// @vitest-environment node
/**
 * `withFaces` (vtt-1xv.16; DESIGN.md §4.5, §4.6 Edit in place, Gestures; M5
 * plan Q1, Q11, Q12, Q13, review r1 finding 16, r2 findings 1, 4, r3
 * findings 3, 4, 8) on fixed face scenes, around a recording inner tool or
 * the real select tool; and the machine's wheel routing (vtt-3l6.22 as
 * amended here). Every gesture's effects carry the stamp captured at
 * pointer down, although `input.revision` advanced before the release.
 */
import type {
  ActionStateView,
  FaceElementView,
  FaceView,
  ObjectView,
  Viewer,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import type { Bounds, ObjectId, Point, Rect, Shape } from "@vtt/schema";
import {
  buildFaceScene,
  buildScene,
  type Camera,
  type ContentsPrimitive,
  createFaceStateStore,
  createSelectTool,
  defaultFacePolicy,
  type Effect,
  type FaceGesture,
  type FaceHit,
  type FacePolicy,
  type FaceStateStore,
  faceHitAt,
  INVOKE_EXTENSION,
  type InteractionEvent,
  initMachine,
  type Modifiers,
  pathContents,
  type ReducerInput,
  reduce,
  TEMPLATE_REFUSAL,
  type Tool,
  type ToolInput,
  ToolRegistry,
  type ToolState,
  toScreen,
  withFaces,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Views

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
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
  formulas?: string[];
  actions?: string[];
  states?: ActionStateView[];
  face?: FaceView;
  template?: boolean;
  contents?: string[];
  at?: Point;
  container?: string;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {};
  cells.name = { value: text(id), kind: "literal" };
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: s.formulas?.includes(name) ? "formula" : "literal" };
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

type Extra = Record<string, unknown>;
const value = (cell: string, r: Rect, index: number, extra: Extra = {}) =>
  ({ type: "value", cell, rect: r, index, shown: true, ...extra }) as FaceElementView;
const editor = (cell: string, r: Rect, index: number) =>
  ({ type: "editor", cell, rect: r, index, shown: true }) as FaceElementView;
const button = (action: string, r: Rect, index: number) =>
  ({ type: "button", action, rect: r, index, shown: true }) as FaceElementView;
const contents = (r: Rect, index: number) =>
  ({ type: "contents", rect: r, index, shown: true }) as FaceElementView;

/** The Attack card's shape of face: name, target editor, total (a formula), Roll and Apply. */
const CARD = mk("card", {
  shape: rect(2, 3),
  at: [0, 0],
  cells: { target: EMPTY, total: num(17) },
  formulas: ["total"],
  actions: ["Roll", "Apply"],
  states: [
    { name: "Roll", enabled: true },
    { name: "Apply", enabled: false, reason: "when_false" },
  ],
  face: {
    elements: [
      value("name", [-1.2, -1.7, 2.4, 0.4], 0),
      editor("target", [-1.2, -1.2, 2.4, 0.4], 1),
      value("total", [-1.2, -0.7, 1.1, 0.5], 2),
      button("Roll", [-1.2, 0.5, 1.1, 0.45], 3),
      button("Apply", [-1.2, 1.1, 2.4, 0.45], 4),
    ],
    default_action: "Roll",
  },
});
/** A d20 template on the board with `default_action` Roll. */
const TPL = mk("tpl", {
  shape: rect(1, 1),
  at: [10, 0],
  template: true,
  cells: { total: EMPTY },
  actions: ["Roll"],
  face: { elements: [value("total", [-0.4, -0.4, 0.8, 0.4], 0)], default_action: "Roll" },
});
/** A d20 whose default action's guard is false. */
const STUCK = mk("stuck", {
  shape: rect(1, 1),
  at: [14, 0],
  actions: ["Roll"],
  states: [{ name: "Roll", enabled: false, reason: "when_false" }],
  face: { elements: [], default_action: "Roll" },
});
/** A faceless token. */
const PLAIN = mk("plain", { shape: rect(1, 1), at: [-10, 0] });

/** A row card: 6 × 2, a Go button; expanded in a 6-wide list its row is 1.8 high. */
const rowCard = (id: string, container: string) =>
  mk(id, {
    shape: rect(6, 2),
    container,
    actions: ["Go"],
    face: { elements: [button("Go", [-2.5, -0.5, 1.5, 0.6], 0)] },
  });

/** Binder `b` at [0, 20]: a 6 × 4.8 list (8 rows of 0.6) holding 14 row cards c0..c13. */
const ENTRIES = Array.from({ length: 14 }, (_, i) => `c${i}`);
const BINDER = mk("b", {
  shape: rect(6, 6),
  at: [0, 20],
  contents: ENTRIES,
  face: { elements: [contents([-3, -3, 6, 4.8], 0)] },
});

/** Two deep: `ob` at [40, 0] holds `ib`, whose own 6 × 3 list holds d0..d9. */
const INNER_ROWS = Array.from({ length: 10 }, (_, i) => `d${i}`);
const OUTER = mk("ob", {
  shape: rect(6, 6),
  at: [40, 0],
  contents: ["ib"],
  face: { elements: [contents([-3, -3, 6, 4.8], 0)] },
});
const INNER = mk("ib", {
  shape: rect(6, 4),
  container: "ob",
  contents: INNER_ROWS,
  face: { elements: [contents([-3, -2, 6, 3], 0)] },
});

/** `sb` at [80, 0]: four small rows, then a 2 × 6 sheet (16.2 high expanded). */
const SHEET_BINDER = mk("sb", {
  shape: rect(6, 6),
  at: [80, 0],
  contents: ["s0", "s1", "s2", "s3", "sheet"],
  face: { elements: [contents([-3, -3, 6, 4.8], 0)] },
});

/** A faceless template with one action: its default face's strip button refuses. */
const TBTN = mk("tbtn", { shape: rect(1, 1), at: [20, 0], template: true, actions: ["Roll"] });
/** `gb` at [0, 60] holds a template row (with a gear). */
const GEAR_BINDER = mk("gb", {
  shape: rect(6, 6),
  at: [0, 60],
  contents: ["trow"],
  face: { elements: [contents([-3, -3, 6, 4.8], 0)] },
});

const VIEWS: ObjectView[] = [
  CARD,
  TBTN,
  GEAR_BINDER,
  mk("trow", { shape: rect(6, 2), container: "gb", template: true }),
  TPL,
  STUCK,
  PLAIN,
  BINDER,
  ...ENTRIES.map((id) => rowCard(id, "b")),
  OUTER,
  INNER,
  ...INNER_ROWS.map((id) => rowCard(id, "ib")),
  SHEET_BINDER,
  ...["s0", "s1", "s2", "s3"].map((id) => mk(id, { shape: rect(6, 2), container: "sb" })),
  mk("sheet", { shape: rect(2, 6), container: "sb" }),
];
const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));

