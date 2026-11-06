/**
 * Face buttons, inline editing, the default action and contents scrolling
 * against a real in-process authority (vtt-1xv.16; DESIGN.md §4.5, §4.6,
 * §7 Undo; PROTOCOL.md §4 `invoke`, §6): `startServer` over an in-memory
 * host with scripted dice, the real session, `UiStore`, runtime inputs,
 * tool context (vtt-3l6.21), the interaction runtime with the `invoke`
 * extension (vtt-3l6.23), `withFaces(withHandles(createSelectTool()))`,
 * `BoardCanvas` with the Canvas2D renderer and `drawFaceItem` (vtt-1xv.15)
 * over a recording context, the real `InPlaceEditor` and the inspector's
 * `CellList`. The session's socket can hold incoming messages, so a press
 * can be sent from a view that predates another client's commit.
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
  type InvokeParams,
  ProtocolClient,
  type WebSocketConstructor,
  type WebSocketLike,
  type WireOp,
  type WireResult,
} from "@vtt/protocol";
import type { ObjectId, OpGroup, Point, Rect } from "@vtt/schema";
import {
  type Affine,
  apply,
  BoardCanvas,
  buildFaceScene,
  CellList,
  compose,
  contentsRect,
  createCanvas2DRenderer,
  createFaceStateStore,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createRuntimeInputs,
  createSelectTool,
  createTableSession,
  createToolContext,
  createUiStore,
  DISABLED_ALPHA,
  defaultFacePolicy,
  drawFaceItem,
  type EditorOpenRequest,
  entryTransform,
  type FaceDrawing,
  type FaceGesture,
  type FaceScene,
  type FaceStateStore,
  faceCullBounds,
  faceHitAt,
  ImageCache,
  INVOKE_EXTENSION,
  InPlaceEditor,
  type InteractionRuntime,
  invokeExtension,
  type RecordedCall,
  RecordingContext,
  sessionNotices,
  TableProvider,
  type TableSession,
  TEMPLATE_REFUSAL,
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
const GM = { type: "gm" } as const;
const ALDRIC = { type: "character", id: "aldric" } as const;

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
// A session socket that can hold incoming messages

class Gate {
  /** Incoming messages for which this returns true are held, in order. */
  hold: (data: string) => boolean = () => false;
  readonly held: { data: string; deliver: () => void }[] = [];
  /** Ids of the `invoke` requests sent. */
  readonly invokes: string[] = [];

  /** Delivers the held messages `pred` selects (default: all), in order. */
  flush(pred: (data: string) => boolean = () => true): void {
    const out = this.held.filter((h) => pred(h.data));
    for (const h of out) this.held.splice(this.held.indexOf(h), 1);
    for (const h of out) h.deliver();
  }
}

const isResponseTo = (id: string) => (data: string) => {
  try {
    const m = JSON.parse(data) as { type?: string; id?: string };
    return m.type === "response" && m.id === id;
  } catch {
    return false;
  }
};

function gatedWebSocket(gate: Gate): WebSocketConstructor {
  return class GatedSocket implements WebSocketLike {
    readonly #ws: NodeWs;
    constructor(url: string) {
      this.#ws = new NodeWs(url);
      this.#ws.on("error", () => undefined);
    }
    send(data: string): void {
      const m = JSON.parse(data) as { type?: string; id?: string; method?: string };
      if (m.type === "request" && m.method === "invoke" && m.id) gate.invokes.push(m.id);
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

const APPLY_WHEN = "hit and dmg != empty and not applied";

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
      {
        name: "Roll damage",
        when: "hit and dmg = empty",
        steps: ["roll(attacker.damage_dice) -> dmg"],
      },
      {
        name: "Apply",
        when: APPLY_WHEN,
        steps: ["add(target.damage_taken, dmg)", "set(applied, true)"],
      },
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
        {
          type: "button",
          action: "Roll damage",
          rect: [0.1, 0.5, 1.1, 0.45],
          show_when: "hit and dmg = empty",
        },
        {
          type: "button",
          action: "Apply",
          rect: [-1.2, 1.1, 2.4, 0.45],
          show_when: "not applied",
        },
      ],
      default_action: "Roll",
    },
  },
};

const die = (id: string, x: number, template: boolean): WireOp => ({
  type: "create_object",
  id,
  to: at(x, -3),
  init: {
    is_template: template,
    shape: rectShape(1, 1),
    cells: { name: text(id), visible_to: ALL, face_up: bool(true), total: EMPTY },
    actions: [{ name: "Roll", steps: ["roll(1d20) -> total"] }],
    face: {
      elements: [{ type: "value", cell: "total", rect: [-0.4, -0.4, 0.8, 0.4] }],
      default_action: "Roll",
    },
  },
});

