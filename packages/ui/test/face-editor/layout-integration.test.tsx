/**
 * The layout tool and cell drops against a real in-process authority
 * (vtt-1xv.27; DESIGN.md §4.6 The inspector: layout mode, Gestures; §7
 * Undo; PROTOCOL.md §5 `set_face`, §6; M5 plan Q1 A2/A3, review r1 finding
 * 10, r3 finding 5). Composed as vtt-1xv.23 will: `BoardCanvas` over a face
 * scene drawn by the real Canvas2D renderer into a `RecordingContext`, the
 * real runtime with the select, ink and layout tools and
 * `dataDropHandlers: [cell drop handler]`, and the real `CellRow` as the
 * drag source.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ObjectView, WireOp } from "@vtt/protocol";
import type { FaceLayout, Point, Rect, TableObject } from "@vtt/schema";
import {
  apply,
  BoardCanvas,
  buildFaceScene,
  CELL_DRAG_MIME,
  CellRow,
  type ContentsPrimitive,
  compose,
  createCanvas2DRenderer,
  createCellDropHandler,
  createFaceStateStore,
  createInkTool,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createLayoutTool,
  createRuntimeInputs,
  createSelectTool,
  createToolContext,
  createUiStore,
  drawFaceItem,
  entryTransform,
  type FaceScene,
  type FaceStateStore,
  faceCullBounds,
  ImageCache,
  type InteractionEvent,
  type InteractionRuntime,
  itemTransform,
  RecordingContext,
  TableProvider,
  type TableSession,
  ToolRegistry,
  type UiStore,
  undo,
  useInteraction,
} from "@vtt/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const BOARD = "gm_board";
/** The camera is centred on the token. */
const CAMERA = { x: 7, y: 3, zoom: 1 };

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

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });

/** The token's `hp` element. */
const HP: Rect = [-1.5, -1.5, 1, 0.5];

/**
 * A 3 × 3 token at (7, 3) rotated 90° with an `hp` element; another token
 * at (3, 3); a shapeless binder at (7, -1) holding a card (and a note).
 */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "tok",
    to: { type: "board", board: BOARD, position: [7, 3] },
    init: {
      shape: { type: "rect", width: 3, height: 3 },
      cells: { name: text("Goblin"), hp: num(7), rotation: num(90) },
      face: { elements: [{ type: "value", cell: "hp", rect: HP }] },
    },
  },
  {
    type: "create_object",
    id: "other",
    to: { type: "board", board: BOARD, position: [3, 3] },
    init: { shape: { type: "rect", width: 1, height: 1 }, cells: { name: text("Other") } },
  },
  {
    type: "create_object",
    id: "binder",
    to: { type: "board", board: BOARD, position: [7, -1] },
    init: { cells: { name: text("Binder") } },
  },
  {
    type: "create_object",
    id: "card",
    to: { type: "container", container: "binder" },
    init: {
      shape: { type: "rect", width: 2.5, height: 3.5 },
      cells: { name: text("Attack"), atk: num(4) },
    },
  },
  {
    type: "create_object",
    id: "note",
    to: { type: "container", container: "binder" },
    init: { cells: { name: text("Note") } },
  },
];

// ---------------------------------------------------------------------------
// Composition

function useStore<T>(subscribe: (fn: () => void) => () => void, get: () => T): T {
  return useSyncExternalStore(subscribe, get);
}

