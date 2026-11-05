// @vitest-environment node
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
import type { Point, Rect, Shape } from "@vtt/schema";
import {
  type Affine,
  apply,
  buildFaceScene,
  type Camera,
  type ContentsPrimitive,
  compose,
  contentsRect,
  createFaceStateStore,
  DEFAULT_CONTENTS_ELEMENT,
  dropTargetAt,
  entryTransform,
  type FaceDrawing,
  type FaceEntry,
  type FaceScene,
  type FaceStateStore,
  faceHitAt,
  pathContents,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// View builders (as in model.test.ts)

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
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
  cells.name = { value: text(id), kind: "literal" };
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

type ElementExtra = Partial<FaceElementView> & Record<string, unknown>;
const value = (cell: string, r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "value", cell, rect: r, index, shown: true, ...extra }) as FaceElementView;
const editor = (cell: string, r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "editor", cell, rect: r, index, shown: true, ...extra }) as FaceElementView;
const button = (action: string, r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "button", action, rect: r, index, shown: true, ...extra }) as FaceElementView;
const contents = (r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "contents", rect: r, index, shown: true, ...extra }) as FaceElementView;

function scene(
  views: ObjectView[],
  faceState: FaceStateStore = createFaceStateStore(),
  covers: Cover[] = [],
): FaceScene {
  return buildFaceScene({ views, covers, board: BOARD, viewer: GM }, { faceState });
}

function contentsOf(d: FaceDrawing | null | undefined): ContentsPrimitive {
  const c = d?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
  if (!c) throw new Error("no contents primitive");
  return c;
}

function entryOf(c: ContentsPrimitive, id: string): FaceEntry {
  const e = c.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
}

/** Board → the frame of the board object `id`. */
const boardOf = (s: FaceScene, id: string): Affine => {
  const t = s.transforms.get(id);
  if (!t) throw new Error(`no transform ${id}`);
  return t;
};

/** The centre of a rect. */
const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];

const close = (a: Point, b: Point) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

// ---------------------------------------------------------------------------
// Board faces

