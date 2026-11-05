import type { Bounds, Point, Shape } from "../shape";
import { GEOM_EPSILON } from "./constants";
import { localOutline, rotation, toWorld } from "./transform";

/**
 * The axis-aligned box of the footprint after rotation. A null shape gives
 * the degenerate box at the anchor.
 */
export function shapeBounds(shape: Shape | null, anchor: Point, rotationDeg: number): Bounds {
  const [x, y] = anchor;
  if (shape === null) return { minX: x, minY: y, maxX: x, maxY: y };
  if (shape.type === "circle") {
    const r = shape.radius;
    return { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
  }
  const rot = rotation(rotationDeg);
  const b: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (const p of localOutline(shape)) {
    const [wx, wy] = toWorld(p, anchor, rot);
    b.minX = Math.min(b.minX, wx);
    b.minY = Math.min(b.minY, wy);
    b.maxX = Math.max(b.maxX, wx);
    b.maxY = Math.max(b.maxY, wy);
  }
  return b;
}

/**
 * The box that defines the candidate set: the union of the footprint's
 * bounds and the anchor point, expanded by GEOM_EPSILON on every side.
 */
export function indexBounds(shape: Shape | null, anchor: Point, rotationDeg: number): Bounds {
  const b = shapeBounds(shape, anchor, rotationDeg);
  return {
    minX: Math.min(b.minX, anchor[0]) - GEOM_EPSILON,
    minY: Math.min(b.minY, anchor[1]) - GEOM_EPSILON,
    maxX: Math.max(b.maxX, anchor[0]) + GEOM_EPSILON,
    maxY: Math.max(b.maxY, anchor[1]) + GEOM_EPSILON,
  };
}

/** Inclusive: boxes that touch intersect. */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Euclidean distance between two anchors, in raw board units. */
export function anchorDistance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