/**
 * A d20 drawn as the examples draw it (M6-D9): `total` large over the centre,
 * the Roll button below it, and (for these tests) a `modifier` editor above
 * it; `when` guards its Roll.
 */
const facedDie = (id: string, x: number, when?: string): WireOp => ({
  type: "create_object",
  id,
  to: at(x, -3),
  init: {
    shape: rectShape(1.2, 1.4),
    cells: {
      name: text(id),
      visible_to: ALL,
      face_up: bool(true),
      value: EMPTY,
      modifier: num(0),
      total: formula("value + modifier"),
    },
    actions: [
      { name: "Roll", ...(when === undefined ? {} : { when }), steps: ["roll(1d20) -> value"] },
    ],
    face: {
      elements: [
        { type: "editor", cell: "modifier", rect: [-0.4, -0.65, 0.8, 0.2] },
        { type: "value", cell: "total", rect: [-0.4, -0.4, 0.8, 0.5], style: { size: "large" } },
        { type: "button", action: "Roll", rect: [-0.4, 0.18, 0.8, 0.25] },
      ],
      default_action: "Roll",
    },
  },
});

/** A 6 × 2 card with a Go button (expanded in a 6-wide list: 1.8 high). */
const rowCard = (id: string, container: string): WireOp => ({
  type: "create_object",
  id,
  to: into(container),
  init: {
    shape: rectShape(6, 2),
    cells: { name: text(id), visible_to: ALL, face_up: bool(true), n: num(0) },
    actions: [{ name: "Go", steps: ["set(n, 1)"] }],
    face: { elements: [{ type: "button", action: "Go", rect: [-2.5, -0.5, 1.5, 0.6] }] },
  },
});

const plainEntry = (id: string, container: string, w = 6, h = 2): WireOp => ({
  type: "create_object",
  id,
  to: into(container),
  init: { shape: rectShape(w, h), cells: { name: text(id), face_up: bool(true) } },
});

const binderWith = (id: string, x: number, y: number, list: Rect, h: number): WireOp => ({
  type: "create_object",
  id,
  to: at(x, y),
  init: {
    tag: ["binder"],
    shape: rectShape(6, h),
    cells: { name: text(id), face_up: bool(true) },
    face: { elements: [{ type: "contents", rect: list }] },
  },
});

const SEED: WireOp[] = [
  { type: "add_board", id: "b2", name: "Two" },
  {
    type: "create_object",
    id: "aldric",
    to: at(-5, 3),
    init: {
      is_character: true,
      shape: { type: "circle", radius: 0.5 },
      cells: {
        name: text("Aldric"),
        visible_to: ALL,
        face_up: bool(true),
        attack_bonus: num(5),
        damage_dice: { type: "dice", expr: "1d8+3" },
      },
    },
  },
  {
    type: "create_object",
    id: "goblin1",
    to: at(5, 3),
    init: {
      shape: { type: "circle", radius: 0.5 },
      cells: {
        name: text("Goblin"),
        visible_to: ALL,
        face_up: bool(true),
        ac: num(13),
        damage_taken: num(0),
      },
    },
  },
  ATTACK_CARD,
  die("d20", -4, false),
  die("tpl_d20", 4, true),
  facedDie("fd20", -8),
  facedDie("stuck_d20", -12, "modifier > 5"),
  {
    type: "create_object",
    id: "note",
    to: at(-16, -3),
    init: {
      shape: rectShape(1, 1),
      cells: { name: text("note"), visible_to: ALL, face_up: bool(true), hp: num(7) },
      face: { elements: [{ type: "value", cell: "hp", rect: [-0.4, -0.2, 0.8, 0.4] }] },
    },
  },
  // A binder with the default face: 14 entries in an 8-row list, the last a card.
  {
    type: "create_object",
    id: "bnd",
    to: at(0, -20),
    init: { tag: ["binder"], shape: rectShape(6, 1), cells: { name: text("Binder") } },
  },
  ...Array.from({ length: 13 }, (_, i) => plainEntry(`e${i}`, "bnd")),
  rowCard("last", "bnd"),
  // Two deep: `outer`'s tall list holds `inner`, whose 5-row list holds f0..f9.
  binderWith("outer", 30, -20, [-3, -6, 6, 10], 12),
  binderWith("inner", 0, 0, [-3, -2, 6, 3], 4),
  { type: "move", object: "inner", to: into("outer") },
  ...Array.from({ length: 9 }, (_, i) => plainEntry(`f${i}`, "inner")),
  rowCard("f9", "inner"),
  // A sheet taller than its parent's list.
  binderWith("sbinder", 60, -20, [-3, -3, 6, 4.8], 6),
  ...Array.from({ length: 4 }, (_, i) => plainEntry(`s${i}`, "sbinder")),
  plainEntry("sheet", "sbinder", 2, 6),
];

