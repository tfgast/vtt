/**
 * The handles against a real in-process authority (vtt-3l6.9; review r1
 * finding 6): the real session, `UiStore`, runtime inputs, tool context and
 * write port (vtt-3l6.21), the interaction runtime and `useInteraction`
 * (vtt-3l6.23), and `BoardCanvas` with the Canvas2D renderer over a
 * recording context, with `withHandles(selectTool)` registered as `select`.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { WireOp, WireResult } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import {
  BoardCanvas,
  buildScene,
  createCanvas2DRenderer,
  createInteractionRuntime,
  createRuntimeInputs,
  createToolContext,
  createUiStore,
  type EditorPort,
  ImageCache,
  type InteractionRuntime,
  RecordingContext,
  type Scene,
  selectTool,
  TableProvider,
  ToolRegistry,
  useInteraction,
  useSession,
  useTableSession,
  useUi,
  useUiStore,
  withHandles,
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

const create = (
  id: string,
  position: Point,
  init: Extract<WireOp, { type: "create_object" }>["init"],
): WireOp => ({ type: "create_object", id, to: { type: "board", board: BOARD, position }, init });

const SETUP: WireOp[] = [
  // A room zone under an imported map image (the map lands above the zone).
  create("room", [10, 0], {
    is_zone: true,
    shape: { type: "rect", width: 6, height: 6 },
    cells: { name: { type: "text", value: "Room" } },
  }),
  create("map", [10, 0], {
    shape: { type: "rect", width: 4, height: 4 },
    cells: {
      name: { type: "text", value: "Map" },
      image: { type: "text", value: "t.assets/map-00000000.png" },
    },
  }),
  // A coin inside the room near its south-east corner, outside the map.
  create("coin", [12.5, 2.5], {
    shape: { type: "circle", radius: 0.25 },
    cells: { name: { type: "text", value: "Coin" } },
  }),
];

async function compose() {
  const authority = await startAuthority();
  const gm = await authority.client("gm");
  await gm.transact(SETUP);
  const session = authority.session();
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("coin") === true, "the views");

  const ui = createUiStore({ session });
  const inputs = createRuntimeInputs(session, ui);
  const toolContext = createToolContext(session, ui, {
    pickFile: async () => null,
    upload: async () => ({ path: "t.assets/x.png", width: 1, height: 1 }),
  });
  const editor: EditorPort = { open: () => undefined, close: () => undefined };
  const registry = new ToolRegistry();
  registry.register(withHandles(selectTool));
  const runtime = createInteractionRuntime({
    registry,
    inputs,
    toolContext,
    ui,
    editor,
    whenRevision: (r) => session.whenRevision(r),
  });

  const ctx = new RecordingContext();
  const utils = render(
    <TableProvider session={session} ui={ui}>
      <Board runtime={runtime} ctx={ctx} />
    </TableProvider>,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  const cell = (id: ObjectId, name: string): WireResult | undefined =>
    session.objectView(id)?.cells[name]?.value;
  const roomContents = async (): Promise<ObjectId[]> => {
    const result = await gm.request("zones", { board: BOARD, viewer: { type: "gm" } });
    return result.zones.find((z) => z.id === "room")?.contents ?? [];
  };
  return { gm, session, ui, runtime, canvas, cell, roomContents };
}

/** Screen point of a board point under the default camera and the 800 × 600 canvas. */
const screenOf = (board: Point): Point => [400 + board[0] * 64, 300 + board[1] * 64];

interface Mods {
  altKey?: boolean;
}

function down(canvas: HTMLCanvasElement, at: Point, mods: Mods = {}) {
  const [x, y] = screenOf(at);
  act(() => {
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      ...mods,
    });
  });
}

function move(canvas: HTMLCanvasElement, at: Point, mods: Mods = {}) {
  const [x, y] = screenOf(at);
  act(() => {
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x, clientY: y, buttons: 1, ...mods });
  });
}

function up(canvas: HTMLCanvasElement, at: Point, mods: Mods = {}) {
  const [x, y] = screenOf(at);
  act(() => {
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0,
      ...mods,
    });
  });
}

function click(canvas: HTMLCanvasElement, at: Point, mods: Mods = {}) {
  down(canvas, at, mods);
  up(canvas, at, mods);
}

describe("handles integration", () => {
  test("a room zone under a map image is selected with Alt+click and resized with a corner handle", async () => {
    const c = await compose();
    expect(await c.roomContents()).toEqual(expect.arrayContaining(["map", "coin"]));

    // Alt+click cycles from the map to the room under it.
    click(c.canvas, [10, 0]);
    expect(c.ui.getState().selection).toEqual(["map"]);
    click(c.canvas, [10, 0], { altKey: true });
    click(c.canvas, [10, 0], { altKey: true });
    expect(c.ui.getState().selection).toEqual(["room"]);

    // The room's handles show once the pointer moves.
    move(c.canvas, [20, 20]);
    const handles = c.runtime.getView().overlays.find((o) => o.kind === "handles");
    expect(handles?.kind === "handles" ? handles.object : null).toBe("room");

    // Drag the south-east corner (13, 3) to (11, 1): the north-west corner (7, -3) stays.
    down(c.canvas, [13, 3]);
    move(c.canvas, [12, 2]);
    move(c.canvas, [11, 1]);
    expect(c.runtime.getView().previews.get("room")).toEqual({
      shape: { type: "rect", width: 4, height: 4 },
      position: [9, -1],
    });
    up(c.canvas, [11, 1]);

    await until(() => {
      const shape = c.cell("room", "shape");
      return shape?.type === "shape" && shape.shape.type === "rect" && shape.shape.width === 4;
    }, "the resize to land");
    expect(c.cell("room", "shape")).toEqual({
      type: "shape",
      shape: { type: "rect", width: 4, height: 4 },
    });
    expect(c.cell("room", "position")).toEqual({
      type: "list",
      items: [
        { type: "number", value: 9 },
        { type: "number", value: -1 },
      ],
    });
    // contents(room) follows the new region: the coin is outside it now, the map inside.
    const contents = await c.roomContents();
    expect(contents).toContain("map");
    expect(contents).not.toContain("coin");
    // The selection is unchanged, and the held preview clears once the write is visible.
    expect(c.ui.getState().selection).toEqual(["room"]);
    await until(() => c.runtime.getView().previews.size === 0, "the preview to clear");
  });
});
