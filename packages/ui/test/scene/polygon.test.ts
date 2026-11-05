// @vitest-environment node
import { type Point, shapeProblem } from "@vtt/schema";
import { normalizePolygon, polygonProblem } from "@vtt/ui";
import { describe, expect, test } from "vitest";

type Row = [name: string, points: Point[], valid: boolean];

const rows: Row[] = [
  [
    "triangle",
    [
      [0, 0],
      [4, 0],
      [0, 3],
    ],
    true,
  ],
  [
    "concave hexagon",
    [
      [0, 0],
      [6, 0],
      [6, 4],
      [3, 2],
      [0, 4],
      [-1, 2],
    ],
    true,
  ],
  [
    "two points",
    [
      [0, 0],
      [1, 1],
    ],
    false,
  ],
  [
    "repeated vertex",
    [
      [0, 0],
      [4, 0],
      [4, 0],
      [0, 3],
    ],
    false,
  ],
  [
    "collinear spike",
    [
      [0, 0],
      [4, 0],
      [6, 0],
      [2, 0],
      [0, 3],
    ],
    false,
  ],
  [
    "bow-tie",
    [
      [0, 0],
      [4, 4],
      [4, 0],
      [0, 4],
    ],
    false,
  ],
  [
    "vertex touching a non-adjacent edge",
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [2, 0],
      [0, 4],
    ],
    false,
  ],
];

describe("polygonProblem", () => {
  test.each(rows)("%s", (_name, points, valid) => {
    const problem = polygonProblem(points);
    expect(problem).toBe(shapeProblem({ type: "polygon", points }));
    if (valid) expect(problem).toBeUndefined();
    else expect(problem).toEqual(expect.any(String));
  });
});

describe("normalizePolygon", () => {
  test("anchor is the bounding-box center, points relative to it", () => {
    expect(
      normalizePolygon([
        [10, 20],
        [14, 20],
        [10, 26],
      ]),
    ).toEqual({
      anchor: [12, 23],
      points: [
        [-2, -3],
        [2, -3],
        [-2, 3],
      ],
    });
  });

  test.each<[string, Point[]]>([
    [
      "concave hexagon far from the origin",
      [
        [100.5, 200.25],
        [106.5, 200.25],
        [106.5, 204.25],
        [103.5, 202.25],
        [100.5, 204.25],
        [99.5, 202.25],
      ],
    ],
    [
      "negative coordinates",
      [
        [-3, -7],
        [-1, -7],
        [-2, -4],
      ],
    ],
  ])("round-trips world points: %s", (_name, world) => {
    const { anchor, points } = normalizePolygon(world);
    expect(points.map(([x, y]) => [anchor[0] + x, anchor[1] + y])).toEqual(world);
    expect(polygonProblem(points)).toBe(polygonProblem(world));
  });
});
