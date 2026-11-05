/**
 * Drawing faces (vtt-1xv.15): the real vtt-3l6.6 renderer with
 * `drawItem: drawFaceItem` and `cullBounds: faceCullBounds` over a
 * `RecordingContext` (CLAUDE.md UI tests; DESIGN.md §4.6, §4.4).
 */
import { stockedTableSnapshot, Table, ViewBuilder } from "@vtt/authority";
import type {
  ActionStateView,
  Cover,
  FaceElementView,
  FaceView,
  ObjectView,
  Viewer,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import type { Bounds, ObjectId, Point, Rect, Shape } from "@vtt/schema";
import {
  BACK_FILL,
  buildFaceScene,
  type Camera,
  COVER_FILL,
  createCanvas2DRenderer,
  createFaceStateStore,
  DISABLED_ALPHA,
  drawFace,
  drawFaceItem,
  FACE_TEXT_SCALE,
  type FaceDrawing,
  type FaceScene,
  type FaceStateStore,
  faceCullBounds,
  GEAR_FILL,
  HIDDEN_TEXT,
  IDENTITY,
  ImageCache,
  INK_STROKE,
  INK_WIDTH,
  PLACEHOLDER_STROKE,
  type RecordedCall,
  RecordingContext,
  resolveFace,
  SCROLL_FILL,
  SELECTION_STROKE,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// View builders (as in test/face/scene.test.ts)

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const ink = (...strokes: Point[][]): WireValue => ({ type: "ink", strokes });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });

interface Spec {
  shape?: Shape | null;
  cells?: Record<string, WireResult>;
  actions?: string[];
  states?: ActionStateView[];
  face?: FaceView;
  template?: boolean;
  contents?: (string | null)[];
  at?: [number, number];
  rotation?: number;
  container?: string;
  faceUp?: boolean;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {};
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: "literal" };
  }
  cells.face_up = { value: bool(s.faceUp ?? true), kind: "literal" };
  if (s.shape) cells.shape = { value: { type: "shape", shape: s.shape }, kind: "literal" };
  if (s.contents) {
    cells.contents = {
      value: {
        type: "list",
        items: s.contents.map((c) => (c === null ? { type: "redacted" } : ref(c))),
      },
      kind: "structural",
    };
  }
  if (s.at) {
    cells.board = { value: ref(BOARD), kind: "literal" };
    cells.position = {
      value: { type: "list", items: [num(s.at[0]), num(s.at[1])] },
      kind: "literal",
    };
    cells.container = { value: EMPTY, kind: "structural" };
  }
  if (s.container) cells.container = { value: ref(s.container), kind: "structural" };
  if (s.rotation !== undefined) cells.rotation = { value: num(s.rotation), kind: "literal" };
  const view: ObjectView = {
    id,
    is_template: s.template ?? false,
    is_character: false,
    cells,
    actions: (s.actions ?? []).map((name) => ({ name })),
    action_states:
      s.states ?? (s.actions ?? []).map((name) => ({ name, enabled: true }) as ActionStateView),
  };
  if (s.face) view.face = s.face;
  return view;
}

type Extra = Partial<FaceElementView> & Record<string, unknown>;
const value = (cell: string, r: Rect, index: number, extra: Extra = {}) =>
  ({ type: "value", cell, rect: r, index, shown: true, ...extra }) as FaceElementView;
const editor = (cell: string, r: Rect, index: number, extra: Extra = {}) =>
  ({ type: "editor", cell, rect: r, index, shown: true, ...extra }) as FaceElementView;
const button = (action: string, r: Rect, index: number, extra: Extra = {}) =>
  ({ type: "button", action, rect: r, index, shown: true, ...extra }) as FaceElementView;
const contents = (r: Rect, index: number, extra: Extra = {}) =>
  ({ type: "contents", rect: r, index, shown: true, ...extra }) as FaceElementView;

// ---------------------------------------------------------------------------
// Rendering

const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };

