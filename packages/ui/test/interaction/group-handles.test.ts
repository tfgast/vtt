// @vitest-environment node
/**
 * Group handles (vtt-qf5.15; DESIGN.md §4.6, §8.1; M6-D36): for two or more
 * selected board objects, `withHandles(selectTool)` shows corner scale
 * handles and a rotate handle on the selection's axis-aligned box; a rotate
 * or a scale about the box's centre is one write with every object's ops.
 */
import type { CellView, ObjectView, Viewer, WireOp, WireResult, WireValue } from "@vtt/protocol";
import type { FaceLayout, ObjectId, Point, Shape } from "@vtt/schema";
import {
  buildScene,
  type Camera,
  type DrawItem,
  dragGroup,
  type Effect,
  groupBounds,
  groupHandlesFor,
  HANDLE_MIN_SIZE,
  type Handle,
  type InteractionEvent,
  type Modifiers,
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

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const HERO: Viewer = { type: "character", id: "hero" };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const SHIFT: Modifiers = { ...NO_MODS, shift: true };
const PX = 64;

const num = (value: number): WireValue => ({ type: "number", value });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

function obj(
  id: string,
  at: Point,
  z: number,
  shape: Shape | null,
  extra: { rotation?: number; face?: FaceLayout } = {},
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
    name: { type: "text", value: id },
  };
  const cells: Record<string, CellView> = {};
  for (const [name, value] of Object.entries(values)) cells[name] = { value, kind: "literal" };
  const view: ObjectView = { id, is_template: false, is_character: false, cells, actions: [] };
  if (extra.face) {
    view.face = {
      elements: extra.face.elements.map((e, index) => ({ ...e, index, shown: true })),
    } as ObjectView["face"];
  }
  return view;
}

/** A box x -4..4, y -1..4 around three objects; its centre, the pivot, is (0, 1.5). */
const VIEWS: ObjectView[] = [
  obj("a", [-3, 0], 1, rect(2, 2)),
  obj("b", [3, 0], 2, { type: "circle", radius: 1 }),
  obj("c", [0, 3], 3, rect(2, 2), {
    face: { elements: [{ type: "value", cell: "name", rect: [-1, -1, 2, 1] }] },
  }),
  obj("far", [40, 40], 4, rect(1, 1)),
];
const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));
const SCENE: Scene = buildScene({ views: VIEWS, covers: [], board: BOARD, viewer: GM });
const THREE: ObjectId[] = ["a", "b", "c"];
const PIVOT: Point = [0, 1.5];

const item = (id: ObjectId): DrawItem => SCENE.items.find((i) => i.id === id) as DrawItem;
const targets = (ids: ObjectId[]) => ids.map(item);
const screenOf = (board: Point): Point => toScreen(CAMERA, board, VIEWPORT);

function groupHandle(key: string): Handle {
  const h = groupHandlesFor(targets(THREE), CAMERA, VIEWPORT).find((x) => x.key === key);
  if (h === undefined) throw new Error(`no group handle ${key}`);
  return h;
}

let seq = 0;
function makeInput(over: Partial<ToolInput>): ToolInput {
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
    interactionId: `g${seq}`,
  };
}

function pointer(
  type: "pointer_down" | "pointer_move" | "pointer_up",
  board: Point,
  modifiers: Modifiers = NO_MODS,
): InteractionEvent {
  return {
    type,
    pointerId: 1,
    screen: screenOf(board),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" ? 0 : 1,
    modifiers,
  };
}

function driver(selection: ObjectId[], viewer: Viewer = GM) {
  const tool = withHandles(selectTool);
  let state: ToolState = tool.init({});
  return {
    get cursor() {
      return tool.cursor(state as never);
    },
    send(event: InteractionEvent): Effect[] {
      const out = tool.reduce(state as never, event, makeInput({ selection, viewer }));
      state = out.state as ToolState;
      return out.effects;
    },
    cancel(): Effect[] {
      const out = tool.cancel(state as never, "escape");
      state = out.state as ToolState;
      return out.effects;
    },
    drag(from: Point, to: Point, mods: Modifiers = NO_MODS): Effect[] {
      const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      return [
        ...this.send(pointer("pointer_down", from)),
        ...this.send(pointer("pointer_move", mid, mods)),
        ...this.send(pointer("pointer_move", to, mods)),
        ...this.send(pointer("pointer_up", to, mods)),
      ];
    },
  };
}

const of = <T extends Effect["type"]>(effects: Effect[], type: T) =>
  effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);

function lastHandles(effects: Effect[]) {
  const all = of(effects, "overlays");
  return all
    .at(-1)
    ?.overlays.find((o): o is Extract<ToolOverlay, { kind: "handles" }> => o.kind === "handles");
}

