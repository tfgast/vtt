// @vitest-environment node
/**
 * The select tool's reducer (vtt-3l6.7) on a fixed scene: selection, Alt+click
 * cycling and its hover target, marquee, drags (move, spawn, containment),
 * cancellation and the M5 `dropOverride` hook.
 */
import type { CellView, ObjectView, Viewer, WireOp, WireResult, WireValue } from "@vtt/protocol";
import type { ObjectId, Point, Shape } from "@vtt/schema";
import {
  buildScene,
  type Camera,
  type CancelReason,
  createSelectTool,
  type DropOverride,
  type Effect,
  type InteractionEvent,
  type Modifiers,
  type ReducerInput,
  type Scene,
  SELECT_DRAG_THRESHOLD_PX,
  type SelectToolOptions,
  selectTool,
  type ToolInput,
  type ToolState,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// The fixed scene

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const ALT: Modifiers = { ...NO_MODS, alt: true };
const SHIFT: Modifiers = { ...NO_MODS, shift: true };

const num = (value: number): WireValue => ({ type: "number", value });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });

function obj(
  id: string,
  at: Point,
  z: number,
  shape: Shape | null,
  extra: { zone?: boolean; image?: string; name?: string; template?: boolean } = {},
): ObjectView {
  const values: Record<string, WireResult> = {
    board: { type: "ref", object: BOARD },
    container: { type: "empty" },
    position: { type: "list", items: [num(at[0]), num(at[1])] },
    rotation: num(0),
    z: num(z),
    shape: shape ? { type: "shape", shape } : { type: "empty" },
    is_zone: { type: "boolean", value: extra.zone ?? false },
    face_up: { type: "boolean", value: true },
  };
  if (extra.image) values.image = { type: "text", value: extra.image };
  if (extra.name) values.name = { type: "text", value: extra.name };
  const cells: Record<string, CellView> = {};
  for (const [name, value] of Object.entries(values)) cells[name] = { value, kind: "literal" };
  return {
    id,
    is_template: extra.template ?? false,
    is_character: false,
    cells,
    actions: [],
  };
}

// A token over a map image over a room zone at (1, 1); a die elsewhere on the map;
// two templates outside the map.
const VIEWS: ObjectView[] = [
  obj("room", [0, 0], 10, rect(10, 10), { zone: true, name: "Room" }),
  obj("map", [0, 0], 1, rect(6, 6), { image: "t.assets/map.png", name: "Map" }),
  obj("tok", [1, 1], 5, circle(0.5), { name: "Goblin" }),
  obj("die", [2, -2], 6, circle(0.25), { name: "d6" }),
  obj("tpl", [-8, -8], 2, circle(0.5), { name: "Orc", template: true }),
  obj("tpl2", [-8, 8], 2, circle(0.5), { name: "Elf", template: true }),
];
const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));
const SCENE: Scene = buildScene({ views: VIEWS, covers: [], board: BOARD, viewer: GM });

const EMPTY: Point = [20, 20];

// ---------------------------------------------------------------------------
// Driving the reducer

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

const screenOf = (board: Point): Point => toScreen(CAMERA, board, VIEWPORT);

type PointerType = "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel";

function pointer(
  type: PointerType,
  board: Point,
  modifiers: Modifiers = NO_MODS,
  over: { pointerId?: number; button?: number; buttons?: number } = {},
): InteractionEvent {
  return {
    type,
    pointerId: over.pointerId ?? 1,
    screen: screenOf(board),
    board,
    button: over.button ?? (type === "pointer_move" ? -1 : 0),
    buttons: over.buttons ?? (type === "pointer_down" || type === "pointer_move" ? 1 : 0),
    modifiers,
  };
}

/** A pointer at a screen offset (px) from a board point. */
function offset(board: Point, px: number): Point {
  return [board[0] + px / 64, board[1]];
}

