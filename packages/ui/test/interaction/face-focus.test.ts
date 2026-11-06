// @vitest-environment node
/**
 * Keyboard face focus (vtt-qf5.26; DESIGN.md §4.6 On the canvas): the
 * target listing (`faceFocusTargets`), the step (`stepFaceFocus`,
 * `resolveFaceFocus`) and `withFaces`'s focus reducer around a recording
 * inner tool: Tab order, wrap, Shift+Tab, activation through the pointer's
 * path, and clearing.
 */
import type {
  ActionStateView,
  FaceElementView,
  ObjectView,
  Viewer,
  WireValue,
} from "@vtt/protocol";
import type { Point, Rect, Shape } from "@vtt/schema";
import {
  buildFaceScene,
  buildScene,
  type Camera,
  createFaceStateStore,
  defaultFacePolicy,
  type Effect,
  type FaceFocusTarget,
  type FaceStateStore,
  faceFocusTargets,
  type InteractionEvent,
  type Modifiers,
  resolveFaceFocus,
  stepFaceFocus,
  type Tool,
  type ToolInput,
  type ToolOverlay,
  type ToolState,
  toScreen,
  withFaces,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

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
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

interface Spec {
  shape?: Shape;
  cells?: Record<string, WireValue>;
  actions?: string[];
  states?: ActionStateView[];
  elements?: FaceElementView[];
  contents?: string[];
  at?: Point;
  container?: string;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {
    name: { value: text(id), kind: "literal" },
    face_up: { value: bool(true), kind: "literal" },
  };
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: "literal" };
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
    cells.container = { value: { type: "empty" }, kind: "structural" };
  }
  if (s.container) cells.container = { value: ref(s.container), kind: "structural" };
  const view: ObjectView = {
    id,
    is_template: false,
    is_character: false,
    cells,
    actions: (s.actions ?? []).map((name) => ({ name })),
    action_states:
      s.states ?? (s.actions ?? []).map((name) => ({ name, enabled: true }) as ActionStateView),
  };
  if (s.elements) view.face = { elements: s.elements };
  return view;
}

const value = (cell: string, r: Rect, index: number) =>
  ({ type: "value", cell, rect: r, index, shown: true }) as FaceElementView;
const editor = (cell: string, r: Rect, index: number) =>
  ({ type: "editor", cell, rect: r, index, shown: true }) as FaceElementView;
const button = (action: string, r: Rect, index: number) =>
  ({ type: "button", action, rect: r, index, shown: true }) as FaceElementView;
const contents = (r: Rect, index: number) =>
  ({ type: "contents", rect: r, index, shown: true }) as FaceElementView;

const ROLL_RECT: Rect = [-1.2, 0.5, 1.1, 0.45];
const TARGET_RECT: Rect = [-1.2, -1.2, 2.4, 0.4];

/** The Attack card's face, its elements listed out of reading order. */
const CARD = mk("card", {
  shape: rect(2, 3),
  at: [0, 0],
  cells: { target: { type: "empty" }, total: num(17) },
  actions: ["Roll", "Roll damage", "Apply"],
  elements: [
    button("Apply", [-1.2, 1.1, 2.4, 0.45], 0),
    button("Roll damage", [0.1, 0.5, 1.1, 0.45], 1),
    value("name", [-1.2, -1.7, 2.4, 0.4], 2),
    button("Roll", ROLL_RECT, 3),
    editor("target", TARGET_RECT, 4),
    value("total", [-1.2, -0.7, 1.1, 0.5], 5),
  ],
});

/** A row card with a Go button (6 × 2; expanded in a 6-wide list, 1.8 high). */
const rowCard = (id: string, container: string) =>
  mk(id, {
    shape: rect(6, 2),
    container,
    actions: ["Go"],
    elements: [button("Go", [-2.5, -0.5, 1.5, 0.6], 0)],
  });

/** Binder `b` at [0, 20]: a 6 × 4.8 list (8 rows of 0.6) of ten row cards. */
const ENTRIES = Array.from({ length: 10 }, (_, i) => `c${i}`);
const BINDER = mk("b", {
  shape: rect(6, 6),
  at: [0, 20],
  contents: ENTRIES,
  elements: [contents([-3, -3, 6, 4.8], 0)],
});

