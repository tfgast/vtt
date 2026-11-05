// @vitest-environment node
import type { Bounds, Point } from "@vtt/schema";
import {
  type Camera,
  clampZoom,
  fitBounds,
  MAX_ZOOM,
  MIN_ZOOM,
  PX_PER_UNIT,
  panBy,
  toBoard,
  toScreen,
  visibleBounds,
  zoomAt,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const viewport = { width: 800, height: 600 };

const cameras: [name: string, camera: Camera][] = [
  ["origin, zoom 1", { x: 0, y: 0, zoom: 1 }],
  ["offset, zoom 2", { x: 10, y: -4, zoom: 2 }],
  ["far, min zoom", { x: 1e5, y: 3e4, zoom: MIN_ZOOM }],
  ["fractional, max zoom", { x: -2.5, y: 7.25, zoom: MAX_ZOOM }],
];

const points: Point[] = [
  [0, 0],
  [3, 4],
  [-12.5, 0.75],
  [1e5 + 1, 3e4 - 2],
];

function close(a: Point, b: Point, digits = 6): void {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
}

describe("camera", () => {
  test("constants", () => {
    expect(PX_PER_UNIT).toBe(64);
    expect(MIN_ZOOM).toBe(1 / 32);
    expect(MAX_ZOOM).toBe(8);
  });

  test("the camera point is at the viewport center", () => {
    expect(toScreen({ x: 10, y: -4, zoom: 2 }, [10, -4], viewport)).toEqual([400, 300]);
    expect(toBoard({ x: 10, y: -4, zoom: 2 }, [400, 300], viewport)).toEqual([10, -4]);
  });

  test("one board unit is PX_PER_UNIT * zoom pixels", () => {
    expect(toScreen({ x: 0, y: 0, zoom: 1 }, [1, 2], viewport)).toEqual([464, 428]);
    expect(toScreen({ x: 0, y: 0, zoom: 0.5 }, [1, 2], viewport)).toEqual([432, 364]);
  });

  describe.each(cameras)("round trips: %s", (_name, camera) => {
    test.each(points)("toBoard(toScreen(%s, %s))", (x, y) => {
      close(toBoard(camera, toScreen(camera, [x, y], viewport), viewport), [x, y]);
    });
    test.each(points)("toScreen(toBoard(%s, %s))", (x, y) => {
      close(toScreen(camera, toBoard(camera, [x, y], viewport), viewport), [x, y], 4);
    });
  });

  test.each([
    [1, 1],
    [0.5, 0.5],
    [1 / 32, 1 / 32],
    [1 / 64, 1 / 32],
    [8, 8],
    [100, 8],
    [0, 1 / 32],
  ])("clampZoom(%s) = %s", (zoom, expected) => {
    expect(clampZoom(zoom)).toBe(expected);
  });

  describe("zoomAt keeps the cursor's board point fixed", () => {
    const cases: [name: string, camera: Camera, cursor: Point, factor: number][] = [
      ["zoom in at a corner", { x: 0, y: 0, zoom: 1 }, [0, 0], 2],
      ["zoom out off center", { x: 5, y: 5, zoom: 2 }, [600, 100], 0.5],
      ["small step", { x: -3, y: 8, zoom: 1.3 }, [123, 456], 1.1],
      ["at the center", { x: 1, y: 1, zoom: 1 }, [400, 300], 3],
    ];
    test.each(cases)("%s", (_name, camera, cursor, factor) => {
      const before = toBoard(camera, cursor, viewport);
      const next = zoomAt(camera, cursor, factor, viewport);
      expect(next.zoom).toBeCloseTo(camera.zoom * factor, 12);
      close(toBoard(next, cursor, viewport), before, 9);
    });

    test("clamped at the maximum, the point still stays put", () => {
      const camera = { x: 2, y: 3, zoom: 6 };
      const cursor: Point = [100, 500];
      const before = toBoard(camera, cursor, viewport);
      const next = zoomAt(camera, cursor, 4, viewport);
      expect(next.zoom).toBe(MAX_ZOOM);
      close(toBoard(next, cursor, viewport), before, 9);
    });

    test("clamped at the minimum, the point still stays put", () => {
      const camera = { x: 2, y: 3, zoom: 1 / 16 };
      const cursor: Point = [700, 50];
      const before = toBoard(camera, cursor, viewport);
      const next = zoomAt(camera, cursor, 0.1, viewport);
      expect(next.zoom).toBe(MIN_ZOOM);
      close(toBoard(next, cursor, viewport), before, 9);
    });
  });

  test("panBy moves the board with the pointer", () => {
    const camera = { x: 10, y: 10, zoom: 2 };
    const next = panBy(camera, [128, -64]);
    expect(next).toEqual({ x: 9, y: 10.5, zoom: 2 });
    // The board point under a screen point moves by the delta on screen.
    const p: Point = [300, 200];
    const board = toBoard(camera, p, viewport);
    close(toScreen(next, board, viewport), [428, 136]);
  });

  describe("fitBounds", () => {
    test("centers the bounds and fits the limiting dimension inside the margin", () => {
      const bounds: Bounds = { minX: 0, minY: 0, maxX: 10, maxY: 5 };
      const camera = fitBounds(bounds, viewport, 40);
      expect(camera.x).toBe(5);
      expect(camera.y).toBe(2.5);
      // width limits: (800 - 80) / (10 * 64) = 1.125; height: (600 - 80) / (5 * 64) = 1.625
      expect(camera.zoom).toBeCloseTo(1.125, 12);
      close(toScreen(camera, [0, 2.5], viewport), [40, 300]);
      close(toScreen(camera, [10, 2.5], viewport), [760, 300]);
    });

    test("a tall box is limited by height", () => {
      const camera = fitBounds({ minX: -1, minY: -10, maxX: 1, maxY: 10 }, viewport, 0);
      expect(camera).toEqual({ x: 0, y: 0, zoom: 600 / (20 * 64) });
    });

    test("the zoom is clamped", () => {
      expect(fitBounds({ minX: 0, minY: 0, maxX: 0.01, maxY: 0.01 }, viewport, 0).zoom).toBe(
        MAX_ZOOM,
      );
      expect(fitBounds({ minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 }, viewport, 0).zoom).toBe(
        MIN_ZOOM,
      );
    });

    test("an empty box centers at zoom 1", () => {
      expect(fitBounds({ minX: 3, minY: 4, maxX: 3, maxY: 4 }, viewport, 20)).toEqual({
        x: 3,
        y: 4,
        zoom: 1,
      });
    });
  });

  test("visibleBounds is the board region the viewport shows", () => {
    expect(visibleBounds({ x: 0, y: 0, zoom: 1 }, viewport)).toEqual({
      minX: -6.25,
      minY: -4.6875,
      maxX: 6.25,
      maxY: 4.6875,
    });
    const camera = { x: 3, y: -2, zoom: 0.5 };
    const b = visibleBounds(camera, viewport);
    close(toScreen(camera, [b.minX, b.minY], viewport), [0, 0]);
    close(toScreen(camera, [b.maxX, b.maxY], viewport), [800, 600]);
  });
});
