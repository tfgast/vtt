// @vitest-environment node
/**
 * The creation tools as pure reducers (vtt-3l6.8; DESIGN.md §4.3, §4.4,
 * §4.6 Appearance cells, §7 assets; FORMULAS.md §3.1; FIXTURES.md §3;
 * PROTOCOL.md §5 `create_object`; M4 plan Q15, Q21, Q22, review r2
 * findings 4, 8, 11, r3 finding 1): the effects each tool emits for given
 * event sequences.
 */
import type { Viewer, WireOp } from "@vtt/protocol";
import type { Point, Shape } from "@vtt/schema";
import {
  type Camera,
  type CancelReason,
  type Continuation,
  createCardTool,
  createImageTool,
  createNoteTool,
  createTokenTool,
  createZoneCircleTool,
  createZonePolygonTool,
  createZoneRectTool,
  creationContinuations,
  type Effect,
  fileStem,
  IMAGE_ACCEPT,
  type InteractionEvent,
  type InteractionStamp,
  importLabel,
  initMachine,
  type Modifiers,
  polygonProblem,
  type ReducerInput,
  reduce,
  registerCreationTools,
  type Scene,
  type SettledOutcome,
  type Tool,
  type ToolId,
  ToolRegistry,
  type ToolState,
  toScreen,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures

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
    activeBoard: "main",
    viewer: GM,
    revision: 7,
    camera: CAMERA,
    selection: [],
    views: () => null,
    ...over,
  };
}

type PointerType = "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel";

function pointer(
  type: PointerType,
  board: Point,
  over: { button?: number; pointerId?: number; modifiers?: Modifiers; camera?: Camera } = {},
): InteractionEvent {
  return {
    type,
    pointerId: over.pointerId ?? 1,
    screen: toScreen(over.camera ?? CAMERA, board, VIEWPORT),
    board,
    button: over.button ?? (type === "pointer_move" ? -1 : 0),
    buttons: type === "pointer_up" || type === "pointer_cancel" ? 0 : 1,
    modifiers: over.modifiers ?? NO_MODS,
  };
}

const down = (p: Point, modifiers: Modifiers = NO_MODS) =>
  pointer("pointer_down", p, { modifiers });
const move = (p: Point) => pointer("pointer_move", p);
const up = (p: Point, modifiers: Modifiers = NO_MODS) => pointer("pointer_up", p, { modifiers });
const click = (p: Point, modifiers: Modifiers = NO_MODS) => [down(p, modifiers), up(p, modifiers)];

function keyDown(key: string, modifiers: Modifiers = NO_MODS): InteractionEvent {
  return { type: "key_down", key, code: key, modifiers, inTextField: false };
}

function dblclick(p: Point): InteractionEvent {
  return {
    type: "double_click",
    screen: toScreen(CAMERA, p, VIEWPORT),
    board: p,
    modifiers: NO_MODS,
  };
}

function settled(interactionId: string, outcome: SettledOutcome): InteractionEvent {
  return { type: "settled", interactionId, outcome };
}

/**
 * Drives a tool through `events`, giving event n the interaction id `i<n>`
 * (from 1), and collects every effect. `input` may vary per event.
 */
function drive<TPhase, K extends ToolId>(
  tool: Tool<TPhase, K>,
  events: (InteractionEvent | { cancel: CancelReason })[],
  options: {
    state?: ToolState<TPhase, K>;
    input?: (n: number) => Partial<ReducerInput>;
    first?: number;
  } = {},
) {
  let state: ToolState<TPhase, K> = options.state ?? tool.init(defaultOptions(tool.id));
  const effects: Effect[] = [];
  const perEvent: Effect[][] = [];
  let n = options.first ?? 1;
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
    perEvent.push(out.effects);
  }
  return { state, effects, perEvent };
}

function defaultOptions<K extends ToolId>(id: K): never {
  return (id.startsWith("zone") ? { fog: false } : {}) as never;
}

function writes(effects: Effect[]) {
  return effects.filter((e): e is Extract<Effect, { type: "write" }> => e.type === "write");
}

function onlyWrite(effects: Effect[]) {
  const w = writes(effects);
  expect(w).toHaveLength(1);
  return w[0] as Extract<Effect, { type: "write" }>;
}

type CreateOp = Extract<WireOp, { type: "create_object" }>;

function createOp(effects: Effect[]): CreateOp {
  const w = onlyWrite(effects);
  expect(w.ops).toHaveLength(1);
  const op = w.ops[0];
  if (op?.type !== "create_object") throw new Error(`not a create_object: ${op?.type}`);
  return op;
}