function opsOf(ops: WireOp[], object: ObjectId): WireOp[] {
  return ops.filter((o) => "object" in o && o.object === object);
}

function position(ops: WireOp[], object: ObjectId): Point {
  const op = opsOf(ops, object).find((o) => o.type === "set_value" && o.cell === "position");
  if (op?.type !== "set_value" || op.value.type !== "list")
    throw new Error(`no position ${object}`);
  const [x, y] = op.value.items as { type: "number"; value: number }[];
  return [x?.value as number, y?.value as number];
}

function rotation(ops: WireOp[], object: ObjectId): number | undefined {
  const op = opsOf(ops, object).find((o) => o.type === "set_value" && o.cell === "rotation");
  return op?.type === "set_value" && op.value.type === "number" ? op.value.value : undefined;
}

function shape(ops: WireOp[], object: ObjectId): Shape | null | undefined {
  const op = opsOf(ops, object).find((o) => o.type === "set_shape");
  return op?.type === "set_shape" ? op.shape : undefined;
}

const close = (a: Point, b: Point) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

describe("group handle geometry", () => {
  test("the box bounds every footprint; four corners and a rotate handle above its top middle", () => {
    expect(groupBounds(targets(THREE))).toEqual({ minX: -4, minY: -1, maxX: 4, maxY: 4 });
    const handles = groupHandlesFor(targets(THREE), CAMERA, VIEWPORT);
    expect(handles.map((h) => [h.key, h.role, h.at])).toEqual([
      ["nw", "resize", [-4, -1]],
      ["ne", "resize", [4, -1]],
      ["se", "resize", [4, 4]],
      ["sw", "resize", [-4, 4]],
      ["rotate", "rotate", [0, -1 - ROTATE_HANDLE_PX / PX]],
    ]);
    expect(handles.at(-1)?.from).toEqual([0, -1]);
    expect(handles.every((h) => h.object === "a")).toBe(true);
  });

  test("a rotated object contributes its rotated footprint", () => {
    const tilted = { ...item("a"), rotation: 45 };
    const half = Math.SQRT2;
    const box = groupBounds([tilted, item("b")]);
    expect(box.minX).toBeCloseTo(-3 - half, 9);
    expect(box.minY).toBeCloseTo(-half, 9);
  });

  test("one object, or none, gets no group handles", () => {
    expect(groupHandlesFor(targets(["a"]), CAMERA, VIEWPORT)).toEqual([]);
    expect(groupHandlesFor([], CAMERA, VIEWPORT)).toEqual([]);
  });

  test("a quarter turn orbits each anchor about the pivot and adds 90° to its rotation", () => {
    const h = groupHandle("rotate");
    const r = PIVOT[1] - h.at[1];
    const previews = dragGroup(targets(THREE), h, h.at, [PIVOT[0] + r, PIVOT[1]], false);
    close(previews.get("a")?.position as Point, [1.5, -1.5]);
    close(previews.get("b")?.position as Point, [1.5, 4.5]);
    close(previews.get("c")?.position as Point, [-1.5, 1.5]);
    expect([...previews.values()].map((p) => p.rotation)).toEqual([90, 90, 90]);
  });

  test("Shift snaps the group turn to 15°", () => {
    const h = groupHandle("rotate");
    const r = PIVOT[1] - h.at[1];
    const a = (32 * Math.PI) / 180; // 32° clockwise from straight up
    const to: Point = [PIVOT[0] + r * Math.sin(a), PIVOT[1] - r * Math.cos(a)];
    expect(dragGroup(targets(THREE), h, h.at, to, true).get("a")?.rotation).toBe(30);
    expect(dragGroup(targets(THREE), h, h.at, to, false).get("a")?.rotation).toBeCloseTo(32, 6);
  });

  test("a corner drag scales shapes and anchor offsets from the pivot uniformly", () => {
    const h = groupHandle("se");
    // The se corner (4, 4) is (4, 2.5) from the pivot; dragging it to (8, 6.5) doubles it.
    const previews = dragGroup(targets(THREE), h, h.at, [8, 6.5], false);
    expect(previews.get("a")).toEqual({ position: [-6, -1.5], shape: rect(4, 4) });
    expect(previews.get("b")).toEqual({
      position: [6, -1.5],
      shape: { type: "circle", radius: 2 },
    });
    expect(previews.get("c")).toEqual({ position: [0, 4.5], shape: rect(4, 4) });
  });

  test("a scale is floored so the smallest object keeps HANDLE_MIN_SIZE", () => {
    const h = groupHandle("se");
    const previews = dragGroup(targets(THREE), h, h.at, PIVOT, false);
    // The circle (radius 1) is the smallest size: the factor stops at HANDLE_MIN_SIZE / 1.
    expect(previews.get("b")?.shape).toEqual({ type: "circle", radius: HANDLE_MIN_SIZE });
    expect(previews.get("a")?.shape).toEqual(rect(2 * HANDLE_MIN_SIZE, 2 * HANDLE_MIN_SIZE));
  });
});

