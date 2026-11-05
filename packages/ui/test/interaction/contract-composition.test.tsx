/**
 * The contract-composition test (vtt-3l6.23; M4 plan review r2 finding 3,
 * r3 findings 1 and 2; M5 plan Q1 A2, review r1 finding 10): the real
 * session over an in-process authority, the real `UiStore`, `RuntimeInputs`,
 * tool context and write port, this runtime and `useInteraction`, and
 * `BoardCanvas` with the Canvas2D renderer over a recording context, wired
 * without casts or adapters. The tool is a real one defined here: it
 * hit-tests the scene, reads the hit object's view through `input.views`
 * and writes a `move` on pointer up.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ObjectView, WireOp, WireResult } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import {
  BoardCanvas,
  buildScene,
  type Continuation,
  captureStamp,
  createCanvas2DRenderer,
  createInteractionRuntime,
  createRuntimeInputs,
  createToolContext,
  createUiStore,
  type DataDropHandler,
  type EditorOpenRequest,
  type EditorPort,
  type Effect,
  hitTest,
  ImageCache,
  type InteractionEvent,
  type InteractionRuntime,
  type InteractionStamp,
  RecordingContext,
  type RuntimeExtensions,
  type RuntimeInputs,
  type Scene,
  type SettledOutcome,
  sessionNotices,
  TableProvider,
  type Tool,
  type ToolId,
  ToolRegistry,
  type ToolState,
  type UiStore,
  useInteraction,
  useSession,
  useTableSession,
  useUi,
  useUiStore,
} from "@vtt/ui";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const BOARD = "gm_board";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    x: 0,
    y: 0,
    right: RECT.width,
    bottom: RECT.height,
    toJSON: () => ({}),
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await cleanupAuthorities();
});

// ---------------------------------------------------------------------------
// The view-reading tool

function pointOf(value: WireResult | undefined): Point | null {
  if (value?.type !== "list") return null;
  const [x, y] = value.items;
  if (x?.type !== "number" || y?.type !== "number") return null;
  return [x.value, y.value];
}

function nameOf(view: ObjectView): string {
  const name = view.cells.name?.value;
  return name?.type === "text" ? name.value : view.id;
}

interface MoverPhase {
  drag: { id: ObjectId; name: string; stamp: InteractionStamp; grab: Point; origin: Point } | null;
}

interface ToolLog {
  views: ObjectView[];
  events: { tool: ToolId; event: InteractionEvent }[];
  settled: { tool: ToolId; outcome: SettledOutcome }[];
}

/**
 * The composition test's tool. Pointer down hit-tests `input.scene` and
 * reads the hit object's `ObjectView` through `input.views`; pointer up
 * writes a `move` of it to `stamp.board` (held previews while it lands,
 * then selects it). Keys stand in for other gestures: `x` a stamped
 * extension, `u` an unknown extension, `e` an editor with a rect, `c` a
 * creation with an extension continuation.
 */
