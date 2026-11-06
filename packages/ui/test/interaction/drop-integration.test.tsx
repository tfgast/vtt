/**
 * Entry drags, reference drops and container insertion against a real
 * in-process authority (vtt-1xv.25; DESIGN.md §4.6 Gestures, §4.7 drag out
 * of a binder, giving a template; §4.1 spawn; §7 Undo; PROTOCOL.md §5;
 * M4-D8): vtt-3l6.21's helper (`startAuthority`, the real session, `UiStore`,
 * runtime inputs and tool context), the interaction runtime (vtt-3l6.23)
 * with `withFaces(withHandles(createSelectTool({dropOverride})), {gestures:
 * [entryDragGesture]})`, `BoardCanvas` with the Canvas2D renderer and
 * `drawFaceItem` over a recording context, and the inspector's `CellList`
 * for the selected object. The Attack card is spawned with its face.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import type { ObjectId, OpGroup, Point, Rect } from "@vtt/schema";
import {
  type Affine,
  apply,
  BoardCanvas,
  buildFaceScene,
  CellList,
  compose,
  createCanvas2DRenderer,
  createFaceDropOverride,
  createFaceStateStore,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createRuntimeInputs,
  createSelectTool,
  createToolContext,
  createUiStore,
  defaultFacePolicy,
  drawFaceItem,
  entryDragGesture,
  entryTransform,
  type FaceDrawing,
  type FaceScene,
  type FaceStateStore,
  faceCullBounds,
  faceHitAt,
  ImageCache,
  type InteractionRuntime,
  RecordingContext,
  TableProvider,
  type TableSession,
  ToolRegistry,
  toScreen,
  type UiStore,
  useInteraction,
  useSession,
  withFaces,
  withHandles,
} from "@vtt/ui";
import { useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const VIEWPORT = { width: 800, height: 600 };
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
// The table

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const bool = (value: boolean) => ({ type: "boolean" as const, value });
const ref = (object: string) => ({ type: "ref" as const, object });
const formula = (source: string) => ({ type: "formula" as const, source });
const EMPTY = { type: "empty" as const };
const ALL = { type: "viewers" as const, viewers: ["all" as const] };
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: BOARD,
  position: [x, y] as [number, number],
});
const into = (container: string) => ({ type: "container" as const, container });
const rectShape = (width: number, height: number) => ({ type: "rect" as const, width, height });

/** The Attack card of DESIGN.md §4.6 (FORMULAS.md §10), as a template. */
const ATTACK_CARD: WireOp = {
  type: "create_object",
  id: "attack_card",
  to: at(-30, 30),
  init: {
    is_template: true,
    tag: ["card", "attack"],
    shape: rectShape(2, 3),
    cells: {
      name: text("Attack"),
      visible_to: ALL,
      face_up: bool(true),
      attacker: EMPTY,
      target: EMPTY,
      roll: EMPTY,
      dmg: EMPTY,
      applied: bool(false),
      bonus: formula("attacker.attack_bonus"),
      total: formula("roll + bonus"),
      hit: formula("roll != empty and total >= target.ac"),
    },
    actions: [
      { name: "Roll", when: "target != empty and roll = empty", steps: ["roll(1d20) -> roll"] },
    ],
    face: {
      elements: [
        { type: "value", cell: "name", rect: [-1.2, -1.7, 2.4, 0.4], style: { size: "large" } },
        { type: "editor", cell: "target", rect: [-1.2, -1.2, 2.4, 0.4], style: { caption: true } },
        { type: "value", cell: "total", rect: [-1.2, -0.7, 1.1, 0.5], style: { caption: true } },
        { type: "value", cell: "hit", rect: [0.1, -0.7, 1.1, 0.5], style: { caption: true } },
        { type: "value", cell: "dmg", rect: [-1.2, -0.1, 2.4, 0.4], style: { caption: true } },
        {
          type: "button",
          action: "Roll",
          rect: [-1.2, 0.5, 1.1, 0.45],
          show_when: "roll = empty",
        },
      ],
      default_action: "Roll",
    },
  },
};

const LIST: Rect = [-3, -3, 6, 4.8];
/** The token's when_selected list: below its radius-0.9 footprint, as the stocked token face places it. */
const TOK_LIST: Rect = [-1.5, 0.9, 3, 1.2];