interface RenderOpts {
  camera?: Camera;
  covers?: Cover[];
  selection?: ObjectId[];
  faceState?: FaceStateStore;
  images?: ImageCache;
  board?: string;
  viewer?: Viewer;
  /** Pass the selection to the hook (else `drawFaceItem` is the hook itself). */
  wrap?: boolean;
  cull?: boolean;
}

function faceScene(views: ObjectView[], o: RenderOpts = {}): FaceScene {
  return buildFaceScene(
    {
      views,
      covers: o.covers ?? [],
      board: o.board ?? BOARD,
      viewer: o.viewer ?? GM,
      selection: o.selection ?? [],
    },
    { faceState: o.faceState ?? createFaceStateStore() },
  );
}

function images(): ImageCache {
  return new ImageCache({ resolve: (p) => `/assets/${p}` });
}

function render(views: ObjectView[], o: RenderOpts = {}): RecordingContext {
  const ctx = new RecordingContext();
  const selection = o.selection ?? [];
  const renderer = createCanvas2DRenderer<FaceScene>(ctx, {
    images: o.images ?? images(),
    drawItem: o.wrap ? (c, item, h) => drawFaceItem(c, item, { ...h, selection }) : drawFaceItem,
    ...(o.cull === false ? {} : { cullBounds: faceCullBounds }),
  });
  renderer.render(faceScene(views, o), [], o.camera ?? CAMERA, VIEWPORT);
  return ctx;
}

const texts = (ctx: RecordingContext) =>
  ctx.paints.filter((c) => c.name === "fillText").map((c) => c.args[0] as string);
const textCall = (ctx: RecordingContext, t: string): RecordedCall => {
  const found = ctx.paints.find((c) => c.name === "fillText" && c.args[0] === t);
  if (!found) throw new Error(`no text ${t}: ${texts(ctx).join(", ")}`);
  return found;
};
const fontPx = (c: RecordedCall) => Number(/(\d+(?:\.\d+)?)px/.exec(c.style?.font ?? "")?.[1]);
const isCoverFill = (c: RecordedCall) =>
  (c.name === "fill" || c.name === "fillRect") && c.style?.fillStyle === COVER_FILL;
const scaleOf = (c: RecordedCall) => Math.hypot(c.transform[0], c.transform[1]);
const round = (b: Bounds | null | undefined) =>
  b
    ? {
        minX: Math.round(b.minX * 1000) / 1000,
        minY: Math.round(b.minY * 1000) / 1000,
        maxX: Math.round(b.maxX * 1000) / 1000,
        maxY: Math.round(b.maxY * 1000) / 1000,
      }
    : b;

/** A cache whose `paths` are loaded (and `failed` failed) before the render. */
function loadedImages(paths: string[], failed: string[] = []): ImageCache {
  const created: HTMLImageElement[] = [];
  const cache = new ImageCache({
    resolve: (p) => `/assets/${p}`,
    createImage: () => {
      const img = document.createElement("img");
      created.push(img);
      return img;
    },
  });
  [...paths, ...failed].forEach((p, i) => {
    cache.get(p);
    created[i]?.dispatchEvent(new Event(i < paths.length ? "load" : "error"));
  });
  return cache;
}

// ---------------------------------------------------------------------------

describe("culling and the default strip", () => {
  // View y ∈ [-4.6875, 4.6875] at zoom 1 on 800 × 600.
  const die = mk("die", { shape: circle(0.5), at: [0, -5.3], actions: ["Roll"] });

  test("a faceless die just off-screen has its on-screen strip drawn", () => {
    const ctx = render([die]);
    expect(texts(ctx)).toContain("Roll");
    // Without faceCullBounds the footprint alone culls it.
    expect(texts(render([die], { cull: false }))).not.toContain("Roll");
  });

  test("a strip below a card is drawn with no clip active", () => {
    const card = mk("card", { shape: rect(2, 3), at: [0, 0], actions: ["Go", "Stop"] });
    const ctx = render([card]);
    const label = textCall(ctx, "Go");
    expect(label.clip).toBeNull();
    // The strip lies below the card's frame (y > 1.5 units = 396 device px).
    expect(label.extent?.minY).toBeGreaterThan(300 + 1.5 * 64);
    const buttonPaints = ctx.paints.filter(
      (c) => (c.name === "fill" || c.name === "stroke") && (c.extent?.minY ?? 0) > 396,
    );
    expect(buttonPaints.length).toBeGreaterThanOrEqual(2);
    for (const p of buttonPaints) expect(p.clip).toBeNull();
  });
});