function Board(props: {
  session: TableSession;
  ui: UiStore;
  runtime: InteractionRuntime;
  ctx: RecordingContext;
  faceState: FaceStateStore;
  scenes: FaceScene[];
}) {
  const { session, ui, runtime, ctx, faceState, scenes } = props;
  const { overlays, previews, handlers } = useInteraction({ runtime });
  const snapshot = useStore(
    (fn) => session.subscribe(fn),
    () => session.getSnapshot(),
  );
  const state = useStore(
    (fn) => ui.subscribe(fn),
    () => ui.getState(),
  );
  // Expanding an entry redraws (vtt-1xv.23 keys its scene the same way).
  const [faceVersion, setFaceVersion] = useState(0);
  useEffect(() => faceState.subscribe(() => setFaceVersion((v) => v + 1)), [faceState]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion and faceVersion key the scene
  const scene: FaceScene = useMemo(() => {
    const view = session.boardView();
    return buildFaceScene(
      {
        views: view === null ? [] : view.objects.values(),
        covers: view === null ? [] : [...view.covers.values()],
        board: view?.board ?? BOARD,
        viewer: snapshot.viewer,
        selection: state.selection,
        previews,
      },
      { faceState },
    );
  }, [session, snapshot.viewVersion, snapshot.viewer, state.selection, previews, faceVersion]);
  scenes.push(scene);
  return (
    <BoardCanvas<FaceScene>
      scene={scene}
      toolOverlays={overlays}
      camera={state.camera}
      setViewport={ui.setViewport}
      createRenderer={() =>
        createCanvas2DRenderer<FaceScene>(ctx, {
          images: new ImageCache({ resolve: (p) => p }),
          drawItem: drawFaceItem,
          cullBounds: faceCullBounds,
        })
      }
      {...handlers}
    />
  );
}

/** The real inspector rows of `object`'s cells `names`. */
function Rows(props: {
  session: TableSession;
  object: string;
  names: string[];
  readOnly?: boolean;
}) {
  const { session, object, names, readOnly = false } = props;
  const snapshot = useStore(
    (fn) => session.subscribe(fn),
    () => session.getSnapshot(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion keys the live view
  const view: ObjectView | null = useMemo(
    () => session.objectView(object),
    [session, object, snapshot.viewVersion],
  );
  if (view === null) return null;
  return (
    <ul data-object={object}>
      {names.map((name) => {
        const cell = view.cells[name];
        return cell === undefined ? null : (
          <CellRow
            key={name}
            object={object}
            name={name}
            cell={cell}
            session={session}
            readOnly={readOnly}
          />
        );
      })}
    </ul>
  );
}

async function setup() {
  const authority = await startAuthority();
  const gm = await authority.client("gm");
  await gm.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session });
  await ui.setActiveBoard(BOARD);
  await until(() => session.boardView()?.objects.has("tok") === true, "the board view");
  await until(() => session.objectView("card") !== null, "the contained card's view");
  act(() => ui.setCamera(CAMERA));

  const faceState = createFaceStateStore();
  const inputs = createRuntimeInputs(session, ui);
  const editor = createInPlaceEditorPort(ui);
  const registry = new ToolRegistry();
  registry.register(createSelectTool());
  const ink = createInkTool();
  const inkEvents: InteractionEvent[] = [];
  registry.register({
    ...ink,
    reduce(state, event, input) {
      inkEvents.push(event);
      return ink.reduce(state, event, input);
    },
  });
  registry.register(createLayoutTool());
  const runtime = createInteractionRuntime({
    registry,
    inputs,
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor,
    whenRevision: (r) => session.whenRevision(r),
    dataDropHandlers: [createCellDropHandler({ faceState })],
  });
  const ctx = new RecordingContext();
  const scenes: FaceScene[] = [];
  const utils = render(
    <TableProvider session={session} ui={ui}>
      <Board
        session={session}
        ui={ui}
        runtime={runtime}
        ctx={ctx}
        faceState={faceState}
        scenes={scenes}
      />
      <Rows session={session} object="tok" names={["hp", "name"]} />
      <Rows session={session} object="card" names={["atk"]} />
      <Rows session={session} object="other" names={["name"]} readOnly />
    </TableProvider>,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await waitFor(() => expect(ui.getState().viewport.width).toBe(800));

  const face = (id: string): FaceLayout | undefined =>
    (authority.host.table.store.getObject(id) as TableObject | undefined)?.face;
  const row = (object: string, cell: string): HTMLElement => {
    const el = utils.container.querySelector(`ul[data-object="${object}"] li[data-cell="${cell}"]`);
    if (el === null) throw new Error(`no row ${object}.${cell}`);
    return el as HTMLElement;
  };
  const transacts = vi.spyOn(session.client, "request");
  const transactCount = () => transacts.mock.calls.filter(([m]) => m === "transact").length;
  return {
    authority,
    session,
    ui,
    runtime,
    canvas,
    scenes,
    faceState,
    inkEvents,
    face,
    row,
    transactCount,
  };
}

/** Screen point of a board point under `CAMERA` and the 800 × 600 canvas. */
const screenOf = (board: Point): Point => [
  400 + (board[0] - CAMERA.x) * 64,
  300 + (board[1] - CAMERA.y) * 64,
];

const TOKEN_TO_BOARD = itemTransform({ anchor: [7, 3], rotation: 90 });
/** A token-local point on the board. */
const onToken = (local: Point): Point => apply(TOKEN_TO_BOARD, local);

function pointer(
  kind: "pointerDown" | "pointerMove" | "pointerUp",
  canvas: HTMLCanvasElement,
  board: Point,
) {
  const [x, y] = screenOf(board);
  act(() => {
    fireEvent[kind](canvas, {
      pointerId: 1,
      clientX: x,
      clientY: y,
      button: kind === "pointerMove" ? -1 : 0,
      buttons: kind === "pointerUp" ? 0 : 1,
    });
  });
}

/** A `DataTransfer` as far as the row and the canvas use it. */
class FakeDataTransfer {
  readonly #data = new Map<string, string>();
  effectAllowed = "none";
  dropEffect = "none";
  readonly files: File[] = [];
  get types(): string[] {
    return [...this.#data.keys()];
  }
  setData(type: string, data: string): void {
    this.#data.set(type, data);
  }
  getData(type: string): string {
    return this.#data.get(type) ?? "";
  }
}

function dispatchDrag(target: Element, type: string, dt: FakeDataTransfer, at?: Point) {
  const [x, y] = at === undefined ? [0, 0] : screenOf(at);
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

/** Drags `row` (the real `CellRow`) and drops it on the canvas at board point `at`. */
function dragRowTo(row: HTMLElement, canvas: HTMLCanvasElement, at: Point): MouseEvent {
  const dt = new FakeDataTransfer();
  dispatchDrag(row, "dragstart", dt);
  dispatchDrag(canvas, "dragover", dt, at);
  return dispatchDrag(canvas, "drop", dt, at);
}

function expectRect(actual: Rect | undefined, expected: Rect) {
  expect(actual).toBeDefined();
  (actual as Rect).forEach((v, i) => {
    expect(v).toBeCloseTo(expected[i] as number, 9);
  });
}

// ---------------------------------------------------------------------------

describe("layout tool", () => {
  test("dragging an element moves it in one set_face write; one undo restores it", async () => {
    const c = await setup();
    act(() => c.ui.select(["tok"]));
    act(() => c.ui.setTool("layout"));
    expect(c.runtime.machine().tool).toBe("layout");
    pointer("pointerMove", c.canvas, onToken([0, 0]));
    await waitFor(() =>
      expect(c.runtime.getView().overlays.some((o) => o.kind === "drag_ghost")).toBe(true),
    );
    const before = c.transactCount();
    // Press inside hp ([-1.5, -1.5, 1, 0.5]) and drag by (0.5, 0.25) local, rotated on the board.
    pointer("pointerDown", c.canvas, onToken([-1, -1.25]));
    pointer("pointerMove", c.canvas, onToken([-0.75, -1.1]));
    pointer("pointerMove", c.canvas, onToken([-0.5, -1]));
    pointer("pointerUp", c.canvas, onToken([-0.5, -1]));
    await until(() => c.face("tok")?.elements[0]?.rect[0] !== HP[0], "the moved element");
    expectRect(c.face("tok")?.elements[0]?.rect, [-1, -1.25, 1, 0.5]);
    expect(c.transactCount() - before).toBe(1);
    // The handles of the selected element are drawn at its corners on the board.
    await waitFor(() => {
      const handles = c.runtime.getView().overlays.find((o) => o.kind === "handles");
      expect(handles?.kind === "handles" && handles.handles.length).toBe(4);
    });

    await act(async () => {
      await undo(c.session);
    });
    await until(() => c.face("tok")?.elements[0]?.rect[0] === HP[0], "the undo");
    expect(c.face("tok")?.elements[0]?.rect).toEqual(HP);
  });

  test("resizing from a corner handle clamps to the minimum size", async () => {
    const c = await setup();
    act(() => c.ui.select(["tok"]));
    act(() => c.ui.setTool("layout"));
    // Select hp, then wait for the view to settle.
    pointer("pointerDown", c.canvas, onToken([-1, -1.25]));
    pointer("pointerUp", c.canvas, onToken([-1, -1.25]));
    // Drag the se corner (-0.5, -1) far past the nw corner.
    pointer("pointerDown", c.canvas, onToken([-0.5, -1]));
    pointer("pointerMove", c.canvas, onToken([-1, -1.2]));
    pointer("pointerMove", c.canvas, onToken([-3, -3]));
    pointer("pointerUp", c.canvas, onToken([-3, -3]));
    await until(() => c.face("tok")?.elements[0]?.rect[2] !== HP[2], "the resized element");
    expectRect(c.face("tok")?.elements[0]?.rect, [-1.5, -1.5, 0.1, 0.1]);
  });

  test("Escape returns to select", async () => {
    const c = await setup();
    act(() => c.ui.select(["tok"]));
    act(() => c.ui.setTool("layout"));
    act(() => {
      fireEvent.keyDown(c.canvas, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(c.runtime.machine().tool).toBe("select"));
    expect(c.ui.getState().tool.id).toBe("select");
  });
});

describe("cell drops", () => {
  test("dropping the hp row on the rotated token adds an hp element at the drop point's local coordinates", async () => {
    const c = await setup();
    expect(c.row("tok", "hp").draggable).toBe(true);
    // Token-local (-1.2, 0.4) is board (6.6, 1.8).
    const at = onToken([-1.2, 0.4]);
    expect(at[0]).toBeCloseTo(6.6, 9);
    expect(at[1]).toBeCloseTo(1.8, 9);
    const ev = dragRowTo(c.row("tok", "hp"), c.canvas, at);
    expect(ev.defaultPrevented).toBe(true);
    await until(() => c.face("tok")?.elements.length === 2, "the added element");
    const added = c.face("tok")?.elements[1];
    expect(added).toMatchObject({ type: "value", cell: "hp" });
    expectRect(added?.rect, [-1.2, 0.4, 2, 0.6]);
    expect(c.runtime.machine().tool).toBe("select");
  });

  test("while ink is active the drop is handled and the ink tool receives no event for it", async () => {
    const c = await setup();
    act(() => c.ui.setTool("ink"));
    expect(c.runtime.machine().tool).toBe("ink");
    const seen = c.inkEvents.length;
    dragRowTo(c.row("tok", "hp"), c.canvas, onToken([0, 0]));
    await until(() => c.face("tok")?.elements.length === 2, "the added element");
    expect(c.face("tok")?.elements[1]).toMatchObject({ type: "value", cell: "hp" });
    expect(c.inkEvents.slice(seen).filter((e) => e.type === "data_drop")).toEqual([]);
    expect(c.inkEvents.length).toBe(seen);
  });

  test("dropping a contained card's row on that card drawn expanded in the binder adds it at its local point", async () => {
    const c = await setup();
    act(() => c.faceState.expand("card"));
    // The faceless binder's default list shows only while it is selected (M6-D12).
    act(() => c.ui.select(["binder"]));
    // The binder's default contents list, from the drawn face scene.
    let scene: FaceScene | undefined;
    await waitFor(() => {
      scene = c.scenes.at(-1);
      const list = scene?.faces
        .get("binder")
        ?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
      expect(list?.entries.find((e) => e.id === "card")?.expanded).toBe(true);
    });
    const s = scene as FaceScene;
    const list = s.faces
      .get("binder")
      ?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents") as ContentsPrimitive;
    const entry = list.entries.find((e) => e.id === "card");
    const binderToBoard = s.transforms.get("binder");
    if (entry === undefined || binderToBoard === undefined) throw new Error("no card row");
    const local: Point = [-1, -1.5];
    const at = apply(compose(binderToBoard, entryTransform(list, entry)), local);
    dragRowTo(c.row("card", "atk"), c.canvas, at);
    await until(() => c.face("card") !== undefined, "the card's new layout");
    const added = c.face("card")?.elements.at(-1);
    expect(added).toMatchObject({ type: "value", cell: "atk" });
    expectRect(added?.rect, [-1, -1.5, 2, 0.6]);
  });

  // A collapsed row's frame maps to no point of the full list (vtt-qf5.46).
  describe("dropping a contained card's row on its collapsed row in the binder", () => {
    /** The board point of the card's collapsed row-local `local`, from the drawn scene. */
    async function collapsedCardPoint(c: Awaited<ReturnType<typeof setup>>, local: Point) {
      // The faceless binder's default list shows only while it is selected (M6-D12).
      act(() => c.ui.select(["binder"]));
      let list: ContentsPrimitive | undefined;
      let scene: FaceScene | undefined;
      await waitFor(() => {
        scene = c.scenes.at(-1);
        list = scene?.faces
          .get("binder")
          ?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
        expect(list?.entries.find((e) => e.id === "card")?.list).toBe("collapsed");
      });
      const l = list as ContentsPrimitive;
      const entry = l.entries.find((e) => e.id === "card");
      const binderToBoard = scene?.transforms.get("binder");
      if (entry === undefined || binderToBoard === undefined) throw new Error("no card row");
      return apply(compose(binderToBoard, entryTransform(l, entry)), local);
    }

    test("a faceless card gets the default layout plus atk where Add puts a new row", async () => {
      const c = await setup();
      const before = c.transactCount();
      dragRowTo(c.row("card", "atk"), c.canvas, await collapsedCardPoint(c, [3, 0.3]));
      await until(() => c.face("card") !== undefined, "the card's new layout");
      expect(c.transactCount() - before).toBe(1);
      const elements = c.face("card")?.elements ?? [];
      expect(elements.map((e) => (e.type === "value" ? e.cell : e.type))).toEqual([
        "name",
        "atk",
        "contents",
        "atk",
      ]);
      // The 2.5 × 3.5 card's full frame starts at (-1.25, -1.75).
      expect(elements.at(-1)).toMatchObject({ type: "value", cell: "atk" });
      expectRect(elements.at(-1)?.rect, [-1.25, -1.75, 2, 0.6]);
      // One undo removes the whole layout again.
      await act(async () => {
        await undo(c.session);
      });
      await until(() => c.face("card") === undefined, "the undone layout");
    });

    test("a card with a stored face gains atk in its full list", async () => {
      const c = await setup();
      const gm = await c.authority.client("gm");
      await gm.transact(
        [
          {
            type: "set_face",
            object: "card",
            face: { elements: [{ type: "value", cell: "name", rect: [-1.25, 1, 2.5, 0.5] }] },
          },
        ],
        { label: "Card face" },
      );
      await until(() => c.session.objectView("card")?.face !== undefined, "the card's face");
      dragRowTo(c.row("card", "atk"), c.canvas, await collapsedCardPoint(c, [1, 0.3]));
      await until(() => c.face("card")?.elements.length === 2, "the added element");
      expect(c.face("card")?.elements).toEqual([
        { type: "value", cell: "name", rect: [-1.25, 1, 2.5, 0.5] },
        { type: "value", cell: "atk", rect: [-1.25, -1.75, 2, 0.6] },
      ]);
    });
  });

  test("a drop on another object or with another mime is not handled", async () => {
    const c = await setup();
    const before = c.transactCount();
    // The hp row of tok dropped on `other`.
    dragRowTo(c.row("tok", "hp"), c.canvas, [3, 3]);
    // Another vtt mime on the token itself.
    const dt = new FakeDataTransfer();
    dt.setData("application/x-vtt-template", JSON.stringify({ object: "tok", cell: "hp" }));
    dispatchDrag(c.canvas, "drop", dt, [7, 3]);
    // A later, handled drop proves the earlier ones wrote nothing.
    dragRowTo(c.row("tok", "hp"), c.canvas, [7, 3]);
    await until(() => c.face("tok")?.elements.length === 2, "the handled drop");
    expect(c.transactCount() - before).toBe(1);
    expect(c.face("other")).toBeUndefined();
  });

  test("the row carries the cell's mime and data, and is no drag source in view-as", async () => {
    const c = await setup();
    const dt = new FakeDataTransfer();
    dispatchDrag(c.row("tok", "hp"), "dragstart", dt);
    expect(dt.types).toEqual([CELL_DRAG_MIME]);
    expect(JSON.parse(dt.getData(CELL_DRAG_MIME))).toEqual({ object: "tok", cell: "hp" });
    // A read-only (view-as) row is not draggable and carries nothing.
    const other = c.row("other", "name");
    expect(other.draggable).toBe(false);
    const none = new FakeDataTransfer();
    dispatchDrag(other, "dragstart", none);
    expect(none.types).toEqual([]);
  });
});
