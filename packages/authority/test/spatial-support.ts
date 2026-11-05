/** Shared by the spatial index tests: the brute-force candidate set. */
import { type DocumentStore, SpatialIndex } from "@vtt/authority";
import {
  type Bounds,
  boundsIntersect,
  type Cell,
  type CellContent,
  indexBounds,
  type ObjectId,
  type Point,
  type Shape,
} from "@vtt/schema";
import { expect } from "vitest";

/** The literal a cell reads as: its override, else its content. */
const literalOf = (c: Cell | undefined): CellContent | undefined =>
  c === undefined ? undefined : (c.override ?? c.content);

const isFormulaCell = (c: Cell | undefined): boolean =>
  c !== undefined && c.content.type === "formula" && c.override === undefined;

/**
 * FORMULAS §6 by brute force: every object directly on `board` whose literal
 * indexBounds meet `near`, plus every object on it with a formula-valued
 * geometry cell. Shape is a field and never holds a formula.
 */
export function reference(store: DocumentStore, board: string, near: Bounds): ObjectId[] {
  const out: ObjectId[] = [];
  for (const id of store.objectIds()) {
    const o = store.getObject(id);
    if (o === undefined || o.board !== board) continue;
    const [position, rotation, z] = (["position", "rotation", "z"] as const).map(
      (c) => store.getCell(id, c) as Cell | undefined,
    );
    if ([position, rotation, z].some(isFormulaCell)) {
      out.push(id);
      continue;
    }
    const p = literalOf(position);
    if (
      p?.type !== "list" ||
      p.items.length !== 2 ||
      !p.items.every((i) => i.type === "number" && Number.isFinite(i.value))
    ) {
      continue;
    }
    const anchor = p.items.map((i) => (i as { value: number }).value) as Point;
    const r = literalOf(rotation);
    const deg = r?.type === "number" && Number.isFinite(r.value) ? r.value : 0;
    if (boundsIntersect(indexBounds(o.shape as Shape | null, anchor, deg), near)) out.push(id);
  }
  return out.sort();
}

/** The index's candidates, sorted, after checking each id appears once. */
export function candidates(index: SpatialIndex, board: string, near: Bounds): ObjectId[] {
  const ids = index.candidates(board, near);
  expect(new Set(ids).size).toBe(ids.length);
  return [...ids].sort();
}

/** Expects the index to agree with the brute-force reference on `near`. */
export function expectAgrees(
  index: SpatialIndex,
  store: DocumentStore,
  board: string,
  near: Bounds,
): void {
  expect(candidates(index, board, near)).toEqual(reference(store, board, near));
}

/** An index over `store`, kept current as an internal commit hook. */
export function attach(store: DocumentStore): SpatialIndex {
  const index = new SpatialIndex(store);
  store.onCommitInternal((payload) => index.applyCommit(payload));
  return index;
}

export const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});