describe("faceHitAt: board faces", () => {
  test("a faceless die whose footprint is off to one side: its Roll button is hit", () => {
    const die = mk("die", { shape: rect(1, 1), at: [0, 20], actions: ["Roll"] });
    const s = scene([die]);
    // The strip button spans x -0.75..0.75, y 20.65..21.1.
    const hit = faceHitAt(s, [0, 20.85], CAMERA);
    expect(hit?.object).toBe("die");
    expect(hit?.target).toEqual({ type: "button", action: "Roll", enabled: true, template: false });
    expect(hit?.path).toEqual([]);
    close(apply(hit?.toLocal as Affine, [0, 20.85]), [0, 0.85]);
    expect(hit?.rect.minY).toBeCloseTo(20.65, 9);
    // Below its minSize (12 px; 0.45 units at 64 px × zoom) the button is not hit.
    expect(faceHitAt(s, [0, 20.85], { x: 0, y: 0, zoom: 0.4 })).toBeNull();
    // The footprint is the body.
    expect(faceHitAt(s, [0, 20], CAMERA)?.target).toEqual({ type: "body" });
  });

  test("of two overlapping faced cards the upper one's button wins; the lower one's is hit where uncovered", () => {
    const face: FaceView = { elements: [button("Go", [-1, 1.6, 2, 0.4], 0)] };
    const lower = mk("lower", { shape: rect(2, 3), at: [0, 0], z: 1, actions: ["Go"], face });
    const upper = mk("upper", { shape: rect(2, 3), at: [1, 0], z: 2, actions: ["Go"], face });
    const s = scene([lower, upper]);
    expect(faceHitAt(s, [0.5, 1.8], CAMERA)).toMatchObject({
      object: "upper",
      target: { type: "button", action: "Go" },
    });
    expect(faceHitAt(s, [-0.5, 1.8], CAMERA)).toMatchObject({
      object: "lower",
      target: { type: "button", action: "Go" },
    });
    // Over the overlap of the footprints, the upper body.
    expect(faceHitAt(s, [0.5, 0], CAMERA)).toMatchObject({
      object: "upper",
      target: { type: "body" },
    });
  });

  test("a template token's gear hit-tests as the gear, face down too", () => {
    const tpl = mk("tpl", { shape: circle(0.5), at: [0, 0], template: true });
    const down = mk("down", { shape: circle(0.5), at: [5, 0], template: true, faceUp: false });
    const s = scene([tpl, down]);
    // The gear is [0.5, -0.8, 0.3, 0.3] beside the frame's top-right corner.
    expect(faceHitAt(s, [0.65, -0.65], CAMERA)).toMatchObject({
      object: "tpl",
      target: { type: "gear", id: "tpl" },
    });
    expect(faceHitAt(s, [5.65, -0.65], CAMERA)?.target).toEqual({ type: "gear", id: "down" });
  });

  test("a value element on a rotated card is hit at its rotated position", () => {
    const face: FaceView = { elements: [value("name", [-1, -1.5, 2, 0.5], 0)] };
    const c = mk("rotcard", { shape: rect(2, 3), at: [10, 10], rotation: 90, face });
    const s = scene([c]);
    const p = apply(boardOf(s, "rotcard"), [0, -1.25]);
    expect(faceHitAt(s, p, CAMERA)?.target).toEqual({ type: "value", cell: "name" });
  });

  test("nothing is hit under a cover", () => {
    const die = mk("die", { shape: rect(1, 1), at: [0, 0], actions: ["Roll"] });
    const cover: Cover = {
      key: "c",
      board: BOARD,
      region: { position: [0, 0.85], rotation: 0, shape: rect(0.5, 0.5) },
    };
    const s = scene([die], createFaceStateStore(), [cover]);
    expect(faceHitAt(s, [0, 0.85], CAMERA)).toBeNull();
    expect(faceHitAt(s, [0.6, 0.85], CAMERA)?.target.type).toBe("button");
    expect(dropTargetAt(s, [0, 0.85], CAMERA, [])).toEqual({ kind: "board" });
  });

  test("a shapeless object is still hit within its marker's slop", () => {
    const pin = mk("pin", { at: [3, 3] });
    const s = scene([pin]);
    // 4 px off the anchor at zoom 1.
    expect(faceHitAt(s, [3 + 4 / 64, 3], CAMERA)).toMatchObject({
      object: "pin",
      target: { type: "body" },
    });
    // At a very small zoom the slop exceeds the default frame.
    expect(faceHitAt(s, [3 + 2, 3], { x: 0, y: 0, zoom: 1 / 32 })?.object).toBe("pin");
  });
});

// ---------------------------------------------------------------------------
// Contents

const kids = (n: number, container: string): ObjectView[] =>
  Array.from({ length: n }, (_, i) => mk(`c${i}`, { shape: rect(2, 3), container }));

