import type { Point, Shape } from "../shape";
import { GEOM_EPSILON } from "./constants";
import { localOutline, rotation, toLocal } from "./transform";

/** Distance from `p` to the segment `ab`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const len2 = ex * ex + ey * ey;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ey));
}

/** Even-odd ray casting along +x. */
function rayCast(p: Point, outline: Point[]): boolean {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i] as Point;
    const [xj, yj] = outline[j] as Point;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether `point` lies in the region of `shape` placed at `anchor` and rotated
 * `rotationDeg` degrees clockwise about it. Boundary inclusive within
 * GEOM_EPSILON, measured as a distance.
 */
export function pointInRegion(
  point: Point,
  shape: Shape,
  anchor: Point,
  rotationDeg: number,
): boolean {
  if (shape.type === "circle") {
    return Math.hypot(point[0] - anchor[0], point[1] - anchor[1]) <= shape.radius + GEOM_EPSILON;
  }
  const p = toLocal(point, anchor, rotation(rotationDeg));
  const outline = localOutline(shape);
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    if (segmentDistance(p, outline[j] as Point, outline[i] as Point) <= GEOM_EPSILON) return true;
  }
  return rayCast(p, outline);
}
