// @vitest-environment node
/**
 * The select tool's keyboard commands (vtt-3l6.7): delete, flip, bring to
 * front, send to back, nudge. Each captures a stamp at the key press. And
 * the app's zoom keys (M6-D11): "+" and "=" zoom in, "-" zooms out, about
 * the viewport centre.
 */
import type { CellView, ObjectView, Viewer, WireResult, WireValue } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import {
  appKeyActions,
  buildScene,
  type Camera,
  type Effect,
  KEY_BINDINGS,
  KEY_ZOOM_FACTOR,
  type KeyDownEvent,
  keyCommand,
  type Modifiers,
  NUDGE_STEP,
  NUDGE_STEP_LARGE,
  type ReducerInput,
  selectKeyEffects,
  selectTool,
  type TableSession,
  type ToolInput,
  type UiStore,
  zoomStep,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };

const num = (value: number): WireValue => ({ type: "number", value });

function obj(
  id: string,
  at: Point,
  z: CellView | null,
  extra: { name?: string; faceUp?: WireResult | null; board?: string } = {},
): ObjectView {
  const cells: Record<string, CellView> = {
    board: { value: { type: "ref", object: extra.board ?? BOARD }, kind: "structural" },
    container: { value: { type: "empty" }, kind: "structural" },
    position: { value: { type: "list", items: [num(at[0]), num(at[1])] }, kind: "literal" },
    rotation: { value: num(0), kind: "structural" },
    shape: { value: { type: "shape", shape: { type: "circle", radius: 0.5 } }, kind: "literal" },
    is_zone: { value: { type: "boolean", value: false }, kind: "structural" },
  };
  if (z !== null) cells.z = z;
  if (extra.faceUp !== null)
    cells.face_up = { value: extra.faceUp ?? { type: "boolean", value: true }, kind: "literal" };
  if (extra.name) cells.name = { value: { type: "text", value: extra.name }, kind: "literal" };
  return { id, is_template: false, is_character: false, cells, actions: [] };
}

const literalZ = (z: number): CellView => ({ value: num(z), kind: "literal" });

const VIEWS: ObjectView[] = [
  obj("a", [1, 1], literalZ(3), { name: "Alpha" }),
  obj("b", [2, 2], literalZ(5), { name: "Beta", faceUp: { type: "boolean", value: false } }),
  // A formula z lower than every literal: ignored by send to back.
  obj("f", [3, 3], { value: num(-10), kind: "formula", source: "-10" }),
  // An overridden formula z counts as literal.
  obj("o", [4, 4], { value: num(-2), kind: "formula", source: "1", overridden: true }),
  // No z cell: counts as 0. Face up absent: the default, true.
  obj("n", [5, 5], null, { faceUp: null }),
  // Not on the active board.
  obj("far", [0, 0], literalZ(-50), { board: "other" }),
];
const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));
const SCENE = buildScene({
  views: VIEWS.filter((v) => v.id !== "far"),
  covers: [],
  board: BOARD,
  viewer: GM,
});

function makeInput(selection: ObjectId[], over: Partial<ReducerInput> = {}): ToolInput {
  return {
    scene: SCENE,
    viewport: { width: 800, height: 600, dpr: 1 },
    activeBoard: BOARD,
    viewer: GM,
    revision: 4,
    camera: { x: 0, y: 0, zoom: 1 },
    selection,
    views: (id) => BY_ID.get(id) ?? null,
    ...over,
    interactionId: "k1",
  };
}

const press = (key: string, modifiers: Modifiers = NO_MODS): KeyDownEvent => ({
  type: "key_down",
  key,
  code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
  modifiers,
  inTextField: false,
});

function onlyWrite(effects: Effect[] | null) {
  expect(effects).not.toBeNull();
  const writes = (effects ?? []).filter((e) => e.type === "write");
  expect(writes).toHaveLength(1);
  const w = writes[0];
  if (w?.type !== "write") throw new Error("unreachable");
  expect(w.stamp).toEqual({ interactionId: "k1", board: BOARD, viewer: GM, baseRevision: 4 });
  expect(w.continuations).toEqual([]);
  return w;
}

const position = (x: number, y: number) => ({
  type: "list" as const,
  items: [num(x), num(y)],
});