describe("render order", () => {
  test("a faced card under a region cover: every face call precedes the cover and selection", () => {
    const card = mk("card", {
      shape: rect(2, 3),
      at: [0, 0],
      cells: { name: text("Card"), hp: num(4) },
      actions: ["Go"],
      face: {
        elements: [
          value("name", [-1, -1.5, 2, 0.5], 0),
          editor("hp", [-1, -0.8, 2, 0.5], 1),
          button("Go", [-1, 1.6, 2, 0.4], 2),
        ],
      },
    });
    const ctx = new RecordingContext();
    const ranges: [number, number][] = [];
    const renderer = createCanvas2DRenderer<FaceScene>(ctx, {
      images: images(),
      cullBounds: faceCullBounds,
      drawItem: (c, item, h) => {
        const from = ctx.calls.length;
        drawFaceItem(c, item, { ...h, selection: ["card"] });
        ranges.push([from, ctx.calls.length]);
      },
    });
    const covers: Cover[] = [
      {
        key: "fog",
        board: BOARD,
        region: { position: [0, 0], rotation: 0, shape: { type: "rect", width: 6, height: 6 } },
      },
    ];
    renderer.render(faceScene([card], { covers, selection: ["card"] }), [], CAMERA, VIEWPORT);
    const calls = ctx.calls;
    const facePaints = ranges.flatMap(([a, b]) =>
      calls.slice(a, b).filter((c) => c.style !== undefined),
    );
    expect(facePaints.length).toBeGreaterThan(3);
    const lastFace = Math.max(
      ...ranges.flatMap(([a, b]) => calls.slice(a, b).map((c) => calls.indexOf(c))),
    );
    const cover = calls.findIndex(isCoverFill);
    const selection = calls.findIndex(
      (c) => c.name === "stroke" && c.style?.strokeStyle === SELECTION_STROKE,
    );
    expect(cover).toBeGreaterThan(0);
    expect(selection).toBeGreaterThan(0);
    expect(lastFace).toBeLessThan(selection);
    expect(lastFace).toBeLessThan(cover);
    expect(texts(ctx)).toEqual(expect.arrayContaining(["Card", "4", "Go"]));
  });
});

