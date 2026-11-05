/**
 * The table host (DESIGN.md §7, Persistence; Saving; Autosave; New tables
 * and ownership; PROTOCOL.md §2, New table; decisions D24, D25, D33): one
 * open table file, its lock and identity, the Table over its store, the
 * dice, and the save queue with autosave and retries.
 *
 * Saves are serialized: at most one `saveTable` is in flight. A save
 * captures the store's revision, the asset generation and the asset list,
 * and calls `saveTable` in the same tick; `saveTable` serializes before its
 * first await, so the file holds exactly that state, and only that pair
 * (revision, assets generation) is marked saved. The host is dirty while
 * the current pair differs from the saved pair (DESIGN.md §7, Revisions and
 * assets: an imported path is listed in the file's assets from the next save).
 */
/// <reference types="node" />
import type { Snapshot } from "@vtt/schema";
import { type DiceSource, RandomDiceSource } from "../engine/dice";
import { Table } from "../engine/table";
import { type LoadedTable, loadTable, nodeFs, type PersistFs, saveTable } from "../persist/io";
import { InvalidAssetPathError } from "../persist/serialize";
import { DocumentStore } from "../store/document-store";
import { canonicalTablePath, readOrCreateTableId } from "./identity";
import { acquireTableLock, type TableLock } from "./lock";
import { newTableSnapshot } from "./new-table";

/** How a save ended (DESIGN.md §7, Saving). */
export type SaveStatus = "saved" | "saved_not_durable" | "failed";

/** A save's result, as emitted to `onSave` listeners. */
export interface SaveEvent {
  status: SaveStatus;
  /** The revision the save captured when it started. */
  revision: number;
  /** Why the save failed or is not durable; absent when `saved`. */
  message?: string;
}

/** Autosave timings, in milliseconds (D24). */
export interface AutosaveOptions {
  /** Save this long after the latest commit... */
  debounceMs: number;
  /** ...but no later than this long after the first unsaved commit. */
  maxDelayMs: number;
  /** Retry delays after a failed save; the last one repeats. */
  retryMs: readonly number[];
}

/** 2 s after the last commit, at most 10 s after the first; retries at 1 s, 5 s, 30 s, then every 60 s. */
export const DEFAULT_AUTOSAVE: Readonly<AutosaveOptions> = Object.freeze({
  debounceMs: 2000,
  maxDelayMs: 10000,
  retryMs: Object.freeze([1000, 5000, 30000, 60000]),
});

/** The timers the host schedules with; injectable for tests. */
export interface HostClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The global timers, looked up at each call (so fake timers installed after
 * import apply). Timers are unref'd: a pending autosave never keeps the
 * process alive by itself.
 */
