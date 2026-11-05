/**
 * The UI's read side (vtt-3l6.4): the connection to the authority and the
 * lifecycle of the UI's mirrors. DESIGN.md §7 Platform (the UI and the agent
 * are two clients of the same protocol; formulas evaluate only in the
 * authority), §4.3 Boards, §4.4 and §4.6 (view as: what is drawn and
 * inspected is the current viewer's view); PROTOCOL.md §2 (explicit
 * credentials, `unauthorized`), §8 (subscriptions, commit events with
 * `boards`, mirrors, reconnection, terminal resubscribe failures); M4 plan
 * Q1, Q2; review r1 findings 3, 11, 13.
 *
 * Subscriptions (Q2):
 * - the **directory**: `{scope: all, viewer: gm, cells: "structural"}`, for
 *   GM presentation and the view-as list only;
 * - the **board view**: `{scope: board, viewer, cells: "all"}` for the
 *   active board and the current viewer;
 * - the **selection view**: `{scope: objects, ids, viewer}` for the selected
 *   ids outside the board view, always with the current viewer.
 *
 * View changes are applied by one serialized reconciler: new subscriptions
 * are made first and swapped in together, and only then are the old ones
 * closed, so no reader ever sees an empty frame or a mix of viewers. Writes,
 * notices, UI state and React hooks are vtt-3l6.21's.
 */
import {
  type BoardView,
  type ConnectionError,
  type Cover,
  enableRecovery,
  LIMITS,
  type ObjectView,
  ProtocolClient,
  type ProtocolError,
  ProtocolFailure,
  type SubscribeParams,
  type Subscription,
  type TableIdentity,
  type Viewer,
  type WebSocketConstructor,
} from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import { describeError } from "../values/rejections";

// ---------------------------------------------------------------------------
// Public types

export interface TableSessionOptions {
  /** The authority's WebSocket URL (from the bootstrap element). */
  url: string;
  /** The session token (from the bootstrap element); never refreshed. */
  token: string;
  /** Defaults to the global `WebSocket`. */
  WebSocket?: WebSocketConstructor;
}

/** The read-side state, observable through `subscribe` / `getSnapshot`. */
export interface SessionSnapshot {
  /**
   * Null when connected. `disconnected` (with `recovering` once reconnected
   * and resubscribing) while the connection is lost; the terminal
   * `unauthorized` (the authority restarted with a new token: reload the
   * page) and `wrong_table`.
   */
  readonly connection: ConnectionError | null;
  /**
   * Connected, the directory live, and the board view live for an active
   * board that is in `boards` (or no board view with zero boards).
   */
  readonly ready: boolean;
  /** The client's revision (from `welcome` and every commit event). */
  readonly revision: number;
  /** From `welcome` and every commit event that carries `boards`. */
  readonly boards: readonly BoardView[];
  readonly table: TableIdentity | null;
  /** The board whose view is shown; null before the first view and with zero boards. */
  readonly activeBoard: BoardId | null;
  /** Whose views are shown (view as). */
  readonly viewer: Viewer;
  /**
   * Increases whenever any view the session holds changes (a commit, a
   * switch, a resync, a failure), also at an unchanged revision, so
   * snapshot-keyed caches see view changes.
   */
  readonly viewVersion: number;
}

/** The current board view's mirror (live maps, updated in place). */
export interface BoardViewState {
  readonly board: BoardId;
  readonly objects: ReadonlyMap<ObjectId, ObjectView>;
  readonly covers: ReadonlyMap<string, Cover>;
  readonly revision: number;
}

/**
 * A subscription the session could not keep (a resubscribe answered with an
 * error after a reconnect, or a new view refused). Connection-level: never a
 * board removal; vtt-3l6.21 shows it as a notice.
 */
export interface ConnectionNotice {
  readonly subscription: "directory" | "board" | "selection";
  /** For `board`: the board whose view failed. */
  readonly board?: BoardId;
  readonly viewer: Viewer;
  readonly error: ProtocolError;
  /** A sentence for the GM. */
  readonly message: string;
}

