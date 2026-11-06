/**
 * Binders, working copies and edit-template against a real in-process
 * authority (vtt-1xv.17; DESIGN.md §4.7, §4.1 spawn, §8.4 steps 9, 10, 12;
 * M5 plan Q14, Q15, Q17, review r1 finding 11, r2 findings 2, 9, r3
 * findings 3, 8): `startServer` with scripted dice, the real session,
 * `UiStore`, runtime inputs and tool context (vtt-3l6.21), the interaction
 * runtime (vtt-3l6.23) with the `invoke` extension and this bead's
 * `expand_created` continuation, `withFaces(withHandles(createSelectTool(
 * {dropOverride})), {policy: binderPolicy(…), gestures: [entryDragGesture]})`,
 * `BoardCanvas` with the Canvas2D renderer and `drawFaceItem` over a
 * recording context, the inspector's `CellList` for the selection and the
 * `EditTemplateBanner`. The session's socket can hold incoming responses,
 * so a spawn can stay pending across a board or viewer switch.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DocumentStore,
  newTableSnapshot,
  type RunningServer,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  startServer,
  TableHost,
} from "@vtt/authority";
import {
  ProtocolClient,
  type WebSocketConstructor,
  type WebSocketLike,
  type WireOp,
} from "@vtt/protocol";
import type { ObjectId, OpGroup, Point, Rect } from "@vtt/schema";
import {
  type Affine,
  apply,
  type BinderPolicy,
  BoardCanvas,
  binderPolicy,
  buildFaceScene,
  CellList,
  compose,
  contentsRect,
  createCanvas2DRenderer,
  createFaceDropOverride,
  createFaceStateStore,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createRuntimeInputs,
  createSelectTool,
  createTableSession,
  createToolContext,
  createUiStore,
  drawFaceItem,
  EditTemplateBanner,
  EXPAND_CREATED_EXTENSION,
  entryDragGesture,
  entryTransform,
  expandCreatedHandler,
  type FaceScene,
  type FaceStateStore,
  faceCullBounds,
  faceHitAt,
  ImageCache,
  INVOKE_EXTENSION,
  type InteractionRuntime,
  invokeExtension,
  pathContents,
  RecordingContext,
  sessionNotices,
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
import { WebSocket as NodeWs } from "ws";
import { JSDOM_ORIGIN, NodeWebSocket, until, whenReady } from "../support/authority";

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

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

// ---------------------------------------------------------------------------
// A session socket that can hold incoming responses

class Gate {
  /** Incoming messages for which this returns true are held, in order. */
  hold: (data: string) => boolean = () => false;
  readonly held: { data: string; deliver: () => void }[] = [];
  /** The requests sent, in order. */
  readonly requests: { id: string; method: string }[] = [];

  /** Delivers every held message, in order. */
  flush(): void {
    for (const h of this.held.splice(0)) h.deliver();
  }
}

function gatedWebSocket(gate: Gate): WebSocketConstructor {
  return class GatedSocket implements WebSocketLike {
    readonly #ws: NodeWs;
    constructor(url: string) {
      this.#ws = new NodeWs(url);
      this.#ws.on("error", () => undefined);
    }
    send(data: string): void {
      const m = JSON.parse(data) as { type?: string; id?: string; method?: string };
      if (m.type === "request" && m.id && m.method) {
        gate.requests.push({ id: m.id, method: m.method });
      }
      this.#ws.send(data);
    }
    close(code?: number, reason?: string): void {
      this.#ws.close(code, reason);
    }
    // biome-ignore lint/suspicious/noExplicitAny: matches WebSocketLike
    addEventListener(type: string, listener: (event: any) => void): void {
      if (type !== "message") {
        this.#ws.addEventListener(type as "open", listener);
        return;
      }
      this.#ws.addEventListener("message", (event) => {
        const data = String(event.data);
        if (gate.hold(data)) gate.held.push({ data, deliver: () => listener(event) });
        else listener(event);
      });
    }
  };
}

