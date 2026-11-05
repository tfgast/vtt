/**
 * The select tool against a real in-process authority (vtt-3l6.7): the real
 * session, `UiStore`, runtime inputs, tool context and write port
 * (vtt-3l6.21), the interaction runtime and `useInteraction` (vtt-3l6.23),
 * and `BoardCanvas` with the Canvas2D renderer over a recording context.
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
  createSelectTool,
  createToolContext,
  createUiStore,
  type DropOverride,
  type EditorPort,
  ImageCache,
  type InteractionRuntime,
  RecordingContext,
  type Scene,
  type SelectToolOptions,
  sessionNotices,
  TableProvider,
  ToolRegistry,
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
// Composition

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
  // A room zone under an imported map image (z: the map is above the zone in draw order).
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
  create("tok", [1, 1], {
    shape: { type: "circle", radius: 0.5 },
    cells: { name: { type: "text", value: "Goblin" } },
  }),
  create("die", [-2, 1], {
    shape: { type: "circle", radius: 0.25 },
    cells: { name: { type: "text", value: "d6" } },
  }),
  create("orc", [-3, -3], {
    is_template: true,
    shape: { type: "circle", radius: 0.5 },
    cells: { name: { type: "text", value: "Orc" } },
  }),
];

async function compose(options?: SelectToolOptions) {
  const authority = await startAuthority();
  const gm = await authority.client("gm");
  await gm.transact(SETUP);
  const session = authority.session();
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("orc") === true, "the views");

  const ui = createUiStore({ session });
  const inputs = createRuntimeInputs(session, ui);
  const toolContext = createToolContext(session, ui, {
    pickFile: async () => null,
    upload: async () => ({ path: "t.assets/x.png", width: 1, height: 1 }),
  });
  const editor: EditorPort = { open: () => undefined, close: () => undefined };
  const registry = new ToolRegistry();
  registry.register(createSelectTool(options));
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
  const position = (id: ObjectId): Point | null => {
    const v = cell(id, "position");
    if (v?.type !== "list") return null;
    const [x, y] = v.items;
    if (x?.type !== "number" || y?.type !== "number") return null;
    return [x.value, y.value];
  };
  const notices = () => sessionNotices(session).list();
  return { authority, gm, session, ui, runtime, canvas, ctx, cell, position, notices };
}

/** Screen point of a board point under the default camera and the 800 × 600 canvas. */
const screenOf = (board: Point): Point => [400 + board[0] * 64, 300 + board[1] * 64];