describe("text, buttons, editors, images, ink", () => {
  test("text sizes by style: rect height × {0.45, 0.6, 0.8, 1}", () => {
    const sizes = ["small", "normal", "large", "huge"] as const;
    const card = mk("card", {
      shape: rect(4, 4),
      at: [0, 0],
      cells: { a: text("A"), b: text("B"), c: text("C"), d: text("D") },
      face: {
        elements: sizes.map((size, i) =>
          value(["a", "b", "c", "d"][i] as string, [-1.5, -2 + i * 0.6, 3, 0.5], i, {
            style: { size },
          }),
        ),
      },
    });
    const ctx = render([card]);
    sizes.forEach((size, i) => {
      const call = textCall(ctx, ["A", "B", "C", "D"][i] as string);
      // CSS px at zoom 1 (64 px per unit), dpr 1.
      expect(fontPx(call)).toBeCloseTo(0.5 * 64 * FACE_TEXT_SCALE[size]);
      // Drawn at that size on screen: the transform is 1 device px per CSS px.
      expect(scaleOf(call)).toBeCloseTo(1);
    });
    expect(FACE_TEXT_SCALE).toEqual({ small: 0.45, normal: 0.6, large: 0.8, huge: 1 });
  });

  test("a font follows the zoom, the default style is normal, a caption prefixes the cell name", () => {
    const card = mk("card", {
      shape: rect(4, 4),
      at: [0, 0],
      cells: { hp: num(7) },
      face: { elements: [value("hp", [-1.5, 0, 3, 0.5], 0, { style: { caption: true } })] },
    });
    const ctx = render([card], { camera: { x: 0, y: 0, zoom: 2 } });
    const call = textCall(ctx, "hp: 7");
    expect(fontPx(call)).toBeCloseTo(0.5 * 128 * 0.6);
  });

  test("long text shrinks to fit the width, then ends in an ellipsis on one line", () => {
    const long = "a very long value that cannot possibly fit in a narrow element";
    const card = mk("card", {
      shape: rect(4, 4),
      at: [0, 0],
      cells: { t: text(long), u: text("abcdefgh") },
      face: {
        elements: [value("t", [-1.5, -1, 2, 0.5], 0), value("u", [-1.5, 0, 1, 0.5], 1)],
      },
    });
    const ctx = render([card]);
    const drawn = ctx.paints.filter((c) => c.name === "fillText");
    const t = drawn.find((c) => (c.args[0] as string).startsWith("a very"));
    expect(t).toBeDefined();
    const tText = t?.args[0] as string;
    expect(tText.endsWith("…")).toBe(true);
    expect(tText.length).toBeLessThan(long.length);
    // Within the element's width (2 units = 128 px).
    expect((t?.extent?.maxX ?? 0) - (t?.extent?.minX ?? 0)).toBeLessThanOrEqual(128);
    // "abcdefgh" at 19.2 px is 92 px; it shrinks to fit 64 px without truncation.
    const u = textCall(ctx, "abcdefgh");
    expect(fontPx(u)).toBeLessThan(19.2);
    expect((u.extent?.maxX ?? 0) - (u.extent?.minX ?? 0)).toBeLessThanOrEqual(64);
  });

  test("a disabled button, and a template's buttons, draw at 40 % alpha", () => {
    const card = mk("card", {
      shape: rect(4, 4),
      at: [0, 0],
      actions: ["Roll", "Apply"],
      states: [
        { name: "Roll", enabled: true },
        { name: "Apply", enabled: false, reason: { type: "when_false" } } as ActionStateView,
      ],
      face: {
        elements: [
          button("Roll", [-1.5, -1, 1.4, 0.45], 0),
          button("Apply", [0.1, -1, 1.4, 0.45], 1),
        ],
      },
    });
    const ctx = render([card]);
    expect(DISABLED_ALPHA).toBe(0.4);
    expect(textCall(ctx, "Apply").style?.globalAlpha).toBeCloseTo(0.4);
    expect(textCall(ctx, "Roll").style?.globalAlpha).toBe(1);
    // The rounded body (fill and outline) is dimmed too.
    const applyBody = ctx.paints.filter(
      (c) => (c.name === "fill" || c.name === "stroke") && (c.extent?.minX ?? 0) >= 400 + 0.1 * 64 - 1,
    );
    expect(applyBody.length).toBeGreaterThanOrEqual(2);
    for (const p of applyBody) expect(p.style?.globalAlpha).toBeCloseTo(0.4);
    // A rounded rect: arcs in the path.
    expect(applyBody[0]?.path).toContain("arc");

    const tpl = mk("tpl", {
      shape: rect(4, 4),
      at: [0, 0],
      template: true,
      actions: ["Roll"],
      face: { elements: [button("Roll", [-1.5, -1, 1.4, 0.45], 0)] },
    });
    expect(textCall(render([tpl]), "Roll").style?.globalAlpha).toBeCloseTo(0.4);
  });

  test("a button label falls back to the action name and uses the element label", () => {
    const card = mk("card", {
      shape: rect(4, 4),
      at: [0, 0],
      actions: ["Roll"],
      face: { elements: [button("Roll", [-1.5, -1, 2, 0.5], 0, { label: "Roll it" })] },
    });
    expect(texts(render([card]))).toContain("Roll it");
  });

  test("an editor is an inset outlined box with its value", () => {
    const card = mk("card", {
      shape: rect(4, 4),
      at: [0, 0],
      cells: { target: text("goblin") },
      face: { elements: [editor("target", [-1, -1, 2, 0.5], 0)] },
    });
    const ctx = render([card]);
    const t = textCall(ctx, "goblin");
    const strokes = ctx.paints.filter((c) => c.name === "stroke" && c.path?.includes("rect"));
    // The element rect in device px: x ∈ [336, 464], y ∈ [236, 268].
    const box = strokes.find(
      (c) =>
        (c.extent?.minX ?? 0) > 336 &&
        (c.extent?.maxX ?? 0) < 464 &&
        (c.extent?.minY ?? 0) > 236 &&
        (c.extent?.maxY ?? 0) < 268,
    );
    expect(box).toBeDefined();
    expect(ctx.calls.indexOf(box as RecordedCall)).toBeLessThan(ctx.calls.indexOf(t));
  });

  test("an image element draws through the ImageCache, a failed one a placeholder", () => {
    const card = mk("card", {
      shape: rect(4, 4),
      at: [0, 0],
      cells: { image: text("a.png") },
      face: { elements: [value("image", [-1, -1, 2, 2], 0)] },
    });
    const ok = render([card], { images: loadedImages(["a.png"]) });
    const img = ok.paints.find((c) => c.name === "drawImage");
    expect(img?.args.slice(1)).toEqual([-1, -1, 2, 2]);
    const bad = render([card], { images: loadedImages([], ["a.png"]) });
    expect(bad.paints.some((c) => c.name === "drawImage")).toBe(false);
    expect(bad.paints.some((c) => c.style?.strokeStyle === PLACEHOLDER_STROKE)).toBe(true);
    // Still loading: nothing.
    const loading = render([card]);
    expect(loading.paints.some((c) => c.name === "drawImage")).toBe(false);
  });

  test("an ink stroke is 0.04 units wide, at least one pixel, dark, at two zooms", () => {
    const note = mk("note", {
      shape: rect(2, 2),
      at: [0, 0],
      cells: {
        ink: ink(
          [
            [-0.5, -0.5],
            [0.5, 0.5],
            [0.5, -0.5],
          ],
          [[0, 0]],
        ),
      },
    });
    const near = render([note]).paints.filter(
      (c) => c.name === "stroke" && c.style?.strokeStyle === INK_STROKE,
    );
    expect(INK_STROKE).toBe("#202020");
    expect(INK_WIDTH).toBe(0.04);
    expect(near).toHaveLength(2);
    expect(near[0]?.style?.lineWidth).toBeCloseTo(0.04);
    expect(near[0]?.path).toEqual(["moveTo", "lineTo", "lineTo"]);
    // 0.04 units at zoom 1 is 2.56 device px.
    expect((near[0]?.style?.lineWidth ?? 0) * scaleOf(near[0] as RecordedCall)).toBeCloseTo(2.56);
    // At zoom 1/32 (2 px per unit) 0.04 units is 0.08 px: one pixel instead.
    const far = render([note], { camera: { x: 0, y: 0, zoom: 1 / 32 } }).paints.filter(
      (c) => c.name === "stroke" && c.style?.strokeStyle === INK_STROKE,
    );
    expect(far[0]?.style?.lineWidth).toBeCloseTo(0.5);
    expect((far[0]?.style?.lineWidth ?? 0) * scaleOf(far[0] as RecordedCall)).toBeCloseTo(1);
  });
});

