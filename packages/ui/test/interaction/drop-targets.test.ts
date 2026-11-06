// @vitest-environment node
/**
 * Face drops (vtt-1xv.25; DESIGN.md §4.6 Gestures, §4.7 giving a template;
 * M4-D8; M5 plan Q1 A4 as amended, Q11, review r1 finding 9, r2 finding 2,
 * r3 finding 2) on fixed face scenes: `faceDropOverride` and
 * `createFaceDropOverride` directly, and through the real select tool, whose
 * drag intent stays as captured at pointer down.
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
  type Effect,
  entryTransform,
  type FaceStateStore,
  faceDropOverride,
  giveTemplateWrite,
  type InteractionEvent,
  isBinder,
  type Modifiers,
  pathContents,
  type ReducerInput,
  type ToolInput,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
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

/** A 2.5 × 3.5 card: a name value and a `title` editor. */
const card = (id: string, s: Spec) =>
  mk(id, {
    shape: rect(2.5, 3.5),
    cells: { title: EMPTY },
    face: {
      elements: [
        value("name", [-1.15, -1.65, 2.3, 0.5], 0),
        editor("title", [-1.15, -1.0, 2.3, 0.5], 1),
      ],
    },
    ...s,
  });

/** The card on the board: name and a `target` editor (the Attack card's shape of face). */
const CARD = mk("card", {
  shape: rect(2, 3),
  at: [0, 0],
  cells: { target: EMPTY },
  face: {
    elements: [
      value("name", [-1.2, -1.7, 2.4, 0.4], 0),
      editor("target", [-1.2, -1.2, 2.4, 0.4], 1),
    ],
  },
});
const GOBLIN = mk("goblin", { shape: { type: "circle", radius: 0.5 }, at: [5, 0] });
const TPL = mk("tpl", {
  shape: rect(1, 1),
  at: [10, 0],
  template: true,
  cells: { total: EMPTY },
  face: { elements: [value("total", [-0.4, -0.4, 0.8, 0.4], 0)] },
});
/** Binder `ba` at [0, 20]: a0..a2 in an 8-row list. */
const BA = mk("ba", {
  shape: rect(6, 6),
  at: [0, 20],
  tags: ["binder"],
  contents: ["a0", "a1", "a2"],
  face: { elements: [contents(LIST, 0)] },
});
/** A hand (not a binder) at [20, 20] holding h0. */
const HAND = mk("hand", {
  shape: rect(6, 6),
  at: [20, 20],
  tags: ["hand"],
  contents: ["h0"],
  face: { elements: [contents(LIST, 0)] },
});
/** Binder `bb` at [40, 20] whose three rows fill its 6 × 1.8 list exactly. */
const BB = mk("bb", {
  shape: rect(6, 3),
  at: [40, 20],
  tags: ["card", "binder"],
  contents: ["b0", "b1", "b2"],
  face: { elements: [contents([-3, -1.5, 6, 1.8], 0)] },
});

