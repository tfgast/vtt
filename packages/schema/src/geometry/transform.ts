import type { Point, Shape } from "../shape";

/** Unit rotation for `deg` degrees clockwise on screen (x right, y down). */
export interface Rotation {
  cos: number;
  sin: number;
}

/**
 * Quarter turns are exact so that axis-aligned results (90°, 180°, 270°) are
 * not perturbed by `Math.cos(Math.PI / 2)` and friends.
 */
export function rotation(deg: number): Rotation {
  const turned = ((deg % 360) + 360) % 360;
  if (turned === 0) return { cos: 1, sin: 0 };
  if (turned === 90) return { cos: 0, sin: 1 };
  if (turned === 180) return { cos: -1, sin: 0 };
  if (turned === 270) return { cos: 0, sin: -1 };
  const rad = (turned * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

/** Local (relative to the anchor, unrotated) to board coordinates. */
export function toWorld(local: Point, anchor: Point, r: Rotation): Point {
  const [x, y] = local;
  // `+ 0` normalises -0 so exact results compare equal to literals.
  return [anchor[0] + (x * r.cos - y * r.sin) + 0, anchor[1] + (x * r.sin + y * r.cos) + 0];
}

/** Board coordinates to local (relative to the anchor, unrotated). */
export function toLocal(world: Point, anchor: Point, r: Rotation): Point {
  const dx = world[0] - anchor[0];
  const dy = world[1] - anchor[1];
  return [dx * r.cos + dy * r.sin + 0, -dx * r.sin + dy * r.cos + 0];
}

/** The outline of a rect or polygon in local coordinates. */
export function localOutline(shape: Exclude<Shape, { type: "circle" }>): Point[] {
  if (shape.type === "polygon") return shape.points;
  const w = shape.width / 2;
  const h = shape.height / 2;
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ];
}

/** `points` translated so that `origin` is at (0, 0). */
export function relativeTo(points: Point[], origin: Point): Point[] {
  return points.map((p) => [p[0] - origin[0], p[1] - origin[1]]);
}

/**
 * Board position of a local outline's first vertex. Outlines are placed and
 * measured relative to it, so a shape far from its anchor keeps its own
 * small-scale geometry exact instead of cancelling large coordinates.
 */
export function outlineOrigin(outline: Point[], anchor: Point, r: Rotation): Point {
  return toWorld(outline[0] ?? [0, 0], anchor, r);
}

/** A local outline in board coordinates, each vertex placed from the first. */
export function placeOutline(outline: Point[], anchor: Point, r: Rotation): Point[] {
  const [ox, oy] = outlineOrigin(outline, anchor, r);
  return relativeTo(outline, outline[0] ?? [0, 0]).map(([x, y]) => [
    ox + (x * r.cos - y * r.sin) + 0,
    oy + (x * r.sin + y * r.cos) + 0,
  ]);
}
