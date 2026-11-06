// @vitest-environment node
/**
 * Resize, vertex and rotate handles (vtt-3l6.9): `handlesFor`, `hitHandle`
 * and the `withHandles(selectTool)` decorator on a fixed scene. Rotated
 * rects keep the opposite corner, edges change one dimension, circles their
 * radius, polygons one vertex (a bow-tie is refused), rotation snaps with
 * Shift; the stamp is the pointer-down one; cancel writes nothing; anything
 * that hits no handle reaches the select tool.
 */
import type {
  CellView,
  FaceView,
  ObjectView,
  Viewer,
  WireOp,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import type { FaceElement, FaceLayout, ObjectId, Point, Rect, Shape } from "@vtt/schema";
import {
  buildScene,
  type Camera,
  type CancelReason,
  type DrawItem,
  type Effect,
  HANDLE_HIT_PX,
  type Handle,
  handlesFor,
  hitHandle,
  type InteractionEvent,
  type Modifiers,
  type ReducerInput,
  ROTATE_HANDLE_PX,
  type Scene,
  selectTool,
  type ToolInput,
  type ToolOverlay,
  type ToolState,
  toScreen,
  withHandles,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// The fixed scene

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const HERO: Viewer = { type: "character", id: "hero" };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const SHIFT: Modifiers = { ...NO_MODS, shift: true };
const PX = 64; // screen pixels per board unit at zoom 1

const num = (value: number): WireValue => ({ type: "number", value });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });
const SQUARE: Point[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

function obj(
  id: string,
  at: Point,
  z: number,
  shape: Shape | null,
  extra: { rotation?: number; name?: string; face?: FaceLayout } = {},
): ObjectView {
  const values: Record<string, WireResult> = {
    board: { type: "ref", object: BOARD },
    container: { type: "empty" },
    position: { type: "list", items: [num(at[0]), num(at[1])] },
    rotation: num(extra.rotation ?? 0),
    z: num(z),
    shape: shape ? { type: "shape", shape } : { type: "empty" },
    is_zone: { type: "boolean", value: false },
    face_up: { type: "boolean", value: true },
  };
  if (extra.name) values.name = { type: "text", value: extra.name };
  const cells: Record<string, CellView> = {};
  for (const [name, value] of Object.entries(values)) cells[name] = { value, kind: "literal" };
  const view: ObjectView = { id, is_template: false, is_character: false, cells, actions: [] };
  if (extra.face) view.face = faceView(extra.face);
  return view;
}

/** A GM view's live face for a stored layout: each element with its index, shown. */
function faceView(layout: FaceLayout): FaceView {
  const live = (list: FaceElement[]) => list.map((e, index) => ({ ...e, index, shown: true }));
  return {
    elements: live(layout.elements),
    ...(layout.collapsed === undefined ? {} : { collapsed: live(layout.collapsed) }),
    ...(layout.default_action === undefined ? {} : { default_action: layout.default_action }),
  } as FaceView;
}

/** A binder face (M6-D14): a name row and a contents list, plus a custom collapsed row. */
const BINDER_FACE: FaceLayout = {
  elements: [
    { type: "value", cell: "name", rect: [-3.1, -4.6, 6.2, 0.8], min_size: 12 },
    { type: "contents", rect: [-3.1, -3.6, 6.2, 8] },
  ],
  collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6] }],
  default_action: "open",
};
const COIN_FACE: FaceLayout = {
  elements: [{ type: "value", cell: "name", rect: [-0.8, -0.3, 1.6, 0.6] }],
};
const POND_FACE: FaceLayout = {
  elements: [
    { type: "value", cell: "name", rect: [-1, -1, 2, 0.5] },
    { type: "value", cell: "depth", rect: [0, 0, 1, 1] },
  ],
};

const VIEWS: ObjectView[] = [
  obj("r", [2, 1], 1, rect(4, 2), { rotation: 30, name: "Box" }),
  obj("u", [6, -4], 2, rect(2, 2), { name: "Crate" }),
  obj("c", [-4, 0], 3, circle(1), { name: "Coin" }),
  obj("p", [0, 5], 4, { type: "polygon", points: SQUARE }, { name: "Pond" }),
  obj("dot", [-6, -6], 5, null, { name: "Dot" }),
  obj("tok", [10, 6], 6, circle(0.5), { name: "Goblin" }),
  // Off the grid, far from the rest (vtt-nb8.34 stationary clicks with Snap on).
  obj("img", [30.3, 20.1], 7, rect(2.5, 1.3), { name: "Odd image" }),
  obj("oc", [40.1, 0.2], 8, circle(1.3), { name: "Odd coin" }),
  obj(
    "op",
    [40.3, 10.2],
    9,
    {
      type: "polygon",
      points: [
        [-1.1, -0.9],
        [1.3, -1.2],
        [0.2, 1.1],
      ],
    },
    { name: "Odd pond" },
  ),
  // Objects with faces, far from the rest (vtt-nb8.32, M6-D14).
  obj("b", [60, 0], 10, rect(6.6, 9.6), { name: "Binder", face: BINDER_FACE }),
  obj("br", [60, 30], 11, rect(6.6, 9.6), { rotation: 30, name: "Tilted", face: BINDER_FACE }),
  obj("cf", [80, 0], 12, circle(1), { name: "Seal", face: COIN_FACE }),
  obj("pf", [80, 20], 13, { type: "polygon", points: SQUARE }, { name: "Lake", face: POND_FACE }),
];
const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));
const SCENE: Scene = buildScene({ views: VIEWS, covers: [], board: BOARD, viewer: GM });