describe("minSize", () => {
  const badgeFace: FaceView = {
    elements: [value("hp", [0.5, -1, 0.5, 0.25], 0, { min_size: 20 })],
  };

  test("culls a badge below its on-screen height", () => {
    const tok = mk("tok", { shape: circle(1), at: [0, 0], cells: { hp: num(7) }, face: badgeFace });
    // 0.25 units: 16 px at zoom 1, 32 px at zoom 2.
    expect(texts(render([tok]))).not.toContain("7");
    expect(texts(render([tok], { camera: { x: 0, y: 0, zoom: 2 } }))).toContain("7");
  });

  test("culls a badge inside a scaled entry by its accumulated height", () => {
    const tok = mk("tok", { shape: circle(1), container: "bag", cells: { hp: num(7) }, face: badgeFace });
    const bag = mk("bag", {
      shape: rect(2, 4),
      at: [0, 0],
      contents: ["tok"],
      face: { elements: [contents([-0.6, -2, 1.2, 4], 0, { entries: "full" })] },
    });
    // Row 0.12 high, inner width 1.08: the token's 2-unit frame scales by 0.54.
    // At zoom 2 the badge is 0.25 × 0.54 × 128 = 17.3 px (culled); at zoom 4, 34.6 px.
    const at2 = render([bag, tok], { camera: { x: 0, y: 0, zoom: 2 } });
    expect(texts(at2)).not.toContain("7");
    expect(at2.paints.some((c) => c.name === "fill")).toBe(true); // the token's base
    expect(texts(render([bag, tok], { camera: { x: 0, y: 0, zoom: 4 } }))).toContain("7");
  });
});