function moverTool(id: ToolId, log: ToolLog): Tool<MoverPhase> {
  const at = (drag: NonNullable<MoverPhase["drag"]>, board: Point): Point => [
    drag.origin[0] + board[0] - drag.grab[0],
    drag.origin[1] + board[1] - drag.grab[1],
  ];
  return {
    id,
    init: (options) => ({ tool: id, options, phase: { drag: null } }) as ToolState<MoverPhase>,
    cursor: (state) => (state.phase.drag === null ? "default" : "grabbing"),
    reduce(state, event, input) {
      log.events.push({ tool: id, event });
      const keep = { state, effects: [] as Effect[] };
      switch (event.type) {
        case "pointer_down": {
          const hit = hitTest(input.scene, event.board, input.camera);
          const view = hit === null ? null : input.views(hit);
          const stamp = captureStamp(input);
          const origin = view === null ? null : pointOf(view.cells.position?.value);
          if (view === null || stamp === null || origin === null) return keep;
          log.views.push(view);
          return {
            state: {
              ...state,
              phase: {
                drag: { id: view.id, name: nameOf(view), stamp, grab: event.board, origin },
              },
            },
            effects: [],
          };
        }
        case "pointer_move": {
          const drag = state.phase.drag;
          if (drag === null) return keep;
          return {
            state,
            effects: [
              {
                type: "previews",
                previews: new Map([[drag.id, { position: at(drag, event.board) }]]),
              },
            ],
          };
        }
        case "pointer_up": {
          const drag = state.phase.drag;
          if (drag === null) return keep;
          const position = at(drag, event.board);
          return {
            state: { ...state, phase: { drag: null } },
            effects: [
              {
                type: "write",
                stamp: drag.stamp,
                ops: [
                  {
                    type: "move",
                    object: drag.id,
                    to: { type: "board", board: drag.stamp.board, position },
                  },
                ],
                label: `Move ${drag.name}`,
                continuations: [{ type: "select", ids: [drag.id] }],
              },
              {
                type: "previews",
                previews: new Map([[drag.id, { position }]]),
                hold: { stamp: drag.stamp },
              },
            ],
          };
        }
        case "key_down": {
          const stamp = captureStamp(input);
          if (stamp === null) return keep;
          switch (event.key) {
            case "x":
              return {
                state,
                effects: [{ type: "extension", name: "ping", stamp, payload: { n: 1 } }],
              };
            case "u":
              return {
                state,
                effects: [{ type: "extension", name: "nope", stamp, payload: null }],
              };
            case "e":
              return {
                state,
                effects: [
                  {
                    type: "open_editor",
                    stamp,
                    object: "tok",
                    cell: "name",
                    rect: { minX: 0.5, minY: 0.5, maxX: 1.5, maxY: 1 },
                  },
                ],
              };
            case "c": {
              const continuations: Continuation[] = [
                { type: "select_created", opIndex: 0 },
                { type: "extension", name: "after_create", opIndex: 0, payload: { why: "edit" } },
              ];
              return {
                state,
                effects: [
                  {
                    type: "write",
                    stamp,
                    ops: [
                      {
                        type: "create_object",
                        id_base: "note",
                        to: { type: "board", board: stamp.board, position: [4, 4] },
                      },
                    ],
                    label: "Create note",
                    continuations,
                  },
                ],
              };
            }
            default:
              return keep;
          }
        }
        case "settled":
          log.settled.push({ tool: id, outcome: event.outcome });
          return keep;
        default:
          return keep;
      }
    },
    cancel: (state) => ({
      state: { ...state, phase: { drag: null } },
      effects: state.phase.drag === null ? [] : [{ type: "previews", previews: new Map() }],
    }),
  };
}

// ---------------------------------------------------------------------------
// The board component, composed as vtt-3l6.17 will

function Board({ runtime, ctx }: { runtime: InteractionRuntime; ctx: RecordingContext }) {
  const { overlays, previews, handlers } = useInteraction({ runtime });
  const viewVersion = useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  const selection = useUi((s) => s.selection);
  const camera = useUi((s) => s.camera);
  const session = useTableSession();
  const ui = useUiStore();
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion keys the live board view
  const scene: Scene = useMemo(() => {
    const view = session.boardView();
    if (view === null) return { items: [], covers: [], objectOverlays: [], skipped: [] };
    return buildScene({
      views: view.objects.values(),
      covers: [...view.covers.values()],
      board: view.board,
      viewer,
      selection,
      previews,
    });
  }, [session, viewVersion, viewer, selection, previews]);
  return (
    <BoardCanvas
      scene={scene}
      toolOverlays={overlays}
      camera={camera}
      setViewport={ui.setViewport}
      createRenderer={() =>
        createCanvas2DRenderer(ctx, { images: new ImageCache({ resolve: (p) => p }) })
      }
      {...handlers}
    />
  );
}

// ---------------------------------------------------------------------------
// Setup

