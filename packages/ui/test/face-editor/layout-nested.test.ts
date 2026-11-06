// @vitest-environment node
/**
 * The layout tool on expanded contained entries (vtt-qf5.30; DESIGN.md §4.6
 * layout mode; M6-D34): with the container selected, a press on an element
 * drawn inside an expanded entry (list, grid or fan, any depth) selects that
 * element on the entry's object, its handles are drawn in the entry's frame
 * (translate, scale, a fan card's turn), and a move or resize is one
 * `set_face` on the entry's object in its own face coordinates. A collapsed
 * entry is not edited on the canvas: a press there does what it did before.
 */
import type {
  FaceElementView,
  FaceView,
  ObjectView,
  Viewer,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import type { FaceLayout, ObjectId, Point, Rect, Shape } from "@vtt/schema";
import {
  type Affine,
  apply,
  buildFaceScene,
  type Camera,
  type ContentsPrimitive,
  compose,
  createFaceStateStore,
  createLayoutTool,
  type Effect,
  entryTransform,
  type FaceDrawing,
  type FaceScene,
  type FaceStateStore,
  type InteractionEvent,
  type LayoutPhase,
  type Modifiers,
  movedRect,
  type ReducerInput,
  resizedRect,
  type Tool,
  type ToolState,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const CAMERA: Camera = { x: 0, y: 0, zoom: 2 };

const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const value = (cell: string, r: Rect, index: number) =>
  ({ type: "value", cell, rect: r, index, shown: true }) as FaceElementView;
const contents = (r: Rect, index: number, extra: Record<string, unknown> = {}) =>
  ({ type: "contents", rect: r, index, shown: true, ...extra }) as FaceElementView;

interface Spec {
  shape?: Shape;
  face?: FaceView;
  contents?: string[];
  at?: Point;
  container?: string;
}

function mk(id: string, s: Spec): ObjectView {
  const cells: ObjectView["cells"] = {
    name: { value: text(id), kind: "literal" },
    hp: { value: num(7), kind: "literal" },
    face_up: { value: bool(true), kind: "literal" },
  };
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
  const view: ObjectView = {
    id,
    is_template: false,
    is_character: false,
    cells,
    actions: [],
    action_states: [],
  };
  if (s.face) view.face = s.face;
  return view;
}

/** A card's elements, in its own face coordinates. */
const HP: Rect = [-0.9, -1.4, 1, 0.5];
const NAME: Rect = [-0.5, 0.4, 1, 0.5];
const card = (id: string, container: string, extra: FaceElementView[] = []) =>
  mk(id, {
    shape: rect(2, 3),
    container,
    face: { elements: [value("hp", HP, 0), value("name", NAME, 1), ...extra] },
  });
const CARD_LAYOUT: FaceLayout = {
  elements: [
    { type: "value", cell: "hp", rect: HP },
    { type: "value", cell: "name", rect: NAME },
  ],
};

/** A binder at (1, 2) whose face is one contents element (`layout`) holding `ids`. */
function binder(ids: string[], layout?: string): ObjectView {
  return mk("bin", {
    shape: rect(8, 10),
    at: [1, 2],
    contents: ids,
    face: {
      elements: [contents([-4, -5, 8, 10], 0, layout === undefined ? {} : { layout })],
    },
  });
}

interface World {
  scene: FaceScene;
  views: (id: ObjectId) => ObjectView | null;
}

function world(views: ObjectView[], faceState: FaceStateStore, selection = ["bin"]): World {
  const scene = buildFaceScene(
    { views, covers: [], board: BOARD, viewer: GM, selection },
    { faceState },
  );
  const byId = new Map(views.map((v) => [v.id, v]));
  return { scene, views: (id) => byId.get(id) ?? null };
}

function contentsOf(d: FaceDrawing | null | undefined): ContentsPrimitive {
  const c = d?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
  if (!c) throw new Error("no contents primitive");
  return c;
}

/** The frame (→ board) of entry `id` of the first contents element of `drawing`, under `toBoard`. */
function entryFrame(drawing: FaceDrawing | null | undefined, toBoard: Affine, id: string) {
  const c = contentsOf(drawing);
  const e = c.entries.find((x) => x.id === id);
  if (!e?.drawing) throw new Error(`no entry ${id}`);
  return {
    frame: compose(toBoard, entryTransform(c, e)),
    drawing: e.drawing,
    expanded: e.expanded,
  };
}

function frameOf(w: World, id: string): Affine {
  const t = w.scene.transforms.get("bin");
  if (!t) throw new Error("no binder transform");
  return entryFrame(w.scene.faces.get("bin"), t, id).frame;
}

type PointerType = "pointer_down" | "pointer_move" | "pointer_up";

function pointer(type: PointerType, board: Point): InteractionEvent {
  return {
    type,
    pointerId: 1,
    screen: toScreen(CAMERA, board, VIEWPORT),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" ? 0 : 1,
    modifiers: NO_MODS,
  };
}

type S = ToolState<LayoutPhase, "layout">;

function drive(tool: Tool<LayoutPhase, "layout">, w: World, events: InteractionEvent[], state?: S) {
  let s: S = state ?? tool.init({});
  const effects: Effect[] = [];
  events.forEach((event, i) => {
    const input: ReducerInput & { interactionId: string } = {
      scene: w.scene,
      views: w.views,
      viewport: VIEWPORT,
      activeBoard: BOARD,
      viewer: GM,
      revision: 7,
      camera: CAMERA,
      selection: ["bin"],
      interactionId: `i${i + 1}`,
    };
    const out = tool.reduce(s, event, input);
    s = out.state;
    effects.push(...out.effects);
  });
  return { state: s, effects };
}

const writes = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { type: "write" }> => e.type === "write");
const lastOverlays = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { type: "overlays" }> => e.type === "overlays").at(-1)
    ?.overlays;