/** Drives one tool: keeps its state and a selection that follows `select` effects. */
function driver(options?: SelectToolOptions) {
  const tool = options === undefined ? selectTool : createSelectTool(options);
  let state: ToolState = tool.init({});
  let selection: ObjectId[] = [];
  let revision = 7;
  const apply = (effects: Effect[]) => {
    for (const e of effects) if (e.type === "select") selection = [...e.ids];
    return effects;
  };
  return {
    tool,
    get selection() {
      return selection;
    },
    set selection(ids: ObjectId[]) {
      selection = ids;
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
        makeInput({ selection: [...selection], revision, ...over }),
      );
      state = out.state as ToolState;
      return apply(out.effects);
    },
    cancel(reason: CancelReason): Effect[] {
      const out = tool.cancel(state as never, reason);
      state = out.state as ToolState;
      return apply(out.effects);
    },
    click(board: Point, modifiers: Modifiers = NO_MODS): Effect[] {
      return [
        ...this.send(pointer("pointer_down", board, modifiers)),
        ...this.send(pointer("pointer_up", board, modifiers)),
      ];
    },
    /** Down at `from`, moves to `to` (in two steps), up at `to`; modifiers per phase. */
    drag(
      from: Point,
      to: Point,
      mods: { down?: Modifiers; move?: Modifiers; up?: Modifiers } = {},
    ): Effect[] {
      const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      return [
        ...this.send(pointer("pointer_down", from, mods.down ?? NO_MODS)),
        ...this.send(pointer("pointer_move", mid, mods.move ?? mods.down ?? NO_MODS)),
        ...this.send(pointer("pointer_move", to, mods.move ?? mods.down ?? NO_MODS)),
        ...this.send(pointer("pointer_up", to, mods.up ?? mods.move ?? mods.down ?? NO_MODS)),
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

const boardMove = (object: string, position: Point): WireOp => ({
  type: "move",
  object,
  to: { type: "board", board: BOARD, position },
});

function closePoint(actual: unknown, expected: Point) {
  const p = actual as Point;
  expect(p[0]).toBeCloseTo(expected[0], 9);
  expect(p[1]).toBeCloseTo(expected[1], 9);
}

// ---------------------------------------------------------------------------

describe("select tool basics", () => {
  test("is registered under id select, starts idle with a default cursor", () => {
    expect(selectTool.id).toBe("select");
    const state = selectTool.init({});
    expect(state.tool).toBe("select");
    expect(selectTool.cursor(state)).toBe("default");
    expect(SELECT_DRAG_THRESHOLD_PX).toBe(4);
  });
});

describe("selection", () => {
  test("a click selects the first entry of hitsAt", () => {
    const d = driver();
    const effects = d.click([1, 1]);
    expect(of(effects, "select")).toEqual([{ type: "select", ids: ["tok"] }]);
    expect(of(effects, "write")).toEqual([]);
  });

  test("Shift+click toggles the hit in the selection", () => {
    const d = driver();
    d.click([1, 1]);
    d.click([2, -2], SHIFT);
    expect(d.selection).toEqual(["tok", "die"]);
    d.click([1, 1], SHIFT);
    expect(d.selection).toEqual(["die"]);
  });

  test("a click on empty clears the selection", () => {
    const d = driver();
    d.click([1, 1]);
    const effects = d.click(EMPTY);
    expect(of(effects, "select")).toEqual([{ type: "select", ids: [] }]);
    expect(d.selection).toEqual([]);
  });

  test("a click on a selected object among several selects only it", () => {
    const d = driver();
    d.selection = ["tok", "die"];
    d.click([1, 1]);
    expect(d.selection).toEqual(["tok"]);
  });

  test("double-click on an object opens the editor with a stamp", () => {
    const d = driver();
    const s = screenOf([1, 1]);
    const effects = d.send({ type: "double_click", screen: s, board: [1, 1], modifiers: NO_MODS });
    expect(effects).toEqual([
      {
        type: "open_editor",
        stamp: expect.objectContaining({ board: BOARD, viewer: GM, baseRevision: 7 }),
        object: "tok",
      },
    ]);
    expect(
      d.send({ type: "double_click", screen: screenOf(EMPTY), board: EMPTY, modifiers: NO_MODS }),
    ).toEqual([]);
  });
});

describe("Alt+click cycling", () => {
  test("cycles token, map image, zone and wraps at one point", () => {
    const d = driver();
    const picks: ObjectId[][] = [];
    for (let i = 0; i < 4; i++) {
      d.click([1, 1], ALT);
      picks.push([...d.selection]);
    }
    expect(picks).toEqual([["tok"], ["map"], ["room"], ["tok"]]);
  });

  test("repeated clicks within 4 px still cycle", () => {
    const d = driver();
    d.click([1, 1], ALT);
    d.click(offset([1, 1], 3), ALT);
    expect(d.selection).toEqual(["map"]);
  });

  test("the cycle resets when the point moves", () => {
    const d = driver();
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    expect(d.selection).toEqual(["map"]);
    // Somewhere else on the token: more than 4 px away.
    d.click(offset([1, 1], 20), ALT);
    expect(d.selection).toEqual(["tok"]);
  });

  test("the cycle resets when the hit list changes", () => {
    const d = driver();
    d.click([1, 1], ALT);
    expect(d.selection).toEqual(["tok"]);
    // The token is gone from the scene: the hits at the point are now map, room.
    const without = buildScene({
      views: VIEWS.filter((v) => v.id !== "tok"),
      covers: [],
      board: BOARD,
      viewer: GM,
    });
    d.send(pointer("pointer_down", [1, 1], ALT), { scene: without });
    d.send(pointer("pointer_up", [1, 1], ALT), { scene: without });
    expect(d.selection).toEqual(["map"]);
  });

  test("a plain click resets the cycle", () => {
    const d = driver();
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    d.click([1, 1]);
    d.click([1, 1], ALT);
    expect(d.selection).toEqual(["tok"]);
  });

  test("the cycled zone stays the hover target until the pointer leaves it", () => {
    const d = driver();
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    const effects = d.click([1, 1], ALT);
    expect(d.selection).toEqual(["room"]);
    expect(of(effects, "hover")).toEqual([{ type: "hover", id: "room", zone: "room" }]);
    // Hovering over the token and the map, still inside the room: the room stays.
    const over = (p: Point) => d.send(pointer("pointer_move", p, NO_MODS, { buttons: 0 }));
    const hovers: Effect[] = [...over([1.1, 1]), ...over([2, 2]), ...over([2, -2])];
    expect(of(hovers, "hover").every((h) => h.id === "room" && h.zone === "room")).toBe(true);
    // Leaving the room's footprint: back to the first hit (none here).
    expect(of(over([30, 30]), "hover")).toEqual([{ type: "hover", id: null, zone: null }]);
    // Back over the token: the first hit again, not a zone.
    expect(of(over([1, 1]), "hover")).toEqual([{ type: "hover", id: "tok", zone: null }]);
  });
});

describe("hover lock across gestures", () => {
  test("leaving the locked target during a drag releases the lock; after a cancel the first hit is hovered", () => {
    const d = driver();
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    expect(d.selection).toEqual(["room"]);
    // Drag the selected room out of its own footprint, then cancel.
    d.send(pointer("pointer_down", [1, 1]));
    d.send(pointer("pointer_move", [30, 30]));
    d.cancel("escape");
    // Back over the map (inside the room): the map is hovered, not the room.
    const back = d.send(pointer("pointer_move", [2, 2], NO_MODS, { buttons: 0 }));
    expect(of(back, "hover")).toEqual([{ type: "hover", id: "map", zone: null }]);
  });

  test("staying inside the locked target during a drag keeps the lock", () => {
    const d = driver();
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    d.send(pointer("pointer_down", [1, 1]));
    d.send(pointer("pointer_move", [2, 2]));
    d.cancel("escape");
    const back = d.send(pointer("pointer_move", [2.1, 2], NO_MODS, { buttons: 0 }));
    expect(of(back, "hover")).toEqual([]);
    expect((d.state.phase as { hoverLock: string | null }).hoverLock).toBe("room");
  });

  test("a drop recomputes the hover at the drop point", () => {
    const d = driver();
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    d.click([1, 1], ALT);
    const effects = d.drag([1, 1], [30, 30]);
    expect(of(effects, "hover")).toEqual([{ type: "hover", id: null, zone: null }]);
  });
});

describe("hover", () => {
  test("hover is the first hit, with zone set only when it is a zone", () => {
    const d = driver();
    const over = (p: Point) => d.send(pointer("pointer_move", p, NO_MODS, { buttons: 0 }));
    expect(of(over([1, 1]), "hover")).toEqual([{ type: "hover", id: "tok", zone: null }]);
    expect(of(over([4, 4]), "hover")).toEqual([{ type: "hover", id: "room", zone: "room" }]);
    // Unchanged hover emits nothing.
    expect(of(over([4.1, 4]), "hover")).toEqual([]);
    expect(of(over(EMPTY), "hover")).toEqual([{ type: "hover", id: null, zone: null }]);
  });
});

describe("marquee", () => {
  test("a drag on empty beyond the threshold draws a marquee overlay", () => {
    const d = driver();
    d.send(pointer("pointer_down", [6, -6]));
    const moved = d.send(pointer("pointer_move", [0.4, 1.6]));
    expect(of(moved, "overlays")).toEqual([
      {
        type: "overlays",
        overlays: [{ kind: "marquee", rect: { minX: 0.4, minY: -6, maxX: 6, maxY: 1.6 } }],
      },
    ]);
    expect(d.tool.cursor(d.state as never)).toBe("crosshair");
    expect(of(d.cancel("escape"), "overlays")).toEqual([{ type: "overlays", overlays: [] }]);
  });

  test("a marquee from empty space selects the objects whose bounds lie inside", () => {
    const d = driver();
    // Start outside the room (-5..5), sweeping across the token and the die only.
    d.send(pointer("pointer_down", [6, -6]));
    d.send(pointer("pointer_move", [0.4, 1.6]));
    const up = d.send(pointer("pointer_up", [0.4, 1.6]));
    // Bounds inside x 0.4..6, y -6..1.6: tok (0.5..1.5) and die (1.75..2.25).
    expect(d.selection.sort()).toEqual(["die", "tok"]);
    expect(of(up, "overlays")).toEqual([{ type: "overlays", overlays: [] }]);
    expect(of(up, "write")).toEqual([]);
  });

  test("Shift+marquee adds to the selection", () => {
    const d = driver();
    d.selection = ["tpl"];
    d.send(pointer("pointer_down", [6, -6], SHIFT));
    d.send(pointer("pointer_move", [0.4, 1.6], SHIFT));
    d.send(pointer("pointer_up", [0.4, 1.6], SHIFT));
    expect([...d.selection].sort()).toEqual(["die", "tok", "tpl"]);
  });
});

describe("dragging", () => {
  test("a drag beyond the threshold shows a ghost and previews and writes N moves on drop", () => {
    const d = driver();
    d.selection = ["tok", "die"];
    d.send(pointer("pointer_down", [1, 1]));
    // input.revision advances during the drag.
    d.revision = 9;
    const moved = d.send(pointer("pointer_move", [2, 3]));
    const previews = of(moved, "previews");
    expect(previews).toHaveLength(1);
    const p = previews[0]?.previews;
    closePoint(p?.get("tok")?.position, [2, 3]);
    closePoint(p?.get("die")?.position, [3, 0]);
    const ghosts = of(moved, "overlays")[0]?.overlays ?? [];
    expect(ghosts).toHaveLength(1);
    const ghost = ghosts[0];
    if (ghost?.kind !== "drag_ghost") throw new Error("no ghost");
    expect(ghost.items.map((i) => i.id).sort()).toEqual(["die", "tok"]);
    expect(ghost.items.find((i) => i.id === "tok")?.shape).toEqual(circle(0.5));
    expect(d.tool.cursor(d.state as never)).toBe("grabbing");

    d.revision = 11;
    const up = d.send(pointer("pointer_up", [2, 3]));
    const write = onlyWrite(up);
    expect(write.stamp).toMatchObject({ board: BOARD, viewer: GM, baseRevision: 7 });
    expect(write.label).toBe("Move 2 objects");
    // Back to front: the token (z 5) before the die (z 6), so the landing rule keeps their order.
    expect(write.ops.map((o) => (o.type === "move" ? o.object : null))).toEqual(["tok", "die"]);
    const tokOp = write.ops[0];
    const dieOp = write.ops[1];
    if (tokOp?.type !== "move" || dieOp?.type !== "move") throw new Error("not moves");
    expect(tokOp.to).toMatchObject({ type: "board", board: BOARD });
    if (tokOp.to.type !== "board" || dieOp.to.type !== "board") throw new Error("not board");
    closePoint(tokOp.to.position, [2, 3]);
    closePoint(dieOp.to.position, [3, 0]);
    expect(write.continuations).toEqual([]);
    // The previews are held by the write's stamp.
    const held = of(up, "previews");
    expect(held).toHaveLength(1);
    expect(held[0]?.hold).toEqual({ stamp: write.stamp });
    closePoint(held[0]?.previews.get("tok")?.position, [2, 3]);
    expect(of(up, "overlays")).toEqual([{ type: "overlays", overlays: [] }]);
    expect(d.tool.cursor(d.state as never)).toBe("default");
  });

  test("dragging an unselected object selects and moves only it, labelled with its name", () => {
    const d = driver();
    d.selection = ["die"];
    const effects = d.drag([1, 1], [1, 3]);
    expect(of(effects, "select")).toEqual([{ type: "select", ids: ["tok"] }]);
    const write = onlyWrite(effects);
    expect(write.label).toBe("Move Goblin");
    expect(write.ops).toHaveLength(1);
    const op = write.ops[0];
    if (op?.type !== "move" || op.to.type !== "board") throw new Error("not a board move");
    expect(op.object).toBe("tok");
    closePoint(op.to.position, [1, 3]);
  });

  test("a drag under 4 px writes nothing and acts as a click", () => {
    const d = driver();
    d.selection = ["tok", "die"];
    const from: Point = [1, 1];
    const to = offset(from, 3);
    const effects = [
      ...d.send(pointer("pointer_down", from)),
      ...d.send(pointer("pointer_move", to)),
      ...d.send(pointer("pointer_up", to)),
    ];
    expect(of(effects, "write")).toEqual([]);
    expect(of(effects, "previews")).toEqual([]);
    expect(d.selection).toEqual(["tok"]);
  });

  test("cancel during a drag emits no write and clears previews and overlays", () => {
    for (const reason of ["escape", "board_change", "viewer_change", "tool_switch"] as const) {
      const d = driver();
      d.send(pointer("pointer_down", [1, 1]));
      d.send(pointer("pointer_move", [3, 3]));
      const cancelled = d.cancel(reason);
      expect(of(cancelled, "write")).toEqual([]);
      expect(of(cancelled, "previews")).toEqual([{ type: "previews", previews: new Map() }]);
      expect(of(cancelled, "overlays")).toEqual([{ type: "overlays", overlays: [] }]);
      // Escape during a drag does not clear the selection.
      expect(of(cancelled, "select")).toEqual([]);
      // The pointer up after the cancel writes nothing.
      expect(of(d.send(pointer("pointer_up", [3, 3])), "write")).toEqual([]);
    }
  });

  test("pointer_cancel during a drag writes nothing", () => {
    const d = driver();
    d.send(pointer("pointer_down", [1, 1]));
    d.send(pointer("pointer_move", [3, 3]));
    const effects = d.send(pointer("pointer_cancel", [3, 3]));
    expect(of(effects, "write")).toEqual([]);
    expect(of(effects, "previews")).toEqual([{ type: "previews", previews: new Map() }]);
  });

  test("Escape with no gesture clears the selection", () => {
    const d = driver();
    d.selection = ["tok"];
    expect(of(d.cancel("escape"), "select")).toEqual([{ type: "select", ids: [] }]);
    d.selection = ["tok"];
    expect(of(d.cancel("tool_switch"), "select")).toEqual([]);
  });

  test("dragging a selected zone that lies under other objects moves the selection", () => {
    const d = driver();
    d.selection = ["room"];
    const write = onlyWrite(d.drag([1, 1], [2, 1]));
    expect(write.label).toBe("Move Room");
    expect(write.ops.map((o) => (o.type === "move" ? o.object : null))).toEqual(["room"]);
  });

  test("objects of the selection not drawn on the active board are not dragged", () => {
    const d = driver();
    d.selection = ["tok", "elsewhere"];
    const write = onlyWrite(d.drag([1, 1], [2, 1]));
    expect(write.ops.map((o) => (o.type === "move" ? o.object : null))).toEqual(["tok"]);
  });
});

describe("containment", () => {
  test("Alt held at the drop over another non-zone object puts the dragged objects into it", () => {
    const d = driver();
    const write = onlyWrite(d.drag([2, -2], [1, 1], { down: NO_MODS, up: ALT }));
    expect(write.ops).toEqual([
      { type: "move", object: "die", to: { type: "container", container: "tok" } },
    ]);
    expect(write.label).toBe("Put d6 into Goblin");
    expect(write.stamp.baseRevision).toBe(7);
  });

  test("several objects into a container: one move each, appending", () => {
    const d = driver();
    d.selection = ["die", "tpl"];
    const write = onlyWrite(d.drag([2, -2], [1, 1], { up: ALT }));
    expect(write.ops).toEqual([
      { type: "move", object: "tpl", to: { type: "container", container: "tok" } },
      { type: "move", object: "die", to: { type: "container", container: "tok" } },
    ]);
    expect(write.label).toBe("Put 2 objects into Goblin");
  });

  test("a plain drop over an object stacks on the board", () => {
    const d = driver();
    const write = onlyWrite(d.drag([2, -2], [1, 1]));
    const op = write.ops[0];
    if (op?.type !== "move" || op.to.type !== "board") throw new Error("not a board move");
    closePoint(op.to.position, [1, 1]);
  });

  test("Alt at the drop over a zone only places on the board", () => {
    const d = driver();
    // (4, 4): inside the room, outside the map.
    const write = onlyWrite(d.drag([2, -2], [4, 4], { up: ALT }));
    expect(write.ops[0]).toMatchObject({ type: "move", object: "die", to: { type: "board" } });
  });

  test("a dragged object is never its own container target", () => {
    const d = driver();
    // At (1.2, 1) the token (dragged) is the first hit; the next is the map image.
    const write = onlyWrite(d.drag([1, 1], [1.2, 1], { up: ALT }));
    expect(write.ops[0]).toEqual({
      type: "move",
      object: "tok",
      to: { type: "container", container: "map" },
    });
  });
});

describe("template drags", () => {
  test("one template dragged without Alt spawns a copy and selects it", () => {
    const d = driver();
    const effects = d.drag([-8, -8], [-6, -5]);
    const write = onlyWrite(effects);
    expect(write.ops).toHaveLength(1);
    const op = write.ops[0];
    if (op?.type !== "spawn" || op.to.type !== "board") throw new Error("not a board spawn");
    expect(op.template).toBe("tpl");
    expect(op.to.board).toBe(BOARD);
    closePoint(op.to.position, [-6, -5]);
    expect(write.continuations).toEqual([{ type: "select_created", opIndex: 0 }]);
    expect(write.label).toBe("Copy Orc");
  });

  test("a spawn drag shows a ghost and does not move the template", () => {
    const d = driver();
    d.send(pointer("pointer_down", [-8, -8]));
    const moved = d.send(pointer("pointer_move", [-6, -5]));
    const ghost = of(moved, "overlays")[0]?.overlays[0];
    if (ghost?.kind !== "drag_ghost") throw new Error("no ghost");
    closePoint(ghost.items[0]?.anchor, [-6, -5]);
    for (const p of of(moved, "previews")) expect(p.previews.has("tpl")).toBe(false);
    expect(d.tool.cursor(d.state as never)).toBe("copy");
  });

  test("one template dragged with Alt moves it", () => {
    const d = driver();
    const write = onlyWrite(d.drag([-8, -8], [-6, -5], { down: ALT, move: ALT, up: NO_MODS }));
    expect(write.ops.map((o) => o.type)).toEqual(["move"]);
    expect(write.label).toBe("Move Orc");
  });

  test("pressing Alt after a template drag started still spawns", () => {
    const d = driver();
    const write = onlyWrite(d.drag([-8, -8], [-6, -5], { down: NO_MODS, move: ALT, up: ALT }));
    expect(write.ops.map((o) => o.type)).toEqual(["spawn"]);
  });

  test("releasing Alt during an Alt template drag still moves", () => {
    const d = driver();
    const write = onlyWrite(d.drag([-8, -8], [-6, -5], { down: ALT, move: NO_MODS, up: NO_MODS }));
    expect(write.ops.map((o) => o.type)).toEqual(["move"]);
  });

  test("Alt at the drop of a spawn drag does not contain", () => {
    const d = driver();
    const write = onlyWrite(d.drag([-8, -8], [1, 1], { down: NO_MODS, up: ALT }));
    expect(write.ops).toHaveLength(1);
    const op = write.ops[0];
    if (op?.type !== "spawn" || op.to.type !== "board") throw new Error("not a board spawn");
    expect(op.template).toBe("tpl");
    closePoint(op.to.position, [1, 1]);
  });

  test("two templates are moved, never spawned", () => {
    const d = driver();
    d.selection = ["tpl", "tpl2"];
    const write = onlyWrite(d.drag([-8, -8], [-7, -7]));
    expect(write.ops.map((o) => o.type)).toEqual(["move", "move"]);
    expect(write.label).toBe("Move 2 objects");
  });

  test("a template and a token are moved, never spawned", () => {
    const d = driver();
    d.selection = ["tpl", "tok"];
    const write = onlyWrite(d.drag([-8, -8], [-7, -7]));
    expect(write.ops.map((o) => o.type)).toEqual(["move", "move"]);
    expect(write.ops).toContainEqual(boardMove("tok", [2, 2]));
  });
});

describe("dropOverride (M5 Q1 A4)", () => {
  type Call = {
    point: Point;
    ids: ObjectId[];
    intent: { copy: boolean; alt: boolean };
    revision: number;
  };

  function recording(result: ReturnType<DropOverride>) {
    const calls: Call[] = [];
    const dropOverride: DropOverride = (input, point, ids, intent) => {
      calls.push({ point, ids, intent, revision: input.revision });
      return result;
    };
    return { calls, dropOverride };
  }

  test("is consulted for a spawn drag with the intent captured at pointer down", () => {
    const r = recording(null);
    const d = driver({ dropOverride: r.dropOverride });
    const write = onlyWrite(d.drag([-8, -8], [-6, -5], { down: NO_MODS, move: ALT, up: ALT }));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.ids).toEqual(["tpl"]);
    expect(r.calls[0]?.intent).toEqual({ copy: true, alt: false });
    closePoint(r.calls[0]?.point, [-6, -5]);
    // A null result leaves the tool's own drop.
    expect(write.ops.map((o) => o.type)).toEqual(["spawn"]);
    expect(write.continuations).toEqual([{ type: "select_created", opIndex: 0 }]);
  });

  test("is consulted for a move drag; Alt released mid-drag keeps alt true", () => {
    const r = recording(null);
    const d = driver({ dropOverride: r.dropOverride });
    const write = onlyWrite(d.drag([-8, -8], [-6, -5], { down: ALT, move: NO_MODS, up: NO_MODS }));
    expect(r.calls[0]?.intent).toEqual({ copy: false, alt: true });
    expect(write.ops.map((o) => o.type)).toEqual(["move"]);
  });

  test("a non-null result replaces the drop's ops, label and continuations with the same stamp and held previews", () => {
    const ops: WireOp[] = [
      { type: "set_value", object: "die", cell: "target", value: { type: "ref", object: "tok" } },
    ];
    const r = recording({
      ops,
      label: "Target Goblin",
      continuations: [{ type: "select", ids: ["die"] }],
    });
    const d = driver({ dropOverride: r.dropOverride });
    d.send(pointer("pointer_down", [1, 1]));
    d.revision = 12;
    d.send(pointer("pointer_move", [2, -2]));
    const up = d.send(pointer("pointer_up", [2, -2]));
    const write = onlyWrite(up);
    expect(write).toEqual({
      type: "write",
      stamp: expect.objectContaining({ board: BOARD, baseRevision: 7 }),
      ops,
      label: "Target Goblin",
      continuations: [{ type: "select", ids: ["die"] }],
    });
    expect(r.calls[0]?.revision).toBe(12);
    const held = of(up, "previews");
    expect(held[0]?.hold).toEqual({ stamp: write.stamp });
    closePoint(held[0]?.previews.get("tok")?.position, [2, -2]);
  });

  test("continuations default to none", () => {
    const r = recording({ ops: [], label: "Nothing" });
    const d = driver({ dropOverride: r.dropOverride });
    const write = onlyWrite(d.drag([-8, -8], [-6, -5]));
    expect(write.label).toBe("Nothing");
    expect(write.continuations).toEqual([]);
  });

  test("is not consulted for a click", () => {
    const r = recording(null);
    const d = driver({ dropOverride: r.dropOverride });
    d.click([1, 1]);
    expect(r.calls).toEqual([]);
  });
});

describe("the Alt-hover of a drag (M6-D12)", () => {
  // A pouch token at (30, 0) with a when_selected list [-1.5, 0.9, 3, 1.2] below it.
  const pouch: ObjectView = {
    ...obj("pouch", [30, 0], 3, circle(0.9), { name: "Pouch" }),
    face: {
      elements: [
        { type: "contents", rect: [-1.5, 0.9, 3, 1.2], index: 0, shown: true, when_selected: true },
      ],
    },
  };
  const views = [...VIEWS, pouch];
  const byId = new Map(views.map((v) => [v.id, v]));
  const over: Partial<ReducerInput> = {
    scene: buildScene({ views, covers: [], board: BOARD, viewer: GM }),
    views: (id) => byId.get(id) ?? null,
  };
  const LIST_POINT: Point = [29, 1.9];
  const hovers = (effects: Effect[]) => of(effects, "alt_hover").map((e) => e.id);

  function start(d: ReturnType<typeof driver>, overrides: Partial<ReducerInput>): void {
    d.send(pointer("pointer_down", [2, -2], ALT), overrides);
    d.send(pointer("pointer_move", [10, -2], ALT), overrides);
  }

  test("entering the footprint with Alt emits it once; the list rect keeps it; leaving both ends it", () => {
    const d = driver();
    start(d, over);
    expect(hovers(d.send(pointer("pointer_move", [30, 0.2], ALT), over))).toEqual(["pouch"]);
    expect(hovers(d.send(pointer("pointer_move", LIST_POINT, ALT), over))).toEqual([]);
    expect(hovers(d.send(pointer("pointer_move", [40, 5], ALT), over))).toEqual([null]);
  });

  test("an Alt key release ends it; so does a cancel", () => {
    const d = driver();
    start(d, over);
    d.send(pointer("pointer_move", [30, 0.2], ALT), over);
    const up: InteractionEvent = {
      type: "key_up",
      key: "Alt",
      code: "AltLeft",
      modifiers: NO_MODS,
      inTextField: false,
    };
    expect(hovers(d.send(up, over))).toEqual([null]);

    const e = driver();
    start(e, over);
    e.send(pointer("pointer_move", [30, 0.2], ALT), over);
    expect(hovers(e.cancel("escape"))).toEqual([null]);
  });

  test("the drop passes the Alt-hover at the release to the drop override and clears it", () => {
    const seen: (ObjectId | null)[] = [];
    const dropOverride: DropOverride = (_i, _p, _ids, _intent, context) => {
      seen.push(context?.altHover ?? null);
      return null;
    };
    const d = driver({ dropOverride });
    start(d, over);
    d.send(pointer("pointer_move", [30, 0.2], ALT), over);
    const out = d.send(pointer("pointer_up", LIST_POINT, ALT), over);
    expect(seen).toEqual(["pouch"]);
    expect(hovers(out)).toEqual([null]);
  });
});