/** A container at (x, y) with a contents element `list`. */
const container = (id: string, x: number, y: number, tag: string[], list = LIST, h = 6) =>
  ({
    type: "create_object",
    id,
    to: at(x, y),
    init: {
      tag,
      shape: rectShape(6, h),
      cells: { name: text(id), visible_to: ALL, face_up: bool(true) },
      face: { elements: [{ type: "contents", rect: list }] },
    },
  }) satisfies WireOp;

/** A 2.5 × 3.5 card in `parent`: a name value and a `title` cell. */
const entry = (id: string, parent: string, template = false) =>
  ({
    type: "create_object",
    id,
    to: into(parent),
    init: {
      is_template: template,
      shape: rectShape(2.5, 3.5),
      cells: { name: text(id), visible_to: ALL, face_up: bool(true), title: text("") },
      face: { elements: [{ type: "value", cell: "name", rect: [-1.15, -1.65, 2.3, 0.5] }] },
    },
  }) satisfies WireOp;

const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "goblin1",
    to: at(5, 3),
    init: {
      shape: { type: "circle", radius: 0.5 },
      cells: { name: text("Goblin"), visible_to: ALL, face_up: bool(true), ac: num(13) },
    },
  },
  ATTACK_CARD,
  {
    type: "create_object",
    id: "tpl_d20",
    to: at(10, -3),
    init: {
      is_template: true,
      shape: rectShape(1, 1),
      cells: { name: text("d20"), visible_to: ALL, face_up: bool(true), total: EMPTY },
      face: { elements: [{ type: "value", cell: "total", rect: [-0.4, -0.4, 0.8, 0.4] }] },
    },
  },
  // Binder A at (0, -20): a template card, then two cards.
  container("bnd_a", 0, -20, ["binder"]),
  entry("tcard", "bnd_a", true),
  entry("acard", "bnd_a"),
  entry("xcard", "bnd_a"),
  // Binder B at (20, -20): three cards.
  container("bnd_b", 20, -20, ["binder"]),
  entry("b0", "bnd_b"),
  entry("b1", "bnd_b"),
  entry("b2", "bnd_b"),
  // A binder whose three rows fill its 6 × 1.8 list exactly, at (40, -20).
  container("bnd_full", 40, -20, ["binder"], [-3, -1.5, 6, 1.8], 3),
  entry("f0", "bnd_full"),
  entry("f1", "bnd_full"),
  entry("f2", "bnd_full"),
  // A pouch (not a binder) at (60, -20) holding one card.
  container("pouch", 60, -20, ["pouch"]),
  entry("p0", "pouch"),
  // A token at (80, 0) whose list below it shows only when selected (M6-D12), holding a gem.
  {
    type: "create_object",
    id: "tok",
    to: at(80, 0),
    init: {
      shape: { type: "circle", radius: 0.9 },
      cells: { name: text("Tok"), visible_to: ALL, face_up: bool(true) },
      face: {
        elements: [
          { type: "value", cell: "name", rect: [-0.9, -0.3, 1.8, 0.6] },
          { type: "contents", rect: TOK_LIST, when_selected: true },
        ],
      },
    },
  },
  entry("gem1", "tok"),
  // A room zone at (90, 0).
  {
    type: "create_object",
    id: "room",
    to: at(90, 0),
    init: {
      is_zone: true,
      shape: rectShape(2, 2),
      cells: { name: text("Room"), visible_to: ALL, face_up: bool(true) },
    },
  },
];

// ---------------------------------------------------------------------------
// Composition