/** Whether `data` is the response to a request of `method` recorded by `gate`. */
const isResponseOf = (gate: Gate, method: string) => (data: string) => {
  try {
    const m = JSON.parse(data) as { type?: string; id?: string };
    return m.type === "response" && gate.requests.some((r) => r.id === m.id && r.method === method);
  } catch {
    return false;
  }
};

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

/** The Attack card's buttons, in its local frame (a 2.5 × 3.5 card). */
const ROLL_RECT: Rect = [-1.2, 0.5, 1.1, 0.45];
const DISCARD_RECT: Rect = [0.05, 1.1, 1.15, 0.45];
/** An empty spot of the Attack card's face. */
const CARD_EMPTY: Point = [0.7, 0.7];

/** The Attack card of DESIGN.md §4.7 (M5-D19's `tpl_attack`, trimmed), as a template in `parent`. */
const attackTemplate = (id: string, parent: string): WireOp => ({
  type: "create_object",
  id,
  to: into(parent),
  init: {
    is_template: true,
    tag: ["card", "attack"],
    shape: rectShape(2.5, 3.5),
    cells: {
      name: text("Attack"),
      visible_to: ALL,
      face_up: bool(true),
      owner: EMPTY,
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
      { name: "Discard", steps: ["remove(this)"] },
    ],
    face: {
      elements: [
        { type: "value", cell: "name", rect: [-1.2, -1.7, 2.4, 0.4], style: { size: "large" } },
        { type: "editor", cell: "target", rect: [-1.2, -1.2, 2.4, 0.4], style: { caption: true } },
        { type: "value", cell: "roll", rect: [-1.2, -0.7, 1.1, 0.5], style: { caption: true } },
        { type: "value", cell: "hit", rect: [0.1, -0.7, 1.1, 0.5], style: { caption: true } },
        { type: "button", action: "Roll", rect: ROLL_RECT, show_when: "roll = empty" },
        { type: "button", action: "Discard", rect: DISCARD_RECT },
      ],
    },
  },
});

/** A binder's contents list: 3 wide (rows 0.3 high), 4.8 tall. */
const LIST: Rect = [-1.5, -2.5, 3, 4.8];

const binder = (id: string, x: number, y: number, cells: Record<string, unknown> = {}): WireOp =>
  ({
    type: "create_object",
    id,
    to: at(x, y),
    init: {
      tag: ["binder"],
      shape: rectShape(3.4, 5.6),
      cells: { name: text(id), visible_to: ALL, face_up: bool(true), ...cells },
      face: { elements: [{ type: "contents", rect: LIST }] },
    },
  }) as WireOp;

const filler = (id: string, parent: string): WireOp => ({
  type: "create_object",
  id,
  to: into(parent),
  init: {
    shape: rectShape(2.5, 0.8),
    cells: { name: text(id), visible_to: ALL, face_up: bool(true) },
  },
});

const FILLERS = Array.from({ length: 10 }, (_, i) => `f${i}`);

const SEED: WireOp[] = [
  { type: "add_board", id: "crypt", name: "Crypt" },
  {
    type: "create_object",
    id: "goblin1",
    to: at(5, 3),
    init: {
      shape: { type: "circle", radius: 0.5 },
      cells: { name: text("Goblin"), visible_to: ALL, face_up: bool(true), ac: num(13) },
    },
  },
  {
    type: "create_object",
    id: "aldric",
    to: at(-5, 3),
    init: {
      is_character: true,
      shape: { type: "circle", radius: 0.5 },
      cells: { name: text("Aldric"), visible_to: ALL, face_up: bool(true), attack_bonus: num(5) },
    },
  },
  // The GM binder at (0, -20): ten fillers, the Attack template, a note.
  binder("bnd", 0, -20),
  ...FILLERS.map((f) => filler(f, "bnd")),
  attackTemplate("tpl_attack", "bnd"),
  filler("note", "bnd"),
  // Aldric's binder, dragged out onto the board at (10, -20); empty.
  binder("aldric_binder", 10, -20, { owner: ref("aldric") }),
  // A binder at (20, -20) whose first entry only the GM sees, then a template and a note.
  binder("pc_binder", 20, -20),
  {
    type: "create_object",
    id: "secret",
    to: into("pc_binder"),
    init: {
      shape: rectShape(2.5, 0.8),
      cells: {
        name: text("secret"),
        visible_to: { type: "viewers", viewers: ["gm"] },
        face_up: bool(true),
      },
    },
  },
  attackTemplate("tpl_pc", "pc_binder"),
  filler("note2", "pc_binder"),
  // A token template placed directly on the board.
  {
    type: "create_object",
    id: "tpl_token",
    to: at(10, -3),
    init: {
      is_template: true,
      tag: ["creature"],
      shape: { type: "circle", radius: 0.5 },
      cells: { name: text("Token"), visible_to: ALL, face_up: bool(true), ac: num(10) },
    },
  },
];

