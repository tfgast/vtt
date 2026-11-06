// @vitest-environment node
/**
 * Touch gestures in the interaction machine (vtt-qf5.18; DESIGN.md §8.1,
 * M6-D40): two touch pointers pan by their midpoint and zoom by their
 * distance about it; a touch held still for `LONG_PRESS_MS` is a
 * double-click at its point. Neither selects nor moves anything, driven
 * through the real select tool on a scene with an object under the fingers.
 */
import type { CellView, ObjectView, Viewer, WireResult, WireValue } from "@vtt/protocol";
import type { Point } from "@vtt/schema";
import {
  buildScene,
  type Camera,
  type Effect,
  type InteractionEvent,
  initMachine,
  LONG_PRESS_SLOP_PX,
  type MachineState,
  type Modifiers,
  pinchCamera,
  type ReducerInput,
  reduce,
  type Scene,
  selectTool,
  ToolRegistry,
  toBoard,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };

const num = (value: number): WireValue => ({ type: "number", value });

function token(id: string, at: Point): ObjectView {
  const values: Record<string, WireResult> = {
    board: { type: "ref", object: BOARD },
    container: { type: "empty" },
    position: { type: "list", items: [num(at[0]), num(at[1])] },
    rotation: num(0),
    z: num(1),
    shape: { type: "shape", shape: { type: "circle", radius: 1 } },
    is_zone: { type: "boolean", value: false },
    face_up: { type: "boolean", value: true },
    name: { type: "text", value: id },
  };
  const cells: Record<string, CellView> = {};
  for (const [name, value] of Object.entries(values)) cells[name] = { value, kind: "literal" };
  return { id, is_template: false, is_character: false, cells, actions: [] };
}

const VIEWS = [token("tok", [0, 0])];
const SCENE: Scene = buildScene({ views: VIEWS, covers: [], board: BOARD, viewer: GM });

/** A machine over the real select tool, driven as the runtime drives it. */
class Driver {
  readonly registry = new ToolRegistry();
  state: MachineState;
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  selection: string[] = [];
  /** Every effect, in order. */
  readonly effects: Effect[] = [];
  /** How many reductions cancelled the active tool. */
  cancels = 0;

  constructor() {
    this.registry.register(selectTool);
    this.state = initMachine(this.registry, { tool: "select", board: BOARD, viewer: GM });
  }

  input(): ReducerInput {
    return {
      scene: SCENE,
      viewport: VIEWPORT,
      activeBoard: BOARD,
      viewer: GM,
      revision: 3,
      camera: this.camera,
      selection: this.selection,
      views: (id) => VIEWS.find((v) => v.id === id) ?? null,
      snap: false,
    };
  }

  send(event: InteractionEvent): Effect[] {
    const out = reduce(this.state, event, this.input(), this.registry);
    this.state = out.state;
    if (out.cancelled === true) this.cancels++;
    for (const e of out.effects) {
      if (e.type === "camera") this.camera = e.camera;
      if (e.type === "select") this.selection = [...e.ids];
    }
    this.effects.push(...out.effects);
    return out.effects;
  }

  pointer(
    type: "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel",
    pointerId: number,
    screen: Point,
    pointerType = "touch",
  ): Effect[] {
    return this.send({
      type,
      pointerId,
      pointerType,
      screen,
      board: toBoard(this.camera, screen, VIEWPORT),
      button: type === "pointer_move" ? -1 : 0,
      buttons: type === "pointer_up" || type === "pointer_cancel" ? 0 : 1,
      modifiers: NO_MODS,
    });
  }

  /** Effects other than camera moves and the tool's overlay and preview clears. */
  writesOrSelections(): Effect[] {
    return this.effects.filter(
      (e) =>
        e.type === "select" ||
        e.type === "write" ||
        e.type === "open_editor" ||
        (e.type === "previews" && e.previews.size > 0),
    );
  }
}

