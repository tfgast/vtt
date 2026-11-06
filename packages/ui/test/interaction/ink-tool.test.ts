// @vitest-environment node
/**
 * The ink tool as a pure reducer (vtt-1xv.21; DESIGN.md §4.1 ink is a cell
 * value, §4.6 Ink and text, §8.1, §8.4 step 6; PROTOCOL.md §5 `set_value`,
 * `create_object` with `id_base`; M5 plan Q19): thinning, the point cap,
 * the object-local frame of a rotated note, the two write shapes, the
 * notice for a non-ink `ink` cell, and cancellation.
 */
import type { ObjectView, Viewer, WireOp, WireResult } from "@vtt/protocol";
import type { Point, Shape } from "@vtt/schema";
import {
  buildScene,
  type Camera,
  type CancelReason,
  type CoverItem,
  createInkTool,
  DEFAULT_TOOL_OPTIONS,
  type Effect,
  INK_MAX_POINTS,
  INK_MIN_SIZE,
  INK_MIN_STEP,
  type InkPhase,
  type InteractionEvent,
  initMachine,
  inkLabel,
  inkTarget,
  MAX_LABEL_LENGTH,
  type Modifiers,
  type ReducerInput,
  reduce,
  type Scene,
  type Tool,
  ToolRegistry,
  type ToolState,
  thinStroke,
  toObjectLocal,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures

const BOARD = "main";
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const GM: Viewer = { type: "gm" };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

const num = (value: number) => ({ type: "number" as const, value });
const text = (value: string) => ({ type: "text" as const, value });
const ref = (object: string) => ({ type: "ref" as const, object });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

interface Spec {
  at: Point;
  shape?: Shape;
  rotation?: number;
  zone?: boolean;
  cells?: Record<string, WireResult>;
}

function view(id: string, s: Spec): ObjectView {
  const cells: ObjectView["cells"] = {
    name: { value: text(id), kind: "literal" },
    board: { value: ref(BOARD), kind: "literal" },
    position: { value: { type: "list", items: [num(s.at[0]), num(s.at[1])] }, kind: "literal" },
    container: { value: { type: "empty" }, kind: "structural" },
    face_up: { value: { type: "boolean", value: true }, kind: "literal" },
  };
  if (s.shape) cells.shape = { value: { type: "shape", shape: s.shape }, kind: "literal" };
  if (s.rotation !== undefined) cells.rotation = { value: num(s.rotation), kind: "literal" };
  if (s.zone) cells.is_zone = { value: { type: "boolean", value: true }, kind: "literal" };
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: "literal" };
  }
  return { id, is_template: false, is_character: false, cells, actions: [], action_states: [] };
}

function world(
  views: ObjectView[],
  covers: CoverItem[] = [],
): Pick<ReducerInput, "scene" | "views"> {
  const built = buildScene({ views, covers: [], board: BOARD, viewer: GM, selection: [] });
  const scene: Scene = { ...built, covers: [...built.covers, ...covers] };
  const byId = new Map(views.map((v) => [v.id, v]));
  return { scene, views: (id) => byId.get(id) ?? null };
}

const EMPTY_WORLD = world([]);

function makeInput(over: Partial<ReducerInput> = {}): ReducerInput {
  return {
    ...EMPTY_WORLD,
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer: GM,
    revision: 7,
    camera: CAMERA,
    selection: [],
    ...over,
  };
}

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

const down = (p: Point) => pointer("pointer_down", p);
const move = (p: Point) => pointer("pointer_move", p);
const up = (p: Point) => pointer("pointer_up", p);

/** A stroke: down at the first point, moves through the middle, up at the last. */
function stroke(points: Point[]): InteractionEvent[] {
  const first = points[0] as Point;
  const last = points.at(-1) as Point;
  return [down(first), ...points.slice(1, -1).map(move), up(last)];
}

type S = ToolState<InkPhase, "ink">;