export const systemClock: HostClock = {
  setTimeout(fn, ms) {
    const handle = globalThis.setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export interface OpenTableOptions {
  /** Create a new table (`newTable`) when the file is missing, and save it at once. */
  createIfMissing?: boolean;
  /**
   * The snapshot of a table created for a missing file (DESIGN.md §7, New
   * tables and ownership; M5-D19). Default `newTableSnapshot`: one GM board,
   * no objects. `vtt-serve` passes `stockedTableSnapshot` unless `--empty`.
   */
  newTable?: () => Snapshot;
  /** Default: a RandomDiceSource seeded from `crypto.getRandomValues`. */
  dice?: DiceSource;
  /** Autosave timings (missing fields take the defaults), or false for no autosave and no retries. */
  autosave?: Partial<AutosaveOptions> | false;
  clock?: HostClock;
  /** The filesystem seam passed to `loadTable` and `saveTable`. */
  fs?: PersistFs;
}

/** What `close` reports. */
export interface CloseResult {
  /** Whether the table's final revision is saved. */
  saved: boolean;
  /** The table's revision at the end of the close. */
  revision: number;
  error?: string;
}

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const randomDice = (): DiceSource =>
  new RandomDiceSource(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0);

/** Absolute POSIX, Windows drive and UNC paths, as `serializeTable` refuses them. */
const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:)/;

type SaveListener = (event: SaveEvent) => void;

/** What a save captures, and what is recorded as saved. */
interface SavePoint {
  revision: number;
  assetsGeneration: number;
}

/** The host's timers: the debounce, the max-delay deadline, and the retry. */
type TimerKind = "debounce" | "maxDelay" | "retry";

interface HostInit {
  table: Table;
  dice: DiceSource;
  path: string | null;
  tableId: string | null;
  assets: readonly string[];
  warnings: readonly string[];
  lock: TableLock | null;
  fs: PersistFs;
  autosave: AutosaveOptions | null;
  clock: HostClock;
}

export class TableHost {
  readonly table: Table;
  readonly dice: DiceSource;
  /** The canonical table path; null for an in-memory table. */
  readonly path: string | null;
  /** The content of `<path>.table-id`; null for an in-memory table. */
  readonly tableId: string | null;
  /** What the load noticed: missing assets, a hand edit, a migration. */
  readonly warnings: readonly string[];

  readonly #lock: TableLock | null;
  readonly #fs: PersistFs;
  readonly #autosave: AutosaveOptions | null;
  readonly #clock: HostClock;
  readonly #listeners: SaveListener[] = [];
  readonly #unsubscribe: () => void;
  #assets: readonly string[];
  #assetsGeneration = 0;
  #lastSaved: SavePoint | null;
  #inFlight: (SavePoint & { promise: Promise<SaveEvent> }) | null = null;
  #queued: Promise<SaveEvent> | null = null;
  readonly #timers = new Map<TimerKind, unknown>();
  #retryStep = 0;
  #closed = false;
  #closing: Promise<CloseResult> | null = null;

  private constructor(init: HostInit) {
    this.table = init.table;
    this.dice = init.dice;
    this.path = init.path;
    this.tableId = init.tableId;
    this.#assets = Object.freeze([...init.assets]);
    this.warnings = Object.freeze([...init.warnings]);
    this.#lock = init.lock;
    this.#fs = init.fs;
    this.#autosave = init.autosave;
    this.#clock = init.clock;
    this.#lastSaved =
      init.path === null ? null : { revision: init.table.store.revision, assetsGeneration: 0 };
    this.#unsubscribe =
      init.autosave === null ? () => undefined : init.table.store.onCommit(() => this.#onCommit());
  }

  /**
   * Opens the table file at `path`: takes the lock on its canonical path
   * (a TableLockedError propagates unchanged; a lock is never taken over),
   * loads the file or, when it is missing and `createIfMissing`, creates a
   * new table from `newTable` and saves it at once, then reads or creates the identity
   * file. Any failure after the lock is held releases it before the error
   * propagates.
   */
  static async open(path: string, options: OpenTableOptions = {}): Promise<TableHost> {
    const fs = options.fs ?? nodeFs;
    const canonical = canonicalTablePath(path);
    const lock = await acquireTableLock(canonical);
    try {
      let loaded: LoadedTable | null = null;
      try {
        loaded = await loadTable(canonical, fs);
      } catch (err) {
        if (codeOf(err) !== "ENOENT") throw err;
      }
      if (loaded === null && options.createIfMissing !== true) {
        const shown = canonical === path ? path : `${path} (${canonical})`;
        throw new Error(`table file not found: ${shown}`);
      }
      const tableId = await readOrCreateTableId(canonical, lock);

      let store: DocumentStore;
      if (loaded === null) {
        store = DocumentStore.fromSnapshot((options.newTable ?? newTableSnapshot)());
        const result = await saveTable(canonical, store, [], fs);
        if (!result.ok) {
          throw new Error(
            `could not create table file ${canonical} (${result.stage}): ${describe(result.error)}`,
            { cause: result.error },
          );
        }
      } else {
        store = loaded.store;
      }

      const autosave =
        options.autosave === false ? null : { ...DEFAULT_AUTOSAVE, ...options.autosave };
      return new TableHost({
        table: Table.fromStore(store),
        dice: options.dice ?? randomDice(),
        path: canonical,
        tableId,
        assets: loaded?.assets ?? [],
        warnings: loaded?.warnings.map((w) => w.message) ?? [],
        lock,
        fs,
        autosave,
        clock: options.clock ?? systemClock,
      });
    } catch (err) {
      await lock.release().catch(() => undefined);
      throw err;
    }
  }

  /** A host over `store` with no file, no lock and no autosave. */
  static inMemory(store: DocumentStore, options: { dice?: DiceSource } = {}): TableHost {
    return new TableHost({
      table: Table.fromStore(store),
      dice: options.dice ?? randomDice(),
      path: null,
      tableId: null,
      assets: [],
      warnings: [],
      lock: null,
      fs: nodeFs,
      autosave: null,
      clock: systemClock,
    });
  }

  /** The table's current revision. */
  get revision(): number {
    return this.table.store.revision;
  }

  /** The latest revision a save wrote durably; null for an in-memory table. */
  get lastSavedRevision(): number | null {
    return this.#lastSaved?.revision ?? null;
  }

  /**
   * The table's asset paths, relative to the file's directory: the list
   * loaded with the file plus every path added since, in order. Each save
   * writes the list as it was when the save started. A frozen array that a
   * later `addAsset` replaces rather than changes.
   */
  get assets(): readonly string[] {
    return this.#assets;
  }

  /** How many new paths `addAsset` has added since the table was opened (0 on open). */
  get assetsGeneration(): number {
    return this.#assetsGeneration;
  }

  /**
   * Adds a relative asset path to the table's asset list, so the next save
   * lists it (DESIGN.md §7, Revisions and assets). A path already listed
   * (the same string) changes nothing. A new path increments
   * `assetsGeneration`, makes the table unsaved, and schedules the autosave
   * exactly as a commit does. An empty or absolute path throws
   * InvalidAssetPathError and changes nothing. Writing the asset's bytes is
   * the caller's job.
   */
  addAsset(path: string): void {
    if (typeof path !== "string" || path === "" || ABSOLUTE_PATH.test(path)) {
      throw new InvalidAssetPathError([path]);
    }
    if (this.#assets.includes(path)) return;
    this.#assets = Object.freeze([...this.#assets, path]);
    this.#assetsGeneration++;
    this.#onCommit();
  }

  /**
   * Registers a listener for save results. Every result a `save()` call
   * resolves with has been emitted before it resolves. A listener that
   * throws is logged and does not affect saving.
   */
  onSave(listener: SaveListener): () => void {
    const entry: SaveListener = (event) => listener(event);
    this.#listeners.push(entry);
    return () => {
      const i = this.#listeners.indexOf(entry);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }

  /**
   * Saves now, queued behind a save in flight, and cancels the pending
   * autosave. Never rejects. A request for a state (revision and assets
   * generation) already saved, or captured by the save in flight or the
   * queued one, shares that result.
   */
  save(): Promise<SaveEvent> {
    if (this.path === null) {
      const event: SaveEvent = { status: "failed", revision: this.revision, message: "no file" };
      this.#emit(event);
      return Promise.resolve(event);
    }
    if (this.#closed) {
      return Promise.resolve({
        status: "failed",
        revision: this.revision,
        message: "the table host is closed",
      });
    }
    this.#clear("debounce");
    this.#clear("maxDelay");
    return this.#request(true);
  }

  /**
   * Cancels the timers, awaits the save in flight and the queued one, saves
   * if the revision or the asset list is unsaved, then always releases the
   * lock. Never throws
   * for a save failure. Idempotent: later calls return the first's result.
   */
  close(): Promise<CloseResult> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<CloseResult> {
    this.#closed = true;
    this.#unsubscribe();
    this.#clearAll();
    if (this.#lock === null) return { saved: false, revision: this.revision, error: "no file" };

    let error: string | undefined;
    while (this.#queued !== null || this.#inFlight !== null) {
      await (this.#queued ?? this.#inFlight?.promise);
    }
    if (this.#dirty()) {
      const event = await this.#start();
      if (event.status !== "saved") error = event.message;
    }
    const revision = this.revision;
    const saved = !this.#dirty();
    if (!saved && error === undefined) {
      error =
        this.#lastSaved?.revision === revision
          ? `an asset was added during close and is not saved`
          : `revision ${revision} was committed during close and is not saved`;
    }
    try {
      await this.#lock.release();
    } catch (err) {
      error ??= `could not release the lock ${this.#lock.path}: ${describe(err)}`;
    }
    return error === undefined ? { saved, revision } : { saved, revision, error };
  }

  /** Whether the current (revision, assets generation) differs from the saved pair. */
  #dirty(): boolean {
    return !this.#isCurrent(this.#lastSaved);
  }

  /** Whether `point` is the current (revision, assets generation). */
  #isCurrent(point: SavePoint | null): boolean {
    return (
      point !== null &&
      point.revision === this.revision &&
      point.assetsGeneration === this.#assetsGeneration
    );
  }

  /** Schedules the autosave after a commit or a new asset (D24). */
  #onCommit(): void {
    const autosave = this.#autosave;
    if (autosave === null || this.#closed) return;
    this.#clear("debounce");
    this.#set("debounce", autosave.debounceMs);
    if (!this.#timers.has("maxDelay")) this.#set("maxDelay", autosave.maxDelayMs);
  }

  #autoRequest(): void {
    if (!this.#closed) void this.#request(false);
  }

  /** A save request: coalesced, queued behind the save in flight, or started now. */
  #request(explicit: boolean): Promise<SaveEvent> {
    // A queued save owns the next write even while its predecessor's result
    // is being emitted (#inFlight already null): a request made from an
    // onSave listener joins it rather than starting a second write.
    if (this.#queued !== null) return this.#queued;
    const inFlight = this.#inFlight;
    if (inFlight !== null) {
      if (this.#isCurrent(inFlight)) return inFlight.promise;
      const queued = inFlight.promise.then(() => {
        this.#queued = null;
        return this.#start();
      });
      this.#queued = queued;
      return queued;
    }
    if (!this.#dirty()) {
      const event: SaveEvent = { status: "saved", revision: this.revision };
      if (explicit) this.#emit(event);
      return Promise.resolve(event);
    }
    return this.#start();
  }

  /**
   * Starts a save of the current revision and asset list. Both, and the
   * asset generation, are captured and `saveTable` is called in this tick,
   * so later commits and assets never reach the file. Every pending timer is cancelled: this save covers what they were
   * for.
   */
  #start(): Promise<SaveEvent> {
    const path = this.path;
    if (path === null) throw new Error("TableHost: no file");
    this.#clearAll();
    const revision = this.revision;
    const assetsGeneration = this.#assetsGeneration;
    const promise = saveTable(path, this.table.store, this.#assets, this.#fs)
      .then(
        (result): SaveEvent => {
          if (result.ok) return { status: "saved", revision };
          if (result.stage === "after_replace") {
            return {
              status: "saved_not_durable",
              revision,
              message: `saved, but durability was not confirmed (directory fsync failed): ${describe(result.error)}`,
            };
          }
          return {
            status: "failed",
            revision,
            message: `save failed; the file was not replaced: ${describe(result.error)}`,
          };
        },
        (err: unknown): SaveEvent => ({
          status: "failed",
          revision,
          message: `save failed; the file was not replaced: ${describe(err)}`,
        }),
      )
      .then((event) => {
        this.#inFlight = null;
        this.#settle(event, { revision, assetsGeneration });
        return event;
      });
    this.#inFlight = { revision, assetsGeneration, promise };
    return promise;
  }

  /** Records `captured` as saved when the save ended `saved`; otherwise schedules a retry. */
  #settle(event: SaveEvent, captured: SavePoint): void {
    if (event.status === "saved") {
      const last = this.#lastSaved;
      this.#lastSaved = {
        revision: Math.max(last?.revision ?? captured.revision, captured.revision),
        assetsGeneration: Math.max(
          last?.assetsGeneration ?? captured.assetsGeneration,
          captured.assetsGeneration,
        ),
      };
      this.#retryStep = 0;
    } else {
      this.#scheduleRetry();
    }
    this.#emit(event);
  }

  /** After a failure: retry by the backoff, repeating its last delay. */
  #scheduleRetry(): void {
    const retryMs = this.#autosave?.retryMs;
    if (retryMs === undefined || retryMs.length === 0 || this.#closed) return;
    const ms = retryMs[Math.min(this.#retryStep, retryMs.length - 1)] as number;
    this.#retryStep++;
    this.#clear("retry");
    this.#set("retry", ms);
  }

  /** Starts `kind`'s timer; when it fires it requests a save. */
  #set(kind: TimerKind, ms: number): void {
    const handle = this.#clock.setTimeout(() => {
      if (this.#timers.get(kind) === handle) this.#timers.delete(kind);
      this.#autoRequest();
    }, ms);
    this.#timers.set(kind, handle);
  }

  #clear(kind: TimerKind): void {
    const handle = this.#timers.get(kind);
    if (handle === undefined) return;
    this.#timers.delete(kind);
    this.#clock.clearTimeout(handle);
  }

  #clearAll(): void {
    for (const kind of [...this.#timers.keys()]) this.#clear(kind);
  }

  #emit(event: SaveEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("TableHost: a save listener threw:", err);
      }
    }
  }
}