/** The token's screen point under the default camera. */
const TOKEN: Point = toScreen({ x: 0, y: 0, zoom: 1 }, [0, 0], VIEWPORT);
const add = (p: Point, dx: number, dy: number): Point => [p[0] + dx, p[1] + dy];

describe("two-finger pan", () => {
  test("two touch pointers moving together pan by their midpoint's movement", () => {
    const d = new Driver();
    const a0 = add(TOKEN, -50, 0);
    const b0 = add(TOKEN, 50, 0);
    d.pointer("pointer_down", 1, a0);
    d.pointer("pointer_down", 2, b0);
    const boardUnderMid = toBoard(d.camera, TOKEN, VIEWPORT);
    d.pointer("pointer_move", 1, add(a0, 30, 40));
    d.pointer("pointer_move", 2, add(b0, 30, 40));
    // The board point first under the midpoint follows it; the zoom is unchanged.
    expect(d.camera.zoom).toBeCloseTo(1, 12);
    const after = toBoard(d.camera, add(TOKEN, 30, 40), VIEWPORT);
    expect(after[0]).toBeCloseTo(boardUnderMid[0], 9);
    expect(after[1]).toBeCloseTo(boardUnderMid[1], 9);
    d.pointer("pointer_up", 1, add(a0, 30, 40));
    d.pointer("pointer_up", 2, add(b0, 30, 40));
    expect(d.writesOrSelections()).toEqual([]);
  });

  test("the first touch's press on an object is cancelled when the second lands", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    expect(d.state.tools.select?.phase).toMatchObject({ gesture: { kind: "press" } });
    d.pointer("pointer_down", 2, add(TOKEN, 100, 0));
    expect(d.cancels).toBe(1);
    expect(d.state.tools.select?.phase).toMatchObject({ gesture: { kind: "idle" } });
    // Moving both well past the drag threshold neither moves nor selects the token.
    for (let i = 1; i <= 5; i++) {
      d.pointer("pointer_move", 1, add(TOKEN, 20 * i, 10 * i));
      d.pointer("pointer_move", 2, add(TOKEN, 100 + 20 * i, 10 * i));
    }
    d.pointer("pointer_up", 2, add(TOKEN, 200, 50));
    d.pointer("pointer_up", 1, add(TOKEN, 100, 50));
    expect(d.writesOrSelections()).toEqual([]);
    expect(d.state.tools.select?.phase).toMatchObject({ gesture: { kind: "idle" } });
  });
});

describe("a selection the first touch made is undone", () => {
  test("touch a token, drag it 12 px, add a finger, release both: it is not selected", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    d.pointer("pointer_move", 1, add(TOKEN, 12, 0));
    expect(d.selection).toEqual(["tok"]);
    d.pointer("pointer_down", 2, add(TOKEN, 100, 0));
    expect(d.selection).toEqual([]);
    d.pointer("pointer_up", 2, add(TOKEN, 100, 0));
    d.pointer("pointer_up", 1, add(TOKEN, 12, 0));
    expect(d.selection).toEqual([]);
    expect(d.effects.some((e) => e.type === "write")).toBe(false);
  });

  test("an earlier selection is put back", () => {
    const d = new Driver();
    d.selection = ["other"];
    d.pointer("pointer_down", 1, TOKEN);
    d.pointer("pointer_move", 1, add(TOKEN, 12, 0));
    d.pointer("pointer_down", 2, add(TOKEN, 100, 0));
    expect(d.selection).toEqual(["other"]);
  });

  test("an unchanged selection gets no select effect", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, add(TOKEN, 200, 0));
    d.pointer("pointer_down", 2, add(TOKEN, 300, 0));
    expect(d.effects.some((e) => e.type === "select")).toBe(false);
  });
});