const tokenOp = (id: string, position: Point): WireOp => ({
  type: "create_object",
  id,
  to: { type: "board", board: BOARD, position },
  init: {
    shape: { type: "circle", radius: 0.5 },
    cells: { name: { type: "text", value: "Goblin" } },
  },
});

interface ComposeOptions {
  extensions?: RuntimeExtensions;
  dataDropHandlers?: DataDropHandler[];
}

async function compose(options: ComposeOptions = {}) {
  const authority = await startAuthority();
  const gm = await authority.client("gm");
  await gm.transact([tokenOp("tok", [1, 1])]);
  const session = authority.session();
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("tok") === true, "the token's view");

  const ui = createUiStore({ session });
  const inputs: RuntimeInputs = createRuntimeInputs(session, ui);
  const toolContext = createToolContext(session, ui, {
    pickFile: async () => null,
    upload: async () => ({ path: "t.assets/x.png", width: 1, height: 1 }),
  });
  const opened: EditorOpenRequest[] = [];
  const editor: EditorPort = { open: (request) => opened.push(request), close: () => undefined };
  const log: ToolLog = { views: [], events: [], settled: [] };
  const registry = new ToolRegistry();
  registry.register(moverTool("select", log));
  registry.register(moverTool("token", log));
  const runtime = createInteractionRuntime({
    registry,
    inputs,
    toolContext,
    ui,
    editor,
    whenRevision: (r) => session.whenRevision(r),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    ...(options.dataDropHandlers === undefined
      ? {}
      : { dataDropHandlers: options.dataDropHandlers }),
  });

  const ctx = new RecordingContext();
  const utils = render(
    <TableProvider session={session} ui={ui}>
      <Board runtime={runtime} ctx={ctx} />
    </TableProvider>,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  const notices = () => sessionNotices(session).list();
  const position = (id: ObjectId) => pointOf(session.objectView(id)?.cells.position?.value);
  return {
    authority,
    gm,
    session,
    ui,
    inputs,
    runtime,
    log,
    opened,
    canvas,
    ctx,
    notices,
    position,
  };
}

/** Screen point of a board point under the default camera and the 800 × 600 canvas. */
const screenOf = (board: Point): Point => [400 + board[0] * 64, 300 + board[1] * 64];

function dragOn(canvas: HTMLCanvasElement, from: Point, to: Point): void {
  const [fx, fy] = screenOf(from);
  const [tx, ty] = screenOf(to);
  act(() => {
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      clientX: fx,
      clientY: fy,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: tx, clientY: ty, buttons: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: tx, clientY: ty, button: 0, buttons: 0 });
  });
}

function pressKey(canvas: HTMLCanvasElement, key: string): void {
  act(() => {
    fireEvent.keyDown(canvas, { key, code: `Key${key.toUpperCase()}` });
  });
}

function dropData(canvas: HTMLCanvasElement, mime: string, data: string, at: Point): void {
  const [x, y] = screenOf(at);
  const make = (type: string) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(ev, "dataTransfer", {
      value: { types: [mime], files: [], getData: (t: string) => (t === mime ? data : "") },
    });
    return ev;
  };
  act(() => {
    canvas.dispatchEvent(make("dragover"));
    canvas.dispatchEvent(make("drop"));
  });
}

// ---------------------------------------------------------------------------

