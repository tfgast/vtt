// @vitest-environment node
/**
 * Cell drops (vtt-1xv.27; DESIGN.md §4.6 The inspector: "A layout mode lets
 * the GM drag cells onto the face", Gestures; M5 plan Q1 A2/A3, review r1
 * finding 10, r3 finding 5): an `application/x-vtt-cell` drop on the same
 * object adds a value element at the drop point converted with the hit's
 * `toLocal`, on a board object (translated and rotated) and on a contained
 * object drawn expanded in a binder row; everything else is not handled.
 */
import type {
  FaceElementView,
  FaceView,
  ObjectView,
  Viewer,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import type { FaceLayout, Point, Rect, Shape } from "@vtt/schema";
import {
  apply,
  buildFaceScene,
  buildScene,
  type Camera,
  CELL_DRAG_MIME,
  type ContentsPrimitive,
  cellDragData,
  compose,
  createCellDropHandler,
  createFaceStateStore,
  type DataDropEvent,
  type Effect,
  entryTransform,
  type FaceStateStore,
  itemTransform,
  type ReducerInput,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const CAMERA: Camera = { x: 7, y: 3, zoom: 1 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

interface Spec {
  shape?: Shape | null;
  cells?: Record<string, WireResult>;
  face?: FaceView;
  contents?: string[];
  at?: [number, number];
  rotation?: number;
  z?: number;
  container?: string;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {};
  cells.name = { value: text(id), kind: "literal" };
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: "literal" };
  }
  cells.face_up = { value: bool(true), kind: "literal" };
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
    is_template: false,
    is_character: false,
    cells,
    actions: [],
    action_states: [],
  };
  if (s.face) view.face = s.face;
  return view;
}

const value = (cell: string, r: Rect, index: number): FaceElementView =>
  ({ type: "value", cell, rect: r, index, shown: true }) as FaceElementView;

/** A 3 × 3 token at (7, 3), rotated 90°, with a `name` element. */
const TOKEN = mk("tok", {
  at: [7, 3],
  shape: rect(3, 3),
  rotation: 90,
  cells: { hp: num(7) },
  face: { elements: [value("name", [-1.5, -1.5, 3, 0.5], 0)] },
});
const OTHER = mk("other", { at: [-6, 0], shape: rect(2, 2), cells: { hp: num(1) } });
/** A shapeless binder at (0, 6) holding a card and a note. */
const BINDER = mk("binder", { at: [0, 6], contents: ["card", "note"] });
const CARD = mk("card", { container: "binder", shape: rect(2.5, 3.5), cells: { atk: num(4) } });
const NOTE = mk("note", { container: "binder", shape: rect(1, 1) });

const VIEWS = [TOKEN, OTHER, BINDER, CARD, NOTE];

function setup(views: ObjectView[] = VIEWS, faceState: FaceStateStore = createFaceStateStore()) {
  const byId = new Map(views.map((v) => [v.id, v]));
  const lookup = (id: string) => byId.get(id) ?? null;
  const input = (over: Partial<ReducerInput> = {}): ReducerInput => ({
    // The runtime's scene is vtt-3l6.5's plain scene (`createRuntimeInputs`).
    scene: buildScene({ views, covers: [], board: BOARD, viewer: GM, selection: [] }),
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer: GM,
    revision: 12,
    camera: CAMERA,
    selection: [],
    views: lookup,
    ...over,
  });
  const handler = createCellDropHandler({ faceState });
  return { input, handler, faceState, lookup };
}

function drop(board: Point, data: string, mime = CELL_DRAG_MIME): DataDropEvent {
  return { type: "data_drop", mime, data, screen: toScreen(CAMERA, board, VIEWPORT), board };
}

type Write = Extract<Effect, { type: "write" }>;

function onlyWrite(effects: Effect[] | null): Write {
  expect(effects).not.toBeNull();
  expect(effects).toHaveLength(1);
  const [w] = effects as Effect[];
  expect(w?.type).toBe("write");
  return w as Write;
}

