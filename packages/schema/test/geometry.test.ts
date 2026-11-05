import {
  anchorDistance,
  type Bounds,
  boundsIntersect,
  type Footprint,
  footprintsOverlap,
  GEOM_EPSILON,
  indexBounds,
  type Point,
  pointInRegion,
  type Shape,
  shapeBounds,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import diceTray from "../../fixtures/scenarios/dice-tray.json" with { type: "json" };
import fireball from "../../fixtures/scenarios/fireball.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });
const polygon = (...points: Point[]): Shape => ({ type: "polygon", points });

/** L-shape: a 2×2 square with its top-right 1×1 quadrant (the notch) removed. */
const L = polygon([0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [0, 2]);

const fp = (shape: Shape | null, anchor: Point, rotation = 0): Footprint => ({
  shape,
  anchor,
  rotation,
});

interface FixtureObject {
  id: string;
  shape?: unknown;
  placement?: { position: unknown };
}
const fixtureObject = (scenario: { setup: { objects: FixtureObject[] } }, id: string) => {
  const o = scenario.setup.objects.find((x) => x.id === id);
  if (!o) throw new Error(`no object ${id}`);
  return o;
};

describe("GEOM_EPSILON", () => {
  test("is 1e-9 board units", () => {
    expect(GEOM_EPSILON).toBe(1e-9);
  });
});

describe("pointInRegion", () => {
  const cases: [string, Point, Shape, Point, number, boolean][] = [
    // rect 2×1 centred on [0,0]: x -1..1, y -0.5..0.5
    ["rect: centre", [0, 0], rect(2, 1), [0, 0], 0, true],
    ["rect: inside", [0.9, 0.4], rect(2, 1), [0, 0], 0, true],
    ["rect: outside", [1.5, 0], rect(2, 1), [0, 0], 0, false],
    ["rect: on edge", [1, 0], rect(2, 1), [0, 0], 0, true],
    ["rect: on corner", [1, 0.5], rect(2, 1), [0, 0], 0, true],
    ["rect: within epsilon of edge", [1 + 0.5e-9, 0], rect(2, 1), [0, 0], 0, true],
    ["rect: beyond epsilon of edge", [1 + 2e-9, 0], rect(2, 1), [0, 0], 0, false],
    ["rect: offset anchor", [5.5, 7], rect(2, 1), [5, 7], 0, true],
    // rotated rect: 4×1 at the origin, horizontal until rotated
    ["rect 0°: [0,1.5] outside", [0, 1.5], rect(4, 1), [0, 0], 0, false],
    ["rect 90°: [0,1.5] inside", [0, 1.5], rect(4, 1), [0, 0], 90, true],
    ["rect 90°: [1.5,0] outside", [1.5, 0], rect(4, 1), [0, 0], 90, false],
    ["rect 0°: [1,1] outside", [1, 1], rect(4, 1), [0, 0], 0, false],
    ["rect 45°: [1,1] inside", [1, 1], rect(4, 1), [0, 0], 45, true],
    ["rect -45°: [1,1] outside", [1, 1], rect(4, 1), [0, 0], -45, false],
    ["rect 135°: [-1,1] inside (clockwise, y down)", [-1, 1], rect(4, 1), [0, 0], 135, true],
    ["rect 45° about offset anchor", [11, 11], rect(4, 1), [10, 10], 45, true],
    // circle radius 2 at [1,1]
    ["circle: centre", [1, 1], circle(2), [1, 1], 0, true],
    ["circle: inside", [2, 2], circle(2), [1, 1], 0, true],
    ["circle: on boundary", [3, 1], circle(2), [1, 1], 0, true],
    ["circle: outside", [3, 3], circle(2), [1, 1], 0, false],
    ["circle: rotation is irrelevant", [3, 1], circle(2), [1, 1], 37, true],
    // polygon points relative to the anchor; need not surround the anchor
    ["triangle: inside", [11, 10.5], polygon([0, 0], [2, 0], [1, 2]), [10, 10], 0, true],
    ["triangle: vertex", [12, 10], polygon([0, 0], [2, 0], [1, 2]), [10, 10], 0, true],
    ["triangle: edge", [11, 10], polygon([0, 0], [2, 0], [1, 2]), [10, 10], 0, true],
    ["triangle: outside", [10, 12], polygon([0, 0], [2, 0], [1, 2]), [10, 10], 0, false],
    [
      "offset polygon: anchor outside",
      [0, 0],
      polygon([10, 10], [12, 10], [12, 12]),
      [0, 0],
      0,
      false,
    ],
    [
      "offset polygon: inside",
      [11.5, 10.5],
      polygon([10, 10], [12, 10], [12, 12]),
      [0, 0],
      0,
      true,
    ],
    [
      "polygon rotated 90° about anchor",
      [-1, 1],
      polygon([0, 0], [2, 0], [2, 2], [0, 2]),
      [0, 0],
      90,
      true,
    ],
    [
      "polygon unrotated: same point outside",
      [-1, 1],
      polygon([0, 0], [2, 0], [2, 2], [0, 2]),
      [0, 0],
      0,
      false,
    ],
    // L-shaped polygon: notch is x 1..2, y 0..1
    ["L: in arm", [0.5, 0.5], L, [0, 0], 0, true],
    ["L: in corner", [0.5, 1.5], L, [0, 0], 0, true],
    ["L: in other arm", [1.5, 1.5], L, [0, 0], 0, true],
    ["L: in notch", [1.5, 0.5], L, [0, 0], 0, false],
    ["L: on notch edge", [1.5, 1], L, [0, 0], 0, true],
    ["L: reflex vertex", [1, 1], L, [0, 0], 0, true],
    ["L: within epsilon of notch edge", [1.5, 1 - 0.5e-9], L, [0, 0], 0, true],
    ["L: beyond epsilon of notch edge", [1.5, 1 - 2e-9], L, [0, 0], 0, false],
    ["L: outside", [3, 3], L, [0, 0], 0, false],
  ];

  test.each(cases)("%s", (_, p, shape, anchor, rotation, expected) => {
    expect(pointInRegion(p, shape, anchor, rotation)).toBe(expected);
  });

  describe("dice-tray.json: rect 4×4 at [10,0]", () => {
    const o = fixtureObject(diceTray, "tray");
    const tray = { shape: o.shape as Shape, anchor: o.placement?.position as Point };
    test("is the fixture's shape", () => {
      expect(tray).toEqual({ shape: rect(4, 4), anchor: [10, 0] });
    });
    test.each([
      [[12, 0], true],
      [[9, 1], true],
      [[10, -1], true],
      [[10, 1], true],
      [[12.5, 0], false],
      [[0, 0], false],
    ] as [Point, boolean][])("%j inside: %s", (p, expected) => {
      expect(pointInRegion(p, tray.shape, tray.anchor, 0)).toBe(expected);
    });
  });

  describe("fireball.json: circle radius 4 at [10,10]", () => {
    // The zone is placed at [10, 10] by a move step in the transcript.
    const shape = fixtureObject(fireball, "fireball_zone").shape as Shape;
    const anchor: Point = [10, 10];
    test("is the fixture's shape and placement", () => {
      expect(shape).toEqual(circle(4));
      expect(JSON.stringify(fireball.steps)).toContain(
        '"object":"zone1","to":{"type":"board","board":"map","position":[10,10]}',
      );
    });
    test.each([
      [[9, 10], true],
      [[12, 10], true],
      [[16, 10], false],
      [[2, 10], false],
      [[14, 10], true],
    ] as [Point, boolean][])("%j inside: %s", (p, expected) => {
      expect(pointInRegion(p, shape, anchor, 0)).toBe(expected);
    });
  });

  describe("circle tolerance is a distance at every scale", () => {
    test.each([
      [1e-6, 0.5e-9, true],
      [1e-6, 2e-9, false],
      [1e6, 0.5e-9, true],
      [1e6, 2e-9, false],
    ])("r = %d, point at r + %d: %s", (r, extra, expected) => {
      expect(pointInRegion([r + extra, 0], circle(r), [0, 0], 0)).toBe(expected);
      expect(pointInRegion([0, -(r + extra)], circle(r), [0, 0], 0)).toBe(expected);
    });
  });
});

describe("footprintsOverlap", () => {
  const cases: [string, Footprint, Footprint, boolean][] = [
    [
      "circles r=0.5 at distance 1 (touching)",
      fp(circle(0.5), [0, 0]),
      fp(circle(0.5), [1, 0]),
      false,
    ],
    ["circles r=0.5 at distance 0.9", fp(circle(0.5), [0, 0]), fp(circle(0.5), [0.9, 0]), true],
    [
      "circles r=0.5 at distance 1 - 0.5e-9 (near-tangent)",
      fp(circle(0.5), [0, 0]),
      fp(circle(0.5), [1 - 0.5e-9, 0]),
      false,
    ],
    [
      "circles r=0.5 at distance 1 - 2e-9",
      fp(circle(0.5), [0, 0]),
      fp(circle(0.5), [1 - 2e-9, 0]),
      true,
    ],
    [
      "tiny circles just overlapping",
      fp(circle(1e-6), [0, 0]),
      fp(circle(1e-6), [2e-6 - 2e-9, 0]),
      true,
    ],
    [
      "tiny circles just separated",
      fp(circle(1e-6), [0, 0]),
      fp(circle(1e-6), [2e-6 - 0.5e-9, 0]),
      false,
    ],
    [
      "huge circles just overlapping",
      fp(circle(1e6), [0, 0]),
      fp(circle(1e6), [2e6 - 2e-9, 0]),
      true,
    ],
    [
      "huge circles just separated",
      fp(circle(1e6), [0, 0]),
      fp(circle(1e6), [2e6 - 0.5e-9, 0]),
      false,
    ],
    ["huge circles touching", fp(circle(1e6), [0, 0]), fp(circle(1e6), [0, 2e6]), false],
    ["identical rects", fp(rect(2, 1), [3, 3]), fp(rect(2, 1), [3, 3]), true],
    ["rects sharing an edge", fp(rect(2, 2), [0, 0]), fp(rect(2, 2), [2, 0]), false],
    ["rects penetrating by 0.5e-9", fp(rect(2, 2), [0, 0]), fp(rect(2, 2), [2 - 0.5e-9, 0]), false],
    ["rects penetrating by 2e-9", fp(rect(2, 2), [0, 0]), fp(rect(2, 2), [2 - 2e-9, 0]), true],
    ["rects far apart", fp(rect(2, 2), [0, 0]), fp(rect(2, 2), [10, 0]), false],
    ["rect inside rect", fp(rect(10, 10), [0, 0]), fp(rect(1, 1), [2, 2]), true],
    ["rotated rects crossing", fp(rect(4, 0.5), [0, 0], 45), fp(rect(4, 0.5), [0, 0], -45), true],
    [
      "rect 45° clears a rect that its bounds overlap",
      fp(rect(2, 2), [0, 0], 45),
      fp(rect(1, 1), [1.5, 1.5]),
      false,
    ],
    ["rect and circle tangent", fp(rect(2, 2), [0, 0]), fp(circle(1), [2, 0]), false],
    [
      "rect and circle tangent at a corner",
      fp(rect(2, 2), [0, 0]),
      fp(circle(1), [1 + Math.SQRT1_2, 1 + Math.SQRT1_2]),
      false,
    ],
    [
      "rect and circle near a corner, apart",
      fp(rect(2, 2), [0, 0]),
      fp(circle(1), [1.8, 1.8]),
      false,
    ],
    ["rect and circle overlapping", fp(rect(2, 2), [0, 0]), fp(circle(1), [1.5, 0]), true],
    ["circle inside rect", fp(rect(10, 10), [0, 0]), fp(circle(1), [0, 0]), true],
    ["rect inside circle", fp(circle(10), [0, 0]), fp(rect(1, 1), [0, 0]), true],
    [
      "circle and triangle tangent at vertex",
      fp(polygon([0, 0], [2, 0], [1, -2]), [0, 0]),
      fp(circle(1), [3, 0]),
      false,
    ],
    ["rect sitting in L's notch", fp(L, [0, 0]), fp(rect(1, 1), [1.5, 0.5]), false],
    ["rect smaller than L's notch", fp(L, [0, 0]), fp(rect(0.5, 0.5), [1.5, 0.5]), false],
    ["rect crossing L's arm", fp(L, [0, 0]), fp(rect(1, 1), [1.5, 1]), true],
    ["rect crossing L's other arm", fp(L, [0, 0]), fp(rect(1, 1), [1, 0.5]), true],
    ["circle sitting in L's notch", fp(L, [0, 0]), fp(circle(0.5), [1.5, 0.5]), false],
    ["circle crossing into L", fp(L, [0, 0]), fp(circle(0.5), [1.5, 0.75]), true],
    [
      "L and the square filling its notch",
      fp(L, [0, 0]),
      fp(polygon([1, 0], [2, 0], [2, 1], [1, 1]), [0, 0]),
      false,
    ],
    [
      "clockwise L same as counter-clockwise",
      fp(polygon([0, 2], [2, 2], [2, 1], [1, 1], [1, 0], [0, 0]), [0, 0]),
      fp(rect(1, 1), [1.5, 0.5]),
      false,
    ],
    [
      "polygon with a collinear vertex",
      fp(polygon([0, 0], [1, 0], [2, 0], [2, 2], [0, 2]), [0, 0]),
      fp(rect(1, 1), [1, 1]),
      true,
    ],
    [
      "polygon rotated into contact",
      fp(polygon([0, 0], [4, 0], [4, 1], [0, 1]), [0, 0], 90),
      fp(rect(1, 1), [0, 3]),
      true,
    ],
    [
      "polygon rotated away",
      fp(polygon([0, 0], [4, 0], [4, 1], [0, 1]), [0, 0], 0),
      fp(rect(1, 1), [0, 3]),
      false,
    ],
    // the point-footprint exception
    ["point inside rect", fp(null, [0.5, 0]), fp(rect(2, 2), [0, 0]), true],
    ["point on rect edge", fp(null, [1, 0]), fp(rect(2, 2), [0, 0]), true],
    ["rect then point on its edge", fp(rect(2, 2), [0, 0]), fp(null, [1, 0.5]), true],
    ["point outside rect", fp(null, [1.5, 0]), fp(rect(2, 2), [0, 0]), false],
    ["point in L's notch", fp(null, [1.5, 0.5]), fp(L, [0, 0]), false],
    ["point on circle boundary", fp(null, [14, 10]), fp(circle(4), [10, 10]), true],
    ["two points at the same place", fp(null, [1, 1]), fp(null, [1, 1]), false],
    ["two points apart", fp(null, [1, 1]), fp(null, [2, 2]), false],
  ];

  test.each(cases)("%s", (_, a, b, expected) => {
    expect(footprintsOverlap(a, b)).toBe(expected);
    expect(footprintsOverlap(b, a)).toBe(expected);
  });

  describe("concave polygons are triangulated faithfully", () => {
    // A small square overlaps the polygon exactly where its centre is inside,
    // sampled away from every edge; the "W" has a reflex vertex on a diagonal.
    const polygons: [string, Shape][] = [
      ["L", L],
      ["W", polygon([0, 0], [4, 0], [4, 4], [3, 4], [2, 2], [1, 4], [0, 4])],
      [
        "comb",
        polygon(
          [0, 0],
          [5, 0],
          [5, 3],
          [4, 3],
          [4, 1],
          [3, 1],
          [3, 3],
          [2, 3],
          [2, 1],
          [1, 1],
          [1, 3],
          [0, 3],
        ),
      ],
      [
        "spiral",
        polygon([0, 0], [4, 0], [4, 4], [1, 4], [1, 2], [2, 2], [2, 3], [3, 3], [3, 1], [0, 1]),
      ],
    ];
    test.each(polygons)("%s", (_, shape) => {
      for (let x = 0.15; x < 5; x += 0.3) {
        for (let y = 0.15; y < 5; y += 0.3) {
          const inside = pointInRegion([x, y], shape, [0, 0], 0);
          const overlaps = footprintsOverlap(fp(shape, [0, 0]), fp(rect(0.02, 0.02), [x, y]));
          expect([x, y, overlaps]).toEqual([x, y, inside]);
        }
      }
    });
  });

  test("zero-area footprints never overlap a shape", () => {
    const big = fp(rect(10, 10), [0, 0]);
    expect(footprintsOverlap(fp(rect(0, 1), [0, 0]), big)).toBe(false);
    expect(footprintsOverlap(fp(circle(0), [0, 0]), big)).toBe(false);
    expect(footprintsOverlap(fp(polygon([0, 0], [1, 0], [2, 0]), [0, 0]), big)).toBe(false);
  });
});

describe("polygons at large coordinates (about 1e8) do not cancel", () => {
  const F = 1e8;
  const shift = (ps: Point[]): Point[] => ps.map(([x, y]) => [x + F, y + F]);
  const square = shift([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
  const lPoints = shift([
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
    [2, 2],
    [0, 2],
  ]);
  const windings: [string, Shape, Shape][] = [
    ["as listed", polygon(...square), polygon(...lPoints)],
    ["reversed", polygon(...square.slice().reverse()), polygon(...lPoints.slice().reverse())],
  ];

  describe.each(windings)("winding %s", (_, sq, ell) => {
    test.each([
      ["square: centre", [F + 0.5, F + 0.5], sq, true],
      ["square: on edge", [F + 1, F + 0.5], sq, true],
      ["square: on vertex", [F, F], sq, true],
      ["square: outside", [F + 1.5, F + 0.5], sq, false],
      ["square: outside below", [F + 0.5, F - 0.25], sq, false],
      ["L: in arm", [F + 0.5, F + 0.5], ell, true],
      ["L: in notch", [F + 1.5, F + 0.5], ell, false],
      ["L: on notch edge", [F + 1.5, F + 1], ell, true],
    ] as [string, Point, Shape, boolean][])("pointInRegion %s", (_, p, shape, expected) => {
      expect(pointInRegion(p, shape, [0, 0], 0)).toBe(expected);
    });

    test.each([
      ["square vs 0.5×0.5 rect centred inside", sq, fp(rect(0.5, 0.5), [F + 0.5, F + 0.5]), true],
      ["square vs rect sharing an edge", sq, fp(rect(1, 1), [F + 1.5, F + 0.5]), false],
      ["square vs rect penetrating by 0.25", sq, fp(rect(1, 1), [F + 1.25, F + 0.5]), true],
      ["square vs point inside", sq, fp(null, [F + 0.25, F + 0.75]), true],
      ["square vs circle tangent", sq, fp(circle(0.5), [F + 1.5, F + 0.5]), false],
      ["square vs circle crossing", sq, fp(circle(0.5), [F + 1.25, F + 0.5]), true],
      ["L vs rect in its notch", ell, fp(rect(1, 1), [F + 1.5, F + 0.5]), false],
      ["L vs rect crossing an arm", ell, fp(rect(1, 1), [F + 1.5, F + 1]), true],
      [
        "L vs the square filling its notch",
        ell,
        fp(
          polygon(
            ...shift([
              [1, 0],
              [2, 0],
              [2, 1],
              [1, 1],
            ]),
          ),
          [0, 0],
        ),
        false,
      ],
    ] as [string, Shape, Footprint, boolean][])(
      "footprintsOverlap %s",
      (_, shape, other, expected) => {
        expect(footprintsOverlap(fp(shape, [0, 0]), other)).toBe(expected);
        expect(footprintsOverlap(other, fp(shape, [0, 0]))).toBe(expected);
      },
    );

    test("rotated 90° about a far anchor", () => {
      // (x, y) -> (-y, x): the square lands on x -F-1..-F, y F..F+1.
      expect(pointInRegion([-F - 0.5, F + 0.5], sq, [0, 0], 90)).toBe(true);
      expect(pointInRegion([-F - 1.5, F + 0.5], sq, [0, 0], 90)).toBe(false);
      expect(footprintsOverlap(fp(sq, [0, 0], 90), fp(rect(0.5, 0.5), [-F - 0.5, F + 0.5]))).toBe(
        true,
      );
      expect(footprintsOverlap(fp(sq, [0, 0], 90), fp(rect(1, 1), [-F - 1.5, F + 0.5]))).toBe(
        false,
      );
    });

    test("rotated 45° about a far anchor", () => {
      const c: Point = [0, (2 * F + 1) * Math.SQRT1_2]; // the square's centre
      expect(pointInRegion(c, sq, [0, 0], 45)).toBe(true);
      expect(footprintsOverlap(fp(sq, [0, 0], 45), fp(rect(0.2, 0.2), c))).toBe(true);
      expect(footprintsOverlap(fp(sq, [0, 0], 45), fp(rect(0.2, 0.2), [c[0] + 2, c[1]]))).toBe(
        false,
      );
    });
  });
});

describe("shapeBounds", () => {
  const cases: [string, Shape | null, Point, number, Bounds][] = [
    ["rect", rect(2, 1), [5, 5], 0, { minX: 4, minY: 4.5, maxX: 6, maxY: 5.5 }],
    ["rect rotated 90°", rect(4, 2), [10, 0], 90, { minX: 9, minY: -2, maxX: 11, maxY: 2 }],
    ["rect rotated -270°", rect(4, 2), [10, 0], -270, { minX: 9, minY: -2, maxX: 11, maxY: 2 }],
    ["rect rotated 180°", rect(4, 2), [0, 0], 180, { minX: -2, minY: -1, maxX: 2, maxY: 1 }],
    ["circle", circle(4), [10, 10], 33, { minX: 6, minY: 6, maxX: 14, maxY: 14 }],
    [
      "polygon",
      polygon([10, 10], [12, 10], [12, 12]),
      [1, 2],
      0,
      { minX: 11, minY: 12, maxX: 13, maxY: 14 },
    ],
    [
      "polygon rotated 90°",
      polygon([1, 0], [2, 0], [2, 1]),
      [0, 0],
      90,
      { minX: -1, minY: 1, maxX: 0, maxY: 2 },
    ],
    ["null shape", null, [3, 4], 45, { minX: 3, minY: 4, maxX: 3, maxY: 4 }],
  ];

  test.each(cases)("%s", (_, shape, anchor, rotation, expected) => {
    expect(shapeBounds(shape, anchor, rotation)).toEqual(expected);
  });

  test("rect rotated 45°", () => {
    const b = shapeBounds(rect(2, 2), [0, 0], 45);
    for (const [k, v] of Object.entries({
      minX: -Math.SQRT2,
      minY: -Math.SQRT2,
      maxX: Math.SQRT2,
      maxY: Math.SQRT2,
    })) {
      expect(b[k as keyof Bounds]).toBeCloseTo(v, 12);
    }
  });
});

describe("indexBounds", () => {
  test("offset polygon: contains the anchor and the polygon, expanded by epsilon", () => {
    const b = indexBounds(polygon([10, 10], [12, 10], [12, 12]), [0, 0], 0);
    expect(b).toEqual({
      minX: -GEOM_EPSILON,
      minY: -GEOM_EPSILON,
      maxX: 12 + GEOM_EPSILON,
      maxY: 12 + GEOM_EPSILON,
    });
  });

  test("null shape: the anchor expanded by epsilon", () => {
    expect(indexBounds(null, [3, 4], 0)).toEqual({
      minX: 3 - GEOM_EPSILON,
      minY: 4 - GEOM_EPSILON,
      maxX: 3 + GEOM_EPSILON,
      maxY: 4 + GEOM_EPSILON,
    });
  });

  test("centred rect: its bounds expanded by epsilon", () => {
    expect(indexBounds(rect(4, 4), [10, 0], 0)).toEqual({
      minX: 8 - GEOM_EPSILON,
      minY: -2 - GEOM_EPSILON,
      maxX: 12 + GEOM_EPSILON,
      maxY: 2 + GEOM_EPSILON,
    });
  });
});

describe("boundsIntersect", () => {
  const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
    minX,
    minY,
    maxX,
    maxY,
  });
  const cases: [string, Bounds, Bounds, boolean][] = [
    ["overlapping", box(0, 0, 2, 2), box(1, 1, 3, 3), true],
    ["touching on an edge", box(0, 0, 1, 1), box(1, 0, 2, 1), true],
    ["touching at a corner", box(0, 0, 1, 1), box(1, 1, 2, 2), true],
    ["contained", box(0, 0, 10, 10), box(2, 2, 3, 3), true],
    ["degenerate point on edge", box(0, 0, 1, 1), box(1, 0.5, 1, 0.5), true],
    ["apart in x", box(0, 0, 1, 1), box(1.5, 0, 2, 1), false],
    ["apart in y", box(0, 0, 1, 1), box(0, 1.5, 1, 2), false],
  ];
  test.each(cases)("%s", (_, a, b, expected) => {
    expect(boundsIntersect(a, b)).toBe(expected);
    expect(boundsIntersect(b, a)).toBe(expected);
  });
});

describe("anchorDistance", () => {
  test.each([
    [[0, 0], [3, 4], 5],
    [[1, 1], [1, 1], 0],
    [[-1, -1], [2, 3], 5],
    [[10, 10], [16, 10], 6],
  ] as [Point, Point, number][])("%j to %j = %d", (a, b, d) => {
    expect(anchorDistance(a, b)).toBe(d);
  });
});

describe("dependencies", () => {
  test("@vtt/schema has no runtime dependency other than zod", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["zod"]);
  });
});