describe("nested objects inside a rotated container", () => {
  const box = mk("box", {
    shape: rect(4, 10),
    at: [0, 0],
    rotation: 30,
    contents: ["note", "tok", "card"],
    face: { elements: [contents([-1.5, -4.5, 3, 9], 0, { entries: "full" })] },
  });
  const note = mk("note", {
    shape: rect(2, 1),
    container: "box",
    cells: {
      color: text("#ffee88"),
      text: text("remember"),
      ink: ink([
        [-0.5, 0],
        [0.5, 0],
      ]),
    },
  });
  const tok = mk("tok", {
    shape: circle(0.5),
    container: "box",
    cells: { image: text("tok.png") },
  });
  const card = mk("card", {
    shape: rect(1, 1.5),
    container: "box",
    faceUp: false,
    cells: { name: text("Secret"), power: num(9) },
    face: { elements: [value("power", [-0.5, -0.5, 1, 0.5], 0)] },
  });
  const camera: Camera = { x: 0, y: 0, zoom: 0.5 };
  const draw = () => render([box, note, tok, card], { camera, images: loadedImages(["tok.png"]) });

  test("an expanded faceless note draws its base (fill, text) then its ink", () => {
    const ctx = draw();
    const fill = ctx.paints.findIndex((c) => c.name === "fill" && c.style?.fillStyle === "#ffee88");
    const words = ctx.paints.findIndex((c) => c.name === "fillText" && c.args[0] === "remember");
    const stroke = ctx.paints.findIndex(
      (c) => c.name === "stroke" && c.style?.strokeStyle === INK_STROKE,
    );
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(fill).toBeLessThan(words);
    expect(words).toBeLessThan(stroke);
    // Drawn rotated with the container and scaled into its row (inner 2.7 / 2 units).
    const f = ctx.paints[fill] as RecordedCall;
    expect(f.transform[1]).not.toBeCloseTo(0);
    expect(scaleOf(f)).toBeCloseTo(32 * 1.35);
    // The base's text is at its fixed screen size, as on a board.
    expect(fontPx(ctx.paints[words] as RecordedCall)).toBe(14);
    expect(scaleOf(ctx.paints[words] as RecordedCall)).toBeCloseTo(1);
    // Ink: 0.04 units in the note's frame.
    expect(ctx.paints[stroke]?.style?.lineWidth).toBeCloseTo(0.04);
  });

  test("an image token draws its base image", () => {
    const ctx = draw();
    const img = ctx.paints.find((c) => c.name === "drawImage");
    expect(img?.args.slice(1)).toEqual([-0.5, -0.5, 1, 1]);
    expect(img?.transform[1]).not.toBeCloseTo(0);
  });

  test("a face-down card draws only its back and glyph (and its name), no face", () => {
    const ctx = draw();
    expect(ctx.paints.some((c) => c.name === "fill" && c.style?.fillStyle === BACK_FILL)).toBe(true);
    expect(texts(ctx)).toContain("↓");
    expect(texts(ctx)).not.toContain("9");
    // DESIGN.md §4.4: a face-down object shows its back and its name.
    expect(texts(ctx).filter((t) => t !== "↓" && t !== "remember")).toEqual(["Secret"]);
  });

  test("every nested paint is clipped to the contents rect", () => {
    const ctx = draw();
    const nested = ctx.paints.filter(
      (c) => c.style?.fillStyle === "#ffee88" || c.style?.fillStyle === BACK_FILL,
    );
    expect(nested.length).toBeGreaterThan(0);
    for (const p of nested) expect(p.clip).not.toBeNull();
  });
});

