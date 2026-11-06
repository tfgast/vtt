// @vitest-environment node
/**
 * The minimap's pure parts (vtt-qf5.19; DESIGN.md §4.3, §8.1): the layout
 * that fits the board's item bounds into the minimap, the mappings between
 * minimap pixels and board points, the frame of a scene and a camera, and
 * the drawing over a recording context.
 */
import {
  boardToMinimap,
  createMinimapRenderer,
  MINIMAP_ITEM_FILL,
  MINIMAP_ITEM_MIN_PX,
  MINIMAP_PADDING_PX,
  MINIMAP_VIEW_STROKE,
  minimapFrame,
  minimapLayout,
  minimapRect,
  minimapToBoard,
  RecordingContext,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const SIZE = { width: 160, height: 120 };

describe("minimapLayout", () => {
  test("fits wide bounds to the width less the padding, centred vertically", () => {
    const layout = minimapLayout({ minX: 0, minY: 0, maxX: 20, maxY: 5 }, SIZE);
    expect(layout.scale).toBeCloseTo((160 - 2 * MINIMAP_PADDING_PX) / 20);
    expect(boardToMinimap([0, 0], layout)).toEqual([MINIMAP_PADDING_PX, 60 - 2.5 * layout.scale]);
    expect(boardToMinimap([20, 5], layout)[0]).toBeCloseTo(160 - MINIMAP_PADDING_PX);
    expect(boardToMinimap([10, 2.5], layout)).toEqual([80, 60]);
  });

  test("fits tall bounds to the height less the padding, centred horizontally", () => {
    const layout = minimapLayout({ minX: -5, minY: -50, maxX: 5, maxY: 50 }, SIZE);
    expect(layout.scale).toBeCloseTo((120 - 2 * MINIMAP_PADDING_PX) / 100);
    expect(boardToMinimap([0, 0], layout)).toEqual([80, 60]);
    expect(boardToMinimap([0, -50], layout)[1]).toBeCloseTo(MINIMAP_PADDING_PX);
  });

  test("gives bounds with no extent one board unit, centred", () => {
    const layout = minimapLayout({ minX: 3, minY: 4, maxX: 3, maxY: 4 }, SIZE);
    expect(layout.scale).toBeCloseTo(120 - 2 * MINIMAP_PADDING_PX);
    expect(boardToMinimap([3, 4], layout)).toEqual([80, 60]);
  });

  test("minimapToBoard inverts boardToMinimap", () => {
    const layout = minimapLayout({ minX: -7, minY: 2, maxX: 13, maxY: 9 }, SIZE);
    const points: [number, number][] = [
      [0, 0],
      [80, 60],
      [17, 101],
    ];
    for (const p of points) {
      const [x, y] = boardToMinimap(minimapToBoard(p, layout), layout);
      expect(x).toBeCloseTo(p[0]);
      expect(y).toBeCloseTo(p[1]);
    }
    const [cx, cy] = minimapToBoard([80, 60], layout);
    expect(cx).toBeCloseTo(3);
    expect(cy).toBeCloseTo(5.5);
  });
});

describe("minimapRect", () => {
  const layout = minimapLayout({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, SIZE);

  test("maps a box to minimap pixels", () => {
    const rect = minimapRect({ minX: 0, minY: 0, maxX: 5, maxY: 10 }, layout);
    expect(rect.x).toBeCloseTo(boardToMinimap([0, 0], layout)[0]);
    expect(rect.width).toBeCloseTo(5 * layout.scale);
    expect(rect.height).toBeCloseTo(10 * layout.scale);
  });

  test("grows a box smaller than the minimum about its centre", () => {
    const rect = minimapRect({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, layout, MINIMAP_ITEM_MIN_PX);
    expect(rect).toEqual({
      x: 80 - MINIMAP_ITEM_MIN_PX / 2,
      y: 60 - MINIMAP_ITEM_MIN_PX / 2,
      width: MINIMAP_ITEM_MIN_PX,
      height: MINIMAP_ITEM_MIN_PX,
    });
  });
});

describe("minimapFrame", () => {
  const items = [
    { bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 } },
    { bounds: { minX: 9, minY: 4, maxX: 11, maxY: 6 } },
  ];

  test("is null with no items", () => {
    expect(
      minimapFrame({
        items: [],
        camera: { x: 0, y: 0, zoom: 1 },
        viewport: { width: 800, height: 600, dpr: 1 },
        size: SIZE,
      }),
    ).toBeNull();
  });

  test("lays out the items' union and puts the camera's visible bounds as the view", () => {
    const frame = minimapFrame({
      items,
      camera: { x: 5, y: 2.5, zoom: 0.5 },
      viewport: { width: 640, height: 320, dpr: 2 },
      size: SIZE,
    });
    if (frame === null) throw new Error("no frame");
    const layout = minimapLayout({ minX: -1, minY: -1, maxX: 11, maxY: 6 }, SIZE);
    expect(frame.layout).toEqual(layout);
    expect(frame.dpr).toBe(2);
    expect(frame.items).toEqual(
      items.map((i) => minimapRect(i.bounds, layout, MINIMAP_ITEM_MIN_PX)),
    );
    // 640x320 px at 32 px per unit is 20x10 units about (5, 2.5).
    expect(frame.view).toEqual(minimapRect({ minX: -5, minY: -2.5, maxX: 15, maxY: 7.5 }, layout));
  });
});

describe("createMinimapRenderer", () => {
  test("sizes the canvas by the dpr, clears it, fills each item and strokes the view", () => {
    const ctx = new RecordingContext();
    const renderer = createMinimapRenderer(ctx);
    const frame = minimapFrame({
      items: [{ bounds: { minX: 0, minY: 0, maxX: 4, maxY: 2 } }],
      camera: { x: 2, y: 1, zoom: 1 },
      viewport: { width: 128, height: 64, dpr: 2 },
      size: SIZE,
    });
    if (frame === null) throw new Error("no frame");
    renderer.render(frame);
    expect(ctx.canvas).toEqual({ width: 320, height: 240 });
    expect(ctx.calls[0]?.name).toBe("setTransform");
    expect(ctx.calls.some((c) => c.name === "clearRect")).toBe(true);
    const items = ctx.paints.filter(
      (c) => c.name === "fillRect" && c.style?.fillStyle === MINIMAP_ITEM_FILL,
    );
    const item = frame.items[0];
    expect(items.map((c) => c.args)).toEqual([[item?.x, item?.y, item?.width, item?.height]]);
    expect(items[0]?.transform).toEqual([2, 0, 0, 2, 0, 0]);
    const views = ctx.paints.filter((c) => c.name === "strokeRect");
    expect(views).toHaveLength(1);
    expect(views[0]?.style?.strokeStyle).toBe(MINIMAP_VIEW_STROKE);
    expect(views[0]?.args).toEqual([
      frame.view.x,
      frame.view.y,
      frame.view.width,
      frame.view.height,
    ]);
    renderer.dispose();
  });
});