/** A plain token: no face of its own, no actions. */
const PLAIN = mk("plain", { shape: rect(1, 1), at: [-10, 0] });

/** `tb` at [0, 40]: a short 6 × 2 list holding `tall`, 6 × 6 with a Top and a low Go button. */
const TALL_LIST: Rect = [-3, -1, 6, 2];
const TALL_BINDER = mk("tb", {
  shape: rect(6, 3),
  at: [0, 40],
  contents: ["tall"],
  elements: [contents(TALL_LIST, 0)],
});
const TALL = mk("tall", {
  shape: rect(6, 6),
  container: "tb",
  actions: ["Top", "Go"],
  elements: [button("Top", [-2.5, -2.8, 1.5, 0.6], 0), button("Go", [-2.5, 2.2, 1.5, 0.6], 1)],
});

const VIEWS = [CARD, BINDER, PLAIN, TALL_BINDER, TALL, ...ENTRIES.map((id) => rowCard(id, "b"))];
const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));

function faceScene(faceState: FaceStateStore, viewer: Viewer = GM, selection = ["card"]) {
  return buildFaceScene(
    { views: VIEWS, covers: [], board: BOARD, viewer, selection },
    { faceState },
  );
}

/** A target as `object:kind:name`. */
function describeTarget(t: FaceFocusTarget): string {
  const x = t.hit.target;
  const name =
    x.type === "button" ? x.action : x.type === "editor" ? x.cell : "id" in x ? x.id : "";
  return `${t.hit.object}:${x.type}:${name}`;
}

describe("faceFocusTargets", () => {
  test("a face's buttons and editors in reading order, top to bottom then left to right", () => {
    const targets = faceFocusTargets(faceScene(createFaceStateStore()), "card", CAMERA);
    expect(targets.map(describeTarget)).toEqual([
      "card:editor:target",
      "card:button:Roll",
      "card:button:Roll damage",
      "card:button:Apply",
    ]);
    const roll = targets[1] as FaceFocusTarget;
    expect(roll.rect).toEqual(ROLL_RECT);
    expect(roll.hit).toMatchObject({
      object: "card",
      path: [],
      target: { type: "button", action: "Roll", enabled: true, template: false },
    });
    expect(roll.hit.rect.minX).toBeCloseTo(-1.2, 9);
    expect(roll.hit.rect.maxX).toBeCloseTo(-0.1, 9);
    expect(roll.hit.rect.minY).toBeCloseTo(0.5, 9);
    expect(roll.hit.rect.maxY).toBeCloseTo(0.95, 9);
    expect(roll.reveal).toEqual([]);
  });

  test("entries' chevrons in list order; an expanded entry's own targets follow its chevron", () => {
    const faceState = createFaceStateStore();
    const before = faceFocusTargets(faceScene(faceState, GM, ["b"]), "b", CAMERA);
    expect(before.map(describeTarget)).toEqual(ENTRIES.map((id) => `${id}:chevron:${id}`));
    faceState.expand("c1");
    const after = faceFocusTargets(faceScene(faceState, GM, ["b"]), "b", CAMERA);
    expect(after.map(describeTarget).slice(0, 4)).toEqual([
      "c0:chevron:c0",
      "c1:chevron:c1",
      "c1:button:Go",
      "c2:chevron:c2",
    ]);
    const go = after[2] as FaceFocusTarget;
    expect(go.hit.path.map((p) => p.container)).toEqual(["b"]);
  });

  test("an entry scrolled out of its list carries the scroll that reveals it", () => {
    const targets = faceFocusTargets(faceScene(createFaceStateStore(), GM, ["b"]), "b", CAMERA);
    expect(targets[0]?.reveal).toMatchObject([{ container: "b", element: 0, offset: 0 }]);
    expect(targets[0]?.reveal[0]?.max).toBeCloseTo(1.2, 9);
    const last = targets[9] as FaceFocusTarget;
    expect(last.reveal).toHaveLength(1);
    expect(last.reveal[0]?.offset).toBeCloseTo(1.2, 9);
  });

  test("nothing for an object without a drawn face target or not on the board", () => {
    const scene = faceScene(createFaceStateStore());
    expect(faceFocusTargets(scene, "plain", CAMERA)).toEqual([]);
    expect(faceFocusTargets(scene, "c0", CAMERA)).toEqual([]);
  });
});