function item(id: ObjectId): DrawItem {
  const found = SCENE.items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Geometry helpers

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Local (relative to the anchor, unrotated) to board, rotated clockwise on screen. */
function world(local: Point, anchor: Point, deg: number): Point {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [anchor[0] + local[0] * c - local[1] * s, anchor[1] + local[0] * s + local[1] * c];
}

function closePoint(actual: Point, expected: Point, digits = 6) {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
}

const screenOf = (board: Point): Point => toScreen(CAMERA, board, VIEWPORT);

function handleOf(id: ObjectId, key: string): Handle {
  const h = handlesFor(item(id), CAMERA, VIEWPORT).find((x) => x.key === key);
  if (h === undefined) throw new Error(`no handle ${key} on ${id}`);
  return h;
}

// ---------------------------------------------------------------------------
// Driving the decorated tool

let seq = 0;
function makeInput(over: Partial<ReducerInput> = {}): ToolInput {
  seq++;
  return {
    scene: SCENE,
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer: GM,
    revision: 7,
    camera: CAMERA,
    selection: [],
    views: (id) => BY_ID.get(id) ?? null,
    ...over,
    interactionId: `i${seq}`,
  };
}

type PointerType = "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel";

function pointer(
  type: PointerType,
  board: Point,
  modifiers: Modifiers = NO_MODS,
  pointerId = 1,
): InteractionEvent {
  return {
    type,
    pointerId,
    screen: screenOf(board),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_down" || type === "pointer_move" ? 1 : 0,
    modifiers,
  };
}

function driver(initial: { selection?: ObjectId[]; viewer?: Viewer; snap?: boolean } = {}) {
  const tool = withHandles(selectTool);
  let state: ToolState = tool.init({});
  let selection: ObjectId[] = initial.selection ?? [];
  let revision = 7;
  const viewer = initial.viewer ?? GM;
  const apply = (effects: Effect[]) => {
    for (const e of effects) if (e.type === "select") selection = [...e.ids];
    return effects;
  };
  return {
    tool,
    get selection() {
      return selection;
    },
    set revision(r: number) {
      revision = r;
    },
    get state() {
      return state;
    },
    send(event: InteractionEvent, over: Partial<ReducerInput> = {}): Effect[] {
      const out = tool.reduce(
        state as never,
        event,
        makeInput({
          selection: [...selection],
          revision,
          viewer,
          ...(initial.snap === undefined ? {} : { snap: initial.snap }),
          ...over,
        }),
      );
      state = out.state as ToolState;
      return apply(out.effects);
    },
    cancel(reason: CancelReason): Effect[] {
      const out = tool.cancel(state as never, reason);
      state = out.state as ToolState;
      return apply(out.effects);
    },
    /** Down at `from`, moves halfway and to `to`, up at `to`. */
    drag(from: Point, to: Point, mods: { move?: Modifiers; up?: Modifiers } = {}): Effect[] {
      const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      return [
        ...this.send(pointer("pointer_down", from)),
        ...this.send(pointer("pointer_move", mid, mods.move ?? NO_MODS)),
        ...this.send(pointer("pointer_move", to, mods.move ?? NO_MODS)),
        ...this.send(pointer("pointer_up", to, mods.up ?? mods.move ?? NO_MODS)),
      ];
    },
  };
}

const of = <T extends Effect["type"]>(effects: Effect[], type: T) =>
  effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);

function onlyWrite(effects: Effect[]) {
  const writes = of(effects, "write");
  expect(writes).toHaveLength(1);
  return writes[0] as Extract<Effect, { type: "write" }>;
}

function shapeOp(ops: WireOp[]): Shape {
  const op = ops.find((o) => o.type === "set_shape");
  if (op?.type !== "set_shape" || op.shape === null) throw new Error("no set_shape");
  return op.shape;
}

function valueOp(ops: WireOp[], cell: string): WireValue | undefined {
  const op = ops.find((o) => o.type === "set_value" && o.cell === cell);
  return op?.type === "set_value" ? (op.value as WireValue) : undefined;
}

function positionOp(ops: WireOp[]): Point {
  const v = valueOp(ops, "position");
  if (v?.type !== "list") throw new Error("no position");
  const [x, y] = v.items;
  if (x?.type !== "number" || y?.type !== "number") throw new Error("bad position");
  return [x.value, y.value];
}

/** The last `overlays` effect's `handles` overlay (undefined: none in it; null: no overlays effect). */
function lastHandles(
  effects: Effect[],
): Extract<ToolOverlay, { kind: "handles" }> | undefined | null {
  const all = of(effects, "overlays");
  const last = all[all.length - 1];
  if (last === undefined) return null;
  return last.overlays.find(
    (o): o is Extract<ToolOverlay, { kind: "handles" }> => o.kind === "handles",
  );
}

// ---------------------------------------------------------------------------