describe("selectKeyEffects", () => {
  test.each(["Delete", "Backspace"])("%s removes every selected object", (key) => {
    const w = onlyWrite(selectKeyEffects(press(key), makeInput(["a", "b"])));
    expect(w.ops).toEqual([
      { type: "remove", object: "a" },
      { type: "remove", object: "b" },
    ]);
    expect(w.label).toBe("Delete 2 objects");
    expect(onlyWrite(selectKeyEffects(press(key), makeInput(["a"]))).label).toBe("Delete Alpha");
  });

  test("F toggles face_up per object", () => {
    const w = onlyWrite(selectKeyEffects(press("f"), makeInput(["a", "b", "n"])));
    expect(w.ops).toEqual([
      { type: "set_value", object: "a", cell: "face_up", value: { type: "boolean", value: false } },
      { type: "set_value", object: "b", cell: "face_up", value: { type: "boolean", value: true } },
      { type: "set_value", object: "n", cell: "face_up", value: { type: "boolean", value: false } },
    ]);
    expect(w.label).toBe("Flip 3 objects");
    expect(onlyWrite(selectKeyEffects(press("F"), makeInput(["a"]))).label).toBe("Flip Alpha");
  });

  test("] brings to front: a move to its own position, back to front", () => {
    const w = onlyWrite(selectKeyEffects(press("]"), makeInput(["b", "a"])));
    expect(w.ops).toEqual([
      { type: "move", object: "a", to: { type: "board", board: BOARD, position: [1, 1] } },
      { type: "move", object: "b", to: { type: "board", board: BOARD, position: [2, 2] } },
    ]);
    expect(w.label).toBe("Bring 2 objects to front");
  });

  test("[ sends to back: z 1 less than the lowest literal z on the board", () => {
    // Literal z on the board: 3, 5, -2 (overridden), 0 (absent); the formula -10 and the
    // other board's -50 do not count.
    const w = onlyWrite(selectKeyEffects(press("["), makeInput(["a"])));
    expect(w.ops).toEqual([{ type: "set_value", object: "a", cell: "z", value: num(-3) }]);
    expect(w.label).toBe("Send Alpha to back");
  });

  test("[ counts board objects skipped by the scene (invalid position) but not contained or other-board ones", () => {
    const bad = obj("bad", [0, 0], literalZ(-100));
    (bad.cells as Record<string, CellView>).position = {
      value: { type: "text", value: "?" },
      kind: "literal",
    };
    const held = obj("held", [0, 0], literalZ(-500));
    (held.cells as Record<string, CellView>).container = {
      value: { type: "ref", object: "a" },
      kind: "structural",
    };
    const views = [
      VIEWS[0] as ObjectView,
      VIEWS[1] as ObjectView,
      bad,
      held,
      VIEWS[5] as ObjectView,
    ];
    const scene = buildScene({ views, covers: [], board: BOARD, viewer: GM });
    expect([...scene.skipped].sort()).toEqual(["bad", "far", "held"]);
    const byId = new Map(views.map((v) => [v.id, v]));
    const w = onlyWrite(
      selectKeyEffects(
        press("["),
        makeInput(["a"], { scene, views: (id) => byId.get(id) ?? null }),
      ),
    );
    expect(w.ops).toEqual([{ type: "set_value", object: "a", cell: "z", value: num(-101) }]);
  });

  test("[ with several objects keeps their order below the lowest", () => {
    const w = onlyWrite(selectKeyEffects(press("["), makeInput(["b", "a"])));
    expect(w.ops).toEqual([
      { type: "set_value", object: "a", cell: "z", value: num(-4) },
      { type: "set_value", object: "b", cell: "z", value: num(-3) },
    ]);
  });

  test.each<[string, Modifiers, Point]>([
    ["ArrowRight", NO_MODS, [1 + NUDGE_STEP, 1]],
    ["ArrowLeft", NO_MODS, [1 - NUDGE_STEP, 1]],
    ["ArrowUp", NO_MODS, [1, 1 - NUDGE_STEP]],
    ["ArrowDown", NO_MODS, [1, 1 + NUDGE_STEP]],
    ["ArrowRight", { ...NO_MODS, shift: true }, [1 + NUDGE_STEP_LARGE, 1]],
    ["ArrowUp", { ...NO_MODS, shift: true }, [1, 1 - NUDGE_STEP_LARGE]],
  ])("%s nudges via set_value position", (key, mods, [x, y]) => {
    const w = onlyWrite(selectKeyEffects(press(key, mods), makeInput(["a"])));
    expect(w.ops).toEqual([
      { type: "set_value", object: "a", cell: "position", value: position(x, y) },
    ]);
    expect(w.label).toBe("Nudge Alpha");
  });

  test("the nudge steps are 0.1 and 1 unit", () => {
    expect(NUDGE_STEP).toBe(0.1);
    expect(NUDGE_STEP_LARGE).toBe(1);
  });

  test("nothing selected, an unknown key, Ctrl or Meta, or no active board: no command", () => {
    expect(selectKeyEffects(press("Delete"), makeInput([]))).toBeNull();
    expect(selectKeyEffects(press("q"), makeInput(["a"]))).toBeNull();
    expect(selectKeyEffects(press("f", { ...NO_MODS, ctrl: true }), makeInput(["a"]))).toBeNull();
    expect(selectKeyEffects(press("f", { ...NO_MODS, meta: true }), makeInput(["a"]))).toBeNull();
    expect(selectKeyEffects(press("Delete"), makeInput(["a"], { activeBoard: null }))).toBeNull();
  });

  test("the select tool runs the key commands on key_down", () => {
    const state = selectTool.init({});
    const out = selectTool.reduce(state, press("Delete"), makeInput(["a"]));
    expect(onlyWrite(out.effects).ops).toEqual([{ type: "remove", object: "a" }]);
  });
});