function setFace(w: Write, object: string): FaceLayout {
  expect(w.ops).toHaveLength(1);
  const op = w.ops[0] as { type: string; object: string; face: FaceLayout };
  expect(op).toMatchObject({ type: "set_face", object });
  return op.face;
}

function expectRect(actual: Rect | undefined, expected: Rect) {
  expect(actual).toBeDefined();
  (actual as Rect).forEach((v, i) => {
    expect(v).toBeCloseTo(expected[i] as number, 9);
  });
}

describe("drag data", () => {
  test("the mime and the data a row carries", () => {
    expect(CELL_DRAG_MIME).toBe("application/x-vtt-cell");
    expect(JSON.parse(cellDragData("tok", "hp"))).toEqual({ object: "tok", cell: "hp" });
  });
});

describe("a drop on a board object", () => {
  test("adds the cell at the drop point in the translated, rotated token's frame", () => {
    const { input, handler } = setup();
    // Token-local (-1.2, 0.4): board (7 - 0.4, 3 - 1.2) under the 90° turn.
    const local: Point = [-1.2, 0.4];
    const board = apply(itemTransform({ anchor: [7, 3], rotation: 90 }), local);
    expect(board[0]).toBeCloseTo(6.6, 9);
    expect(board[1]).toBeCloseTo(1.8, 9);
    const w = onlyWrite(handler(drop(board, cellDragData("tok", "hp")), input()));
    expect(w.stamp).toMatchObject({ board: BOARD, viewer: GM, baseRevision: 12 });
    expect(typeof w.stamp.interactionId).toBe("string");
    expect(w.label).toBe("Add hp to the face of tok");
    expect(w.continuations).toEqual([]);
    const face = setFace(w, "tok");
    expect(face.elements).toHaveLength(2);
    expect(face.elements[0]).toEqual({ type: "value", cell: "name", rect: [-1.5, -1.5, 3, 0.5] });
    const added = face.elements[1];
    expect(added).toMatchObject({ type: "value", cell: "hp" });
    expectRect(added?.rect, [-1.2, 0.4, 2, 0.6]);
  });

  test("each drop gets its own interaction id", () => {
    const { input, handler } = setup();
    const a = onlyWrite(handler(drop([7, 3], cellDragData("tok", "hp")), input()));
    const b = onlyWrite(handler(drop([7, 3], cellDragData("tok", "hp")), input()));
    expect(a.stamp.interactionId).not.toBe(b.stamp.interactionId);
  });

  test("a drop near the edge is clamped into the frame (vtt-1xv.18's addCellElement)", () => {
    const { input, handler } = setup();
    const board = apply(itemTransform({ anchor: [7, 3], rotation: 90 }), [1.4, 1.4]);
    const face = setFace(
      onlyWrite(handler(drop(board, cellDragData("tok", "hp")), input())),
      "tok",
    );
    expectRect(face.elements[1]?.rect, [-0.5, 0.9, 2, 0.6]);
  });

  test("an object without a layout starts from the default layout", () => {
    const { input, handler } = setup();
    const face = setFace(
      onlyWrite(handler(drop([-6.5, -0.5], cellDragData("other", "hp")), input())),
      "other",
    );
    expect(face.elements.map((e) => (e.type === "value" ? e.cell : e.type))).toEqual([
      "name",
      "hp",
      "contents",
      "hp",
    ]);
    // Local (-0.5, -0.5); 2 units wide in a 2-unit frame: x clamps to -1.
    expectRect(face.elements.at(-1)?.rect, [-1, -0.5, 2, 0.6]);
  });
});

