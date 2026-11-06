/**
 * Keyboard access to face buttons and contents entries against a real
 * in-process authority (vtt-qf5.26; DESIGN.md §4.6 On the canvas):
 * `startAuthority` over an in-memory host with scripted dice, the real
 * session, `UiStore`, runtime inputs and tool context, the interaction
 * runtime with the `invoke` extension, `withFaces(withHandles(
 * createSelectTool()))`, and `BoardCanvas` with the Canvas2D renderer and
 * `drawFaceItem` over a recording context. Only the keyboard presses the
 * Roll button and expands the entry; Tab stays on the canvas.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { newTableSnapshot, type ScriptedDiceEntry, ScriptedDiceSource } from "@vtt/authority";
import type { InvokeParams, WireOp } from "@vtt/protocol";
import type { Point, Rect } from "@vtt/schema";
import {
  BoardCanvas,
  buildFaceScene,
  createCanvas2DRenderer,
  createFaceStateStore,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createRuntimeInputs,
  createSelectTool,
  createToolContext,
  createUiStore,
  defaultFacePolicy,
  drawFaceItem,
  type FaceScene,
  type FaceStateStore,
  faceCullBounds,
  HIGHLIGHT_STROKE,
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
  type ToolOverlay,
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
import { startAuthority, until, whenReady } from "../support/authority";

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

const ROLL_RECT: Rect = [-1.2, 0.5, 1.1, 0.45];

/** The Attack card of DESIGN.md §4.6, on the board, its target set. */
const SEED: WireOp[] = [
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
    id: "card",
    to: at(0, 0),
    init: {
      shape: rectShape(2, 3),
      cells: {
        name: text("Attack"),
        visible_to: ALL,
        face_up: bool(true),
        attacker: ref("aldric"),
        target: ref("goblin1"),
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
          name: "Apply",
          when: "hit and dmg != empty and not applied",
          steps: ["set(applied, true)"],
        },
      ],
      face: {
        elements: [
          { type: "value", cell: "name", rect: [-1.2, -1.7, 2.4, 0.4], style: { size: "large" } },
          { type: "editor", cell: "target", rect: [-1.2, -1.2, 2.4, 0.4] },
          { type: "value", cell: "total", rect: [-1.2, -0.7, 1.1, 0.5] },
          { type: "button", action: "Roll", rect: ROLL_RECT, show_when: "roll = empty" },
          { type: "button", action: "Apply", rect: [-1.2, 1.1, 2.4, 0.45] },
        ],
      },
    },
  },
  // A binder with two row cards, each with a Go button.
  {
    type: "create_object",
    id: "bnd",
    to: at(20, 0),
    init: {
      tag: ["binder"],
      shape: rectShape(6, 6),
      cells: { name: text("Binder"), face_up: bool(true) },
      face: { elements: [{ type: "contents", rect: [-3, -3, 6, 4.8] }] },
    },
  },
  ...["r0", "r1"].map(
    (id): WireOp => ({
      type: "create_object",
      id,
      to: into("bnd"),
      init: {
        shape: rectShape(6, 2),
        cells: { name: text(id), visible_to: ALL, face_up: bool(true), n: num(0) },
        actions: [{ name: "Go", steps: ["set(n, 1)"] }],
        face: { elements: [{ type: "button", action: "Go", rect: [-2.5, -0.5, 1.5, 0.6] }] },
      },
    }),
  ),
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
      { faceState },
    );
  }, [session, viewVersion, viewer, state.selection, previews, faceTick]);
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
      overlay={<InPlaceEditor session={session} ui={ui} camera={state.camera} scene={scene} />}
      {...handlers}
    />
  );
}