const roll = (expr: string, value: number): ScriptedDiceEntry => ({
  type: "roll",
  expr,
  dice: [value],
  dropped: [],
  total: expr === "1d8+3" ? value + 3 : value,
});

// ---------------------------------------------------------------------------
// Composition

function Board(props: {
  session: TableSession;
  ui: UiStore;
  runtime: InteractionRuntime;
  ctx: RecordingContext;
  faceState: FaceStateStore;
  card: ObjectId;
}) {
  const { session, ui, runtime, ctx, faceState, card } = props;
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
  const cardView = session.objectView(card);
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
        overlay={<InPlaceEditor session={session} ui={ui} camera={state.camera} scene={scene} />}
        {...handlers}
      />
      <section aria-label="inspector">
        {cardView === null ? null : (
          <CellList
            object={card}
            view={cardView}
            session={session}
            readOnly={viewer.type !== "gm"}
          />
        )}
      </section>
    </div>
  );
}

interface Options {
  dice?: ScriptedDiceEntry[];
  gestures?: FaceGesture<unknown>[];
}

async function world(options: Options = {}) {
  const dice = new ScriptedDiceSource(options.dice ?? []);
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()), { dice });
  const server: RunningServer = await startServer({ host, port: 0, allowOrigins: [JSDOM_ORIGIN] });
  cleanups.push(async () => {
    await server.close();
    await host.close().catch(() => undefined);
  });
  const client = async (name: string) => {
    const c = new ProtocolClient({
      url: server.url,
      token: server.token,
      client: { name, kind: "test" },
      WebSocket: NodeWebSocket,
      onWarning: () => undefined,
    });
    cleanups.push(() => c.close());
    await c.connect();
    return c;
  };
  const gm = await client("seed");
  const seeded = await gm.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));
  const spawned = await gm.transact(
    [
      {
        type: "spawn",
        template: "attack_card",
        to: at(0, 0),
        cells: { attacker: ref("aldric") },
        as: "$card",
      },
    ],
    { label: "Spawn" },
  );
  if (spawned.status !== "committed") throw new Error(JSON.stringify(spawned));
  const card = spawned.bindings.$card as ObjectId;
  const other = await client("other");

  const gate = new Gate();
  const session = createTableSession({
    url: server.url,
    token: server.token,
    WebSocket: gatedWebSocket(gate),
  });
  cleanups.push(() => session.close());
  await whenReady(session);
  await until(() => session.boardView()?.objects.has(card) === true, "the card's view");

  const ui = createUiStore({ session });
  const faceState = createFaceStateStore();
  const registry = new ToolRegistry();
  registry.register(
    withFaces(withHandles(createSelectTool()), {
      faceState,
      policy: defaultFacePolicy,
      ...(options.gestures ? { gestures: options.gestures } : {}),
    }),
  );
  const port = createInPlaceEditorPort(ui);
  /** Every request the runtime made of the in-place editor. */
  const opens: EditorOpenRequest[] = [];
  const runtime = createInteractionRuntime({
    registry,
    inputs: createRuntimeInputs(session, ui),
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor: {
      open(request) {
        opens.push(request);
        port.open(request);
      },
      close: () => port.close(),
    },
    whenRevision: (r) => session.whenRevision(r),
    extensions: {
      effects: { [INVOKE_EXTENSION]: invokeExtension(session, sessionNotices(session)) },
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
        card={card}
      />
    </TableProvider>,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await waitFor(() => expect(ui.getState().viewport.width).toBe(800));
  const request = vi.spyOn(session.client, "request");

  const cell = (id: ObjectId, name: string): WireResult | undefined =>
    session.objectView(id)?.cells[name]?.value;
  const stored = (id: ObjectId, name: string) =>
    host.table.store.getObject(id)?.cells[name]?.content;
  const invokes = () =>
    request.mock.calls.filter(([m]) => m === "invoke").map(([, p]) => p as InvokeParams);
  const groups = (): readonly OpGroup[] => host.table.store.history.groups() as readonly OpGroup[];
  const notices = () =>
    sessionNotices(session)
      .list()
      .map((n) => n.text);

  /** The scene the runtime sees, with faces, for locating targets. */
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
  const pointer = (type: "pointerDown" | "pointerUp", board: Point) => {
    const [x, y] = screenOf(board);
    act(() => {
      fireEvent[type](canvas, {
        pointerId: 1,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === "pointerDown" ? 1 : 0,
      });
    });
  };
  const click = (board: Point) => {
    pointer("pointerDown", board);
    pointer("pointerUp", board);
  };
  const dblClick = (board: Point) => {
    click(board);
    click(board);
    const [x, y] = screenOf(board);
    act(() => {
      fireEvent.doubleClick(canvas, { clientX: x, clientY: y });
    });
  };
  const wheel = (board: Point, deltaY: number, ctrlKey = false) => {
    const [x, y] = screenOf(board);
    act(() => {
      fireEvent.wheel(canvas, { clientX: x, clientY: y, deltaY, deltaMode: 0, ctrlKey });
    });
  };

  return {
    host,
    dice,
    gm,
    other,
    gate,
    session,
    ui,
    faceState,
    runtime,
    ctx,
    canvas,
    card,
    cell,
    stored,
    invokes,
    groups,
    notices,
    faces,
    click,
    dblClick,
    wheel,
    opens,
  };
}

type World = Awaited<ReturnType<typeof world>>;

// ---------------------------------------------------------------------------
// Locating targets and reading frames

interface Located {
  toBoard: Affine;
  drawing: FaceDrawing | null;
  chevron?: Point;
}

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];

/** Every faced object of `scene`, board and contained, with its frame → board and chevron. */
function locate(scene: FaceScene): Map<ObjectId, Located> {
  const out = new Map<ObjectId, Located>();
  const walk = (drawing: FaceDrawing, toBoard: Affine) => {
    for (const p of drawing.primitives) {
      if (p.kind !== "contents") continue;
      for (const e of p.entries) {
        if (e.id === null) continue;
        const t = compose(toBoard, entryTransform(p, e));
        out.set(e.id, {
          toBoard: t,
          drawing: e.drawing,
          chevron: apply(toBoard, centre(contentsRect(p, e.chevron))),
        });
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

function located(w: World, id: ObjectId): Located {
  const l = locate(w.faces()).get(id);
  if (l === undefined) throw new Error(`${id} is not drawn`);
  return l;
}

function chevronOf(w: World, id: ObjectId): Point {
  const p = located(w, id).chevron;
  if (p === undefined) throw new Error(`${id} has no chevron`);
  expect(faceHitAt(w.faces(), p, w.ui.getState().camera)?.target).toEqual({
    type: "chevron",
    id,
  });
  return p;
}

function buttonOf(w: World, id: ObjectId, action: string): Point {
  const l = located(w, id);
  const b = l.drawing?.primitives.find((p) => p.kind === "button" && p.action === action);
  if (b === undefined) throw new Error(`${id} has no ${action} button`);
  const p = apply(l.toBoard, centre(b.rect));
  expect(faceHitAt(w.faces(), p, w.ui.getState().camera)).toMatchObject({
    object: id,
    target: { type: "button", action },
  });
  return p;
}

/** The calls of the last frame drawn. */
function lastFrame(ctx: RecordingContext): RecordedCall[] {
  const calls = ctx.calls;
  let i = calls.length - 1;
  while (i >= 0 && calls[i]?.name !== "clearRect") i--;
  return calls.slice(Math.max(0, i));
}

/** The `fillText` calls of the last frame whose text is `label`. */
const texts = (ctx: RecordingContext, label: string) =>
  lastFrame(ctx).filter((c) => c.name === "fillText" && c.args[0] === label);

/** Lets pending writes and renders settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

// The Attack card at [0, 0] (local rects of DESIGN.md §4.6).
const ROLL: Point = centre([-1.2, 0.5, 1.1, 0.45]);
const ROLL_DAMAGE: Point = centre([0.1, 0.5, 1.1, 0.45]);
const APPLY: Point = centre([-1.2, 1.1, 2.4, 0.45]);
const TARGET: Point = centre([-1.2, -1.2, 2.4, 0.4]);

/** Sets `target` to the goblin through the inspector's cell row. */
async function targetThroughInspector(w: World) {
  const user = userEvent.setup();
  const inspector = screen.getByRole("region", { name: "inspector" });
  const row = [...inspector.querySelectorAll<HTMLElement>("[data-cell]")].find(
    (el) => el.getAttribute("data-cell") === "target",
  );
  if (row === undefined) throw new Error("no target row");
  const value = row.querySelector<HTMLElement>('[data-part="value"]');
  if (value === null) throw new Error("no target value");
  await user.dblClick(value);
  const input = within(row).getByRole("textbox", { name: "Value of target" });
  await user.clear(input);
  await user.type(input, "@goblin1{Enter}");
  await until(() => w.cell(w.card, "target")?.type === "ref", "the target");
}

// ---------------------------------------------------------------------------

describe("the Attack card's buttons", () => {
  test("Roll, Roll damage and Apply through the face; Apply is drawn disabled until it may run", async () => {
    const w = await world({ dice: [roll("1d20", 12), roll("1d8+3", 5)] });
    await targetThroughInspector(w);

    // Before the rolls: Apply is drawn (show_when "not applied") but disabled (its guard).
    await until(() => texts(w.ctx, "Roll")[0]?.style?.globalAlpha === 1, "Roll drawn enabled");
    expect(texts(w.ctx, "Apply")).toHaveLength(1);
    expect(texts(w.ctx, "Apply")[0]?.style?.globalAlpha).toBeCloseTo(DISABLED_ALPHA, 9);
    const r0 = w.host.revision;
    w.click(APPLY);
    await until(() => w.notices().length > 0, "the reason");
    expect(w.notices()).toEqual([`Apply: its condition is false (when: ${APPLY_WHEN}).`]);
    expect(w.invokes()).toEqual([]);
    expect(w.host.revision).toBe(r0);

    // Roll: one invoke with the revision the press began on; the face updates.
    w.click(ROLL);
    await until(() => w.cell(w.card, "roll")?.type === "roll", "the roll");
    expect(w.invokes()).toMatchObject([
      {
        object: w.card,
        action: "Roll",
        base_revision: r0,
        table: { board: BOARD, position: [0, 0] },
      },
    ]);
    expect(w.invokes()[0]?.actor).toBeUndefined();
    await until(() => texts(w.ctx, "total: 17").length === 1, "total drawn");
    expect(texts(w.ctx, "Roll")).toEqual([]);

    // Roll damage, then Apply is enabled.
    w.click(ROLL_DAMAGE);
    await until(() => w.cell(w.card, "dmg")?.type === "roll", "the damage");
    await until(() => texts(w.ctx, "Apply")[0]?.style?.globalAlpha === 1, "Apply enabled");
    const damageGroup = w.groups().at(-1) as OpGroup;
    expect(damageGroup.label).toBe("Roll damage");
    w.click(APPLY);
    await until(
      () => JSON.stringify(w.cell(w.card, "applied")) === JSON.stringify(bool(true)),
      "applied",
    );
    const applyGroup = w.groups().at(-1) as OpGroup;
    expect(applyGroup).toMatchObject({ kind: "action", label: "Apply", actor: GM });
    const touched = applyGroup.effects
      .filter((e) => e.type === "cell")
      .map((e) => `${e.object}.${e.cell}`)
      .sort();
    expect(touched).toEqual([`${w.card}.applied`, "goblin1.damage_taken"].sort());
    expect(damageGroup.effects.some((e) => e.type === "cell" && e.cell === "dmg")).toBe(true);
    expect(w.stored("goblin1", "damage_taken")).toEqual(num(8));
    // After it, Apply is no longer drawn.
    await until(() => texts(w.ctx, "Apply").length === 0, "Apply hidden");
    expect(w.invokes()).toHaveLength(3);
    expect(w.notices()).toHaveLength(1);
  });

  test("a press on an Apply drawn enabled from a view that predates another client's Apply is refused with a notice", async () => {
    const w = await world({ dice: [roll("1d20", 12), roll("1d8+3", 5)] });
    const base = () => w.host.revision;
    await w.gm.transact(
      [{ type: "set_value", object: w.card, cell: "target", value: ref("goblin1") }],
      { base_revision: base() },
    );
    await w.gm.invoke({ object: w.card, action: "Roll", base_revision: base() });
    await w.gm.invoke({ object: w.card, action: "Roll damage", base_revision: base() });
    await until(
      () =>
        w.session
          .objectView(w.card)
          ?.action_states?.some((s) => s.name === "Apply" && s.enabled) === true,
      "Apply enabled in the view",
    );
    await until(() => texts(w.ctx, "Apply")[0]?.style?.globalAlpha === 1, "Apply drawn enabled");
    // Hold the session's incoming messages: the other client's Apply commits unseen.
    w.gate.hold = () => true;
    const theirs = await w.other.invoke({ object: w.card, action: "Apply", base_revision: base() });
    expect(theirs.status).toBe("committed");
    const after = base();
    w.click(APPLY);
    expect(w.invokes()).toHaveLength(1);
    await until(
      () => w.gate.held.some((h) => isResponseTo(w.gate.invokes[0] ?? "")(h.data)),
      "our response",
    );
    w.gate.hold = () => false;
    w.gate.flush();
    await until(() => w.notices().length > 0, "the notice");
    // The press began on the revision before the other Apply, which touched the card:
    // PROTOCOL.md §6 checks `obj:<card>` before the guard, so it is `stale_write`.
    expect(w.notices()).toEqual(['Not applied: the table changed first ("Apply" by the GM).']);
    expect(w.host.revision).toBe(after);
    expect(w.stored("goblin1", "damage_taken")).toEqual(num(8));
  });

  test("clicking target's editor element opens the in-place editor at the element's rect", async () => {
    const w = await world();
    w.click(TARGET);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Edit target" })).toBeDefined());
    const el = document.querySelector<HTMLElement>('[data-part="in-place-editor"]');
    if (el === null) throw new Error("no editor frame");
    // [-1.2, -1.2, 2.4, 0.4] at the origin, 64 px per unit, centred in 800 × 600.
    expect(Number.parseFloat(el.style.left)).toBeCloseTo(400 - 1.2 * 64, 6);
    expect(Number.parseFloat(el.style.top)).toBeCloseTo(300 - 1.2 * 64, 6);
    expect(Number.parseFloat(el.style.width)).toBeCloseTo(2.4 * 64, 6);
    expect(Number.parseFloat(el.style.height)).toBeCloseTo(0.4 * 64, 6);
  });

  test("in view-as Aldric a press records actor Aldric in the log group", async () => {
    const w = await world({ dice: [roll("1d20", 12)] });
    await w.gm.transact(
      [{ type: "set_value", object: w.card, cell: "target", value: ref("goblin1") }],
      { base_revision: w.host.revision },
    );
    await act(() => w.session.setView(BOARD, ALDRIC));
    await until(
      () =>
        w.session.objectView(w.card)?.action_states?.some((s) => s.name === "Roll" && s.enabled) ===
        true,
      "Roll enabled for Aldric",
    );
    w.click(ROLL);
    await until(() => w.groups().at(-1)?.label === "Roll", "the Roll group");
    expect(w.groups().at(-1)?.actor).toEqual(ALDRIC);
    expect(w.invokes()[0]?.actor).toEqual(ALDRIC);
  });

  test("a board switch during a pending invoke still shows the result notice and keeps the selection", async () => {
    const w = await world({ dice: [roll("1d20", 12), roll("1d8+3", 5)] });
    const base = () => w.host.revision;
    await w.gm.transact(
      [{ type: "set_value", object: w.card, cell: "target", value: ref("goblin1") }],
      { base_revision: base() },
    );
    await w.gm.invoke({ object: w.card, action: "Roll", base_revision: base() });
    await w.gm.invoke({ object: w.card, action: "Roll damage", base_revision: base() });
    await until(() => texts(w.ctx, "Apply")[0]?.style?.globalAlpha === 1, "Apply drawn enabled");
    act(() => w.ui.select([w.card]));
    w.gate.hold = () => true;
    await w.other.invoke({ object: w.card, action: "Apply", base_revision: base() });
    w.click(APPLY);
    const id = w.gate.invokes[0] ?? "";
    await until(() => w.gate.held.some((h) => isResponseTo(id)(h.data)), "our response");
    // Deliver everything but our response; keep holding it while the board switches.
    w.gate.hold = isResponseTo(id);
    w.gate.flush((d) => !isResponseTo(id)(d));
    await act(() => w.session.setView("b2", GM));
    await until(() => w.session.getSnapshot().activeBoard === "b2", "the board switch");
    expect(w.notices()).toEqual([]);
    w.gate.flush();
    await until(() => w.notices().length > 0, "the result notice");
    expect(w.notices()[0]).toMatch(/^Not applied: the table changed first/);
    await settle();
    expect(w.ui.getState().selection).toEqual([w.card]);
    expect(w.ui.getState().tool.id).toBe("select");
  });
});

describe("the default action", () => {
  test("double-clicking a d20 rolls it; double-clicking a d20 template refuses and sends nothing", async () => {
    const w = await world({ dice: [roll("1d20", 15)] });
    w.dblClick([-4, -2.7]);
    await until(() => w.cell("d20", "total")?.type === "roll", "the d20's roll");
    expect(w.invokes()).toMatchObject([{ object: "d20", action: "Roll" }]);
    expect(w.dice.remaining()).toBe(0);

    const r = w.host.revision;
    w.dblClick([4, -2.7]);
    await until(() => w.notices().length > 0, "the template notice");
    expect(w.notices()).toEqual([TEMPLATE_REFUSAL]);
    await settle();
    expect(w.invokes()).toHaveLength(1);
    expect(w.host.revision).toBe(r);
    expect(w.stored("tpl_d20", "total")).toEqual(EMPTY);
  });
});

describe("double-click by element kind (M6-D9)", () => {
  // The faced d20 `fd20` at [-8, -3] and the stuck one at [-12, -3] (local rects above).
  const onDie = (x: number, r: Rect): Point => [x + r[0] + r[2] / 2, -3 + r[1] + r[3] / 2];
  const TOTAL_R: Rect = [-0.4, -0.4, 0.8, 0.5];
  const D20_TOTAL = onDie(-8, TOTAL_R);
  const D20_ROLL = onDie(-8, [-0.4, 0.18, 0.8, 0.25]);
  const D20_MODIFIER = onDie(-8, [-0.4, -0.65, 0.8, 0.2]);
  const D20_BODY: Point = [-8 + 0.5, -3 + 0.6];

  test("the GM double-clicks the d20's total: one Roll invoke, no editor opened", async () => {
    const w = await world({ dice: [roll("1d20", 15)] });
    expect(faceHitAt(w.faces(), D20_TOTAL, w.ui.getState().camera)?.target).toEqual({
      type: "value",
      cell: "total",
    });
    w.dblClick(D20_TOTAL);
    await until(() => w.cell("fd20", "value")?.type === "roll", "the roll");
    await settle();
    expect(w.invokes()).toMatchObject([{ object: "fd20", action: "Roll" }]);
    expect(w.invokes()).toHaveLength(1);
    expect(w.opens).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "Edit total" })).toBeNull();
  });

  test("a character viewer double-clicks the d20's total: one Roll invoke as that character", async () => {
    const w = await world({ dice: [roll("1d20", 15)] });
    await act(() => w.session.setView(BOARD, ALDRIC));
    await until(
      () =>
        w.session.objectView("fd20")?.action_states?.some((s) => s.name === "Roll" && s.enabled) ===
        true,
      "Roll enabled for Aldric",
    );
    w.dblClick(D20_TOTAL);
    await until(() => w.groups().at(-1)?.label === "Roll", "the Roll group");
    await settle();
    expect(w.invokes()).toMatchObject([{ object: "fd20", action: "Roll", actor: ALDRIC }]);
    expect(w.invokes()).toHaveLength(1);
    expect(w.opens).toEqual([]);
  });

  test("the GM double-clicks the d20's body: one invoke", async () => {
    const w = await world({ dice: [roll("1d20", 15)] });
    w.dblClick(D20_BODY);
    await until(() => w.cell("fd20", "value")?.type === "roll", "the roll");
    await settle();
    expect(w.invokes()).toHaveLength(1);
    expect(w.opens).toEqual([]);
  });

  test("the GM double-clicks a value element of an object without a default action: the editor opens once", async () => {
    const w = await world();
    w.dblClick([-16, -3]);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Edit hp" })).toBeDefined());
    await settle();
    expect(w.opens).toMatchObject([{ object: "note", cell: "hp" }]);
    expect(w.opens).toHaveLength(1);
    expect(w.invokes()).toEqual([]);
  });

  test("the GM double-clicks the d20's editor element: its editor opens and nothing is invoked", async () => {
    const w = await world({ dice: [roll("1d20", 15)] });
    w.dblClick(D20_MODIFIER);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit modifier" })).toBeDefined(),
    );
    await settle();
    expect(w.invokes()).toEqual([]);
    expect(w.opens.length).toBeGreaterThan(0);
    expect(w.opens.every((o) => o.object === "fd20" && o.cell === "modifier")).toBe(true);
    expect(w.dice.remaining()).toBe(1);
  });

  test("the GM double-clicks the d20's Roll button: exactly two invokes, one per click", async () => {
    const w = await world({ dice: [roll("1d20", 15), roll("1d20", 4)] });
    w.dblClick(D20_ROLL);
    await until(() => w.cell("fd20", "value")?.type === "roll", "the roll");
    await settle();
    expect(w.invokes()).toMatchObject([
      { object: "fd20", action: "Roll" },
      { object: "fd20", action: "Roll" },
    ]);
    expect(w.invokes()).toHaveLength(2);
    expect(w.opens).toEqual([]);
  });

  test("the GM double-clicks the total of a d20 whose Roll has a false when: it is edited in place", async () => {
    const w = await world({ dice: [roll("1d20", 15)] });
    w.dblClick(onDie(-12, TOTAL_R));
    await until(() => w.opens.length > 0, "the editor request");
    await settle();
    expect(w.opens).toMatchObject([{ object: "stuck_d20", cell: "total" }]);
    expect(w.opens).toHaveLength(1);
    expect(w.invokes()).toEqual([]);
    expect(w.notices()).toEqual([]);
  });
});

describe("contents: the wheel and chevrons", () => {
  test("14 entries in an 8-row list: the wheel scrolls it, the last entry expands into view, and its button presses", async () => {
    const w = await world();
    const zoom = w.ui.getState().camera.zoom;
    // The default face's list sits below the 6 × 1 frame: [-3, 0.65, 6, 4.8] at [0, -20].
    const list: Point = [0, -20 + 0.65 + 2];
    w.wheel(list, 1000);
    expect(w.ui.getState().camera.zoom).toBe(zoom);
    expect(w.faceState.scrollOffset("bnd", -1)).toBeCloseTo(14 * 0.6 - 4.8, 9);
    const chevron = chevronOf(w, "last");
    w.click(chevron);
    expect(w.faceState.isExpanded("last", "collapsed")).toBe(true);
    // Expanded, `last` is 1.8 high and ends the list at 13 × 0.6 + 1.8: shown whole at the end.
    expect(w.faceState.scrollOffset("bnd", -1)).toBeCloseTo(13 * 0.6 + 1.8 - 4.8, 9);
    const go = buttonOf(w, "last", "Go");
    w.click(go);
    await until(
      () =>
        w.stored("last", "n")?.type === "number" &&
        (w.stored("last", "n") as { value: number }).value === 1,
      "Go",
    );
    expect(w.invokes()).toMatchObject([{ object: "last", action: "Go" }]);
    // The wheel over that button scrolls the enclosing list.
    w.wheel(go, -100);
    expect(w.faceState.scrollOffset("bnd", -1)).toBeCloseTo(13 * 0.6 + 1.8 - 4.8 - 1, 9);
    expect(w.ui.getState().camera.zoom).toBe(zoom);
    // Ctrl+wheel elsewhere zooms (a plain wheel pans, M6-D11).
    w.wheel([200, 200], 100, true);
    expect(w.ui.getState().camera.zoom).toBeLessThan(zoom);
  });

  test("two containers deep, expanding a row scrolls the inner list to reveal it", async () => {
    const w = await world();
    w.click(chevronOf(w, "inner"));
    expect(w.faceState.isExpanded("inner", "collapsed")).toBe(true);
    // The wheel over the inner list scrolls it (the innermost list that overflows).
    const innerList = located(w, "f0").chevron as Point;
    w.wheel(innerList, 1000);
    expect(w.faceState.scrollOffset("inner", 0)).toBeCloseTo(10 * 0.6 - 3, 9);
    expect(w.faceState.scrollOffset("outer", 0)).toBe(0);
    w.click(chevronOf(w, "f9"));
    expect(w.faceState.isExpanded("f9", "collapsed")).toBe(true);
    expect(w.faceState.scrollOffset("inner", 0)).toBeCloseTo(9 * 0.6 + 1.8 - 3, 9);
    expect(w.faceState.scrollOffset("outer", 0)).toBe(0);
    buttonOf(w, "f9", "Go");
  });

  test("expanding a sheet taller than its parent's list aligns its top", async () => {
    const w = await world();
    w.click(chevronOf(w, "sheet"));
    expect(w.faceState.isExpanded("sheet", "collapsed")).toBe(true);
    expect(w.faceState.scrollOffset("sbinder", 0)).toBeCloseTo(4 * 0.6, 9);
  });

  test("a gesture registered through options.gestures that claims an entry receives the pointer sequence; the select tool does not", async () => {
    const log: string[] = [];
    const gesture: FaceGesture<ObjectId> = {
      id: "entries",
      start: (hit, event) => {
        if (hit.target.type !== "entry") return null;
        log.push(`${event.type} ${hit.target.id}`);
        return hit.target.id;
      },
      reduce: (state, event) => {
        log.push(event.type);
        return { state: event.type === "pointer_up" ? null : state, effects: [] };
      },
      cancel: () => [],
      overlays: () => [],
    };
    const w = await world({ gestures: [gesture as FaceGesture<unknown>] });
    const row = located(w, "e2").chevron as Point;
    const onRow: Point = [row[0] + 2, row[1]];
    w.click(onRow);
    expect(log).toEqual(["pointer_down e2", "pointer_up"]);
    expect(w.ui.getState().selection).toEqual([]);
    // The binder's frame is still the select tool's.
    w.click([0, -20]);
    expect(w.ui.getState().selection).toEqual(["bnd"]);
    expect(log).toHaveLength(2);
  });
});
