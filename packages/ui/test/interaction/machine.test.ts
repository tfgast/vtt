// @vitest-environment node
import type { Viewer } from "@vtt/protocol";
import type { Point } from "@vtt/schema";
import {
  type Camera,
  type CancelReason,
  captureStamp,
  type Effect,
  type InteractionEvent,
  initMachine,
  type MachineState,
  type Modifiers,
  machineCursor,
  type ReducerInput,
  reduce,
  type Scene,
  setTool,
  syncInput,
  type Tool,
  type ToolId,
  type ToolInput,
  ToolRegistry,
  type ToolState,
  toBoard,
  toScreen,
  zoomAt,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures

const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const EMPTY_SCENE: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };

function makeInput(over: Partial<ReducerInput> = {}): ReducerInput {
  return {
    scene: EMPTY_SCENE,
    viewport: { width: 800, height: 600, dpr: 1 },
    activeBoard: "main",
    viewer: GM,
    revision: 5,
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    views: () => null,
    ...over,
  };
}

type Call =
  | { tool: ToolId; kind: "reduce"; event: InteractionEvent; input: ToolInput }
  | { tool: ToolId; kind: "cancel"; reason: CancelReason };

/** A stub tool counting events in its phase and recording every call. */
function stubTool(
  id: ToolId,
  calls: Call[],
  respond: (event: InteractionEvent, input: ToolInput) => Effect[] = () => [],
): Tool<number> {
  return {
    id,
    init: (options) => ({ tool: id, options, phase: 0 }) as ToolState<number>,
    cursor: (state) => `${id}-${state.phase}`,
    reduce(state, event, input) {
      calls.push({ tool: id, kind: "reduce", event, input });
      return { state: { ...state, phase: state.phase + 1 }, effects: respond(event, input) };
    },
    cancel(state, reason) {
      calls.push({ tool: id, kind: "cancel", reason });
      return { state: { ...state, phase: 0 }, effects: [{ type: "overlays", overlays: [] }] };
    },
  };
}

function setup(respond?: (event: InteractionEvent, input: ToolInput) => Effect[]) {
  const calls: Call[] = [];
  const registry = new ToolRegistry();
  registry.register(stubTool("select", calls, respond));
  registry.register(stubTool("token", calls, respond));
  registry.register(stubTool("zone-rect", calls, respond));
  registry.register(stubTool("image", calls, respond));
  const state = initMachine(registry, { tool: "select", board: "main", viewer: GM });
  return { calls, registry, state };
}

function pointer(
  type: "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel",
  screen: Point,
  camera: Camera,
  over: { button?: number; buttons?: number; pointerId?: number; modifiers?: Modifiers } = {},
): InteractionEvent {
  return {
    type,
    pointerId: over.pointerId ?? 1,
    screen,
    board: toBoard(camera, screen, { width: 800, height: 600 }),
    button: over.button ?? 0,
    buttons: over.buttons ?? (type === "pointer_up" ? 0 : 1),
    modifiers: over.modifiers ?? NO_MODS,
  };
}

function key(
  type: "key_down" | "key_up",
  k: string,
  code: string,
  inTextField = false,
  modifiers: Modifiers = NO_MODS,
): InteractionEvent {
  return { type, key: k, code, modifiers, inTextField };
}

function cameraOf(effects: Effect[]): Camera {
  const cams = effects.filter((e) => e.type === "camera");
  expect(cams).toHaveLength(1);
  const e = cams[0];
  if (e?.type !== "camera") throw new Error("unreachable");
  return e.camera;
}

function closeTo(a: Point, b: Point) {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
}

// ---------------------------------------------------------------------------

const CTRL: Modifiers = { ...NO_MODS, ctrl: true };
const META: Modifiers = { ...NO_MODS, meta: true };