async function world(dice: ScriptedDiceEntry[] = []) {
  const authority = await startAuthority({
    snapshot: newTableSnapshot(),
    dice: new ScriptedDiceSource(dice),
  });
  cleanups.push(() => authority.cleanup());
  const gm = await authority.client("seed");
  const seeded = await gm.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));

  const session = authority.session();
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("card") === true, "the card's view");

  const ui = createUiStore({ session });
  const faceState = createFaceStateStore();
  const registry = new ToolRegistry();
  registry.register(
    withFaces(withHandles(createSelectTool()), { faceState, policy: defaultFacePolicy }),
  );
  const port = createInPlaceEditorPort(ui);
  const runtime = createInteractionRuntime({
    registry,
    inputs: createRuntimeInputs(session, ui),
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor: { open: (request) => port.open(request), close: () => port.close() },
    whenRevision: (r) => session.whenRevision(r),
    extensions: {
      effects: { [INVOKE_EXTENSION]: invokeExtension(session, sessionNotices(session)) },
    },
  });
  cleanups.push(() => runtime.dispose());

  const ctx = new RecordingContext();
  const utils = render(
    <TableProvider session={session} ui={ui}>
      <Board session={session} ui={ui} runtime={runtime} ctx={ctx} faceState={faceState} />
    </TableProvider>,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await until(() => ui.getState().viewport.width === 800, "the viewport");
  const request = vi.spyOn(session.client, "request");
  const invokes = () =>
    request.mock.calls.filter(([m]) => m === "invoke").map(([, p]) => p as InvokeParams);

  const click = (board: Point) => {
    const [x, y] = toScreen(ui.getState().camera, board, VIEWPORT);
    const base = { pointerId: 1, clientX: x, clientY: y };
    act(() => {
      fireEvent.pointerDown(canvas, { ...base, button: 0, buttons: 1 });
      fireEvent.pointerUp(canvas, { ...base, button: 0, buttons: 0 });
    });
  };
  /** The face focus ring the runtime shows, or null. */
  const ring = (): Extract<ToolOverlay, { kind: "face_focus" }> | null =>
    runtime
      .getView()
      .overlays.find(
        (o): o is Extract<ToolOverlay, { kind: "face_focus" }> => o.kind === "face_focus",
      ) ?? null;

  return { session, ui, faceState, runtime, ctx, canvas, invokes, click, ring };
}

/** The calls of the last frame drawn. */
function lastFrame(ctx: RecordingContext): RecordedCall[] {
  const calls = ctx.calls;
  let i = calls.length - 1;
  while (i >= 0 && calls[i]?.name !== "clearRect") i--;
  return calls.slice(Math.max(0, i));
}

const ringDrawn = (ctx: RecordingContext) =>
  lastFrame(ctx).some((c) => c.name === "stroke" && c.style?.strokeStyle === HIGHLIGHT_STROKE);

const texts = (ctx: RecordingContext, label: string) =>
  lastFrame(ctx).filter((c) => c.name === "fillText" && c.args[0] === label);

const sameRect = (a: Rect | undefined, b: Rect) =>
  a?.every((v, i) => Math.abs(v - (b[i] as number)) < 1e-9) === true;

// ---------------------------------------------------------------------------

describe("keyboard access to faces", () => {
  test("select the card, Tab to its Roll button, Enter: the authority runs Roll; focus stays on the canvas", async () => {
    const w = await world([roll("1d20", 12)]);
    const user = userEvent.setup();
    // A click on the card's body selects it (and focuses the canvas).
    w.click([0.95, 0.4]);
    expect(w.ui.getState().selection).toEqual(["card"]);
    expect(document.activeElement).toBe(w.canvas);

    let tabs = 0;
    while (!sameRect(w.ring()?.rect, ROLL_RECT)) {
      if (++tabs > 6) throw new Error("Tab never reached Roll");
      await user.keyboard("{Tab}");
      // The face focus took the Tab: the canvas keeps the browser focus.
      expect(document.activeElement).toBe(w.canvas);
    }
    expect(w.ring()?.object).toBe("card");
    await until(() => ringDrawn(w.ctx), "the focus ring drawn");

    await user.keyboard("{Enter}");
    await until(() => w.session.objectView("card")?.cells.roll?.value.type === "roll", "the roll");
    expect(w.invokes()).toMatchObject([{ object: "card", action: "Roll" }]);
    expect(w.invokes()).toHaveLength(1);
  });

  test("Tab to an entry's chevron and Space expands the entry; Escape clears the focus", async () => {
    const w = await world();
    const user = userEvent.setup();
    // Look at the binder (at [20, 0]) and select it.
    act(() => {
      w.ui.cameraPort().set({ x: 20, y: 0, zoom: 1 });
      w.canvas.focus();
      w.ui.select(["bnd"]);
    });
    expect(w.faceState.isExpanded("r0", "collapsed")).toBe(false);
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(w.canvas);
    expect(w.ring()?.object).toBe("bnd");

    await user.keyboard(" ");
    expect(w.faceState.isExpanded("r0", "collapsed")).toBe(true);
    await until(() => texts(w.ctx, "Go").length === 1, "r0's Go button drawn");
    expect(w.invokes()).toEqual([]);

    await user.keyboard("{Escape}");
    expect(w.ring()).toBeNull();
    // Escape cleared only the focus: the binder stays selected.
    expect(w.ui.getState().selection).toEqual(["bnd"]);
  });

  test("with nothing selected, Tab is not taken from the browser", async () => {
    const w = await world();
    const user = userEvent.setup();
    act(() => w.canvas.focus());
    await user.keyboard("{Tab}");
    expect(w.ring()).toBeNull();
    expect(document.activeElement).not.toBe(w.canvas);
  });
});
