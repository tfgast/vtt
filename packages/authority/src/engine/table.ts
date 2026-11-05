/**
 * Table (DESIGN.md §4.2, §4.4, §7; FORMULAS.md §7): the document store, the
 * spatial index, the formula engine over a DocumentHost, and Visibility with
 * the engine as its reader and EngineCover as its cover query, kept in step.
 *
 * Formulas evaluate only here, in the authority. One internal commit hook
 * (`store.onCommitInternal`) applies each commit to the index and then calls
 * `engine.invalidate` once with the commit's changes, so it runs right after
 * the commit point and before every public `onCommit` listener, including
 * listeners registered before the table was constructed: a public listener
 * always reads the new revision's values.
 */
import { type Change, createEngine, type Engine, type EngineOptions } from "@vtt/formula";
import type { ObjectId, Result, Snapshot } from "@vtt/schema";
import { SpatialIndex } from "../spatial/index";
import { DocumentStore } from "../store/document-store";
import type { DeepReadonly, History } from "../store/history";
import type { ChangeSummary } from "../store/summary";
import { Visibility } from "../visibility";
import { EngineCover } from "./cover";
import { DocumentHost } from "./host";

/**
 * The engine changes of one commit: a `cell` change for every key of
 * `summary.changedCells` (all derived changes included: a move's `board`,
 * `position`, `rotation`, `z`, `container` and both containers' `contents`;
 * tag and shape field changes; every readable cell of created and removed
 * objects; per-cell visibility changes produce none), then
 * `object_created` / `object_deleted` for every object in each created or
 * removed subtree, and for every created or removed board, since boards
 * exist for `exists` and reference validation.
 */
export function engineChanges(summary: DeepReadonly<ChangeSummary>): Change[] {
  const changes: Change[] = [];
  for (const key of summary.changedCells) {
    const sep = key.indexOf(":");
    changes.push({ type: "cell", object: key.slice(0, sep), cell: key.slice(sep + 1) });
  }
  for (const id of [...summary.created, ...summary.boardsCreated]) {
    changes.push({ type: "object_created", object: id });
  }
  for (const id of [...summary.removed, ...summary.boardsRemoved]) {
    changes.push({ type: "object_deleted", object: id });
  }
  return changes;
}

export class Table {
  readonly store: DocumentStore;
  readonly index: SpatialIndex;
  readonly host: DocumentHost;
  readonly engine: Engine;
  readonly cover: EngineCover;
  readonly visibility: Visibility;

  private constructor(store: DocumentStore, options: EngineOptions) {
    this.store = store;
    this.index = new SpatialIndex(store);
    this.host = new DocumentHost(store, this.index);
    this.engine = createEngine(this.host, options);
    const reader = { value: (obj: ObjectId, cell: string) => this.engine.value(obj, cell) };
    this.cover = new EngineCover(store, this.index, reader);
    this.visibility = new Visibility(store, reader, this.cover);
    store.onCommitInternal(({ group, summary }) => {
      this.index.applyCommit({ group, summary });
      this.engine.invalidate(engineChanges(summary));
    });
  }

  /** A table over a new store holding a copy of `snapshot` (see DocumentStore.fromSnapshot). */
  static fromSnapshot(snapshot: Snapshot, history?: History, options: EngineOptions = {}): Table {
    return new Table(DocumentStore.fromSnapshot(snapshot, history), options);
  }

  /**
   * A table over an existing store, from its current document. Its commit
   * hook is internal, so it runs before public listeners the store already
   * has. Throws if a transaction is open.
   */
  static fromStore(store: DocumentStore, options: EngineOptions = {}): Table {
    if (store.openTransaction !== null) throw new Error("Table.fromStore: a transaction is open");
    return new Table(store, options);
  }

  /** The result of `obj`.`cell` at the store's current revision (`engine.value`). */
  value(obj: ObjectId, cell: string): Result {
    return this.engine.value(obj, cell);
  }

  /** Whether `obj`.`cell` holds a formula with an override. */
  isOverridden(obj: ObjectId, cell: string): boolean {
    return this.store.getCell(obj, cell)?.override !== undefined;
  }
}