export interface TableSession {
  /** The protocol client, for vtt-3l6.21's writes and explain/zones queries. */
  readonly client: ProtocolClient;
  /** Adds a listener called after every snapshot change; returns its remover. */
  subscribe(listener: () => void): () => void;
  /** The current snapshot; the same object until something changes. */
  getSnapshot(): SessionSnapshot;
  /**
   * Shows `board` as `viewer`. Resolves once the new views are in place (or
   * the change is deferred until the connection is ready again, or failed and
   * was reported through `onConnectionNotice`); never rejects. A board not
   * in the board list resolves to the first board (or none with zero boards).
   */
  setView(board: BoardId | null, viewer: Viewer): Promise<void>;
  /** Sets the selected ids; those outside the board view get the selection view. */
  watchObjects(ids: readonly ObjectId[]): Promise<void>;
  /** The active board's view for the current viewer; null with no active board. */
  boardView(): BoardViewState | null;
  /** The GM directory (structural cells of every live object). GM presentation and view-as list only. */
  directory(): ReadonlyMap<ObjectId, ObjectView>;
  /**
   * The current viewer's view of `id`: the board view, then the selection
   * view; never the directory or another viewer's mirror.
   */
  objectView(id: ObjectId): ObjectView | null;
  /**
   * The `name` of `id` as `viewer` sees it, from that viewer's views only
   * (for `gm`, also the directory); otherwise the id.
   */
  refLabel(viewer: Viewer, id: ObjectId): string;
  /** A stable key of the current viewer (`gm`, `character:<id>`), for caches. */
  viewerKey(): string;
  /** Resolves once the client's revision reaches `revision`; rejects if the session closes first. */
  whenRevision(revision: number): Promise<void>;
  /** Adds a listener for connection notices; returns its remover. */
  onConnectionNotice(listener: (notice: ConnectionNotice) => void): () => void;
  /** Closes the connection for good. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Internals

const GM: Viewer = { type: "gm" };

const DIRECTORY_PARAMS: SubscribeParams = {
  scope: { type: "all" },
  viewer: GM,
  cells: "structural",
};

const EMPTY: ReadonlyMap<ObjectId, ObjectView> = new Map();

const keyOf = (viewer: Viewer): string => (viewer.type === "gm" ? "gm" : `character:${viewer.id}`);

const sameViewer = (a: Viewer, b: Viewer) => keyOf(a) === keyOf(b);

const copyViewer = (viewer: Viewer): Viewer =>
  viewer.type === "gm" ? { type: "gm" } : { type: "character", id: viewer.id };

const sameConnection = (a: ConnectionError | null, b: ConnectionError | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.code === b.code &&
    a.message === b.message &&
    a.recovering === b.recovering);

type Role = ConnectionNotice["subscription"];

/** A subscription the session holds, with its listeners. */
interface Held {
  readonly role: Role;
  readonly sub: Subscription;
  readonly viewer: Viewer;
  /** For `board`. */
  readonly board: BoardId | null;
  /** For `selection`. */
  readonly ids: readonly ObjectId[];
  readonly offs: (() => void)[];
}

const isLive = (held: Held | null): held is Held => held !== null && held.sub.state === "live";

/** What opening a subscription came to. */
type Opened = Held | "retry" | "again" | "failed";

class Session implements TableSession {
  readonly client: ProtocolClient;
  readonly #stopRecovery: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #noticeListeners = new Set<(notice: ConnectionNotice) => void>();
  readonly #waiters = new Set<{
    revision: number;
    resolve(): void;
    reject(e: Error): void;
  }>();
  readonly #offClient: (() => void)[] = [];

  /** What the caller asked to see. */
  #want: { board: BoardId | null; viewer: Viewer } = { board: null, viewer: GM };
  /** What the held views show. */
  #applied: { board: BoardId | null; viewer: Viewer } = { board: null, viewer: GM };
  #selected: ObjectId[] = [];

  #directory: Held | null = null;
  #board: Held | null = null;
  #selection: Held | null = null;

  /** Subscriptions refused with an error response; not retried until the next ready transition or request. */
  readonly #blocked = new Set<string>();
  #dirty = false;
  #running: Promise<void> | null = null;
  #wasReady = false;
  #closed = false;

  #viewVersion = 0;
  #snapshot: SessionSnapshot;
  #boardView: { version: number; value: BoardViewState | null } | null = null;

