/**
 * Transactions (DESIGN.md §7, Transactions; FORMULAS.md §8.1): every change
 * runs in one, and one is open at a time. A transaction records resolved
 * effects onto a working copy of the committed document. Committing validates
 * the working copy, builds the group, and hands both to the store, which
 * publishes them together (the commit point) and then runs internal
 * synchronization hooks before public listeners.
 *
 * The working copy is a full copy of the document taken at `begin`; the
 * committed document is never touched before the commit point, so an abort
 * is simply dropping the copy, and the old document serves as `before`.
 */
import {
  type Actor,
  type Effect,
  type ObjectId,
  type OpGroup,
  type Rejection,
  validateSnapshot,
} from "@vtt/schema";
import type { DocState } from "./doc";
import type { DocView } from "./document-store";
import { applyEffect, type HistoricalInverse, historicalInverse } from "./effects";
import type { DeepReadonly, FrozenGroup } from "./history";
import { type ChangeSummary, SummaryBuilder } from "./summary";

/** A refusal by a primitive or by commit validation; nothing is applied. */
export class Rejected extends Error {
  readonly rejection: Rejection;

  constructor(rejection: Rejection) {
    super(`rejected: ${rejection.type}${"message" in rejection ? `: ${rejection.message}` : ""}`);
    this.name = "Rejected";
    this.rejection = rejection;
  }
}

/** What a group says about itself besides its effects. */
export interface TransactionMeta {
  kind: OpGroup["kind"];
  label: string;
  origin?: { object: ObjectId; action: string };
  /** The absolute index of the group reversed; exactly for kind `undo`. */
  undoes?: number;
}

/** What internal hooks and public listeners receive, right after the commit point. */
export interface CommitPayload {
  group: FrozenGroup;
  summary: DeepReadonly<ChangeSummary>;
  /** The document just before the commit; nothing changes it any more. */
  before: DocView;
}

export type CommitListener = (payload: CommitPayload) => void;

export interface CommitResult {
  group: FrozenGroup;
  summary: ChangeSummary;
  /** What public listeners threw, in the order they ran. The commit stands. */
  listenerErrors: unknown[];
}

/** The store's side of a transaction. */
export interface TransactionHost {
  /**
   * The commit point: publishes `working` and appends `group` together, and
   * closes the transaction's slot. Throws, publishing nothing, if `group`
   * breaks the history's undo invariants.
   */
  publish(
    working: DocState,
    group: Omit<OpGroup, "index">,
    inverses: HistoricalInverse[],
  ): FrozenGroup;
  /**
   * Runs internal hooks, then public listeners. Returns what public listeners
   * threw; an internal hook's error propagates.
   */
  notify(payload: CommitPayload): unknown[];
  /** Closes the transaction's slot before the commit point. */
  release(): void;
}

export type TransactionState = "open" | "committed" | "aborted";

/**
 * A view of a transaction's live working copy whose record reads are
 * copies, so mutating them cannot reach the working copy.
 */
function copyingView(doc: DocState): DocView {
  const copy = structuredClone;
  return {
    get revision() {
      return doc.revision;
    },
    get nextSeq() {
      return doc.nextSeq;
    },
    toSnapshot: () => doc.toSnapshot(),
    getObject: (id) => {
      const o = doc.getObject(id);
      return o === undefined ? undefined : copy(o);
    },
    hasObject: (id) => doc.hasObject(id),
    objectIds: () => doc.objectIds(),
    getBoard: (id) => {
      const b = doc.getBoard(id);
      return b === undefined ? undefined : copy(b);
    },
    boardIndex: (id) => doc.boardIndex(id),
    boards: () => doc.boards(),
    getCell: (id, cell) => {
      const c = doc.getCell(id, cell);
      return c === undefined ? undefined : copy(c);
    },
    getCellVisibility: (id, cell) => {
      const v = doc.getCellVisibility(id, cell);
      return v === undefined ? undefined : copy(v);
    },
    containerOf: (id) => doc.containerOf(id),
    boardOf: (id) => doc.boardOf(id),
    locationOf: (id) => doc.locationOf(id),
    contentsOf: (id) => doc.contentsOf(id),
    subtreeOf: (id) => doc.subtreeOf(id),
    objectsOnBoard: (board) => doc.objectsOnBoard(board),
    isReserved: (id) => doc.isReserved(id),
    isRetired: (id) => doc.isRetired(id),
  };
}

/** The name an object has in `state`: its `name` cell's text, or "" when it has none. */
function nameIn(state: DocState, id: ObjectId): string {
  const content = state.getCell(id, "name")?.content;
  return content?.type === "text" ? content.value : "";
}