describe("Escape during a lone touch", () => {
  test("ends it: no long press, and its moves and release are consumed", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    d.send({
      type: "key_down",
      key: "Escape",
      code: "Escape",
      modifiers: NO_MODS,
      inTextField: false,
    });
    expect(d.state.touch.press).toBeNull();
    const before = d.effects.length;
    expect(d.send({ type: "long_press", pointerId: 1 })).toEqual([]);
    d.pointer("pointer_move", 1, add(TOKEN, 50, 0));
    d.pointer("pointer_up", 1, add(TOKEN, 50, 0));
    expect(d.effects.slice(before)).toEqual([]);
  });
});

describe("pinch zoom", () => {
  test("moving apart zooms by the distance ratio about the midpoint", () => {
    const d = new Driver();
    const mid: Point = [300, 200];
    d.pointer("pointer_down", 1, add(mid, -40, 0));
    d.pointer("pointer_down", 2, add(mid, 40, 0));
    const boardUnderMid = toBoard(d.camera, mid, VIEWPORT);
    d.pointer("pointer_move", 1, add(mid, -80, 0));
    d.pointer("pointer_move", 2, add(mid, 80, 0));
    expect(d.camera.zoom).toBeCloseTo(2, 12);
    const after = toBoard(d.camera, mid, VIEWPORT);
    expect(after[0]).toBeCloseTo(boardUnderMid[0], 9);
    expect(after[1]).toBeCloseTo(boardUnderMid[1], 9);
    expect(d.writesOrSelections()).toEqual([]);
  });

  test("moving together zooms out", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, [100, 300]);
    d.pointer("pointer_down", 2, [500, 300]);
    d.pointer("pointer_move", 2, [200, 300]);
    expect(d.camera.zoom).toBeCloseTo(0.25, 12);
  });

  test("the zoom is clamped to the camera limits", () => {
    const d = new Driver();
    d.camera = { x: 0, y: 0, zoom: 8 };
    d.pointer("pointer_down", 1, [390, 300]);
    d.pointer("pointer_down", 2, [410, 300]);
    d.pointer("pointer_move", 2, [790, 300]);
    expect(d.camera.zoom).toBe(8);
  });

  test("pinchCamera pans by the midpoint and zooms about the new midpoint", () => {
    const camera: Camera = { x: 2, y: -1, zoom: 1.5 };
    const a0: Point = [100, 100];
    const b0: Point = [200, 100];
    const a1: Point = [90, 150];
    const b1: Point = [250, 150];
    const before = toBoard(camera, [150, 100], VIEWPORT);
    const next = pinchCamera(camera, [a0, b0], [a1, b1], VIEWPORT);
    expect(next.zoom).toBeCloseTo(1.5 * 1.6, 12);
    const after = toBoard(next, [170, 150], VIEWPORT);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });
});

describe("lifting one finger", () => {
  test("the other finger does nothing until it lifts", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    d.pointer("pointer_down", 2, add(TOKEN, 100, 0));
    d.pointer("pointer_up", 2, add(TOKEN, 100, 0));
    const camera = d.camera;
    const before = d.effects.length;
    d.pointer("pointer_move", 1, add(TOKEN, 60, 60));
    d.pointer("pointer_move", 1, add(TOKEN, 120, 90));
    d.pointer("pointer_up", 1, add(TOKEN, 120, 90));
    expect(d.effects.slice(before)).toEqual([]);
    expect(d.camera).toBe(camera);
    expect(d.writesOrSelections()).toEqual([]);
    // The next single touch reaches the tool again.
    d.pointer("pointer_down", 3, TOKEN);
    expect(d.state.tools.select?.phase).toMatchObject({ gesture: { kind: "press" } });
  });

  test("a finger put back down resumes the pinch", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, [300, 300]);
    d.pointer("pointer_down", 2, [400, 300]);
    d.pointer("pointer_up", 2, [400, 300]);
    d.pointer("pointer_down", 3, [500, 300]);
    d.pointer("pointer_move", 3, [700, 300]);
    expect(d.camera.zoom).toBeCloseTo(2, 12);
    expect(d.writesOrSelections()).toEqual([]);
  });

  test("a pointer_cancel ends the gesture like a lift", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, [300, 300]);
    d.pointer("pointer_down", 2, [400, 300]);
    d.pointer("pointer_cancel", 2, [400, 300]);
    const before = d.effects.length;
    d.pointer("pointer_move", 1, [350, 350]);
    expect(d.effects.slice(before)).toEqual([]);
  });
});