describe("contract composition", () => {
  test("a drag over a token on a real board view commits the move", async () => {
    const c = await compose();
    const before = c.session.getSnapshot().revision;
    dragOn(c.canvas, [1, 1], [3, 2]);
    // The tool read the token's view through input.views.
    expect(c.log.views.map((v) => v.id)).toEqual(["tok"]);
    expect(nameOf(c.log.views[0] as ObjectView)).toBe("Goblin");
    // The held preview shows the landing point until the commit is visible.
    expect(c.runtime.getView().previews.get("tok")).toEqual({ position: [3, 2] });
    await until(() => c.position("tok")?.[0] === 3, "the move to land");
    expect(c.position("tok")).toEqual([3, 2]);
    expect(c.session.getSnapshot().revision).toBe(before + 1);
    await until(() => c.runtime.getView().previews.size === 0, "the preview to clear");
    await until(() => c.ui.getState().selection.includes("tok"), "the continuation");
    // The recording renderer drew the frame.
    expect(c.ctx.paints.length).toBeGreaterThan(0);
    expect(c.log.settled).toEqual([
      {
        tool: "select",
        outcome: { type: "write", result: expect.objectContaining({ status: "committed" }) },
      },
    ]);
  });

  test("a wheel event changes the stored camera", async () => {
    const c = await compose();
    act(() => {
      fireEvent.wheel(c.canvas, { clientX: 400, clientY: 300, deltaY: -100 });
    });
    expect(c.ui.getState().camera.zoom).toBeCloseTo(1.1, 9);
  });

  test("a tool switch during a pending stale write runs no continuation and shows the stale notice", async () => {
    const c = await compose();
    const [fx, fy] = screenOf([1, 1]);
    const [tx, ty] = screenOf([3, 1]);
    act(() => {
      fireEvent.pointerDown(c.canvas, {
        pointerId: 1,
        clientX: fx,
        clientY: fy,
        button: 0,
        buttons: 1,
      });
    });
    // Another client moves the token after the drag began.
    const other = await c.authority.client("other");
    await other.transact(
      [{ type: "move", object: "tok", to: { type: "board", board: BOARD, position: [-5, -5] } }],
      { label: "Shove" },
    );
    await until(() => c.position("tok")?.[0] === -5, "the other client's move");
    act(() => {
      fireEvent.pointerUp(c.canvas, {
        pointerId: 1,
        clientX: tx,
        clientY: ty,
        button: 0,
        buttons: 0,
      });
      c.ui.setTool("token");
    });
    await until(() => c.log.settled.length === 1, "the write to settle");
    expect(c.log.settled[0]?.outcome).toMatchObject({
      type: "write",
      result: { status: "rejected" },
    });
    expect(c.notices().some((n) => n.kind === "stale")).toBe(true);
    expect(c.ui.getState().selection).toEqual([]);
    expect(c.ui.getState().tool.id).toBe("token");
    expect(c.runtime.getView().previews.size).toBe(0);
    expect(c.position("tok")).toEqual([-5, -5]);
  });

  test("an extension effect with a registered handler settles back to its tool with the handler's result", async () => {
    const seen: { payload: unknown; board: string | null }[] = [];
    const c = await compose({
      extensions: {
        effects: {
          ping: async (effect, ext) => {
            seen.push({ payload: effect.payload, board: ext.toolContext.activeBoard() });
            return { pong: effect.payload };
          },
        },
      },
    });
    pressKey(c.canvas, "x");
    await until(() => c.log.settled.length === 1, "the extension to settle");
    expect(seen).toEqual([{ payload: { n: 1 }, board: BOARD }]);
    expect(c.log.settled).toEqual([
      { tool: "select", outcome: { type: "extension", name: "ping", result: { pong: { n: 1 } } } },
    ]);
    expect(c.runtime.machine().pending).toEqual({});
  });

  test("an unknown extension name pushes one warning notice and nothing else", async () => {
    const c = await compose({ extensions: { effects: {} } });
    const before = c.session.getSnapshot().revision;
    pressKey(c.canvas, "u");
    await new Promise((r) => setTimeout(r, 20));
    expect(c.notices().filter((n) => n.level === "warning")).toHaveLength(1);
    expect(c.notices()).toHaveLength(1);
    expect(c.log.settled).toEqual([]);
    expect(c.session.getSnapshot().revision).toBe(before);
  });

  test("an extension continuation runs after select_created with the created id", async () => {
    const calls: { id: ObjectId | null; payload: unknown; selection: readonly ObjectId[] }[] = [];
    let ui: UiStore | null = null;
    const c = await compose({
      extensions: {
        continuations: {
          after_create: (id, payload) =>
            calls.push({ id, payload, selection: ui?.getState().selection ?? [] }),
        },
      },
    });
    ui = c.ui;
    pressKey(c.canvas, "c");
    await until(() => calls.length === 1, "the extension continuation");
    const id = calls[0]?.id ?? null;
    expect(id).toMatch(/^note/);
    expect(calls[0]?.payload).toEqual({ why: "edit" });
    // select_created ran first.
    expect(calls[0]?.selection).toEqual([id]);
    expect(c.session.objectView(id ?? "")).not.toBeNull();
  });

  test("open_editor passes rect to EditorPort.open", async () => {
    const c = await compose();
    pressKey(c.canvas, "e");
    expect(c.opened).toEqual([
      {
        stamp: expect.objectContaining({ board: BOARD, viewer: { type: "gm" } }),
        object: "tok",
        cell: "name",
        rect: { minX: 0.5, minY: 0.5, maxX: 1.5, maxY: 1 },
      },
    ]);
  });

  describe("data drops", () => {
    const CELL_MIME = "application/x-vtt-cell";

    function handlers(calls: string[]): DataDropHandler[] {
      const declines: DataDropHandler = (event) => {
        calls.push(`first:${event.mime}`);
        return null;
      };
      const cellDrop: DataDropHandler = (event, input) => {
        calls.push(`second:${event.mime}`);
        if (event.mime !== CELL_MIME || input.activeBoard === null) return null;
        const { object, cell } = JSON.parse(event.data) as { object: ObjectId; cell: string };
        const stamp: InteractionStamp = {
          interactionId: "drop",
          board: input.activeBoard,
          viewer: input.viewer,
          baseRevision: input.revision,
        };
        return [
          {
            type: "write",
            stamp,
            ops: [{ type: "set_value", object, cell, value: { type: "number", value: 7 } }],
            label: `Drop ${cell}`,
            continuations: [{ type: "select", ids: [object] }],
          },
        ];
      };
      return [declines, cellDrop];
    }

    const dataDropsReaching = (log: ToolLog) =>
      log.events.filter((e) => e.event.type === "data_drop").map((e) => e.tool);

    test("a drop a handler accepts executes its effects and does not reach the active tool", async () => {
      const calls: string[] = [];
      const c = await compose({ dataDropHandlers: handlers(calls) });
      dropData(c.canvas, CELL_MIME, JSON.stringify({ object: "tok", cell: "hp" }), [1, 1]);
      expect(calls).toEqual([`first:${CELL_MIME}`, `second:${CELL_MIME}`]);
      await until(() => c.session.objectView("tok")?.cells.hp !== undefined, "the dropped write");
      expect(c.session.objectView("tok")?.cells.hp?.value).toEqual({ type: "number", value: 7 });
      await until(() => c.ui.getState().selection.includes("tok"), "the drop's continuation");
      expect(dataDropsReaching(c.log)).toEqual([]);
      expect(c.log.settled).toEqual([]);
    });

    test.each<ToolId>(["select", "token"])(
      "a drop every handler declines reaches the active tool (%s)",
      async (tool) => {
        const calls: string[] = [];
        const c = await compose({ dataDropHandlers: handlers(calls) });
        act(() => c.ui.setTool(tool));
        const before = c.session.getSnapshot().revision;
        dropData(c.canvas, "application/x-vtt-entry", "{}", [1, 1]);
        expect(calls).toEqual(["first:application/x-vtt-entry", "second:application/x-vtt-entry"]);
        expect(dataDropsReaching(c.log)).toEqual([tool]);
        expect(c.session.getSnapshot().revision).toBe(before);
      },
    );

    test("a handled drop does not reach a second registered tool either", async () => {
      const calls: string[] = [];
      const c = await compose({ dataDropHandlers: handlers(calls) });
      act(() => c.ui.setTool("token"));
      dropData(c.canvas, CELL_MIME, JSON.stringify({ object: "tok", cell: "hp" }), [1, 1]);
      await until(() => c.session.objectView("tok")?.cells.hp !== undefined, "the dropped write");
      expect(dataDropsReaching(c.log)).toEqual([]);
    });
  });
});