/** The objects an effect touches: those its undo conflict keys name (DESIGN.md §7). */
function touchedObjects(e: Effect): ObjectId[] {
  const container = (at: { type: string; container?: ObjectId }) =>
    at.type === "container" && at.container !== undefined ? [at.container] : [];
  switch (e.type) {
    case "cell":
    case "cell_visibility":
    case "field":
      return [e.object];
    case "place":
      return [e.object, ...container(e.before), ...container(e.after)];
    case "create":
    case "remove":
      return [...e.objects.map((o) => o.id), ...container(e.location)];
    case "reorder":
      return [e.container];
    case "board":
    case "allocate":
    case "retire":
      return [];
  }
}

function deepFreeze<T>(x: T): DeepReadonly<T> {
  if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x as DeepReadonly<T>;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class Transaction {
  readonly actor: Actor;
  readonly meta: Readonly<TransactionMeta>;
  readonly #base: DocState;
  readonly #working: DocState;
  readonly #view: DocView;
  readonly #host: TransactionHost;
  readonly #effects: Effect[] = [];
  readonly #inverses: HistoricalInverse[] = [];
  readonly #summary = new SummaryBuilder();
  readonly #touched = new Set<ObjectId>();
  /** Names of objects just before a removal in this transaction. */
  readonly #removedNames = new Map<ObjectId, string>();
  #state: TransactionState = "open";
  /** An effect failed to apply; the working copy is unspecified. */
  #broken = false;

  /** Use `DocumentStore.begin`. `working` is the transaction's own copy of `base`. */
  constructor(
    actor: Actor,
    meta: TransactionMeta,
    base: DocState,
    working: DocState,
    host: TransactionHost,
  ) {
    this.actor = structuredClone(actor);
    this.meta = structuredClone(meta);
    this.#base = base;
    this.#working = working;
    this.#view = copyingView(working);
    this.#host = host;
  }

  get state(): TransactionState {
    return this.#state;
  }

  /** The working copy, with every recorded effect applied; record reads are copies. */
  get doc(): DocView {
    return this.#view;
  }

  /** The change summary of the effects recorded so far. */
  changes(): ChangeSummary {
    return this.#summary.build();
  }

  #requireOpen(what: string): void {
    if (this.#state !== "open") throw new Error(`${what}: the transaction is ${this.#state}`);
    if (this.#broken) throw new Error(`${what}: an effect failed to apply; abort the transaction`);
  }

  /**
   * Applies a resolved effect to the working copy and appends it. An effect
   * that does not apply is a bug in its primitive: this throws, and the
   * transaction can then only be aborted.
   */
  record(effect: Effect): void {
    this.#requireOpen("record");
    const e = structuredClone(effect);
    const w = this.#working;
    try {
      const inverse = historicalInverse(e, w);
      if (e.type === "remove") {
        for (const o of e.objects) {
          if (w.hasObject(o.id)) this.#removedNames.set(o.id, nameIn(w, o.id));
        }
      }
      this.#summary.add(e, w);
      applyEffect(w, e);
      this.#inverses.push(inverse);
    } catch (err) {
      this.#broken = true;
      throw err;
    }
    this.#effects.push(e);
    for (const id of touchedObjects(e)) this.#touched.add(id);
  }

  /**
   * Validates the working copy and commits. Before the commit point, a
   * failure closes the transaction as aborted: an invalid document throws
   * Rejected({type: "invalid"}). After it, an internal hook's error
   * propagates with the commit standing.
   */
  commit(): CommitResult {
    this.#requireOpen("commit");
    let group: FrozenGroup;
    try {
      const violations = validateSnapshot(this.#working.toSnapshot());
      if (violations.length > 0) {
        throw new Rejected({
          type: "invalid",
          message: violations.map((v) => v.message).join("; "),
        });
      }
      const draft = this.#group();
      this.#working.revision = draft.revision;
      group = this.#host.publish(this.#working, draft, this.#inverses);
    } catch (err) {
      this.abort();
      throw err;
    }
    this.#state = "committed";
    const summary = this.#summary.build();
    const listenerErrors = this.#host.notify({
      group,
      summary: deepFreeze(this.#summary.build()),
      before: this.#base,
    });
    return { group, summary, listenerErrors };
  }

  #group(): Omit<OpGroup, "index"> {
    const names: Record<ObjectId, string> = {};
    for (const id of [...this.#touched].sort(byString)) {
      const name = this.#working.hasObject(id)
        ? nameIn(this.#working, id)
        : this.#removedNames.get(id);
      if (name !== undefined) names[id] = name;
    }
    const { kind, label, origin, undoes } = this.meta;
    return {
      base_revision: this.#base.revision,
      revision: this.#base.revision + 1,
      actor: structuredClone(this.actor),
      kind,
      label,
      ...(origin !== undefined ? { origin: { ...origin } } : {}),
      ...(undoes !== undefined ? { undoes } : {}),
      names,
      effects: this.#effects,
    };
  }

  /** Discards everything. A no-op on an aborted transaction; refused after commit. */
  abort(): void {
    if (this.#state === "aborted") return;
    if (this.#state === "committed") throw new Error("abort: the transaction is committed");
    this.#state = "aborted";
    this.#host.release();
  }
}
