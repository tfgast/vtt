/**
 * The document store (DESIGN.md §7): the committed document, its operation
 * history and revision, and the one open transaction. The store is the only
 * place a committed document changes, and it changes only at a commit point,
 * where the new document and the appended group are published together.
 *
 * The historical inverses of each group committed through the store are
 * computed while its effects are recorded and kept in memory (never
 * persisted), so `rewind` can use them; see replay.ts.
 *
 * The committed document is deep-frozen at `fromSnapshot` and at every
 * commit point, so store reads and a commit payload's `before` cannot be
 * mutated; `begin` works on a fresh deep copy.
 *
 * `transact`'s `onAbort` hook runs in try/catch: an error it throws never
 * replaces the original outcome. It is recorded on `lastAbortHookError`,
 * passed to `onAbortError` if given, and carried on a rejection result as
 * `abortHookError`.
 */
import {
  type Actor,
  type Board,
  type BoardId,
  type Cell,
  type Location,
  type ObjectId,
  type Snapshot,
  type TableObject,
  type ViewersValue,
  type Violation,
  validateSnapshot,
} from "@vtt/schema";
import { DocState } from "./doc";
import type { HistoricalInverse } from "./effects";
import { type DeepReadonly, History } from "./history";
import {
  type CommitListener,
  type CommitPayload,
  type CommitResult,
  Rejected,
  Transaction,
  type TransactionMeta,
} from "./transaction";

/**
 * The read API of a document: DocState's reads, without its mutators, and
 * with every record readonly. The committed document behind the store and
 * behind a commit payload's `before` is deep-frozen; a transaction's `doc`
 * returns copies of the working copy's records.
 */
export interface DocView {
  readonly revision: number;
  readonly nextSeq: number;
  toSnapshot(): Snapshot;
  getObject(id: ObjectId): DeepReadonly<TableObject> | undefined;
  hasObject(id: ObjectId): boolean;
  objectIds(): ObjectId[];
  getBoard(id: BoardId): DeepReadonly<Board> | undefined;
  boardIndex(id: BoardId): number;
  boards(): Board[];
  getCell(id: ObjectId, cell: string): DeepReadonly<Cell> | undefined;
  getCellVisibility(id: ObjectId, cell: string): DeepReadonly<ViewersValue> | undefined;
  containerOf(id: ObjectId): ObjectId | null;
  boardOf(id: ObjectId): BoardId | null;
  locationOf(id: ObjectId): Location | null;
  contentsOf(id: ObjectId): ObjectId[];
  subtreeOf(id: ObjectId): ObjectId[];
  objectsOnBoard(board: BoardId): ObjectId[];
  isReserved(id: string): boolean;
  isRetired(id: string): boolean;
}

/**
 * Deep-freezes every record of `doc` and the instance itself, so neither its
 * records nor its revision can change. Its mutators must never run again;
 * a transaction works on a fresh copy.
 */
function freezeDoc(doc: DocState): DocState {
  for (const id of doc.objectIds()) deepFreeze(doc.getObject(id));
  for (const b of doc.boards()) deepFreeze(doc.getBoard(b.id));
  Object.freeze(doc);
  return doc;
}

function deepFreeze(x: unknown): void {
  if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
}

/** A snapshot that fails the document invariants. */
export class InvalidSnapshotError extends Error {
  readonly violations: Violation[];

  constructor(violations: Violation[]) {
    super(`invalid snapshot: ${violations.map((v) => v.message).join("; ")}`);
    this.name = "InvalidSnapshotError";
    this.violations = violations;
  }
}

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);
const sortedRecord = <T>(r: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(r).sort(byKey));

/**
 * A deep copy of `s` in canonical order: objects by id, and each object's
 * `cells` and `cell_visibility` by name. Boards, contents and every list keep
 * their order, which is meaningful.
 */
export function canonicalSnapshot(s: Snapshot): Snapshot {
  const c = structuredClone(s);
  return {
    revision: c.revision,
    next_seq: c.next_seq,
    boards: c.boards,
    objects: Object.fromEntries(
      Object.entries(c.objects)
        .sort(byKey)
        .map(([id, o]) => [
          id,
          { ...o, cells: sortedRecord(o.cells), cell_visibility: sortedRecord(o.cell_visibility) },
        ]),
    ),
    retired_ids: c.retired_ids,
  };
}