describe("withHandles(selectTool) with a multi-selection", () => {
  test("shows the group handles for two or more board objects, none for players", () => {
    const d = driver(THREE);
    const shown = lastHandles(d.send(pointer("pointer_move", [20, 20])));
    expect(shown?.handles.map((m) => m.key)).toEqual(["nw", "ne", "se", "sw", "rotate"]);
    const hero = driver(THREE, HERO);
    expect(lastHandles(hero.send(pointer("pointer_move", [20, 20])))).toBeUndefined();
  });

  test("a group rotate writes one transact with every selected object's position and rotation", () => {
    const d = driver(THREE);
    d.send(pointer("pointer_move", [20, 20]));
    const h = groupHandle("rotate");
    const r = PIVOT[1] - h.at[1];
    const effects = d.drag(h.at, [PIVOT[0] + r, PIVOT[1]]);
    const writes = of(effects, "write");
    expect(writes).toHaveLength(1);
    const write = writes[0] as Extract<Effect, { type: "write" }>;
    expect(write.label).toBe("Rotate 3 objects");
    expect(write.ops).toHaveLength(6);
    for (const id of THREE) {
      expect(opsOf(write.ops, id).map((o) => o.type)).toEqual(["set_value", "set_value"]);
      expect(rotation(write.ops, id)).toBe(90);
    }
    close(position(write.ops, "a"), [1.5, -1.5]);
    expect(opsOf(write.ops, "far")).toEqual([]);
    expect(write.stamp.baseRevision).toBe(7);
    // The previews are held by the write's stamp.
    const held = of(effects, "previews").at(-1);
    expect(held?.hold?.stamp).toEqual(write.stamp);
    expect([...(held?.previews.keys() ?? [])].sort()).toEqual(["a", "b", "c"]);
  });

  test("a group scale writes one transact; the faced object's face is scaled too (M6-D14)", () => {
    const d = driver(THREE);
    d.send(pointer("pointer_move", [20, 20]));
    const write = of(d.drag([4, 4], [8, 6.5]), "write");
    expect(write).toHaveLength(1);
    const { ops, label } = write[0] as Extract<Effect, { type: "write" }>;
    expect(label).toBe("Resize 3 objects");
    expect(shape(ops, "a")).toEqual(rect(4, 4));
    expect(shape(ops, "b")).toEqual({ type: "circle", radius: 2 });
    close(position(ops, "c"), [0, 4.5]);
    expect(opsOf(ops, "c").find((o) => o.type === "set_face")).toEqual({
      type: "set_face",
      object: "c",
      face: { elements: [{ type: "value", cell: "name", rect: [-2, -2, 4, 2] }] },
    });
    expect(opsOf(ops, "a").some((o) => o.type === "set_face")).toBe(false);
  });

  test("a press and release without moving, or Escape mid-drag, writes nothing", () => {
    const d = driver(THREE);
    d.send(pointer("pointer_move", [20, 20]));
    expect(of(d.drag([4, 4], [4, 4]), "write")).toEqual([]);
    d.send(pointer("pointer_down", [4, 4]));
    d.send(pointer("pointer_move", [6, 6]));
    const cancelled = d.cancel();
    expect(of(cancelled, "write")).toEqual([]);
    expect(lastHandles(cancelled)?.handles.map((m) => m.key)).toEqual([
      "nw",
      "ne",
      "se",
      "sw",
      "rotate",
    ]);
  });

  test("one selected object keeps its own handles", () => {
    const d = driver(["a"]);
    const shown = lastHandles(d.send(pointer("pointer_move", [20, 20])));
    expect(shown?.handles.map((m) => m.key)).toEqual([
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
  });

  test("a selection with one object on the board shows no group handles", () => {
    const d = driver(["a", "elsewhere"]);
    expect(lastHandles(d.send(pointer("pointer_move", [20, 20])))).toBeUndefined();
  });

  test("the cursor over a corner is a resize cursor, over the rotate handle grab", () => {
    const d = driver(THREE);
    d.send(pointer("pointer_move", [20, 20]));
    d.send(pointer("pointer_move", [4, 4]));
    expect(d.cursor).toBe("nwse-resize");
    const h = groupHandle("rotate");
    d.send(pointer("pointer_move", h.at));
    expect(d.cursor).toBe("grab");
    d.send(pointer("pointer_down", h.at));
    d.send(pointer("pointer_move", [3, 0], SHIFT));
    expect(d.cursor).toBe("grabbing");
  });
});