describe("faceHitAt: contents", () => {
  test("a shapeless binder's contents list is hit outside its 10 px marker", () => {
    const binder = mk("binder", { at: [0, 0], contents: ["c0", "c1"] });
    const s = scene([binder, ...kids(2, "binder")]);
    // The default list is [-3, 0.65, 6, 1.2]: row 0 spans y 0.65..1.25.
    const hit = faceHitAt(s, [2, 0.9], CAMERA);
    expect(hit?.object).toBe("c0");
    expect(hit?.target).toEqual({
      type: "entry",
      id: "c0",
      container: "binder",
      element: DEFAULT_CONTENTS_ELEMENT,
    });
    expect(hit?.path).toHaveLength(1);
    expect(hit?.path[0]).toMatchObject({
      container: "binder",
      element: DEFAULT_CONTENTS_ELEMENT,
      list: "full",
      transform: boardOf(s, "binder"),
    });
    expect(hit?.rect).toEqual({ minX: -3, minY: 0.65, maxX: 3, maxY: 1.25 });
    expect(faceHitAt(s, [2, 1.5], CAMERA)?.target).toMatchObject({ type: "entry", id: "c1" });
  });

  test("with a scroll offset the row under the point is the scrolled one; a row scrolled out is not hit", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const binder = mk("binder", { at: [0, 0], contents: ids });
    const faceState = createFaceStateStore();
    faceState.setScroll("binder", DEFAULT_CONTENTS_ELEMENT, 1.2);
    const s = scene([binder, ...kids(10, "binder")], faceState);
    const c = contentsOf(s.faces.get("binder"));
    expect(c.offset).toBeCloseTo(1.2, 9);
    // The first visible row is c2.
    expect(faceHitAt(s, [2, c.rect[1] + 0.3], CAMERA)?.target).toMatchObject({
      type: "entry",
      id: "c2",
    });
    // c0 is drawn above the rect, clipped: nothing there.
    const c0 = contentsRect(c, entryOf(c, "c0").row);
    expect(faceHitAt(s, [2, c0[1] + 0.3], CAMERA)).toBeNull();
    // The last row is reachable.
    const c9 = contentsRect(c, entryOf(c, "c9").row);
    expect(faceHitAt(s, [2, c9[1] + 0.3], CAMERA)?.target).toMatchObject({ id: "c9" });
  });

  test("the chevron of a row", () => {
    const binder = mk("binder", { at: [0, 0], contents: ["c0", "c1"] });
    const s = scene([binder, ...kids(2, "binder")]);
    const c = contentsOf(s.faces.get("binder"));
    const p = centre(contentsRect(c, entryOf(c, "c1").chevron));
    const hit = faceHitAt(s, p, CAMERA);
    expect(hit?.target).toEqual({ type: "chevron", id: "c1" });
    expect(hit?.path.map((e) => e.container)).toEqual(["binder"]);
  });

  test("insertion indices where no row is", () => {
    const face: FaceView = { elements: [contents([-3, 0, 6, 3], 0)] };
    const box = mk("box", { shape: rect(6, 3), at: [0, -1.5], face, contents: ["c0", "c1"] });
    const s = scene([box, ...kids(2, "box")]);
    // Rows fill y 0..1.2 of the element (board y -1.5..-0.3).
    const hit = faceHitAt(s, [0, 0.5], CAMERA);
    expect(hit?.object).toBe("box");
    expect(hit?.target).toEqual({ type: "contents", container: "box", element: 0, index: 2 });
    expect(hit?.path).toEqual([]);
    expect(dropTargetAt(s, [1, -1.5 + 0.1], CAMERA, [])).toEqual({
      kind: "contents",
      container: "box",
      element: 0,
      index: 0,
    });
    expect(dropTargetAt(s, [1, -1.5 + 0.5], CAMERA, [])).toMatchObject({ index: 1 });
    expect(dropTargetAt(s, [1, -1.5 + 0.7], CAMERA, [])).toMatchObject({ index: 1 });
    expect(dropTargetAt(s, [1, -1.5 + 1.1], CAMERA, [])).toMatchObject({ index: 2 });
    expect(dropTargetAt(s, [1, 0.5], CAMERA, [])).toMatchObject({ kind: "contents", index: 2 });
  });

  test("a collapsed default row's name is the entry; a custom collapsed row's button and value are on the child", () => {
    const custom = mk("custom", {
      shape: rect(2, 3),
      container: "binder",
      actions: ["Go"],
      face: {
        elements: [],
        collapsed: [value("hp", [0, 0, 4, 0.6], 0), button("Go", [4.5, 0, 1.5, 0.6], 1)],
      },
      cells: { hp: num(7) },
    });
    const plain = mk("plain", { shape: rect(2, 3), container: "binder" });
    const binder = mk("binder", { at: [0, 0], contents: ["plain", "custom"] });
    const s = scene([binder, plain, custom]);
    const c = contentsOf(s.faces.get("binder"));
    const toBoard = (e: FaceEntry, local: Point) =>
      apply(compose(boardOf(s, "binder"), entryTransform(c, e)), local);

    const name = faceHitAt(s, toBoard(entryOf(c, "plain"), [1, 0.3]), CAMERA);
    expect(name?.target).toEqual({
      type: "entry",
      id: "plain",
      container: "binder",
      element: DEFAULT_CONTENTS_ELEMENT,
    });

    const e = entryOf(c, "custom");
    const go = faceHitAt(s, toBoard(e, [5.25, 0.3]), CAMERA);
    expect(go).toMatchObject({
      object: "custom",
      target: { type: "button", action: "Go", enabled: true },
    });
    expect(go?.path.map((x) => x.container)).toEqual(["binder"]);
    close(apply(go?.toLocal as Affine, toBoard(e, [5.25, 0.3])), [5.25, 0.3]);
    expect(faceHitAt(s, toBoard(e, [2, 0.3]), CAMERA)).toMatchObject({
      object: "custom",
      target: { type: "value", cell: "hp" },
    });
    // Between the value and the button: the entry.
    expect(faceHitAt(s, toBoard(e, [4.25, 0.3]), CAMERA)?.target).toMatchObject({
      type: "entry",
      id: "custom",
    });
  });

  test("a face-down card entry hits as the entry, its collapsed face not shown", () => {
    const down = mk("down", {
      shape: rect(2, 3),
      container: "binder",
      faceUp: false,
      actions: ["Go"],
      face: { elements: [], collapsed: [button("Go", [0, 0, 6, 0.6], 0)] },
    });
    const binder = mk("binder", { at: [0, 0], contents: ["down"] });
    const s = scene([binder, down]);
    expect(faceHitAt(s, [0, 0.95], CAMERA)?.target).toEqual({
      type: "entry",
      id: "down",
      container: "binder",
      element: DEFAULT_CONTENTS_ELEMENT,
    });
  });

  const cardFace: FaceView = {
    elements: [
      editor("target", [-1, -0.5, 1, 0.5], 0),
      value("hp", [0, -0.5, 1, 0.5], 1),
      button("Go", [-0.5, 0, 1, 0.5], 2, { min_size: 12 }),
    ],
  };
  const sheetFace: FaceView = { elements: [contents([-2, -2, 4, 4], 0, { entries: "full" })] };

  test("a button inside an expanded entry inside a rotated container is hit at its transformed position, not below its minSize", () => {
    const sheet = mk("sheet", {
      shape: rect(4, 4),
      at: [10, 10],
      rotation: 90,
      face: sheetFace,
      contents: ["card"],
    });
    const card = mk("card", {
      shape: rect(2, 1),
      container: "sheet",
      actions: ["Go"],
      face: cardFace,
      cells: { hp: num(3), target: EMPTY },
    });
    const s = scene([sheet, card]);
    const c = contentsOf(s.faces.get("sheet"));
    const e = entryOf(c, "card");
    expect(e.expanded).toBe(true);
    const childToBoard = compose(boardOf(s, "sheet"), entryTransform(c, e));
    const p = apply(childToBoard, [0, 0.25]);
    const hit = faceHitAt(s, p, CAMERA);
    expect(hit).toMatchObject({ object: "card", target: { type: "button", action: "Go" } });
    expect(hit?.path).toHaveLength(1);
    close(apply(hit?.toLocal as Affine, p), [0, 0.25]);
    // The button is 0.5 × 1.8 units high: below 12 px under zoom 0.2; then the child's body.
    const small: Camera = { x: 0, y: 0, zoom: 0.1 };
    expect(faceHitAt(s, p, small)).toMatchObject({ object: "card", target: { type: "body" } });
    // The editor of the child.
    expect(faceHitAt(s, apply(childToBoard, [-0.5, -0.25]), CAMERA)).toMatchObject({
      object: "card",
      target: { type: "editor", cell: "target" },
    });
    // The row outside the child's drawing: the entry.
    const rowRight = contentsRect(c, e.row);
    const outside = apply(boardOf(s, "sheet"), [
      rowRight[0] + 0.2,
      rowRight[1] + rowRight[3] / 2 + 0.6,
    ]);
    expect(faceHitAt(s, outside, CAMERA)?.target).toMatchObject({ type: "entry", id: "card" });
  });

  test("a button inside an expanded entry two containers deep has a two-element path", () => {
    const outer = mk("outer", {
      shape: rect(6, 6),
      at: [20, 0],
      rotation: 30,
      face: { elements: [contents([-3, -3, 6, 6], 0, { entries: "full" })] },
      contents: ["inner"],
    });
    const inner = mk("inner", {
      shape: rect(4, 4),
      container: "outer",
      face: sheetFace,
      contents: ["card"],
    });
    const card = mk("card", {
      shape: rect(2, 1),
      container: "inner",
      actions: ["Go"],
      face: cardFace,
      cells: { hp: num(3), target: EMPTY },
    });
    const s = scene([outer, inner, card]);
    const co = contentsOf(s.faces.get("outer"));
    const eo = entryOf(co, "inner");
    const ci = contentsOf(eo.drawing);
    const ec = entryOf(ci, "card");
    const innerToBoard = compose(boardOf(s, "outer"), entryTransform(co, eo));
    const cardToBoard = compose(innerToBoard, entryTransform(ci, ec));
    const p = apply(cardToBoard, [0.1, 0.3]);
    const hit = faceHitAt(s, p, CAMERA);
    expect(hit).toMatchObject({ object: "card", target: { type: "button", action: "Go" } });
    expect(hit?.path.map((x) => [x.container, x.element, x.list])).toEqual([
      ["outer", 0, "full"],
      ["inner", 0, "full"],
    ]);
    hit?.path[1]?.transform.forEach((x, i) => {
      expect(x).toBeCloseTo(innerToBoard[i] as number, 9);
    });
    close(apply(hit?.toLocal as Affine, p), [0.1, 0.3]);
    // pathContents walks to each level's contents primitive.
    expect(pathContents(s, hit?.path ?? [])).toEqual([co, ci]);
  });
});

