// @vitest-environment node
/**
 * The per-item offscreen bitmap cache (vtt-qf5.10, M6-D37; DESIGN.md §7
 * Platform). Offscreen surfaces come from an injected factory producing
 * `RecordingContext`s, so the test sees what is drawn into each surface and
 * what the main context receives: an unchanged item is drawn into its
 * surface once and blitted on every later frame; a change to its drawn
 * content or to the zoom draws it again; overlays stay live.
 */
import type { Shape } from "@vtt/schema";
import {
  type Camera,
  type Canvas2DRendererOptions,
  cameraScale,
  createCanvas2DRenderer,
  type DrawItem,
  ImageCache,
  type RecordedCall,
  RecordingContext,
  type RenderSurface,
  type Scene,
  SELECTION_STROKE,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };

function item(id: string, over: Partial<DrawItem> = {}): DrawItem {
  const shape: Shape = { type: "rect", width: 2, height: 1 };
  return {
    id,
    anchor: [0, 0],
    rotation: 0,
    z: 0,
    shape,
    bounds: { minX: -1, minY: -0.5, maxX: 1, maxY: 0.5 },
    isZone: false,
    fill: "#c9c4b8",
    text: "Goblin",
    faceDown: false,
    faceDownGlyph: false,
    opaqueGm: false,
    hiddenBadge: false,
    outline: true,
    alpha: 1,
    ...over,
  };
}

function scene(items: DrawItem[], over: Partial<Scene> = {}): Scene {
  return { items, covers: [], objectOverlays: [], skipped: [], ...over };
}

interface Made {
  width: number;
  height: number;
  ctx: RecordingContext;
  surface: RenderSurface;
}

/** A renderer over a recording main context whose surfaces are recording contexts too. */
function setup(over: Partial<Canvas2DRendererOptions> = {}, cache: { maxBytes?: number } = {}) {
  const main = new RecordingContext();
  const made: Made[] = [];
  const renderer = createCanvas2DRenderer(main, {
    images: new ImageCache({ resolve: (p) => p }),
    renderCache: {
      ...cache,
      createSurface(width, height) {
        const ctx = new RecordingContext({ width, height });
        const surface: RenderSurface = { ctx, image: ctx as unknown as CanvasImageSource };
        made.push({ width, height, ctx, surface });
        return surface;
      },
    },
    ...over,
  });
  /** Renders one frame and returns the main context's calls for it. */
  const frame = (s: Scene, camera: Camera = CAMERA, viewport: Viewport = VIEWPORT) => {
    const from = main.calls.length;
    renderer.render(s, [], camera, viewport);
    return main.calls.slice(from);
  };
  return { main, made, renderer, frame };
}

const paints = (calls: RecordedCall[]) =>
  calls.filter((c) => ["fill", "stroke", "fillRect", "fillText", "drawImage"].includes(c.name));
const texts = (calls: RecordedCall[]) =>
  calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
const blits = (calls: RecordedCall[]) => calls.filter((c) => c.name === "drawImage");

