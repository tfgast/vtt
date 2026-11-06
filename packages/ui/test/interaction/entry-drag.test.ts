// @vitest-environment node
/**
 * `entryDragGesture` (vtt-1xv.25; DESIGN.md §4.6 Gestures, §4.7 drag out of
 * a binder, giving a template; M4-D8; M5 plan review r3 findings 2, 4) in
 * vtt-1xv.16's `withFaces` over the real select tool, on fixed face scenes.
 * Every write carries the stamp captured at pointer down (`i1`, revision 5)
 * although `input.revision` advanced before the release.
 */
import type { FaceElementView, FaceView, ObjectView, WireResult, WireValue } from "@vtt/protocol";
import type { Point, Rect, Shape } from "@vtt/schema";
import {
  apply,
  buildFaceScene,
  buildScene,
  type Camera,
  compose,
  createFaceDropOverride,
  createFaceStateStore,
  createSelectTool,
  defaultFacePolicy,
  type Effect,
  ENTRY_DRAG_GESTURE,
  entryDragGesture,
  entryTransform,
  type FaceHit,
  type FaceStateStore,
  faceHitAt,
  type InteractionEvent,
  type Modifiers,
  pathContents,
  type Tool,
  type ToolInput,
  type ToolState,
  toScreen,
  withFaces,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const ALT_MODS: Modifiers = { ...NO_MODS, alt: true };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

interface Spec {
  shape?: Shape;
  cells?: Record<string, WireResult>;
  face?: FaceView;
  template?: boolean;
  tags?: string[];
  contents?: string[];
  at?: Point;
  container?: string;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {};
  cells.name = { value: text(id), kind: "literal" };
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: "literal" };
  }
  cells.face_up = { value: bool(true), kind: "literal" };
  if (s.tags) {
    cells.tag = { value: { type: "list", items: s.tags.map(text) }, kind: "structural" };
  }
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
    is_template: s.template ?? false,
    is_character: false,
    cells,
    actions: [],
    action_states: [],
  };
  if (s.face) view.face = s.face;
  return view;
}

const value = (cell: string, r: Rect, index: number) =>
  ({ type: "value", cell, rect: r, index, shown: true }) as FaceElementView;
const editor = (cell: string, r: Rect, index: number) =>
  ({ type: "editor", cell, rect: r, index, shown: true }) as FaceElementView;
const contents = (r: Rect, index: number) =>
  ({ type: "contents", rect: r, index, shown: true }) as FaceElementView;

const LIST: Rect = [-3, -3, 6, 4.8];
const binder = (id: string, at: Point, items: string[], tags = ["binder"]) =>
  mk(id, { shape: rect(6, 6), at, tags, contents: items, face: { elements: [contents(LIST, 0)] } });
/** A 2.5 × 3.5 card with a name value. */
const card = (id: string, container: string, template = false) =>
  mk(id, {
    shape: rect(2.5, 3.5),
    container,
    template,
    face: { elements: [value("name", [-1.15, -1.65, 2.3, 0.5], 0)] },
  });

const CARD = mk("card", {
  shape: rect(2, 3),
  at: [0, 0],
  cells: { target: EMPTY },
  face: { elements: [editor("target", [-1.2, -1.2, 2.4, 0.4], 0)] },
});
const VIEWS: ObjectView[] = [
  CARD,
  // ba at [0, 20]: a template card `ta`, then cards a0, a1.
  binder("ba", [0, 20], ["ta", "a0", "a1"]),
  card("ta", "ba", true),
  card("a0", "ba"),
  card("a1", "ba"),
  // Another binder bc at [20, 20] holding c0, c1.
  binder("bc", [20, 20], ["c0", "c1"]),
  card("c0", "bc"),
  card("c1", "bc"),
  // A hand (not a binder) at [40, 20] holding h0.
  binder("hand", [40, 20], ["h0"], ["hand"]),
  card("h0", "hand"),
  // A binder bn at [60, 20] holding pc, which has a name value, a `note`
  // editor and its own list holding the card pcs (vtt-nb8.30: a character
  // with its sheet, drawn in an expanded row).
  binder("bn", [60, 20], ["pc"]),
  mk("pc", {
    shape: rect(3, 3),
    container: "bn",
    cells: { note: text("") },
    contents: ["pcs"],
    face: {
      elements: [
        value("name", [-1.4, -1.4, 2.8, 0.5], 0),
        editor("note", [-1.4, -0.85, 2.8, 0.4], 1),
        contents([-1.4, -0.35, 2.8, 1.7], 2),
      ],
    },
  }),
  card("pcs", "pc"),
];
const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));