function Board(props: {
  session: TableSession;
  ui: UiStore;
  runtime: InteractionRuntime;
  ctx: RecordingContext;
  faceState: FaceStateStore;
}) {
  const { session, ui, runtime, ctx, faceState } = props;
  const { overlays, previews, handlers } = useInteraction({ runtime });
  const viewVersion = useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  const state = useSyncExternalStore(
    (fn) => ui.subscribe(fn),
    () => ui.getState(),
  );
  const [faceTick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => faceState.subscribe(bump), [faceState]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion and faceTick key the scene
  const scene: FaceScene = useMemo(() => {
    const view = session.boardView();
    return buildFaceScene(
      {
        views: view === null ? [] : view.objects.values(),
        covers: view === null ? [] : [...view.covers.values()],
        board: view?.board ?? BOARD,
        viewer,
        selection: state.selection,
        previews,
      },
      // As App.tsx's CanvasPane: the drag's Alt-hover reveals when_selected lists (M6-D12).
      { faceState, altHover: state.altHover },
    );
  }, [session, viewVersion, viewer, state.selection, state.altHover, previews, faceTick]);
  const selected = state.selection.length === 1 ? (state.selection[0] as ObjectId) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion keys the view
  const view = useMemo(
    () => (selected === null ? null : session.objectView(selected)),
    [session, selected, viewVersion],
  );
  return (
    <div>
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
      <section aria-label="inspector">
        {selected === null || view === null ? null : (
          <CellList object={selected} view={view} session={session} readOnly={false} />
        )}
      </section>
    </div>
  );
}

async function world() {
  const authority = await startAuthority();
  const seeder = await authority.client("seed");
  const seeded = await seeder.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));
  const spawned = await seeder.transact(
    [{ type: "spawn", template: "attack_card", to: at(0, 0), as: "$card" }],
    { label: "Spawn" },
  );
  if (spawned.status !== "committed") throw new Error(JSON.stringify(spawned));
  const card = spawned.bindings.$card as ObjectId;

  const session = authority.session();
  await whenReady(session);
  await until(() => session.boardView()?.objects.has(card) === true, "the card's view");

  const ui = createUiStore({ session });
  const faceState = createFaceStateStore();
  const registry = new ToolRegistry();
  registry.register(
    withFaces(withHandles(createSelectTool({ dropOverride: createFaceDropOverride(faceState) })), {
      faceState,
      policy: defaultFacePolicy,
      gestures: [entryDragGesture({ faceState })],
    }),
  );
  const runtime = createInteractionRuntime({
    registry,
    inputs: createRuntimeInputs(session, ui),
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor: createInPlaceEditorPort(ui),
    whenRevision: (r) => session.whenRevision(r),
  });

  const ctx = new RecordingContext();
  const utils = render(
    <TableProvider session={session} ui={ui}>
      <Board session={session} ui={ui} runtime={runtime} ctx={ctx} faceState={faceState} />
    </TableProvider>,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await waitFor(() => expect(ui.getState().viewport.width).toBe(800));

  const store = authority.host.table.store;
  const object = (id: ObjectId) => store.getObject(id);
  const groups = (): readonly OpGroup[] => store.history.groups() as readonly OpGroup[];
  const ids = () => new Set(store.objectIds());

  const faces = (): FaceScene => {
    const view = session.boardView();
    if (view === null) throw new Error("no board view");
    const { selection, altHover } = ui.getState();
    return buildFaceScene(
      {
        views: view.objects.values(),
        covers: [...view.covers.values()],
        board: view.board,
        viewer: session.getSnapshot().viewer,
        selection,
      },
      { faceState, altHover },
    );
  };

  const screenOf = (board: Point): Point => toScreen(ui.getState().camera, board, VIEWPORT);
  const fire = (
    type: "pointerDown" | "pointerMove" | "pointerUp",
    board: Point,
    altKey = false,
  ) => {
    const [x, y] = screenOf(board);
    act(() => {
      fireEvent[type](canvas, {
        pointerId: 1,
        clientX: x,
        clientY: y,
        button: type === "pointerMove" ? -1 : 0,
        buttons: type === "pointerUp" ? 0 : 1,
        altKey,
      });
    });
  };
  /** A press at `from`, moves through `via`, a release at the last point; Alt per event. */
  const drag = (from: Point, via: Point[], alt: boolean[] = []) => {
    fire("pointerDown", from, alt[0] ?? false);
    via.forEach((p, i) => {
      fire("pointerMove", p, alt[i + 1] ?? false);
    });
    fire("pointerUp", via[via.length - 1] ?? from, alt[via.length + 1] ?? false);
  };
  const click = (p: Point) => drag(p, []);

  return {
    authority,
    session,
    ui,
    faceState,
    runtime,
    card,
    canvas,
    object,
    groups,
    ids,
    faces,
    fire,
    drag,
    click,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Lets pending writes and renders settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];

/** Every faced object of `scene`, board and contained, with its frame → board. */
function locate(scene: FaceScene): Map<ObjectId, { toBoard: Affine; drawing: FaceDrawing | null }> {
  const out = new Map<ObjectId, { toBoard: Affine; drawing: FaceDrawing | null }>();
  const walk = (drawing: FaceDrawing, toBoard: Affine) => {
    for (const p of drawing.primitives) {
      if (p.kind !== "contents") continue;
      for (const e of p.entries) {
        if (e.id === null) continue;
        const t = compose(toBoard, entryTransform(p, e));
        out.set(e.id, { toBoard: t, drawing: e.drawing });
        if (e.drawing !== null) walk(e.drawing, t);
      }
    }
  };
  for (const [id, drawing] of scene.faces) {
    const t = scene.transforms.get(id) as Affine;
    out.set(id, { toBoard: t, drawing });
    walk(drawing, t);
  }
  return out;
}

/** The board point of local point `local` of drawn object `id`. */
function pointOn(w: World, id: ObjectId, local: Point): Point {
  const l = locate(w.faces()).get(id);
  if (l === undefined) throw new Error(`${id} is not drawn`);
  return apply(l.toBoard, local);
}

/** Collapsed row `i` of a list at board y `top` (x right of the chevron), upper or lower half. */
const rowAt = (x: number, top: number, i: number, half: "upper" | "lower" = "upper"): Point => [
  x + 1,
  top + 0.6 * i + (half === "upper" ? 0.15 : 0.45),
];
/** The rows of the 4.8-high lists at y = -20: their top is -23. */
const TOP = -23;
// The Attack card at (0, 0): its target editor.
const TARGET: Point = centre([-1.2, -1.2, 2.4, 0.4]);

const contentsOf = (w: World, id: ObjectId) => w.object(id)?.contents ?? [];

// ---------------------------------------------------------------------------

describe("reference drops", () => {
  test("dropping the goblin token on the card's target editor writes the reference and leaves the goblin in place", async () => {
    const w = await world();
    const before = w.groups().length;
    const position = w.object("goblin1")?.cells.position?.content;
    w.drag([5, 3], [[3, 1], TARGET]);
    await until(() => w.object(w.card)?.cells.target?.content.type === "ref", "the target");
    expect(w.object(w.card)?.cells.target?.content).toEqual(ref("goblin1"));
    await settle();
    expect(w.groups().length).toBe(before + 1);
    expect(w.object("goblin1")?.board).toBe(BOARD);
    expect(w.object("goblin1")?.cells.position?.content).toEqual(position);
  });
});

describe("clicking contained objects", () => {
  test("clicking a card's collapsed row in a binder selects it (no write); editing one of its cells in the inspector writes it", async () => {
    const w = await world();
    const before = w.groups().length;
    w.click(rowAt(0, TOP, 1));
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["acard"]));
    await settle();
    expect(w.groups().length).toBe(before);

    const user = userEvent.setup();
    const inspector = screen.getByRole("region", { name: "inspector" });
    const row = [...inspector.querySelectorAll<HTMLElement>("[data-cell]")].find(
      (el) => el.getAttribute("data-cell") === "title",
    );
    if (row === undefined) throw new Error("no title row");
    const value = row.querySelector<HTMLElement>('[data-part="value"]');
    if (value === null) throw new Error("no title value");
    await user.dblClick(value);
    const input = within(row).getByRole("textbox", { name: "Value of title" });
    await user.clear(input);
    await user.type(input, "hello{Enter}");
    await until(
      () =>
        JSON.stringify(w.object("acard")?.cells.title?.content) === JSON.stringify(text("hello")),
      "acard's title",
    );
  });

  test("clicking the empty area of an expanded child selects the child", async () => {
    const w = await world();
    act(() => w.faceState.expand("xcard"));
    await settle();
    const empty = pointOn(w, "xcard", [0.8, -1.0]);
    expect(faceHitAt(w.faces(), empty, w.ui.getState().camera)).toMatchObject({
      object: "xcard",
      target: { type: "body" },
    });
    const before = w.groups().length;
    w.click(empty);
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["xcard"]));
    expect(w.groups().length).toBe(before);
  });
});