function positionOf(op: CreateOp): Point {
  if (op.to.type !== "board") throw new Error("not a board destination");
  return op.to.position;
}

function stampAt(n: number, over: Partial<InteractionStamp> = {}): InteractionStamp {
  return { interactionId: `i${n}`, board: "main", viewer: GM, baseRevision: 7, ...over };
}

const SELECT_THEN_TOOL: Continuation[] = [
  { type: "select_created", opIndex: 0 },
  { type: "set_tool", tool: "select" },
];
const SELECT_ONLY: Continuation[] = [{ type: "select_created", opIndex: 0 }];

function closePoints(actual: Point[], expected: Point[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((p, i) => {
    expect(p[0]).toBeCloseTo((expected[i] as Point)[0], 9);
    expect(p[1]).toBeCloseTo((expected[i] as Point)[1], 9);
  });
}

function overlaysOf(effects: Effect[]) {
  const o = effects.filter(
    (e): e is Extract<Effect, { type: "overlays" }> => e.type === "overlays",
  );
  return o.at(-1)?.overlays;
}

// ---------------------------------------------------------------------------

describe("continuations", () => {
  test("select the created object, then switch to select unless Shift was held", () => {
    expect(creationContinuations(false)).toEqual(SELECT_THEN_TOOL);
    expect(creationContinuations(true)).toEqual(SELECT_ONLY);
  });
});

describe("fileStem", () => {
  test.each([
    ["Dungeon Map.png", "Dungeon Map"],
    ["crypt.level.1.webp", "crypt.level.1"],
    ["noext", "noext"],
    [".hidden", ".hidden"],
    ["", "Image"],
    ["  .png", "Image"],
  ])("%j → %j", (name, stem) => {
    expect(fileStem(name)).toBe(stem);
  });
});

describe("registration", () => {
  test("registerCreationTools registers the seven creation tools under their ids", () => {
    const registry = new ToolRegistry();
    registerCreationTools(registry);
    expect(registry.list().map((t) => t.id)).toEqual([
      "token",
      "card",
      "note",
      "zone-rect",
      "zone-circle",
      "zone-polygon",
      "image",
    ]);
  });
});

// ---------------------------------------------------------------------------
// token, card, note

describe("click tools", () => {
  const cases: [
    name: string,
    make: () => Tool<unknown, "token" | "card" | "note">,
    idBase: string,
    shape: Shape,
    cells: Record<string, unknown>,
  ][] = [
    [
      "token",
      createTokenTool as () => Tool<unknown, "token">,
      "token",
      { type: "circle", radius: 0.5 },
      { name: { type: "text", value: "Token" } },
    ],
    [
      "card",
      createCardTool as () => Tool<unknown, "card">,
      "card",
      { type: "rect", width: 2.5, height: 3.5 },
      { name: { type: "text", value: "Card" } },
    ],
    [
      "note",
      createNoteTool as () => Tool<unknown, "note">,
      "note",
      { type: "rect", width: 2, height: 2 },
      {
        name: { type: "text", value: "Note" },
        color: { type: "text", value: "#fff3a0" },
        text: { type: "text", value: "" },
      },
    ],
  ];

  test.each(cases)(
    "%s: a click creates the object at the press point, selected, back to select",
    (_name, make, idBase, shape, cells) => {
      const tool = make();
      const { perEvent, effects } = drive(tool, click([3, -2]));
      // The press previews; nothing is written until the release.
      expect(writes(perEvent[0] ?? [])).toEqual([]);
      expect(overlaysOf(perEvent[0] ?? [])).toEqual([
        { kind: "creation_preview", anchor: [3, -2], shape, zone: false },
      ]);
      const w = onlyWrite(effects);
      expect(w.stamp).toEqual(stampAt(1));
      expect(w.continuations).toEqual(SELECT_THEN_TOOL);
      expect(w.ops).toEqual([
        {
          type: "create_object",
          id_base: idBase,
          to: { type: "board", board: "main", position: [3, -2] },
          init: { shape, cells },
        },
      ]);
      expect(overlaysOf(perEvent[1] ?? [])).toEqual([]);
    },
  );

  test.each(cases)("%s: Shift at the press keeps the tool", (_name, make) => {
    const tool = make();
    // Shift is decided at the press, not at the release.
    const { effects } = drive(tool, [down([0, 0], SHIFT), up([0, 0])]);
    expect(onlyWrite(effects).continuations).toEqual(SELECT_ONLY);
    const released = drive(tool, [down([0, 0]), up([0, 0], SHIFT)]);
    expect(onlyWrite(released.effects).continuations).toEqual(SELECT_THEN_TOOL);
  });

  test("the stamp is the press's: board, viewer and revision at the press", () => {
    const tool = createTokenTool();
    const { effects } = drive(tool, click([1, 1]), {
      input: (n) =>
        n === 1
          ? { activeBoard: "crypt", revision: 3, viewer: { type: "character", id: "aldric" } }
          : { activeBoard: "main", revision: 9 },
    });
    const w = onlyWrite(effects);
    expect(w.stamp).toEqual({
      interactionId: "i1",
      board: "crypt",
      viewer: { type: "character", id: "aldric" },
      baseRevision: 3,
    });
    expect(createOp(effects).to).toEqual({ type: "board", board: "crypt", position: [1, 1] });
  });

  test("a drag still creates at the press point", () => {
    const { effects } = drive(createCardTool(), [down([1, 1]), move([4, 4]), up([4, 4])]);
    expect(positionOf(createOp(effects))).toEqual([1, 1]);
  });

  test("no active board, a secondary button, a cancelled pointer or a cancel create nothing", () => {
    const tool = createTokenTool();
    expect(
      writes(drive(tool, click([0, 0]), { input: () => ({ activeBoard: null }) }).effects),
    ).toEqual([]);
    expect(
      writes(
        drive(tool, [
          pointer("pointer_down", [0, 0], { button: 2 }),
          pointer("pointer_up", [0, 0], { button: 2 }),
        ]).effects,
      ),
    ).toEqual([]);
    const cancelled = drive(tool, [down([0, 0]), pointer("pointer_cancel", [0, 0]), up([0, 0])]);
    expect(writes(cancelled.effects)).toEqual([]);
    for (const reason of ["escape", "tool_switch", "board_change"] as const) {
      const out = drive(tool, [down([0, 0]), { cancel: reason }, up([0, 0])]);
      expect(writes(out.effects)).toEqual([]);
      expect(overlaysOf(out.perEvent[1] ?? [])).toEqual([]);
    }
  });

  test("another pointer's release does not complete the press", () => {
    const tool = createTokenTool();
    const { effects } = drive(tool, [
      down([0, 0]),
      pointer("pointer_up", [5, 5], { pointerId: 2 }),
    ]);
    expect(writes(effects)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// zone-rect, zone-circle

const ZONE_NAME = { name: { type: "text", value: "Zone" } };
const FOG_CELLS = {
  ...ZONE_NAME,
  opaque: { type: "boolean", value: true },
  visible_to: { type: "viewers", viewers: ["gm"] },
};

describe("zone-rect", () => {
  test("a drag from a corner makes the rect between the corners, anchored at its center", () => {
    const { effects, perEvent } = drive(createZoneRectTool(), [
      down([1, 1]),
      move([3, 2]),
      move([5, 4]),
      up([5, 4]),
    ]);
    expect(overlaysOf(perEvent[2] ?? [])).toEqual([
      {
        kind: "creation_preview",
        anchor: [3, 2.5],
        shape: { type: "rect", width: 4, height: 3 },
        zone: true,
      },
    ]);
    const w = onlyWrite(effects);
    expect(w.stamp).toEqual(stampAt(1));
    expect(w.continuations).toEqual(SELECT_THEN_TOOL);
    expect(w.ops).toEqual([
      {
        type: "create_object",
        id_base: "zone",
        to: { type: "board", board: "main", position: [3, 2.5] },
        init: { is_zone: true, shape: { type: "rect", width: 4, height: 3 }, cells: ZONE_NAME },
      },
    ]);
  });

  test("a drag up and to the left works the same way", () => {
    const { effects } = drive(createZoneRectTool(), [down([5, 4]), move([1, 1]), up([1, 1])]);
    const op = createOp(effects);
    expect(positionOf(op)).toEqual([3, 2.5]);
    expect(op.init?.shape).toEqual({ type: "rect", width: 4, height: 3 });
  });

  test("a click alone makes a 2 × 2 zone centered on the click", () => {
    const { effects } = drive(createZoneRectTool(), click([2, 3]));
    const op = createOp(effects);
    expect(positionOf(op)).toEqual([2, 3]);
    expect(op.init?.shape).toEqual({ type: "rect", width: 2, height: 2 });
  });

  test("a thin drag is held to the 0.25 minimum in each dimension, from the corner", () => {
    // 1 unit = 64 px at zoom 1, so a 0.1-unit move is past the 4 px click slop.
    const { effects } = drive(createZoneRectTool(), [down([0, 0]), move([3, 0.1]), up([3, 0.1])]);
    const op = createOp(effects);
    expect(op.init?.shape).toEqual({ type: "rect", width: 3, height: 0.25 });
    expect(positionOf(op)).toEqual([1.5, 0.125]);
    const leftUp = drive(createZoneRectTool(), [down([0, 0]), move([-0.1, -2]), up([-0.1, -2])]);
    const op2 = createOp(leftUp.effects);
    expect(op2.init?.shape).toEqual({ type: "rect", width: 0.25, height: 2 });
    expect(positionOf(op2)).toEqual([-0.125, -1]);
  });

  test("with fog, the zone is opaque and visible to the GM", () => {
    const tool = createZoneRectTool();
    const { effects } = drive(tool, [down([0, 0]), move([2, 2]), up([2, 2])], {
      state: tool.init({ fog: true }),
    });
    const op = createOp(effects);
    expect(op.init).toEqual({
      is_zone: true,
      shape: { type: "rect", width: 2, height: 2 },
      cells: FOG_CELLS,
    });
  });

  test("Shift at the press keeps the tool", () => {
    const { effects } = drive(createZoneRectTool(), [
      down([0, 0], SHIFT),
      move([2, 2]),
      up([2, 2]),
    ]);
    expect(onlyWrite(effects).continuations).toEqual(SELECT_ONLY);
  });

  test.each(["escape", "tool_switch", "board_change", "viewer_change"] as const)(
    "a %s cancel ends the drag with no write and clears the preview",
    (reason) => {
      const { effects, perEvent } = drive(createZoneRectTool(), [
        down([0, 0]),
        move([2, 2]),
        { cancel: reason },
        up([2, 2]),
      ]);
      expect(writes(effects)).toEqual([]);
      expect(overlaysOf(perEvent[2] ?? [])).toEqual([]);
    },
  );
});

describe("zone-circle", () => {
  test("a drag from the center sets the radius", () => {
    const { effects, perEvent } = drive(createZoneCircleTool(), [
      down([1, 1]),
      move([4, 5]),
      up([4, 5]),
    ]);
    expect(overlaysOf(perEvent[1] ?? [])).toEqual([
      {
        kind: "creation_preview",
        anchor: [1, 1],
        shape: { type: "circle", radius: 5 },
        zone: true,
      },
    ]);
    const w = onlyWrite(effects);
    expect(w.stamp).toEqual(stampAt(1));
    expect(w.continuations).toEqual(SELECT_THEN_TOOL);
    expect(w.ops).toEqual([
      {
        type: "create_object",
        id_base: "zone",
        to: { type: "board", board: "main", position: [1, 1] },
        init: { is_zone: true, shape: { type: "circle", radius: 5 }, cells: ZONE_NAME },
      },
    ]);
  });

  test("a click alone makes an r 1 zone; a short drag is held to r 0.25", () => {
    expect(createOp(drive(createZoneCircleTool(), click([2, 2])).effects).init?.shape).toEqual({
      type: "circle",
      radius: 1,
    });
    const short = drive(createZoneCircleTool(), [down([0, 0]), move([0.1, 0]), up([0.1, 0])]);
    expect(createOp(short.effects).init?.shape).toEqual({ type: "circle", radius: 0.25 });
  });

  test("with fog and Shift: fog cells, the tool kept", () => {
    const tool = createZoneCircleTool();
    const { effects } = drive(tool, [down([0, 0], SHIFT), move([0, 3]), up([0, 3])], {
      state: tool.init({ fog: true }),
    });
    expect(createOp(effects).init?.cells).toEqual(FOG_CELLS);
    expect(onlyWrite(effects).continuations).toEqual(SELECT_ONLY);
  });

  test("the click slop is in screen pixels: zoomed out, a small board move is a drag", () => {
    const camera: Camera = { x: 0, y: 0, zoom: 1 / 16 }; // 4 px per unit
    const events = [
      pointer("pointer_down", [0, 0], { camera }),
      pointer("pointer_move", [3, 0], { camera }),
      pointer("pointer_up", [3, 0], { camera }),
    ];
    const { effects } = drive(createZoneCircleTool(), events, { input: () => ({ camera }) });
    expect(createOp(effects).init?.shape).toEqual({ type: "circle", radius: 3 });
    // 0.5 units is 2 px there: still a click.
    const tiny = drive(
      createZoneCircleTool(),
      [pointer("pointer_down", [0, 0], { camera }), pointer("pointer_up", [0.5, 0], { camera })],
      { input: () => ({ camera }) },
    );
    expect(createOp(tiny.effects).init?.shape).toEqual({ type: "circle", radius: 1 });
  });
});

// ---------------------------------------------------------------------------
// zone-polygon

const TRIANGLE: Point[] = [
  [0, 0],
  [4, 0],
  [2, 3],
];
/** TRIANGLE relative to its bounding-box center [2, 1.5]. */
const TRIANGLE_REL: Point[] = [
  [-2, -1.5],
  [2, -1.5],
  [0, 1.5],
];

describe("zone-polygon", () => {
  test("clicks add vertices and the draft overlay follows the cursor", () => {
    const { perEvent } = drive(createZonePolygonTool(), [
      ...click([0, 0]),
      move([4, 0]),
      ...click([4, 0]),
      move([2, 3]),
      ...click([2, 3]),
      move([0.02, 0.02]),
    ]);
    expect(overlaysOf(perEvent[2] ?? [])).toEqual([
      { kind: "polygon_draft", points: [[0, 0]], cursor: [4, 0], closing: false },
    ]);
    // Near the first vertex with three points: the next click closes.
    expect(overlaysOf(perEvent[8] ?? [])).toEqual([
      { kind: "polygon_draft", points: TRIANGLE, cursor: [0.02, 0.02], closing: true },
    ]);
  });

  const closers: [string, InteractionEvent[]][] = [
    ["a click on the first vertex", click([0.05, -0.05])],
    ["a double-click", [dblclick([2, 3])]],
    ["Enter", [keyDown("Enter")]],
  ];

  test.each(closers)("closes with %s: one zone, anchor at the bounding-box center", (_n, close) => {
    const tool = createZonePolygonTool();
    const { effects, state } = drive(tool, [
      ...click([0, 0]),
      ...click([4, 0]),
      ...click([2, 3]),
      ...close,
    ]);
    const w = onlyWrite(effects);
    expect(w.stamp).toEqual(stampAt(1));
    expect(w.continuations).toEqual(SELECT_THEN_TOOL);
    const op = createOp(effects);
    expect(op.id_base).toBe("zone");
    expect(op.to).toEqual({ type: "board", board: "main", position: [2, 1.5] });
    expect(op.init?.is_zone).toBe(true);
    expect(op.init?.cells).toEqual(ZONE_NAME);
    const shape = op.init?.shape;
    if (shape?.type !== "polygon") throw new Error("not a polygon");
    closePoints(shape.points, TRIANGLE_REL);
    expect(overlaysOf(effects)).toEqual([]);
    expect(state.phase).toEqual(tool.init({ fog: false }).phase);
  });

  test("a double-click's own clicks add no vertex (DOM order: down, up, down, up, dblclick)", () => {
    const { effects } = drive(createZonePolygonTool(), [
      ...click([0, 0]),
      ...click([4, 0]),
      ...click([2, 3]),
      ...click([2, 3]),
      dblclick([2, 3]),
    ]);
    const shape = createOp(effects).init?.shape;
    if (shape?.type !== "polygon") throw new Error("not a polygon");
    closePoints(shape.points, TRIANGLE_REL);
  });

  test("Shift at the first click keeps the tool; fog adds the fog cells", () => {
    const tool = createZonePolygonTool();
    const { effects } = drive(
      tool,
      [...click([0, 0], SHIFT), ...click([4, 0]), ...click([2, 3]), keyDown("Enter")],
      { state: tool.init({ fog: true }) },
    );
    expect(onlyWrite(effects).continuations).toEqual(SELECT_ONLY);
    expect(createOp(effects).init?.cells).toEqual(FOG_CELLS);
  });

  test("the stamp is the first click's", () => {
    const { effects } = drive(
      createZonePolygonTool(),
      [...click([0, 0]), ...click([4, 0]), ...click([2, 3]), keyDown("Enter")],
      { input: (n) => ({ revision: 7 + n }) },
    );
    expect(onlyWrite(effects).stamp).toEqual(stampAt(1, { baseRevision: 8 }));
  });

  test("a bow-tie is refused with a notice and no write", () => {
    const bowTie: Point[] = [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
    ];
    expect(polygonProblem(bowTie)).toBeDefined();
    const { effects, state } = drive(createZonePolygonTool(), [
      ...bowTie.flatMap((p) => click(p)),
      keyDown("Enter"),
    ]);
    expect(writes(effects)).toEqual([]);
    const notices = effects.filter((e) => e.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "notice", level: "warning" });
    expect(overlaysOf(effects)).toEqual([]);
    expect(state.phase).toEqual(createZonePolygonTool().init({ fog: false }).phase);
  });

  test("closing with fewer than three points is refused the same way", () => {
    const { effects } = drive(createZonePolygonTool(), [
      ...click([0, 0]),
      ...click([4, 0]),
      keyDown("Enter"),
    ]);
    expect(writes(effects)).toEqual([]);
    expect(effects.filter((e) => e.type === "notice")).toHaveLength(1);
  });

  test("a click near the first vertex with fewer than three points adds no vertex", () => {
    const { effects } = drive(createZonePolygonTool(), [
      ...click([0, 0]),
      ...click([4, 0]),
      ...click([0.02, 0]),
      ...click([2, 3]),
      keyDown("Enter"),
    ]);
    // [0.02, 0] is within the close slop of [0, 0] but there were only two points.
    const shape = createOp(effects).init?.shape;
    if (shape?.type !== "polygon") throw new Error("not a polygon");
    expect(shape.points).toHaveLength(3);
  });

  test.each(["escape", "tool_switch", "board_change", "viewer_change"] as const)(
    "a %s cancel discards the draft: no write, overlay cleared, later Enter does nothing",
    (reason) => {
      const { effects, perEvent } = drive(createZonePolygonTool(), [
        ...click([0, 0]),
        ...click([4, 0]),
        ...click([2, 3]),
        { cancel: reason },
        keyDown("Enter"),
      ]);
      expect(writes(effects)).toEqual([]);
      expect(overlaysOf(perEvent[6] ?? [])).toEqual([]);
      expect(effects.filter((e) => e.type === "notice")).toEqual([]);
    },
  );

  test("Escape through the machine cancels the draft", () => {
    const registry = new ToolRegistry();
    registerCreationTools(registry);
    let m = initMachine(registry, { tool: "zone-polygon", board: "main", viewer: GM });
    const all: Effect[] = [];
    for (const event of [
      ...click([0, 0]),
      ...click([4, 0]),
      ...click([2, 3]),
      keyDown("Escape"),
      keyDown("Enter"),
    ]) {
      const out = reduce(m, event, makeInput(), registry);
      m = out.state;
      all.push(...out.effects);
    }
    expect(writes(all)).toEqual([]);
  });

  test("Enter or a double-click without a draft does nothing", () => {
    const { effects } = drive(createZonePolygonTool(), [keyDown("Enter"), dblclick([1, 1])]);
    expect(effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cancels, per tool

describe("a cancel ends an unfinished press or drag, per tool", () => {
  const tools: [name: string, make: () => Tool<unknown, ToolId>][] = [
    ["token", createTokenTool as () => Tool<unknown, ToolId>],
    ["card", createCardTool as () => Tool<unknown, ToolId>],
    ["note", createNoteTool as () => Tool<unknown, ToolId>],
    ["zone-rect", createZoneRectTool as () => Tool<unknown, ToolId>],
    ["zone-circle", createZoneCircleTool as () => Tool<unknown, ToolId>],
    ["image", createImageTool as () => Tool<unknown, ToolId>],
  ];
  const reasons = ["escape", "tool_switch", "board_change", "viewer_change"] as const;
  const cases = tools.flatMap(([name, make]) =>
    reasons.map((reason) => [name, reason, make] as const),
  );

  test.each(cases)("%s, %s: no write, no picker, preview cleared", (name, reason, make) => {
    const out = drive(make(), [down([0, 0]), move([2, 2]), { cancel: reason }, up([2, 2])]);
    expect(writes(out.effects)).toEqual([]);
    expect(out.effects.filter((e) => e.type === "pick_file")).toEqual([]);
    if (name !== "image") expect(overlaysOf(out.perEvent[2] ?? [])).toEqual([]);
  });

  test.each(tools)("%s: a cancelled pointer creates nothing", (_name, make) => {
    const out = drive(make(), [down([0, 0]), pointer("pointer_cancel", [0, 0]), up([0, 0])]);
    expect(writes(out.effects)).toEqual([]);
    expect(out.effects.filter((e) => e.type === "pick_file")).toEqual([]);
  });

  test.each(tools)("%s: with no active board a click creates nothing", (_name, make) => {
    const out = drive(make(), click([0, 0]), { input: () => ({ activeBoard: null }) });
    expect(out.effects.filter((e) => e.type === "write" || e.type === "pick_file")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// image

function png(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

describe("image", () => {
  test("click → pick_file → upload → write, driven by settled events", () => {
    const tool = createImageTool();
    const file = png("Dungeon Map.png");
    const a = drive(tool, click([5, 6]));
    expect(a.perEvent[0]).toEqual([]);
    expect(a.perEvent[1]).toEqual([{ type: "pick_file", stamp: stampAt(1), accept: IMAGE_ACCEPT }]);
    expect(IMAGE_ACCEPT).toBe("image/png,image/jpeg,image/webp,image/gif");

    const b = drive(tool, [settled("i1", { type: "file_picked", file })], {
      state: a.state,
      first: 3,
    });
    expect(b.effects).toEqual([{ type: "upload", stamp: stampAt(1), file }]);

    const c = drive(
      tool,
      [
        settled("i1", {
          type: "uploaded",
          path: "t.json.assets/map-0123abcd.png",
          width: 1200,
          height: 800,
        }),
      ],
      { state: b.state, first: 4, input: () => ({ activeBoard: "other", revision: 30 }) },
    );
    const w = onlyWrite(c.effects);
    // The stamp is the click's, whatever is active when the upload ends.
    expect(w.stamp).toEqual(stampAt(1));
    expect(w.continuations).toEqual(SELECT_THEN_TOOL);
    expect(w.ops).toEqual([
      {
        type: "create_object",
        id_base: "image",
        to: { type: "board", board: "main", position: [5, 6] },
        init: {
          shape: { type: "rect", width: 12, height: 8 },
          cells: {
            name: { type: "text", value: "Dungeon Map" },
            image: { type: "text", value: "t.json.assets/map-0123abcd.png" },
          },
        },
      },
    ]);
    // The write's own settlement ends nothing further.
    const d = drive(
      tool,
      [settled("i1", { type: "write", result: { status: "uncertain", reason: "x" } })],
      { state: c.state, first: 5 },
    );
    expect(d.effects).toEqual([]);
  });

  test("Shift at the click keeps the tool", () => {
    const tool = createImageTool();
    const a = drive(tool, [down([0, 0], SHIFT), up([0, 0])]);
    const b = drive(
      tool,
      [
        settled("i1", { type: "file_picked", file: png("a.png") }),
        settled("i1", { type: "uploaded", path: "p.png", width: 100, height: 50 }),
      ],
      { state: a.state, first: 3 },
    );
    expect(onlyWrite(b.effects).continuations).toEqual(SELECT_ONLY);
    expect(createOp(b.effects).init?.shape).toEqual({ type: "rect", width: 1, height: 0.5 });
  });

  test("a dismissed picker ends the interaction with nothing", () => {
    const tool = createImageTool();
    const a = drive(tool, click([0, 0]));
    const b = drive(
      tool,
      [
        settled("i1", { type: "file_picked", file: null }),
        settled("i1", { type: "uploaded", path: "p.png", width: 100, height: 50 }),
      ],
      { state: a.state, first: 3 },
    );
    expect(b.effects).toEqual([]);
  });

  test("a file_drop uploads the first accepted image at the drop point", () => {
    const tool = createImageTool();
    const text = new File(["x"], "notes.txt", { type: "text/plain" });
    const map = png("crypt.png");
    const a = drive(tool, [
      { type: "file_drop", files: [text, map], screen: [0, 0], board: [-3, 2] },
    ]);
    expect(a.effects).toEqual([{ type: "upload", stamp: stampAt(1), file: map }]);
    const b = drive(
      tool,
      [settled("i1", { type: "uploaded", path: "c.png", width: 250, height: 400 })],
      { state: a.state, first: 2 },
    );
    const op = createOp(b.effects);
    expect(positionOf(op)).toEqual([-3, 2]);
    expect(op.init?.shape).toEqual({ type: "rect", width: 2.5, height: 4 });
    expect(op.init?.cells?.name).toEqual({ type: "text", value: "crypt" });
    // A drop has no modifiers: the tool returns to select.
    expect(onlyWrite(b.effects).continuations).toEqual(SELECT_THEN_TOOL);
  });

  test("a drop with no accepted image is a notice and nothing else", () => {
    const tool = createImageTool();
    const { effects } = drive(tool, [
      {
        type: "file_drop",
        files: [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })],
        screen: [0, 0],
        board: [0, 0],
      },
    ]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "notice", level: "warning" });
  });

  test("upload_failed is a notice and no write", () => {
    const tool = createImageTool();
    const a = drive(tool, [
      { type: "file_drop", files: [png("a.png")], screen: [0, 0], board: [0, 0] },
    ]);
    const b = drive(tool, [settled("i1", { type: "upload_failed", message: "too large" })], {
      state: a.state,
      first: 2,
    });
    expect(writes(b.effects)).toEqual([]);
    expect(b.effects).toHaveLength(1);
    expect(b.effects[0]).toMatchObject({ type: "notice", level: "error" });
    expect((b.effects[0] as { text: string }).text).toContain("too large");
  });

  test("a started upload finishes after any cancel; a cancel before the release picks nothing", () => {
    const tool = createImageTool();
    const a = drive(tool, [
      { type: "file_drop", files: [png("a.png")], screen: [0, 0], board: [1, 1] },
      { cancel: "tool_switch" },
      { cancel: "board_change" },
    ]);
    const b = drive(
      tool,
      [settled("i1", { type: "uploaded", path: "a.png", width: 100, height: 100 })],
      { state: a.state, first: 4 },
    );
    expect(onlyWrite(b.effects).stamp).toEqual(stampAt(1));
    // Cancelled between press and release: no picker.
    const c = drive(tool, [down([0, 0]), { cancel: "escape" }, up([0, 0])]);
    expect(c.effects.filter((e) => e.type === "pick_file")).toEqual([]);
  });

  test("a cancel while the picker is open discards the picked file (unfinished gesture)", () => {
    const tool = createImageTool();
    const a = drive(tool, [...click([0, 0]), { cancel: "tool_switch" }]);
    const b = drive(tool, [settled("i1", { type: "file_picked", file: png("a.png") })], {
      state: a.state,
      first: 4,
    });
    expect(b.effects).toEqual([]);
  });

  test("two uploads in flight finish independently, each on its own stamp", () => {
    const tool = createImageTool();
    const a = drive(
      tool,
      [
        { type: "file_drop", files: [png("one.png")], screen: [0, 0], board: [1, 1] },
        { type: "file_drop", files: [png("two.png")], screen: [0, 0], board: [9, 9] },
      ],
      { input: (n) => ({ activeBoard: n === 1 ? "main" : "crypt" }) },
    );
    const b = drive(
      tool,
      [
        settled("i2", { type: "uploaded", path: "two.png", width: 100, height: 100 }),
        settled("i1", { type: "uploaded", path: "one.png", width: 100, height: 100 }),
      ],
      { state: a.state, first: 3 },
    );
    const [w2, w1] = writes(b.effects);
    if (w1 === undefined || w2 === undefined) throw new Error("two writes expected");
    expect(w2.stamp).toEqual(stampAt(2, { board: "crypt" }));
    expect(w1.stamp).toEqual(stampAt(1));
    expect((w2.ops[0] as CreateOp).init?.cells?.name).toEqual({ type: "text", value: "two" });
    expect((w1.ops[0] as CreateOp).to).toEqual({ type: "board", board: "main", position: [1, 1] });
  });

  test("a long file stem keeps the full name but the label fits the 200-character limit", () => {
    const tool = createImageTool();
    const stem = `${"a".repeat(193)}😀`; // 195 UTF-16 code units
    const a = drive(tool, [
      { type: "file_drop", files: [png(`${stem}.png`)], screen: [0, 0], board: [0, 0] },
    ]);
    const b = drive(
      tool,
      [settled("i1", { type: "uploaded", path: "a.png", width: 100, height: 100 })],
      { state: a.state, first: 2 },
    );
    const w = onlyWrite(b.effects);
    expect(w.label).toBe(`Import ${"a".repeat(192)}…`);
    expect(w.label.length).toBe(200);
    // An emoji at the cut is dropped whole, never split into a lone surrogate.
    expect(importLabel(`${"b".repeat(191)}😀x`)).toBe(`Import ${"b".repeat(191)}…`);
    expect(createOp(b.effects).init?.cells?.name).toEqual({ type: "text", value: stem });
    // A short stem is labelled in full.
    expect(importLabel("Crypt")).toBe("Import Crypt");
  });

  test("an unmeasurable image is a notice and no write", () => {
    const tool = createImageTool();
    const a = drive(tool, [
      { type: "file_drop", files: [png("a.png")], screen: [0, 0], board: [0, 0] },
    ]);
    const b = drive(
      tool,
      [settled("i1", { type: "uploaded", path: "a.png", width: 0, height: 10 })],
      {
        state: a.state,
        first: 2,
      },
    );
    expect(writes(b.effects)).toEqual([]);
    expect(b.effects[0]).toMatchObject({ type: "notice", level: "error" });
  });
});
