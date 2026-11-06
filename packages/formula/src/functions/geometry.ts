/**
 * Geometry cell readings and id order shared by the spatial functions
 * (FORMULAS.md §5, §6) and the authority's views, queries and cover oracle.
 */
import type { Point, Result } from "@vtt/schema";

/** A z or rotation as a number: empty as 0, a roll result as its total, else undefined. */
export function geometryNumber(r: Result): number | undefined {
  switch (r.type) {
    case "number":
      return r.value;
    case "empty":
      return 0;
    case "roll":
      return r.total;
    default:
      return undefined;
  }
}

/** The anchor, if `r` is a list of two finite numbers. */
export function anchorOf(r: Result): Point | undefined {
  if (r.type !== "list" || r.items.length !== 2) return undefined;
  const [x, y] = r.items;
  if (x?.type !== "number" || y?.type !== "number") return undefined;
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return undefined;
  return [x.value, y.value];
}

/** Compares ids by Unicode code point (FORMULAS.md §5 order). */
export function compareIds(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}
