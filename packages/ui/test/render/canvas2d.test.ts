import type { Bounds, Point, Shape } from "@vtt/schema";
import {
  BACK_FILL,
  type Camera,
  COVER_FILL,
  type CoverItem,
  CROSSHAIR_STROKE,
  createCanvas2DRenderer,
  type DrawItem,
  HATCH_STROKE,
  ImageCache,
  MARQUEE_FILL,
  MARQUEE_STROKE,
  PLACEHOLDER_STROKE,
  paintItem,
  type RecordedCall,
  RecordingContext,
  type Scene,
  SELECTION_STROKE,
  type ToolOverlay,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Builders

const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };

function boundsOf(anchor: Point, shape: Shape | null): Bounds {
  const [x, y] = anchor;
  if (shape === null) return { minX: x, minY: y, maxX: x, maxY: y };
  if (shape.type === "circle") {
    const r = shape.radius;
    return { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
  }
  if (shape.type === "rect") {
    return {
      minX: x - shape.width / 2,
      minY: y - shape.height / 2,
      maxX: x + shape.width / 2,
      maxY: y + shape.height / 2,
    };
  }
  const xs = shape.points.map((p) => p[0] + x);
  const ys = shape.points.map((p) => p[1] + y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function item(id: string, over: Partial<DrawItem> = {}): DrawItem {
  const anchor = over.anchor ?? [0, 0];
  const shape = over.shape === undefined ? { type: "rect", width: 1, height: 1 } : over.shape;
  return {
    id,
    anchor,
    rotation: 0,
    z: 0,
    shape: shape as Shape | null,
    bounds: boundsOf(anchor, shape as Shape | null),
    isZone: false,
    fill: "#c9c4b8",
    faceDown: false,
    faceDownGlyph: false,
    opaqueGm: false,
    hiddenBadge: false,
    outline: true,
    alpha: 1,
    ...over,
  };
}

function scene(over: Partial<Scene> = {}): Scene {
  return { items: [], covers: [], objectOverlays: [], skipped: [], ...over };
}

function regionCover(key: string, anchor: Point, shape: Shape): CoverItem {
  return { key, wholeBoard: false, anchor, rotation: 0, shape, bounds: boundsOf(anchor, shape) };
}

function images(): ImageCache {
  return new ImageCache({ resolve: (p) => `/assets/${p}` });
}

function draw(
  s: Scene,
  overlays: ToolOverlay[] = [],
  opts: { camera?: Camera; viewport?: Viewport; images?: ImageCache } = {},
): RecordingContext {
  const ctx = new RecordingContext();
  const renderer = createCanvas2DRenderer(ctx, { images: opts.images ?? images() });
  renderer.render(s, overlays, opts.camera ?? CAMERA, opts.viewport ?? VIEWPORT);
  return ctx;
}

const isCoverFill = (c: RecordedCall) =>
  (c.name === "fill" || c.name === "fillRect") && c.style?.fillStyle === COVER_FILL;

function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

// ---------------------------------------------------------------------------

describe("render order and covers", () => {
  const token = item("token", { label: "Goblin", text: "hp 7" });
  const coverScene = scene({
    items: [token],
    covers: [regionCover("fog", [0, 0], { type: "rect", width: 4, height: 4 })],
    objectOverlays: [
      { kind: "highlight", id: "token", bounds: token.bounds },
      { kind: "selection", id: "token", bounds: token.bounds },
    ],
  });
  const objectOverlays: ToolOverlay[] = [
    {
      kind: "handles",
      object: "token",
      handles: [
        { key: "nw", role: "resize", at: [-0.5, -0.5] },
        { key: "rot", role: "rotate", at: [0, -1], from: [0, -0.5] },
      ],
    },
    {
      kind: "drag_ghost",
      items: [{ id: "token", anchor: [0.5, 0.5], rotation: 0, shape: token.shape }],
    },
  ];

  test("nothing object-related is drawn after the first cover fill", () => {
    const ctx = draw(coverScene, objectOverlays);
    const paints = ctx.paints;
    const first = paints.findIndex(isCoverFill);
    expect(first).toBeGreaterThan(0);
    // The token, its outlines, handles and ghost all come before.
    const before = paints.slice(0, first);
    expect(before.some((c) => c.name === "fillText" && c.args[0] === "Goblin")).toBe(true);
    expect(before.filter((c) => c.name === "stroke").length).toBeGreaterThanOrEqual(5);
    for (const call of paints.slice(first)) expect(isCoverFill(call)).toBe(true);
  });

  test("no object-related pixel lands inside the cover after it", () => {
    const ctx = draw(coverScene, objectOverlays);
    const paints = ctx.paints;
    const first = paints.findIndex(isCoverFill);
    const region = paints[first]?.extent as Bounds;
    expect(region).toEqual({ minX: 272, minY: 172, maxX: 528, maxY: 428 });
    // Object paints before the cover do touch its region (the test is meaningful).
    expect(paints.slice(0, first).some((c) => c.extent && intersects(c.extent, region))).toBe(true);
    const after = paints.slice(first).filter((c) => !isCoverFill(c));
    for (const call of after) {
      if (call.extent) expect(intersects(call.extent, region)).toBe(false);
    }
  });

  test("chrome is drawn after covers", () => {
    const ctx = draw(coverScene, [
      { kind: "marquee", rect: { minX: -1, minY: -1, maxX: 1, maxY: 1 } },
      ...objectOverlays,
      { kind: "crosshair", at: [0, 0] },
    ]);
    const paints = ctx.paints;
    const lastCover = paints.findLastIndex(isCoverFill);
    const marquee = paints.findIndex((c) => c.style?.strokeStyle === MARQUEE_STROKE);
    expect(marquee).toBeGreaterThan(lastCover);
    // Only chrome follows the covers.
    for (const call of paints.slice(lastCover + 1)) {
      expect(call.name === "stroke" || call.name === "fill").toBe(true);
    }
    // The handles and ghost, passed after the marquee, are still before the covers: everything
    // after the first cover fill is a cover or chrome.
    const firstCover = paints.findIndex(isCoverFill);
    const chrome = new Set([MARQUEE_STROKE, MARQUEE_FILL, CROSSHAIR_STROKE]);
    for (const call of paints.slice(firstCover).filter((c) => !isCoverFill(c))) {
      const style = call.name === "stroke" ? call.style?.strokeStyle : call.style?.fillStyle;
      expect(chrome.has(String(style))).toBe(true);
    }
  });

  test("whole_board covers fill the viewport", () => {
    const ctx = draw(scene({ items: [token], covers: [{ key: "all", wholeBoard: true }] }), [], {
      viewport: { width: 400, height: 300, dpr: 2 },
    });
    const fill = ctx.paints.find(isCoverFill);
    expect(fill?.name).toBe("fillRect");
    expect(fill?.extent).toEqual({ minX: 0, minY: 0, maxX: 800, maxY: 600 });
  });

  test("the canvas is cleared first", () => {
    const ctx = draw(coverScene);
    expect(ctx.calls.find((c) => c.name !== "setTransform")?.name).toBe("clearRect");
  });
});

describe("culling", () => {
  test("an off-screen item issues no calls", () => {
    const empty = draw(scene()).calls.map((c) => c.name);
    const far = draw(scene({ items: [item("far", { anchor: [100, 100], label: "x" })] }));
    expect(far.calls.map((c) => c.name)).toEqual(empty);
  });

  test("an on-screen item does", () => {
    const ctx = draw(scene({ items: [item("near", { anchor: [1, 1] })] }));
    expect(ctx.paints.length).toBeGreaterThan(0);
  });
});

describe("item drawing", () => {
  test("a hatched zone draws hatch lines inside the shape clip; a plain zone none", () => {
    const zone = {
      isZone: true,
      fill: null,
      shape: { type: "rect", width: 2, height: 2 } as Shape,
    };
    const hatched = draw(scene({ items: [item("z", { ...zone, pattern: "hatch" })] }));
    const hatch = hatched.paints.filter((c) => c.style?.strokeStyle === HATCH_STROKE);
    expect(hatch.length).toBeGreaterThan(0);
    for (const call of hatch) {
      expect(call.clip).toEqual({ minX: 336, minY: 236, maxX: 464, maxY: 364 });
      expect(call.name).toBe("stroke");
    }
    // Spacing 8 px: about (128 + 128) / (8 * sqrt 2) lines.
    const lines = hatch[0]?.path?.filter((p) => p === "moveTo").length ?? 0;
    expect(lines).toBeGreaterThanOrEqual(20);
    expect(lines).toBeLessThanOrEqual(26);
    const plain = draw(scene({ items: [item("z", zone)] }));
    expect(plain.paints.some((c) => c.style?.strokeStyle === HATCH_STROKE)).toBe(false);
  });

  test("an image draws once loaded and a placeholder after an error", () => {
    const created: HTMLImageElement[] = [];
    const onLoad = vi.fn();
    const cache = new ImageCache({
      resolve: (p) => `/assets/${p}`,
      onLoad,
      createImage: () => {
        const img = document.createElement("img");
        created.push(img);
        return img;
      },
    });
    const s = scene({
      items: [item("map", { image: "map.png" }), item("bad", { image: "x.png" })],
    });
    const first = draw(s, [], { images: cache });
    expect(first.calls.some((c) => c.name === "drawImage")).toBe(false);
    expect(created.map((i) => i.src)).toEqual([
      expect.stringContaining("/assets/map.png"),
      expect.stringContaining("/assets/x.png"),
    ]);
    created[0]?.dispatchEvent(new Event("load"));
    created[1]?.dispatchEvent(new Event("error"));
    expect(onLoad).toHaveBeenCalledTimes(2);
    const second = draw(s, [], { images: cache });
    const images = second.calls.filter((c) => c.name === "drawImage");
    expect(images).toHaveLength(1);
    expect(images[0]?.args).toEqual([created[0], -0.5, -0.5, 1, 1]);
    expect(second.paints.some((c) => c.style?.strokeStyle === PLACEHOLDER_STROKE)).toBe(true);
    expect(created).toHaveLength(2);
  });

  test("a face-down item draws the back and its label, no text and no image", () => {
    const ctx = draw(
      scene({
        items: [
          item("card", {
            faceDown: true,
            fill: null,
            label: "Card",
            text: "secret",
            image: "face.png",
            faceDownGlyph: true,
          }),
        ],
      }),
    );
    expect(ctx.paints.some((c) => c.style?.fillStyle === BACK_FILL)).toBe(true);
    const texts = ctx.calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
    expect(texts).toContain("Card");
    expect(texts).not.toContain("secret");
    expect(ctx.calls.some((c) => c.name === "drawImage")).toBe(false);
  });

  test("text is drawn inside the shape clip", () => {
    const ctx = draw(
      scene({
        items: [item("note", { text: "hello", shape: { type: "rect", width: 2, height: 1 } })],
      }),
    );
    const text = ctx.calls.find((c) => c.name === "fillText" && c.args[0] === "hello");
    expect(text?.clip).toEqual({ minX: 336, minY: 268, maxX: 464, maxY: 332 });
  });

  test("text wraps to the shape's width", () => {
    const ctx = draw(
      scene({
        items: [
          item("note", {
            text: "one two three four five six",
            shape: { type: "rect", width: 1, height: 2 },
          }),
        ],
      }),
    );
    const lines = ctx.calls.filter((c) => c.name === "fillText").map((c) => c.args[0] as string);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("one two three four five six");
  });

  test("the label is skipped below 24 px on screen", () => {
    const small = draw(
      scene({ items: [item("t", { label: "Tiny", shape: { type: "circle", radius: 0.15 } })] }),
    );
    expect(small.calls.some((c) => c.name === "fillText" && c.args[0] === "Tiny")).toBe(false);
    const big = draw(
      scene({ items: [item("t", { label: "Big", shape: { type: "circle", radius: 0.5 } })] }),
    );
    const label = big.calls.find((c) => c.name === "fillText" && c.args[0] === "Big");
    expect(label).toBeDefined();
    expect(label?.clip).toBeNull();
  });

  test("GM marks: opaque zones dashed with a dark fill, hidden badges", () => {
    const ctx = draw(
      scene({
        items: [item("fog", { isZone: true, fill: null, opaqueGm: true, hiddenBadge: true })],
      }),
    );
    expect(ctx.paints.some((c) => c.style?.fillStyle === "rgba(0, 0, 0, 0.35)")).toBe(true);
    expect(ctx.paints.some((c) => c.name === "stroke" && (c.style?.lineDash.length ?? 0) > 0)).toBe(
      true,
    );
    const badge = draw(scene({ items: [item("b", { hiddenBadge: true })] })).paints.length;
    const plain = draw(scene({ items: [item("b")] })).paints.length;
    expect(badge).toBeGreaterThan(plain);
  });

  test("a shapeless object is a marker; outline false draws no outline", () => {
    const marker = draw(scene({ items: [item("m", { shape: null })] }));
    const fill = marker.paints.find((c) => c.name === "fill");
    expect(fill?.extent).toEqual({ minX: 395, minY: 295, maxX: 405, maxY: 305 });
    const noOutline = draw(
      scene({ items: [item("z", { isZone: true, fill: "#00f", outline: false })] }),
    );
    expect(noOutline.paints.filter((c) => c.name === "stroke")).toHaveLength(0);
  });
});

describe("device pixel ratio", () => {
  test("DPR 2 doubles the canvas size and scales the transform", () => {
    const ctx = draw(scene({ items: [item("t")] }), [], {
      viewport: { width: 400, height: 300, dpr: 2 },
    });
    expect(ctx.canvas).toMatchObject({ width: 800, height: 600 });
    const fill = ctx.paints.find((c) => c.name === "fill");
    // 1 unit = 64 CSS px = 128 device px, centered.
    expect(fill?.extent).toEqual({ minX: 336, minY: 236, maxX: 464, maxY: 364 });
    expect(fill?.transform[0]).toBe(128);
  });
});

describe("drawItem hook, cullBounds and paintItem", () => {
  test("the hook runs inside each item's transform, unclipped, before overlays and covers", () => {
    const ctx = new RecordingContext();
    const seen: { id: string; clip: Bounds | null; transform: number[] }[] = [];
    let sceneSeen: Scene | null = null;
    const s = scene({
      items: [
        item("a", { anchor: [1, 0], rotation: 90, text: "clipped" }),
        item("b", { anchor: [-1, 0] }),
      ],
      covers: [{ key: "c", wholeBoard: true }],
      objectOverlays: [
        { kind: "selection", id: "a", bounds: { minX: 0.5, minY: -0.5, maxX: 1.5, maxY: 0.5 } },
      ],
    });
    const renderer = createCanvas2DRenderer(ctx, {
      images: images(),
      drawItem: (c, it, helpers) => {
        sceneSeen = helpers.scene;
        expect(helpers.camera).toEqual(CAMERA);
        seen.push({ id: it.id, clip: ctx.clipBounds, transform: ctx.getTransform() });
        c.fillStyle = "#00ff00";
        c.fillRect(0, 0, 0.1, 0.1);
      },
    });
    renderer.render(s, [], CAMERA, VIEWPORT);
    expect(sceneSeen).toBe(s);
    expect(seen.map((x) => x.id)).toEqual(["a", "b"]);
    for (const x of seen) expect(x.clip).toBeNull();
    // Item a: anchor (1, 0) = (464, 300), rotated 90°: scale 64.
    const [a, b, c, d, e, f] = seen[0]?.transform ?? [];
    expect([a, b, c, d, e, f].map((n) => Math.round((n as number) * 1e6) / 1e6)).toEqual([
      0, 64, -64, 0, 464, 300,
    ]);
    const paints = ctx.paints;
    const hookIdx = paints
      .map((p, i) => (p.style?.fillStyle === "#00ff00" ? i : -1))
      .filter((i) => i >= 0);
    expect(hookIdx).toHaveLength(2);
    const selection = paints.findIndex(
      (p) => p.name === "stroke" && p.style?.strokeStyle === SELECTION_STROKE,
    );
    const cover = paints.findIndex(isCoverFill);
    expect(Math.max(...hookIdx)).toBeLessThan(selection);
    expect(selection).toBeLessThan(cover);
    // After the item's own drawing: item a's text precedes its hook call.
    const text = paints.findIndex((p) => p.name === "fillText" && p.args[0] === "clipped");
    expect(text).toBeLessThan(hookIdx[0] as number);
  });

  test("culling uses cullBounds when given", () => {
    const offscreen = item("strip", { anchor: [0, -6] }); // footprint above the view (view y ∈ [-4.6875, 4.6875])
    const onscreen = item("other", { anchor: [0, 0] });
    const drawn: string[] = [];
    const ctx = new RecordingContext();
    const renderer = createCanvas2DRenderer(ctx, {
      images: images(),
      cullBounds: (it, s) => {
        expect(s.items).toContain(it);
        return it.id === "strip"
          ? { minX: -0.5, minY: -6, maxX: 0.5, maxY: -4 }
          : { minX: 50, minY: 50, maxX: 51, maxY: 51 };
      },
      drawItem: (_c, it) => drawn.push(it.id),
    });
    renderer.render(scene({ items: [offscreen, onscreen] }), [], CAMERA, VIEWPORT);
    expect(drawn).toEqual(["strip"]);
  });

  test("near the edge, default culling pads only for decorations", () => {
    // View y starts at -4.6875; the label strip adds 18 px = 0.28125 units below.
    const hanging = item("hang", { anchor: [0, -5.3], label: "Goblin" }); // maxY -4.8
    const ctx = draw(scene({ items: [hanging] }));
    expect(ctx.calls.some((c) => c.name === "fillText" && c.args[0] === "Goblin")).toBe(true);
    const beyond = item("far", { anchor: [0, -5.5], label: "Goblin" }); // maxY -5, padded -4.71875
    const empty = draw(scene()).calls.map((c) => c.name);
    expect(draw(scene({ items: [beyond] })).calls.map((c) => c.name)).toEqual(empty);
  });

  test("near the edge, custom cull bounds are honoured exactly", () => {
    const hanging = item("hang", { anchor: [0, -5.3], label: "Goblin" }); // maxY -4.8
    const ctx = new RecordingContext();
    const drawn: string[] = [];
    const renderer = createCanvas2DRenderer(ctx, {
      images: images(),
      cullBounds: (it) => it.bounds,
      drawItem: (_c, it) => drawn.push(it.id),
    });
    renderer.render(scene({ items: [hanging] }), [], CAMERA, VIEWPORT);
    expect(drawn).toEqual([]);
    expect(ctx.paints).toHaveLength(0);
  });

  test("paintItem records the same calls render makes inside the item's transform", () => {
    const it = item("t", {
      anchor: [1, 1],
      rotation: 30,
      text: "hp 3",
      label: "Orc",
      pattern: "hatch",
      hiddenBadge: true,
    });
    const rendered = draw(scene({ items: [it] }));
    const calls = rendered.calls;
    const rotate = calls.findIndex((c) => c.name === "rotate");
    let depth = 0;
    let end = rotate + 1;
    for (; end < calls.length; end++) {
      const name = calls[end]?.name;
      if (name === "save") depth++;
      if (name === "restore") {
        if (depth === 0) break;
        depth--;
      }
    }
    const inside = calls.slice(rotate + 1, end).map((c) => [c.name, c.args]);
    const direct = new RecordingContext();
    paintItem(direct, it, { camera: CAMERA, images: images() });
    expect(direct.calls.map((c) => [c.name, c.args])).toEqual(inside);
    expect(inside.length).toBeGreaterThan(10);
  });
});
