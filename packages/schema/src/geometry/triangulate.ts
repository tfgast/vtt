import type { Point } from "../shape";

const cross = (o: Point, a: Point, b: Point): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Twice the signed area; positive for counter-clockwise in a y-up frame. */
export function signedArea2(points: Point[]): number {
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
  const area = signedArea2(points);
  if (points.length < 3 || area === 0) return [];
  const sign = Math.sign(area);
  const ring = points.slice();
  const out: [Point, Point, Point][] = [];
  let closed = true;
  let i = 0;
  let sinceClip = 0;
  while (ring.length > 3) {
    const n = ring.length;
    const ia = (i + n - 1) % n;
    const ic = (i + 1) % n;
    const a = ring[ia] as Point;
    const b = ring[i] as Point;
    const c = ring[ic] as Point;
    const turn = sign * cross(a, b, c);
    // Collinear: clip without emitting a triangle, there is no area.
    let clip = turn === 0;
    if (turn > 0) {
      clip = !ring.some(
        (p, j) => j !== ia && j !== i && j !== ic && inTriangle(p, a, b, c, sign, closed),
      );
      if (clip) out.push([a, b, c]);
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
  const [a, b, c] = ring as [Point, Point, Point];
  if (cross(a, b, c) !== 0) out.push([a, b, c]);
  return out;
}