function writtenFace(effect: Extract<Effect, { type: "write" }>, object: string): FaceLayout {
  expect(effect.ops).toHaveLength(1);
  const op = effect.ops[0] as { type: string; object: string; face: FaceLayout };
  expect(op.type).toBe("set_face");
  expect(op.object).toBe(object);
  return op.face;
}

function expectRect(actual: Rect | undefined, expected: Rect) {
  expect(actual).toBeDefined();
  (actual as Rect).forEach((v, i) => {
    expect(v).toBeCloseTo(expected[i] as number, 9);
  });
}

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];
const add = (p: Point, d: Point): Point => [p[0] + d[0], p[1] + d[1]];
const scaleOf = (m: Affine) => Math.hypot(m[0], m[1]);

/** Move element `hp` of `id` by local `delta` and resize its `se` corner by `grow`, under `frame`. */
function moveAndResize(w: World, id: string, path: unknown[], frame: Affine) {
  const tool = createLayoutTool();
  const on = (local: Point) => apply(frame, local);
  const grab = centre(HP);
  const delta: Point = [0.33, 0.21];
  const moved = drive(tool, w, [
    pointer("pointer_down", on(grab)),
    pointer("pointer_move", on(add(grab, [0.1, 0.1]))),
    pointer("pointer_move", on(add(grab, delta))),
    pointer("pointer_up", on(add(grab, delta))),
  ]);
  expect(moved.state.phase.selected).toEqual({ object: id, index: 0, path });
  const [moveWrite, ...more] = writes(moved.effects);
  expect(more).toEqual([]);
  const movedFace = writtenFace(moveWrite as Extract<Effect, { type: "write" }>, id);
  const after = movedRect(HP, delta);
  expectRect(movedFace.elements[0]?.rect, after);
  expect(movedFace.elements[1]).toEqual(CARD_LAYOUT.elements[1]);
  expect(moveWrite?.label).toBe(`Move a face element of ${id}`);

  // The handles are drawn at the element's corners in the entry's frame.
  const handles = lastOverlays(moved.effects)?.find((o) => o.kind === "handles");
  expect(handles?.kind === "handles" && handles.object).toBe(id);
  const se = handles?.kind === "handles" ? handles.handles.find((h) => h.key === "se") : undefined;
  const seLocal: Point = [after[0] + after[2], after[1] + after[3]];
  expect(se?.at[0]).toBeCloseTo(on(seLocal)[0], 9);
  expect(se?.at[1]).toBeCloseTo(on(seLocal)[1], 9);

  // Resize from the selected element's se handle (the pending layout shows meanwhile).
  const grow: Point = [0.42, -0.13];
  const resized = drive(
    tool,
    w,
    [
      pointer("pointer_down", on(seLocal)),
      pointer("pointer_move", on(add(seLocal, [0.2, 0]))),
      pointer("pointer_move", on(add(seLocal, grow))),
      pointer("pointer_up", on(add(seLocal, grow))),
    ],
    moved.state,
  );
  const [resizeWrite, ...extra] = writes(resized.effects);
  expect(extra).toEqual([]);
  expect(resizeWrite?.label).toBe(`Resize a face element of ${id}`);
  const resizedFace = writtenFace(resizeWrite as Extract<Effect, { type: "write" }>, id);
  expectRect(resizedFace.elements[0]?.rect, resizedRect(after, "se", grow));
  expect(resizedFace.elements[1]).toEqual(CARD_LAYOUT.elements[1]);
}