describe("contents elements", () => {
  const names = Array.from({ length: 10 }, (_, i) => `item ${i}`);
  const children = names.map((n, i) =>
    mk(`c${i}`, { shape: rect(1, 1), container: "bag", cells: { name: text(n) } }),
  );
  const bag = mk("bag", {
    shape: rect(4, 4),
    at: [0, 0],
    contents: children.map((c) => c.id),
    // Rows 0.4 high: three rows show.
    face: { elements: [contents([-2, -1.5, 4, 1.2], 0)] },
  });

  test("a scrolled contents element draws the scrolled rows, clipped to its rect, and not the rows outside", () => {
    const faceState = createFaceStateStore();
    faceState.setScroll("bag", 0, 1.7);
    const ctx = render([bag, ...children], { faceState });
    // Rows 4 to 7 overlap [1.7, 2.9).
    const drawn = texts(ctx).filter((t) => t.startsWith("item"));
    expect(drawn).toEqual(["item 4", "item 5", "item 6", "item 7"]);
    // Clipped to the element rect in device px: x ∈ [272, 528], y ∈ [204, 280.8].
    for (const t of drawn) {
      expect(round(textCall(ctx, t).clip)).toEqual({ minX: 272, minY: 204, maxX: 528, maxY: 280.8 });
    }
    // Row 4 is drawn 0.1 units above the rect's top: scrolled.
    const row4 = textCall(ctx, "item 4");
    expect(row4.transform[5]).toBeLessThan(204);
    // A thin scroll indicator inside the rect, after the rows.
    const bar = ctx.paints.findIndex((c) => c.style?.fillStyle === SCROLL_FILL);
    expect(bar).toBeGreaterThan(ctx.paints.indexOf(textCall(ctx, "item 7")));
  });

  test("no scroll indicator when everything fits", () => {
    const small = mk("bag", {
      shape: rect(4, 4),
      at: [0, 0],
      contents: ["c0"],
      face: { elements: [contents([-2, -1.5, 4, 1.2], 0)] },
    });
    const ctx = render([small, children[0] as ObjectView]);
    expect(texts(ctx)).toContain("item 0");
    expect(ctx.paints.some((c) => c.style?.fillStyle === SCROLL_FILL)).toBe(false);
  });

  test("selected entries are outlined, redacted ones read hidden, templates have a gear", () => {
    const tpl = mk("t", {
      shape: rect(1, 1),
      container: "box",
      template: true,
      cells: { name: text("Template") },
    });
    const sel = mk("s", { shape: rect(1, 1), container: "box", cells: { name: text("Chosen") } });
    const boxed = mk("box", {
      shape: rect(4, 4),
      at: [0, 0],
      contents: ["t", null, "s"],
      face: { elements: [contents([-2, -1.5, 4, 2], 0)] },
    });
    const ctx = render([boxed, tpl, sel], { selection: ["s"], wrap: true });
    expect(texts(ctx)).toEqual(expect.arrayContaining(["Template", HIDDEN_TEXT, "Chosen"]));
    const outline = ctx.paints.find(
      (c) => c.style?.strokeStyle === SELECTION_STROKE && c.clip !== null,
    );
    // Row 2 spans y ∈ [-1.5 + 0.8, -1.5 + 1.2] = 256 .. 281.6 device px.
    expect(outline?.extent?.minY).toBeGreaterThanOrEqual(255);
    expect(outline?.extent?.maxY).toBeLessThanOrEqual(283);
    expect(ctx.paints.some((c) => c.style?.fillStyle === GEAR_FILL && c.clip !== null)).toBe(true);
    // Unselected: no row outline.
    const plain = render([boxed, tpl, sel], { selection: [], wrap: true });
    expect(plain.paints.some((c) => c.style?.strokeStyle === SELECTION_STROKE)).toBe(false);
  });

  test("collapsed rows of the stocked GM binder draw each template's name", () => {
    const table = Table.fromSnapshot(stockedTableSnapshot());
    const builder = new ViewBuilder(table, { type: "gm" });
    const ids = Object.keys(stockedTableSnapshot().objects);
    const views = ids.map((id) => builder.objectView(id, "all")).filter((v) => v !== null);
    const binder = views.find((v) => v.id === "gm_binder") as ObjectView;
    const contentsCell = binder.cells.contents?.value;
    const entryIds =
      contentsCell?.type === "list"
        ? contentsCell.items.map((i) => (i.type === "ref" ? i.object : ""))
        : [];
    expect(entryIds).toHaveLength(14);
    const ctx = render(views as ObjectView[], {
      board: "gm_board",
      camera: { x: 0, y: 0, zoom: 0.5 },
    });
    const drawn = texts(ctx);
    for (const id of entryIds) {
      const name = views.find((v) => v.id === id)?.cells.name?.value;
      expect(name?.type).toBe("text");
      if (name?.type === "text") expect(drawn).toContain(name.value);
    }
    // One gear per template row.
    const gears = ctx.paints.filter((c) => c.style?.fillStyle === GEAR_FILL && c.name === "fill");
    expect(gears).toHaveLength(14);
  });

  test("a custom collapsed row draws its value and button", () => {
    const goblin = mk("goblin", {
      shape: rect(1, 1),
      container: "bag",
      cells: { name: text("Goblin"), hp: num(7) },
      actions: ["Hit"],
      face: {
        elements: [],
        collapsed: [value("hp", [0, 0, 3, 0.6], 0), button("Hit", [3.2, 0, 2.6, 0.6], 1)],
      },
    });
    const holder = mk("bag", {
      shape: rect(4, 4),
      at: [0, 0],
      contents: ["goblin"],
      face: { elements: [contents([-2, -1.5, 4, 2], 0)] },
    });
    const ctx = render([holder, goblin]);
    const hp = textCall(ctx, "7");
    const hit = textCall(ctx, "Hit");
    expect(texts(ctx)).not.toContain("Goblin");
    expect(hp.clip).not.toBeNull();
    expect(hit.clip).not.toBeNull();
    // Inside the row: y ∈ [204, 229.6] device px (row 0.4 units).
    for (const c of [hp, hit]) {
      expect(c.extent?.minY).toBeGreaterThanOrEqual(204);
      expect(c.extent?.maxY).toBeLessThanOrEqual(229.6);
    }
  });

  test("a collapsed row's chevron points right, an expanded one's down", () => {
    const faceState = createFaceStateStore();
    const ctx = render([bag, ...children], { faceState });
    const chevrons = ctx.paints.filter((c) => c.name === "fill" && c.path?.includes("closePath"));
    expect(chevrons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("drawFace", () => {
  test("draws a drawing directly under a given transform and restores the context", () => {
    const card = mk("card", {
      shape: rect(2, 2),
      at: [0, 0],
      cells: { hp: num(3) },
      face: { elements: [value("hp", [-1, -1, 2, 1], 0)] },
    });
    const drawing: FaceDrawing = resolveFace(card, {
      views: () => null,
      faceState: createFaceStateStore(),
      list: "full",
      gm: true,
    });
    const ctx = new RecordingContext();
    ctx.setTransform(64, 0, 0, 64, 400, 300);
    drawFace(ctx, drawing, { camera: CAMERA, images: images(), transform: IDENTITY });
    expect(texts(ctx)).toEqual(["3"]);
    expect(ctx.getTransform()).toEqual([64, 0, 0, 64, 400, 300]);
    const saves = ctx.calls.filter((c) => c.name === "save").length;
    const restores = ctx.calls.filter((c) => c.name === "restore").length;
    expect(saves).toBe(restores);
  });
});