// The faceless binder's default list shows only while it is selected (M6-D12).
describe("a drop on a contained object drawn expanded in a binder row", () => {
  test("converts with the hit's accumulated transform", () => {
    const faceState = createFaceStateStore();
    faceState.expand("card");
    const { input, handler } = setup(VIEWS, faceState);
    const scene = buildFaceScene(
      { views: VIEWS, covers: [], board: BOARD, viewer: GM, selection: ["binder"] },
      { faceState },
    );
    const c = scene.faces
      .get("binder")
      ?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
    const entry = c?.entries.find((e) => e.id === "card");
    expect(entry?.expanded).toBe(true);
    const binderToBoard = scene.transforms.get("binder");
    if (c === undefined || entry === undefined || binderToBoard === undefined) throw new Error();
    const cardToBoard = compose(binderToBoard, entryTransform(c, entry));
    // Inside the list's clip (the 1.2-unit default list shows the top of the scaled card).
    const local: Point = [-1, -1.5];
    const board = apply(cardToBoard, local);
    const face = setFace(
      onlyWrite(
        handler(drop(board, cellDragData("card", "atk")), input({ selection: ["binder"] })),
      ),
      "card",
    );
    const added = face.elements.at(-1);
    expect(added).toMatchObject({ type: "value", cell: "atk" });
    expectRect(added?.rect, [-1, -1.5, 2, 0.6]);
  });

  test("a collapsed row is not a face to drop on", () => {
    const { input, handler } = setup();
    const scene = buildFaceScene(
      { views: VIEWS, covers: [], board: BOARD, viewer: GM, selection: ["binder"] },
      { faceState: createFaceStateStore() },
    );
    const c = scene.faces
      .get("binder")
      ?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
    const entry = c?.entries.find((e) => e.id === "card");
    const binderToBoard = scene.transforms.get("binder");
    if (c === undefined || entry === undefined || binderToBoard === undefined) throw new Error();
    const board = apply(compose(binderToBoard, entryTransform(c, entry)), [3, 0.3]);
    expect(
      handler(drop(board, cellDragData("card", "atk")), input({ selection: ["binder"] })),
    ).toBeNull();
  });
});

describe("not handled", () => {
  test("another mime", () => {
    const { input, handler } = setup();
    expect(
      handler(drop([7, 3], cellDragData("tok", "hp"), "application/x-vtt-template"), input()),
    ).toBeNull();
  });

  test("a drop on another object, or on nothing", () => {
    const { input, handler } = setup();
    expect(handler(drop([-6, 0], cellDragData("tok", "hp")), input())).toBeNull();
    expect(handler(drop([20, 20], cellDragData("tok", "hp")), input())).toBeNull();
  });

  test("view-as a character", () => {
    const { input, handler } = setup();
    expect(
      handler(
        drop([7, 3], cellDragData("tok", "hp")),
        input({ viewer: { type: "character", id: "aldric" } }),
      ),
    ).toBeNull();
  });

  test("no active board, or data that is not {object, cell}", () => {
    const { input, handler } = setup();
    expect(
      handler(drop([7, 3], cellDragData("tok", "hp")), input({ activeBoard: null })),
    ).toBeNull();
    for (const data of ["", "{", "[]", '{"object":"tok"}', '{"object":1,"cell":"hp"}']) {
      expect(handler(drop([7, 3], data), input())).toBeNull();
    }
  });

  test("a scene that is already a face scene is used as it is", () => {
    const faceState = createFaceStateStore();
    faceState.expand("card");
    const { input, handler } = setup(VIEWS, createFaceStateStore());
    // The handler's own face state has nothing expanded, but the scene given is a face scene.
    const scene = buildFaceScene(
      { views: VIEWS, covers: [], board: BOARD, viewer: GM, selection: ["binder"] },
      { faceState },
    );
    const c = scene.faces
      .get("binder")
      ?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
    const entry = c?.entries.find((e) => e.id === "card");
    const binderToBoard = scene.transforms.get("binder");
    if (c === undefined || entry === undefined || binderToBoard === undefined) throw new Error();
    const board = apply(compose(binderToBoard, entryTransform(c, entry)), [-1, -1.5]);
    const w = onlyWrite(handler(drop(board, cellDragData("card", "atk")), input({ scene })));
    expectRect(setFace(w, "card").elements.at(-1)?.rect, [-1, -1.5, 2, 0.6]);
  });
});