// ---------------------------------------------------------------------------
// Drops

describe("dropTargetAt", () => {
  const cardFace: FaceView = {
    elements: [editor("target", [-1, -0.5, 1, 0.5], 0), value("hp", [0, -0.5, 1, 0.5], 1)],
  };
  const make = () => {
    const binder = mk("binder", { at: [0, 0], contents: ["a", "b"] });
    const a = mk("a", { shape: rect(2, 3), container: "binder" });
    const b = mk("b", { shape: rect(2, 3), container: "binder" });
    const sheet = mk("sheet", {
      shape: rect(4, 4),
      at: [20, 0],
      face: { elements: [contents([-2, -2, 4, 4], 0, { entries: "full" })] },
      contents: ["card"],
    });
    const card = mk("card", {
      shape: rect(2, 1),
      container: "sheet",
      face: cardFace,
      cells: { hp: num(3), target: EMPTY },
    });
    const goblin = mk("goblin", { shape: circle(0.5), at: [40, 0] });
    return scene([binder, a, b, sheet, card, goblin]);
  };

  test("over a collapsed row: that container's contents at the row's index", () => {
    const s = make();
    // Row b spans y 1.25..1.85; its upper half.
    expect(dropTargetAt(s, [2, 1.35], CAMERA, ["goblin"])).toEqual({
      kind: "contents",
      container: "binder",
      element: DEFAULT_CONTENTS_ELEMENT,
      index: 1,
    });
    expect(dropTargetAt(s, [2, 1.75], CAMERA, ["goblin"])).toMatchObject({ index: 2 });
  });

  test("over a value inside an expanded row's child: the parent's contents; over its editor: the editor", () => {
    const s = make();
    const c = contentsOf(s.faces.get("sheet"));
    const e = entryOf(c, "card");
    const childToBoard = compose(boardOf(s, "sheet"), entryTransform(c, e));
    const row = contentsRect(c, e.row);
    const valueP = apply(childToBoard, [0.5, -0.4]);
    const target = dropTargetAt(s, valueP, CAMERA, ["goblin"]);
    // Upper half of the row: before it.
    expect(valueP[1] - 0).toBeLessThan(row[1] + row[3] / 2);
    expect(target).toEqual({ kind: "contents", container: "sheet", element: 0, index: 0 });
    expect(dropTargetAt(s, apply(childToBoard, [-0.5, -0.25]), CAMERA, ["goblin"])).toEqual({
      kind: "editor",
      object: "card",
      element: 0,
    });
    // The dragged object's own editor is not a target: its container's list is.
    expect(dropTargetAt(s, apply(childToBoard, [-0.5, -0.25]), CAMERA, ["card"])).toMatchObject({
      kind: "contents",
      container: "sheet",
    });
  });

  test("over a list whose rows fill the rect: contents at the row's index", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const binder = mk("binder", { at: [0, 0], contents: ids });
    const s = scene([binder, ...kids(10, "binder")]);
    const c = contentsOf(s.faces.get("binder"));
    const r3 = contentsRect(c, entryOf(c, "c3").row);
    expect(dropTargetAt(s, [0, r3[1] + 0.1], CAMERA, ["x"])).toEqual({
      kind: "contents",
      container: "binder",
      element: DEFAULT_CONTENTS_ELEMENT,
      index: 3,
    });
  });

  test("precedence across overlapping objects: editors, then contents, then the board; bodies do not hide them", () => {
    const binder = mk("binder", { at: [0, 0], z: 0, contents: ["a", "b"] });
    const a = mk("a", { shape: rect(2, 3), container: "binder" });
    const b = mk("b", { shape: rect(2, 3), container: "binder" });
    const token = mk("token", { shape: circle(0.5), at: [2, 1], z: 5 });
    const targetFace: FaceView = { elements: [editor("target", [-1, -1.5, 2, 0.5], 0)] };
    // An editor under another object's body.
    const card = mk("card", { shape: rect(2, 3), at: [10, 0], z: 1, face: targetFace });
    const cover = mk("over", { shape: circle(0.5), at: [10, -1.25], z: 5 });
    // An editor on a lower object under an upper object's contents element.
    const card2 = mk("card2", { shape: rect(2, 3), at: [20, 0], z: 1, face: targetFace });
    const upper = mk("upper", { at: [20, -2.3], z: 5, contents: ["u0"] });
    const u0 = mk("u0", { shape: rect(2, 3), container: "upper" });
    const s = scene([binder, a, b, token, card, cover, card2, upper, u0]);

    // Contents under a token's body: the list, at the row's index.
    expect(dropTargetAt(s, [2, 1], CAMERA, ["x"])).toEqual({
      kind: "contents",
      container: "binder",
      element: DEFAULT_CONTENTS_ELEMENT,
      index: 1,
    });
    expect(dropTargetAt(s, [2, 0.8], CAMERA, ["token"])).toMatchObject({
      kind: "contents",
      container: "binder",
      index: 0,
    });
    // An editor under a body.
    expect(dropTargetAt(s, [10, -1.25], CAMERA, ["x"])).toEqual({
      kind: "editor",
      object: "card",
      element: 0,
    });
    // An editor under an upper object's list beats the list.
    expect(faceHitAt(s, [20, -1.25], CAMERA)?.target).toMatchObject({ type: "entry", id: "u0" });
    expect(dropTargetAt(s, [20, -1.25], CAMERA, ["x"])).toEqual({
      kind: "editor",
      object: "card2",
      element: 0,
    });
    // A dragged entry over its own row: its container's list.
    expect(dropTargetAt(s, [-2, 0.8], CAMERA, ["a"])).toMatchObject({
      kind: "contents",
      container: "binder",
      index: 0,
    });
  });

  test("elsewhere: the board; a dragged container is not a target", () => {
    const s = make();
    expect(dropTargetAt(s, [100, 100], CAMERA, ["goblin"])).toEqual({ kind: "board" });
    expect(dropTargetAt(s, [40, 0], CAMERA, ["a"])).toEqual({ kind: "board" });
    expect(dropTargetAt(s, [20, -1], CAMERA, ["sheet"])).toEqual({ kind: "board" });
    // The binder's marker (no contents there).
    expect(dropTargetAt(s, [0, 0], CAMERA, ["goblin"])).toEqual({ kind: "board" });
  });
});