const roll = (expr: string, value: number): ScriptedDiceEntry => ({
  type: "roll",
  expr,
  dice: [value],
  dropped: [],
  total: value,
});

// ---------------------------------------------------------------------------
// Composition

function Board(props: {
  session: TableSession;
  ui: UiStore;
  runtime: InteractionRuntime;
  ctx: RecordingContext;
  faceState: FaceStateStore;
  policy: BinderPolicy;
}) {
  const { session, ui, runtime, ctx, faceState, policy } = props;
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
      { faceState },
    );
  }, [session, viewVersion, viewer, state.selection, previews, faceTick]);
  const selected = state.selection.length === 1 ? (state.selection[0] as ObjectId) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion keys the view
  const view = useMemo(
    () => (selected === null ? null : session.objectView(selected)),
    [session, selected, viewVersion],
  );
  return (
    <div>
      <EditTemplateBanner policy={policy} />
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

async function world(options: { dice?: ScriptedDiceEntry[] } = {}) {
  const dice = new ScriptedDiceSource(options.dice ?? []);
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()), { dice });
  const server: RunningServer = await startServer({ host, port: 0, allowOrigins: [JSDOM_ORIGIN] });
  cleanups.push(async () => {
    await server.close();
    await host.close().catch(() => undefined);
  });
  const gm = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: "seed", kind: "test" },
    WebSocket: NodeWebSocket,
    onWarning: () => undefined,
  });
  cleanups.push(() => gm.close());
  await gm.connect();
  const seeded = await gm.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));

  const gate = new Gate();
  const session = createTableSession({
    url: server.url,
    token: server.token,
    WebSocket: gatedWebSocket(gate),
  });
  cleanups.push(() => session.close());
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("bnd") === true, "the binder's view");

  const ui = createUiStore({ session });
  const faceState = createFaceStateStore();
  const inputs = createRuntimeInputs(session, ui);
  const policy = binderPolicy({ faceState, ui, inputs });
  cleanups.push(() => policy.dispose());
  const registry = new ToolRegistry();
  registry.register(
    withFaces(withHandles(createSelectTool({ dropOverride: createFaceDropOverride(faceState) })), {
      faceState,
      policy,
      gestures: [entryDragGesture({ faceState })],
    }),
  );
  const runtime = createInteractionRuntime({
    registry,
    inputs,
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor: createInPlaceEditorPort(ui),
    whenRevision: (r) => session.whenRevision(r),
    extensions: {
      effects: { [INVOKE_EXTENSION]: invokeExtension(session, sessionNotices(session)) },
      continuations: { [EXPAND_CREATED_EXTENSION]: expandCreatedHandler(faceState, ui, inputs) },
    },
  });
  cleanups.push(() => runtime.dispose());

  const ctx = new RecordingContext();
  const utils = render(
    <TableProvider session={session} ui={ui}>
      <Board
        session={session}
        ui={ui}
        runtime={runtime}
        ctx={ctx}
        faceState={faceState}
        policy={policy}
      />
    </TableProvider>,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await waitFor(() => expect(ui.getState().viewport.width).toBe(800));

  const store = host.table.store;
  const object = (id: ObjectId) => store.getObject(id);
  const contentsOf = (id: ObjectId): readonly ObjectId[] => object(id)?.contents ?? [];
  const groups = (): readonly OpGroup[] => store.history.groups() as readonly OpGroup[];

  const faces = (): FaceScene => {
    const view = session.boardView();
    if (view === null) throw new Error("no board view");
    return buildFaceScene(
      {
        views: view.objects.values(),
        covers: [...view.covers.values()],
        board: view.board,
        viewer: session.getSnapshot().viewer,
      },
      { faceState },
    );
  };

  const screenOf = (board: Point): Point => toScreen(ui.getState().camera, board, VIEWPORT);
  const fire = (type: "pointerDown" | "pointerMove" | "pointerUp", board: Point) => {
    const [x, y] = screenOf(board);
    act(() => {
      fireEvent[type](canvas, {
        pointerId: 1,
        clientX: x,
        clientY: y,
        button: type === "pointerMove" ? -1 : 0,
        buttons: type === "pointerUp" ? 0 : 1,
      });
    });
  };
  const drag = (from: Point, via: Point[]) => {
    fire("pointerDown", from);
    for (const p of via) fire("pointerMove", p);
    fire("pointerUp", via[via.length - 1] ?? from);
  };
  const click = (p: Point) => drag(p, []);
  const key = (k: string) => {
    act(() => {
      fireEvent.keyDown(canvas, { key: k, code: k });
    });
  };

  return {
    host,
    dice,
    gm,
    gate,
    session,
    ui,
    faceState,
    policy,
    runtime,
    canvas,
    object,
    contentsOf,
    groups,
    faces,
    fire,
    drag,
    click,
    key,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Lets pending writes and renders settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];

/** The list of board object `container` (its contents element 0) as drawn now. */
function listOf(w: World, container: ObjectId) {
  const scene = w.faces();
  const list = pathContents(scene, [{ container, element: 0 }])[0];
  if (list === undefined) throw new Error(`${container} has no list`);
  return { scene, list, toBoard: scene.transforms.get(container) as Affine };
}

/** The board point of `id`'s chevron in board object `container`'s list (asserted hittable). */
function chevronOf(w: World, container: ObjectId, id: ObjectId): Point {
  const { scene, list, toBoard } = listOf(w, container);
  const e = list.entries.find((x) => x.id === id);
  if (e === undefined) throw new Error(`${id} is not in ${container}`);
  const p = apply(toBoard, centre(contentsRect(list, e.chevron)));
  expect(faceHitAt(scene, p, w.ui.getState().camera)?.target).toEqual({ type: "chevron", id });
  return p;
}

/** The board point of `id`'s gear in board object `container`'s list. */
function gearOf(w: World, container: ObjectId, id: ObjectId): Point {
  const { scene, list, toBoard } = listOf(w, container);
  const e = list.entries.find((x) => x.id === id);
  if (e?.gear === undefined) throw new Error(`${id} has no gear`);
  const p = apply(toBoard, centre(contentsRect(list, e.gear)));
  expect(faceHitAt(scene, p, w.ui.getState().camera)?.target).toEqual({ type: "gear", id });
  return p;
}

/** A point on the collapsed row of `id`, left of its middle (no chevron or gear). */
function rowOf(w: World, container: ObjectId, id: ObjectId): Point {
  const { list, toBoard } = listOf(w, container);
  const e = list.entries.find((x) => x.id === id);
  if (e === undefined) throw new Error(`${id} is not in ${container}`);
  const r = contentsRect(list, e.row);
  return apply(toBoard, [r[0] + r[2] * 0.4, r[1] + r[3] / 2]);
}

/** The board point of local point `local` of expanded entry `id` of `container`'s list. */
function onEntry(w: World, container: ObjectId, id: ObjectId, local: Point): Point {
  const { list, toBoard } = listOf(w, container);
  const e = list.entries.find((x) => x.id === id);
  if (e === undefined || !e.expanded) throw new Error(`${id} is not expanded in ${container}`);
  return apply(compose(toBoard, entryTransform(list, e)), local);
}

/** Whether `id`'s row is drawn entirely inside `container`'s list rect. */
function wholeRowShown(w: World, container: ObjectId, id: ObjectId): boolean {
  const { list } = listOf(w, container);
  const e = list.entries.find((x) => x.id === id);
  if (e === undefined) return false;
  const top = e.row[1] - list.offset;
  return top >= -1e-9 && top + e.row[3] <= list.rect[3] + 1e-9;
}

const copiesOf = (w: World, container: ObjectId, template: ObjectId): ObjectId[] =>
  w.contentsOf(container).filter((id) => {
    const t = w.object(id)?.cells.template?.content;
    return t?.type === "ref" && t.object === template && w.object(id)?.is_template === false;
  });

/**
 * Waits until the gate holds the spawn's transact response, then stops
 * holding. The authority commits the copy before its response reaches the
 * session's socket; releasing the gate as soon as the copy exists lets a
 * response still in flight through, so the continuation would select and
 * expand the copy before the switch (vtt-qf5.60).
 */
async function heldSpawn(w: World) {
  const isTransact = isResponseOf(w.gate, "transact");
  await until(() => w.gate.held.some((h) => isTransact(h.data)), "the held spawn response");
  w.gate.hold = () => false;
}

const expanded = (w: World, id: ObjectId) => w.faceState.isExpanded(id, "collapsed");

const banner = () => screen.queryByRole("status", { name: "Editing template" });

/** Expands `template` in `container` by its chevron and waits for the working copy. */
async function expandTemplate(w: World, container: ObjectId, template: ObjectId) {
  const before = new Set(copiesOf(w, container, template));
  w.click(chevronOf(w, container, template));
  await until(
    () => copiesOf(w, container, template).some((id) => !before.has(id)),
    "the working copy",
  );
  const copy = copiesOf(w, container, template).find((id) => !before.has(id)) as ObjectId;
  await waitFor(() => expect(w.ui.getState().selection).toEqual([copy]));
  await until(() => w.session.objectView(copy) !== null, "the copy's view");
  return copy;
}

// ---------------------------------------------------------------------------

describe("working copies", () => {
  test("expanding a template entry spawns one working copy right after it, selected, expanded and scrolled into view; the template stays collapsed", async () => {
    const w = await world();
    const before = w.groups().length;
    const copy = await expandTemplate(w, "bnd", "tpl_attack");
    expect(copy).toMatch(/^tpl_attack_\d+$/);
    expect(w.contentsOf("bnd")).toEqual([...FILLERS, "tpl_attack", copy, "note"]);
    expect(w.object(copy)?.is_template).toBe(false);
    await settle();
    expect(w.groups().length).toBe(before + 1);
    expect(expanded(w, copy)).toBe(true);
    expect(expanded(w, "tpl_attack")).toBe(false);
    // The expanded copy is taller than what was below the fold: scrolled so all of it shows.
    await waitFor(() => expect(wholeRowShown(w, "bnd", copy)).toBe(true));
    expect(w.faceState.scrollOffset("bnd", 0)).toBeGreaterThan(0);
  });

  test("expanding again selects and expands that copy instead of spawning", async () => {
    const w = await world();
    const copy = await expandTemplate(w, "bnd", "tpl_attack");
    await settle();
    act(() => {
      w.faceState.collapse(copy);
      w.faceState.setScroll("bnd", 0, 0);
      w.ui.select([]);
    });
    const before = w.groups().length;
    w.click(chevronOf(w, "bnd", "tpl_attack"));
    await waitFor(() => expect(w.ui.getState().selection).toEqual([copy]));
    expect(expanded(w, copy)).toBe(true);
    expect(expanded(w, "tpl_attack")).toBe(false);
    expect(wholeRowShown(w, "bnd", copy)).toBe(true);
    await settle();
    expect(w.groups().length).toBe(before);
    expect(copiesOf(w, "bnd", "tpl_attack")).toEqual([copy]);
  });

  test("with two working copies (the second spawned by protocol) the first in contents order is chosen", async () => {
    const w = await world();
    const first = await expandTemplate(w, "bnd", "tpl_attack");
    const spawned = await w.gm.transact(
      [{ type: "spawn", template: "tpl_attack", to: { ...into("bnd"), index: 11 }, as: "$c" }],
      { label: "Spawn" },
    );
    if (spawned.status !== "committed") throw new Error(JSON.stringify(spawned));
    const second = spawned.bindings.$c as ObjectId;
    await until(() => w.session.objectView(second) !== null, "the second copy's view");
    expect(w.contentsOf("bnd")).toEqual([...FILLERS, "tpl_attack", second, first, "note"]);
    act(() => {
      w.faceState.collapse(first);
      w.faceState.setScroll("bnd", 0, 0);
      w.ui.select([]);
    });
    await settle();
    const before = w.groups().length;
    w.click(chevronOf(w, "bnd", "tpl_attack"));
    await waitFor(() => expect(w.ui.getState().selection).toEqual([second]));
    expect(expanded(w, second)).toBe(true);
    expect(expanded(w, first)).toBe(false);
    await settle();
    expect(w.groups().length).toBe(before);
  });

  test("Roll on the working copy leaves the template's cells unchanged", async () => {
    const w = await world({ dice: [roll("1d20", 12)] });
    const template = JSON.stringify(w.object("tpl_attack")?.cells);
    const copy = await expandTemplate(w, "bnd", "tpl_attack");
    const set = await w.gm.transact([
      { type: "set_value", object: copy, cell: "target", value: ref("goblin1") },
    ]);
    if (set.status !== "committed") throw new Error(JSON.stringify(set));
    await until(
      () =>
        w.session.objectView(copy)?.action_states?.find((s) => s.name === "Roll")?.enabled === true,
      "Roll enabled on the copy",
    );
    await waitFor(() => expect(wholeRowShown(w, "bnd", copy)).toBe(true));
    const button = onEntry(w, "bnd", copy, centre(ROLL_RECT));
    expect(faceHitAt(w.faces(), button, w.ui.getState().camera)).toMatchObject({
      object: copy,
      target: { type: "button", action: "Roll" },
    });
    w.click(button);
    await until(() => w.object(copy)?.cells.roll?.content.type === "roll", "the copy's roll");
    expect(w.object(copy)?.cells.roll?.content).toMatchObject({ type: "roll", total: 12 });
    expect(JSON.stringify(w.object("tpl_attack")?.cells)).toBe(template);
  });

  test("a board switch while the spawn is pending still creates the copy but neither selects nor expands it", async () => {
    const w = await world();
    w.gate.hold = isResponseOf(w.gate, "transact");
    w.click(chevronOf(w, "bnd", "tpl_attack"));
    await until(() => copiesOf(w, "bnd", "tpl_attack").length === 1, "the copy");
    const [copy] = copiesOf(w, "bnd", "tpl_attack") as [ObjectId];
    await heldSpawn(w);
    await act(async () => {
      await w.ui.setActiveBoard("crypt");
    });
    await until(() => w.session.getSnapshot().activeBoard === "crypt", "the Crypt board");
    act(() => w.gate.flush());
    await w.session.whenRevision(w.host.revision);
    await settle();
    expect(w.contentsOf("bnd")).toEqual([...FILLERS, "tpl_attack", copy, "note"]);
    expect(w.ui.getState().selection).not.toContain(copy);
    expect(expanded(w, copy)).toBe(false);
  });

  test("a viewer switch while the spawn is pending still creates the copy but neither selects nor expands it", async () => {
    const w = await world();
    w.gate.hold = isResponseOf(w.gate, "transact");
    w.click(chevronOf(w, "bnd", "tpl_attack"));
    await until(() => copiesOf(w, "bnd", "tpl_attack").length === 1, "the copy");
    const [copy] = copiesOf(w, "bnd", "tpl_attack") as [ObjectId];
    await heldSpawn(w);
    await act(async () => {
      await w.ui.setViewer({ type: "character", id: "aldric" });
    });
    await until(() => w.session.getSnapshot().viewer.type === "character", "the Aldric view");
    act(() => w.gate.flush());
    await w.session.whenRevision(w.host.revision);
    await settle();
    expect(w.contentsOf("bnd")).toEqual([...FILLERS, "tpl_attack", copy, "note"]);
    expect(w.ui.getState().selection).not.toContain(copy);
    expect(expanded(w, copy)).toBe(false);
  });

  test("in a character view with a hidden entry before the template, the copy lands right after the template", async () => {
    const w = await world();
    await act(async () => {
      await w.ui.setViewer({ type: "character", id: "aldric" });
    });
    await until(() => w.session.getSnapshot().viewer.type === "character", "the Aldric view");
    await until(() => {
      const items = w.session.objectView("pc_binder")?.cells.contents?.value;
      return items?.type === "list" && items.items[0]?.type !== "ref";
    }, "the redacted first entry");
    await until(() => w.session.objectView("tpl_pc") !== null, "the template's view");
    w.click(chevronOf(w, "pc_binder", "tpl_pc"));
    await until(() => copiesOf(w, "pc_binder", "tpl_pc").length === 1, "the copy");
    const [copy] = copiesOf(w, "pc_binder", "tpl_pc") as [ObjectId];
    expect(w.contentsOf("pc_binder")).toEqual(["secret", "tpl_pc", copy, "note2"]);
  });

  test("dragging the working copy out of the binder moves it onto the board", async () => {
    const w = await world();
    const copy = await expandTemplate(w, "bnd", "tpl_attack");
    await waitFor(() => expect(wholeRowShown(w, "bnd", copy)).toBe(true));
    const from = onEntry(w, "bnd", copy, CARD_EMPTY);
    expect(faceHitAt(w.faces(), from, w.ui.getState().camera)).toMatchObject({
      object: copy,
      target: { type: "body" },
    });
    const ids = new Set(w.host.table.store.objectIds());
    w.drag(from, [
      [-6, -12],
      [-8, -10],
    ]);
    await until(() => w.object(copy)?.board === BOARD, "the copy on the board");
    expect(w.object(copy)?.cells.position?.content).toEqual({
      type: "list",
      items: [num(-8), num(-10)],
    });
    expect(w.contentsOf("bnd")).toEqual([...FILLERS, "tpl_attack", "note"]);
    expect(new Set(w.host.table.store.objectIds())).toEqual(ids);
  });
});

describe("edit-template", () => {
  test("the gear on a template entry selects the template and shows the banner until the selection changes", async () => {
    const w = await world();
    expect(banner()).toBeNull();
    const before = w.groups().length;
    w.click(gearOf(w, "bnd", "tpl_attack"));
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["tpl_attack"]));
    await waitFor(() =>
      expect(banner()?.textContent).toBe(
        "Editing template Attack: changes apply to copies made from now on",
      ),
    );
    expect(w.policy.editing()).toBe("tpl_attack");
    expect(expanded(w, "tpl_attack")).toBe(false);
    await settle();
    expect(w.groups().length).toBe(before);
    act(() => w.ui.select(["goblin1"]));
    await waitFor(() => expect(banner()).toBeNull());
    expect(w.policy.editing()).toBeNull();
  });

  test("a template token on the board: its gear selects it with the banner, an inspector edit writes the template, and a copy dragged from it carries the edit", async () => {
    const w = await world();
    // The board gear sits at the top-right corner of the token's frame.
    const gear: Point = [10 + 0.5 + 0.15, -3 - 0.5 - 0.15];
    expect(faceHitAt(w.faces(), gear, w.ui.getState().camera)?.target).toEqual({
      type: "gear",
      id: "tpl_token",
    });
    w.click(gear);
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["tpl_token"]));
    await waitFor(() =>
      expect(banner()?.textContent).toBe(
        "Editing template Token: changes apply to copies made from now on",
      ),
    );

    const user = userEvent.setup();
    const inspector = screen.getByRole("region", { name: "inspector" });
    const row = [...inspector.querySelectorAll<HTMLElement>("[data-cell]")].find(
      (el) => el.getAttribute("data-cell") === "ac",
    );
    if (row === undefined) throw new Error("no ac row");
    const value = row.querySelector<HTMLElement>('[data-part="value"]');
    if (value === null) throw new Error("no ac value");
    await user.dblClick(value);
    const input = within(row).getByRole("textbox", { name: "Value of ac" });
    await user.clear(input);
    await user.type(input, "15{Enter}");
    await until(
      () => JSON.stringify(w.object("tpl_token")?.cells.ac?.content) === JSON.stringify(num(15)),
      "the template's ac",
    );
    expect(w.policy.editing()).toBe("tpl_token");
    await until(() => {
      const ac = w.session.objectView("tpl_token")?.cells.ac?.value;
      return ac?.type === "number" && ac.value === 15;
    }, "the template's view");

    w.drag(
      [10, -3],
      [
        [12, -2],
        [14, 0],
      ],
    );
    await until(
      () => w.host.table.store.objectIds().some((id) => id.startsWith("tpl_token_")),
      "the copy",
    );
    const copy = w.host.table.store.objectIds().find((id) => id.startsWith("tpl_token_"));
    if (copy === undefined) throw new Error("no copy");
    expect(w.object(copy)?.is_template).toBe(false);
    expect(w.object(copy)?.cells.ac?.content).toEqual(num(15));
    expect(w.object("tpl_token")?.board).toBe(BOARD);
  });
});