describe("wheel pan (M6-D11)", () => {
  test.each([
    ["a mouse wheel down", { x: 0, y: 0, zoom: 1 }, 0, 100],
    ["a two-finger scroll right and up", { x: 3, y: -2, zoom: 2 }, 40, -25],
    ["a horizontal scroll at zoom 0.5", { x: -5, y: 7, zoom: 0.5 }, -64, 0],
  ] as [string, Camera, number, number][])(
    "%s pans the camera by (deltaX, deltaY) screen pixels without reaching the tool",
    (_n, camera, deltaX, deltaY) => {
      const { calls, registry, state } = setup();
      const input = makeInput({ camera });
      const screen: Point = [123, 45];
      const event: InteractionEvent = {
        type: "wheel",
        screen,
        board: toBoard(camera, screen, input.viewport),
        deltaX,
        deltaY,
        modifiers: NO_MODS,
      };
      const out = reduce(state, event, input, registry);
      expect(out.effects).toHaveLength(1);
      const next = cameraOf(out.effects);
      expect(next.zoom).toBe(camera.zoom);
      // The view moves with the scroll: the board point that was (deltaX, deltaY)
      // away from the cursor is now under it.
      const ahead: Point = [screen[0] + deltaX, screen[1] + deltaY];
      closeTo(toBoard(next, screen, input.viewport), toBoard(camera, ahead, input.viewport));
      expect(calls).toEqual([]);
      expect(out.state).toEqual(state);
    },
  );

  test("Shift or Alt alone still pans", () => {
    const { registry, state } = setup();
    const input = makeInput();
    for (const modifiers of [
      { ...NO_MODS, shift: true },
      { ...NO_MODS, alt: true },
    ]) {
      const out = reduce(
        state,
        { type: "wheel", screen: [5, 5], board: [0, 0], deltaX: 0, deltaY: 64, modifiers },
        input,
        registry,
      );
      expect(cameraOf(out.effects)).toEqual({ x: 0, y: 1, zoom: 1 });
    }
  });

  test("a zero wheel emits no camera effect", () => {
    const { registry, state } = setup();
    const out = reduce(
      state,
      { type: "wheel", screen: [5, 5], board: [0, 0], deltaX: 0, deltaY: 0, modifiers: NO_MODS },
      makeInput(),
      registry,
    );
    expect(out.effects).toEqual([]);
  });

  test("a tool's wheel hook keeps precedence over the pan (a list that scrolls)", () => {
    const { calls, registry, state } = setup();
    const base = registry.get("select") as Tool<number>;
    const claimed: InteractionEvent[] = [];
    const claiming = new ToolRegistry();
    claiming.register({
      ...base,
      wheel(s, event) {
        claimed.push(event);
        return { state: s, effects: [] };
      },
    });
    const out = reduce(
      state,
      { type: "wheel", screen: [5, 5], board: [0, 0], deltaX: 0, deltaY: 100, modifiers: NO_MODS },
      makeInput(),
      claiming,
    );
    expect(out.effects).toEqual([]);
    expect(claimed).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

describe("ctrl+wheel and meta+wheel (pinch) zoom", () => {
  const cases: [name: string, camera: Camera, screen: Point, deltaY: number, factor: number][] = [
    ["zoom in at the center", { x: 0, y: 0, zoom: 1 }, [400, 300], -100, 1.1],
    ["zoom out at a corner", { x: 3, y: -2, zoom: 2 }, [10, 590], 100, 1 / 1.1],
    ["a large trackpad delta", { x: -5, y: 7, zoom: 0.5 }, [123, 45], -350, 1.1 ** 3.5],
    ["a zero delta leaves the camera", { x: 1, y: 1, zoom: 1 }, [200, 200], 0, 1],
  ];

  test.each(cases.map((c, i) => [...c, i] as const))(
    "%s: a camera effect keeping the cursor's board point",
    (_n, camera, screen, deltaY, factor, i) => {
      const { calls, registry, state } = setup();
      const input = makeInput({ camera });
      const before = toBoard(camera, screen, input.viewport);
      const event: InteractionEvent = {
        type: "wheel",
        screen,
        board: before,
        deltaX: 17,
        deltaY,
        modifiers: i % 2 === 0 ? CTRL : META,
      };
      const out = reduce(state, event, input, registry);
      const next = cameraOf(out.effects);
      expect(out.effects).toHaveLength(1);
      expect(next).toEqual(zoomAt(camera, screen, 1.1 ** (-deltaY / 100), input.viewport));
      expect(next.zoom).toBeCloseTo(camera.zoom * factor, 12);
      closeTo(toBoard(next, screen, input.viewport), before);
      expect(calls).toEqual([]);
    },
  );

  test("the zoom is clamped by zoomAt", () => {
    const { registry, state } = setup();
    const input = makeInput({ camera: { x: 0, y: 0, zoom: 8 } });
    const out = reduce(
      state,
      {
        type: "wheel",
        screen: [0, 0],
        board: [0, 0],
        deltaX: 0,
        deltaY: -1000,
        modifiers: CTRL,
      },
      input,
      registry,
    );
    expect(cameraOf(out.effects).zoom).toBe(8);
  });

  test("the input camera is never mutated", () => {
    const { registry, state } = setup();
    const camera = Object.freeze({ x: 1, y: 2, zoom: 1 });
    const input = Object.freeze(makeInput({ camera }));
    reduce(
      state,
      { type: "wheel", screen: [5, 5], board: [0, 0], deltaX: 0, deltaY: 100, modifiers: CTRL },
      input,
      registry,
    );
    reduce(
      state,
      { type: "wheel", screen: [5, 5], board: [0, 0], deltaX: 3, deltaY: 100, modifiers: NO_MODS },
      input,
      registry,
    );
    expect(camera).toEqual({ x: 1, y: 2, zoom: 1 });
  });
});

describe("pan", () => {
  /** Drives a drag, applying each camera effect to the next input as the runtime does. */
  function drag(
    start: MachineState,
    registry: ToolRegistry,
    path: Point[],
    opts: { button: number },
    camera0: Camera,
  ) {
    let state = start;
    let camera = camera0;
    const viewport = { width: 800, height: 600 };
    const first = path[0] as Point;
    const grabbed = toBoard(camera, first, viewport);
    const effects: Effect[][] = [];
    path.forEach((screen, i) => {
      const type = i === 0 ? "pointer_down" : i === path.length - 1 ? "pointer_up" : "pointer_move";
      const out = reduce(
        state,
        pointer(type, screen, camera, { button: type === "pointer_move" ? -1 : opts.button }),
        makeInput({ camera }),
        registry,
      );
      state = out.state;
      effects.push(out.effects);
      for (const e of out.effects) if (e.type === "camera") camera = e.camera;
      // The board point grabbed at pointer down stays under the pointer.
      closeTo(toScreen(camera, grabbed, viewport), screen);
    });
    return { state, camera, effects };
  }

  const path: Point[] = [
    [100, 100],
    [130, 90],
    [200, 250],
    [210, 260],
  ];

  test.each([
    ["zoom 1", { x: 0, y: 0, zoom: 1 }],
    ["zoom 2.5, offset", { x: -4, y: 9, zoom: 2.5 }],
  ] as [string, Camera][])("middle-button drag pans, following the pointer (%s)", (_n, camera0) => {
    const { calls, registry, state } = setup();
    const { effects, state: after } = drag(state, registry, path, { button: 1 }, camera0);
    expect(effects[0]).toEqual([]);
    for (const step of effects.slice(1)) {
      expect(step).toHaveLength(1);
      expect(step[0]?.type).toBe("camera");
    }
    expect(calls).toEqual([]);
    expect(after.pan).toBeNull();
  });

  test("Space + left drag pans without reaching the tool; Space is consumed", () => {
    const { calls, registry, state: s0 } = setup();
    const input = makeInput();
    let state = reduce(s0, key("key_down", " ", "Space"), input, registry).state;
    expect(machineCursor(state, registry)).toBe("grab");
    const { state: s1 } = drag(state, registry, path, { button: 0 }, input.camera);
    state = reduce(s1, key("key_up", " ", "Space"), input, registry).state;
    expect(calls).toEqual([]);
    // Without Space, a left drag goes to the tool.
    const out = reduce(state, pointer("pointer_down", [5, 5], input.camera), input, registry);
    expect(out.effects).toEqual([]);
    expect(calls.map((c) => c.kind === "reduce" && c.event.type)).toEqual(["pointer_down"]);
  });

  test("Space-drag pans after a Space key_down from the window (focus outside the canvas, not in a text field)", () => {
    const { calls, registry, state: s0 } = setup();
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    const input = makeInput({ camera });
    // BoardCanvas forwards a window-level Space as an ordinary key_down outside text fields.
    let state = reduce(s0, key("key_down", " ", "Space"), input, registry).state;
    expect(state.space).toBe(true);
    state = reduce(state, pointer("pointer_down", [10, 10], camera), input, registry).state;
    const moved = reduce(state, pointer("pointer_move", [10, 42], camera), input, registry);
    expect(cameraOf(moved.effects)).toEqual({ x: 0, y: -0.5, zoom: 1 });
    expect(calls).toEqual([]);
  });

  test("releasing Space mid-drag keeps panning until the pointer is up", () => {
    const { calls, registry, state: s0 } = setup();
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    const input = makeInput({ camera });
    let state = reduce(s0, key("key_down", " ", "Space"), input, registry).state;
    state = reduce(state, pointer("pointer_down", [10, 10], camera), input, registry).state;
    expect(machineCursor(state, registry)).toBe("grabbing");
    state = reduce(state, key("key_up", " ", "Space"), input, registry).state;
    const moved = reduce(state, pointer("pointer_move", [20, 10], camera), input, registry);
    expect(cameraOf(moved.effects).x).toBeCloseTo(-10 / 64, 12);
    const up = reduce(moved.state, pointer("pointer_up", [20, 10], camera), input, registry);
    expect(up.state.pan).toBeNull();
    expect(calls).toEqual([]);
  });

  test("another pointer's events still reach the tool during a pan", () => {
    const { calls, registry, state: s0 } = setup();
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    const input = makeInput({ camera });
    const state = reduce(
      s0,
      pointer("pointer_down", [10, 10], camera, { button: 1, buttons: 4 }),
      input,
      registry,
    ).state;
    reduce(state, pointer("pointer_move", [30, 30], camera, { pointerId: 2 }), input, registry);
    expect(calls).toHaveLength(1);
  });

  test("pointer_cancel ends a pan", () => {
    const { registry, state: s0 } = setup();
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    const input = makeInput({ camera });
    const s1 = reduce(
      s0,
      pointer("pointer_down", [10, 10], camera, { button: 1 }),
      input,
      registry,
    );
    const s2 = reduce(s1.state, pointer("pointer_cancel", [10, 10], camera), input, registry);
    expect(s2.state.pan).toBeNull();
    expect(s2.effects).toEqual([]);
  });
});

describe("keys", () => {
  test("Escape calls the active tool's cancel and its effects are returned", () => {
    const { calls, registry, state } = setup();
    const out = reduce(state, key("key_down", "Escape", "Escape"), makeInput(), registry);
    expect(calls).toEqual([{ tool: "select", kind: "cancel", reason: "escape" }]);
    expect(out.effects).toEqual([{ type: "overlays", overlays: [] }]);
  });

  test.each([
    ["key_down", "a", "KeyA"],
    ["key_up", "a", "KeyA"],
    ["key_down", "Escape", "Escape"],
    ["key_down", " ", "Space"],
    ["key_down", "Delete", "Delete"],
  ] as const)("%s %s in a text field is dropped", (type, k, code) => {
    const { calls, registry, state } = setup();
    const out = reduce(state, key(type, k, code, true), makeInput(), registry);
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual(state);
    expect(calls).toEqual([]);
  });

  test("a key outside text fields reaches the active tool", () => {
    const { calls, registry, state } = setup();
    reduce(state, key("key_down", "Delete", "Delete"), makeInput(), registry);
    reduce(state, key("key_up", "Delete", "Delete"), makeInput(), registry);
    expect(calls.map((c) => c.kind === "reduce" && c.event.type)).toEqual(["key_down", "key_up"]);
  });

  test("a keyboard nudge's write carries the stamp captured at the key press", () => {
    const { registry, state: s0 } = setup((event, input) => {
      if (event.type !== "key_down" || event.key !== "ArrowRight") return [];
      const stamp = captureStamp(input);
      if (stamp === null) return [];
      return [
        {
          type: "write",
          stamp,
          ops: [
            {
              type: "set_value",
              object: "goblin",
              cell: "position",
              value: { type: "number", value: 1 },
            },
          ] as never,
          label: "Move goblin",
          continuations: [],
        },
      ];
    });
    const first = reduce(
      s0,
      key("key_down", "ArrowRight", "ArrowRight"),
      makeInput({ revision: 7 }),
      registry,
    );
    const second = reduce(
      first.state,
      key("key_down", "ArrowRight", "ArrowRight"),
      makeInput({ revision: 8, viewer: GM }),
      registry,
    );
    const [w1] = first.effects;
    const [w2] = second.effects;
    if (w1?.type !== "write" || w2?.type !== "write") throw new Error("expected writes");
    expect(w1.stamp).toEqual({
      interactionId: w1.stamp.interactionId,
      board: "main",
      viewer: GM,
      baseRevision: 7,
    });
    expect(w2.stamp.baseRevision).toBe(8);
    expect(w1.stamp.interactionId).not.toBe(w2.stamp.interactionId);
  });
});

describe("other events reach the active tool", () => {
  const camera: Camera = { x: 0, y: 0, zoom: 1 };
  const events: InteractionEvent[] = [
    pointer("pointer_down", [1, 2], camera),
    pointer("pointer_move", [3, 4], camera, { buttons: 0 }),
    pointer("pointer_up", [3, 4], camera),
    pointer("pointer_cancel", [3, 4], camera),
    pointer("pointer_down", [1, 2], camera, { button: 2, buttons: 2 }),
    { type: "double_click", screen: [1, 1], board: [0, 0], modifiers: NO_MODS },
    { type: "file_drop", files: [], screen: [1, 1], board: [0, 0] },
    {
      type: "data_drop",
      mime: "application/x-vtt-cell",
      data: "{}",
      screen: [1, 1],
      board: [0, 0],
    },
  ];

  test.each(events.map((e) => [e.type, e] as const))("%s", (_t, event) => {
    const respond = (): Effect[] => [{ type: "hover", id: null, zone: null }];
    const { calls, registry, state } = setup(respond);
    const input = makeInput();
    const out = reduce(state, event, input, registry);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.kind !== "reduce") throw new Error("expected reduce");
    expect(call.tool).toBe("select");
    expect(call.event).toBe(event);
    expect(call.input).toMatchObject(input);
    expect(typeof call.input.interactionId).toBe("string");
    expect(out.effects).toEqual([{ type: "hover", id: null, zone: null }]);
    expect(out.state.tools.select?.phase).toBe(1);
  });

  test("each delivered event gets a fresh interaction id", () => {
    const { calls, registry, state } = setup();
    const a = reduce(state, pointer("pointer_down", [1, 1], camera), makeInput(), registry);
    reduce(a.state, pointer("pointer_up", [1, 1], camera), makeInput(), registry);
    const ids = calls.map((c) => (c.kind === "reduce" ? c.input.interactionId : null));
    expect(new Set(ids).size).toBe(2);
  });
});

describe("tool switches", () => {
  test("setTool cancels the active tool first, then activates the new one", () => {
    const { calls, registry, state } = setup();
    const out = setTool(state, { tool: "zone-rect", options: { fog: true } }, registry);
    expect(calls).toEqual([{ tool: "select", kind: "cancel", reason: "tool_switch" }]);
    expect(out.effects).toEqual([{ type: "overlays", overlays: [] }]);
    expect(out.state.tool).toBe("zone-rect");
    expect(out.state.tools["zone-rect"]).toEqual({
      tool: "zone-rect",
      options: { fog: true },
      phase: 0,
    });
    expect(machineCursor(out.state, registry)).toBe("zone-rect-0");
  });

  test("without options the tool's defaults are used", () => {
    const { registry, state } = setup();
    const out = setTool(state, { tool: "zone-rect" }, registry);
    expect(out.state.tools["zone-rect"]?.options).toEqual({ fog: false });
  });

  test("switching back keeps the tool's state (so a pending result can still reach it)", () => {
    const { registry, state: s0 } = setup();
    const s1 = setTool(s0, { tool: "image" }, registry).state;
    const s2 = reduce(
      s1,
      pointer("pointer_down", [0, 0], { x: 0, y: 0, zoom: 1 }),
      makeInput(),
      registry,
    ).state;
    const s3 = setTool(s2, { tool: "select" }, registry).state;
    expect(s3.tools.image).toEqual({ tool: "image", options: {}, phase: 0 });
    const s4 = setTool(s3, { tool: "image" }, registry).state;
    expect(s4.tools.image).toBe(s3.tools.image);
  });

  test("selecting the active tool again only replaces its options", () => {
    const { calls, registry, state: s0 } = setup();
    const s1 = setTool(s0, { tool: "zone-rect" }, registry);
    calls.length = 0;
    const s2 = setTool(s1.state, { tool: "zone-rect", options: { fog: true } }, registry);
    expect(calls).toEqual([]);
    expect(s2.effects).toEqual([]);
    expect(s2.state.tools["zone-rect"]?.options).toEqual({ fog: true });
  });

  test("an unregistered tool throws", () => {
    const { registry, state } = setup();
    expect(() => setTool(state, { tool: "ink" }, registry)).toThrow(/ink/);
    expect(() => initMachine(registry, { tool: "text", board: null, viewer: GM })).toThrow(/text/);
  });
});

describe("board and viewer changes", () => {
  test("a board change cancels the active tool before the event", () => {
    const { calls, registry, state } = setup(() => [{ type: "hover", id: null, zone: null }]);
    const out = reduce(
      state,
      pointer("pointer_move", [0, 0], { x: 0, y: 0, zoom: 1 }),
      makeInput({ activeBoard: "cellar" }),
      registry,
    );
    expect(calls.map((c) => (c.kind === "cancel" ? c.reason : c.event.type))).toEqual([
      "board_change",
      "pointer_move",
    ]);
    expect(out.effects).toEqual([
      { type: "overlays", overlays: [] },
      { type: "hover", id: null, zone: null },
    ]);
    expect(out.state.board).toBe("cellar");
  });

  test("syncInput cancels on a viewer change, once", () => {
    const { calls, registry, state } = setup();
    const a = syncInput(state, makeInput({ viewer: ALDRIC }), registry);
    expect(calls).toEqual([{ tool: "select", kind: "cancel", reason: "viewer_change" }]);
    const b = syncInput(
      a.state,
      makeInput({ viewer: { type: "character", id: "aldric" } }),
      registry,
    );
    expect(b.effects).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("syncInput with nothing changed does nothing", () => {
    const { calls, registry, state } = setup();
    const out = syncInput(state, makeInput(), registry);
    expect(out).toEqual({ state, effects: [] });
    expect(calls).toEqual([]);
  });

  test("a board change ends a pan", () => {
    const { registry, state: s0 } = setup();
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    const s1 = reduce(
      s0,
      pointer("pointer_down", [1, 1], camera, { button: 1 }),
      makeInput(),
      registry,
    );
    const s2 = syncInput(s1.state, makeInput({ activeBoard: null }), registry);
    expect(s2.state.pan).toBeNull();
  });
});

describe("settled results go to the tool that started the interaction", () => {
  test("an upload started by the image tool settles there after a switch to select", () => {
    const {
      calls,
      registry,
      state: s0,
    } = setup((event, input) => {
      if (event.type !== "file_drop") return [];
      const stamp = captureStamp(input);
      return stamp ? [{ type: "upload", stamp, file: {} as File }] : [];
    });
    const s1 = setTool(s0, { tool: "image" }, registry).state;
    const dropped = reduce(
      s1,
      { type: "file_drop", files: [], screen: [0, 0], board: [0, 0] },
      makeInput(),
      registry,
    );
    const [upload] = dropped.effects;
    if (upload?.type !== "upload") throw new Error("expected upload");
    const s2 = setTool(dropped.state, { tool: "select" }, registry).state;
    calls.length = 0;
    const settled: InteractionEvent = {
      type: "settled",
      interactionId: upload.stamp.interactionId,
      outcome: { type: "uploaded", path: "assets/map.png", width: 100, height: 50 },
    };
    const out = reduce(s2, settled, makeInput({ activeBoard: "main" }), registry);
    expect(calls.map((c) => [c.tool, c.kind])).toEqual([["image", "reduce"]]);
    expect(out.state.tool).toBe("select");
    expect(out.state.tools.image?.phase).toBe((s2.tools.image?.phase as number) + 1);
    // Settled once, the entry is gone: a repeat is dropped.
    calls.length = 0;
    const again = reduce(out.state, settled, makeInput(), registry);
    expect(calls).toEqual([]);
    expect(again.effects).toEqual([]);
  });

  test("write, pick_file and stamped extension effects are routed; a re-issued stamp routes again", () => {
    const {
      calls,
      registry,
      state: s0,
    } = setup((event, input) => {
      if (event.type === "key_down") {
        const stamp = captureStamp(input);
        if (!stamp) return [];
        return [
          { type: "write", stamp, ops: [], label: "x", continuations: [] },
          {
            type: "pick_file",
            stamp: { ...stamp, interactionId: `${stamp.interactionId}-p` },
            accept: "image/png",
          },
          {
            type: "extension",
            name: "invoke",
            stamp: { ...stamp, interactionId: `${stamp.interactionId}-x` },
            payload: 1,
          },
          { type: "extension", name: "nostamp", payload: 2 },
        ];
      }
      if (event.type === "settled" && event.outcome.type === "file_picked") {
        return [
          {
            type: "upload",
            stamp: {
              interactionId: event.interactionId,
              board: "main",
              viewer: GM,
              baseRevision: 5,
            },
            file: {} as File,
          },
        ];
      }
      return [];
    });
    const out = reduce(s0, key("key_down", "x", "KeyX"), makeInput(), registry);
    const ids = Object.keys(out.state.pending).sort();
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(out.state.pending[id]).toEqual({ tool: "select", outstanding: 1 });
    const pickId = ids.find((i) => i.endsWith("-p")) as string;
    const picked = reduce(
      out.state,
      { type: "settled", interactionId: pickId, outcome: { type: "file_picked", file: null } },
      makeInput(),
      registry,
    );
    expect(picked.state.pending[pickId]).toEqual({ tool: "select", outstanding: 1 });
    expect(
      calls.filter((c) => c.kind === "reduce").map((c) => c.kind === "reduce" && c.event.type),
    ).toEqual(["key_down", "settled"]);
  });
});

describe("several effects sharing one stamp", () => {
  test("every result settles back to the tool, then the entry goes", () => {
    const {
      calls,
      registry,
      state: s0,
    } = setup((event, input) => {
      if (event.type !== "key_down") return [];
      const stamp = captureStamp(input);
      if (!stamp) return [];
      return [
        { type: "extension", name: "a", stamp, payload: 1 },
        { type: "extension", name: "b", stamp, payload: 2 },
      ];
    });
    const started = reduce(s0, key("key_down", "x", "KeyX"), makeInput(), registry);
    const [first] = started.effects;
    if (first?.type !== "extension" || first.stamp === undefined)
      throw new Error("expected extension");
    const id = first.stamp.interactionId;
    expect(started.state.pending[id]).toEqual({ tool: "select", outstanding: 2 });
    // Switch away: the cancel keeps the entry, so both results still arrive.
    const switched = setTool(started.state, { tool: "token" }, registry).state;
    expect(switched.pending[id]).toEqual({ tool: "select", outstanding: 2 });
    const settle = (name: string): InteractionEvent => ({
      type: "settled",
      interactionId: id,
      outcome: { type: "extension", name, result: name },
    });
    calls.length = 0;
    const a = reduce(switched, settle("a"), makeInput(), registry);
    expect(a.state.pending[id]).toEqual({ tool: "select", outstanding: 1 });
    const b = reduce(a.state, settle("b"), makeInput(), registry);
    expect(b.state.pending[id]).toBeUndefined();
    expect(
      calls.map(
        (c) => c.kind === "reduce" && c.event.type === "settled" && [c.tool, c.event.outcome],
      ),
    ).toEqual([
      ["select", { type: "extension", name: "a", result: "a" }],
      ["select", { type: "extension", name: "b", result: "b" }],
    ]);
    // A third result for the finished interaction is dropped.
    calls.length = 0;
    reduce(b.state, settle("c"), makeInput(), registry);
    expect(calls).toEqual([]);
  });
});

describe("registry", () => {
  test("register, get, list; a duplicate id throws", () => {
    const calls: Call[] = [];
    const registry = new ToolRegistry();
    const select = stubTool("select", calls);
    registry.register(select);
    registry.register(stubTool("token", calls));
    expect(registry.get("select")).toBe(select);
    expect(registry.get("note")).toBeUndefined();
    expect(registry.list().map((t) => t.id)).toEqual(["select", "token"]);
    expect(() => registry.register(stubTool("select", calls))).toThrow(/select/);
    expect(registry.get("select")).toBe(select);
  });
});

describe("initMachine", () => {
  test("starts the given tool with its default options", () => {
    const { registry } = setup();
    const state = initMachine(registry, { tool: "zone-rect", board: "main", viewer: GM });
    expect(state.tool).toBe("zone-rect");
    expect(state.tools["zone-rect"]).toEqual({
      tool: "zone-rect",
      options: { fog: false },
      phase: 0,
    });
    expect(state.board).toBe("main");
    expect(state.viewer).toEqual(GM);
    expect(state.space).toBe(false);
    expect(state.pan).toBeNull();
    expect(state.pending).toEqual({});
  });
});