describe("container insertion", () => {
  test("a card entry dropped over a collapsed row of another binder is inserted at that row's index", async () => {
    const w = await world();
    w.drag(rowAt(0, TOP, 1), [[10, -10], rowAt(20, TOP, 1)]);
    await until(() => contentsOf(w, "bnd_b").includes("acard"), "acard in bnd_b");
    expect(contentsOf(w, "bnd_b")).toEqual(["b0", "acard", "b1", "b2"]);
    expect(contentsOf(w, "bnd_a")).toEqual(["tcard", "xcard"]);
  });

  test("a card dropped over a value inside an expanded row's child is inserted into the outer list, not into the child", async () => {
    const w = await world();
    act(() => w.faceState.expand("xcard"));
    await settle();
    // xcard's name value, in the upper half of its row: before xcard.
    const name = pointOn(w, "xcard", [0, -1.4]);
    expect(faceHitAt(w.faces(), name, w.ui.getState().camera)).toMatchObject({
      object: "xcard",
      target: { type: "value", cell: "name" },
    });
    w.drag(rowAt(20, TOP, 0), [[10, -10], name]);
    await until(() => contentsOf(w, "bnd_a").includes("b0"), "b0 in bnd_a");
    expect(contentsOf(w, "bnd_a")).toEqual(["tcard", "acard", "b0", "xcard"]);
    expect(contentsOf(w, "xcard")).toEqual([]);
  });

  test("a card dropped over a list whose rows fill its rect is inserted at the row index", async () => {
    const w = await world();
    // bnd_full's list spans y -21.5..-19.7.
    w.drag(rowAt(20, TOP, 1), [[30, -10], rowAt(40, -21.5, 1, "lower")]);
    await until(() => contentsOf(w, "bnd_full").includes("b1"), "b1 in bnd_full");
    expect(contentsOf(w, "bnd_full")).toEqual(["f0", "f1", "b1", "f2"]);
  });
});