describe("long press", () => {
  test("a held touch becomes a double-click at its point and nothing follows", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    expect(d.state.touch.press).toMatchObject({ pointerId: 1, screen: TOKEN });
    d.pointer("pointer_move", 1, add(TOKEN, 3, 4));
    const out = d.send({ type: "long_press", pointerId: 1 });
    expect(d.cancels).toBe(1);
    // The select tool answers a double-click on the token with its editor.
    expect(out.filter((e) => e.type === "open_editor")).toEqual([
      expect.objectContaining({ type: "open_editor", object: "tok" }),
    ]);
    expect(d.state.touch.press).toBeNull();
    // Dragging and releasing afterwards neither selects nor moves.
    const before = d.effects.length;
    d.pointer("pointer_move", 1, add(TOKEN, 80, 80));
    d.pointer("pointer_up", 1, add(TOKEN, 80, 80));
    expect(d.effects.slice(before)).toEqual([]);
    expect(d.writesOrSelections().filter((e) => e.type !== "open_editor")).toEqual([]);
  });

  test("moving past the slop ends the candidate; a late timer does nothing", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    d.pointer("pointer_move", 1, add(TOKEN, LONG_PRESS_SLOP_PX + 1, 0));
    expect(d.state.touch.press).toBeNull();
    expect(d.send({ type: "long_press", pointerId: 1 })).toEqual([]);
    expect(d.cancels).toBe(0);
  });

  test("a second finger ends the candidate", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    d.pointer("pointer_down", 2, add(TOKEN, 50, 0));
    expect(d.state.touch.press).toBeNull();
    expect(d.send({ type: "long_press", pointerId: 1 })).toEqual([]);
  });

  test("a stale timer for a lifted pointer does nothing", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    d.pointer("pointer_up", 1, TOKEN);
    expect(d.state.touch.press).toBeNull();
    expect(d.send({ type: "long_press", pointerId: 1 })).toEqual([]);
  });

  test("a quick tap still selects", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN);
    d.pointer("pointer_up", 1, TOKEN);
    expect(d.effects.filter((e) => e.type === "select")).toEqual([
      { type: "select", ids: ["tok"] },
    ]);
  });

  test("a mouse press is never a long-press candidate", () => {
    const d = new Driver();
    d.pointer("pointer_down", 1, TOKEN, "mouse");
    expect(d.state.touch.press).toBeNull();
    expect(d.send({ type: "long_press", pointerId: 1 })).toEqual([]);
  });
});

describe("mouse and pen are unchanged", () => {
  test.each(["mouse", "pen", undefined])(
    "a %s drag with a second pointer still moves the token",
    (kind) => {
      const d = new Driver();
      const send = (
        type: "pointer_down" | "pointer_move" | "pointer_up",
        pointerId: number,
        screen: Point,
      ) =>
        d.send({
          type,
          pointerId,
          ...(kind === undefined ? {} : { pointerType: kind }),
          screen,
          board: toBoard(d.camera, screen, VIEWPORT),
          button: type === "pointer_move" ? -1 : 0,
          buttons: type === "pointer_up" ? 0 : 1,
          modifiers: NO_MODS,
        });
      send("pointer_down", 1, TOKEN);
      send("pointer_down", 2, add(TOKEN, 100, 0));
      send("pointer_move", 1, add(TOKEN, 60, 0));
      send("pointer_up", 1, add(TOKEN, 60, 0));
      expect(d.cancels).toBe(0);
      expect(d.effects.some((e) => e.type === "camera")).toBe(false);
      expect(d.effects.some((e) => e.type === "select")).toBe(true);
      expect(d.effects.some((e) => e.type === "write")).toBe(true);
    },
  );
});