describe("handlesFor", () => {
  test("a rotated rect has eight resize handles in object-local coordinates and a rotate handle", () => {
    const r = item("r");
    const handles = handlesFor(r, CAMERA, VIEWPORT);
    expect(handles.map((h) => h.key)).toEqual([
      "nw",
      "n",
      "ne",
      "e",
      "se",
      "s",
      "sw",
      "w",
      "rotate",
    ]);
    const local: Record<string, Point> = {
      nw: [-2, -1],
      n: [0, -1],
      ne: [2, -1],
      e: [2, 0],
      se: [2, 1],
      s: [0, 1],
      sw: [-2, 1],
      w: [-2, 0],
    };
    for (const h of handles) {
      expect(h.object).toBe("r");
      if (h.key === "rotate") continue;
      expect(h.role).toBe("resize");
      closePoint(h.at, world(local[h.key] as Point, [2, 1], 30));
      closePoint(h.screen, screenOf(h.at));
    }
    const rotate = handles[8] as Handle;
    expect(rotate.role).toBe("rotate");
    closePoint(rotate.from as Point, world([0, -1], [2, 1], 30));
    // 24 px above the top edge, along the object's rotated "up".
    closePoint(rotate.at, world([0, -1 - ROTATE_HANDLE_PX / PX], [2, 1], 30));
  });

  test("the rotate handle stays 24 px above the top edge at any zoom", () => {
    const zoomed: Camera = { x: 0, y: 0, zoom: 2 };
    const rotate = handlesFor(item("u"), zoomed, VIEWPORT).find((h) => h.key === "rotate");
    closePoint(rotate?.at as Point, [6, -5 - ROTATE_HANDLE_PX / (PX * 2)]);
    closePoint(rotate?.screen as Point, toScreen(zoomed, rotate?.at as Point, VIEWPORT));
  });

  test("a circle has one radius handle, a polygon one handle per vertex, both a rotate handle", () => {
    const c = handlesFor(item("c"), CAMERA, VIEWPORT);
    expect(c.map((h) => [h.key, h.role])).toEqual([
      ["radius", "radius"],
      ["rotate", "rotate"],
    ]);
    closePoint((c[0] as Handle).at, [-3, 0]);
    const p = handlesFor(item("p"), CAMERA, VIEWPORT);
    expect(p.map((h) => h.role)).toEqual(["vertex", "vertex", "vertex", "vertex", "rotate"]);
    closePoint((p[1] as Handle).at, [1, 4]);
  });

  test("a shapeless object has no handles", () => {
    expect(handlesFor(item("dot"), CAMERA, VIEWPORT)).toEqual([]);
  });
});

describe("hitHandle", () => {
  test("returns the nearest handle within the hit radius, else null", () => {
    const handles = handlesFor(item("u"), CAMERA, VIEWPORT);
    const se = handles.find((h) => h.key === "se") as Handle;
    expect(hitHandle(handles, se.screen)?.key).toBe("se");
    expect(hitHandle(handles, [se.screen[0] + HANDLE_HIT_PX - 1, se.screen[1]])?.key).toBe("se");
    expect(hitHandle(handles, [se.screen[0] + HANDLE_HIT_PX + 1, se.screen[1]])).toBeNull();
    expect(hitHandle([], se.screen)).toBeNull();
  });
});