const VIEWS: ObjectView[] = [
  CARD,
  GOBLIN,
  TPL,
  BA,
  ...["a0", "a1", "a2"].map((id) => card(id, { container: "ba" })),
  HAND,
  card("h0", { container: "hand" }),
  BB,
  ...["b0", "b1", "b2"].map((id) => card(id, { container: "bb" })),
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

/** The centre of collapsed row `i` of a list whose top is at board y `top` (x right of the chevron). */
const rowAt = (x: number, top: number, i: number, half: "upper" | "lower" = "upper"): Point => [
  x + 1,
  top + 0.6 * i + (half === "upper" ? 0.15 : 0.45),
];
const TARGET: Point = [0, -1.0];
const COPY = { copy: true, alt: false };
const MOVE = { copy: false, alt: false };
const ALT = { copy: false, alt: true };

describe("faceDropOverride", () => {
  test("a drop on another object's editor element writes a reference to the dragged object, for either intent", () => {
    for (const [id, intent] of [
      ["goblin", MOVE],
      ["tpl", COPY],
      ["tpl", ALT],
    ] as const) {
      expect(faceDropOverride(input(), TARGET, [id], intent)).toEqual({
        ops: [{ type: "set_value", object: "card", cell: "target", value: ref(id) }],
        label: `Set card target to ${id}`,
        continuations: [],
      });
    }
  });

  test("a template dropped with the copy intent on a binder's contents element gives a template at the row's index", () => {
    const out = faceDropOverride(input(), rowAt(0, 17, 1, "lower"), ["tpl"], COPY);
    expect(out).toEqual(giveTemplateWrite(input(), "tpl", "ba", 2));
    expect(out).toEqual({
      ops: [
        {
          type: "spawn",
          template: "tpl",
          to: { type: "container", container: "ba", index: 2 },
          as: "$copy",
        },
        { type: "set_template_flag", object: "$copy", value: true },
      ],
      label: "Give tpl",
      continuations: [{ type: "select_created", opIndex: 0 }],
    });
  });

  test("with the copy intent into a non-binder container: an instance spawn at the index, selected", () => {
    expect(faceDropOverride(input(), rowAt(20, 17, 0), ["tpl"], COPY)).toEqual({
      ops: [
        { type: "spawn", template: "tpl", to: { type: "container", container: "hand", index: 0 } },
      ],
      label: "Copy tpl into hand",
      continuations: [{ type: "select_created", opIndex: 0 }],
    });
  });

  test("with the move intent: a move into the container at the index (Alt at pointer down moves a template)", () => {
    expect(faceDropOverride(input(), rowAt(0, 17, 2), ["goblin"], MOVE)).toEqual({
      ops: [
        { type: "move", object: "goblin", to: { type: "container", container: "ba", index: 2 } },
      ],
      label: "Put goblin into ba",
      continuations: [],
    });
    expect(faceDropOverride(input(), rowAt(0, 17, 0), ["tpl"], ALT)?.ops).toEqual([
      { type: "move", object: "tpl", to: { type: "container", container: "ba", index: 0 } },
    ]);
  });

  test("the empty area of a list inserts at the end", () => {
    expect(faceDropOverride(input(), [0, 21], ["goblin"], MOVE)?.ops).toEqual([
      { type: "move", object: "goblin", to: { type: "container", container: "ba", index: 3 } },
    ]);
  });

  test("a list whose rows fill its rect inserts at the row index", () => {
    // bb's list spans y 18.5..20.3; its rows are 0.6 high.
    for (const [i, half, index] of [
      [0, "upper", 0],
      [1, "lower", 2],
      [2, "lower", 3],
    ] as const) {
      expect(faceDropOverride(input(), rowAt(40, 18.5, i, half), ["goblin"], MOVE)?.ops).toEqual([
        { type: "move", object: "goblin", to: { type: "container", container: "bb", index } },
      ]);
    }
  });

  test("the board, a body and several dragged objects are the select tool's own drop (null)", () => {
    expect(faceDropOverride(input(), [100, 100], ["goblin"], MOVE)).toBeNull();
    expect(faceDropOverride(input(), [0, 1], ["goblin"], MOVE)).toBeNull();
    expect(faceDropOverride(input(), TARGET, ["goblin", "tpl"], MOVE)).toBeNull();
    expect(faceDropOverride(input(), rowAt(0, 17, 0), ["goblin", "tpl"], MOVE)).toBeNull();
  });

  test("the dragged object itself is no target: a template dropped on its own face is the board", () => {
    expect(faceDropOverride(input(), [10, 0], ["tpl"], COPY)).toBeNull();
    // The card dropped on its own editor: the board.
    expect(faceDropOverride(input(), TARGET, ["card"], MOVE)).toBeNull();
  });

  test("isBinder reads the tag list", () => {
    expect(isBinder(BA)).toBe(true);
    expect(isBinder(BB)).toBe(true);
    expect(isBinder(HAND)).toBe(false);
    expect(isBinder(null)).toBe(false);
  });
});

describe("expanded rows (createFaceDropOverride with the session's face state)", () => {
  function expandedA1(): { faceState: FaceStateStore; point: (local: Point) => Point } {
    const faceState = createFaceStateStore();
    faceState.expand("a1");
    const faces = buildFaceScene(
      { views: VIEWS, covers: [], board: BOARD, viewer: { type: "gm" } },
      { faceState },
    );
    const list = pathContents(faces, [{ container: "ba", element: 0 }])[0];
    const entry = list?.entries.find((e) => e.id === "a1");
    const toBoard = faces.transforms.get("ba");
    if (list === undefined || entry === undefined || toBoard === undefined)
      throw new Error("no a1");
    return {
      faceState,
      point: (local) => apply(compose(toBoard, entryTransform(list, entry)), local),
    };
  }

  test("a drop over a value inside an expanded row's child inserts into the outer list, not the child", () => {
    const { faceState, point } = expandedA1();
    const override = createFaceDropOverride(faceState);
    // a1's name value, in the upper half of its expanded row → before it.
    const name = point([0, -1.4]);
    expect(override(input(), name, ["goblin"], MOVE)?.ops).toEqual([
      { type: "move", object: "goblin", to: { type: "container", container: "ba", index: 1 } },
    ]);
    // Its lower half (still inside the clipped list) → after it.
    expect(override(input(), point([0.5, 0.1]), ["goblin"], MOVE)?.ops).toEqual([
      { type: "move", object: "goblin", to: { type: "container", container: "ba", index: 2 } },
    ]);
  });

  test("an editor of an expanded child takes the reference", () => {
    const { faceState, point } = expandedA1();
    expect(createFaceDropOverride(faceState)(input(), point([0, -0.75]), ["goblin"], MOVE)).toEqual(
      {
        ops: [{ type: "set_value", object: "a1", cell: "title", value: ref("goblin") }],
        label: "Set a1 title to goblin",
        continuations: [],
      },
    );
  });

  test("faceDropOverride resolves on input.scene's faces when the scene carries them", () => {
    const { faceState, point } = expandedA1();
    const scene = buildFaceScene(
      { views: VIEWS, covers: [], board: BOARD, viewer: { type: "gm" } },
      { faceState },
    );
    const withFaces: ReducerInput = { ...input(), scene };
    expect(faceDropOverride(withFaces, point([0, -0.75]), ["goblin"], MOVE)?.ops[0]).toMatchObject({
      type: "set_value",
      object: "a1",
    });
    // On a plain scene the default expansion applies: a1 is a collapsed row there.
    expect(
      faceDropOverride(input(), point([0, -0.75]), ["goblin"], MOVE)?.ops[0],
    ).not.toMatchObject({
      object: "a1",
    });
  });
});

// ---------------------------------------------------------------------------
// Through the select tool: the intent is the one captured at pointer down.

const screenOf = (board: Point): Point => toScreen(CAMERA, board, VIEWPORT);

function ptr(
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

const ALT_MODS: Modifiers = { ...NO_MODS, alt: true };

/** Drags `from` → `to` with the select tool and `faceDropOverride`; Alt as given per event. */
function selectDrag(from: Point, to: Point, alt: [boolean, boolean, boolean]): Effect[] {
  const tool = createSelectTool({ dropOverride: faceDropOverride });
  let state = tool.init({});
  const out: Effect[] = [];
  const mods = (a: boolean) => (a ? ALT_MODS : NO_MODS);
  const steps: [InteractionEvent, number, string][] = [
    [ptr("pointer_down", from, mods(alt[0])), 5, "i1"],
    [ptr("pointer_move", to, mods(alt[1])), 6, "i2"],
    [ptr("pointer_up", to, mods(alt[2])), 7, "i3"],
  ];
  for (const [event, revision, interactionId] of steps) {
    const r = tool.reduce(state, event, input({ revision, interactionId }));
    state = r.state;
    out.push(...r.effects);
  }
  return out;
}

const writeOf = (effects: Effect[]) => effects.find((e) => e.type === "write");
const STAMP = { interactionId: "i1", board: BOARD, viewer: { type: "gm" }, baseRevision: 5 };

describe("a board template drag through the select tool", () => {
  test("no Alt at pointer down, Alt pressed mid-drag and at the drop: still a copy, given to the binder with the pointer-down stamp", () => {
    const w = writeOf(selectDrag([10, 0], rowAt(0, 17, 1), [false, true, true]));
    expect(w).toMatchObject({
      type: "write",
      stamp: STAMP,
      label: "Give tpl",
      continuations: [{ type: "select_created", opIndex: 0 }],
    });
    expect(w?.type === "write" && w.ops.map((o) => o.type)).toEqual(["spawn", "set_template_flag"]);
  });

  test("Alt at pointer down, released mid-drag: still a move into the binder", () => {
    const w = writeOf(selectDrag([10, 0], rowAt(0, 17, 1), [true, false, false]));
    expect(w).toMatchObject({
      stamp: STAMP,
      ops: [{ type: "move", object: "tpl", to: { type: "container", container: "ba", index: 1 } }],
    });
  });

  test("onto a non-binder's contents: an instance; onto the card's editor: a reference and no spawn", () => {
    expect(writeOf(selectDrag([10, 0], rowAt(20, 17, 0), [false, false, false]))).toMatchObject({
      stamp: STAMP,
      ops: [
        { type: "spawn", template: "tpl", to: { type: "container", container: "hand", index: 0 } },
      ],
    });
    expect(writeOf(selectDrag([10, 0], TARGET, [false, false, false]))).toMatchObject({
      stamp: STAMP,
      ops: [{ type: "set_value", object: "card", cell: "target", value: ref("tpl") }],
    });
  });

  test("onto the board: the select tool's own spawn", () => {
    expect(writeOf(selectDrag([10, 0], [12, 4], [false, true, true]))).toMatchObject({
      stamp: STAMP,
      ops: [
        { type: "spawn", template: "tpl", to: { type: "board", board: BOARD, position: [12, 4] } },
      ],
    });
  });

  test("a goblin dragged onto the card's target editor: one reference write, nothing moves", () => {
    const effects = selectDrag([5, 0], TARGET, [false, false, false]);
    expect(writeOf(effects)).toEqual({
      type: "write",
      stamp: STAMP,
      ops: [{ type: "set_value", object: "card", cell: "target", value: ref("goblin") }],
      label: "Set card target to goblin",
      continuations: [],
    });
  });
});

describe("a when_selected list (vtt-nb8.35, M6-D12)", () => {
  /** A token at [0, 40] with a when-selected list below it holding `gem`, and a die to drop. */
  const TOKEN = mk("token", {
    shape: { type: "circle", radius: 0.9 },
    at: [0, 40],
    contents: ["gem"],
    face: {
      elements: [
        {
          type: "contents",
          rect: [-1.5, 0.9, 3, 1.2],
          index: 0,
          shown: true,
          when_selected: true,
        } as FaceElementView,
      ],
    },
  });
  const GEM = card("gem", { container: "token" });
  const DIE = mk("die", { shape: rect(1, 1), at: [10, 40] });
  const views = [
    TOKEN,
    GEM,
    DIE,
    BA,
    ...["a0", "a1", "a2"].map((id) => card(id, { container: "ba" })),
  ];
  const byId = new Map(views.map((v) => [v.id, v]));
  const tokenInput = (selection: string[]): ToolInput =>
    input({
      scene: buildScene({ views, covers: [], board: BOARD, viewer: { type: "gm" }, selection }),
      views: (id) => byId.get(id) ?? null,
      selection,
    });
  // In the list's rect, below the token's footprint (list top at board y 40.9).
  const IN_LIST: Point = [-1, 41.9];
  const INTO_TOKEN = {
    ops: [{ type: "move", object: "die", to: { type: "container", container: "token", index: 1 } }],
  };

  test("unselected: a drop over the hidden list is the select tool's own (board) drop", () => {
    expect(
      createFaceDropOverride(createFaceStateStore())(tokenInput([]), IN_LIST, ["die"], MOVE),
    ).toBeNull();
    expect(faceDropOverride(tokenInput([]), IN_LIST, ["die"], MOVE)).toBeNull();
  });

  test("selected (or with a selected descendant): the list takes the drop", () => {
    for (const selection of [["token"], ["gem"]]) {
      const out = createFaceDropOverride(createFaceStateStore())(
        tokenInput(selection),
        IN_LIST,
        ["die"],
        MOVE,
      );
      expect(out, selection.join()).toMatchObject(INTO_TOKEN);
    }
  });

  test("an entry dragged out of a binder onto a selected token's list goes inside", () => {
    const out = createFaceDropOverride(createFaceStateStore())(
      tokenInput(["token"]),
      IN_LIST,
      ["a1"],
      MOVE,
    );
    expect(out?.ops).toEqual([
      { type: "move", object: "a1", to: { type: "container", container: "token", index: 1 } },
    ]);
  });

  test("the Alt-hover reveals the list to the drop override", () => {
    let hover: string | null = "token";
    const override = createFaceDropOverride(createFaceStateStore(), { altHover: () => hover });
    expect(override(tokenInput([]), IN_LIST, ["die"], ALT)).toMatchObject(INTO_TOKEN);
    hover = null;
    expect(override(tokenInput([]), IN_LIST, ["die"], ALT)).toBeNull();
  });
});