function input(over: Partial<ToolInput> = {}): ToolInput {
  const viewer = over.viewer ?? GM;
  return {
    scene: buildScene({ views: VIEWS, covers: [], board: BOARD, viewer }),
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer,
    revision: 5,
    camera: CAMERA,
    selection: [],
    views: (id) => BY_ID.get(id) ?? null,
    interactionId: "i1",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Events

const screenOf = (board: Point, camera: Camera = CAMERA): Point =>
  toScreen(camera, board, VIEWPORT);

function ptr(
  type: "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel",
  board: Point,
  pointerId = 1,
): InteractionEvent {
  return {
    type,
    pointerId,
    screen: screenOf(board),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" ? 0 : 1,
    modifiers: NO_MODS,
  };
}

const dbl = (board: Point): InteractionEvent => ({
  type: "double_click",
  screen: screenOf(board),
  board,
  modifiers: NO_MODS,
});

const wheelAt = (board: Point, deltaY: number) =>
  ({
    type: "wheel",
    screen: screenOf(board),
    board,
    deltaX: 0,
    deltaY,
    modifiers: NO_MODS,
  }) as const;

// ---------------------------------------------------------------------------
// A recording inner tool

interface Inner {
  tool: Tool<number, "select">;
  events: InteractionEvent["type"][];
  cancels: string[];
}

function recordingTool(respond: (e: InteractionEvent) => Effect[] = () => []): Inner {
  const events: InteractionEvent["type"][] = [];
  const cancels: string[] = [];
  const tool: Tool<number, "select"> = {
    id: "select",
    init: (options) => ({ tool: "select", options, phase: 0 }),
    cursor: () => "default",
    reduce(state, event) {
      events.push(event.type);
      return { state: { ...state, phase: state.phase + 1 }, effects: respond(event) };
    },
    cancel(state, reason) {
      cancels.push(reason);
      return { state, effects: [] };
    },
  };
  return { tool, events, cancels };
}

interface Rig {
  faces: Tool<unknown, "select">;
  inner: Inner;
  faceState: FaceStateStore;
  state: ToolState<unknown, "select">;
  /** Runs `event` with `over` merged into the default input; returns its effects. */
  send(event: InteractionEvent, over?: Partial<ToolInput>): Effect[];
  wheel(board: Point, deltaY: number): Effect[] | null;
  cancel(reason: "escape" | "tool_switch" | "board_change" | "viewer_change"): Effect[];
}

function rig(
  opts: {
    policy?: FacePolicy;
    gestures?: FaceGesture<unknown>[];
    respond?: (e: InteractionEvent) => Effect[];
    faceState?: FaceStateStore;
  } = {},
): Rig {
  const inner = recordingTool(opts.respond);
  const faceState = opts.faceState ?? createFaceStateStore();
  const faces = withFaces(inner.tool, {
    faceState,
    policy: opts.policy ?? defaultFacePolicy,
    ...(opts.gestures ? { gestures: opts.gestures } : {}),
  }) as unknown as Tool<unknown, "select">;
  const r: Rig = {
    faces,
    inner,
    faceState,
    state: faces.init({}),
    send(event, over = {}) {
      const out = faces.reduce(r.state, event, input(over));
      r.state = out.state;
      return out.effects;
    },
    wheel(board, deltaY) {
      const out = faces.wheel?.(r.state, wheelAt(board, deltaY), input());
      if (out === undefined || out === null) return null;
      r.state = out.state;
      return out.effects;
    },
    cancel(reason) {
      const out = faces.cancel(r.state, reason);
      r.state = out.state;
      return out.effects;
    },
  };
  return r;
}

/** A click: pointer down at revision 5 (`i1`), up at revision 7 (`i2`). */
function click(r: Rig, at: Point, over: Partial<ToolInput> = {}): Effect[] {
  const a = r.send(ptr("pointer_down", at), { ...over, revision: 5, interactionId: "i1" });
  const b = r.send(ptr("pointer_up", at), { ...over, revision: 7, interactionId: "i2" });
  return [...a, ...b];
}

const STAMP_GM = { interactionId: "i1", board: BOARD, viewer: GM, baseRevision: 5 };

/** The board point of the centre of `r` in the frame of board object `id` at `at` (unrotated). */
const centreOn = (at: Point, r: Rect): Point => [at[0] + r[0] + r[2] / 2, at[1] + r[1] + r[3] / 2];

function faceScene(faceState: FaceStateStore) {
  return buildFaceScene({ views: VIEWS, covers: [], board: BOARD, viewer: GM }, { faceState });
}

function hitAt(faceState: FaceStateStore, p: Point): FaceHit | null {
  return faceHitAt(faceScene(faceState), p, CAMERA);
}

function listOf(faceState: FaceStateStore, container: ObjectId, path: ObjectId[] = [container]) {
  const prims = pathContents(
    faceScene(faceState),
    path.map((c) => ({ container: c, element: 0 })),
  );
  const c = prims[prims.length - 1];
  if (c === undefined) throw new Error(`no list of ${container}`);
  return c as ContentsPrimitive;
}

const boundsOf = (r: Rect, at: Point): Bounds => ({
  minX: at[0] + r[0],
  minY: at[1] + r[1],
  maxX: at[0] + r[0] + r[2],
  maxY: at[1] + r[1] + r[3],
});

function closeBounds(a: Bounds | undefined, b: Bounds) {
  expect(a).toBeDefined();
  for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(a?.[k]).toBeCloseTo(b[k], 9);
}

// ---------------------------------------------------------------------------
// Buttons

const ROLL = centreOn([0, 0], [-1.2, 0.5, 1.1, 0.45]);
const APPLY = centreOn([0, 0], [-1.2, 1.1, 2.4, 0.45]);
const TARGET = centreOn([0, 0], [-1.2, -1.2, 2.4, 0.4]);
const TOTAL = centreOn([0, 0], [-1.2, -0.7, 1.1, 0.5]);
const BODY: Point = [0.8, -0.2];

describe("buttons", () => {
  test("down + up within 4 px on an enabled button → the invoke effect with the pointer-down stamp", () => {
    const r = rig();
    const effects = click(r, ROLL);
    expect(effects).toEqual([
      {
        type: "extension",
        name: INVOKE_EXTENSION,
        stamp: STAMP_GM,
        payload: { object: "card", action: "Roll", table: { board: BOARD, position: [0, 0] } },
      },
    ]);
    expect(r.inner.events).toEqual([]);
  });

  test("a release 3 px away still presses; 5 px away presses nothing", () => {
    const r = rig();
    r.send(ptr("pointer_down", ROLL));
    const near: Point = [ROLL[0] + 3 / 64, ROLL[1]];
    r.send(ptr("pointer_move", near));
    expect(r.send(ptr("pointer_up", near))).toHaveLength(1);
    r.send(ptr("pointer_down", ROLL));
    const far: Point = [ROLL[0] + 5 / 64, ROLL[1]];
    expect(r.send(ptr("pointer_move", far))).toEqual([]);
    expect(r.send(ptr("pointer_up", far))).toEqual([]);
    expect(r.inner.events).toEqual([]);
  });

  test("a disabled button shows its reason and sends nothing", () => {
    const r = rig();
    expect(click(r, APPLY)).toEqual([
      { type: "notice", level: "info", text: "Apply: its condition is false." },
    ]);
  });

  test("a template's button refuses with the template notice", () => {
    const r = rig();
    // The default face's strip button below the 1 × 1 frame: [-0.75, 0.65, 1.5, 0.45].
    expect(click(r, [20, 0.875])).toEqual([
      { type: "notice", level: "info", text: TEMPLATE_REFUSAL },
    ]);
  });

  test("in view-as the press invokes as the viewed character", () => {
    const r = rig();
    const [effect] = click(r, ROLL, { viewer: ALDRIC });
    expect(effect).toMatchObject({
      type: "extension",
      stamp: { viewer: ALDRIC, baseRevision: 5 },
      payload: { actor: { type: "character", id: "aldric" } },
    });
  });

  test("policy.onButton overrides the default; null falls back to it", () => {
    const seen: FaceHit[] = [];
    const policy: FacePolicy = {
      ...defaultFacePolicy,
      onButton: (hit, ctx) => {
        seen.push(hit);
        return hit.target.type === "button" && hit.target.action === "Roll"
          ? [{ type: "notice", level: "info", text: `custom ${ctx.stamp.baseRevision}` }]
          : null;
      },
    };
    const r = rig({ policy });
    expect(click(r, ROLL)).toEqual([{ type: "notice", level: "info", text: "custom 5" }]);
    expect(click(r, APPLY)).toEqual([
      { type: "notice", level: "info", text: "Apply: its condition is false." },
    ]);
    expect(seen.map((h) => h.object)).toEqual(["card", "card"]);
  });

  test("a pointer_cancel ends a press with nothing", () => {
    const r = rig();
    r.send(ptr("pointer_down", ROLL));
    expect(r.send(ptr("pointer_cancel", ROLL))).toEqual([]);
    expect(r.send(ptr("pointer_up", ROLL))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Editing in place

describe("editing in place", () => {
  test("a click on an editor element opens the editor at the element's rect (GM)", () => {
    const r = rig();
    const effects = click(r, TARGET);
    expect(effects).toHaveLength(1);
    const [e] = effects;
    expect(e).toMatchObject({
      type: "open_editor",
      stamp: STAMP_GM,
      object: "card",
      cell: "target",
    });
    closeBounds(
      e?.type === "open_editor" ? e.rect : undefined,
      boundsOf([-1.2, -1.2, 2.4, 0.4], [0, 0]),
    );
    expect(r.inner.events).toEqual([]);
  });

  test("in view-as an editor click goes to the wrapped tool", () => {
    const r = rig();
    expect(click(r, TARGET, { viewer: ALDRIC })).toEqual([]);
    expect(r.inner.events).toEqual(["pointer_down", "pointer_up"]);
  });

  test("a value element: a single click is the wrapped tool's, a double-click edits it", () => {
    const r = rig();
    click(r, TOTAL);
    expect(r.inner.events).toEqual(["pointer_down", "pointer_up"]);
    const effects = r.send(dbl(TOTAL), { revision: 6, interactionId: "i3" });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      type: "open_editor",
      stamp: { interactionId: "i3", baseRevision: 6 },
      object: "card",
      cell: "total",
    });
    expect(r.inner.events).toEqual(["pointer_down", "pointer_up"]);
  });

  test("a double-click on an editor element does nothing more", () => {
    const r = rig();
    click(r, TARGET);
    expect(r.send(dbl(TARGET))).toEqual([]);
    expect(r.inner.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Default action

describe("double-click on the body", () => {
  test("with an enabled default_action → requestInvoke", () => {
    const r = rig();
    const effects = r.send(dbl(BODY), { revision: 8, interactionId: "i4" });
    expect(effects).toEqual([
      {
        type: "extension",
        name: INVOKE_EXTENSION,
        stamp: { interactionId: "i4", board: BOARD, viewer: GM, baseRevision: 8 },
        payload: { object: "card", action: "Roll", table: { board: BOARD, position: [0, 0] } },
      },
    ]);
    expect(r.inner.events).toEqual([]);
  });

  test("on a template the default action refuses with the template notice", () => {
    const r = rig();
    // Below its total element, inside the 1 × 1 footprint: the body.
    expect(r.send(dbl([10, 0.3]))).toEqual([
      { type: "notice", level: "info", text: TEMPLATE_REFUSAL },
    ]);
    expect(r.inner.events).toEqual([]);
  });

  test("a disabled default action, or none, is the wrapped tool's (M4's edit in place)", () => {
    const r = rig();
    r.send(dbl([14, 0]));
    r.send(dbl([-10, 0]));
    expect(r.inner.events).toEqual(["double_click", "double_click"]);
  });
});

// ---------------------------------------------------------------------------
// Contents: chevrons, gears, wheel

/** Board y of the top of row `i` of binder `b`'s list at scroll `offset` (rows 0.6, list top 17). */
const rowY = (i: number, offset: number, height = 0.6) => 17 + 0.6 * i - offset + height / 2;
const CHEVRON_X = -2.7;

describe("the wheel and chevrons in a binder of 14 entries in an 8-row list", () => {
  test("the wheel over the list scrolls it by deltaY / 100 units, clamped; elsewhere it is not claimed", () => {
    const r = rig();
    expect(r.wheel([0, 18], 100)).toEqual([]);
    expect(r.faceState.scrollOffset("b", 0)).toBeCloseTo(1, 9);
    r.wheel([0, 18], 1000);
    expect(r.faceState.scrollOffset("b", 0)).toBeCloseTo(3.6, 9);
    r.wheel([0, 18], -50);
    expect(r.faceState.scrollOffset("b", 0)).toBeCloseTo(3.1, 9);
    expect(r.wheel([0, 0], 100)).toBeNull();
    expect(r.wheel([200, 200], 100)).toBeNull();
  });

  test("scrolled to the end, the last entry's chevron expands it, reveals it whole, and its button presses", () => {
    const r = rig();
    r.wheel([0, 18], 1000);
    const chevron: Point = [CHEVRON_X, rowY(13, 3.6)];
    expect(hitAt(r.faceState, chevron)?.target).toEqual({ type: "chevron", id: "c13" });
    expect(click(r, chevron)).toEqual([]);
    expect(r.faceState.isExpanded("c13", "collapsed")).toBe(true);
    // Expanded, c13 is 1.8 high: the list's end is 9.6, so the whole row shows at offset 4.8.
    expect(r.faceState.scrollOffset("b", 0)).toBeCloseTo(4.8, 9);
    const list = listOf(r.faceState, "b");
    expect(list.maxOffset).toBeCloseTo(4.8, 9);
    // Its Go button: frame [-3, -1, 6, 2] scaled by 0.9 into [0.6, 7.8, 5.4, 1.8].
    const go: Point = [-3 + 0.6 + (-1.75 + 3) * 0.9, 17 + 7.8 + (-0.2 + 1) * 0.9 - 4.8];
    expect(hitAt(r.faceState, go)).toMatchObject({
      object: "c13",
      target: { type: "button", action: "Go" },
    });
    expect(click(r, go)).toEqual([
      {
        type: "extension",
        name: INVOKE_EXTENSION,
        stamp: STAMP_GM,
        payload: { object: "c13", action: "Go", table: { board: BOARD, position: [0, 0] } },
      },
    ]);
    // The wheel over that button scrolls the enclosing list.
    r.wheel(go, -100);
    expect(r.faceState.scrollOffset("b", 0)).toBeCloseTo(3.8, 9);
    expect(r.inner.events).toEqual([]);
  });

  test("collapsing again toggles back and leaves the scroll as it is", () => {
    const r = rig();
    const chevron: Point = [CHEVRON_X, rowY(0, 0)];
    click(r, chevron);
    expect(r.faceState.isExpanded("c0", "collapsed")).toBe(true);
    click(r, chevron);
    expect(r.faceState.isExpanded("c0", "collapsed")).toBe(false);
    expect(r.faceState.scrollOffset("b", 0)).toBe(0);
  });

  test("policy.onToggle replaces the default", () => {
    const policy: FacePolicy = {
      ...defaultFacePolicy,
      onToggle: (hit) => [{ type: "select", ids: [hit.object] }],
    };
    const r = rig({ policy });
    expect(click(r, [CHEVRON_X, rowY(2, 0)])).toEqual([{ type: "select", ids: ["c2"] }]);
    expect(r.faceState.isExpanded("c2", "collapsed")).toBe(false);
  });

  test("two containers deep: expanding a row of the inner binder scrolls the inner list only", () => {
    const faceState = createFaceStateStore();
    faceState.expand("ib");
    faceState.setScroll("ib", 0, 3);
    const r = rig({ faceState });
    // ib is drawn at scale 0.9 in ob's row: d9's chevron (ib-local [-2.7, 0.7]).
    const chevron: Point = [40 - 3 + 0.6 + 0.3 * 0.9, -3 + 2.7 * 0.9];
    expect(hitAt(faceState, chevron)).toMatchObject({
      object: "d9",
      target: { type: "chevron", id: "d9" },
    });
    click(r, chevron);
    expect(faceState.isExpanded("d9", "collapsed")).toBe(true);
    // d9 expanded is 1.8 high at the inner list's end (7.2) with 3 visible: offset 4.2.
    expect(faceState.scrollOffset("ib", 0)).toBeCloseTo(4.2, 9);
    expect(listOf(faceState, "ib", ["ob", "ib"]).offset).toBeCloseTo(4.2, 9);
    expect(faceState.scrollOffset("ob", 0)).toBe(0);
  });

  test("the wheel over the inner list scrolls the innermost overflowing list", () => {
    const faceState = createFaceStateStore();
    faceState.expand("ib");
    const r = rig({ faceState });
    // A row of ib's list (ib-local y -1.7 → outer y -3 + 0.3 * 0.9).
    r.wheel([40, -3 + 0.3 * 0.9], 100);
    expect(faceState.scrollOffset("ib", 0)).toBeCloseTo(1, 9);
    expect(faceState.scrollOffset("ob", 0)).toBe(0);
  });

  test("a sheet taller than its parent's list is scrolled to align its top", () => {
    const r = rig();
    click(r, [80 + CHEVRON_X, -3 + 0.6 * 4 + 0.3]);
    expect(r.faceState.isExpanded("sheet", "collapsed")).toBe(true);
    expect(r.faceState.scrollOffset("sb", 0)).toBeCloseTo(2.4, 9);
  });

  test("a gear is policy.onGear's, and nothing by default", () => {
    // The row gear: 0.42 square, inset 0.09 from the row's right end.
    const gear: Point = [3 - 0.09 - 0.21, 57 + 0.3];
    const plain = rig();
    expect(hitAt(plain.faceState, gear)?.target).toEqual({ type: "gear", id: "trow" });
    expect(click(plain, gear)).toEqual([]);
    expect(plain.inner.events).toEqual([]);
    const policy: FacePolicy = {
      ...defaultFacePolicy,
      onGear: (hit, ctx) => [{ type: "select", ids: [hit.object, ctx.stamp.interactionId] }],
    };
    expect(click(rig({ policy }), gear)).toEqual([{ type: "select", ids: ["trow", "i1"] }]);
  });
});

// ---------------------------------------------------------------------------
// Gestures and delegation

describe("gestures", () => {
  const GHOST = { kind: "drag_ghost" as const, items: [] };
  const MARQUEE = {
    kind: "marquee" as const,
    rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };

  function entryGesture(log: string[]): FaceGesture<unknown> {
    const g: FaceGesture<{ id: ObjectId; base: number }> = {
      id: "entry",
      start(hit, event, _input, stamp) {
        if (hit.target.type !== "entry") return null;
        log.push(`start ${event.type} ${hit.target.id} ${stamp.baseRevision}`);
        return { id: hit.target.id, base: stamp.baseRevision };
      },
      reduce(state, event) {
        log.push(event.type);
        if (event.type === "pointer_up") {
          return { state: null, effects: [{ type: "select", ids: [state.id] }] };
        }
        return { state, effects: [] };
      },
      cancel(state) {
        log.push(`cancel ${state.id}`);
        return [{ type: "notice", level: "info", text: "cancelled" }];
      },
      overlays: () => [GHOST],
    };
    return g as FaceGesture<unknown>;
  }

  test("a gesture claiming an entry receives the pointer sequence; the wrapped tool does not", () => {
    const log: string[] = [];
    const r = rig({
      gestures: [entryGesture(log)],
      respond: (e) => (e.type === "key_down" ? [{ type: "overlays", overlays: [MARQUEE] }] : []),
    });
    // The wrapped tool's overlays first.
    expect(
      r.send({ type: "key_down", key: "m", code: "KeyM", modifiers: NO_MODS, inTextField: false }),
    ).toEqual([{ type: "overlays", overlays: [MARQUEE] }]);
    const row: Point = [0, rowY(1, 0)];
    const down = r.send(ptr("pointer_down", row), { revision: 5 });
    expect(down).toEqual([{ type: "overlays", overlays: [MARQUEE, GHOST] }]);
    r.send(ptr("pointer_move", [1, rowY(3, 0)]), { revision: 6 });
    const up = r.send(ptr("pointer_up", [1, rowY(3, 0)]), { revision: 7 });
    expect(up).toEqual([
      { type: "select", ids: ["c1"] },
      { type: "overlays", overlays: [MARQUEE] },
    ]);
    expect(log).toEqual(["start pointer_down c1 5", "pointer_move", "pointer_up"]);
    expect(r.inner.events).toEqual(["key_down"]);
    // Ended: the next press on the body is the wrapped tool's again.
    click(r, BODY);
    expect(r.inner.events).toEqual(["key_down", "pointer_down", "pointer_up"]);
  });

  test("buttons inside a contained object stay withFaces' while a gesture is registered", () => {
    const log: string[] = [];
    const faceState = createFaceStateStore();
    faceState.expand("c0");
    const r = rig({ gestures: [entryGesture(log)], faceState });
    // c0 expanded at the list's top: its Go button.
    const go: Point = [-3 + 0.6 + 1.25 * 0.9, 17 + 0.8 * 0.9];
    expect(click(r, go)).toMatchObject([{ type: "extension", payload: { object: "c0" } }]);
    expect(log).toEqual([]);
  });

  test("a cancel ends the gesture with its cancel effects and its overlays", () => {
    const log: string[] = [];
    const r = rig({ gestures: [entryGesture(log)] });
    r.send(ptr("pointer_down", [0, rowY(1, 0)]));
    expect(r.cancel("escape")).toEqual([
      { type: "notice", level: "info", text: "cancelled" },
      { type: "overlays", overlays: [] },
    ]);
    expect(log).toEqual(["start pointer_down c1 5", "cancel c1"]);
    // Escape ended the gesture only: the wrapped tool was not cancelled.
    expect(r.inner.cancels).toEqual([]);
    expect(r.send(ptr("pointer_up", [0, rowY(1, 0)]))).toEqual([]);
  });

  test("without gestures, an entry row and anything else go to the wrapped tool", () => {
    const r = rig();
    click(r, [0, rowY(1, 0)]);
    click(r, BODY);
    expect(r.inner.events).toEqual(["pointer_down", "pointer_up", "pointer_down", "pointer_up"]);
  });

  test("a board or viewer change cancels the wrapped tool and any press", () => {
    const r = rig();
    r.send(ptr("pointer_down", ROLL));
    r.cancel("board_change");
    expect(r.inner.cancels).toEqual(["board_change"]);
    expect(r.send(ptr("pointer_up", ROLL))).toEqual([]);
  });
});

describe("over the real select tool", () => {
  test("a body click selects the card; a press on Roll does not", () => {
    const faces = withFaces(createSelectTool(), {
      faceState: createFaceStateStore(),
      policy: defaultFacePolicy,
    });
    let state = faces.init({});
    const run = (e: InteractionEvent, over: Partial<ToolInput> = {}) => {
      const out = faces.reduce(state, e, input(over));
      state = out.state;
      return out.effects;
    };
    run(ptr("pointer_down", BODY));
    expect(run(ptr("pointer_up", BODY))).toContainEqual({ type: "select", ids: ["card"] });
    run(ptr("pointer_down", ROLL));
    const up = run(ptr("pointer_up", ROLL));
    expect(up.some((e) => e.type === "select")).toBe(false);
    expect(up.some((e) => e.type === "extension")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The machine's wheel routing (vtt-3l6.22, amended)

describe("machine wheel routing", () => {
  function machine(faceState = createFaceStateStore()) {
    const registry = new ToolRegistry();
    registry.register(withFaces(recordingTool().tool, { faceState, policy: defaultFacePolicy }));
    const state = initMachine(registry, { tool: "select", board: BOARD, viewer: GM });
    return { registry, state, faceState };
  }
  const reducerInput = (): ReducerInput => {
    const { interactionId: _id, ...rest } = input();
    return rest;
  };

  test("a wheel over an overflowing list is claimed: no camera effect", () => {
    const { registry, state, faceState } = machine();
    const out = reduce(state, wheelAt([0, 18], 100), reducerInput(), registry);
    expect(out.effects.filter((e) => e.type === "camera")).toEqual([]);
    expect(faceState.scrollOffset("b", 0)).toBeCloseTo(1, 9);
  });

  test("a wheel elsewhere zooms the camera", () => {
    const { registry, state } = machine();
    const out = reduce(state, wheelAt([0, 0], 100), reducerInput(), registry);
    expect(out.effects.filter((e) => e.type === "camera")).toHaveLength(1);
  });
});
