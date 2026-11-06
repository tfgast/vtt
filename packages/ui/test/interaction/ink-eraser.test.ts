// @vitest-environment node
/**
 * Ink pens and the eraser (vtt-qf5.27; DESIGN.md §4.6 Ink and text; M5
 * plan Q19; M6-D28): the crossing geometry, the pen fields a stroke is
 * written with, and the eraser's one write per gesture against the stamp's
 * base revision.
 */
import {
  type ObjectView,
  TransactParamsSchema,
  type Viewer,
  type WireOp,
  type WireResult,
} from "@vtt/protocol";
import type { Point, Shape, Stroke } from "@vtt/schema";
import {
  buildScene,
  type Camera,
  createInkTool,
  crossedStrokes,
  DEFAULT_INK_COLOR,
  DEFAULT_INK_WIDTH,
  DEFAULT_TOOL_OPTIONS,
  type Effect,
  ERASER_RADIUS_PX,
  eraseLabel,
  INK_MAX_POINTS,
  INK_PALETTE,
  INK_WIDTHS,
  type InkPhase,
  type InkToolOptions,
  type InteractionEvent,
  type Modifiers,
  penStroke,
  pointSegmentDistance,
  type ReducerInput,
  type Scene,
  segmentDistance,
  strokeCrossed,
  strokePen,
  type Tool,
  type ToolState,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Geometry

describe("crossing geometry", () => {
  test("segments that cross are at distance 0; apart, the nearest endpoint distance", () => {
    expect(segmentDistance([0, -1], [0, 1], [-1, 0], [1, 0])).toBe(0);
    expect(segmentDistance([0, 0], [1, 0], [0, 2], [1, 2])).toBeCloseTo(2, 12);
    expect(segmentDistance([0, 0], [1, 0], [2, 0.5], [3, 0.5])).toBeCloseTo(Math.hypot(1, 0.5), 12);
    expect(pointSegmentDistance([0.5, 1], [0, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(pointSegmentDistance([3, 4], [0, 0], [0, 0])).toBeCloseTo(5, 12);
  });

  const horizontal: Stroke = [
    [0, 0],
    [1, 0],
    [2, 0],
  ];

  test("a path that crosses a stroke crosses it, whatever the radius", () => {
    const path: Point[] = [
      [1.5, -1],
      [1.5, 1],
    ];
    expect(strokeCrossed(path, horizontal, 0)).toBe(true);
  });

  test("a path passing near a stroke crosses it only within radius plus half its width", () => {
    const path: Point[] = [
      [0, 0.2],
      [2, 0.2],
    ];
    // Half the default width is 0.02: reach 0.1 + 0.02 < 0.2.
    expect(strokeCrossed(path, horizontal, 0.1)).toBe(false);
    expect(strokeCrossed(path, horizontal, 0.19)).toBe(true);
    // A wide stroke reaches further: 0.1 + 0.16 / 2 = 0.18 < 0.2; 0.1 + 0.25 > 0.2.
    expect(strokeCrossed(path, { points: horizontal as Point[], width: 0.16 }, 0.1)).toBe(false);
    expect(strokeCrossed(path, { points: horizontal as Point[], width: 0.5 }, 0.1)).toBe(true);
  });

  test("a tap (one point) erases what lies within the radius", () => {
    expect(strokeCrossed([[1, 0.05]], horizontal, 0.1)).toBe(true);
    expect(strokeCrossed([[1, 0.5]], horizontal, 0.1)).toBe(false);
    // A one-point stroke is a dot.
    expect(strokeCrossed([[3.05, 3]], [[3, 3]], 0.1)).toBe(true);
  });

  test("crossedStrokes lists the crossed strokes' indices in order", () => {
    const strokes: Stroke[] = [
      horizontal,
      [
        [0, 5],
        [2, 5],
      ],
      { points: [[1, -1]], color: "#d32f2f" },
    ];
    const path: Point[] = [
      [1, -2],
      [1, 1],
    ];
    expect(crossedStrokes(path, strokes, 0.1)).toEqual([0, 2]);
    expect(crossedStrokes([[9, 9]], strokes, 0.1)).toEqual([]);
  });
});

describe("pens", () => {
  test("the palette and widths", () => {
    expect(INK_PALETTE.map((c) => c.color)).toEqual([
      "#202020",
      "#d32f2f",
      "#1e63d6",
      "#2e8b3a",
      "#f2b100",
      "#ffffff",
    ]);
    expect(INK_PALETTE[0]?.color).toBe(DEFAULT_INK_COLOR);
    expect(INK_WIDTHS.map((w) => w.width)).toEqual([0.02, 0.04, 0.08, 0.16]);
    expect(DEFAULT_TOOL_OPTIONS.ink).toEqual({
      color: DEFAULT_INK_COLOR,
      width: DEFAULT_INK_WIDTH,
      eraser: false,
    });
  });

  test("penStroke keeps only the fields that differ from the default pen", () => {
    const pts: Point[] = [[0, 0]];
    expect(penStroke(pts, DEFAULT_INK_COLOR, DEFAULT_INK_WIDTH)).toBe(pts);
    expect(penStroke(pts, "#d32f2f", DEFAULT_INK_WIDTH)).toEqual({ points: pts, color: "#d32f2f" });
    expect(penStroke(pts, DEFAULT_INK_COLOR, 0.16)).toEqual({ points: pts, width: 0.16 });
    expect(penStroke(pts, "#1e63d6", 0.08)).toEqual({ points: pts, color: "#1e63d6", width: 0.08 });
  });

  test("strokePen fills in the default pen", () => {
    expect(strokePen([[0, 0]])).toEqual({
      points: [[0, 0]],
      color: DEFAULT_INK_COLOR,
      width: DEFAULT_INK_WIDTH,
    });
    expect(strokePen({ points: [[0, 0]], width: 0.08 })).toEqual({
      points: [[0, 0]],
      color: DEFAULT_INK_COLOR,
      width: 0.08,
    });
  });

  test("eraseLabel names one object, not several", () => {
    expect(eraseLabel(["Note"])).toBe("Erase ink on Note");
    expect(eraseLabel(["Note", "Map"])).toBe("Erase ink");
  });

  test("eraseLabel shortens a long name to 200 chars with its own prefix, whole code points", () => {
    const long = eraseLabel(["n".repeat(188)]);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith("Erase ink on n")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    const emoji = eraseLabel(["😀".repeat(120)]);
    expect(emoji.length).toBeLessThanOrEqual(200);
    expect(emoji.endsWith("😀…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tool

const BOARD = "main";
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const GM: Viewer = { type: "gm" };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

const num = (value: number) => ({ type: "number" as const, value });
const text = (value: string) => ({ type: "text" as const, value });
const ref = (object: string) => ({ type: "ref" as const, object });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

function view(
  id: string,
  at: Point,
  cells: Record<string, WireResult> = {},
  rotation?: number,
): ObjectView {
  const all: ObjectView["cells"] = {
    name: { value: text(id), kind: "literal" },
    board: { value: ref(BOARD), kind: "literal" },
    position: { value: { type: "list", items: [num(at[0]), num(at[1])] }, kind: "literal" },
    container: { value: { type: "empty" }, kind: "structural" },
    face_up: { value: { type: "boolean", value: true }, kind: "literal" },
    shape: { value: { type: "shape", shape: rect(4, 4) }, kind: "literal" },
  };
  if (rotation !== undefined) all.rotation = { value: num(rotation), kind: "literal" };
  for (const [name, value] of Object.entries(cells)) all[name] = { value, kind: "literal" };
  return {
    id,
    is_template: false,
    is_character: false,
    cells: all,
    actions: [],
    action_states: [],
  };
}

function input(views: ObjectView[], camera: Camera = CAMERA): ReducerInput {
  const scene: Scene = buildScene({ views, covers: [], board: BOARD, viewer: GM, selection: [] });
  const byId = new Map(views.map((v) => [v.id, v]));
  return {
    scene,
    views: (id) => byId.get(id) ?? null,
    viewport: VIEWPORT,
    activeBoard: BOARD,
    viewer: GM,
    revision: 7,
    camera,
    selection: [],
  };
}

function pointer(type: "pointer_down" | "pointer_move" | "pointer_up", board: Point) {
  return {
    type,
    pointerId: 1,
    screen: toScreen(CAMERA, board, VIEWPORT),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" ? 0 : 1,
    modifiers: NO_MODS,
  } as InteractionEvent;
}

function gesture(points: Point[]): InteractionEvent[] {
  const first = points[0] as Point;
  const last = points.at(-1) as Point;
  return [
    pointer("pointer_down", first),
    ...points.slice(1, -1).map((p) => pointer("pointer_move", p)),
    pointer("pointer_up", last),
  ];
}

type S = ToolState<InkPhase, "ink">;

function drive(events: InteractionEvent[], world: ReducerInput, options: Partial<InkToolOptions>) {
  const tool: Tool<InkPhase, "ink"> = createInkTool();
  let state: S = tool.init({ ...DEFAULT_TOOL_OPTIONS.ink, ...options });
  const effects: Effect[] = [];
  events.forEach((event, i) => {
    const out = tool.reduce(state, event, { ...world, interactionId: `i${i + 1}` });
    state = out.state;
    effects.push(...out.effects);
  });
  return { state, effects };
}

const writes = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { type: "write" }> => e.type === "write");

const ink = (...strokes: Stroke[]) => ({ type: "ink" as const, strokes });
const A: Stroke = [
  [-1, 0],
  [1, 0],
];
const B: Stroke = {
  points: [
    [-1, 1],
    [1, 1],
  ],
  color: "#d32f2f",
  width: 0.08,
};
const C: Stroke = [
  [-1, -1.5],
  [1, -1.5],
];

describe("the pen", () => {
  test("a stroke on a note carries the options' colour and width", () => {
    const world = input([view("note", [0, 0])]);
    const { effects } = drive(
      gesture([
        [0, 0],
        [0.5, 0],
      ]),
      world,
      { color: "#1e63d6", width: 0.16 },
    );
    const op = writes(effects)[0]?.ops[0] as Extract<WireOp, { type: "set_value" }>;
    expect(op.value).toEqual(
      ink({
        points: [
          [0, 0],
          [0.5, 0],
        ],
        color: "#1e63d6",
        width: 0.16,
      }),
    );
  });

  test("the default pen still writes a bare point list, also for a new ink object", () => {
    const { effects } = drive(
      gesture([
        [5, 5],
        [6, 5],
      ]),
      input([]),
      {},
    );
    const op = writes(effects)[0]?.ops[0] as Extract<WireOp, { type: "create_object" }>;
    const cells = op.init?.cells as Record<string, unknown>;
    expect(cells.ink).toEqual(
      ink([
        [-0.5, 0],
        [0.5, 0],
      ]),
    );
  });
});

describe("the eraser", () => {
  test("a drag crossing two strokes writes one set_value without them, against the base revision", () => {
    const world = input([view("note", [0, 0], { ink: ink(A, B, C) })]);
    const { effects, state } = drive(
      gesture([
        [0, -0.5],
        [0, 0.5],
        [0, 1.2],
      ]),
      world,
      { eraser: true },
    );
    const ws = writes(effects);
    expect(ws).toHaveLength(1);
    const [w] = ws;
    expect(w?.stamp).toEqual({ interactionId: "i1", board: BOARD, viewer: GM, baseRevision: 7 });
    expect(w?.label).toBe("Erase ink on note");
    expect(w?.ops).toEqual([{ type: "set_value", object: "note", cell: "ink", value: ink(C) }]);
    expect(state.phase.erase ?? null).toBeNull();
  });

  test("erasing every stroke writes empty", () => {
    const world = input([view("note", [0, 0], { ink: ink(A) })]);
    const { effects } = drive(
      [pointer("pointer_down", [0, 0]), pointer("pointer_up", [0, 0])],
      world,
      {
        eraser: true,
      },
    );
    expect(writes(effects)[0]?.ops).toEqual([
      { type: "set_value", object: "note", cell: "ink", value: { type: "empty" } },
    ]);
  });

  test("a drag crossing nothing writes nothing, and its preview clears", () => {
    const world = input([view("note", [0, 0], { ink: ink(A, B) })]);
    const { effects } = drive(
      gesture([
        [3, 3],
        [3.5, 3.5],
      ]),
      world,
      { eraser: true },
    );
    expect(writes(effects)).toEqual([]);
    const overlays = effects.filter((e) => e.type === "overlays").at(-1);
    expect(overlays).toEqual({ type: "overlays", overlays: [] });
  });

  test("the reach is ERASER_RADIUS_PX on screen: a tap near a stroke erases at zoom 1, not zoomed in", () => {
    // 6 px at zoom 1 is 6 / 64 ≈ 0.094 units; the stroke's half width is 0.02.
    const near: Point = [0, 0.1];
    const world = input([view("note", [0, 0], { ink: ink(A) })]);
    const tap = [pointer("pointer_down", near), pointer("pointer_up", near)];
    expect(ERASER_RADIUS_PX).toBe(6);
    expect(writes(drive(tap, world, { eraser: true }).effects)).toHaveLength(1);
    const zoomed = input([view("note", [0, 0], { ink: ink(A) })], { x: 0, y: 0, zoom: 4 });
    expect(writes(drive(tap, zoomed, { eraser: true }).effects)).toEqual([]);
  });

  test("strokes are tested in each object's rotated frame; two objects are one write", () => {
    // A note at (5, 0) rotated 90°: its local stroke A runs down the board, x = 5.
    const world = input([
      view("note", [0, 0], { ink: ink(A) }),
      view("turned", [5, 0], { ink: ink(A, C) }, 90),
    ]);
    const { effects } = drive(
      gesture([
        [-2, 0.5],
        [0, -0.5],
        [5.5, -0.5],
      ]),
      world,
      { eraser: true },
    );
    const ws = writes(effects);
    expect(ws).toHaveLength(1);
    expect(ws[0]?.label).toBe("Erase ink");
    expect(ws[0]?.ops).toEqual([
      { type: "set_value", object: "turned", cell: "ink", value: ink(C) },
      { type: "set_value", object: "note", cell: "ink", value: { type: "empty" } },
    ]);
  });

  test("a short drag zoomed in reaches a fine stroke (segments are not thinned)", () => {
    // At zoom 8 the reach is 6 / 512 ≈ 0.0117 plus half of 0.02: about 0.022.
    const fine: Stroke = {
      points: [
        [-1, 0],
        [1, 0],
      ],
      width: 0.02,
    };
    const world = input([view("note", [0, 0], { ink: ink(fine) })], { x: 0, y: 0, zoom: 8 });
    const { effects } = drive(
      [pointer("pointer_down", [0, 0.04]), pointer("pointer_up", [0, 0])],
      world,
      { eraser: true },
    );
    expect(writes(effects)[0]?.ops).toEqual([
      { type: "set_value", object: "note", cell: "ink", value: { type: "empty" } },
    ]);
    // Short moves each count too: 0.01 steps from 0.06 down to 0.
    const steps = Array.from({ length: 7 }, (_, i) => [0, 0.06 - i * 0.01] as Point);
    const moved = drive(gesture(steps), world, { eraser: true });
    expect(writes(moved.effects)).toHaveLength(1);
  });

  test("movement past the point cap still erases", () => {
    const far: Stroke = [
      [205, 0],
      [215, 0],
    ];
    const world = input([view("note", [0, 0], { ink: ink(A, far) })]);
    const path: Point[] = Array.from({ length: INK_MAX_POINTS + 100 }, (_, i) => [i * 0.1, 5]);
    path.push([210, -5], [212, -5]);
    const { effects, state } = drive(gesture(path), world, { eraser: true });
    expect(writes(effects)[0]?.ops).toEqual([
      { type: "set_value", object: "note", cell: "ink", value: ink(A) },
    ]);
    expect(state.phase.erase ?? null).toBeNull();
  });

  test("an erase on a long-named object is a transaction the protocol accepts", () => {
    const world = input([view("n".repeat(188), [0, 0], { ink: ink(A) })]);
    const { effects } = drive(
      [pointer("pointer_down", [0, 0]), pointer("pointer_up", [0, 0])],
      world,
      {
        eraser: true,
      },
    );
    const [w] = writes(effects);
    expect(w?.label.length).toBeLessThanOrEqual(200);
    const parsed = TransactParamsSchema.safeParse({
      base_revision: w?.stamp.baseRevision,
      ops: w?.ops,
      label: w?.label,
    });
    expect(parsed.success).toBe(true);
  });

  test("a face-down object's ink is not erased", () => {
    const down = view("card", [0, 0], {
      ink: ink(A),
      face_up: { type: "boolean", value: false },
    });
    const { effects } = drive(
      [pointer("pointer_down", [0, 0]), pointer("pointer_up", [0, 0])],
      input([down]),
      {
        eraser: true,
      },
    );
    expect(writes(effects)).toEqual([]);
  });
});