interface Mods {
  altKey?: boolean;
  shiftKey?: boolean;
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

function drag(
  canvas: HTMLCanvasElement,
  from: Point,
  to: Point,
  mods: { down?: Mods; move?: Mods; up?: Mods } = {},
) {
  down(canvas, from, mods.down);
  move(canvas, to, mods.move ?? mods.down);
  up(canvas, to, mods.up ?? mods.move ?? mods.down);
}

function click(canvas: HTMLCanvasElement, at: Point, mods: Mods = {}) {
  down(canvas, at, mods);
  up(canvas, at, mods);
}

const contentsOf = (v: WireResult | undefined): ObjectId[] =>
  v?.type === "list" ? v.items.flatMap((i) => (i.type === "ref" ? [i.object] : [])) : [];

// ---------------------------------------------------------------------------

describe("select tool integration", () => {
  test("dragging a token moves it in the authority", async () => {
    const c = await compose();
    drag(c.canvas, [1, 1], [3, 2]);
    await until(() => c.position("tok")?.[0] === 3, "the move to land");
    expect(c.position("tok")).toEqual([3, 2]);
    expect(c.ui.getState().selection).toEqual(["tok"]);
    await until(() => c.runtime.getView().previews.size === 0, "the preview to clear");
    expect(c.runtime.getView().overlays).toEqual([]);
  });

  test("dragging a template creates a copy pointing at it, and the copy is selected", async () => {
    const c = await compose();
    drag(c.canvas, [-3, -3], [-1, -4]);
    await until(
      () => c.ui.getState().selection.some((id) => id !== "orc"),
      "the copy to be selected",
    );
    const [copy] = c.ui.getState().selection;
    expect(copy).toMatch(/^orc_/);
    await until(() => c.session.objectView(copy as ObjectId) !== null, "the copy's view");
    expect(c.cell(copy as ObjectId, "template")).toEqual({ type: "ref", object: "orc" });
    expect(c.position(copy as ObjectId)).toEqual([-1, -4]);
    expect(c.session.objectView(copy as ObjectId)?.is_template).toBe(false);
    // The template stays.
    expect(c.position("orc")).toEqual([-3, -3]);
  });

  test("Alt-dropping a die onto a token puts it in the token's contents", async () => {
    const c = await compose();
    drag(c.canvas, [-2, 1], [1, 1], { up: { altKey: true } });
    await until(() => contentsOf(c.cell("tok", "contents")).includes("die"), "the containment");
    expect(c.cell("die", "container")).toEqual({ type: "ref", object: "tok" });
  });

  test("a drag that began before another client moved the token is rejected stale_write", async () => {
    const c = await compose();
    down(c.canvas, [1, 1]);
    const other = await c.authority.client("other");
    await other.transact(
      [{ type: "move", object: "tok", to: { type: "board", board: BOARD, position: [-5, -5] } }],
      { label: "Shove" },
    );
    await until(() => c.position("tok")?.[0] === -5, "the other client's move");
    move(c.canvas, [3, 3]);
    expect(c.runtime.getView().previews.get("tok")).toEqual({ position: [3, 3] });
    up(c.canvas, [3, 3]);
    await until(() => c.notices().some((n) => n.kind === "stale"), "the stale notice");
    await until(() => c.runtime.getView().previews.size === 0, "the preview to clear");
    expect(c.position("tok")).toEqual([-5, -5]);
  });

  test("Alt+click selects a zone lying under an imported map image", async () => {
    const c = await compose();
    click(c.canvas, [10, 0]);
    expect(c.ui.getState().selection).toEqual(["map"]);
    click(c.canvas, [10, 0], { altKey: true });
    expect(c.ui.getState().selection).toEqual(["map"]);
    click(c.canvas, [10, 0], { altKey: true });
    expect(c.ui.getState().selection).toEqual(["room"]);
    expect(c.ui.getState().hoveredZone).toBe("room");
    expect(c.ui.getState().hover).toBe("room");
  });

  describe("dropOverride", () => {
    type Call = { ids: ObjectId[]; intent: { copy: boolean; alt: boolean } };

    test("receives the intent captured at pointer down, for spawn and move drags; null keeps the tool's drop", async () => {
      const calls: Call[] = [];
      const dropOverride: DropOverride = (_input, _point, ids, intent) => {
        calls.push({ ids, intent });
        return null;
      };
      const c = await compose({ dropOverride });
      // A spawn drag (one template, no Alt) with Alt pressed mid-drag.
      drag(c.canvas, [-3, -3], [-1, -4], { down: {}, move: { altKey: true } });
      await until(
        () => c.ui.getState().selection.some((id) => id.startsWith("orc_")),
        "the copy to be selected",
      );
      // A move drag with Alt released mid-drag.
      drag(c.canvas, [1, 1], [2, 2], { down: { altKey: true }, move: {}, up: {} });
      await until(() => c.position("tok")?.[0] === 2, "the move to land");
      expect(calls).toEqual([
        { ids: ["orc"], intent: { copy: true, alt: false } },
        { ids: ["tok"], intent: { copy: false, alt: true } },
      ]);
    });

    test("a non-null result replaces the drop write with the same stamp and its continuations run on commit", async () => {
      const dropOverride: DropOverride = (_input, _point, ids) => ({
        ops: [
          {
            type: "set_value",
            object: ids[0] as ObjectId,
            cell: "hp",
            value: { type: "number", value: 7 },
          },
        ],
        label: "Mark",
        continuations: [{ type: "select", ids: ["die"] }],
      });
      const c = await compose({ dropOverride });
      down(c.canvas, [1, 1]);
      const other = await c.authority.client("other");
      // A disjoint write after the pointer down: the override's write still commits with
      // the pointer-down revision as its base (it touches tok.hp only).
      await other.transact([
        { type: "set_value", object: "die", cell: "label", value: { type: "text", value: "x" } },
      ]);
      await until(() => c.cell("die", "label") !== undefined, "the other write");
      move(c.canvas, [3, 3]);
      up(c.canvas, [3, 3]);
      await until(() => c.cell("tok", "hp") !== undefined, "the override write");
      expect(c.cell("tok", "hp")).toEqual({ type: "number", value: 7 });
      // Nothing moved; the continuation selected the die.
      expect(c.position("tok")).toEqual([1, 1]);
      await until(() => c.ui.getState().selection.includes("die"), "the continuation");
      expect(c.ui.getState().selection).toEqual(["die"]);
    });

    test("a non-null result on a stale base is rejected: the stamp is the pointer-down one", async () => {
      const dropOverride: DropOverride = () => ({
        ops: [
          { type: "set_value", object: "tok", cell: "hp", value: { type: "number", value: 7 } },
        ],
        label: "Mark",
      });
      const c = await compose({ dropOverride });
      down(c.canvas, [1, 1]);
      const other = await c.authority.client("other");
      await other.transact([
        { type: "set_value", object: "tok", cell: "hp", value: { type: "number", value: 1 } },
      ]);
      await until(() => c.cell("tok", "hp") !== undefined, "the other write");
      move(c.canvas, [3, 3]);
      up(c.canvas, [3, 3]);
      await until(() => c.notices().some((n) => n.kind === "stale"), "the stale notice");
      expect(c.cell("tok", "hp")).toEqual({ type: "number", value: 1 });
    });
  });
});
