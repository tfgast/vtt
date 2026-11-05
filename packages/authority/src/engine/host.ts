/**
 * DocumentHost (FORMULAS.md §3, §3.1, §6; DESIGN.md §7): the formula
 * engine's `EvalHost` over the document store's committed document and the
 * spatial index. It never evaluates a formula.
 *
 * - `exists`: live objects and live boards. A missing id is how `#REF`
 *   arises.
 * - `cell`: the stored content, with an override returned as its literal;
 *   structural cells read per STRUCTURAL_CELLS through the store's
 *   `getCell` (field-backed cells from their fields, `container` derived,
 *   `shape` as a shape value or empty, unstored cell-backed ones as their
 *   defaults). Returned values are the committed document's frozen records.
 * - `objectsNamed`: exact match over literal `name`s.
 * - `objectsOnBoard`: exactly `SpatialIndex.candidates`, the literal-geometry
 *   candidate set. Exact geometry is the evaluator's.
 */
import type { EvalHost } from "@vtt/formula";
import type { Bounds, CellContent, ObjectId } from "@vtt/schema";
import type { SpatialIndex } from "../spatial/index";
import type { DocView } from "../store/document-store";

/** What the host reads: the store's committed document. */
export type DocumentHostSource = Pick<
  DocView,
  "hasObject" | "boardIndex" | "getCell" | "objectIds"
>;

export class DocumentHost implements EvalHost {
  readonly #doc: DocumentHostSource;
  readonly #index: Pick<SpatialIndex, "candidates">;

  constructor(doc: DocumentHostSource, index: Pick<SpatialIndex, "candidates">) {
    this.#doc = doc;
    this.#index = index;
  }

  exists(id: ObjectId): boolean {
    return this.#doc.hasObject(id) || this.#doc.boardIndex(id) >= 0;
  }

  cell(id: ObjectId, name: string): CellContent | undefined {
    const stored = this.#doc.getCell(id, name);
    if (stored === undefined) return undefined;
    return (stored.override ?? stored.content) as CellContent;
  }

  objectsNamed(name: string): ObjectId[] {
    return this.#doc.objectIds().filter((id) => {
      const n = this.#doc.getCell(id, "name")?.content;
      return n?.type === "text" && n.value === name;
    });
  }

  allObjects(): ObjectId[] {
    return this.#doc.objectIds();
  }

  objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[] {
    return this.#index.candidates(board, near);
  }
}