function input(over: Partial<ToolInput> = {}): ToolInput {
  return {
    scene: buildScene({ views: VIEWS, covers: [], board: BOARD, viewer: { type: "gm" } }),
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer: { type: "gm" },
    revision: 5,
    camera: CAMERA,
    selection: [],
    views: (id) => BY_ID.get(id) ?? null,
    interactionId: "i1",
    ...over,
  };
}

const screenOf = (board: Point): Point => toScreen(CAMERA, board, VIEWPORT);

function ptr(
  type: "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel",
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

/** Collapsed row `i` of a list at board y `top` (upper or lower half, right of the chevron). */
const rowAt = (x: number, top: number, i: number, half: "upper" | "lower" = "upper"): Point => [
  x + 1,
  top + 0.6 * i + (half === "upper" ? 0.15 : 0.45),
];
const TA = rowAt(0, 17, 0);
const A0 = rowAt(0, 17, 1);
const TARGET: Point = [0, -1.0];
const STAMP = { interactionId: "i1", board: BOARD, viewer: { type: "gm" }, baseRevision: 5 };

interface Rig {
  faceState: FaceStateStore;
  send(event: InteractionEvent, over?: Partial<ToolInput>): Effect[];
  wheel(board: Point): Effect[] | null;
  cancel(reason: "escape" | "tool_switch" | "board_change" | "viewer_change"): Effect[];
  /** Pointer down at `from` (revision 5, `i1`), moves through `via`, up at the last point (revision 7). */
  drag(from: Point, via: Point[], mods?: Modifiers[]): Effect[];
}

function rig(faceState = createFaceStateStore()): Rig {
  const tool = withFaces(createSelectTool({ dropOverride: createFaceDropOverride(faceState) }), {
    faceState,
    policy: defaultFacePolicy,
    gestures: [entryDragGesture({ faceState })],
  }) as unknown as Tool<unknown, "select">;
  let state: ToolState<unknown, "select"> = tool.init({});
  const r: Rig = {
    faceState,
    send(event, over = {}) {
      const out = tool.reduce(state, event, input(over));
      state = out.state;
      return out.effects;
    },
    wheel(board) {
      const event = {
        type: "wheel" as const,
        screen: screenOf(board),
        board,
        deltaX: 0,
        deltaY: 100,
        modifiers: NO_MODS,
      };
      const out = tool.wheel?.(state, event, input());
      if (out === undefined || out === null) return null;
      state = out.state;
      return out.effects;
    },
    cancel(reason) {
      const out = tool.cancel(state, reason);
      state = out.state;
      return out.effects;
    },
    drag(from, via, mods = []) {
      const m = (i: number) => mods[i] ?? NO_MODS;
      const out = [
        ...r.send(ptr("pointer_down", from, m(0)), { revision: 5, interactionId: "i1" }),
      ];
      via.forEach((p, i) => {
        out.push(
          ...r.send(ptr("pointer_move", p, m(i + 1)), { revision: 6, interactionId: `m${i}` }),
        );
      });
      const last = via[via.length - 1] ?? from;
      out.push(
        ...r.send(ptr("pointer_up", last, m(via.length + 1)), { revision: 7, interactionId: "i9" }),
      );
      return out;
    },
  };
  return r;
}

const writes = (effects: Effect[]) => effects.filter((e) => e.type === "write");

describe("claiming and clicking", () => {
  test("the gesture's id", () => {
    expect(entryDragGesture().id).toBe(ENTRY_DRAG_GESTURE);
  });

  test("a click on a collapsed row selects that contained object and writes nothing", () => {
    const r = rig();
    const out = r.drag(A0, []);
    expect(out).toEqual([{ type: "select", ids: ["a0"] }]);
  });

  test("a release within 4 px is still a click", () => {
    const r = rig();
    const near: Point = [A0[0] + 0.03, A0[1]];
    expect(r.drag(A0, [near])).toEqual([{ type: "select", ids: ["a0"] }]);
  });

  test("a click on the empty area of an expanded child selects the child", () => {
    const faceState = createFaceStateStore();
    faceState.expand("a0");
    const faces = buildFaceScene(
      { views: VIEWS, covers: [], board: BOARD, viewer: { type: "gm" } },
      { faceState },
    );
    const list = pathContents(faces, [{ container: "ba", element: 0 }])[0];
    const entry = list?.entries.find((e) => e.id === "a0");
    const toBoard = faces.transforms.get("ba");
    if (list === undefined || entry === undefined || toBoard === undefined) throw new Error("a0");
    const empty = apply(compose(toBoard, entryTransform(list, entry)), [0.8, 0]);
    const r = rig(faceState);
    expect(r.drag(empty, [])).toEqual([{ type: "select", ids: ["a0"] }]);
  });

  test("a press on a board object's own face is not claimed (the select tool's)", () => {
    const r = rig();
    const out = r.drag([0.5, 1], []);
    expect(out).toContainEqual({ type: "select", ids: ["card"] });
  });
});

describe("drags", () => {
  test("a card entry dragged onto the board: a drag ghost, then one move with the pointer-down stamp", () => {
    const r = rig();
    r.send(ptr("pointer_down", A0), { revision: 5, interactionId: "i1" });
    const moving = r.send(ptr("pointer_move", [10, 10]), { revision: 6, interactionId: "i2" });
    expect(moving).toEqual([
      {
        type: "overlays",
        overlays: [
          {
            kind: "drag_ghost",
            items: [{ id: "a0", anchor: [10, 10], rotation: 0, shape: rect(2.5, 3.5) }],
          },
        ],
      },
    ]);
    const up = r.send(ptr("pointer_up", [12, 11]), { revision: 7, interactionId: "i3" });
    expect(up).toEqual([
      {
        type: "write",
        stamp: STAMP,
        ops: [
          { type: "move", object: "a0", to: { type: "board", board: BOARD, position: [12, 11] } },
        ],
        label: "Move a0",
        continuations: [],
      },
      { type: "overlays", overlays: [] },
    ]);
  });

  test("a template entry dragged out spawns a copy on the board, selected; Alt pressed mid-drag changes nothing", () => {
    const r = rig();
    const out = r.drag(TA, [[10, 10]], [NO_MODS, ALT_MODS, ALT_MODS]);
    expect(writes(out)).toEqual([
      {
        type: "write",
        stamp: STAMP,
        ops: [
          {
            type: "spawn",
            template: "ta",
            to: { type: "board", board: BOARD, position: [10, 10] },
          },
        ],
        label: "Copy ta",
        continuations: [{ type: "select_created", opIndex: 0 }],
      },
    ]);
  });

  test("with Alt held at pointer down the template is moved out; releasing Alt mid-drag changes nothing", () => {
    const r = rig();
    const out = r.drag(TA, [[10, 10]], [ALT_MODS, NO_MODS, NO_MODS]);
    expect(writes(out)).toMatchObject([
      {
        stamp: STAMP,
        ops: [
          { type: "move", object: "ta", to: { type: "board", board: BOARD, position: [10, 10] } },
        ],
      },
    ]);
  });

  test("a template entry dropped on another binder's contents gives a template at the index", () => {
    const r = rig();
    const out = r.drag(TA, [rowAt(20, 17, 1, "lower")]);
    expect(writes(out)).toEqual([
      {
        type: "write",
        stamp: STAMP,
        ops: [
          {
            type: "spawn",
            template: "ta",
            to: { type: "container", container: "bc", index: 2 },
            as: "$copy",
          },
          { type: "set_template_flag", object: "$copy", value: true },
        ],
        label: "Give ta",
        continuations: [{ type: "select_created", opIndex: 0 }],
      },
    ]);
  });

  test("a template entry dropped on a non-binder's contents spawns an instance there", () => {
    const r = rig();
    expect(writes(r.drag(TA, [rowAt(40, 17, 0)]))).toEqual([
      {
        type: "write",
        stamp: STAMP,
        ops: [
          { type: "spawn", template: "ta", to: { type: "container", container: "hand", index: 0 } },
        ],
        label: "Copy ta into hand",
        continuations: [{ type: "select_created", opIndex: 0 }],
      },
    ]);
  });

  test("a card entry dropped on another binder's contents is moved there at the index", () => {
    const r = rig();
    expect(writes(r.drag(A0, [rowAt(20, 17, 1)]))).toEqual([
      {
        type: "write",
        stamp: STAMP,
        ops: [{ type: "move", object: "a0", to: { type: "container", container: "bc", index: 1 } }],
        label: "Put a0 into bc",
        continuations: [],
      },
    ]);
  });

  test("an entry dropped on its own container's contents writes nothing", () => {
    const r = rig();
    const out = r.drag(A0, [rowAt(0, 17, 2, "lower")]);
    expect(out.filter((e) => e.type !== "overlays")).toEqual([]);
  });

  test("an entry dropped on an editor element writes a reference; nothing moves", () => {
    const r = rig();
    expect(writes(r.drag(A0, [TARGET]))).toEqual([
      {
        type: "write",
        stamp: STAMP,
        ops: [{ type: "set_value", object: "card", cell: "target", value: ref("a0") }],
        label: "Set card target to a0",
        continuations: [],
      },
    ]);
    // A template entry too: a reference, no spawn.
    expect(writes(r.drag(TA, [TARGET]))[0]).toMatchObject({
      ops: [{ type: "set_value", object: "card", cell: "target", value: ref("ta") }],
    });
  });

  test("a release beyond the threshold without moves is a drop", () => {
    const r = rig();
    r.send(ptr("pointer_down", A0), { revision: 5, interactionId: "i1" });
    const up = r.send(ptr("pointer_up", [12, 11]), { revision: 7, interactionId: "i3" });
    expect(writes(up)).toMatchObject([{ stamp: STAMP, ops: [{ type: "move", object: "a0" }] }]);
  });

  test("wheel events during a drag are claimed and scroll nothing", () => {
    const r = rig();
    r.send(ptr("pointer_down", A0));
    r.send(ptr("pointer_move", [10, 10]));
    expect(r.wheel([0, 18])).toEqual([]);
    expect(r.wheel([200, 200])).toEqual([]);
    expect(r.faceState.scrollOffset("ba", 0)).toBe(0);
  });
});

describe("cancellation", () => {
  for (const reason of ["escape", "board_change", "viewer_change", "tool_switch"] as const) {
    test(`${reason} during an entry drag writes nothing and clears the ghost`, () => {
      const r = rig();
      r.send(ptr("pointer_down", A0));
      r.send(ptr("pointer_move", [10, 10]));
      expect(r.cancel(reason)).toEqual([{ type: "overlays", overlays: [] }]);
      const up = r.send(ptr("pointer_up", [10, 10]));
      expect(writes(up)).toEqual([]);
    });
  }

  test("pointer_cancel ends it with no write", () => {
    const r = rig();
    r.send(ptr("pointer_down", A0));
    r.send(ptr("pointer_move", [10, 10]));
    const out = r.send(ptr("pointer_cancel", [10, 10]));
    expect(out).toEqual([{ type: "overlays", overlays: [] }]);
  });
});

describe("without the session's face state", () => {
  test("drops resolve on the default expansion", () => {
    const tool = withFaces(createSelectTool(), {
      faceState: createFaceStateStore(),
      policy: defaultFacePolicy,
      gestures: [entryDragGesture()],
    }) as unknown as Tool<unknown, "select">;
    let state: ToolState<unknown, "select"> = tool.init({});
    const run = (e: InteractionEvent, over: Partial<ToolInput> = {}) => {
      const out = tool.reduce(state, e, input(over));
      state = out.state;
      return out.effects;
    };
    run(ptr("pointer_down", A0));
    run(ptr("pointer_move", rowAt(20, 17, 0)), { revision: 6 });
    const up = run(ptr("pointer_up", rowAt(20, 17, 0)), { revision: 7 });
    expect(writes(up)).toMatchObject([
      {
        ops: [{ type: "move", object: "a0", to: { type: "container", container: "bc", index: 0 } }],
      },
    ]);
  });
});

describe("expanded rows: a press that moves on the drawn object drags its entry (vtt-nb8.30)", () => {
  /**
   * The first point of `box` (board [x, y, w, h], scanned on a 0.05 grid)
   * whose face hit satisfies `ok`, on the scene `faceState` draws.
   */
  function find(faceState: FaceStateStore, box: Rect, ok: (hit: FaceHit) => boolean): Point {
    const faces = buildFaceScene(
      { views: VIEWS, covers: [], board: BOARD, viewer: { type: "gm" } },
      { faceState },
    );
    for (let y = box[1]; y <= box[1] + box[3]; y += 0.05) {
      for (let x = box[0]; x <= box[0] + box[2]; x += 0.05) {
        const p: Point = [x, y];
        const hit = faceHitAt(faces, p, CAMERA);
        if (hit !== null && ok(hit)) return p;
      }
    }
    throw new Error("no such hit");
  }
  const BA: Rect = [-3, 17, 6, 6];
  const BN: Rect = [57, 17, 6, 6];
  const expanded = (...ids: string[]) => {
    const faceState = createFaceStateStore();
    for (const id of ids) faceState.expand(id);
    return faceState;
  };
  const isValue = (object: string, cell: string) => (h: FaceHit) =>
    h.object === object && h.target.type === "value" && h.target.cell === cell;
  const moveOut = (object: string, position: Point) => ({
    type: "write",
    stamp: STAMP,
    ops: [{ type: "move", object, to: { type: "board", board: BOARD, position } }],
    label: `Move ${object}`,
    continuations: [],
  });
  const selects = (effects: Effect[]) => effects.filter((e) => e.type === "select");

  test("a press on a value element of an expanded row that moves drags that row's object out (no selection change)", () => {
    const faceState = expanded("a0");
    const name = find(faceState, BA, isValue("a0", "name"));
    const r = rig(faceState);
    expect(r.send(ptr("pointer_down", name), { revision: 5, interactionId: "i1" })).toEqual([]);
    const moving = r.send(ptr("pointer_move", [10, 10]), { revision: 6, interactionId: "i2" });
    expect(moving).toEqual([
      {
        type: "overlays",
        overlays: [
          {
            kind: "drag_ghost",
            items: [{ id: "a0", anchor: [10, 10], rotation: 0, shape: rect(2.5, 3.5) }],
          },
        ],
      },
    ]);
    const up = r.send(ptr("pointer_up", [12, 11]), { revision: 7, interactionId: "i3" });
    expect(up).toEqual([moveOut("a0", [12, 11]), { type: "overlays", overlays: [] }]);
    expect(selects([...moving, ...up])).toEqual([]);
  });

  test("a press on that value element that does not move is the select tool's click, as before", () => {
    const faceState = expanded("a0");
    const name = find(faceState, BA, isValue("a0", "name"));
    const r = rig(faceState);
    const near: Point = [name[0] + 0.02, name[1]];
    const out = r.drag(name, [near]);
    expect(writes(out)).toEqual([]);
    expect(selects(out)).toEqual([{ type: "select", ids: ["ba"] }]);
  });

  test("a double-click on that value element still edits it in place (no default action; M6-D9)", () => {
    const faceState = expanded("a0");
    const name = find(faceState, BA, isValue("a0", "name"));
    const r = rig(faceState);
    r.drag(name, []);
    r.drag(name, []);
    const out = r.send({
      type: "double_click",
      screen: screenOf(name),
      board: name,
      modifiers: NO_MODS,
    });
    expect(out).toMatchObject([{ type: "open_editor", object: "a0", cell: "name" }]);
  });

  test("a press on the chevron of an expanded row that moves beyond the click threshold drags that entry", () => {
    const faceState = expanded("a0");
    const chevron = find(faceState, BA, (h) => h.target.type === "chevron" && h.target.id === "a0");
    const r = rig(faceState);
    // Within the threshold nothing happens yet.
    expect(r.send(ptr("pointer_down", chevron))).toEqual([]);
    expect(r.send(ptr("pointer_move", [chevron[0] + 0.02, chevron[1]]))).toEqual([]);
    expect(r.send(ptr("pointer_move", [10, 10]))).toMatchObject([
      { type: "overlays", overlays: [{ kind: "drag_ghost", items: [{ id: "a0" }] }] },
    ]);
    const up = r.send(ptr("pointer_up", [12, 11]), { revision: 7, interactionId: "i3" });
    expect(writes(up)).toEqual([moveOut("a0", [12, 11])]);
    // The chevron was not toggled.
    expect(faceState.isExpanded("a0", "collapsed")).toBe(true);
  });

  test("a press on a template row's gear that moves drags the template: a copy, as from its row", () => {
    const faceState = createFaceStateStore();
    const gear = find(faceState, BA, (h) => h.target.type === "gear" && h.target.id === "ta");
    const r = rig(faceState);
    const out = r.drag(gear, [[10, 10]]);
    expect(writes(out)).toEqual([
      {
        type: "write",
        stamp: STAMP,
        ops: [
          {
            type: "spawn",
            template: "ta",
            to: { type: "board", board: BOARD, position: [10, 10] },
          },
        ],
        label: "Copy ta",
        continuations: [{ type: "select_created", opIndex: 0 }],
      },
    ]);
  });

  test("a press on a non-editable editor element of an expanded row that moves drags that row's object", () => {
    const faceState = expanded("pc");
    const note = find(
      faceState,
      BN,
      (h) => h.object === "pc" && h.target.type === "editor" && h.target.cell === "note",
    );
    const r = rig(faceState);
    const viewer = { viewer: { type: "character" as const, id: "someone" } };
    r.send(ptr("pointer_down", note), { ...viewer, revision: 5, interactionId: "i1" });
    r.send(ptr("pointer_move", [70, 10]), viewer);
    const up = r.send(ptr("pointer_up", [70, 10]), viewer);
    const { stamp: _gm, ...move } = moveOut("pc", [70, 10]);
    expect(writes(up)).toEqual([{ ...move, stamp: { ...STAMP, viewer: viewer.viewer } }]);
  });

  test("an editable editor element of an expanded row keeps its press: a moved press does nothing", () => {
    const faceState = expanded("pc");
    const note = find(
      faceState,
      BN,
      (h) => h.object === "pc" && h.target.type === "editor" && h.target.cell === "note",
    );
    const r = rig(faceState);
    const out = r.drag(note, [[70, 10]]);
    expect(out.filter((e) => e.type !== "overlays")).toEqual([]);
  });

  test("a nested entry in an expanded row still drags the nested object, not the row's", () => {
    const faceState = expanded("pc");
    const nested = find(faceState, BN, (h) => h.target.type === "entry" && h.target.id === "pcs");
    const r = rig(faceState);
    const out = r.drag(nested, [[70, 10]]);
    expect(writes(out)).toEqual([moveOut("pcs", [70, 10])]);
  });

  test("empty space in an expanded row's nested list that moves drags that row's object, not the outer binder", () => {
    const faceState = expanded("pc");
    const empty = find(
      faceState,
      BN,
      (h) => h.object === "pc" && h.target.type === "contents" && h.target.container === "pc",
    );
    const r = rig(faceState);
    const out = r.drag(empty, [[70, 10]]);
    expect(writes(out)).toEqual([moveOut("pc", [70, 10])]);
  });

  test("a click on that empty space without moving is still the select tool's click", () => {
    const faceState = expanded("pc");
    const empty = find(
      faceState,
      BN,
      (h) => h.object === "pc" && h.target.type === "contents" && h.target.container === "pc",
    );
    const r = rig(faceState);
    const out = r.drag(empty, []);
    expect(writes(out)).toEqual([]);
    expect(selects(out)).toEqual([{ type: "select", ids: ["bn"] }]);
  });

  test("a value element of the nested object's row, expanded too, drags the nested object", () => {
    const faceState = expanded("pc", "pcs");
    const name = find(faceState, BN, isValue("pcs", "name"));
    const r = rig(faceState);
    const out = r.drag(name, [[70, 10]]);
    expect(writes(out)).toEqual([moveOut("pcs", [70, 10])]);
  });

  test("a value element of a board object that moves is still the select tool's drag", () => {
    const faceState = createFaceStateStore();
    const r = rig(faceState);
    // The board card's target editor is editable (a press); its body is the select tool's.
    const out = r.drag([0.5, 1], [[3, 3]]);
    expect(writes(out)).toMatchObject([{ ops: [{ type: "move", object: "card" }] }]);
  });
});
