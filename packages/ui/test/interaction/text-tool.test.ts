// @vitest-environment node
/**
 * The text tool as a pure reducer and its `edit_created` continuation
 * handler (vtt-1xv.21; DESIGN.md §4.6 Ink and text; PROTOCOL.md §5
 * `create_object` with `id_base`; M5 plan Q1 A1/A2, Q19).
 */
import type { ObjectView, Viewer } from "@vtt/protocol";
import type { Point } from "@vtt/schema";
import {
  type Camera,
  type CancelReason,
  createTextTool,
  EDIT_CREATED,
  type EditorOpenRequest,
  type EditorPort,
  type Effect,
  editCreatedHandler,
  type InteractionEvent,
  type InteractionStamp,
  type Modifiers,
  type ReducerInput,
  type RuntimeInputs,
  type Scene,
  TEXT_BOX,
  type TextPhase,
  type Tool,
  type ToolState,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const SHIFT: Modifiers = { ...NO_MODS, shift: true };
const GM: Viewer = { type: "gm" };
const EMPTY_SCENE: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

function makeInput(over: Partial<ReducerInput> = {}): ReducerInput {
  return {
    scene: EMPTY_SCENE,
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer: GM,
    revision: 4,
    camera: CAMERA,
    selection: [],
    views: () => null,
    ...over,
  };
}

function pointer(
  type: "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel",
  board: Point,
  modifiers: Modifiers = NO_MODS,
): InteractionEvent {
  return {
    type,
    pointerId: 1,
    screen: toScreen(CAMERA, board, VIEWPORT),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" || type === "pointer_cancel" ? 0 : 1,
    modifiers,
  };
}

type S = ToolState<TextPhase, "text">;

function drive(
  tool: Tool<TextPhase, "text">,
  events: (InteractionEvent | { cancel: CancelReason })[],
  input: (n: number) => Partial<ReducerInput> = () => ({}),
) {
  let state: S = tool.init({});
  const effects: Effect[] = [];
  let n = 1;
  for (const event of events) {
    const out =
      "cancel" in event
        ? tool.cancel(state, event.cancel)
        : tool.reduce(state, event, { ...makeInput(input(n)), interactionId: `i${n}` });
    n++;
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const writes = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { type: "write" }> => e.type === "write");

const STAMP: InteractionStamp = { interactionId: "i1", board: BOARD, viewer: GM, baseRevision: 4 };

describe("text tool", () => {
  test("a click creates a transparent 4 × 1 text object, selects it, edits it and returns to select", () => {
    expect(TEXT_BOX).toEqual({ width: 4, height: 1 });
    const { effects, state } = drive(createTextTool(), [
      pointer("pointer_down", [3, 2]),
      pointer("pointer_up", [3, 2]),
    ]);
    expect(writes(effects)).toHaveLength(1);
    const [w] = writes(effects);
    expect(w?.stamp).toEqual(STAMP);
    expect(w?.ops).toEqual([
      {
        type: "create_object",
        id_base: "text",
        to: { type: "board", board: BOARD, position: [3, 2] },
        init: {
          shape: { type: "rect", width: 4, height: 1 },
          cells: {
            text: { type: "text", value: "" },
            color: { type: "text", value: "transparent" },
            name: { type: "text", value: "Text" },
          },
        },
      },
    ]);
    expect(w?.continuations).toEqual([
      { type: "select_created", opIndex: 0 },
      {
        type: "extension",
        name: EDIT_CREATED,
        opIndex: 0,
        payload: { stamp: STAMP, cell: "text", rect: { minX: 1, minY: 1.5, maxX: 5, maxY: 2.5 } },
      },
      { type: "set_tool", tool: "select" },
    ]);
    expect(EDIT_CREATED).toBe("edit_created");
    expect(state.phase.press).toBeNull();
  });

  test("with Shift held at pointer down the tool stays", () => {
    const { effects } = drive(createTextTool(), [
      pointer("pointer_down", [0, 0], SHIFT),
      pointer("pointer_up", [0, 0]),
    ]);
    const continuations = writes(effects)[0]?.continuations ?? [];
    expect(continuations.map((c) => c.type)).toEqual(["select_created", "extension"]);
  });

  test("the base revision is captured at pointer down", () => {
    const { effects } = drive(
      createTextTool(),
      [pointer("pointer_down", [0, 0]), pointer("pointer_up", [0, 0])],
      (n) => ({ revision: n === 1 ? 4 : 11 }),
    );
    expect(writes(effects)[0]?.stamp.baseRevision).toBe(4);
  });

  test("Escape, a board or viewer change and pointer_cancel cancel a press", () => {
    for (const ev of [
      { cancel: "escape" as const },
      { cancel: "board_change" as const },
      { cancel: "viewer_change" as const },
      pointer("pointer_cancel", [0, 0]),
    ]) {
      const { effects } = drive(createTextTool(), [
        pointer("pointer_down", [0, 0]),
        ev,
        pointer("pointer_up", [0, 0]),
      ]);
      expect(writes(effects)).toEqual([]);
    }
  });

  test("no active board: nothing", () => {
    const { effects } = drive(
      createTextTool(),
      [pointer("pointer_down", [0, 0]), pointer("pointer_up", [0, 0])],
      () => ({ activeBoard: null }),
    );
    expect(effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

function fakeInputs(over: { board?: string | null; viewer?: Viewer; revision?: number } = {}) {
  const views = new Map<string, ObjectView>();
  const listeners = new Set<() => void>();
  const live = {
    board: over.board ?? BOARD,
    viewer: over.viewer ?? GM,
    revision: over.revision ?? 5,
  };
  const inputs: RuntimeInputs = {
    views: (id) => views.get(id) ?? null,
    scene: () => EMPTY_SCENE,
    viewport: () => VIEWPORT,
    activeBoard: () => live.board,
    viewer: () => live.viewer,
    revision: () => live.revision,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const fire = () => {
    for (const l of [...listeners]) l();
  };
  const addView = (id: string) =>
    views.set(id, {
      id,
      is_template: false,
      is_character: false,
      cells: {},
      actions: [],
      action_states: [],
    });
  return { inputs, live, fire, addView, listeners };
}

function fakeEditor() {
  const opened: EditorOpenRequest[] = [];
  const editor: EditorPort = { open: (r) => opened.push(r), close: () => undefined };
  return { editor, opened };
}

const PAYLOAD = { stamp: STAMP, cell: "text", rect: { minX: 1, minY: 1.5, maxX: 5, maxY: 2.5 } };

describe("editCreatedHandler", () => {
  test("opens the editor on the created object's cell at the current revision", () => {
    const f = fakeInputs({ revision: 5 });
    const e = fakeEditor();
    f.addView("text_1");
    editCreatedHandler({ editor: e.editor, inputs: f.inputs })("text_1", PAYLOAD);
    expect(e.opened).toEqual([
      {
        stamp: { ...STAMP, baseRevision: 5 },
        object: "text_1",
        cell: "text",
        rect: PAYLOAD.rect,
      },
    ]);
  });

  test("waits for the created object's view, then opens once", () => {
    const f = fakeInputs({ revision: 4 });
    const e = fakeEditor();
    editCreatedHandler({ editor: e.editor, inputs: f.inputs })("text_1", PAYLOAD);
    expect(e.opened).toEqual([]);
    f.fire();
    expect(e.opened).toEqual([]);
    f.live.revision = 5;
    f.addView("text_1");
    f.fire();
    f.fire();
    expect(e.opened).toHaveLength(1);
    expect(e.opened[0]?.stamp.baseRevision).toBe(5);
    expect(f.listeners.size).toBe(0);
  });

  test("gives up when the board or viewer changes before the view arrives", () => {
    const f = fakeInputs();
    const e = fakeEditor();
    editCreatedHandler({ editor: e.editor, inputs: f.inputs })("text_1", PAYLOAD);
    f.live.board = "other";
    f.fire();
    f.live.board = BOARD;
    f.addView("text_1");
    f.fire();
    expect(e.opened).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });

  test("does nothing for a stamp on another board, a null id or a malformed payload", () => {
    const f = fakeInputs();
    const e = fakeEditor();
    f.addView("text_1");
    const handler = editCreatedHandler({ editor: e.editor, inputs: f.inputs });
    handler("text_1", { ...PAYLOAD, stamp: { ...STAMP, board: "other" } });
    handler(null, PAYLOAD);
    handler("text_1", { cell: "text" });
    handler("text_1", null);
    expect(e.opened).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });
});