describe("board template drops", () => {
  test("a d20 template dropped on a binder's contents element gives a template: one group, the copy at the index with is_template true, selected", async () => {
    const w = await world();
    const before = w.groups().length;
    w.drag([10, -3], [[15, -10], rowAt(20, TOP, 1)]);
    await until(() => contentsOf(w, "bnd_b").length === 4, "the copy in bnd_b");
    const copy = contentsOf(w, "bnd_b")[1] as ObjectId;
    expect(copy).toMatch(/^tpl_d20_\d+$/);
    expect(w.object(copy)?.is_template).toBe(true);
    expect(w.groups().length).toBe(before + 1);
    expect(w.object("tpl_d20")?.board).toBe(BOARD);
    await waitFor(() => expect(w.ui.getState().selection).toEqual([copy]));
  });

  test("dropped on a non-binder container's contents element it spawns an instance there", async () => {
    const w = await world();
    w.drag([10, -3], [[30, -10], rowAt(60, TOP, 1)]);
    await until(() => contentsOf(w, "pouch").length === 2, "the copy in the pouch");
    const copy = contentsOf(w, "pouch")[1] as ObjectId;
    expect(copy).toMatch(/^tpl_d20_\d+$/);
    expect(w.object(copy)?.is_template).toBe(false);
    await waitFor(() => expect(w.ui.getState().selection).toEqual([copy]));
  });

  test("dropped on the card's target editor it writes a reference to the template and spawns nothing", async () => {
    const w = await world();
    const ids = w.ids();
    w.drag([10, -3], [[5, -2], TARGET]);
    await until(() => w.object(w.card)?.cells.target?.content.type === "ref", "the target");
    expect(w.object(w.card)?.cells.target?.content).toEqual(ref("tpl_d20"));
    await settle();
    expect(w.ids()).toEqual(ids);
    expect(w.object("tpl_d20")?.board).toBe(BOARD);
  });
});