describe("giving a template", () => {
  test("a template entry dropped on a character's binder arrives as a template; there expanding spawns a working copy, discarding it (Discard, then Delete) keeps the template, and expanding again spawns a new copy", async () => {
    const w = await world();
    w.drag(rowOf(w, "bnd", "tpl_attack"), [
      [5, -15],
      [10, -20],
    ]);
    await until(() => w.contentsOf("aldric_binder").length === 1, "the given template");
    const [given] = w.contentsOf("aldric_binder") as [ObjectId];
    expect(given).toMatch(/^tpl_attack_\d+$/);
    expect(w.object(given)?.is_template).toBe(true);
    expect(w.contentsOf("bnd")).toEqual([...FILLERS, "tpl_attack", "note"]);
    await until(() => w.session.objectView(given) !== null, "the given template's view");
    act(() => w.ui.select([]));

    // Expanding it there spawns a working copy right after it.
    const copy1 = await expandTemplate(w, "aldric_binder", given);
    expect(w.contentsOf("aldric_binder")).toEqual([given, copy1]);
    expect(expanded(w, copy1)).toBe(true);

    // Its Discard button removes the copy; the received template stays.
    await waitFor(() => expect(wholeRowShown(w, "aldric_binder", copy1)).toBe(true));
    const discard = onEntry(w, "aldric_binder", copy1, centre(DISCARD_RECT));
    expect(faceHitAt(w.faces(), discard, w.ui.getState().camera)).toMatchObject({
      object: copy1,
      target: { type: "button", action: "Discard" },
    });
    w.click(discard);
    await until(() => w.object(copy1) === undefined, "copy1 discarded");
    expect(w.contentsOf("aldric_binder")).toEqual([given]);
    expect(w.object(given)?.is_template).toBe(true);
    await until(() => w.session.objectView(copy1) === null, "copy1's view gone");

    // Expanding again spawns a new working copy; Delete discards it too.
    const copy2 = await expandTemplate(w, "aldric_binder", given);
    expect(copy2).not.toBe(copy1);
    expect(w.contentsOf("aldric_binder")).toEqual([given, copy2]);
    w.key("Delete");
    await until(() => w.object(copy2) === undefined, "copy2 deleted");
    expect(w.contentsOf("aldric_binder")).toEqual([given]);
    expect(w.object(given)?.is_template).toBe(true);
    await until(() => w.session.objectView(copy2) === null, "copy2's view gone");

    const copy3 = await expandTemplate(w, "aldric_binder", given);
    expect([copy1, copy2]).not.toContain(copy3);
    expect(w.contentsOf("aldric_binder")).toEqual([given, copy3]);
  });
});
