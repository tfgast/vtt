// @vitest-environment node
/**
 * The Snap grid (vtt-nb8.31; DESIGN.md §4.6 On the canvas, M6-D13): with
 * `scene.grid`, the Canvas2D renderer strokes faint 1-unit lines within the
 * viewport only, under the items, while a unit is at least `GRID_MIN_PX` on
 * screen; without it, no grid.
 */
import type { Shape } from "@vtt/schema";
import {
  type Camera,
  createCanvas2DRenderer,
  type DrawItem,
  GRID_MIN_PX,
  GRID_STROKE,
  ImageCache,
  PX_PER_UNIT,
  type RecordedCall,
  RecordingContext,
  type Scene,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };
const CAMERA: Camera = { x: 0.25, y: -0.25, zoom: 1 };

const TOKEN: DrawItem = {
  id: "tok",
  anchor: [0, 0],
  rotation: 0,
  z: 0,
  shape: { type: "circle", radius: 0.5 } as Shape,
  bounds: { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 },
  isZone: false,
  fill: "#c9c4b8",
  faceDown: false,
  faceDownGlyph: false,
  opaqueGm: false,
  hiddenBadge: false,
  outline: true,
  alpha: 1,
};

function scene(grid: boolean | undefined): Scene {
  const s: Scene = { items: [TOKEN], covers: [], objectOverlays: [], skipped: [] };
  return grid === undefined ? s : { ...s, grid };
}

function render(grid: boolean | undefined, camera: Camera = CAMERA): RecordingContext {
  const ctx = new RecordingContext();
  const renderer = createCanvas2DRenderer(ctx, {
    images: new ImageCache({ resolve: (p) => p, onLoad: () => {} }),
  });
  renderer.render(scene(grid), [], camera, VIEWPORT);
  return ctx;
}

const gridStrokes = (ctx: RecordingContext): RecordedCall[] =>
  ctx.paints.filter((c) => c.name === "stroke" && c.style?.strokeStyle === GRID_STROKE);

/** The points of the path `stroke` paints: the moveTo and lineTo calls since its beginPath. */
function points(ctx: RecordingContext, stroke: RecordedCall): [number, number][] {
  const end = ctx.calls.indexOf(stroke);
  let start = end;
  while (start > 0 && (ctx.calls[start] as RecordedCall).name !== "beginPath") start--;
  return ctx.calls
    .slice(start, end)
    .filter((c) => c.name === "moveTo" || c.name === "lineTo")
    .map((c) => [c.args[0] as number, c.args[1] as number]);
}

describe("the Snap grid (M6-D13)", () => {
  test("is stroked when the scene asks for it, before the items, faint and one pixel wide", () => {
    const ctx = render(true);
    const strokes = gridStrokes(ctx);
    expect(strokes).toHaveLength(1);
    const grid = strokes[0] as RecordedCall;
    expect(ctx.paints[0]).toBe(grid);
    expect(grid.style?.lineWidth).toBeCloseTo(1 / PX_PER_UNIT, 9);
  });

  test("its lines lie on whole units within the viewport only", () => {
    const ctx = render(true);
    const pts = points(ctx, gridStrokes(ctx)[0] as RecordedCall);
    // The view: x in [0.25 - 6.25, 0.25 + 6.25], y in [-0.25 - 4.6875, -0.25 + 4.6875].
    const view = { minX: -6, minY: -4.9375, maxX: 6.5, maxY: 4.4375 };
    expect(pts.length).toBeGreaterThan(0);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(view.minX);
      expect(x).toBeLessThanOrEqual(view.maxX);
      expect(y).toBeGreaterThanOrEqual(view.minY);
      expect(y).toBeLessThanOrEqual(view.maxY);
    }
    // Vertical lines at x = -6 … 6, horizontal at y = -4 … 4: two points each.
    const verticals = new Set(pts.filter(([x]) => Number.isInteger(x)).map(([x]) => x));
    expect([...verticals].sort((a, b) => a - b)).toEqual([
      -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(pts).toHaveLength(2 * (13 + 9));
  });

  test("is not drawn when the scene does not ask for it (snap off)", () => {
    expect(gridStrokes(render(false))).toEqual([]);
    expect(gridStrokes(render(undefined))).toEqual([]);
  });

  test("is not drawn while a unit is under GRID_MIN_PX on screen", () => {
    const below = { x: 0, y: 0, zoom: (GRID_MIN_PX - 0.5) / PX_PER_UNIT };
    expect(gridStrokes(render(true, below))).toEqual([]);
    const at = { x: 0, y: 0, zoom: GRID_MIN_PX / PX_PER_UNIT };
    expect(gridStrokes(render(true, at))).toHaveLength(1);
  });
});
