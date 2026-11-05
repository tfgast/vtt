/**
 * Affine transforms for faces (DESIGN.md §4.6 Zoom as level of detail,
 * nested objects; M5 plan review r2 finding 3): an object's frame (origin at
 * the anchor, y down, unrotated) to its container's frame or the board, and
 * the on-screen size `min_size` compares against. Pure.
 */
import type { Bounds, Point, Rect } from "@vtt/schema";
import { type Camera, cameraScale } from "../scene/camera";

/**
 * A 2×3 affine transform `[a, b, c, d, e, f]`, in canvas `setTransform`
 * order: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Affine = Object.freeze([1, 0, 0, 1, 0, 0] as const);

export function translate(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}

export function scale(s: number): Affine {
  return [s, 0, 0, s, 0, 0];
}

/** `deg` degrees clockwise on screen (x right, y down); quarter turns are exact. */
export function rotate(deg: number): Affine {
  const turned = ((deg % 360) + 360) % 360;
  let cos: number;
  let sin: number;
  if (turned === 0) [cos, sin] = [1, 0];
  else if (turned === 90) [cos, sin] = [0, 1];
  else if (turned === 180) [cos, sin] = [-1, 0];
  else if (turned === 270) [cos, sin] = [0, -1];
  else {
    const rad = (turned * Math.PI) / 180;
    [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  }
  return [cos, sin, -sin, cos, 0, 0];
}

/**
 * The composition, outermost first: `apply(compose(m, n), p)` is
 * `apply(m, apply(n, p))`. No argument is the identity.
 */
export function compose(...ms: Affine[]): Affine {
  let out: Affine = IDENTITY;
  for (const n of ms) {
    const [a, b, c, d, e, f] = out;
    const [na, nb, nc, nd, ne, nf] = n;
    out = [
      a * na + c * nb,
      b * na + d * nb,
      a * nc + c * nd,
      b * nc + d * nd,
      a * ne + c * nf + e,
      b * ne + d * nf + f,
    ];
  }
  return out;
}

/** The inverse; throws for a singular transform. */
export function invert(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) throw new Error("invert: singular transform");
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply(m: Affine, p: Point): Point {
  const [a, b, c, d, e, f] = m;
  // `+ 0` normalises -0 so exact results compare equal to literals.
  return [a * p[0] + c * p[1] + e + 0, b * p[0] + d * p[1] + f + 0];
}

/**
 * Maps `from` into `to` with one uniform scale (the smaller of the two
 * fits) and their top-left corners aligned.
 */
export function rectToRect(from: Rect, to: Rect): Affine {
  const s = Math.min(to[2] / from[2], to[3] / from[3]);
  return [s, 0, 0, s, to[0] - from[0] * s, to[1] - from[1] * s];
}

/** The axis-aligned box of `rect` after `m`. */
export function aabb(rect: Rect, m: Affine): Bounds {
  const [x, y, w, h] = rect;
  const corners: Point[] = [
    apply(m, [x, y]),
    apply(m, [x + w, y]),
    apply(m, [x + w, y + h]),
    apply(m, [x, y + h]),
  ];
  return {
    minX: Math.min(...corners.map((p) => p[0])),
    minY: Math.min(...corners.map((p) => p[1])),
    maxX: Math.max(...corners.map((p) => p[0])),
    maxY: Math.max(...corners.map((p) => p[1])),
  };
}

/**
 * The height of `rect` in CSS px after `m` (the accumulated transform to the
 * board) and the camera: the length of its transformed vertical side, so
 * rotation does not change it. `min_size` compares against this.
 */
export function screenHeight(rect: Rect, m: Affine, camera: Camera): number {
  return rect[3] * Math.hypot(m[2], m[3]) * cameraScale(camera);
}

/** An object's frame to the board: its anchor, then its rotation (degrees clockwise). */
export function itemTransform(item: { anchor: Point; rotation: number }): Affine {
  return compose(translate(item.anchor[0], item.anchor[1]), rotate(item.rotation));
}

/** The smallest rect holding every one of `rects` (at least one). */
export function unionRect(first: Rect, ...rects: Rect[]): Rect {
  let [minX, minY] = [first[0], first[1]];
  let [maxX, maxY] = [first[0] + first[2], first[1] + first[3]];
  for (const [x, y, w, h] of rects) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return [minX, minY, maxX - minX, maxY - minY];
}
