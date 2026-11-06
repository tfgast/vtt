/**
 * ActionContext (FORMULAS.md §8.1, "Reads inside an action"; §6): the
 * `EvalEnv` an action's steps evaluate through, over a committed `Table`
 * and the action's open transaction. Formulas are never evaluated before
 * commit, so a read is one of:
 *
 * 1. Existence. An object removed earlier in the transaction does not
 *    exist, nor does one that neither existed at the start nor was created
 *    in it; any read of a missing object is `#REF`.
 * 2. An object created in the transaction (spawned or created) reads every
 *    cell from the working copy (2a below).
 * 3. On an existing object, a cell the transaction changed (any key of
 *    `tx.changes().changedCells`: written cells, same-value writes
 *    included, and the cells a move, create, remove, reorder or tag/shape
 *    change derives) reads from the working copy (2a).
 * 4. Any other cell reads `table.value`, still the start-of-action value
 *    because recompute runs only after commit.
 *
 * 2a. A working-copy read: a literal as stored, a formula with an override
 *     as the override, a formula without one as `empty`; structural cells
 *     with their defaults and derivations (DocState.getCell).
 *
 * Every value read is checked for references to objects that do not exist
 * in the transaction (FORMULAS §2.4), so a reference to an object removed
 * by an earlier step reads `#REF`, as it will after commit.
 *
 * Queries read the working copy: `objectsNamed` and `allObjects` its live
 * objects, `objectsOnBoard` the literal-geometry candidate set of FORMULAS
 * §6 computed by brute force (the spatial index reflects only committed
 * state). Candidate geometry is then read by the evaluator through `read`.
 *
 * Rules 2 and 3 ask the transaction (`tx.hasCreated`, `tx.hasChanged`)
 * rather than building `tx.changes()`, which copies the summary so far, so
 * a read costs the same however much the transaction has changed.
 */
import { type EvalEnv, validateRefs } from "@vtt/formula";
import {
  type Bounds,
  boundsIntersect,
  type Cell,
  EMPTY,
  err,
  indexBounds,
  type ObjectId,
  type Point,
  type Result,
  type Shape,
} from "@vtt/schema";
import type { DocView } from "../store/document-store";
import type { Transaction } from "../store/transaction";
import type { Table } from "./table";

/** The geometry cells whose formula makes an object always a candidate (FORMULAS §6). */
const GEOMETRY_CELLS = ["position", "rotation", "z"] as const;

/** What the context needs of a table: its start-of-action values and committed host. */
export type ActionContextTable = Pick<Table, "value" | "host">;

export class ActionContext implements EvalEnv {
  readonly #table: ActionContextTable;
  readonly #tx: Transaction;

  constructor(table: ActionContextTable, tx: Transaction) {
    this.#table = table;
    this.#tx = tx;
  }

  read(id: ObjectId, cell: string): Result | undefined {
    if (!this.#exists(id)) return err("#REF", `reference to deleted object ${id}`);
    const exists = (o: ObjectId) => this.#exists(o);
    if (this.#tx.hasCreated(id) || this.#tx.hasChanged(id, cell)) {
      const content = workingContent(this.#tx.doc, id, cell);
      return content === undefined ? undefined : validateRefs(content, exists);
    }
    if (this.#table.host.cell(id, cell) === undefined) return undefined;
    return validateRefs(this.#table.value(id, cell), exists);
  }

  exists(id: ObjectId): boolean {
    return this.#exists(id);
  }

  objectsNamed(name: string): ObjectId[] {
    const doc = this.#tx.doc;
    return doc.objectIds().filter((id) => {
      const n = doc.getCell(id, "name")?.content;
      return n?.type === "text" && n.value === name;
    });
  }

  allObjects(): ObjectId[] {
    return this.#tx.doc.objectIds();
  }

  /**
   * Every object placed directly on `board` in the working copy whose
   * literal index bounds intersect `near` (inclusive), plus every object
   * there with a formula-valued `position`, `rotation` or `z` (an override
   * counts as its literal). An object whose literal position is not two
   * finite numbers is not a candidate by bounds.
   */
  objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[] {
    const doc = this.#tx.doc;
    return doc.objectsOnBoard(board).filter((id) => {
      const [position, rotation, z] = GEOMETRY_CELLS.map((c) => doc.getCell(id, c));
      const isFormula = (c: typeof position) =>
        c !== undefined && c.content.type === "formula" && c.override === undefined;
      if (isFormula(position) || isFormula(rotation) || isFormula(z)) return true;
      const p = position?.override ?? position?.content;
      if (p?.type !== "list" || p.items.length !== 2) return false;
      const [x, y] = p.items;
      if (x?.type !== "number" || y?.type !== "number") return false;
      if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return false;
      const anchor: Point = [x.value, y.value];
      const r = rotation?.override ?? rotation?.content;
      const deg = r?.type === "number" && Number.isFinite(r.value) ? r.value : 0;
      const s = doc.getCell(id, "shape")?.content;
      const shape = s?.type === "shape" ? (s.shape as Shape) : null;
      return boundsIntersect(indexBounds(shape, anchor, deg), near);
    });
  }

  /**
   * Rule 1, read off the working copy: an object removed in the transaction
   * is gone from it, one created in it is there, and every other object or
   * board is there exactly when it was at the start. (Equivalent to
   * consulting `tx.changes()`'s created and removed lists, without the copy.)
   */
  #exists(id: ObjectId): boolean {
    const doc = this.#tx.doc;
    return doc.hasObject(id) || doc.boardIndex(id) >= 0;
  }
}

/** A working-copy read (2a): literal, override, or `empty` for a formula without one. */
function workingContent(doc: DocView, id: ObjectId, cell: string): Result | undefined {
  // The transaction's view returns copies, so dropping readonly is safe.
  const stored = doc.getCell(id, cell) as Cell | undefined;
  if (stored === undefined) return undefined;
  if (stored.override !== undefined) return stored.override;
  return stored.content.type === "formula" ? EMPTY : stored.content;
}
