/**
 * The table host (DESIGN.md §7, Persistence; Saving; Autosave; New tables
 * and ownership; PROTOCOL.md §2, New table; decisions D24, D25, D33): one
 * open table file, its lock and identity, the Table over its store, the
 * dice, and the save queue with autosave and retries.
 *
 * Saves are serialized: at most one `saveTable` is in flight. A save
 * captures the store's revision and calls `saveTable` in the same tick;
 * `saveTable` serializes before its first await, so the file holds exactly
 * that revision, and only that revision is marked saved.
 */
/// <reference types="node" />
import { type DiceSource, RandomDiceSource } from "../engine/dice";
import { Table } from "../engine/table";
import { type LoadedTable, loadTable, nodeFs, type PersistFs, saveTable } from "../persist/io";
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
  /** Create a new table (one GM board) when the file is missing, and save it at once. */
  createIfMissing?: boolean;
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

type SaveListener = (event: SaveEvent) => void;

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
  /** The asset list loaded with the file, passed unchanged to every save. */
  readonly assets: readonly string[];
  /** What the load noticed: missing assets, a hand edit, a migration. */
  readonly warnings: readonly string[];

  readonly #lock: TableLock | null;
  readonly #fs: PersistFs;
  readonly #autosave: AutosaveOptions | null;
  readonly #clock: HostClock;
  readonly #listeners: SaveListener[] = [];
  readonly #unsubscribe: () => void;
  #lastSaved: number | null;
  #inFlight: { revision: number; promise: Promise<SaveEvent> } | null = null;
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
    this.assets = Object.freeze([...init.assets]);
    this.warnings = Object.freeze([...init.warnings]);
    this.#lock = init.lock;
    this.#fs = init.fs;
    this.#autosave = init.autosave;
    this.#clock = init.clock;
    this.#lastSaved = init.path === null ? null : init.table.store.revision;
    this.#unsubscribe =
      init.autosave === null ? () => undefined : init.table.store.onCommit(() => this.#onCommit());
  }

  /**
   * Opens the table file at `path`: takes the lock on its canonical path
   * (a TableLockedError propagates unchanged; a lock is never taken over),
   * loads the file or, when it is missing and `createIfMissing`, creates a
   * new table and saves it at once, then reads or creates the identity
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
        store = DocumentStore.fromSnapshot(newTableSnapshot());
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
    return this.#lastSaved;
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
   * autosave. Never rejects. A request for a revision already saved, or
   * captured by the save in flight or the queued one, shares that result.
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
   * if the revision is unsaved, then always releases the lock. Never throws
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
    if (this.revision !== this.#lastSaved) {
      const event = await this.#start();
      if (event.status !== "saved") error = event.message;
    }
    const revision = this.revision;
    const saved = this.#lastSaved === revision;
    if (!saved && error === undefined) {
      error = `revision ${revision} was committed during close and is not saved`;
    }
    try {
      await this.#lock.release();
    } catch (err) {
      error ??= `could not release the lock ${this.#lock.path}: ${describe(err)}`;
    }
    return error === undefined ? { saved, revision } : { saved, revision, error };
  }

  /** Schedules the autosave after a commit (D24). */
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
    const inFlight = this.#inFlight;
    if (inFlight !== null) {
      if (this.#queued !== null) return this.#queued;
      if (this.revision === inFlight.revision) return inFlight.promise;
      const queued = inFlight.promise.then(() => {
        this.#queued = null;
        return this.#start();
      });
      this.#queued = queued;
      return queued;
    }
    if (this.revision === this.#lastSaved) {
      const event: SaveEvent = { status: "saved", revision: this.revision };
      if (explicit) this.#emit(event);
      return Promise.resolve(event);
    }
    return this.#start();
  }

  /**
   * Starts a save of the current revision. The revision is captured and
   * `saveTable` is called in this tick, so later commits never reach the
   * file. Every pending timer is cancelled: this save covers what they were
   * for.
   */
  #start(): Promise<SaveEvent> {
    const path = this.path;
    if (path === null) throw new Error("TableHost: no file");
    this.#clearAll();
    const revision = this.revision;
    const promise = saveTable(path, this.table.store, this.assets, this.#fs)
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
        this.#settle(event);
        return event;
      });
    this.#inFlight = { revision, promise };
    return promise;
  }

  #settle(event: SaveEvent): void {
    if (event.status === "saved") {
      this.#lastSaved = Math.max(this.#lastSaved ?? event.revision, event.revision);
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