function drive(
  tool: Tool<InkPhase, "ink">,
  events: (InteractionEvent | { cancel: CancelReason })[],
  options: { input?: (n: number) => Partial<ReducerInput>; state?: S } = {},
) {
  let state: S = options.state ?? tool.init(DEFAULT_TOOL_OPTIONS.ink);
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

function expectClose(actual: Point[][], expected: Point[][]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((s, i) => {
    const e = expected[i] as Point[];
    expect(s).toHaveLength(e.length);
    s.forEach((p, j) => {
      expect(p[0]).toBeCloseTo((e[j] as Point)[0], 9);
      expect(p[1]).toBeCloseTo((e[j] as Point)[1], 9);
    });
  });
}

// ---------------------------------------------------------------------------

describe("constants", () => {
  test("the step, cap and minimum size are as specified", () => {
    expect(INK_MIN_STEP).toBe(0.05);
    expect(INK_MAX_POINTS).toBe(2000);
    expect(INK_MIN_SIZE).toBe(0.25);
  });
});

describe("collecting points", () => {
  test("thinStroke drops a point closer than 0.05 to the previous kept point", () => {
    let pts: Point[] = [[0, 0]];
    pts = thinStroke(pts, [0.03, 0]);
    expect(pts).toEqual([[0, 0]]);
    // 0.06 from the kept point, though only 0.03 from the dropped one.
    pts = thinStroke(pts, [0.06, 0]);
    expect(pts).toEqual([
      [0, 0],
      [0.06, 0],
    ]);
    // Exactly 0.05 is kept.
    pts = thinStroke(pts, [0.06, 0.05]);
    expect(pts).toHaveLength(3);
  });

  test("moves are thinned while drawing and the preview is a polygon_draft of the kept points", () => {
    const tool = createInkTool();
    const { effects, state } = drive(tool, [
      down([0, 0]),
      move([0.01, 0]),
      move([0.02, 0]),
      move([0.1, 0]),
      move([0.12, 0]),
      move([0.2, 0]),
    ]);
    expect(state.phase.stroke?.points).toEqual([
      [0, 0],
      [0.1, 0],
      [0.2, 0],
    ]);
    expect(lastOverlays(effects)).toEqual([
      {
        kind: "polygon_draft",
        points: [
          [0, 0],
          [0.1, 0],
          [0.2, 0],
        ],
        cursor: null,
        closing: false,
      },
    ]);
    expect(writes(effects)).toEqual([]);
  });

  test("a stroke holds at most 2,000 points; later points are dropped", () => {
    const tool = createInkTool();
    const points: Point[] = Array.from({ length: 2500 }, (_, i) => [i * 0.1, 0] as Point);
    const { effects } = drive(tool, stroke(points));
    const [w] = writes(effects);
    const op = w?.ops[0] as Extract<WireOp, { type: "create_object" }>;
    const cells = op.init?.cells as Record<string, { type: string; strokes?: Point[][] }>;
    const strokes = cells.ink?.strokes as Point[][];
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toHaveLength(INK_MAX_POINTS);
    // The kept points are the first 2,000: the stroke ends at x = 199.9.
    const anchor = op.to.type === "board" ? op.to.position : [0, 0];
    expect(((strokes[0] as Point[]).at(-1) as Point)[0] + (anchor[0] as number)).toBeCloseTo(
      199.9,
      9,
    );
  });

  test("a click (fewer than two points) writes nothing and clears the preview", () => {
    const tool = createInkTool();
    const { effects, state } = drive(tool, [down([1, 1]), move([1.01, 1]), up([1.02, 1])]);
    expect(writes(effects)).toEqual([]);
    expect(lastOverlays(effects)).toEqual([]);
    expect(state.phase.stroke).toBeNull();
  });

  test("another pointer and a secondary button are ignored", () => {
    const tool = createInkTool();
    const right: InteractionEvent = { ...(down([0, 0]) as object), button: 2 } as InteractionEvent;
    const { effects, state } = drive(tool, [
      right,
      down([0, 0]),
      pointer("pointer_move", [5, 5], 2),
    ]);
    expect(state.phase.stroke?.points).toEqual([[0, 0]]);
    expect(writes(effects)).toEqual([]);
  });
});

describe("targets and the object-local frame", () => {
  test("toObjectLocal inverts the rotation about the anchor", () => {
    // A note at (2, 1) rotated 90° clockwise: its local +x points down the board.
    const local = toObjectLocal([2, 2], [2, 1], 90);
    expect(local[0]).toBeCloseTo(1, 12);
    expect(local[1]).toBeCloseTo(0, 12);
    const back = toObjectLocal([1, 1], [2, 1], 90);
    expect(back[0]).toBeCloseTo(0, 12);
    expect(back[1]).toBeCloseTo(1, 12);
    expect(toObjectLocal([3, 4], [1, 1], 0)).toEqual([2, 3]);
  });

  test("the target is the topmost non-zone object; a zone alone or a cover gives none", () => {
    const w = world([
      view("zone", { at: [0, 0], shape: rect(10, 10), zone: true }),
      view("low", { at: [0, 0], shape: rect(2, 2) }),
      view("high", { at: [0.5, 0], shape: rect(2, 2), cells: { z: num(1) } }),
    ]);
    const input = makeInput(w);
    expect(inkTarget(input, [0.2, 0])).toBe("high");
    expect(inkTarget(input, [-0.9, 0])).toBe("low");
    expect(inkTarget(input, [4, 4])).toBeNull();
    const covered = makeInput(
      world([view("low", { at: [0, 0], shape: rect(2, 2) })], [{ key: "c", wholeBoard: true }]),
    );
    expect(inkTarget(covered, [0, 0])).toBeNull();
  });

  test("a stroke on a rotated note appends in its local frame with set_value of the whole ink", () => {
    const existing: Point[][] = [
      [
        [0, 0],
        [0.5, 0.5],
      ],
    ];
    const note = view("note", {
      at: [2, 1],
      shape: rect(2, 2),
      rotation: 90,
      cells: { ink: { type: "ink", strokes: existing } },
    });
    const tool = createInkTool();
    const { effects } = drive(
      tool,
      stroke([
        [2, 1.5],
        [2, 1.75],
        [1.5, 1.75],
      ]),
      {
        input: () => world([note]),
      },
    );
    const [w] = writes(effects);
    expect(writes(effects)).toHaveLength(1);
    expect(w?.stamp).toEqual({ interactionId: "i1", board: BOARD, viewer: GM, baseRevision: 7 });
    expect(w?.continuations).toEqual([]);
    expect(w?.ops).toHaveLength(1);
    const op = w?.ops[0] as Extract<WireOp, { type: "set_value" }>;
    expect(op.type).toBe("set_value");
    expect(op.object).toBe("note");
    expect(op.cell).toBe("ink");
    expect(op.replace).toBeUndefined();
    const value = op.value as { type: "ink"; strokes: Point[][] };
    expect(value.type).toBe("ink");
    expectClose(value.strokes, [
      ...existing,
      [
        [0.5, 0],
        [0.75, 0],
        [0.75, 0.5],
      ],
    ]);
    expect(lastOverlays(effects)).toEqual([]);
  });

  test("an absent or empty ink cell becomes an ink value with the one stroke", () => {
    for (const cells of [{}, { ink: { type: "empty" } }] as Record<string, WireResult>[]) {
      const note = view("note", { at: [0, 0], shape: rect(2, 2), cells });
      const { effects } = drive(
        createInkTool(),
        stroke([
          [0, 0],
          [0.5, 0],
        ]),
        {
          input: () => world([note]),
        },
      );
      const op = writes(effects)[0]?.ops[0] as Extract<WireOp, { type: "set_value" }>;
      expect(op.value).toEqual({
        type: "ink",
        strokes: [
          [
            [0, 0],
            [0.5, 0],
          ],
        ],
      });
    }
  });

  test("the label names the object, capped at 200 UTF-16 units with an ellipsis", () => {
    expect(inkLabel("Note")).toBe("Draw ink on Note");
    const fits = "n".repeat(MAX_LABEL_LENGTH - "Draw ink on ".length);
    expect(inkLabel(fits)).toBe(`Draw ink on ${fits}`);
    // A 189-character name would make a 201-unit label.
    const long = "n".repeat(189);
    const label = inkLabel(long);
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(label.startsWith("Draw ink on nnn")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    // Whole code points only: never half a surrogate pair.
    const emoji = inkLabel("😀".repeat(150));
    expect(emoji.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(emoji).toBe(`Draw ink on ${"😀".repeat(93)}…`);

    const note = view("note", { at: [0, 0], shape: rect(2, 2), cells: { name: text(long) } });
    const { effects } = drive(
      createInkTool(),
      stroke([
        [0, 0],
        [0.5, 0],
      ]),
      { input: () => world([note]) },
    );
    const [w] = writes(effects);
    expect(w?.label).toBe(label);
  });

  test("an ink cell holding something else is a notice and no write", () => {
    const note = view("note", { at: [0, 0], shape: rect(2, 2), cells: { ink: text("scrawl") } });
    const { effects } = drive(
      createInkTool(),
      stroke([
        [0, 0],
        [0.5, 0],
      ]),
      {
        input: () => world([note]),
      },
    );
    expect(writes(effects)).toEqual([]);
    const notices = effects.filter((e) => e.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "warning" });
    expect(lastOverlays(effects)).toEqual([]);
  });

  test("the target and the base revision are those of pointer down", () => {
    const note = view("note", { at: [0, 0], shape: rect(2, 2) });
    const { effects } = drive(
      createInkTool(),
      stroke([
        [0, 0],
        [0.5, 0],
        [5, 5],
      ]),
      {
        // The note is gone from the snapshot after pointer down and the revision moved on.
        input: (n) => (n === 1 ? { ...world([note]), revision: 7 } : { revision: 9 }),
      },
    );
    const [w] = writes(effects);
    expect(w?.stamp.baseRevision).toBe(7);
    expect(w?.ops[0]).toMatchObject({ type: "set_value", object: "note", cell: "ink" });
  });

  test("a stroke on empty board creates an ink object at the bbox centre", () => {
    const { effects } = drive(
      createInkTool(),
      stroke([
        [1, 1],
        [3, 1.5],
        [2, 2],
      ]),
    );
    const [w] = writes(effects);
    expect(writes(effects)).toHaveLength(1);
    expect(w?.continuations).toEqual([]);
    expect(w?.ops).toEqual([
      {
        type: "create_object",
        id_base: "ink",
        to: { type: "board", board: BOARD, position: [2, 1.5] },
        init: {
          shape: { type: "rect", width: 2, height: 1 },
          cells: {
            ink: {
              type: "ink",
              strokes: [
                [
                  [-1, -0.5],
                  [1, 0],
                  [0, 0.5],
                ],
              ],
            },
            color: { type: "text", value: "transparent" },
            name: { type: "text", value: "Ink" },
          },
        },
      },
    ]);
  });

  test("a thin stroke's rect is at least 0.25 on each side", () => {
    const { effects } = drive(
      createInkTool(),
      stroke([
        [0, 0],
        [1, 0],
      ]),
    );
    const op = writes(effects)[0]?.ops[0] as Extract<WireOp, { type: "create_object" }>;
    expect(op.init?.shape).toEqual({ type: "rect", width: 1, height: INK_MIN_SIZE });
    expect(op.to).toEqual({ type: "board", board: BOARD, position: [0.5, 0] });
  });

  test("a stroke over a zone only, or under a cover, creates an ink object", () => {
    const zone = view("zone", { at: [0, 0], shape: rect(10, 10), zone: true });
    const a = drive(
      createInkTool(),
      stroke([
        [0, 0],
        [1, 0],
      ]),
      { input: () => world([zone]) },
    );
    expect(writes(a.effects)[0]?.ops[0]).toMatchObject({ type: "create_object", id_base: "ink" });
    const note = view("note", { at: [0, 0], shape: rect(2, 2) });
    const b = drive(
      createInkTool(),
      stroke([
        [0, 0],
        [1, 0],
      ]),
      {
        input: () => world([note], [{ key: "c", wholeBoard: true }]),
      },
    );
    expect(writes(b.effects)[0]?.ops[0]).toMatchObject({ type: "create_object", id_base: "ink" });
  });

  test("the tool stays active and starts the next stroke fresh", () => {
    const { effects, state } = drive(createInkTool(), [
      ...stroke([
        [0, 0],
        [1, 0],
      ]),
      ...stroke([
        [5, 5],
        [6, 5],
      ]),
    ]);
    expect(writes(effects)).toHaveLength(2);
    expect(effects.some((e) => e.type === "set_tool")).toBe(false);
    expect(writes(effects)[1]?.stamp.interactionId).toBe("i3");
    expect(state.phase.stroke).toBeNull();
  });

  test("no active board: nothing starts", () => {
    const { effects, state } = drive(
      createInkTool(),
      stroke([
        [0, 0],
        [1, 0],
      ]),
      {
        input: () => ({ activeBoard: null }),
      },
    );
    expect(effects).toEqual([]);
    expect(state.phase.stroke).toBeNull();
  });
});

describe("cancellation", () => {
  for (const reason of ["escape", "board_change", "viewer_change", "tool_switch"] as const) {
    test(`${reason} cancels an unfinished stroke: preview cleared, no write`, () => {
      const { effects, state } = drive(createInkTool(), [
        down([0, 0]),
        move([1, 0]),
        { cancel: reason },
        move([2, 0]),
        up([3, 0]),
      ]);
      expect(writes(effects)).toEqual([]);
      expect(lastOverlays(effects)).toEqual([]);
      expect(state.phase.stroke).toBeNull();
    });
  }

  test("pointer_cancel ends the stroke with no write", () => {
    const { effects } = drive(createInkTool(), [
      down([0, 0]),
      move([1, 0]),
      pointer("pointer_cancel", [1, 0]),
      up([2, 0]),
    ]);
    expect(writes(effects)).toEqual([]);
    expect(lastOverlays(effects)).toEqual([]);
  });

  test("cancel with nothing in progress emits nothing", () => {
    const tool = createInkTool();
    expect(tool.cancel(tool.init(DEFAULT_TOOL_OPTIONS.ink), "escape").effects).toEqual([]);
  });

  test("through the machine: Escape mid-stroke cancels it", () => {
    const registry = new ToolRegistry();
    registry.register(createInkTool());
    let machine = initMachine(registry, { tool: "ink", board: BOARD, viewer: GM });
    const effects: Effect[] = [];
    const events: InteractionEvent[] = [
      down([0, 0]),
      move([1, 0]),
      { type: "key_down", key: "Escape", code: "Escape", modifiers: NO_MODS, inTextField: false },
      up([2, 0]),
    ];
    for (const event of events) {
      const out = reduce(machine, event, makeInput(), registry);
      machine = out.state;
      effects.push(...out.effects);
    }
    expect(writes(effects)).toEqual([]);
    expect(lastOverlays(effects)).toEqual([]);
  });
});