describe("an expanded binder card", () => {
  test("in a list: an element is moved and resized through the entry's scale, one set_face each", () => {
    const faceState = createFaceStateStore();
    faceState.expand("card");
    const w = world([binder(["card"]), card("card", "bin")], faceState);
    const frame = frameOf(w, "card");
    expect(scaleOf(frame)).not.toBeCloseTo(1, 3);
    moveAndResize(w, "card", [{ container: "bin", element: 0, entry: "card" }], frame);
  });

  test("in a fan, on a turned card: deltas are mapped through the card's turn", () => {
    const faceState = createFaceStateStore();
    faceState.expand("c2");
    const ids = ["c0", "c1", "c2"];
    const w = world([binder(ids, "fan"), ...ids.map((id) => card(id, "bin"))], faceState);
    const frame = frameOf(w, "c2");
    // The top card is turned and scaled.
    expect(Math.abs(frame[1])).toBeGreaterThan(1e-3);
    expect(scaleOf(frame)).not.toBeCloseTo(1, 3);
    moveAndResize(w, "c2", [{ container: "bin", element: 0, entry: "c2" }], frame);
  });

  test("in a grid", () => {
    const faceState = createFaceStateStore();
    faceState.expand("c1");
    const ids = ["c0", "c1"];
    const w = world([binder(ids, "grid"), ...ids.map((id) => card(id, "bin"))], faceState);
    moveAndResize(w, "c1", [{ container: "bin", element: 0, entry: "c1" }], frameOf(w, "c1"));
  });

  test("nested two deep: the innermost expanded entry's element, its object written", () => {
    const faceState = createFaceStateStore();
    faceState.expand("card");
    faceState.expand("gem");
    const outer = card("card", "bin", [contents([-1, -0.5, 2, 0.8], 2)]);
    const w = world(
      [
        binder(["card"]),
        {
          ...outer,
          cells: {
            ...outer.cells,
            contents: { value: { type: "list", items: [ref("gem")] }, kind: "structural" },
          },
        },
        card("gem", "card"),
      ],
      faceState,
    );
    const binTo = w.scene.transforms.get("bin") as Affine;
    const cardLevel = entryFrame(w.scene.faces.get("bin"), binTo, "card");
    const gem = entryFrame(cardLevel.drawing, cardLevel.frame, "gem");
    expect(gem.expanded).toBe(true);
    moveAndResize(
      w,
      "gem",
      [
        { container: "bin", element: 0, entry: "card" },
        { container: "card", element: 2, entry: "gem" },
      ],
      gem.frame,
    );
  });

  test("the outlines of the selected entry's elements are drawn in its frame", () => {
    const faceState = createFaceStateStore();
    faceState.expand("card");
    const w = world([binder(["card"]), card("card", "bin")], faceState);
    const frame = frameOf(w, "card");
    const tool = createLayoutTool();
    const at = apply(frame, centre(NAME));
    const { effects } = drive(tool, w, [pointer("pointer_down", at), pointer("pointer_up", at)]);
    const ghost = lastOverlays(effects)?.find((o) => o.kind === "drag_ghost");
    const items = ghost?.kind === "drag_ghost" ? ghost.items : [];
    expect(items).toHaveLength(2);
    const nw = items[1]?.shape?.type === "polygon" ? items[1].shape.points[0] : undefined;
    const want = apply(frame, [NAME[0], NAME[1]]);
    expect(items[1]?.anchor).toEqual([0, 0]);
    expect(items[1]?.rotation).toBe(0);
    expect(nw?.[0]).toBeCloseTo(want[0], 9);
    expect(nw?.[1]).toBeCloseTo(want[1], 9);
  });
});

describe("collapsed entries and board objects are unchanged", () => {
  test("a press on a collapsed entry selects the container's contents element, as before", () => {
    const faceState = createFaceStateStore();
    const w = world([binder(["card"]), card("card", "bin")], faceState);
    const binTo = w.scene.transforms.get("bin") as Affine;
    expect(entryFrame(w.scene.faces.get("bin"), binTo, "card").expanded).toBe(false);
    const c = contentsOf(w.scene.faces.get("bin"));
    const row = (c.entries[0] as { row: Rect }).row;
    // The middle of the collapsed row, right of its chevron (its collapsed face, the name).
    const at = apply(binTo, [c.rect[0] + row[2] / 2, c.rect[1] + row[1] + row[3] / 2]);
    const tool = createLayoutTool();
    const { state, effects } = drive(tool, w, [
      pointer("pointer_down", at),
      pointer("pointer_move", add(at, [0.5, 0])),
      pointer("pointer_up", add(at, [0.5, 0])),
    ]);
    expect(state.phase.selected).toEqual({ object: "bin", index: 0 });
    const all = writes(effects);
    expect(all).toHaveLength(1);
    writtenFace(all[0] as Extract<Effect, { type: "write" }>, "bin");
  });

  test("a press on an expanded card's blank area falls back to the container's element", () => {
    const faceState = createFaceStateStore();
    faceState.expand("card");
    const w = world([binder(["card"]), card("card", "bin")], faceState);
    const at = apply(frameOf(w, "card"), [0.8, -0.5]);
    const tool = createLayoutTool();
    const { state } = drive(tool, w, [pointer("pointer_down", at), pointer("pointer_up", at)]);
    expect(state.phase.selected).toEqual({ object: "bin", index: 0 });
  });
});
