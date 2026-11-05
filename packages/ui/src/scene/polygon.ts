/**
 * Polygon validation and normalization (DESIGN.md §4.3; review r2 finding
 * 11): the only polygon validation in the UI, reused by the creation tools
 * (vtt-3l6.8) and the vertex handles (vtt-3l6.9).
 */
import { type Point, shapeProblem } from "@vtt/schema";

/**
 * Why `points` (anchor-relative or world, it does not matter) are not a valid
 * polygon, or undefined: exactly the rule the authority enforces
 * (`@vtt/schema`'s `shapeProblem`).
 */
export function polygonProblem(points: Point[]): string | undefined {
  return shapeProblem({ type: "polygon", points });
}

/** World points as an anchor (the bounding-box center) and points relative to it. */
export function normalizePolygon(worldPoints: Point[]): { anchor: Point; points: Point[] } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of worldPoints) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (worldPoints.length === 0) return { anchor: [0, 0], points: [] };
  const anchor: Point = [(minX + maxX) / 2, (minY + maxY) / 2];
  return {
    anchor,
    points: worldPoints.map(([x, y]) => [x - anchor[0] + 0, y - anchor[1] + 0]),
  };
}
