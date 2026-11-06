/**
 * Drawing grid and fan contents elements (vtt-qf5.28; DESIGN.md §4.6
 * contents `layout`; M6-D30) through the real renderer over a
 * `RecordingContext` (CLAUDE.md UI tests).
 */
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
import type { Bounds, ObjectId, Rect, Shape } from "@vtt/schema";
import {
  buildFaceScene,
  type Camera,
  CHEVRON_FILL,
  createCanvas2DRenderer,
  createFaceStateStore,
  drawFaceItem,
  type FaceScene,
  type FaceStateStore,
  faceCullBounds,
  ImageCache,
  type RecordedCall,
  RecordingContext,
  SELECTION_STROKE,
  TILE_FILL,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

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
const round = (b: Bounds | null | undefined) =>
  b
    ? {
        minX: Math.round(b.minX * 1000) / 1000,
        minY: Math.round(b.minY * 1000) / 1000,
        maxX: Math.round(b.maxX * 1000) / 1000,
        maxY: Math.round(b.maxY * 1000) / 1000,
      }
    : b;

const names = Array.from({ length: 10 }, (_, i) => `item ${i}`);
const children = names.map((n, i) =>
  mk(`c${i}`, { shape: rect(1, 1), container: "bag", cells: { name: text(n) } }),
);
/** A bag whose contents element is 4 × 1.2 (list rows 0.4 high). */
const bag = (layout: string | undefined, count = 10) =>
  mk("bag", {
    shape: rect(4, 4),
    at: [0, 0],
    contents: children.slice(0, count).map((c) => c.id),
    face: {
      elements: [contents([-2, -1.5, 4, 1.2], 0, layout === undefined ? {} : { layout })],
    },
  });
const tiles = (ctx: RecordingContext) =>
  ctx.paints.filter((c) => c.name === "fill" && c.style?.fillStyle === TILE_FILL);
/** The rotation of a call's transform, in degrees. */
const turnOf = (c: RecordedCall) => (Math.atan2(c.transform[1], c.transform[0]) * 180) / Math.PI;

describe("the default list", () => {
  test("draws rows and no tiles, with or without layout list", () => {
    for (const layout of [undefined, "list"]) {
      const ctx = render([bag(layout), ...children]);
      expect(tiles(ctx)).toHaveLength(0);
      expect(texts(ctx).filter((t) => t.startsWith("item"))).toEqual(names.slice(0, 3));
    }
  });
});

describe("grid", () => {
  test("tiles in rows within the rect: the rows past it are not drawn, the rest clipped", () => {
    // Cells 1.2 high and 6/7 wide: four to a row; the second row starts below the rect.
    const ctx = render([bag("grid"), ...children]);
    expect(tiles(ctx)).toHaveLength(4);
    expect(texts(ctx).filter((t) => t.startsWith("item"))).toEqual(names.slice(0, 4));
    const clip: Bounds = { minX: 272, minY: 204, maxX: 528, maxY: 280.8 };
    for (const t of tiles(ctx)) {
      expect(round(t.clip)).toEqual(clip);
      expect(turnOf(t)).toBe(0);
    }
    // Left to right along the top of the rect.
    const xs = tiles(ctx).map((t) => t.extent?.minX ?? 0);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(round(tiles(ctx)[0]?.extent)?.minY).toBe(204);
    // Each tile has its chevron.
    expect(ctx.paints.filter((c) => c.style?.fillStyle === CHEVRON_FILL)).toHaveLength(4);
  });

  test("an expanded entry draws its full drawing in its tile", () => {
    const faceState = createFaceStateStore();
    faceState.expand("c1");
    const ctx = render([bag("grid"), ...children], { faceState });
    expect(tiles(ctx)).toHaveLength(4);
    const tile = tiles(ctx)[1]?.extent as Bounds;
    // The child's base fill (a 1 × 1 rect) lies inside its tile.
    const base = ctx.paints.filter(
      (c) =>
        c.name === "fill" &&
        c.style?.fillStyle !== TILE_FILL &&
        c.extent !== null &&
        c.extent !== undefined &&
        c.extent.minX >= tile.minX - 1e-6 &&
        c.extent.maxX <= tile.maxX + 1e-6 &&
        c.extent.minY > tile.minY,
    );
    expect(base.length).toBeGreaterThan(0);
  });
});

describe("fan", () => {
  test("every card drawn in list order, turned about the pivot, the last on top", () => {
    const ctx = render([bag("fan", 5), ...children]);
    const cards = tiles(ctx);
    expect(cards).toHaveLength(5);
    const turns = cards.map(turnOf);
    expect(turns[2]).toBeCloseTo(0, 9);
    for (let i = 1; i < 5; i++) expect(turns[i]).toBeGreaterThan(turns[i - 1] as number);
    // Each card's name is drawn after its card and before the next card.
    const at = (c: RecordedCall | undefined) => ctx.paints.indexOf(c as RecordedCall);
    for (let i = 0; i < 5; i++) {
      const name = textCall(ctx, `item ${i}`);
      expect(at(name)).toBeGreaterThan(at(cards[i]));
      if (i < 4) expect(at(name)).toBeLessThan(at(cards[i + 1]));
      expect(turnOf(name)).toBeCloseTo(turns[i] as number, 6);
    }
  });

  test("a selected card's outline turns with it", () => {
    const ctx = render([bag("fan", 5), ...children], { selection: ["c0"], wrap: true });
    const outline = ctx.paints.find(
      (c) => c.name === "stroke" && c.style?.strokeStyle === SELECTION_STROKE && c.clip !== null,
    );
    expect(outline).toBeDefined();
    expect(turnOf(outline as RecordedCall)).toBeCloseTo(turnOf(tiles(ctx)[0] as RecordedCall), 6);
    expect(turnOf(outline as RecordedCall)).toBeLessThan(0);
  });
});