describe("entry drags out of a binder", () => {
  test("dragging a template entry out spawns a copy on the board", async () => {
    const w = await world();
    w.drag(rowAt(0, TOP, 0), [
      [5, -10],
      [6, -8],
    ]);
    await until(() => [...w.ids()].some((id) => id.startsWith("tcard_")), "the copy");
    const copy = [...w.ids()].find((id) => id.startsWith("tcard_")) as ObjectId;
    expect(w.object(copy)?.board).toBe(BOARD);
    expect(w.object(copy)?.cells.position?.content).toEqual({
      type: "list",
      items: [num(6), num(-8)],
    });
    expect(contentsOf(w, "bnd_a")).toEqual(["tcard", "acard", "xcard"]);
    await waitFor(() => expect(w.ui.getState().selection).toEqual([copy]));
  });

  test("with Alt held at pointer down it moves the template out", async () => {
    const w = await world();
    w.drag(
      rowAt(0, TOP, 0),
      [
        [5, -10],
        [6, -8],
      ],
      [true, false, false],
    );
    await until(() => w.object("tcard")?.board === BOARD, "tcard on the board");
    expect(contentsOf(w, "bnd_a")).toEqual(["acard", "xcard"]);
    expect([...w.ids()].some((id) => id.startsWith("tcard_"))).toBe(false);
  });

  test("a card entry dropped onto another binder's contents element is inserted at the index", async () => {
    const w = await world();
    w.drag(rowAt(0, TOP, 2), [[10, -10], rowAt(20, TOP, 0)]);
    await until(() => contentsOf(w, "bnd_b").includes("xcard"), "xcard in bnd_b");
    expect(contentsOf(w, "bnd_b")).toEqual(["xcard", "b0", "b1", "b2"]);
  });

  test("Escape during an entry drag writes nothing", async () => {
    const w = await world();
    const before = w.groups().length;
    w.fire("pointerDown", rowAt(0, TOP, 1));
    w.fire("pointerMove", [10, -10]);
    act(() => {
      fireEvent.keyDown(w.canvas, { key: "Escape", code: "Escape" });
    });
    w.fire("pointerUp", rowAt(20, TOP, 1));
    await settle();
    expect(w.groups().length).toBe(before);
    expect(contentsOf(w, "bnd_a")).toEqual(["tcard", "acard", "xcard"]);
    expect(contentsOf(w, "bnd_b")).toEqual(["b0", "b1", "b2"]);
  });
});