describe("the zoom keys (M6-D11)", () => {
  const press = (
    key: string,
    mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {},
  ) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...mods,
  });

  test('"+" (with or without Shift) and "=" zoom in; "-" zooms out', () => {
    expect(keyCommand(press("+", { shiftKey: true }))).toEqual({ type: "zoom", direction: "in" });
    expect(keyCommand(press("+"))).toEqual({ type: "zoom", direction: "in" });
    expect(keyCommand(press("="))).toEqual({ type: "zoom", direction: "in" });
    expect(keyCommand(press("-"))).toEqual({ type: "zoom", direction: "out" });
  });

  test("they are KEY_BINDINGS rows, so the help and README list them", () => {
    const zoom = KEY_BINDINGS.filter((b) => b.command.type === "zoom");
    expect(zoom.map((b) => [b.keys, b.label])).toEqual([
      ["+", "Zoom in"],
      ["=", "Zoom in (the + key without Shift)"],
      ["-", "Zoom out"],
    ]);
  });

  test("Ctrl/Cmd or Alt with them is left to the browser (its own page zoom)", () => {
    expect(keyCommand(press("=", { ctrlKey: true }))).toBeNull();
    expect(keyCommand(press("-", { metaKey: true }))).toBeNull();
    expect(keyCommand(press("+", { altKey: true }))).toBeNull();
  });

  test("zoomStep zooms by KEY_ZOOM_FACTOR about the viewport centre, clamped", () => {
    const viewport = { width: 800, height: 600, dpr: 1 };
    const camera: Camera = { x: 3, y: -2, zoom: 1 };
    expect(KEY_ZOOM_FACTOR).toBeGreaterThan(1);
    expect(zoomStep(camera, viewport, "in")).toEqual({ x: 3, y: -2, zoom: KEY_ZOOM_FACTOR });
    expect(zoomStep(camera, viewport, "out").zoom).toBeCloseTo(1 / KEY_ZOOM_FACTOR, 12);
    expect(zoomStep(camera, viewport, "out").x).toBeCloseTo(3, 12);
    expect(zoomStep({ x: 0, y: 0, zoom: 8 }, viewport, "in").zoom).toBe(8);
  });

  test("the app's zoom action sets the camera from the store's camera and viewport", () => {
    let camera: Camera = { x: 1, y: 1, zoom: 2 };
    const viewport = { width: 400, height: 300, dpr: 1 };
    const ui = {
      getState: () => ({ camera, viewport }),
      setCamera: (next: Camera) => {
        camera = next;
      },
    } as unknown as UiStore;
    const actions = appKeyActions({} as TableSession, ui, () => {});
    actions.zoom?.("in");
    expect(camera).toEqual({ x: 1, y: 1, zoom: 2 * KEY_ZOOM_FACTOR });
    actions.zoom?.("out");
    expect(camera.zoom).toBeCloseTo(2, 12);
  });
});
