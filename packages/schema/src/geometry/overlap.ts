import type { Point, Shape } from "../shape";
import { GEOM_EPSILON } from "./constants";
import { pointInRegion } from "./point";
import { localOutline, placeOutline, rotation } from "./transform";
import { triangulate } from "./triangulate";

/** An object's footprint: its shape, or a point when it has none. */
export interface Footprint {
  shape: Shape | null;
  anchor: Point;
  /** Degrees clockwise on screen about the anchor. */
  rotation: number;
}

/** A convex piece in board coordinates. */
type Piece = { kind: "circle"; centre: Point; radius: number } | { kind: "poly"; points: Point[] };

/**
 * Convex pieces of positive area: a circle stays whole, a rect is one
 * quadrilateral, a polygon is its ear-clipping triangles. A shape without
 * area (a non-positive size, a polygon whose points are collinear) yields no
 * pieces and so overlaps nothing.
 */
function pieces(shape: Shape, anchor: Point, deg: number): Piece[] {
  if (shape.type === "circle") {
    return shape.radius > 0 ? [{ kind: "circle", centre: anchor, radius: shape.radius }] : [];
  }
  const r = rotation(deg);
  if (shape.type === "rect") {
    return shape.width > 0 && shape.height > 0
      ? [{ kind: "poly", points: placeOutline(localOutline(shape), anchor, r) }]
      : [];
  }
  // Place the whole outline once, so triangles share exactly the same vertices.
  return triangulate(placeOutline(shape.points, anchor, r)).map((points) => ({
    kind: "poly",
    points,
  }));
}

interface Range {
  min: number;
  max: number;
}

/** Projection onto `axis`, measured from `o` so large coordinates do not cancel. */
function project(piece: Piece, axis: Point, o: Point): Range {
  if (piece.kind === "circle") {
    const c = (piece.centre[0] - o[0]) * axis[0] + (piece.centre[1] - o[1]) * axis[1];
    return { min: c - piece.radius, max: c + piece.radius };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of piece.points) {
    const d = (p[0] - o[0]) * axis[0] + (p[1] - o[1]) * axis[1];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/** Unit vector along (x, y), or undefined for the zero vector. */
function unit(x: number, y: number): Point | undefined {
  const len = Math.hypot(x, y);
  return len === 0 ? undefined : [x / len, y / len];
}

function edgeNormals(points: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] as Point;
    const [xj, yj] = points[j] as Point;
    const n = unit(yj - yi, xi - xj);
    if (n) out.push(n);
  }
  return out;
}

/** The axis from a circle's centre to the polygon vertex nearest it. */
function nearestVertexAxis(centre: Point, points: Point[]): Point | undefined {
  let best: Point | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const d = Math.hypot(p[0] - centre[0], p[1] - centre[1]);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best && unit(best[0] - centre[0], best[1] - centre[1]);
}

/**
 * Convex pieces overlap unless some separating axis has
 * max1 <= min2 + GEOM_EPSILON (either way round); circle pairs compare
 * centre distance against r1 + r2 - GEOM_EPSILON. Axes are unit length, so
 * the tolerance is a distance.
 */
function piecesOverlap(a: Piece, b: Piece): boolean {
  if (a.kind === "circle" && b.kind === "circle") {
    const d = Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]);
    return d < a.radius + b.radius - GEOM_EPSILON;
  }
  const axes: Point[] = [];
  for (const [p, q] of [
    [a, b],
    [b, a],
  ] as const) {
    if (p.kind === "poly") {
      axes.push(...edgeNormals(p.points));
      if (q.kind === "circle") {
        const v = nearestVertexAxis(q.centre, p.points);
        if (v) axes.push(v);
      }
    }
  }
  const o = a.kind === "circle" ? a.centre : (a.points[0] as Point);
  for (const axis of axes) {
    const ra = project(a, axis, o);
    const rb = project(b, axis, o);
    if (ra.max <= rb.min + GEOM_EPSILON || rb.max <= ra.min + GEOM_EPSILON) return false;
  }
  return true;
}

/**
 * Whether two footprints overlap: their intersection has positive area, so
 * touching or near-tangent footprints (penetrating by at most GEOM_EPSILON)
 * do not. The one exception: a point footprint overlaps a shape when the
 * point is in its region, boundary inclusive; two points never overlap.
 */
export function footprintsOverlap(a: Footprint, b: Footprint): boolean {
  if (a.shape === null && b.shape === null) return false;
  if (a.shape === null) return pointInRegion(a.anchor, b.shape as Shape, b.anchor, b.rotation);
  if (b.shape === null) return pointInRegion(b.anchor, a.shape, a.anchor, a.rotation);
  const pa = pieces(a.shape, a.anchor, a.rotation);
  const pb = pieces(b.shape, b.anchor, b.rotation);
  return pa.some((x) => pb.some((y) => piecesOverlap(x, y)));
}