describe("stepFaceFocus and resolveFaceFocus", () => {
  const targets = faceFocusTargets(faceScene(createFaceStateStore()), "card", CAMERA);
  const keys = targets.map((t) => t.key);

  test("Tab from nothing is the first; Shift+Tab from nothing the last", () => {
    expect(stepFaceFocus(targets, "card", null, false)).toEqual({
      object: "card",
      key: keys[0],
      index: 0,
    });
    expect(stepFaceFocus(targets, "card", null, true)?.index).toBe(3);
  });

  test("Tab walks forward and wraps; Shift+Tab walks back and wraps", () => {
    let focus = stepFaceFocus(targets, "card", null, false);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      focus = stepFaceFocus(targets, "card", focus, false);
      seen.push(focus?.index ?? -1);
    }
    expect(seen).toEqual([1, 2, 3, 0, 1]);
    focus = stepFaceFocus(
      targets,
      "card",
      { object: "card", key: keys[0] as string, index: 0 },
      true,
    );
    expect(focus?.index).toBe(3);
  });

  test("a focus on another object starts over; no targets is no focus", () => {
    const other = { object: "b", key: "x", index: 2 };
    expect(stepFaceFocus(targets, "card", other, false)?.index).toBe(0);
    expect(stepFaceFocus([], "card", null, false)).toBeNull();
  });

  test("a vanished key resolves to the target now at its index, clamped", () => {
    const gone = { object: "card", key: "gone", index: 7 };
    expect(resolveFaceFocus(targets, gone)?.focus).toEqual({
      object: "card",
      key: keys[3],
      index: 3,
    });
    expect(
      resolveFaceFocus(targets, { object: "card", key: keys[2] as string, index: 0 })?.focus.index,
    ).toBe(2);
    expect(resolveFaceFocus([], gone)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withFaces's focus reducer

function input(over: Partial<ToolInput> = {}): ToolInput {
  const viewer = over.viewer ?? GM;
  const selection = over.selection ?? ["card"];
  return {
    scene: buildScene({ views: VIEWS, covers: [], board: BOARD, viewer, selection }),
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer,
    revision: 5,
    camera: CAMERA,
    selection,
    views: (id) => BY_ID.get(id) ?? null,
    interactionId: "i1",
    ...over,
  };
}

const keyDown = (key: string, modifiers: Partial<Modifiers> = {}): InteractionEvent => ({
  type: "key_down",
  key,
  code: key === " " ? "Space" : key,
  modifiers: { ...NO_MODS, ...modifiers },
  inTextField: false,
});

function ptr(type: "pointer_down" | "pointer_up", board: Point): InteractionEvent {
  return {
    type,
    pointerId: 1,
    screen: toScreen(CAMERA, board, VIEWPORT),
    board,
    button: 0,
    buttons: type === "pointer_up" ? 0 : 1,
    modifiers: NO_MODS,
  };
}

function rig(faceState: FaceStateStore = createFaceStateStore()) {
  const events: InteractionEvent["type"][] = [];
  const cancels: string[] = [];
  const inner: Tool<number, "select"> = {
    id: "select",
    init: (options) => ({ tool: "select", options, phase: 0 }),
    cursor: () => "default",
    reduce(state, event) {
      events.push(event.type);
      return { state: { ...state, phase: state.phase + 1 }, effects: [] };
    },
    cancel(state, reason) {
      cancels.push(reason);
      return { state, effects: [] };
    },
  };
  const faces = withFaces(inner, {
    faceState,
    policy: defaultFacePolicy,
  }) as unknown as Tool<unknown, "select">;
  let state: ToolState<unknown, "select"> = faces.init({});
  return {
    events,
    cancels,
    faceState,
    send(event: InteractionEvent, over: Partial<ToolInput> = {}): Effect[] {
      const out = faces.reduce(state, event, input(over));
      state = out.state;
      return out.effects;
    },
    cancel(reason: "escape" | "tool_switch"): Effect[] {
      const out = faces.cancel(state, reason);
      state = out.state;
      return out.effects;
    },
  };
}

/** The face_focus rects of the last overlays effect of `effects`, or undefined without one. */
function ring(effects: readonly Effect[]): Rect[] | undefined {
  const last = effects.filter((e) => e.type === "overlays").at(-1);
  if (last?.type !== "overlays") return undefined;
  return last.overlays
    .filter((o): o is Extract<ToolOverlay, { kind: "face_focus" }> => o.kind === "face_focus")
    .map((o) => o.rect);
}

const handled = (effects: readonly Effect[]) => effects.some((e) => e.type === "key_handled");

describe("withFaces: Tab, Shift+Tab, Enter and Space", () => {
  test("Tab focuses the selected card's targets in order, wrapping, each answered and ringed", () => {
    const r = rig();
    const first = r.send(keyDown("Tab"));
    expect(handled(first)).toBe(true);
    expect(ring(first)).toEqual([TARGET_RECT]);
    expect(ring(r.send(keyDown("Tab")))).toEqual([ROLL_RECT]);
    r.send(keyDown("Tab"));
    r.send(keyDown("Tab"));
    expect(ring(r.send(keyDown("Tab")))).toEqual([TARGET_RECT]);
    expect(ring(r.send(keyDown("Tab", { shift: true })))).toEqual([[-1.2, 1.1, 2.4, 0.45]]);
    // None of it reached the wrapped tool.
    expect(r.events).toEqual([]);
  });

  test("Enter on the focused Roll button emits exactly what a click on it does", () => {
    const clicked = rig();
    const centre: Point = [ROLL_RECT[0] + ROLL_RECT[2] / 2, ROLL_RECT[1] + ROLL_RECT[3] / 2];
    clicked.send(ptr("pointer_down", centre));
    const viaPointer = clicked.send(ptr("pointer_up", centre));
    expect(viaPointer).toMatchObject([
      { type: "extension", payload: { object: "card", action: "Roll" } },
    ]);

    const r = rig();
    r.send(keyDown("Tab"));
    r.send(keyDown("Tab"));
    const out = r.send(keyDown("Enter"));
    expect(out.filter((e) => e.type !== "key_handled")).toEqual(viaPointer);
    expect(handled(out)).toBe(true);
  });

  test("Space on a focused editor opens the editor over its rect", () => {
    const r = rig();
    r.send(keyDown("Tab"));
    const out = r.send(keyDown(" "));
    expect(out).toMatchObject([
      {
        type: "open_editor",
        stamp: { interactionId: "i1", board: BOARD, viewer: GM, baseRevision: 5 },
        object: "card",
        cell: "target",
      },
      { type: "key_handled" },
    ]);
  });

  test("Space on a focused chevron expands the entry; Tab then reaches its button", () => {
    const r = rig();
    const sel = { selection: ["b"] };
    r.send(keyDown("Tab"), sel);
    r.send(keyDown("Tab"), sel);
    expect(r.faceState.isExpanded("c1", "collapsed")).toBe(false);
    const out = r.send(keyDown(" "), sel);
    expect(handled(out)).toBe(true);
    expect(r.faceState.isExpanded("c1", "collapsed")).toBe(true);
    // The focus stays on c1's chevron; the next Tab is c1's Go button.
    const go = r.send(keyDown("Tab"), sel);
    const goTarget = faceFocusTargets(faceScene(r.faceState, GM, ["b"]), "b", CAMERA)[2];
    expect(goTarget && describeTarget(goTarget)).toBe("c1:button:Go");
    expect(ring(go)).toEqual([goTarget?.rect]);
  });

  test("a character viewer's Tab skips the editor it could not edit by clicking", () => {
    const r = rig();
    expect(ring(r.send(keyDown("Tab"), { viewer: ALDRIC }))).toEqual([ROLL_RECT]);
  });

  test("Tab entering the last entry scrolls its list to reveal it", () => {
    const r = rig();
    const sel = { selection: ["b"] };
    r.send(keyDown("Tab", { shift: true }), sel);
    expect(r.faceState.scrollOffset("b", 0)).toBeCloseTo(1.2, 9);
  });
});

describe("withFaces: when Tab and Enter are not the focus's", () => {
  test("without a selection, or with several, Tab and Enter go to the wrapped tool unanswered", () => {
    const r = rig();
    for (const selection of [[], ["card", "b"]]) {
      expect(handled(r.send(keyDown("Tab"), { selection }))).toBe(false);
      expect(handled(r.send(keyDown("Enter"), { selection }))).toBe(false);
    }
    expect(r.events).toEqual(["key_down", "key_down", "key_down", "key_down"]);
  });

  test("a selected object without targets leaves Tab to the wrapped tool", () => {
    const r = rig();
    expect(handled(r.send(keyDown("Tab"), { selection: ["plain"] }))).toBe(false);
    expect(r.events).toEqual(["key_down"]);
  });

  test("Enter or Space with no focus, and Ctrl+Tab, are the wrapped tool's", () => {
    const r = rig();
    expect(handled(r.send(keyDown("Enter")))).toBe(false);
    expect(handled(r.send(keyDown(" ")))).toBe(false);
    expect(handled(r.send(keyDown("Tab", { ctrl: true })))).toBe(false);
    expect(r.events).toEqual(["key_down", "key_down", "key_down"]);
  });
});

describe("withFaces: clearing the focus", () => {
  test("Escape clears the focus first and only that; the next Escape reaches the wrapped tool", () => {
    const r = rig();
    r.send(keyDown("Tab"));
    expect(ring(r.cancel("escape"))).toEqual([]);
    expect(r.cancels).toEqual([]);
    expect(handled(r.send(keyDown("Enter")))).toBe(false);
    r.cancel("escape");
    expect(r.cancels).toEqual(["escape"]);
  });

  test("a pointer press clears it", () => {
    const r = rig();
    r.send(keyDown("Tab"));
    expect(ring(r.send(ptr("pointer_down", [-10, 0])))).toEqual([]);
    r.send(ptr("pointer_up", [-10, 0]));
    // The next Tab starts over at the first target.
    expect(ring(r.send(keyDown("Tab")))).toEqual([TARGET_RECT]);
  });

  test("a selection change clears it at the next event", () => {
    const r = rig();
    r.send(keyDown("Tab"));
    r.send(keyDown("Tab"));
    expect(ring(r.send(keyDown("a"), { selection: [] }))).toEqual([]);
    expect(ring(r.send(keyDown("Tab")))).toEqual([TARGET_RECT]);
  });

  test("a tool switch clears it", () => {
    const r = rig();
    r.send(keyDown("Tab"));
    expect(ring(r.cancel("tool_switch"))).toEqual([]);
    expect(r.cancels).toEqual(["tool_switch"]);
  });
});

describe("a target in an expanded entry taller than its list", () => {
  test("Tab to the low button scrolls the list to that button, and the ring lies inside the list", () => {
    const faceState = createFaceStateStore();
    faceState.expand("tall");
    const sel = { selection: ["tb"] };
    const listed = faceFocusTargets(faceScene(faceState, GM, ["tb"]), "tb", CAMERA);
    expect(listed.map(describeTarget)).toEqual([
      "tall:chevron:tall",
      "tall:button:Top",
      "tall:button:Go",
    ]);
    // The row's own reveal (its top) would leave Go clipped; Go's reveal scrolls past it.
    expect(listed[2]?.reveal[0]?.offset).toBeGreaterThan(0);

    const r = rig(faceState);
    r.send(keyDown("Tab"), sel);
    r.send(keyDown("Tab"), sel);
    expect(faceState.scrollOffset("tb", 0)).toBe(0);
    const out = r.send(keyDown("Tab"), sel);
    expect(faceState.scrollOffset("tb", 0)).toBeGreaterThan(0);
    const [ringRect] = ring(out) ?? [];
    expect(ringRect).toBeDefined();
    if (ringRect === undefined) return;
    const eps = 1e-9;
    expect(ringRect[1]).toBeGreaterThanOrEqual(TALL_LIST[1] - eps);
    expect(ringRect[1] + ringRect[3]).toBeLessThanOrEqual(TALL_LIST[1] + TALL_LIST[3] + eps);
    // Enter presses the button now in view.
    expect(r.send(keyDown("Enter"), sel)).toMatchObject([
      { type: "extension", payload: { object: "tall", action: "Go" } },
      { type: "key_handled" },
    ]);
  });

  test("Shift+Tab back to the chevron scrolls the list back to the row's top", () => {
    const faceState = createFaceStateStore();
    faceState.expand("tall");
    const sel = { selection: ["tb"] };
    const r = rig(faceState);
    r.send(keyDown("Tab", { shift: true }), sel);
    expect(faceState.scrollOffset("tb", 0)).toBeGreaterThan(0);
    r.send(keyDown("Tab"), sel);
    expect(faceState.scrollOffset("tb", 0)).toBe(0);
  });
});
