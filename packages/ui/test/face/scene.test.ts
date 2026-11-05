// @vitest-environment node
import type {
  ActionStateView,
  FaceElementView,
  FaceView,
  ObjectView,
  Viewer,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import type { Bounds, Rect, Shape } from "@vtt/schema";
import {
  attachFaces,
  buildFaceScene,
  buildScene,
  type Camera,
  createFaceStateStore,
  type DrawItem,
  type FaceScene,
  faceCullBounds,
  itemTransform,
  presentationBounds,
  resolveFace,
  type SceneInput,
  visibleBounds,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// View builders (as in model.test.ts)

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });

interface Spec {
  shape?: Shape | null;
  cells?: Record<string, WireResult>;
  actions?: string[];
  states?: ActionStateView[];
  face?: FaceView;
  template?: boolean;
  contents?: string[];
  at?: [number, number];
  rotation?: number;
  z?: number;
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
    cells.contents = { value: { type: "list", items: s.contents.map(ref) }, kind: "structural" };
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
  if (s.z !== undefined) cells.z = { value: num(s.z), kind: "literal" };
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

const value = (cell: string, r: Rect, index: number) =>
  ({ type: "value", cell, rect: r, index, shown: true }) as FaceElementView;
const button = (action: string, r: Rect, index: number) =>
  ({ type: "button", action, rect: r, index, shown: true }) as FaceElementView;

function lookup(views: ObjectView[]) {
  const map = new Map(views.map((v) => [v.id, v]));
  return (id: string) => map.get(id) ?? null;
}

function input(views: ObjectView[], viewer: Viewer = GM): SceneInput {
  return { views, covers: [], board: BOARD, viewer };
}

const itemOf = (scene: FaceScene, id: string): DrawItem => {
  const found = scene.items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};

const intersects = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

// ---------------------------------------------------------------------------
// Fixtures

const cardFace: FaceView = {
  elements: [value("name", [-1, -1.5, 2, 0.5], 0), button("Go", [-1, 1.6, 2, 0.4], 1)],
};
const card = mk("card", {
  shape: rect(2, 3),
  at: [0, 0],
  cells: {
    name: text("Card"),
    text: text("words"),
    image: text("t.assets/card-00000000.png"),
    color: text("#ff0000"),
    pattern: text("hatch"),
  },
  actions: ["Go"],
  face: cardFace,
});
const token = mk("token", {
  shape: circle(0.5),
  at: [5, 0],
  cells: {
    name: text("Token"),
    text: text("hp 7"),
    image: text("t.assets/token-00000000.png"),
  },
});
const downCard = mk("down", {
  shape: rect(2, 3),
  at: [10, 0],
  cells: { name: text("Hidden card"), text: text("secret") },
  actions: ["Go"],
  face: cardFace,
  faceUp: false,
});
const downTemplate = mk("down_tpl", {
  shape: circle(0.5),
  at: [15, 0],
  cells: { name: text("Template") },
  template: true,
  faceUp: false,
});
const die = mk("die", { shape: rect(1, 1), at: [0, 20], actions: ["Roll"] });

describe("attachFaces", () => {
  test("clears image, text and label only for items whose view has a layout", () => {
    const views = [card, token];
    const scene = attachFaces(buildScene(input(views)), lookup(views), createFaceStateStore(), {
      gm: true,
    });
    const c = itemOf(scene, "card");
    expect(c.text).toBeUndefined();
    expect(c.label).toBeUndefined();
    expect(c.image).toBeUndefined();
    expect(c.shape).toEqual(rect(2, 3));
    expect(c.fill).toBe("#ff0000");
    expect(c.pattern).toBe("hatch");
    const t = itemOf(scene, "token");
    expect(t.text).toBe("hp 7");
    expect(t.label).toBe("Token");
    expect(t.image).toBe("t.assets/token-00000000.png");
  });

  test("one full-list drawing per board item, as resolveFace makes it", () => {
    const views = [card, token, die];
    const faceState = createFaceStateStore();
    const scene = attachFaces(buildScene(input(views)), lookup(views), faceState, { gm: true });
    for (const v of views) {
      expect(scene.faces.get(v.id)).toEqual(
        resolveFace(v, { views: lookup(views), faceState, list: "full", gm: true }),
      );
    }
    expect([...scene.faces.keys()].sort()).toEqual(["card", "die", "token"]);
  });

  test("a face-down item gets no drawing and keeps its label; a face-down template keeps its gear", () => {
    const views = [downCard, downTemplate];
    const scene = attachFaces(buildScene(input(views)), lookup(views), createFaceStateStore(), {
      gm: true,
    });
    expect(scene.faces.has("down")).toBe(false);
    const d = itemOf(scene, "down");
    expect(d.faceDown).toBe(true);
    expect(d.label).toBe("Hidden card");
    expect(scene.presentation.get("down")).toEqual(d.bounds);
    const gear = scene.faces.get("down_tpl");
    expect(gear?.primitives.map((p) => p.kind)).toEqual(["gear"]);
  });

  test("presentation bounds and transforms per item", () => {
    const rotated = mk("rot", { shape: rect(2, 1), at: [3, 4], rotation: 90, actions: ["Go"] });
    const views = [card, die, rotated];
    const scene = attachFaces(buildScene(input(views)), lookup(views), createFaceStateStore(), {
      gm: true,
    });
    for (const item of scene.items) {
      expect(scene.presentation.get(item.id)).toEqual(
        presentationBounds(item, scene.faces.get(item.id) ?? null),
      );
      expect(scene.transforms.get(item.id)).toEqual(itemTransform(item));
    }
    // The strip extends past the footprint.
    const p = scene.presentation.get("die") as Bounds;
    expect(p.maxY).toBeGreaterThan(itemOf(scene, "die").bounds.maxY + 0.5);
  });

  test("a character scene reads face_up: absent fails closed to face down", () => {
    const unknown = mk("unknown", { shape: rect(2, 3), at: [0, 0], face: cardFace });
    delete (unknown.cells as Record<string, unknown>).face_up;
    const views = [card, unknown];
    const scene = buildFaceScene(input(views, ALDRIC), { faceState: createFaceStateStore() });
    expect(scene.faces.has("card")).toBe(true);
    expect(scene.faces.has("unknown")).toBe(false);
  });
});

describe("buildFaceScene", () => {
  test("is buildScene then attachFaces", () => {
    const views = [card, token, die, downCard, downTemplate];
    const faceState = createFaceStateStore();
    const built = buildFaceScene(input(views), { faceState });
    const attached = attachFaces(buildScene(input(views)), lookup(views), faceState, { gm: true });
    expect(built).toEqual(attached);
  });

  test("accepts a one-shot iterable of views", () => {
    const views = [card, die];
    const scene = buildFaceScene(
      { ...input(views), views: views.values() },
      { faceState: createFaceStateStore() },
    );
    expect(scene.items.map((i) => i.id).sort()).toEqual(["card", "die"]);
    expect(scene.faces.size).toBe(2);
  });
});

describe("faceCullBounds", () => {
  test("a faceless die just off-screen whose strip is on-screen is kept by its presentation bounds", () => {
    const views = [die];
    const scene = buildFaceScene(input(views), { faceState: createFaceStateStore() });
    const item = itemOf(scene, "die");
    // The footprint ends at y = 20.5; the strip spans y 20.65 to 21.1.
    const camera: Camera = { x: 0, y: 25.55, zoom: 1 };
    const view = visibleBounds(camera, { width: 640, height: 640 });
    expect(intersects(item.bounds, view)).toBe(false);
    const cull = faceCullBounds(item, scene);
    expect(cull).toEqual(scene.presentation.get("die"));
    expect(intersects(cull, view)).toBe(true);
  });

  test("an item without a drawing is culled by its own bounds", () => {
    const views = [downCard];
    const scene = buildFaceScene(input(views), { faceState: createFaceStateStore() });
    const item = itemOf(scene, "down");
    expect(faceCullBounds(item, scene)).toEqual(item.bounds);
  });
});