describe("withHandles(selectTool)", () => {
  test("keeps the select tool's id, and shows handles for one selected shaped object", () => {
    const d = driver({ selection: ["u"] });
    expect(d.tool.id).toBe("select");
    const effects = d.send(pointer("pointer_move", [20, 20]));
    const overlay = lastHandles(effects);
    expect(overlay?.object).toBe("u");
    expect(overlay?.handles.map((m) => m.key)).toEqual(
      handlesFor(item("u"), CAMERA, VIEWPORT).map((h) => h.key),
    );
    // Unchanged handles are not emitted again.
    expect(of(d.send(pointer("pointer_move", [21, 20])), "overlays")).toEqual([]);
  });

  test("a corner drag on a rotated rect keeps the opposite corner and writes set_shape + set_value position", () => {
    const d = driver({ selection: ["r"] });
    const se = handleOf("r", "se");
    const to: Point = [se.at[0] + 1, se.at[1] + 0.5];
    const effects = d.drag(se.at, to);
    const write = onlyWrite(effects);
    expect(write.ops.map((o) => o.type)).toEqual(["set_shape", "set_value"]);
    expect(write.ops.every((o) => "object" in o && o.object === "r")).toBe(true);
    expect(write.label).toBe("Resize Box");
    const shape = shapeOp(write.ops);
    const position = positionOp(write.ops);
    if (shape.type !== "rect") throw new Error("not a rect");
    // The dragged corner follows the pointer; the opposite corner keeps its world position.
    closePoint(
      world([-shape.width / 2, -shape.height / 2], position, 30),
      world([-2, -1], [2, 1], 30),
    );
    closePoint(world([shape.width / 2, shape.height / 2], position, 30), to);
    // Previews during the drag, then held by the write's stamp.
    const previews = of(effects, "previews");
    const last = previews[previews.length - 1];
    expect(last?.hold?.stamp).toBe(write.stamp);
    expect(last?.previews.get("r")).toEqual({ shape, position });
    expect(previews.slice(0, -1).every((p) => p.hold === undefined)).toBe(true);
  });

  test("an edge drag changes one dimension only", () => {
    const d = driver({ selection: ["r"] });
    const e = handleOf("r", "e");
    // One unit outward along the local x axis, plus some drift along local y that is ignored.
    const to = world([3, 0.7], [2, 1], 30);
    const write = onlyWrite(d.drag(e.at, to));
    const shape = shapeOp(write.ops);
    expect(shape.type).toBe("rect");
    if (shape.type !== "rect") return;
    expect(shape.width).toBeCloseTo(5, 9);
    expect(shape.height).toBeCloseTo(2, 9);
    closePoint(positionOp(write.ops), world([0.5, 0], [2, 1], 30));
  });

  test("a drag past the opposite side clamps to the minimum size", () => {
    const d = driver({ selection: ["u"] });
    const write = onlyWrite(d.drag(handleOf("u", "e").at, [0, -4]));
    const shape = shapeOp(write.ops);
    expect(shape).toEqual({ type: "rect", width: 0.25, height: 2 });
  });

  test("the circle's radius handle changes only the radius", () => {
    const d = driver({ selection: ["c"] });
    const write = onlyWrite(d.drag(handleOf("c", "radius").at, [-1.5, 0]));
    expect(write.ops).toEqual([{ type: "set_shape", object: "c", shape: circle(2.5) }]);
  });

  test("a vertex handle moves that vertex and keeps the anchor", () => {
    const d = driver({ selection: ["p"] });
    const write = onlyWrite(d.drag(handleOf("p", "v1").at, [2, 3]));
    expect(write.ops).toEqual([
      {
        type: "set_shape",
        object: "p",
        shape: {
          type: "polygon",
          points: [
            [-1, -1],
            [2, -2],
            [1, 1],
            [-1, 1],
          ],
        },
      },
    ]);
  });

  test("a vertex move that makes a bow-tie is refused with a notice and no write", () => {
    const d = driver({ selection: ["p"] });
    const effects = d.drag(handleOf("p", "v0").at, [2, 5]);
    expect(of(effects, "write")).toEqual([]);
    const notices = of(effects, "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe("warning");
    expect(notices[0]?.text).toMatch(/simple/);
    // The preview is cleared.
    const previews = of(effects, "previews");
    expect(previews[previews.length - 1]?.previews.size).toBe(0);
  });

  describe("rotate", () => {
    // Pointer at 38° clockwise from the object's "up", two units out.
    const at38 = world([0, -2], [6, -4], 38);

    test("writes set_value rotation in degrees clockwise", () => {
      const d = driver({ selection: ["u"] });
      const write = onlyWrite(d.drag(handleOf("u", "rotate").at, at38));
      expect(write.ops).toHaveLength(1);
      expect(write.label).toBe("Rotate Crate");
      const v = valueOp(write.ops, "rotation");
      expect(v?.type).toBe("number");
      expect(v?.type === "number" ? v.value : Number.NaN).toBeCloseTo(38, 6);
    });

    test("Shift snaps to 15°", () => {
      const d = driver({ selection: ["u"] });
      const write = onlyWrite(d.drag(handleOf("u", "rotate").at, at38, { move: SHIFT }));
      expect(write.ops).toEqual([
        { type: "set_value", object: "u", cell: "rotation", value: num(45) },
      ]);
      const previews = of(d.send(pointer("pointer_move", [20, 20])), "previews");
      expect(previews).toEqual([]);
    });

    test("is relative to the current rotation", () => {
      const d = driver({ selection: ["r"] });
      const rotate = handleOf("r", "rotate");
      // A quarter turn clockwise about the anchor.
      const to = world([0, -3], [2, 1], 120);
      const write = onlyWrite(d.drag(rotate.at, to, { move: SHIFT }));
      expect(write.ops).toEqual([
        { type: "set_value", object: "r", cell: "rotation", value: num(120) },
      ]);
    });
  });

  describe("no handles", () => {
    const cases: [string, { selection: ObjectId[]; viewer?: Viewer }][] = [
      ["a shapeless object", { selection: ["dot"] }],
      ["a multiple selection", { selection: ["u", "c"] }],
      ["a character view", { selection: ["u"], viewer: HERO }],
    ];
    test.each(cases)("for %s", (_name, setup) => {
      const d = driver(setup);
      const effects = d.send(pointer("pointer_move", [20, 20]));
      expect(lastHandles(effects) ?? undefined).toBeUndefined();
      // A press where u's corner handle would be is the select tool's.
      d.send(pointer("pointer_down", handleOf("u", "se").at));
      expect(d.state.phase).toMatchObject({ inner: { gesture: { kind: "press" } } });
    });
  });

  test("the write carries the baseRevision captured at pointer down", () => {
    const d = driver({ selection: ["u"] });
    const se = handleOf("u", "se");
    d.send(pointer("pointer_down", se.at));
    d.revision = 9;
    d.send(pointer("pointer_move", [8, -2]));
    const write = onlyWrite(d.send(pointer("pointer_up", [8, -2])));
    expect(write.stamp.baseRevision).toBe(7);
    expect(write.stamp.board).toBe(BOARD);
  });

  test.each<CancelReason>(["escape", "board_change", "tool_switch", "viewer_change"])(
    "cancel (%s) during a handle drag writes nothing and clears the previews",
    (reason) => {
      const d = driver({ selection: ["u"] });
      const se = handleOf("u", "se");
      d.send(pointer("pointer_down", se.at));
      d.send(pointer("pointer_move", [8, -2]));
      const effects = d.cancel(reason);
      expect(of(effects, "write")).toEqual([]);
      expect(of(effects, "previews").map((p) => p.previews.size)).toEqual([0]);
      // Escape ends the drag; it does not also clear the selection.
      expect(of(effects, "select")).toEqual([]);
      expect(d.selection).toEqual(["u"]);
      // The release after a cancel writes nothing either.
      expect(of(d.send(pointer("pointer_up", [8, -2])), "write")).toEqual([]);
    },
  );

  test("a pointer_cancel during a handle drag writes nothing", () => {
    const d = driver({ selection: ["u"] });
    d.send(pointer("pointer_down", handleOf("u", "se").at));
    d.send(pointer("pointer_move", [8, -2]));
    const effects = d.send(pointer("pointer_cancel", [8, -2]));
    expect(of(effects, "write")).toEqual([]);
    expect(of(effects, "previews").map((p) => p.previews.size)).toEqual([0]);
  });

  test.each([
    ["an image corner", "img", "se"],
    ["a rotated rect corner", "r", "se"],
    ["a rotated rect edge", "r", "e"],
    ["an off-grid circle radius", "oc", "radius"],
    ["an off-grid polygon vertex", "op", "v1"],
  ] as const)(
    "with Snap on, a stationary press and release on %s writes nothing",
    (_n, id, key) => {
      const d = driver({ selection: [id], snap: true });
      const h = handleOf(id, key);
      const effects = [
        ...d.send(pointer("pointer_down", h.at)),
        ...d.send(pointer("pointer_move", h.at)),
        ...d.send(pointer("pointer_up", h.at)),
      ];
      expect(of(effects, "write")).toEqual([]);
      // The preview during the stationary move is the original geometry.
      for (const p of of(effects, "previews")) {
        const preview = p.previews.get(id);
        if (preview?.shape !== undefined) expect(preview.shape).toEqual(item(id).shape);
        if (preview?.position !== undefined) closePoint(preview.position, item(id).anchor, 9);
      }
    },
  );

  test("a press and release on a handle without moving writes nothing", () => {
    const d = driver({ selection: ["u"] });
    const se = handleOf("u", "se");
    const effects = [
      ...d.send(pointer("pointer_down", se.at)),
      ...d.send(pointer("pointer_up", se.at)),
    ];
    expect(of(effects, "write")).toEqual([]);
    expect(d.selection).toEqual(["u"]);
  });

  test("a pointer down that hits no handle reaches the select tool", () => {
    const d = driver({ selection: ["u"] });
    const effects = [
      ...d.send(pointer("pointer_down", [10, 6])),
      ...d.send(pointer("pointer_up", [10, 6])),
    ];
    expect(of(effects, "select")).toEqual([{ type: "select", ids: ["tok"] }]);
    // The handles follow the new selection in the same reduction.
    expect(lastHandles(effects)?.object).toBe("tok");
  });

  test("Escape with no handle drag is the select tool's (clears the selection, drops the handles)", () => {
    const d = driver({ selection: ["u"] });
    d.send(pointer("pointer_move", [20, 20]));
    const effects = d.cancel("escape");
    expect(of(effects, "select")).toEqual([{ type: "select", ids: [] }]);
    expect(lastHandles(effects)).toBeUndefined();
  });

  test("handles hide while the select tool drags, and return after the drop", () => {
    const d = driver({ selection: ["u"] });
    d.send(pointer("pointer_move", [20, 20]));
    d.send(pointer("pointer_down", [6, -4]));
    const moving = d.send(pointer("pointer_move", [7, -4]));
    const overlays = of(moving, "overlays");
    expect(overlays[overlays.length - 1]?.overlays.map((o) => o.kind)).toEqual(["drag_ghost"]);
    const dropped = d.send(pointer("pointer_up", [7, -4]));
    expect(onlyWrite(dropped).ops[0]?.type).toBe("move");
    expect(lastHandles(dropped)?.object).toBe("u");
  });

  test("after a resize the handles follow the held geometry until the write is visible", () => {
    const d = driver({ selection: ["u"] });
    const se = handleOf("u", "se");
    const effects = d.drag(se.at, [8, -2]);
    const write = onlyWrite(effects);
    const shown = lastHandles(effects);
    // u is now 3 × 3 at (6.5, -3.5): its se corner is at (8, -2).
    closePoint(shown?.handles.find((m) => m.key === "se")?.at as Point, [8, -2]);
    // The commit settles; until the client has seen its revision the held geometry stays.
    d.send({
      type: "settled",
      interactionId: write.stamp.interactionId,
      outcome: {
        type: "write",
        result: {
          status: "committed",
          revision: 8,
          index: 1,
          created: [],
          copies: [],
          bindings: {},
        },
      },
    });
    expect(of(d.send(pointer("pointer_move", [20, 20])), "overlays")).toEqual([]);
    // Once revision 8 is seen, the handles come from the scene (here unchanged: the old geometry).
    const after = d.send(pointer("pointer_move", [20, 21]), { revision: 8 });
    closePoint(lastHandles(after)?.handles.find((m) => m.key === "se")?.at as Point, [7, -3]);
  });

  describe("the grab offset", () => {
    // 3 px right and 2 px below the handle's center: inside the hit radius.
    const off = (at: Point): Point => [at[0] + 3 / PX, at[1] + 2 / PX];

    test.each([
      ["a rotated rect corner", "r", "se"],
      ["a rect edge", "u", "e"],
      ["a circle radius", "c", "radius"],
      ["a polygon vertex", "p", "v1"],
    ])("a stationary off-center click on %s writes nothing", (_name, id, key) => {
      const d = driver({ selection: [id] });
      const press = off(handleOf(id, key).at);
      const effects = [
        ...d.send(pointer("pointer_down", press)),
        ...d.send(pointer("pointer_move", press)),
        ...d.send(pointer("pointer_up", press)),
      ];
      expect(of(effects, "write")).toEqual([]);
      expect(of(effects, "notice")).toEqual([]);
    });

    test("an off-center rect corner drag applies the pointer's displacement to the corner", () => {
      const d = driver({ selection: ["u"] });
      const press = off(handleOf("u", "se").at);
      const write = onlyWrite(d.drag(press, [press[0] + 1, press[1] + 1]));
      expect(write.ops).toEqual([
        { type: "set_shape", object: "u", shape: rect(3, 3) },
        {
          type: "set_value",
          object: "u",
          cell: "position",
          value: { type: "list", items: [num(6.5), num(-3.5)] },
        },
      ]);
    });

    test("an off-center circle radius drag applies the displacement to the radius handle", () => {
      const d = driver({ selection: ["c"] });
      const press = off(handleOf("c", "radius").at);
      const write = onlyWrite(d.drag(press, [press[0] + 1.5, press[1]]));
      expect(write.ops).toEqual([{ type: "set_shape", object: "c", shape: circle(2.5) }]);
    });

    test("an off-center vertex drag applies the displacement to the vertex", () => {
      const d = driver({ selection: ["p"] });
      const press = off(handleOf("p", "v1").at);
      const write = onlyWrite(d.drag(press, [press[0] + 1, press[1] - 1]));
      const shape = shapeOp(write.ops);
      expect(shape.type === "polygon" ? shape.points[1] : null).toEqual([2, -2]);
    });
  });

  test("a rotation after a resize that has not settled keeps the pending size and position", () => {
    const d = driver({ selection: ["u"] });
    const resize = onlyWrite(d.drag(handleOf("u", "se").at, [8, -2]));
    // u is pending at 3 × 3 about (6.5, -3.5): its rotate handle is above that top edge.
    const rotate = { at: [6.5, -5 - ROTATE_HANDLE_PX / PX] as Point };
    const to = world([0, -3], [6.5, -3.5], 90);
    d.send(pointer("pointer_down", rotate.at));
    const moving = d.send(pointer("pointer_move", to, SHIFT));
    const pending = { shape: rect(3, 3), position: [6.5, -3.5] as Point };
    expect(of(moving, "previews")[0]?.previews.get("u")).toEqual({ ...pending, rotation: 90 });
    const released = d.send(pointer("pointer_up", to, SHIFT));
    const write = onlyWrite(released);
    // The write carries only its own change.
    expect(write.ops).toEqual([
      { type: "set_value", object: "u", cell: "rotation", value: num(90) },
    ]);
    const held = of(released, "previews")[0];
    expect(held?.hold?.stamp).toBe(write.stamp);
    expect(held?.previews.get("u")).toEqual({ ...pending, rotation: 90 });
    // The handles show both: the se corner of a 3 × 3 square turned a quarter about (6.5, -3.5)
    // (emitted during the drag; the release changes nothing).
    expect(of(released, "overlays")).toEqual([]);
    const shown = lastHandles(moving)?.handles.find((m) => m.key === "se")?.at as Point;
    closePoint(shown, [5, -2]);
    // The resize settles first; until revision 8 is seen nothing changes.
    d.send({
      type: "settled",
      interactionId: resize.stamp.interactionId,
      outcome: {
        type: "write",
        result: {
          status: "committed",
          revision: 8,
          index: 1,
          created: [],
          copies: [],
          bindings: {},
        },
      },
    });
    expect(of(d.send(pointer("pointer_move", [20, 20])), "overlays")).toEqual([]);
    // A failed rotation drops only its own geometry: the handles go back to the pending resize.
    const after = d.send({
      type: "settled",
      interactionId: write.stamp.interactionId,
      outcome: { type: "write", result: { status: "uncertain", reason: "lost" } },
    });
    closePoint(lastHandles(after)?.handles.find((m) => m.key === "se")?.at as Point, [8, -2]);
  });

  test("cursor shows the handle under the pointer and the drag in progress", () => {
    const d = driver({ selection: ["u"] });
    expect(d.tool.cursor(d.state as never)).toBe("default");
    d.send(pointer("pointer_move", handleOf("u", "se").at));
    expect(d.tool.cursor(d.state as never)).toBe("nwse-resize");
    d.send(pointer("pointer_move", handleOf("u", "n").at));
    expect(d.tool.cursor(d.state as never)).toBe("ns-resize");
    d.send(pointer("pointer_move", handleOf("u", "rotate").at));
    expect(d.tool.cursor(d.state as never)).toBe("grab");
    d.send(pointer("pointer_down", handleOf("u", "rotate").at));
    expect(d.tool.cursor(d.state as never)).toBe("grabbing");
  });
});

// ---------------------------------------------------------------------------
// Snap (M6-D13, vtt-nb8.34)

describe("handle drags with Snap", () => {
  const onHalf = (n: number) => Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;

  test("an unrotated rect's corner lands on half units; with Snap off it does not", () => {
    const on = onlyWrite(driver({ selection: ["u"], snap: true }).drag([7, -3], [7.8, -2.1]));
    // The nw corner (5, -5) stays; the se corner snaps to (8, -2).
    expect(shapeOp(on.ops)).toEqual(rect(3, 3));
    expect(positionOp(on.ops)).toEqual([6.5, -3.5]);
    const off = onlyWrite(driver({ selection: ["u"], snap: false }).drag([7, -3], [7.8, -2.1]));
    const shape = shapeOp(off.ops);
    if (shape.type !== "rect") throw new Error("not a rect");
    expect(shape.width).toBeCloseTo(2.8, 9);
    expect(onHalf(shape.width)).toBe(false);
  });

  test("an unrotated rect's edge lands on a half unit and changes one dimension", () => {
    const write = onlyWrite(driver({ selection: ["u"], snap: true }).drag([7, -4], [8.2, -3.7]));
    expect(shapeOp(write.ops)).toEqual(rect(3, 2));
    expect(positionOp(write.ops)).toEqual([6.5, -4]);
  });

  test("a snap below the minimum is clamped to the minimum from the fixed edge", () => {
    // The e edge snaps onto the w edge (x = 5): width 0, clamped to 0.25.
    const write = onlyWrite(driver({ selection: ["u"], snap: true }).drag([7, -4], [5.1, -4]));
    expect(shapeOp(write.ops)).toEqual(rect(0.25, 2));
    expect(positionOp(write.ops)).toEqual([5.125, -4]);
  });

  test("a rotated rect's corner lands on the snapped board point; the rect stays rotated", () => {
    const se = handleOf("r", "se");
    const to: Point = [se.at[0] + 1.1, se.at[1] + 0.4];
    const snapped: Point = [Math.round(to[0] * 2) / 2, Math.round(to[1] * 2) / 2];
    const write = onlyWrite(driver({ selection: ["r"], snap: true }).drag(se.at, to));
    expect(write.ops.map((o) => o.type)).toEqual(["set_shape", "set_value"]);
    const shape = shapeOp(write.ops);
    const position = positionOp(write.ops);
    if (shape.type !== "rect") throw new Error("not a rect");
    closePoint(world([shape.width / 2, shape.height / 2], position, 30), snapped, 9);
    // The opposite corner keeps its world position (not snapped).
    closePoint(
      world([-shape.width / 2, -shape.height / 2], position, 30),
      world([-2, -1], [2, 1], 30),
    );
    // Without Snap the corner follows the pointer instead.
    const off = onlyWrite(driver({ selection: ["r"] }).drag(se.at, to));
    const offShape = shapeOp(off.ops);
    if (offShape.type !== "rect") throw new Error("not a rect");
    closePoint(world([offShape.width / 2, offShape.height / 2], positionOp(off.ops), 30), to);
  });

  test("the circle's radius snaps to a half unit, at least the minimum", () => {
    const on = onlyWrite(driver({ selection: ["c"], snap: true }).drag([-3, 0], [-1.4, 0.3]));
    expect(on.ops).toEqual([{ type: "set_shape", object: "c", shape: circle(2.5) }]);
    const off = onlyWrite(driver({ selection: ["c"] }).drag([-3, 0], [-1.4, 0.3]));
    const shape = shapeOp(off.ops);
    expect(shape.type === "circle" && onHalf(shape.radius)).toBe(false);
    const tiny = onlyWrite(driver({ selection: ["c"], snap: true }).drag([-3, 0], [-3.9, 0]));
    expect(tiny.ops).toEqual([{ type: "set_shape", object: "c", shape: circle(0.25) }]);
  });

  test("a polygon vertex lands on a half unit", () => {
    const write = onlyWrite(driver({ selection: ["p"], snap: true }).drag([1, 4], [2.2, 2.9]));
    expect(write.ops).toEqual([
      {
        type: "set_shape",
        object: "p",
        shape: {
          type: "polygon",
          points: [
            [-1, -1],
            [2, -2],
            [1, 1],
            [-1, 1],
          ],
        },
      },
    ]);
  });

  test("the rotate handle ignores Snap", () => {
    const at38 = world([0, -2], [6, -4], 38);
    const rotateOf = (snap: boolean) => {
      const d = driver({ selection: ["u"], snap });
      return valueOp(onlyWrite(d.drag(handleOf("u", "rotate").at, at38)).ops, "rotation");
    };
    expect(rotateOf(true)).toEqual(rotateOf(false));
  });
});

// ---------------------------------------------------------------------------
// Faces follow a resize (M6-D14, vtt-nb8.32)

function faceOp(ops: WireOp[]): FaceLayout {
  const op = ops.find((o) => o.type === "set_face");
  if (op?.type !== "set_face" || op.face === null) throw new Error("no set_face");
  return op.face as FaceLayout;
}

function closeRect(actual: Rect, expected: Rect) {
  for (let i = 0; i < 4; i++) expect(actual[i]).toBeCloseTo(expected[i] as number, 9);
}

describe("resizing an object with a face scales its elements", () => {
  const fy = 14 / 9.6;

  test("a binder made taller (6.6 × 9.6 → 6.6 × 14) scales heights and y, keeps x and w", () => {
    const d = driver({ selection: ["b"] });
    // The s edge (60, 4.8) moves down 4.4: the n edge (y = -4.8) stays.
    const write = onlyWrite(d.drag([60, 4.8], [60, 9.2]));
    expect(write.ops.map((o) => o.type)).toEqual(["set_shape", "set_value", "set_face"]);
    expect(write.label).toBe("Resize Binder");
    expect(shapeOp(write.ops)).toEqual(rect(6.6, 14));
    closePoint(positionOp(write.ops), [60, 2.2]);
    const face = faceOp(write.ops);
    const [name, contents] = face.elements as [FaceElement, FaceElement];
    // Local frame: the box's origin moves from y -4.8 to -7.
    closeRect(name.rect, [-3.1, -7 + 0.2 * fy, 6.2, 0.8 * fy]);
    closeRect(contents.rect, [-3.1, -7 + 1.2 * fy, 6.2, 8 * fy]);
    expect(contents.rect[3]).toBeCloseTo(11.6666666667, 6);
    // min_size, the custom collapsed list and the rest of the layout are unchanged.
    expect(name.min_size).toBe(12);
    expect(name).toMatchObject({ type: "value", cell: "name" });
    expect(contents.type).toBe("contents");
    expect(face.collapsed).toEqual(BINDER_FACE.collapsed);
    expect(face.default_action).toBe("open");
    // The live view's fields (index, shown) are not written.
    expect(Object.keys(contents)).toEqual(["type", "rect"]);
  });

  test("a non-uniform corner resize scales x and y independently", () => {
    const d = driver({ selection: ["b"] });
    // se (63.3, 4.8) → (66.6, 7.2): 9.9 × 12 (factors 1.5 and 1.25); nw (56.7, -4.8) stays.
    const write = onlyWrite(d.drag([63.3, 4.8], [66.6, 7.2]));
    const shape = shapeOp(write.ops);
    if (shape.type !== "rect") throw new Error("not a rect");
    expect(shape.width).toBeCloseTo(9.9, 9);
    expect(shape.height).toBeCloseTo(12, 9);
    const [name, contents] = faceOp(write.ops).elements as [FaceElement, FaceElement];
    closeRect(contents.rect, [-4.95 + 0.2 * 1.5, -6 + 1.2 * 1.25, 6.2 * 1.5, 8 * 1.25]);
    closeRect(name.rect, [-4.95 + 0.2 * 1.5, -6 + 0.2 * 1.25, 6.2 * 1.5, 0.8 * 1.25]);
  });

  test("a rotated binder scales like an unrotated one (factors in the local frame)", () => {
    const d = driver({ selection: ["br"] });
    const s = handleOf("br", "s");
    closePoint(s.at, world([0, 4.8], [60, 30], 30));
    const write = onlyWrite(d.drag(s.at, world([0, 9.2], [60, 30], 30)));
    const shape = shapeOp(write.ops);
    if (shape.type !== "rect") throw new Error("not a rect");
    expect(shape.width).toBeCloseTo(6.6, 9);
    expect(shape.height).toBeCloseTo(14, 9);
    const [name, contents] = faceOp(write.ops).elements as [FaceElement, FaceElement];
    closeRect(name.rect, [-3.1, -7 + 0.2 * fy, 6.2, 0.8 * fy]);
    closeRect(contents.rect, [-3.1, -7 + 1.2 * fy, 6.2, 8 * fy]);
  });

  test("a circle's radius handle scales both axes by r'/r", () => {
    const d = driver({ selection: ["cf"] });
    const write = onlyWrite(d.drag(handleOf("cf", "radius").at, [82, 0]));
    expect(write.ops).toEqual([
      { type: "set_shape", object: "cf", shape: circle(2) },
      {
        type: "set_face",
        object: "cf",
        face: { elements: [{ type: "value", cell: "name", rect: [-1.6, -0.6, 3.2, 1.2] }] },
      },
    ]);
  });

  test("a polygon vertex drag that moves the bounding box's origin: elements follow the box", () => {
    const d = driver({ selection: ["pf"] });
    // v0 (-1, -1) → (-3, -2): the box goes from [-1, -1, 2, 2] to [-3, -2, 4, 3].
    const write = onlyWrite(d.drag(handleOf("pf", "v0").at, [77, 18]));
    expect(write.ops.map((o) => o.type)).toEqual(["set_shape", "set_face"]);
    const [name, depth] = faceOp(write.ops).elements as [FaceElement, FaceElement];
    closeRect(name.rect, [-3, -2, 4, 0.75]);
    closeRect(depth.rect, [-1, -0.5, 2, 1.5]);
  });

  test("a vertex drag that keeps the bounding box writes no set_face", () => {
    const d = driver({ selection: ["pf"] });
    // v1 (1, -1) → (0.5, -0.5): v2 and v0 still span [-1, 1] × [-1, 1].
    const write = onlyWrite(d.drag(handleOf("pf", "v1").at, [80.5, 19.5]));
    expect(write.ops.map((o) => o.type)).toEqual(["set_shape"]);
  });

  test("rotating an object with a face writes no set_face", () => {
    const d = driver({ selection: ["b"] });
    const write = onlyWrite(d.drag(handleOf("b", "rotate").at, world([0, -6], [60, 0], 40)));
    expect(write.ops.map((o) => o.type)).toEqual(["set_value"]);
  });

  test("an object without a face is unaffected", () => {
    const write = onlyWrite(driver({ selection: ["u"] }).drag([7, -3], [8, -2]));
    expect(write.ops.map((o) => o.type)).toEqual(["set_shape", "set_value"]);
  });

  test("a second resize before the first is visible scales from the pending face", () => {
    const d = driver({ selection: ["b"] });
    const first = faceOp(onlyWrite(d.drag([60, 4.8], [60, 9.2])).ops);
    // The s edge is pending at y 9.2; back to 9.6 high.
    const second = faceOp(onlyWrite(d.drag([60, 9.2], [60, 4.8])).ops);
    expect(first.elements[1]?.rect[3]).toBeCloseTo(8 * fy, 9);
    closeRect((second.elements[1] as FaceElement).rect, [-3.1, -3.6, 6.2, 8]);
  });

  test("with Snap the handle snaps before the factors are computed", () => {
    const d = driver({ selection: ["b"], snap: true });
    // The s edge snaps to y 9 (from 9.2): 6.6 × 13.8.
    const write = onlyWrite(d.drag([60, 4.8], [60, 9.2]));
    expect(shapeOp(write.ops)).toEqual(rect(6.6, 13.8));
    const contents = faceOp(write.ops).elements[1] as FaceElement;
    expect(contents.rect[3]).toBeCloseTo((8 * 13.8) / 9.6, 9);
  });
});
