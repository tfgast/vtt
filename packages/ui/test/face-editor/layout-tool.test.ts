// @vitest-environment node
/**
 * The layout tool as a pure reducer (vtt-1xv.27; DESIGN.md §4.6 The
 * inspector: layout mode; §7 Undo; PROTOCOL.md §5 `set_face`, §6): element
 * outlines and handles for one selected board object, move (snapped to 0.05
 * units), resize (at least 0.1), Delete and Escape, each gesture one
 * `set_face` write of the whole layout with the stamp captured at pointer
 * down (or at the key press), and cancellation.
 */
import type { FaceElementView, FaceView, ObjectView, Viewer, WireResult } from "@vtt/protocol";
import type { FaceLayout, Point, Rect, Shape } from "@vtt/schema";
import {
  apply,
  buildScene,
  type Camera,
  type CancelReason,
  createLayoutTool,
  type Effect,
  type InteractionEvent,
  itemTransform,
  LAYOUT_MIN_SIZE,
  LAYOUT_SNAP,
  type LayoutPhase,
  layoutLabel,
  layoutTargetOf,
  MAX_LABEL_LENGTH,
  type Modifiers,
  movedRect,
  type ReducerInput,
  resizedRect,
  snapToGrid,
  type Tool,
  type ToolState,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures

const BOARD = "main";
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const GM: Viewer = { type: "gm" };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const CAMERA: Camera = { x: 7, y: 3, zoom: 1 };

const num = (value: number) => ({ type: "number" as const, value });
const text = (value: string) => ({ type: "text" as const, value });
const ref = (object: string) => ({ type: "ref" as const, object });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

const value = (cell: string, r: Rect, index: number): FaceElementView =>
  ({ type: "value", cell, rect: r, index, shown: true }) as FaceElementView;

interface Spec {
  at: Point;
  shape?: Shape;
  rotation?: number;
  face?: FaceView;
  cells?: Record<string, WireResult>;
}

function view(id: string, s: Spec): ObjectView {
  const cells: ObjectView["cells"] = {
    name: { value: text(id === "tok" ? "Goblin" : id), kind: "literal" },
    board: { value: ref(BOARD), kind: "literal" },
    position: { value: { type: "list", items: [num(s.at[0]), num(s.at[1])] }, kind: "literal" },
    container: { value: { type: "empty" }, kind: "structural" },
    face_up: { value: { type: "boolean", value: true }, kind: "literal" },
  };
  if (s.shape) cells.shape = { value: { type: "shape", shape: s.shape }, kind: "literal" };
  if (s.rotation !== undefined) cells.rotation = { value: num(s.rotation), kind: "literal" };
  for (const [name, v] of Object.entries(s.cells ?? {}))
    cells[name] = { value: v, kind: "literal" };
  const out: ObjectView = {
    id,
    is_template: false,
    is_character: false,
    cells,
    actions: [],
    action_states: [],
  };
  if (s.face) out.face = s.face;
  return out;
}

/** The token: 2 × 2 at (7, 3), rotated 90°, with `hp` and `name` elements. */
const HP: Rect = [-1, -1, 1, 0.5];
const NAME: Rect = [-0.5, 0.25, 1, 0.5];
const TOKEN = view("tok", {
  at: [7, 3],
  shape: rect(2, 2),
  rotation: 90,
  cells: { hp: num(7) },
  face: { elements: [value("hp", HP, 0), value("name", NAME, 1)], default_action: "Roll" },
});
const OTHER = view("other", { at: [-5, 0], shape: rect(1, 1) });

/** The token's stored layout. */
const LAYOUT: FaceLayout = {
  elements: [
    { type: "value", cell: "hp", rect: HP },
    { type: "value", cell: "name", rect: NAME },
  ],
  default_action: "Roll",
};

function world(views: ObjectView[]): Pick<ReducerInput, "scene" | "views"> {
  const scene = buildScene({ views, covers: [], board: BOARD, viewer: GM, selection: [] });
  const byId = new Map(views.map((v) => [v.id, v]));
  return { scene, views: (id) => byId.get(id) ?? null };
}

const WORLD = world([TOKEN, OTHER]);

function makeInput(over: Partial<ReducerInput> = {}): ReducerInput {
  return {
    ...WORLD,
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer: GM,
    revision: 7,
    camera: CAMERA,
    selection: ["tok"],
    ...over,
  };
}

/** The token's frame → the board. */
const TO_BOARD = itemTransform({ anchor: [7, 3], rotation: 90 });
/** A token-local point on the board. */
const onToken = (local: Point): Point => apply(TO_BOARD, local);

type PointerType = "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel";

function pointer(type: PointerType, board: Point, pointerId = 1): InteractionEvent {
  return {
    type,
    pointerId,
    screen: toScreen(CAMERA, board, VIEWPORT),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" || type === "pointer_cancel" ? 0 : 1,
    modifiers: NO_MODS,
  };
}

const down = (local: Point) => pointer("pointer_down", onToken(local));
const move = (local: Point) => pointer("pointer_move", onToken(local));
const up = (local: Point) => pointer("pointer_up", onToken(local));
const key = (k: string): InteractionEvent => ({
  type: "key_down",
  key: k,
  code: k,
  modifiers: NO_MODS,
  inTextField: false,
});

type S = ToolState<LayoutPhase, "layout">;
type Step = InteractionEvent | { cancel: CancelReason };

function drive(
  tool: Tool<LayoutPhase, "layout">,
  events: Step[],
  options: { input?: (n: number) => Partial<ReducerInput>; state?: S } = {},
) {
  let state: S = options.state ?? tool.init({});
  const effects: Effect[] = [];
  let n = 1;
  for (const event of events) {
    const out =
      "cancel" in event
        ? tool.cancel(state, event.cancel)
        : tool.reduce(state, event, {
            ...makeInput(options.input?.(n) ?? {}),
            interactionId: `i${n}`,
          });
    n++;
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const writes = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { type: "write" }> => e.type === "write");
const lastOverlays = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { type: "overlays" }> => e.type === "overlays").at(-1)
    ?.overlays;

function expectRect(actual: Rect | undefined, expected: Rect) {
  expect(actual).toBeDefined();
  (actual as Rect).forEach((v, i) => {
    expect(v).toBeCloseTo(expected[i] as number, 9);
  });
}

/** The layout a write sets. */
function writtenFace(effect: Extract<Effect, { type: "write" }>): FaceLayout {
  expect(effect.ops).toHaveLength(1);
  const op = effect.ops[0] as { type: string; object: string; face: FaceLayout };
  expect(op.type).toBe("set_face");
  expect(op.object).toBe("tok");
  return op.face;
}

// ---------------------------------------------------------------------------

describe("geometry helpers", () => {
  test("constants", () => {
    expect(LAYOUT_SNAP).toBe(0.05);
    expect(LAYOUT_MIN_SIZE).toBe(0.1);
  });

  test("snapToGrid rounds to the nearest 0.05 without binary noise", () => {
    expect(snapToGrid(0.33)).toBe(0.35);
    expect(snapToGrid(-0.67)).toBe(-0.65);
    expect(snapToGrid(0.1 + 0.2)).toBe(0.3);
    expect(snapToGrid(-0.001)).toBe(0);
  });

  test("movedRect snaps the new top-left and keeps the size", () => {
    expect(movedRect([-1, -1, 1, 0.5], [0.33, 0.04])).toEqual([-0.65, -0.95, 1, 0.5]);
  });

  test("resizedRect moves the dragged corner, snapped, and keeps the opposite one", () => {
    expect(resizedRect([-1, -1, 1, 0.5], "se", [0.33, 0.31])).toEqual([-1, -1, 1.35, 0.8]);
    expect(resizedRect([-1, -1, 1, 0.5], "nw", [0.21, -0.2])).toEqual([-0.8, -1.2, 0.8, 0.7]);
    expect(resizedRect([-1, -1, 1, 0.5], "ne", [0.5, 0.1])).toEqual([-1, -0.9, 1.5, 0.4]);
    expect(resizedRect([-1, -1, 1, 0.5], "sw", [-0.5, 0.5])).toEqual([-1.5, -1, 1.5, 1]);
  });

  test("resizedRect clamps each side to at least 0.1", () => {
    expect(resizedRect([-1, -1, 1, 0.5], "se", [-5, -5])).toEqual([-1, -1, 0.1, 0.1]);
    const nw = resizedRect([-1, -1, 1, 0.5], "nw", [5, 5]);
    expectRect(nw, [-0.1, -0.6, 0.1, 0.1]);
  });

  test("layoutLabel fits the protocol's label limit", () => {
    expect(layoutLabel("Move a face element of Goblin")).toBe("Move a face element of Goblin");
    const long = layoutLabel(`Move a face element of ${"x".repeat(300)}`);
    expect(long.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("layoutTargetOf", () => {
  test("exactly one selected board object in the GM view", () => {
    const target = layoutTargetOf(makeInput());
    expect(target?.object).toBe("tok");
    expect(target?.name).toBe("Goblin");
    expect(target?.face).toEqual(LAYOUT);
    expect(target?.toBoard).toEqual(TO_BOARD);
  });

  test("none for no selection, two selected, an object not on the board, or a character view", () => {
    expect(layoutTargetOf(makeInput({ selection: [] }))).toBeNull();
    expect(layoutTargetOf(makeInput({ selection: ["tok", "other"] }))).toBeNull();
    expect(layoutTargetOf(makeInput({ selection: ["nowhere"] }))).toBeNull();
    expect(layoutTargetOf(makeInput({ viewer: { type: "character", id: "aldric" } }))).toBeNull();
  });

  test("an object without a layout has an empty one", () => {
    expect(layoutTargetOf(makeInput({ selection: ["other"] }))?.face).toEqual({ elements: [] });
  });
});

describe("outlines and handles", () => {
  test("a pointer move shows each element's outline in the object's frame", () => {
    const tool = createLayoutTool();
    const { effects } = drive(tool, [move([3, 3])]);
    const overlays = lastOverlays(effects);
    expect(overlays).toEqual([
      {
        kind: "drag_ghost",
        items: [
          {
            id: "tok",
            anchor: [7, 3],
            rotation: 90,
            shape: {
              type: "polygon",
              points: [
                [-1, -1],
                [0, -1],
                [0, -0.5],
                [-1, -0.5],
              ],
            },
          },
          {
            id: "tok",
            anchor: [7, 3],
            rotation: 90,
            shape: {
              type: "polygon",
              points: [
                [-0.5, 0.25],
                [0.5, 0.25],
                [0.5, 0.75],
                [-0.5, 0.75],
              ],
            },
          },
        ],
      },
    ]);
    // An unchanged view emits nothing more.
    const again = drive(tool, [move([3, 3]), move([3.1, 3])]);
    expect(again.effects.filter((e) => e.type === "overlays")).toHaveLength(1);
  });

  test("nothing is shown without exactly one selected board object", () => {
    const tool = createLayoutTool();
    const { effects } = drive(tool, [move([0, 0])], { input: () => ({ selection: [] }) });
    expect(lastOverlays(effects) ?? []).toEqual([]);
  });

  test("a pressed element is selected: its four corner handles are drawn on the board", () => {
    const tool = createLayoutTool();
    const { effects, state } = drive(tool, [down([-0.5, -0.75]), up([-0.5, -0.75])]);
    expect(state.phase.selected).toEqual({ object: "tok", index: 0 });
    expect(writes(effects)).toEqual([]);
    const handles = lastOverlays(effects)?.find((o) => o.kind === "handles");
    expect(handles).toEqual({
      kind: "handles",
      object: "tok",
      handles: [
        { key: "nw", role: "resize", at: onToken([-1, -1]) },
        { key: "ne", role: "resize", at: onToken([0, -1]) },
        { key: "se", role: "resize", at: onToken([0, -0.5]) },
        { key: "sw", role: "resize", at: onToken([-1, -0.5]) },
      ],
    });
  });

  test("a press where no element is clears the element selection", () => {
    const tool = createLayoutTool();
    const first = drive(tool, [down([-0.5, -0.75]), up([-0.5, -0.75])]);
    const { state } = drive(tool, [down([0.8, -0.8]), up([0.8, -0.8])], { state: first.state });
    expect(state.phase.selected).toBeNull();
  });
});

describe("move", () => {
  test("dragging an element body is one set_face write of the whole layout, snapped, stamped at pointer down", () => {
    const tool = createLayoutTool();
    const { effects, state } = drive(
      tool,
      [down([-0.5, -0.75]), move([-0.3, -0.5]), move([-0.17, -0.41]), up([-0.17, -0.41])],
      { input: (n) => ({ revision: 6 + n }) },
    );
    const [write] = writes(effects);
    expect(writes(effects)).toHaveLength(1);
    expect(write?.stamp).toEqual({
      interactionId: "i1",
      board: BOARD,
      viewer: GM,
      baseRevision: 7,
    });
    expect(write?.label).toBe("Move a face element of Goblin");
    expect(write?.continuations).toEqual([]);
    const face = writtenFace(write as Extract<Effect, { type: "write" }>);
    // Delta (0.33, 0.34) → top-left (-0.67, -0.66) snapped to (-0.65, -0.65).
    expect(face.elements[0]).toEqual({ type: "value", cell: "hp", rect: [-0.65, -0.65, 1, 0.5] });
    expect(face.elements[1]).toEqual(LAYOUT.elements[1]);
    expect(face.default_action).toBe("Roll");
    expect(state.phase.gesture).toBeNull();
    expect(state.phase.selected).toEqual({ object: "tok", index: 0 });
  });

  test("the outline follows the drag", () => {
    const tool = createLayoutTool();
    const { effects } = drive(tool, [down([-0.5, -0.75]), move([0, -0.75])]);
    const ghost = lastOverlays(effects)?.find((o) => o.kind === "drag_ghost");
    expect(ghost?.kind === "drag_ghost" && ghost.items[0]?.shape).toEqual({
      type: "polygon",
      points: [
        [-0.5, -1],
        [0.5, -1],
        [0.5, -0.5],
        [-0.5, -0.5],
      ],
    });
  });

  test("a press and release without movement writes nothing", () => {
    const tool = createLayoutTool();
    const { effects } = drive(tool, [
      down([-0.5, -0.75]),
      move([-0.49, -0.75]),
      up([-0.49, -0.75]),
    ]);
    expect(writes(effects)).toEqual([]);
  });

  test("the topmost element (the later one) is pressed where two overlap", () => {
    const overlapping = view("tok", {
      at: [7, 3],
      shape: rect(2, 2),
      rotation: 90,
      face: { elements: [value("hp", [-1, -1, 2, 2], 0), value("name", NAME, 1)] },
    });
    const tool = createLayoutTool();
    const { state } = drive(tool, [down([0, 0.5])], {
      input: () => world([overlapping]),
    });
    expect(state.phase.gesture?.index).toBe(1);
  });

  test("another pointer's events do not drive the gesture", () => {
    const tool = createLayoutTool();
    const { effects } = drive(tool, [
      down([-0.5, -0.75]),
      pointer("pointer_up", onToken([0.5, 0.5]), 2),
      pointer("pointer_cancel", onToken([0.5, 0.5]), 1),
    ]);
    expect(writes(effects)).toEqual([]);
  });
});

describe("resize", () => {
  test("dragging a corner handle resizes, snapped, with the stamp of its pointer down", () => {
    const tool = createLayoutTool();
    const selected = drive(tool, [down([-0.5, -0.75]), up([-0.5, -0.75])]).state;
    const { effects } = drive(tool, [down([0, -0.5]), move([0.33, -0.19]), up([0.33, -0.19])], {
      state: selected,
      input: (n) => ({ revision: 10 + n }),
    });
    const [write] = writes(effects);
    expect(write?.stamp.baseRevision).toBe(11);
    expect(write?.stamp.interactionId).toBe("i1");
    expect(write?.label).toBe("Resize a face element of Goblin");
    const face = writtenFace(write as Extract<Effect, { type: "write" }>);
    expectRect(face.elements[0]?.rect, [-1, -1, 1.35, 0.8]);
  });

  test("a handle is grabbed within its screen radius, before the element body", () => {
    const tool = createLayoutTool();
    const selected = drive(tool, [down([-0.5, -0.75]), up([-0.5, -0.75])]).state;
    // 3 px inside the nw corner (64 px per unit).
    const { state } = drive(tool, [down([-1 + 3 / 64, -1 + 3 / 64])], { state: selected });
    expect(state.phase.gesture).toMatchObject({ kind: "resize", corner: "nw", index: 0 });
  });

  test("resizing clamps each side to 0.1", () => {
    const tool = createLayoutTool();
    const selected = drive(tool, [down([-0.5, -0.75]), up([-0.5, -0.75])]).state;
    const { effects } = drive(tool, [down([0, -0.5]), move([-3, -3]), up([-3, -3])], {
      state: selected,
    });
    const face = writtenFace(writes(effects)[0] as Extract<Effect, { type: "write" }>);
    expectRect(face.elements[0]?.rect, [-1, -1, 0.1, 0.1]);
  });
});

describe("Delete and Escape", () => {
  test("Delete removes the selected element with the stamp of the key press", () => {
    const tool = createLayoutTool();
    const { effects, state } = drive(
      tool,
      [down([-0.5, -0.75]), up([-0.5, -0.75]), key("Delete")],
      { input: (n) => ({ revision: 20 + n }) },
    );
    const [write] = writes(effects);
    expect(write?.stamp).toEqual({
      interactionId: "i3",
      board: BOARD,
      viewer: GM,
      baseRevision: 23,
    });
    expect(write?.label).toBe("Remove a face element of Goblin");
    expect(writtenFace(write as Extract<Effect, { type: "write" }>)).toEqual({
      elements: [LAYOUT.elements[1]],
      default_action: "Roll",
    });
    expect(state.phase.selected).toBeNull();
  });

  test("Backspace removes too; with no element selected nothing is written", () => {
    const tool = createLayoutTool();
    expect(writes(drive(tool, [key("Delete")]).effects)).toEqual([]);
    const { effects } = drive(tool, [down([-0.5, -0.75]), up([-0.5, -0.75]), key("Backspace")]);
    expect(writes(effects)).toHaveLength(1);
  });

  test("a selected element of an object no longer selected is not removed", () => {
    const tool = createLayoutTool();
    const selected = drive(tool, [down([-0.5, -0.75]), up([-0.5, -0.75])]).state;
    const { effects } = drive(tool, [key("Delete")], {
      state: selected,
      input: () => ({ selection: ["other"] }),
    });
    expect(writes(effects)).toEqual([]);
  });

  test("Escape ends a drag with no write and returns to select", () => {
    const tool = createLayoutTool();
    const { effects, state } = drive(tool, [
      down([-0.5, -0.75]),
      move([0, 0]),
      { cancel: "escape" },
      up([0, 0]),
    ]);
    expect(writes(effects)).toEqual([]);
    expect(effects).toContainEqual({ type: "set_tool", tool: "select" });
    expect(state.phase.gesture).toBeNull();
  });

  test("Escape with nothing in progress returns to select", () => {
    const tool = createLayoutTool();
    const { effects } = drive(tool, [{ cancel: "escape" }]);
    expect(effects).toEqual([{ type: "set_tool", tool: "select" }]);
  });
});

describe("cancellation", () => {
  test.each(["board_change", "viewer_change", "tool_switch"] as const)(
    "%s ends an unfinished gesture with no write and clears the overlays",
    (reason) => {
      const tool = createLayoutTool();
      const started = drive(tool, [down([-0.5, -0.75]), move([0, 0])]);
      expect((lastOverlays(started.effects) ?? []).length).toBeGreaterThan(0);
      const { effects, state } = drive(tool, [{ cancel: reason }, up([0, 0])], {
        state: started.state,
      });
      expect(writes(effects)).toEqual([]);
      expect(state.phase.gesture).toBeNull();
      expect(effects).not.toContainEqual({ type: "set_tool", tool: "select" });
      expect(effects[0]).toEqual({ type: "overlays", overlays: [] });
    },
  );

  test("pointer_cancel ends a gesture with no write", () => {
    const tool = createLayoutTool();
    const { effects } = drive(tool, [
      down([-0.5, -0.75]),
      move([0, 0]),
      pointer("pointer_cancel", onToken([0, 0])),
      up([0, 0]),
    ]);
    expect(writes(effects)).toEqual([]);
  });

  test("a character viewer gets no gesture", () => {
    const tool = createLayoutTool();
    const { effects, state } = drive(tool, [down([-0.5, -0.75]), up([0, 0])], {
      input: () => ({ viewer: { type: "character", id: "aldric" } }),
    });
    expect(writes(effects)).toEqual([]);
    expect(state.phase.gesture).toBeNull();
  });
});

describe("pending writes", () => {
  const ghostOf = (effects: Effect[]) => {
    const ghost = lastOverlays(effects)?.find((o) => o.kind === "drag_ghost");
    return ghost?.kind === "drag_ghost" ? ghost.items[0]?.shape : undefined;
  };
  const MOVED = {
    type: "polygon",
    points: [
      [-0.5, -1],
      [0.5, -1],
      [0.5, -0.5],
      [-0.5, -0.5],
    ],
  };

  test("after a write the outline keeps the written layout until the client has its revision", () => {
    const tool = createLayoutTool();
    const { state, effects } = drive(tool, [down([-0.5, -0.75]), move([0, -0.75]), up([0, -0.75])]);
    const write = writes(effects)[0] as Extract<Effect, { type: "write" }>;
    expect(ghostOf(effects)).toEqual(MOVED);
    expect(state.phase.pending?.face.elements[0]?.rect).toEqual([-0.5, -1, 1, 0.5]);

    // Committed at revision 8; the view (still the old one) is at 7.
    const settled = drive(
      tool,
      [
        {
          type: "settled",
          interactionId: write.stamp.interactionId,
          outcome: {
            type: "write",
            result: {
              status: "committed",
              revision: 8,
              index: 3,
              created: [],
              copies: [],
              bindings: {},
            },
          },
        },
        move([1, 1]),
      ],
      { state },
    );
    expect(settled.state.phase.pending?.revision).toBe(8);
    // Once the client is at revision 8 the view's layout is shown again.
    const seen = drive(tool, [move([1, 1])], {
      state: settled.state,
      input: () => ({ revision: 8 }),
    });
    expect(seen.state.phase.pending).toBeNull();
    expect(ghostOf(seen.effects)?.type).toBe("polygon");
    expect(ghostOf(seen.effects)).not.toEqual(MOVED);
  });

  test("a write that does not commit drops the pending layout", () => {
    const tool = createLayoutTool();
    const { state, effects } = drive(tool, [down([-0.5, -0.75]), move([0, -0.75]), up([0, -0.75])]);
    const write = writes(effects)[0] as Extract<Effect, { type: "write" }>;
    const failed = drive(
      tool,
      [
        {
          type: "settled",
          interactionId: write.stamp.interactionId,
          outcome: { type: "write", result: { status: "uncertain", reason: "lost" } },
        },
      ],
      { state },
    );
    expect(failed.state.phase.pending).toBeNull();
    expect(ghostOf(failed.effects)).not.toEqual(MOVED);
  });
});
