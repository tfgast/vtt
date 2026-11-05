import type { Point } from "../shape";

const cross = (o: Point, a: Point, b: Point): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Twice the signed area; positive for counter-clockwise in a y-up frame.
 * Callers pass coordinates relative to a vertex of the polygon: the shoelace
 * products of large absolute coordinates cancel.
 */
function signedArea2(points: Point[]): number {
  let s = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] as Point;
    const [xj, yj] = points[j] as Point;
    s += xj * yi - xi * yj;
  }
  return s;
}

/**
 * `p` in the triangle `abc` of orientation sign `sign`: the closed triangle
 * when `closed`, else its interior.
 */
function inTriangle(
  p: Point,
  a: Point,
  b: Point,
  c: Point,
  sign: number,
  closed: boolean,
): boolean {
  const side = (o: Point, q: Point) => {
    const s = sign * cross(o, q, p);
    return closed ? s >= 0 : s > 0;
  };
  return side(a, b) && side(b, c) && side(c, a);
}

/**
 * Ear-clipping triangulation of a simple polygon, either orientation.
 * Collinear vertices are dropped without emitting a triangle, so every
 * returned triangle has nonzero area; a polygon with no area yields none.
 */
export function triangulate(points: Point[]): [Point, Point, Point][] {
  if (points.length < 3) return [];
  // Every product below is taken relative to vertex 0, so a small polygon at
  // large coordinates keeps its area; triangles are returned in the input
  // points.
  const [ox, oy] = points[0] as Point;
  const rel: Point[] = points.map((p) => [p[0] - ox, p[1] - oy]);
  const area = signedArea2(rel);
  if (area === 0) return [];
  const sign = Math.sign(area);
  const at = (k: number) => rel[k] as Point;
  const ring = points.map((_, k) => k);
  const out: [Point, Point, Point][] = [];
  const emit = (ka: number, kb: number, kc: number) =>
    out.push([points[ka] as Point, points[kb] as Point, points[kc] as Point]);
  let closed = true;
  let i = 0;
  let sinceClip = 0;
  while (ring.length > 3) {
    const n = ring.length;
    const ia = (i + n - 1) % n;
    const ic = (i + 1) % n;
    const ka = ring[ia] as number;
    const kb = ring[i] as number;
    const kc = ring[ic] as number;
    const a = at(ka);
    const b = at(kb);
    const c = at(kc);
    const turn = sign * cross(a, b, c);
    // Collinear: clip without emitting a triangle, there is no area.
    let clip = turn === 0;
    if (turn > 0) {
      clip = !ring.some(
        (k, j) => j !== ia && j !== i && j !== ic && inTriangle(at(k), a, b, c, sign, closed),
      );
      if (clip) emit(ka, kb, kc);
    }
    if (clip) {
      ring.splice(i, 1);
      i %= n - 1; // the vertex after b now sits at i, or at 0 if b was last
      sinceClip = 0;
    } else {
      i = ic;
      // A full pass with no ear can only come from a vertex lying on a
      // candidate diagonal: relax the test to the open triangle. A second
      // fruitless pass cannot happen for a simple polygon; stop rather than
      // loop.
      if (++sinceClip > n) {
        if (!closed) return out;
        closed = false;
        sinceClip = 0;
      }
    }
  }
  const [ka, kb, kc] = ring as [number, number, number];
  if (cross(at(ka), at(kb), at(kc)) !== 0) emit(ka, kb, kc);
  return out;
}