/** Marks "no error" where any value, undefined included, may be thrown. */
const NO_ERROR: unique symbol = Symbol("no error");

/** What `transact` returns. */
export type TransactResult =
  | ({ ok: true } & CommitResult)
  | {
      ok: false;
      rejection: Rejected["rejection"];
      /** What `onAbort` threw, if it threw. The rejection still stands. */
      abortHookError?: unknown;
    };

export interface TransactOptions {
  /**
   * Called after the transaction aborts before the commit point, on a
   * rejection or any other error; never after a commit. If it throws, the
   * original outcome stands (see `transact`).
   */
  onAbort?: () => void;
  /** Receives what `onAbort` threw. An error it throws itself is ignored. */
  onAbortError?: (error: unknown) => void;
}

export class DocumentStore implements DocView {
  #doc: DocState;
  readonly #history: History;
  #open: Transaction | null = null;
  /** The last error an `onAbort` hook of `transact` threw, for diagnostics. */
  lastAbortHookError: unknown = undefined;
  readonly #internal: CommitListener[] = [];
  readonly #public: CommitListener[] = [];
  /** Absolute group index → its historical inverses, for groups committed here. */
  readonly #inverses = new Map<number, readonly HistoricalInverse[]>();

  private constructor(doc: DocState, history: History) {
    this.#doc = doc;
    this.#history = history;
  }

  /**
   * A store over a copy of `snapshot`, which must satisfy the document
   * invariants. `history` is taken as is (History.restore checks its own
   * invariants); by default it is empty.
   */
  static fromSnapshot(snapshot: Snapshot, history: History = new History()): DocumentStore {
    const violations = validateSnapshot(snapshot);
    if (violations.length > 0) throw new InvalidSnapshotError(violations);
    return new DocumentStore(freezeDoc(DocState.fromSnapshot(snapshot)), history);
  }