describe("a when_selected list (vtt-nb8.35, M6-D12)", () => {
  // In the token's list rect, below its footprint: local (-1, 1.9) of the token at (80, 0).
  const IN_LIST: Point = [79, 1.9];

  test("a zone released over an unselected token's list lands on the board; its contents are untouched", async () => {
    const w = await world();
    expect(
      w
        .faces()
        .faces.get("tok")
        ?.primitives.some((p) => p.kind === "contents"),
    ).toBe(false);
    w.drag([90, 0], [[85, 1], IN_LIST]);
    await until(() => {
      const pos = w.object("room")?.cells.position?.content;
      return JSON.stringify(pos) !== JSON.stringify({ type: "list", items: [num(90), num(0)] });
    }, "the room moved");
    expect(w.object("room")?.board).toBe(BOARD);
    expect(contentsOf(w, "tok")).toEqual(["gem1"]);
  });

  test("with Alt held at the drop over the token, the zone goes inside", async () => {
    const w = await world();
    w.drag(
      [90, 0],
      [
        [85, 1],
        [80, 0.5],
      ],
      [false, false, true, true],
    );
    await until(() => contentsOf(w, "tok").includes("room"), "the room in the token");
    expect(contentsOf(w, "tok")).toEqual(["gem1", "room"]);
  });

  test("an entry dropped onto a selected token's list goes inside", async () => {
    const w = await world();
    w.click([80, 0.5]);
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["tok"]));
    await settle();
    w.drag(rowAt(0, TOP, 1), [[40, -10], IN_LIST]);
    await until(() => contentsOf(w, "tok").includes("acard"), "acard in the token");
    expect(contentsOf(w, "tok")).toEqual(["gem1", "acard"]);
    expect(contentsOf(w, "bnd_a")).toEqual(["tcard", "xcard"]);
  });

  const tokList = (w: World) =>
    w
      .faces()
      .faces.get("tok")
      ?.primitives.some((p) => p.kind === "contents") ?? false;

  test("dragging with Alt from the token's footprint onto its revealed list keeps the list and drops inside", async () => {
    const w = await world();
    w.fire("pointerDown", [5, 3], true);
    w.fire("pointerMove", [40, 1], true);
    expect(w.ui.getState().altHover).toBeNull();
    expect(tokList(w)).toBe(false);
    // Into the token's footprint: the list shows.
    w.fire("pointerMove", [80, 0.2], true);
    expect(w.ui.getState().altHover).toBe("tok");
    expect(tokList(w)).toBe(true);
    // Onto the revealed list, outside the footprint: it stays.
    w.fire("pointerMove", IN_LIST, true);
    expect(w.ui.getState().altHover).toBe("tok");
    expect(tokList(w)).toBe(true);
    w.fire("pointerUp", IN_LIST, true);
    await until(() => contentsOf(w, "tok").includes("goblin1"), "the goblin in the token");
    expect(contentsOf(w, "tok")).toEqual(["gem1", "goblin1"]);
    expect(w.ui.getState().altHover).toBeNull();
    // The list stays only because the dropped goblin, now inside, is selected.
    expect(w.ui.getState().selection).toEqual(["goblin1"]);
    act(() => w.ui.select([]));
    expect(tokList(w)).toBe(false);
  });

  test("releasing Alt over the revealed list ends the hover: the drop lands on the board", async () => {
    const w = await world();
    w.fire("pointerDown", [5, 3], true);
    w.fire("pointerMove", [80, 0.2], true);
    expect(w.ui.getState().altHover).toBe("tok");
    w.fire("pointerMove", IN_LIST, false);
    expect(w.ui.getState().altHover).toBeNull();
    w.fire("pointerUp", IN_LIST, false);
    const near = (pos: unknown) => {
      const items = (pos as { items?: { value: number }[] } | undefined)?.items ?? [];
      return (
        Math.abs((items[0]?.value ?? 0) - 79) < 1e-9 &&
        Math.abs((items[1]?.value ?? 0) - 1.9) < 1e-9
      );
    };
    await until(
      () => near(w.object("goblin1")?.cells.position?.content),
      "the goblin moved onto the board",
    );
    expect(w.object("goblin1")?.board).toBe(BOARD);
    expect(contentsOf(w, "tok")).toEqual(["gem1"]);
  });

  test("an entry Alt-dragged from a binder row onto an unselected token, then onto its revealed list, drops inside", async () => {
    const w = await world();
    w.fire("pointerDown", rowAt(0, TOP, 1), true);
    w.fire("pointerMove", [40, -10], true);
    expect(w.ui.getState().altHover).toBeNull();
    expect(tokList(w)).toBe(false);
    w.fire("pointerMove", [80, 0.2], true);
    expect(w.ui.getState().altHover).toBe("tok");
    expect(tokList(w)).toBe(true);
    w.fire("pointerMove", IN_LIST, true);
    expect(w.ui.getState().altHover).toBe("tok");
    w.fire("pointerUp", IN_LIST, true);
    await until(() => contentsOf(w, "tok").includes("acard"), "acard in the token");
    expect(contentsOf(w, "tok")).toEqual(["gem1", "acard"]);
    expect(contentsOf(w, "bnd_a")).toEqual(["tcard", "xcard"]);
    expect(w.ui.getState().altHover).toBeNull();
  });

  test("an entry drag's revealed list hides again when Alt is released, and the entry lands on the board", async () => {
    const w = await world();
    w.fire("pointerDown", rowAt(0, TOP, 1), true);
    w.fire("pointerMove", [80, 0.2], true);
    expect(tokList(w)).toBe(true);
    w.fire("pointerMove", IN_LIST, true);
    expect(tokList(w)).toBe(true);
    act(() => {
      fireEvent.keyUp(w.canvas, { key: "Alt", code: "AltLeft", altKey: false });
    });
    expect(w.ui.getState().altHover).toBeNull();
    expect(tokList(w)).toBe(false);
    w.fire("pointerUp", IN_LIST, false);
    await until(() => w.object("acard")?.board === BOARD, "acard on the board");
    expect(contentsOf(w, "tok")).toEqual(["gem1"]);
  });

  test("after clicking a row of a selected token's list (selecting the child), the other rows still hit", async () => {
    const w = await world();
    w.click([80, 0.5]);
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["tok"]));
    // A second entry in the token's list: a card dragged from binder A.
    w.drag(rowAt(0, TOP, 1), [[40, -10], IN_LIST]);
    await until(() => contentsOf(w, "tok").includes("acard"), "acard in the token");
    await settle();
    // Rows of 0.3 from the list top at y 0.9: gem1, then acard.
    const row = (i: number): Point => [79, 0.9 + 0.3 * i + 0.15];
    w.click(row(0));
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["gem1"]));
    await settle();
    // The token is no longer selected, but its list stays drawn and hit (gem1 is inside it).
    w.click(row(1));
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["acard"]));
  });
});