describe("the per-item bitmap cache (vtt-qf5.10)", () => {
  test("an unchanged item is drawn into its surface once and blitted on later frames", () => {
    const { made, frame } = setup();
    const s = scene([item("a")]);

    const first = frame(s);
    expect(made).toHaveLength(1);
    const surface = made[0] as Made;
    // The item's primitives went to the offscreen surface…
    expect(texts(surface.ctx.calls)).toEqual(["Goblin"]);
    expect(paints(surface.ctx.calls).some((c) => c.name === "fill")).toBe(true);
    // …and the main context got one drawImage of that surface, none of the primitives.
    expect(texts(first)).toEqual([]);
    expect(paints(first).map((c) => c.name)).toEqual(["drawImage"]);
    expect(blits(first)[0]?.args[0]).toBe(surface.surface.image);

    const drawnInto = surface.ctx.calls.length;
    const second = frame(s);
    const third = frame(scene([item("a")])); // a rebuilt scene with equal content
    expect(made).toHaveLength(1);
    expect(surface.ctx.calls.length).toBe(drawnInto);
    for (const calls of [second, third]) {
      expect(paints(calls).map((c) => c.name)).toEqual(["drawImage"]);
      expect(blits(calls)[0]?.args[0]).toBe(surface.surface.image);
    }
  });

  test("the blit covers the item's footprint in its own frame", () => {
    const { made, frame } = setup();
    const calls = frame(scene([item("a", { anchor: [1, 2], bounds: boundsAt(1, 2) })]));
    const blit = blits(calls)[0] as RecordedCall;
    const extent = blit.extent as NonNullable<RecordedCall["extent"]>;
    // 2 × 1 units at 64 px per unit, centred on screen (400, 300) + (64, 128), with a little padding.
    expect(extent.minX).toBeLessThanOrEqual(400 + 64 - 64);
    expect(extent.maxX).toBeGreaterThanOrEqual(400 + 64 + 64);
    expect(extent.minY).toBeLessThanOrEqual(300 + 128 - 32);
    expect(extent.maxY).toBeGreaterThanOrEqual(300 + 128 + 32);
    expect(extent.maxX - extent.minX).toBeLessThan(128 + 16);
    const surface = made[0] as Made;
    expect(surface.width).toBeLessThan(128 + 16);
    expect(surface.height).toBeLessThan(64 + 16);
  });

  test("a change to the item's view draws it into the surface again", () => {
    const { made, frame } = setup();
    frame(scene([item("a")]));
    const before = made.reduce((n, m) => n + texts(m.ctx.calls).length, 0);
    const calls = frame(scene([item("a", { text: "Orc" })]));
    const drawn = made.flatMap((m) => texts(m.ctx.calls));
    expect(drawn.length).toBe(before + 1);
    expect(drawn.at(-1)).toBe("Orc");
    expect(texts(calls)).toEqual([]);
    expect(blits(calls)).toHaveLength(1);
  });

  test("moving an item redraws it; panning the camera does not", () => {
    const { made, frame } = setup();
    frame(scene([item("a")]));
    frame(scene([item("a")]), { x: 0.5, y: -0.25, zoom: 1 });
    expect(made.flatMap((m) => texts(m.ctx.calls))).toEqual(["Goblin"]);
    frame(scene([item("a", { anchor: [1, 0], bounds: boundsAt(1, 0) })]));
    expect(made.flatMap((m) => texts(m.ctx.calls))).toEqual(["Goblin", "Goblin"]);
  });

  test("a zoom redraws the bitmap at the new scale and draws it 1:1", () => {
    const { made, frame } = setup();
    frame(scene([item("a")]), { x: 0, y: 0, zoom: 1.05 });
    frame(scene([item("a")]), { x: 0.3, y: 0, zoom: 1.05 });
    expect(made.flatMap((m) => texts(m.ctx.calls))).toHaveLength(1);
    const calls = frame(scene([item("a")]), { x: 0, y: 0, zoom: 1.1 });
    expect(made.flatMap((m) => texts(m.ctx.calls))).toHaveLength(2);
    const blit = blits(calls)[0] as RecordedCall;
    const surface = made.at(-1) as Made;
    const extent = blit.extent as NonNullable<RecordedCall["extent"]>;
    expect(extent.maxX - extent.minX).toBeCloseTo(surface.width, 6);
    expect(extent.maxY - extent.minY).toBeCloseTo(surface.height, 6);
  });

  test("min_size visibility is decided at the frame's zoom, not a rounded-up one", () => {
    // A 0.3-unit button with min_size 22: 21.1 px at zoom 1.1 (hidden), 23.0 px at 1.2 (shown).
    const zooms: number[] = [];
    const { made, frame } = setup({
      cacheKey: (i) => [i],
      drawItem(ctx, _item, { camera }) {
        zooms.push(camera.zoom);
        if (0.3 * cameraScale(camera) >= 22) ctx.fillText("button", 0, 0);
      },
    });
    const drawn = () => made.flatMap((m) => texts(m.ctx.calls)).filter((t) => t === "button");
    frame(scene([item("a")]), { x: 0, y: 0, zoom: 1.1 });
    frame(scene([item("a")]), { x: 0.1, y: 0, zoom: 1.1 });
    expect(drawn()).toEqual([]);
    expect(zooms).toEqual([1.1]);
    frame(scene([item("a")]), { x: 0, y: 0, zoom: 1.2 });
    expect(drawn()).toEqual(["button"]);
    frame(scene([item("a")]), { x: 0, y: 0, zoom: 1.1 });
    expect(drawn()).toEqual(["button"]);
    expect(zooms).toEqual([1.1, 1.2, 1.1]);
  });

  test("selection and hover outlines are drawn live and never redraw the bitmap", () => {
    const { made, frame } = setup();
    frame(scene([item("a")]));
    const calls = frame(
      scene([item("a")], {
        objectOverlays: [{ kind: "selection", id: "a", bounds: item("a").bounds }],
      }),
    );
    frame(
      scene([item("a")], {
        objectOverlays: [{ kind: "hover", id: "a", bounds: item("a").bounds }],
      }),
    );
    expect(made).toHaveLength(1);
    expect(made.flatMap((m) => texts(m.ctx.calls))).toHaveLength(1);
    const strokes = calls.filter((c) => c.name === "stroke");
    expect(strokes.some((c) => c.style?.strokeStyle === SELECTION_STROKE)).toBe(true);
    for (const m of made) {
      expect(m.ctx.calls.some((c) => c.style?.strokeStyle === SELECTION_STROKE)).toBe(false);
    }
  });

  test("a plain shape with no text, image or face is drawn live", () => {
    const { made, frame } = setup();
    const { text: _text, ...plain } = item("a");
    const calls = frame(scene([plain]));
    expect(made).toHaveLength(0);
    expect(blits(calls)).toHaveLength(0);
    expect(calls.some((c) => c.name === "fill")).toBe(true);
  });

  test("the label and hidden badge are drawn live over the blit", () => {
    const { made, frame } = setup();
    const calls = frame(scene([item("a", { label: "Gob", hiddenBadge: true })]));
    expect(texts(calls)).toEqual(["Gob"]);
    expect(made.flatMap((m) => texts(m.ctx.calls))).toEqual(["Goblin"]);
    const names = paints(calls).map((c) => c.name);
    expect(names[0]).toBe("drawImage");
    expect(names.length).toBeGreaterThan(1);
  });

  test("the item's alpha is applied inside the bitmap, which is blitted at full alpha", () => {
    const { made, frame } = setup();
    const calls = frame(scene([item("a", { alpha: 0.5 })]));
    expect(blits(calls)[0]?.style?.globalAlpha).toBe(1);
    const inner = (made[0] as Made).ctx.paints;
    expect(inner.every((c) => c.style?.globalAlpha === 0.5)).toBe(true);
  });

  test("a drawItem hook is drawn into the surface, once across frames", () => {
    let hookCalls = 0;
    const { made, frame } = setup({
      cacheKey: (i) => [i],
      drawItem(ctx) {
        hookCalls += 1;
        ctx.fillText("face", 0, 0);
      },
    });
    const s = scene([item("a")]);
    const first = frame(s);
    frame(s);
    expect(hookCalls).toBe(1);
    expect(texts((made[0] as Made).ctx.calls)).toEqual(["Goblin", "face"]);
    expect(texts(first)).toEqual([]);
  });

  test("a drawItem hook without a cacheKey keeps every item live", () => {
    const { made, frame } = setup({ drawItem: (ctx) => ctx.fillText("face", 0, 0) });
    const calls = frame(scene([item("a")]));
    expect(made).toHaveLength(0);
    expect(texts(calls)).toEqual(["Goblin", "face"]);
  });

  test("a cacheKey that returns null keeps the item live", () => {
    const { made, frame } = setup({ cacheKey: () => null });
    const calls = frame(scene([item("a")]));
    expect(made).toHaveLength(0);
    expect(texts(calls)).toEqual(["Goblin"]);
  });

  test("a cacheKey part that changes redraws the bitmap", () => {
    let version = 0;
    const { made, frame } = setup({ cacheKey: (i) => [i, version] });
    const s = scene([item("a")]);
    frame(s);
    frame(s);
    version = 1;
    frame(s);
    expect(made.flatMap((m) => texts(m.ctx.calls))).toEqual(["Goblin", "Goblin"]);
  });

  test("an image that finishes loading redraws the bitmap that showed it loading", () => {
    const images: FakeImage[] = [];
    const { made, frame } = setup({
      images: new ImageCache({
        resolve: (p) => p,
        createImage: () => {
          const img = new FakeImage();
          images.push(img);
          return img as unknown as HTMLImageElement;
        },
      }),
    });
    const { text: _text, ...rest } = item("a");
    const s = scene([{ ...rest, image: "map.png" }]);
    frame(s);
    frame(s);
    const draws = () => made.flatMap((m) => m.ctx.calls.filter((c) => c.name === "drawImage"));
    expect(draws()).toHaveLength(0); // still loading: nothing drawn
    images[0]?.fire("load");
    frame(s);
    expect(draws()).toHaveLength(1);
    frame(s);
    expect(draws()).toHaveLength(1);
  });

  test("the cache evicts the least recently used bitmaps past maxBytes", () => {
    // Each 2 × 1 item is about 132 × 68 px, about 36 KB; two fit in 80 KB, three do not.
    const { made, frame, renderer } = setup({}, { maxBytes: 80_000 });
    const a = item("a", { anchor: [-3, 0], bounds: boundsAt(-3, 0) });
    const b = item("b", { anchor: [0, 0], bounds: boundsAt(0, 0) });
    const c = item("c", { anchor: [3, 0], bounds: boundsAt(3, 0) });
    frame(scene([a, b]));
    expect(renderer.cacheStats().entries).toBe(2);
    frame(scene([a, b, c]));
    const stats = renderer.cacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeLessThanOrEqual(80_000);
    // `a` was the least recently used: drawing it again rasterizes it again.
    const drawnA = () => made.filter((m) => m.ctx.calls.length > 0).length;
    const before = drawnA();
    frame(scene([b, c]));
    expect(drawnA()).toBe(before);
    frame(scene([a, b, c]));
    expect(drawnA()).toBeGreaterThan(before);
  });

  test("an item too large for a surface is drawn live", () => {
    const { made, frame } = setup();
    const big = item("a", {
      shape: { type: "rect", width: 200, height: 200 },
      bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    });
    const calls = frame(scene([big]));
    expect(made).toHaveLength(0);
    expect(texts(calls)).toEqual(["Goblin"]);
  });

  test("renderCache false draws every item live", () => {
    const main = new RecordingContext();
    const renderer = createCanvas2DRenderer(main, {
      images: new ImageCache({ resolve: (p) => p }),
      renderCache: false,
    });
    renderer.render(scene([item("a")]), [], CAMERA, VIEWPORT);
    expect(texts(main.calls)).toEqual(["Goblin"]);
    expect(renderer.cacheStats().entries).toBe(0);
  });

  test("the cache is off by default", () => {
    const main = new RecordingContext();
    const renderer = createCanvas2DRenderer(main, {
      images: new ImageCache({ resolve: (p) => p }),
    });
    renderer.render(scene([item("a")]), [], CAMERA, VIEWPORT);
    expect(texts(main.calls)).toEqual(["Goblin"]);
    expect(renderer.cacheStats().entries).toBe(0);
  });

  test("without a surface factory and a native context the renderer draws live", () => {
    const main = new RecordingContext();
    const renderer = createCanvas2DRenderer(main, {
      images: new ImageCache({ resolve: (p) => p }),
      renderCache: {},
    });
    renderer.render(scene([item("a")]), [], CAMERA, VIEWPORT);
    expect(texts(main.calls)).toEqual(["Goblin"]);
  });

  test("dispose drops every cached bitmap", () => {
    const { frame, renderer } = setup();
    frame(scene([item("a")]));
    expect(renderer.cacheStats().entries).toBe(1);
    renderer.dispose();
    expect(renderer.cacheStats()).toEqual({ entries: 0, bytes: 0 });
  });
});

function boundsAt(x: number, y: number) {
  return { minX: x - 1, minY: y - 0.5, maxX: x + 1, maxY: y + 0.5 };
}

class FakeImage {
  src = "";
  readonly #listeners = new Map<string, () => void>();
  addEventListener(type: string, fn: () => void) {
    this.#listeners.set(type, fn);
  }
  fire(type: string) {
    this.#listeners.get(type)?.();
  }
}