  /** A deep copy of the committed document, in canonical order. */
  toSnapshot(): Snapshot {
    return canonicalSnapshot(this.#doc.toSnapshot());
  }

  get history(): History {
    return this.#history;
  }

  get revision(): number {
    return this.#doc.revision;
  }

  /** The open transaction, or null. */
  get openTransaction(): Transaction | null {
    return this.#open;
  }

  /**
   * The historical inverses of a retained group committed through this
   * store, in effect order; undefined for groups loaded or compacted away.
   */
  inverses(index: number): readonly HistoricalInverse[] | undefined {
    return this.#history.get(index) === undefined ? undefined : this.#inverses.get(index);
  }

  // Commit notifications.

  /**
   * Registers an internal synchronization hook (formula invalidation, the
   * spatial index). Hooks run in registration order right after the commit
   * point, before every public listener. A hook that throws is a bug: the
   * error propagates from the commit, which stands.
   */
  onCommitInternal(fn: CommitListener): () => void {
    return subscribe(this.#internal, fn);
  }

  /**
   * Registers a public commit listener. Listeners run in registration order
   * after every internal hook; one that throws is reported in the commit's
   * `listenerErrors` and never undoes the commit.
   */
  onCommit(fn: CommitListener): () => void {
    return subscribe(this.#public, fn);
  }

  // Transactions.

  /** Opens the one transaction. Throws if one is already open. */
  begin(actor: Actor, meta: TransactionMeta): Transaction {
    if (this.#open !== null) throw new Error("begin: a transaction is already open");
    if ((meta.kind === "undo") !== (meta.undoes !== undefined)) {
      throw new Error(`begin: kind "undo" exactly when undoes is present`);
    }
    const base = this.#doc;
    const working = DocState.fromSnapshot(base.toSnapshot());
    const tx: Transaction = new Transaction(actor, meta, base, working, {
      publish: (doc, group, inverses) => {
        const appended = this.#history.append(group);
        this.#doc = freezeDoc(doc);
        this.#open = null;
        this.#inverses.set(appended.index, inverses);
        for (const i of this.#inverses.keys()) {
          if (i < this.#history.firstIndex) this.#inverses.delete(i);
        }
        return appended;
      },
      notify: (payload) => this.#notify(payload),
      release: () => {
        if (this.#open === tx) this.#open = null;
      },
    });
    this.#open = tx;
    return tx;
  }

  /**
   * Runs `fn` in a new transaction and commits it. Before the commit point,
   * a Rejected becomes `{ok: false, rejection}` and any other error is
   * rethrown unchanged; either way the transaction aborts and `onAbort`
   * runs. An internal hook's error after the commit point propagates
   * without `onAbort`.
   *
   * An error thrown by `onAbort` never replaces the original outcome. It is
   * recorded on `lastAbortHookError` and passed to `onAbortError` if given;
   * a rejection result also carries it as `abortHookError`. A rethrown
   * error is rethrown unchanged.
   */
  transact(
    actor: Actor,
    meta: TransactionMeta,
    fn: (tx: Transaction) => void,
    options: TransactOptions = {},
  ): TransactResult {
    const tx = this.begin(actor, meta);
    try {
      fn(tx);
      if (tx.state !== "open") throw new Error("transact: fn must not commit or abort");
      return { ok: true, ...tx.commit() };
    } catch (err) {
      if (tx.state === "committed") throw err;
      tx.abort();
      const hookError = this.#runAbortHook(options);
      if (err instanceof Rejected) {
        return hookError === NO_ERROR
          ? { ok: false, rejection: err.rejection }
          : { ok: false, rejection: err.rejection, abortHookError: hookError };
      }
      throw err;
    }
  }

  /** Runs `onAbort`; returns what it threw, or NO_ERROR. */
  #runAbortHook({ onAbort, onAbortError }: TransactOptions): unknown {
    if (onAbort === undefined) return NO_ERROR;
    try {
      onAbort();
      return NO_ERROR;
    } catch (hookError) {
      this.lastAbortHookError = hookError;
      try {
        onAbortError?.(hookError);
      } catch {
        // Documented: an error from onAbortError is ignored.
      }
      return hookError;
    }
  }

  #notify(payload: CommitPayload): unknown[] {
    for (const fn of [...this.#internal]) fn(payload);
    const errors: unknown[] = [];
    for (const fn of [...this.#public]) {
      try {
        fn(payload);
      } catch (err) {
        errors.push(err);
      }
    }
    return errors;
  }

  // The DocState read API, over the committed document.

  get nextSeq(): number {
    return this.#doc.nextSeq;
  }

  getObject: DocView["getObject"] = (id) => this.#doc.getObject(id);
  hasObject: DocView["hasObject"] = (id) => this.#doc.hasObject(id);
  objectIds: DocView["objectIds"] = () => this.#doc.objectIds();
  getBoard: DocView["getBoard"] = (id) => this.#doc.getBoard(id);
  boardIndex: DocView["boardIndex"] = (id) => this.#doc.boardIndex(id);
  boards: DocView["boards"] = () => this.#doc.boards();
  getCell: DocView["getCell"] = (id, cell) => this.#doc.getCell(id, cell);
  getCellVisibility: DocView["getCellVisibility"] = (id, cell) =>
    this.#doc.getCellVisibility(id, cell);
  containerOf: DocView["containerOf"] = (id) => this.#doc.containerOf(id);
  boardOf: DocView["boardOf"] = (id) => this.#doc.boardOf(id);
  locationOf: DocView["locationOf"] = (id) => this.#doc.locationOf(id);
  contentsOf: DocView["contentsOf"] = (id) => this.#doc.contentsOf(id);
  subtreeOf: DocView["subtreeOf"] = (id) => this.#doc.subtreeOf(id);
  objectsOnBoard: DocView["objectsOnBoard"] = (board) => this.#doc.objectsOnBoard(board);
  isReserved: DocView["isReserved"] = (id) => this.#doc.isReserved(id);
  isRetired: DocView["isRetired"] = (id) => this.#doc.isRetired(id);
}

function subscribe(list: CommitListener[], fn: CommitListener): () => void {
  list.push(fn);
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}
