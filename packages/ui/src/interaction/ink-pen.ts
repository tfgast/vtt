/**
 * Ink pens and the eraser's geometry (DESIGN.md §4.6 Ink and text; M5 plan
 * Q19; M6-D28). Pure: no React, no canvas.
 *
 * - A stroke is a bare point list (the default pen) or `{points, color?,
 *   width?}` (`@vtt/schema`'s `Stroke`); `strokePen` resolves either to its
 *   points, colour and width, absent fields taking the default pen's.
 * - The ink tool's pen picks its colour from `INK_PALETTE` and its width from
 *   `INK_WIDTHS`; `penStroke` writes a stroke with only the fields that
 *   differ from the default pen, so a default-pen stroke stays a bare list.
 * - Stored points are rounded to 0.001 board units (`roundInkPoint`).
 * - The eraser removes whole strokes: `strokeCrossed` is true when the
 *   eraser's path (a polyline, or one point for a tap) comes within
 *   `radius` plus half the stroke's width of the stroke's polyline, so a
 *   path that crosses a stroke (segments intersect, distance 0) always does.
 */
import type { Point, Stroke } from "@vtt/schema";

/** The default pen's colour (M5-D20's one pen). */
export const DEFAULT_INK_COLOR = "#202020";
/** The default pen's width in board units (M5-D20's one pen). */
export const DEFAULT_INK_WIDTH = 0.04;

/** One pen colour of the palette. */
export interface InkColorChoice {
  readonly color: string;
  readonly label: string;
}

/** The ink tool's colours, in toolbar order; the first is the default pen's. */
export const INK_PALETTE: readonly InkColorChoice[] = [
  { color: DEFAULT_INK_COLOR, label: "Black" },
  { color: "#d32f2f", label: "Red" },
  { color: "#1e63d6", label: "Blue" },
  { color: "#2e8b3a", label: "Green" },
  { color: "#f2b100", label: "Yellow" },
  { color: "#ffffff", label: "White" },
];

/** One pen width of the set. */
export interface InkWidthChoice {
  readonly width: number;
  readonly label: string;
}

/** The ink tool's widths in board units, thinnest first; "Medium" is the default pen's. */
export const INK_WIDTHS: readonly InkWidthChoice[] = [
  { width: 0.02, label: "Fine" },
  { width: DEFAULT_INK_WIDTH, label: "Medium" },
  { width: 0.08, label: "Bold" },
  { width: 0.16, label: "Marker" },
];

/** The eraser's reach around its path, in screen pixels (so a tap erases). */
export const ERASER_RADIUS_PX = 6;

/** A stroke resolved: its points, colour and width (defaults filled in). */
export interface ResolvedStroke {
  points: Point[];
  color: string;
  width: number;
}

/** `stroke`'s points, colour and width, absent fields taking the default pen's. */
export function strokePen(stroke: Stroke): ResolvedStroke {
  if (Array.isArray(stroke)) {
    return { points: stroke, color: DEFAULT_INK_COLOR, width: DEFAULT_INK_WIDTH };
  }
  return {
    points: stroke.points,
    color: stroke.color ?? DEFAULT_INK_COLOR,
    width: stroke.width ?? DEFAULT_INK_WIDTH,
  };
}

/**
 * `point` rounded to 0.001 board units, `-0` normalised to `0`: the ink tool
 * stores points this way so a save file stays readable (DESIGN.md §4.6 Ink
 * and text, §8.4 step 6). Thinning and the preview keep full precision.
 */
export function roundInkPoint(point: Point): Point {
  const round = (v: number) => Math.round(v * 1000) / 1000 || 0;
  return [round(point[0]), round(point[1])];
}

/**
 * The stroke of `points` drawn with `color` and `width`: a bare point list
 * for the default pen, else `{points}` with each field that differs from it.
 */
export function penStroke(points: Point[], color: string, width: number): Stroke {
  const c = color.toLowerCase() === DEFAULT_INK_COLOR ? undefined : color;
  const w = width === DEFAULT_INK_WIDTH ? undefined : width;
  if (c === undefined && w === undefined) return points;
  return {
    points,
    ...(c === undefined ? {} : { color: c }),
    ...(w === undefined ? {} : { width: w }),
  };
}

const cross = (o: Point, a: Point, b: Point) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Distance from `p` to segment `a`–`b` (a point when `a` equals `b`). */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether segments `a`–`b` and `c`–`d` properly cross (strict sign changes). */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Distance between segments `a`–`b` and `c`–`d`: 0 when they cross. */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

/** The segments of a polyline; one degenerate segment for a single point. */
function segments(points: readonly Point[]): [Point, Point][] {
  const [first] = points;
  if (first === undefined) return [];
  if (points.length === 1) return [[first, first]];
  const out: [Point, Point][] = [];
  for (let i = 1; i < points.length; i++) out.push([points[i - 1] as Point, points[i] as Point]);
  return out;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOf(points: readonly Point[], pad: number): Box {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    box.minX = Math.min(box.minX, x - pad);
    box.minY = Math.min(box.minY, y - pad);
    box.maxX = Math.max(box.maxX, x + pad);
    box.maxY = Math.max(box.maxY, y + pad);
  }
  return box;
}

const boxesMeet = (a: Box, b: Box) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/**
 * Whether the eraser path `path` (in the stroke's frame) crosses `stroke`:
 * some path segment comes within `radius` plus half the stroke's width of
 * some stroke segment. A path segment that intersects a stroke segment is
 * at distance 0, so a crossing always counts, whatever `radius`.
 */
export function strokeCrossed(path: readonly Point[], stroke: Stroke, radius: number): boolean {
  const { points, width } = strokePen(stroke);
  const reach = radius + width / 2;
  if (path.length === 0 || points.length === 0) return false;
  if (!boxesMeet(boxOf(path, reach), boxOf(points, 0))) return false;
  const eraser = segments(path);
  for (const [c, d] of segments(points)) {
    for (const [a, b] of eraser) {
      if (segmentDistance(a, b, c, d) <= reach) return true;
    }
  }
  return false;
}

/** The indices of the strokes of `strokes` that `path` crosses (`strokeCrossed`). */
export function crossedStrokes(
  path: readonly Point[],
  strokes: readonly Stroke[],
  radius: number,
): number[] {
  const out: number[] = [];
  strokes.forEach((s, i) => {
    if (strokeCrossed(path, s, radius)) out.push(i);
  });
  return out;
}