  constructor(options: TableSessionOptions) {
    this.client = new ProtocolClient({
      url: options.url,
      token: options.token,
      client: { name: "vtt-ui", kind: "ui" },
      ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
    });
    this.#snapshot = this.#buildSnapshot();
    this.#offClient.push(
      this.client.on("state", () => this.#onState()),
      this.client.on("commit", () => this.#onCommit()),
    );
    // Explicit credentials: no discovery reader, so a 4401 is terminal (PROTOCOL.md §2).
    this.#stopRecovery = enableRecovery(this.client);
    this.#refresh();
  }

  // -------------------------------------------------------------------------
  // Observation

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    return this.#snapshot;
  }

  onConnectionNotice(listener: (notice: ConnectionNotice) => void): () => void {
    this.#noticeListeners.add(listener);
    return () => {
      this.#noticeListeners.delete(listener);
    };
  }

  whenRevision(revision: number): Promise<void> {
    if (this.client.revision >= revision) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error("the table session is closed"));
    return new Promise((resolve, reject) => {
      this.#waiters.add({ revision, resolve, reject });
    });
  }

  // -------------------------------------------------------------------------
  // Views

  setView(board: BoardId | null, viewer: Viewer): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#want = { board, viewer: copyViewer(viewer) };
    this.#blocked.clear();
    return this.#kick();
  }

  watchObjects(ids: readonly ObjectId[]): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#selected = [...new Set(ids)];
    this.#blocked.clear();
    return this.#kick();
  }

  boardView(): BoardViewState | null {
    if (this.#boardView?.version !== this.#viewVersion) {
      const held = this.#board;
      this.#boardView = {
        version: this.#viewVersion,
        value:
          held === null || held.board === null
            ? null
            : {
                board: held.board,
                objects: held.sub.mirror.objects,
                covers: held.sub.mirror.covers,
                revision: held.sub.mirror.revision,
              },
      };
    }
    return this.#boardView.value;
  }

  directory(): ReadonlyMap<ObjectId, ObjectView> {
    return this.#directory?.sub.mirror.objects ?? EMPTY;
  }

  objectView(id: ObjectId): ObjectView | null {
    // Both held views always carry the applied viewer (they are swapped together).
    return (
      this.#board?.sub.mirror.objects.get(id) ?? this.#selection?.sub.mirror.objects.get(id) ?? null
    );
  }

  refLabel(viewer: Viewer, id: ObjectId): string {
    const sources: ReadonlyMap<ObjectId, ObjectView>[] = [];
    if (sameViewer(viewer, this.#applied.viewer)) {
      if (this.#board) sources.push(this.#board.sub.mirror.objects);
      if (this.#selection) sources.push(this.#selection.sub.mirror.objects);
    }
    if (viewer.type === "gm" && this.#directory) sources.push(this.#directory.sub.mirror.objects);
    for (const source of sources) {
      const view = source.get(id);
      if (view === undefined) continue;
      const name = view.cells.name?.value;
      return name?.type === "text" && name.value !== "" ? name.value : id;
    }
    return id;
  }

  viewerKey(): string {
    return keyOf(this.#applied.viewer);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopRecovery();
    this.client.close();
    for (const held of [this.#directory, this.#board, this.#selection]) this.#release(held);
    for (const off of this.#offClient.splice(0)) off();
    const error = new Error("the table session is closed");
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
    this.#refresh();
  }

  // -------------------------------------------------------------------------
  // Client events

  #onState(): void {
    const ready = this.client.ready;
    if (ready && !this.#wasReady) {
      // Connected again (or for the first time): retry what was refused, and reconcile.
      this.#blocked.clear();
      void this.#kick();
    }
    this.#wasReady = ready;
    this.#settleWaiters();
    this.#refresh();
  }

  #onCommit(): void {
    this.#viewVersion++;
    this.#settleWaiters();
    // The board list or the board view's membership may have changed.
    void this.#kick();
    this.#refresh();
  }

  #settleWaiters(): void {
    const revision = this.client.revision;
    for (const waiter of this.#waiters) {
      if (revision >= waiter.revision) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconciliation

  /** Runs the reconciler (again) and resolves when it is idle. */
  #kick(): Promise<void> {
    this.#dirty = true;
    this.#running ??= this.#loop();
    return this.#running;
  }

  async #loop(): Promise<void> {
    // Yield first, so `#running` is assigned before the loop can finish.
    await null;
    try {
      while (this.#dirty && !this.#closed) {
        this.#dirty = false;
        await this.#pass();
      }
    } finally {
      this.#running = null;
    }
  }

  /** One reconciliation pass: brings the held views to `#want` when the client is ready. */
  async #pass(): Promise<void> {
    const client = this.client;
    if (!client.ready) return; // Resumed by the next ready transition.

    // Board removal (review r1 finding 11): the active board must be in the list.
    const boards = client.boards;
    const want = this.#want;
    if (want.board === null || !boards.some((b) => b.id === want.board)) {
      want.board = boards[0]?.id ?? null;
    }
    const { board, viewer } = want;

    if (!isLive(this.#directory) && !this.#blocked.has("directory")) {
      const opened = await this.#open("directory", DIRECTORY_PARAMS, GM, null, []);
      if (typeof opened === "string") {
        if (opened === "again") this.#dirty = true;
        if (opened !== "failed") return;
      } else {
        if (this.#closed) {
          this.#release(opened);
          return;
        }
        const old = this.#directory;
        this.#directory = opened;
        this.#viewVersion++;
        this.#refresh();
        this.#release(old);
      }
      if (this.#want !== want) {
        this.#dirty = true;
        return;
      }
    }

    // The board view.
    let nextBoard = this.#board;
    let created: Held | null = null;
    const boardOk =
      board === null
        ? this.#board === null
        : isLive(this.#board) &&
          this.#board.board === board &&
          sameViewer(this.#board.viewer, viewer);
    if (!boardOk) {
      if (board === null) {
        nextBoard = null;
      } else {
        const opened = await this.#open(
          "board",
          { scope: { type: "board", board }, viewer: copyViewer(viewer), cells: "all" },
          viewer,
          board,
          [],
        );
        if (typeof opened === "string") {
          if (opened === "again") this.#dirty = true;
          else if (opened === "failed") this.#revertWant(want);
          return;
        }
        nextBoard = created = opened;
      }
    }

    // The selection view: selected ids outside the (new) board view, with the same viewer.
    const inBoard = nextBoard?.sub.mirror.objects;
    const need = this.#selected.filter((id) => !inBoard?.has(id)).slice(0, LIMITS.max_ids);
    let nextSelection = this.#selection;
    let createdSelection: Held | null = null;
    const current = this.#selection;
    const selectionOk =
      need.length === 0
        ? current === null
        : isLive(current) &&
          sameViewer(current.viewer, viewer) &&
          current.ids.length === need.length &&
          need.every((id) => current.ids.includes(id));
    if (!selectionOk) {
      const keepable = isLive(current) && sameViewer(current.viewer, viewer) ? current : null;
      if (need.length === 0) {
        nextSelection = null;
      } else {
        const opened = await this.#open(
          "selection",
          { scope: { type: "objects", ids: need }, viewer: copyViewer(viewer) },
          viewer,
          null,
          need,
        );
        if (opened === "retry" || opened === "again") {
          this.#release(created);
          if (opened === "again") this.#dirty = true;
          return;
        }
        // A refused selection view never blocks a board or viewer switch.
        if (opened === "failed") {
          nextSelection = keepable;
        } else {
          nextSelection = opened;
          createdSelection = opened;
        }
      }
    }

    if (this.#closed) {
      this.#release(created);
      this.#release(createdSelection);
      return;
    }
    // Swap everything at once, then close what was replaced.
    const oldBoard = this.#board !== nextBoard ? this.#board : null;
    const oldSelection = this.#selection !== nextSelection ? this.#selection : null;
    this.#board = nextBoard;
    this.#selection = nextSelection;
    const changed =
      oldBoard !== null ||
      oldSelection !== null ||
      created !== null ||
      createdSelection !== null ||
      this.#applied.board !== board ||
      !sameViewer(this.#applied.viewer, viewer);
    if (changed) {
      this.#applied = { board, viewer: copyViewer(viewer) };
      this.#viewVersion++;
    }
    this.#refresh();
    this.#release(oldBoard);
    this.#release(oldSelection);
    if (this.#want !== want) this.#dirty = true;
  }

  /** A refused view: keep showing what is shown. */
  #revertWant(want: { board: BoardId | null; viewer: Viewer }): void {
    if (this.#want === want) this.#want = { ...this.#applied };
  }

  async #open(
    role: Role,
    params: SubscribeParams,
    viewer: Viewer,
    board: BoardId | null,
    ids: readonly ObjectId[],
  ): Promise<Opened> {
    const key = `${role}:${board ?? ""}:${keyOf(viewer)}:${ids.join(",")}`;
    if (this.#blocked.has(key)) return "failed";
    let sub: Subscription;
    try {
      sub = await this.client.subscribe(params);
    } catch (e) {
      if (this.#closed) return "retry";
      if (e instanceof ProtocolFailure && e.local && e.error.code === "disconnected") {
        return "retry"; // Not connected: resumed when the client is ready again.
      }
      const error =
        e instanceof ProtocolFailure ? e.error : { code: "internal" as const, message: String(e) };
      if (
        role === "board" &&
        error.code === "not_found" &&
        !this.client.boards.some((b) => b.id === board)
      ) {
        return "again"; // Removed meanwhile: the next pass picks another board.
      }
      this.#blocked.add(key);
      this.#notice(role, viewer, board, error);
      return "failed";
    }
    const held: Held = { role, sub, viewer: copyViewer(viewer), board, ids: [...ids], offs: [] };
    held.offs.push(
      sub.on("resync", () => {
        if (!this.#holds(held)) return;
        this.#viewVersion++;
        this.#refresh();
      }),
      sub.on("error", (_, error) => this.#onFailed(held, error)),
    );
    return held;
  }

  /** A held subscription became terminal through recovery (PROTOCOL.md §8). */
  #onFailed(held: Held, error: ProtocolError): void {
    if (!this.#holds(held) || this.#closed) return;
    this.#viewVersion++;
    // A board removed meanwhile is a removal, handled by the board list, not a notice.
    const removed = held.role === "board" && !this.client.boards.some((b) => b.id === held.board);
    if (!removed) this.#notice(held.role, held.viewer, held.board, error);
    // Not a removal: replaced by the reconciler once the client is ready.
    void this.#kick();
    this.#refresh();
  }

  #holds(held: Held): boolean {
    return this.#directory === held || this.#board === held || this.#selection === held;
  }

  #release(held: Held | null): void {
    if (held === null) return;
    for (const off of held.offs.splice(0)) off();
    held.sub.close().catch(() => undefined);
  }

  #notice(role: Role, viewer: Viewer, board: BoardId | null, error: ProtocolError): void {
    const what =
      role === "directory"
        ? "The table directory"
        : role === "selection"
          ? "The view of the selected objects"
          : `The view of board ${this.#boardName(board)}`;
    const notice: ConnectionNotice = {
      subscription: role,
      ...(board === null ? {} : { board }),
      viewer: copyViewer(viewer),
      error,
      message: `${what} could not be updated. ${describeError(error)}`,
    };
    for (const listener of [...this.#noticeListeners]) {
      try {
        listener(notice);
      } catch {
        // A throwing listener must not break the session.
      }
    }
  }

  #boardName(board: BoardId | null): string {
    const found = this.client.boards.find((b) => b.id === board);
    return `"${found?.name ?? board ?? ""}"`;
  }

  // -------------------------------------------------------------------------
  // Snapshot

  #buildSnapshot(): SessionSnapshot {
    const client = this.client;
    const boards = client.boards;
    const applied = this.#applied;
    const boardReady =
      applied.board === null
        ? boards.length === 0
        : isLive(this.#board) && boards.some((b) => b.id === applied.board);
    return {
      connection: client.connectionError(),
      ready: !this.#closed && client.ready && isLive(this.#directory) && boardReady,
      revision: client.revision,
      boards,
      table: client.table,
      activeBoard: applied.board,
      viewer: applied.viewer,
      viewVersion: this.#viewVersion,
    };
  }

  /** Rebuilds the snapshot and notifies listeners when it changed. */
  #refresh(): void {
    const next = this.#buildSnapshot();
    const prev = this.#snapshot;
    if (
      sameConnection(prev.connection, next.connection) &&
      prev.ready === next.ready &&
      prev.revision === next.revision &&
      prev.boards === next.boards &&
      prev.table === next.table &&
      prev.activeBoard === next.activeBoard &&
      prev.viewer === next.viewer &&
      prev.viewVersion === next.viewVersion
    ) {
      return;
    }
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A throwing listener must not break the session.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Connects to the authority with explicit credentials (`client.kind: "ui"`)
 * and `enableRecovery`, and keeps the directory and the board view current
 * (the first board, as the GM, once connected).
 */
export function createTableSession(options: TableSessionOptions): TableSession {
  return new Session(options);
}
