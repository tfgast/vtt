/**
 * The UI fixture driver (vtt-1xv.24; M5 plan Q11, Q16, Q21; review r1
 * finding 13, r2 finding 12, r3 finding 4; FIXTURES.md §1–§9; FORMULAS.md
 * §10): runs one scenario through the real composed `<App>` in jsdom against
 * an in-process authority over `documentFromSetup` with the scenario's
 * `ScriptedDiceSource`, drawn by the app's face renderer into a
 * `RecordingContext`.
 *
 * The driver never chooses a path: every step comes with its row of the
 * bead's fixed matrix (`MatrixRow`), and a row that does not fit the step
 * (another actor, a path the step type cannot take, a board other than the
 * navigation rule gives) is a `MatrixMismatch`. Paths:
 *
 * - `click`: view as the step's actor (the toolbar's "View as"), make active
 *   the board of the object's outermost container (the board tabs), expand
 *   the default-face contents entries down to the object (their chevrons;
 *   never a template entry), scroll its button into its lists (the wheel),
 *   assert with `faceHitAt` that the button is drawn and enabled there, and
 *   click it.
 * - `suppressed`: the same navigation; the button is not drawn, or drawn
 *   disabled and a press sends nothing (no `invoke` request, the authority's
 *   revision unchanged); then the `invoke` goes through the app's own
 *   `session.client` with the step's actor and the predicted refusal is
 *   checked.
 * - `drag`: as the GM on the destination board, a canvas drag of the object
 *   (pressed on its body) or, when it starts contained, an entry drag out
 *   of its container's contents list; pointer points sit on whole pixels so
 *   the landing anchor is exactly the step's.
 * - `edit`: as the GM on the target's outermost board, the target selected
 *   by a click (its body on the board, or its row: the entry click), then
 *   its inspector value cell double-clicked and the value typed with Enter;
 *   `clear_override` focuses the row and presses the formula bar's Clear.
 * - `log`: the Log tab's Undo on the newest group that is neither undone nor
 *   an undo.
 * - `protocol`: the app's own `session.client` (same connection).
 *
 * Every UI step must commit exactly one group. Expectations: `action` reads
 * `action_states` of the GM's object view (never button visibility);
 * `face_element` reads the face drawn for its viewer (the app's face scene;
 * an element not drawn is asserted absent); everything else goes through
 * `get_objects`, `log`, `explain_group` and `document` with the
 * expectation's viewer. The rejection protocol and the leftover-dice check
 * are the runners' (FIXTURES §5, §6).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  canonicalJson,
  DocumentStore,
  diffStoredState,
  type RunningServer,
  replay,
  ScenarioError,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  startServer,
  storedStateEqual,
  TableHost,
} from "@vtt/authority";
import { documentFromSetup, fixtureValueEquals } from "@vtt/authority/test-runner";
import type {
  Expectation,
  Destination as FixtureDestination,
  Value as FixtureValue,
  LogEffect,
  RejectionReason,
  Scenario,
  Step,
} from "@vtt/fixtures";
import { equals } from "@vtt/formula";
import type {
  CellStateView,
  Destination,
  EffectView,
  GroupView,
  InputCellContent,
  InvokeResult,
  ObjectView,
  ProtocolRejection,
  TransactParams,
  TransactResult,
  Viewer,
  WireOp,
} from "@vtt/protocol";
import {
  type BoardId,
  isValue,
  type ObjectId,
  type OpGroup,
  type Point,
  type Rect,
  type Rejection,
  type Result,
  type Snapshot,
  toFixtureReason,
  type Value,
} from "@vtt/schema";
import {
  type Affine,
  App,
  apply,
  boardLabel,
  buildFaceScene,
  type Camera,
  CONTENTS_ROW_RATIO,
  type ContentsPrimitive,
  compose,
  contentsRect,
  createAppRenderer,
  createFaceStateStore,
  createTableSession,
  createUiStore,
  dropTargetAt,
  entryTransform,
  FACE_WHEEL_PX_PER_UNIT,
  type FaceDrawing,
  type FaceEntry,
  type FaceHit,
  type FacePrimitive,
  type FaceScene,
  type FaceStateStore,
  faceHitAt,
  hitsAt,
  invert,
  pathContents,
  RecordingContext,
  sessionNotices,
  type TableSession,
  toScreen,
  type UiStore,
  valueToInputText,
} from "@vtt/ui";
import { createElement } from "react";
import { type MockInstance, vi } from "vitest";
import { JSDOM_ORIGIN, NodeWebSocket, until, whenReady } from "../support/authority";

// ---------------------------------------------------------------------------
// The matrix

/** A path of the bead's matrix. */
export type UiPath =
  | "click"
  | "suppressed"
  | "drag"
  | "edit"
  | "edit (formula bar Clear)"
  | "log"
  | "protocol";

/** One step's row of the fixed matrix: who acts, by which path, on which board (null: protocol). */
export interface MatrixRow {
  step: number;
  /** The step's actor; null for a `bind` step. */
  actor: string | null;
  path: UiPath;
  board: BoardId | null;
}

/** A row that does not fit its step: the bead is defective (the driver never chooses paths). */
export class MatrixMismatch extends Error {}

/** An expectation that does not hold, or a UI path that did not do what it should. */
export class UiScenarioFailure extends Error {}

export interface UiRunReport {
  title: string;
  complete: boolean;
  stepsRun: number;
  stepsTotal: number;
  /** Dice script entries left at the end (a complete run with any left fails). */
  leftoverDice: number;
  /** Expectations checked (setup and steps, `rejected` included). */
  expectationsChecked: number;
  /** The path taken per step, as the driver recorded it. */
  paths: MatrixRow[];
}

const PATHS_BY_STEP: Record<Step["do"]["type"], readonly UiPath[]> = {
  invoke: ["click", "suppressed", "protocol"],
  move: ["drag", "protocol"],
  set: ["edit", "protocol"],
  override: ["edit", "protocol"],
  clear_override: ["edit (formula bar Clear)", "protocol"],
  undo: ["log", "protocol"],
  spawn: ["protocol"],
  bind: ["protocol"],
};

// ---------------------------------------------------------------------------
// The world

/** The viewport the app is measured at (every element's bounding rect). */
export const VIEWPORT = { width: 800, height: 600 };
/** Pixels kept free at the viewport's edges when a camera is chosen for a gesture. */
const EDGE_PX = 40;
/** How long a UI step may take to commit. */
const COMMIT_MS = 8000;

interface World {
  readonly scenario: Scenario;
  readonly host: TableHost;
  readonly dice: ScriptedDiceSource;
  readonly server: RunningServer;
  readonly session: TableSession;
  readonly ui: UiStore;
  readonly faceState: FaceStateStore;
  readonly ctx: RecordingContext;
  readonly canvas: HTMLCanvasElement;
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly request: MockInstance;
  /** Committed groups so far. */
  commits(): number;
  readonly bindings: Map<string, ObjectId>;
  readonly names: ReadonlySet<string>;
  /** The `document` snapshot right after setup, for `replay`. */
  setup: Snapshot;
  close(): Promise<void>;
}

const settle = (ms = 40) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function openWorld(scenario: Scenario): Promise<World> {
  const dice = new ScriptedDiceSource(scenario.dice as ScriptedDiceEntry[]);
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(documentFromSetup(scenario.setup)), {
    dice,
  });
  let commits = 0;
  const offCommit = host.table.onCommit(() => {
    commits++;
  });
  const server = await startServer({ host, port: 0, allowOrigins: [JSDOM_ORIGIN] });
  const session = createTableSession({
    url: server.url,
    token: server.token,
    WebSocket: NodeWebSocket,
  });
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    right: VIEWPORT.width,
    bottom: VIEWPORT.height,
    toJSON: () => ({}),
  });
  const request = vi.spyOn(session.client, "request");
  const ui = createUiStore({ session });
  const faceState = createFaceStateStore();
  const ctx = new RecordingContext();
  const utils = render(
    createElement(App, {
      session,
      ui,
      faceState,
      createRenderer: (_canvas, { requestRedraw }) =>
        createAppRenderer(ctx, { resolve: (p) => p, requestRedraw }),
    }),
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    utils.unmount();
    session.close();
    request.mockRestore();
    rect.mockRestore();
    offCommit();
    await server.close();
    await host.close().catch(() => undefined);
  };
  try {
    await whenReady(session);
    await until(() => utils.container.querySelector("canvas") !== null, "the canvas");
    const canvas = utils.container.querySelector("canvas") as HTMLCanvasElement;
    const doc = await session.client.request("document", {});
    return {
      scenario,
      host,
      dice,
      server,
      session,
      ui,
      faceState,
      ctx,
      canvas,
      user: userEvent.setup({ delay: null }),
      request,
      commits: () => commits,
      bindings: new Map(),
      names: new Set([
        ...scenario.setup.boards.map((b) => b.id),
        ...scenario.setup.objects.map((o) => o.id),
      ]),
      setup: structuredClone(doc.snapshot),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Names and views

function resolveName(w: World, name: string): ObjectId {
  const bound = w.bindings.get(name);
  if (bound !== undefined) return bound;
  if (w.names.has(name)) return name;
  throw new ScenarioError(`unknown object or binding "${name}"`);
}

function resolveValue(w: World, v: FixtureValue): Value {
  if (!isValue(v)) throw new ScenarioError(`not a value: ${JSON.stringify(v)}`);
  const walk = (x: Value): Value => {
    switch (x.type) {
      case "ref":
        return { type: "ref", object: resolveName(w, x.object) };
      case "list":
        return { type: "list", items: x.items.map(walk) };
      case "viewers":
        return {
          type: "viewers",
          viewers: x.viewers.map((e) =>
            typeof e === "string" ? e : { type: "ref", object: resolveName(w, e.object) },
          ),
        };
      default:
        return x;
    }
  };
  return walk(structuredClone(v));
}

const toViewer = (w: World, name: string): Viewer =>
  name === "gm" ? { type: "gm" } : { type: "character", id: resolveName(w, name) };

const viewerKeyOf = (w: World, name: string): string =>
  name === "gm" ? "gm" : `character:${resolveName(w, name)}`;

async function viewOf(w: World, id: ObjectId, viewer?: Viewer): Promise<ObjectView | undefined> {
  const result = await w.session.client.request("get_objects", {
    ids: [id],
    ...(viewer === undefined ? {} : { viewer }),
  });
  return result.objects.find((o) => o.id === id);
}

async function liveObject(w: World, name: string): Promise<{ id: ObjectId; view: ObjectView }> {
  const id = resolveName(w, name);
  const view = await viewOf(w, id);
  if (view !== undefined) return { id, view };
  throw new ScenarioError(`"${name}" has been removed or is a board`);
}

function cellValue(view: ObjectView, cell: string): Result {
  if (cell === "id") return { type: "text", value: view.id };
  const held = view.cells[cell];
  if (held !== undefined) return held.value as Result;
  return { type: "error", code: "#NAME", message: `no cell ${cell} on ${view.id}` };
}

const refIds = (v: Result): ObjectId[] =>
  v.type === "list" ? v.items.flatMap((x) => (x.type === "ref" ? [x.object] : [])) : [];

const refOf = (v: Result | undefined): ObjectId | null => (v?.type === "ref" ? v.object : null);

/** The containers of `id` (GM views), outermost first, and the board the outermost one is on. */
async function containment(w: World, id: ObjectId): Promise<{ chain: ObjectId[]; board: BoardId }> {
  const chain: ObjectId[] = [];
  let at = id;
  for (let i = 0; i < 64; i++) {
    const view = await viewOf(w, at);
    if (view === undefined) throw new ScenarioError(`"${at}" does not exist`);
    const container = refOf(cellValue(view, "container"));
    if (container === null) {
      const board = refOf(cellValue(view, "board"));
      if (board === null) throw new ScenarioError(`"${at}" is neither contained nor on a board`);
      return { chain: chain.reverse(), board };
    }
    chain.push(container);
    at = container;
  }
  throw new ScenarioError(`the containment of "${id}" is too deep`);
}

/** The position of a board object (GM view). */
async function anchorOf(w: World, id: ObjectId): Promise<Point> {
  const view = await viewOf(w, id);
  const p = view === undefined ? undefined : cellValue(view, "position");
  if (
    p?.type !== "list" ||
    p.items.length !== 2 ||
    p.items[0]?.type !== "number" ||
    p.items[1]?.type !== "number"
  ) {
    throw new ScenarioError(`"${id}" has no numeric position`);
  }
  return [p.items[0].value, p.items[1].value];
}

// ---------------------------------------------------------------------------
// Navigation and the canvas

/** Makes `board` active with the board tabs and waits for its view (and the first-visit fit). */
async function onBoard(w: World, board: BoardId): Promise<void> {
  if (w.session.getSnapshot().activeBoard !== board) {
    const view = w.session.getSnapshot().boards.find((b) => b.id === board);
    if (view === undefined) throw new ScenarioError(`no board "${board}"`);
    const tabs = screen.getByRole("tablist", { name: "Boards" });
    await w.user.click(within(tabs).getByRole("tab", { name: boardLabel(view) }));
  }
  await until(
    () =>
      w.session.getSnapshot().activeBoard === board &&
      w.session.boardView()?.board === board &&
      w.ui.getState().viewport.width > 0,
    `the board ${board}`,
  );
  await settle(60);
}

/** Views the table as `name` ("gm" or a character) with the toolbar's "View as". */
async function viewAs(w: World, name: string): Promise<void> {
  const key = viewerKeyOf(w, name);
  if (w.session.viewerKey() !== key) {
    await w.user.selectOptions(screen.getByRole("combobox", { name: "View as" }), key);
  }
  await until(
    () => w.session.viewerKey() === key && w.session.boardView() !== null,
    `the view as ${name}`,
  );
  await settle(60);
}

async function navigate(w: World, viewer: string, board: BoardId): Promise<void> {
  await viewAs(w, viewer);
  await onBoard(w, board);
}

/** The face scene the app draws now (its board view, viewer and face state). */
function faces(w: World): FaceScene {
  const view = w.session.boardView();
  if (view === null) throw new Error("no board view");
  return buildFaceScene(
    {
      views: view.objects.values(),
      covers: [...view.covers.values()],
      board: view.board,
      viewer: w.session.getSnapshot().viewer,
    },
    { faceState: w.faceState },
  );
}

const camera = (w: World): Camera => w.ui.getState().camera;
const screenOf = (w: World, p: Point): Point => toScreen(camera(w), p, VIEWPORT);

function onScreen(w: World, p: Point, cam: Camera = camera(w)): boolean {
  const [x, y] = toScreen(cam, p, VIEWPORT);
  return (
    x >= EDGE_PX && y >= EDGE_PX && x <= VIEWPORT.width - EDGE_PX && y <= VIEWPORT.height - EDGE_PX
  );
}

const quarter = (x: number) => Math.round(x * 4) / 4;

/**
 * The camera a gesture over `points` works under: centred on them (on a
 * quarter unit, so quarter-unit points sit on whole pixels) at the largest
 * of zoom 1, 1/2, 1/4 that shows them all.
 */
function cameraFor(points: readonly Point[]): Camera {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = quarter((Math.min(...xs) + Math.max(...xs)) / 2);
  const y = quarter((Math.min(...ys) + Math.max(...ys)) / 2);
  for (const zoom of [1, 0.5, 0.25]) {
    const cam = { x, y, zoom };
    if (
      points.every((p) => {
        const [sx, sy] = toScreen(cam, p, VIEWPORT);
        return (
          sx >= EDGE_PX &&
          sy >= EDGE_PX &&
          sx <= VIEWPORT.width - EDGE_PX &&
          sy <= VIEWPORT.height - EDGE_PX
        );
      })
    ) {
      return cam;
    }
  }
  throw new Error(`no camera shows ${JSON.stringify(points)}`);
}

function setCamera(w: World, cam: Camera): void {
  act(() => w.ui.setCamera(cam));
  const now = camera(w);
  if (now.x !== cam.x || now.y !== cam.y || now.zoom !== cam.zoom) {
    throw new Error(`the camera did not take ${JSON.stringify(cam)}: ${JSON.stringify(now)}`);
  }
}

function pointer(w: World, type: "down" | "move" | "up", p: Point): void {
  const [x, y] = screenOf(w, p);
  const init = {
    pointerId: 1,
    clientX: x,
    clientY: y,
    button: type === "move" ? -1 : 0,
    buttons: type === "up" ? 0 : 1,
  };
  act(() => {
    if (type === "down") fireEvent.pointerDown(w.canvas, init);
    else if (type === "move") fireEvent.pointerMove(w.canvas, init);
    else fireEvent.pointerUp(w.canvas, init);
  });
}

function click(w: World, p: Point): void {
  pointer(w, "down", p);
  pointer(w, "up", p);
}

/** A press at `from`, two moves and a release at `to`. */
function drag(w: World, from: Point, to: Point): void {
  pointer(w, "down", from);
  pointer(w, "move", [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
  pointer(w, "move", to);
  pointer(w, "up", to);
}

function wheel(w: World, p: Point, deltaY: number): void {
  const [x, y] = screenOf(w, p);
  act(() => {
    fireEvent.wheel(w.canvas, { clientX: x, clientY: y, deltaY, deltaMode: 0 });
  });
}

/** Asserts `p` lands on a whole pixel under the current camera (so its board point is exact). */
function wholePixel(w: World, p: Point): void {
  const [x, y] = screenOf(w, p);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`${JSON.stringify(p)} is not on a whole pixel (${x}, ${y})`);
  }
}

// ---------------------------------------------------------------------------
// Locating things on the face scene

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];

function inRect(p: Point, r: Rect): boolean {
  return p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];
}

/** A contents list a drawing sits in: its container, element and the container's frame → board. */
interface Clip {
  container: ObjectId;
  element: number;
  list: ContentsPrimitive;
  toBoard: Affine;
}

interface Located {
  id: ObjectId;
  /** The drawing shown for it (full on the board or expanded, collapsed in a row), or null. */
  drawing: FaceDrawing | null;
  /** Its drawing's frame → board. */
  toBoard: Affine;
  /** The lists around it, outermost first (empty on the board). */
  clips: Clip[];
  /** Its row, when it is contained. */
  entry: { clip: Clip; entry: FaceEntry } | null;
}

/** Where `id` is drawn on `scene`: a board item, or an entry of a (nested) contents list. */
function locate(scene: FaceScene, id: ObjectId): Located | null {
  const search = (
    drawing: FaceDrawing,
    owner: ObjectId,
    toBoard: Affine,
    clips: Clip[],
  ): Located | null => {
    for (const prim of drawing.primitives) {
      if (prim.kind !== "contents") continue;
      const clip: Clip = { container: owner, element: prim.element, list: prim, toBoard };
      for (const entry of prim.entries) {
        if (entry.id === null) continue;
        const childToBoard = compose(toBoard, entryTransform(prim, entry));
        const inner = [...clips, clip];
        if (entry.id === id) {
          return {
            id,
            drawing: entry.drawing,
            toBoard: childToBoard,
            clips: inner,
            entry: { clip, entry },
          };
        }
        if (entry.drawing !== null && entry.expanded) {
          const found = search(entry.drawing, entry.id, childToBoard, inner);
          if (found !== null) return found;
        }
      }
    }
    return null;
  };
  for (const item of scene.items) {
    const toBoard = scene.transforms.get(item.id);
    if (toBoard === undefined) continue;
    const drawing = scene.faces.get(item.id) ?? null;
    if (item.id === id) return { id, drawing, toBoard, clips: [], entry: null };
    if (drawing !== null) {
      const found = search(drawing, item.id, toBoard, []);
      if (found !== null) return found;
    }
  }
  return null;
}

function mustLocate(scene: FaceScene, id: ObjectId): Located {
  const found = locate(scene, id);
  if (found === null) throw new UiScenarioFailure(`${id} is not drawn on the active board`);
  return found;
}

const insideClip = (clip: Clip, p: Point): boolean =>
  inRect(apply(invert(clip.toBoard), p), clip.list.rect);

/** The (container, element) the wheel at `p` scrolls (face-tool's `scrollAt`), or null. */
function wheelTarget(scene: FaceScene, p: Point, cam: Camera): string | null {
  const hit = faceHitAt(scene, p, cam);
  if (hit === null) return null;
  const steps = hit.path.map((s) => ({ container: s.container, element: s.element }));
  if (hit.target.type === "contents") {
    steps.push({ container: hit.target.container, element: hit.target.element });
  }
  const lists = pathContents(scene, steps);
  for (let i = lists.length - 1; i >= 0; i--) {
    const list = lists[i];
    const step = steps[i];
    if (list !== undefined && step !== undefined && list.maxOffset > 0) {
      return `${step.container}/${step.element}`;
    }
  }
  return null;
}

/**
 * Turns the wheel over clip `i`'s chevron column (at a point inside every
 * list around it, where the wheel scrolls that list) so that `target` moves
 * toward the middle of its rect; false when no such point exists.
 */
async function wheelClip(
  w: World,
  scene: FaceScene,
  clips: readonly Clip[],
  i: number,
  target: Point,
): Promise<boolean> {
  const clip = clips[i] as Clip;
  const list = clip.list;
  const q = apply(invert(clip.toBoard), target);
  const dy = q[1] - (list.rect[1] + list.rect[3] / 2);
  const column = list.rect[0] + (list.rect[2] * CONTENTS_ROW_RATIO) / 2;
  const want = `${clip.container}/${clip.element}`;
  for (const f of [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95]) {
    const at = apply(clip.toBoard, [column, list.rect[1] + list.rect[3] * f]);
    if (!clips.slice(0, i).every((c) => insideClip(c, at))) continue;
    setCamera(w, { x: at[0], y: at[1], zoom: 1 });
    if (wheelTarget(scene, at, camera(w)) !== want) continue;
    wheel(w, at, dy * FACE_WHEEL_PX_PER_UNIT);
    await settle(20);
    return true;
  }
  return false;
}

/**
 * Scrolls the lists around a point with the wheel until the point is inside
 * every one of them; returns the point. `where` re-locates the point and its
 * lists on a scene. The innermost failing list whose chevron column can be
 * reached is turned; when none can, an outer list is turned to bring the
 * innermost failing list into view.
 */
async function reveal(
  w: World,
  where: (scene: FaceScene) => { p: Point; clips: Clip[] },
): Promise<Point> {
  const trail: string[] = [];
  for (let round = 0; round < 24; round++) {
    const scene = faces(w);
    const { p, clips } = where(scene);
    const failing = clips.flatMap((c, i) => (insideClip(c, p) ? [] : [i]));
    if (failing.length === 0) return p;
    trail.push(
      failing
        .map((i) => {
          const c = clips[i] as Clip;
          const q = apply(invert(c.toBoard), p);
          return `${c.container}/${c.element} y ${q[1].toFixed(3)} in [${c.list.rect[1].toFixed(3)}, +${c.list.rect[3].toFixed(3)}] offset ${c.list.offset.toFixed(3)} of ${c.list.maxOffset.toFixed(3)}`;
        })
        .join(", "),
    );
    let turned = false;
    for (const i of [...failing].reverse()) {
      if (await wheelClip(w, scene, clips, i, p)) {
        turned = true;
        break;
      }
    }
    if (!turned) {
      // Bring the innermost failing list's rect into the lists around it.
      const k = failing.at(-1) as number;
      const inner = clips[k] as Clip;
      const c = apply(inner.toBoard, centre(inner.list.rect));
      const outer = clips.slice(0, k).findIndex((x) => !insideClip(x, c));
      if (outer === -1 || !(await wheelClip(w, scene, clips, outer, c))) {
        throw new UiScenarioFailure(`no wheel point scrolls toward the point: ${trail.join("; ")}`);
      }
    }
  }
  throw new UiScenarioFailure(`the wheel never revealed the point: ${trail.join("; ")}`);
}

/**
 * Expands the default-face entries along `path` (a board item, then the
 * objects nested in it, outermost first): the board item is not an entry,
 * every object below it is.
 */
async function expandDown(w: World, path: readonly ObjectId[]): Promise<void> {
  for (const x of path.slice(1)) {
    const loc = mustLocate(faces(w), x);
    if (loc.entry === null) throw new UiScenarioFailure(`${x} is not an entry`);
    if (loc.entry.entry.expanded) continue;
    if (loc.entry.entry.template) {
      throw new UiScenarioFailure(`${x} is a template entry; the driver never expands one`);
    }
    const p = await reveal(w, (scene) => {
      const l = mustLocate(scene, x);
      if (l.entry === null) throw new UiScenarioFailure(`${x} is not an entry`);
      const r = contentsRect(l.entry.clip.list, l.entry.entry.chevron);
      return { p: apply(l.entry.clip.toBoard, centre(r)), clips: l.clips };
    });
    setCamera(w, { x: p[0], y: p[1], zoom: 1 });
    const hit = faceHitAt(faces(w), p, camera(w));
    if (hit?.target.type !== "chevron" || hit.target.id !== x) {
      throw new UiScenarioFailure(`${x}'s chevron is not hit: ${describeHit(hit)}`);
    }
    click(w, p);
    await until(() => mustLocate(faces(w), x).entry?.entry.expanded === true, `${x} expanded`);
    await settle(20);
  }
}

const describeHit = (hit: FaceHit | null): string =>
  hit === null ? "nothing" : `${hit.object} ${JSON.stringify(hit.target)}`;

function buttonOf(drawing: FaceDrawing | null, action: string) {
  return drawing?.primitives.find(
    (p): p is Extract<FacePrimitive, { kind: "button" }> =>
      p.kind === "button" && p.action === action,
  );
}

/** A whole-pixel point of `id`'s body on the board that hits it first (face and footprint). */
function bodyPoint(
  w: World,
  scene: FaceScene,
  id: ObjectId,
  accept: (p: Point) => boolean = () => true,
): Point {
  const item = scene.items.find((i) => i.id === id);
  if (item === undefined) throw new UiScenarioFailure(`${id} is not on the active board`);
  const [ax, ay] = item.anchor;
  const b = item.bounds;
  const points: Point[] = [];
  for (let i = -32; i <= 32; i++) {
    for (let j = -32; j <= 32; j++) {
      const p: Point = [ax + i / 8, ay + j / 8];
      if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
      points.push(p);
    }
  }
  points.sort((p, q) => Math.hypot(p[0] - ax, p[1] - ay) - Math.hypot(q[0] - ax, q[1] - ay));
  const cam = camera(w);
  for (const p of points) {
    if (!onScreen(w, p)) continue;
    if (hitsAt(scene, p, cam)[0] !== id) continue;
    const hit = faceHitAt(scene, p, cam);
    if (hit?.object !== id || hit.target.type !== "body" || hit.path.length > 0) continue;
    if (accept(p)) return p;
  }
  throw new UiScenarioFailure(`no point of ${id}'s body is free to press`);
}

/** A point on `id`'s row (left of its middle: no chevron or gear), revealed in its lists. */
async function rowPoint(w: World, id: ObjectId): Promise<Point> {
  return reveal(w, (scene) => {
    const l = mustLocate(scene, id);
    if (l.entry === null) throw new UiScenarioFailure(`${id} is not an entry`);
    const { clip, entry } = l.entry;
    const r = contentsRect(clip.list, entry.row);
    const h = Math.min(r[3], clip.list.rect[2] * CONTENTS_ROW_RATIO);
    return { p: apply(clip.toBoard, [r[0] + r[2] * 0.4, r[1] + h / 2]), clips: l.clips };
  });
}

// ---------------------------------------------------------------------------
// Steps

type Outcome = { type: "committed" } | { type: "refused"; rejection: ProtocolRejection };

const outcomeOf = (r: TransactResult | InvokeResult): Outcome =>
  r.status === "committed" ? { type: "committed" } : { type: "refused", rejection: r.rejection };

/** Waits for one more committed group than `before` and the session to catch up. */
async function committed(w: World, before: number, what: string): Promise<Outcome> {
  try {
    await until(() => w.commits() > before, what, COMMIT_MS);
  } catch {
    const notices = sessionNotices(w.session)
      .list()
      .map((n) => n.text);
    throw new UiScenarioFailure(
      `${what}: nothing was committed${notices.length > 0 ? `; notices: ${JSON.stringify(notices)}` : ""}`,
    );
  }
  await settle(30);
  if (w.commits() !== before + 1) {
    throw new UiScenarioFailure(`${what}: ${w.commits() - before} groups were committed, not one`);
  }
  return { type: "committed" };
}

const invokeCount = (w: World) => w.request.mock.calls.filter(([m]) => m === "invoke").length;

type ActorParam = TransactParams["actor"];

function actorParam(w: World, actor: string | undefined): ActorParam {
  if (actor === undefined) throw new ScenarioError("the step has no actor");
  return actor === "gm" ? undefined : { type: "character", id: resolveName(w, actor) };
}

async function toDestination(w: World, to: FixtureDestination): Promise<Destination> {
  if (to.type === "board") {
    return { type: "board", board: resolveName(w, to.board), position: [...to.position] };
  }
  const { id } = await liveObject(w, to.container);
  return {
    type: "container",
    container: id,
    ...(to.index === undefined ? {} : { index: to.index }),
  };
}

function bindName(w: World, name: string, id: ObjectId): void {
  if (w.bindings.has(name) || w.names.has(name)) {
    throw new ScenarioError(`"${name}" is already bound`);
  }
  w.bindings.set(name, id);
}

function transact(w: World, actor: ActorParam, label: string, op: WireOp) {
  return w.session.client.transact([op], {
    label,
    base_revision: w.session.client.revision,
    ...(actor === undefined ? {} : { actor }),
  });
}

/** The protocol path: the step as the request it maps to, on the app's own client. */
async function protocolStep(w: World, step: Step): Promise<Outcome | { type: "bound" }> {
  const d = step.do;
  if (d.type === "bind") {
    if (step.actor !== undefined) throw new ScenarioError("a bind step has no actor");
    bindName(w, d.as, await bindTarget(w, d));
    return { type: "bound" };
  }
  const actor = actorParam(w, step.actor);
  switch (d.type) {
    case "set": {
      const { id, view } = await liveObject(w, d.object);
      if (view.cells[d.cell]?.kind === "formula") {
        throw new ScenarioError(`set on "${d.object}.${d.cell}", which holds a formula`);
      }
      const value = resolveValue(w, d.value);
      return outcomeOf(
        await transact(w, actor, `set ${d.object}.${d.cell}`, {
          type: "set_value",
          object: id,
          cell: d.cell,
          value,
        }),
      );
    }
    case "override": {
      const { id, view } = await liveObject(w, d.object);
      if (view.cells[d.cell]?.kind !== "formula") {
        throw new ScenarioError(`override on "${d.object}.${d.cell}", which holds no formula`);
      }
      const value = resolveValue(w, d.value);
      return outcomeOf(
        await transact(w, actor, `override ${d.object}.${d.cell}`, {
          type: "set_value",
          object: id,
          cell: d.cell,
          value,
        }),
      );
    }
    case "clear_override": {
      const { id, view } = await liveObject(w, d.object);
      if (view.cells[d.cell]?.overridden !== true) {
        throw new ScenarioError(`clear_override on "${d.object}.${d.cell}", which has none`);
      }
      return outcomeOf(
        await transact(w, actor, `clear override ${d.object}.${d.cell}`, {
          type: "clear_override",
          object: id,
          cell: d.cell,
        }),
      );
    }
    case "move": {
      const { id } = await liveObject(w, d.object);
      const to = await toDestination(w, d.to);
      return outcomeOf(
        await transact(w, actor, `move ${d.object}`, { type: "move", object: id, to }),
      );
    }
    case "spawn": {
      const { id: template } = await liveObject(w, d.template);
      const to = await toDestination(w, d.to);
      const cells: Record<string, InputCellContent> = {};
      for (const [name, c] of Object.entries(d.cells ?? {})) {
        cells[name] = (
          c.type === "formula"
            ? { type: "formula", source: c.source }
            : resolveValue(w, c as FixtureValue)
        ) as InputCellContent;
      }
      const as = `$${d.as}`;
      const result = await transact(w, actor, `spawn ${d.template}`, {
        type: "spawn",
        template,
        to,
        ...(Object.keys(cells).length > 0 ? { cells } : {}),
        as,
      });
      if (result.status === "committed") {
        const spawned = result.copies[0];
        const root = result.bindings[as];
        if (spawned === undefined || root === undefined) {
          throw new Error(`spawn result without its root: ${JSON.stringify(result)}`);
        }
        bindName(w, d.as, root);
        for (const [key, name] of Object.entries(d.owned ?? {})) {
          const copy = spawned.copies[resolveName(w, key)];
          if (copy === undefined) throw new ScenarioError(`"${key}" is not in the subtree`);
          bindName(w, name, copy);
        }
      }
      return outcomeOf(result);
    }
    case "undo":
      if (actor !== undefined) throw new ScenarioError("a character's undo cannot be sent");
      return outcomeOf(await w.session.client.request("undo", { target: { type: "latest" } }));
    case "invoke":
      return invokeOverProtocol(w, actor, d.object, d.action);
  }
}

async function invokeOverProtocol(
  w: World,
  actor: ActorParam,
  object: string,
  action: string,
): Promise<Outcome> {
  const { id } = await liveObject(w, object);
  return outcomeOf(
    await w.session.client.request("invoke", {
      object: id,
      action,
      base_revision: w.session.client.revision,
      ...(actor === undefined ? {} : { actor }),
    }),
  );
}

async function taggedViews(w: World, tag: string): Promise<ObjectView[]> {
  const out: ObjectView[] = [];
  let cursor: string | null = null;
  do {
    const page: { objects: ObjectView[]; next_cursor: string | null } =
      await w.session.client.request("list_objects", {
        filter: { tag },
        cells: "all",
        ...(cursor === null ? {} : { cursor }),
      });
    out.push(...page.objects);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return out;
}

async function bindTarget(w: World, d: Extract<Step["do"], { type: "bind" }>): Promise<ObjectId> {
  let candidates: ObjectView[];
  if (d.in === undefined) {
    candidates = await taggedViews(w, d.tag);
  } else {
    const { view } = await liveObject(w, d.in);
    const ids = refIds(cellValue(view, "contents"));
    candidates =
      ids.length === 0 ? [] : (await w.session.client.request("get_objects", { ids })).objects;
  }
  const wanted = d.where === undefined ? undefined : resolveValue(w, d.where.value);
  const matches = candidates
    .filter((view) => {
      const tags = cellValue(view, "tag");
      const tagged =
        tags.type === "list" && tags.items.some((t) => t.type === "text" && t.value === d.tag);
      if (!tagged) return false;
      if (d.where === undefined || wanted === undefined) return true;
      const eq = equals(cellValue(view, d.where.cell), wanted);
      return eq.type === "boolean" && eq.value;
    })
    .map((view) => view.id);
  if (matches.length !== 1) {
    throw new ScenarioError(`bind "${d.as}" matches ${matches.length} objects`);
  }
  return matches[0] as ObjectId;
}

/** `click`: the step's actor presses the object's drawn, enabled button. */
async function clickStep(w: World, step: Step, row: MatrixRow): Promise<Outcome> {
  const d = step.do;
  if (d.type !== "invoke") throw new MatrixMismatch("click is for invoke steps");
  const { id } = await liveObject(w, d.object);
  const { chain, board } = await containment(w, id);
  checkBoard(row, board);
  await navigate(w, step.actor as string, board);
  await expandDown(w, [...chain, id]);
  const p = await reveal(w, (scene) => {
    const l = mustLocate(scene, id);
    const button = buttonOf(l.drawing, d.action);
    if (button === undefined) throw new UiScenarioFailure(`${id} draws no ${d.action} button`);
    return { p: apply(l.toBoard, centre(button.rect)), clips: l.clips };
  });
  setCamera(w, { x: p[0], y: p[1], zoom: 1 });
  const hit = faceHitAt(faces(w), p, camera(w));
  if (
    hit?.object !== id ||
    hit.target.type !== "button" ||
    hit.target.action !== d.action ||
    !hit.target.enabled
  ) {
    throw new UiScenarioFailure(
      `${id}'s ${d.action} button is not hit enabled: ${describeHit(hit)}`,
    );
  }
  const before = w.commits();
  click(w, p);
  return committed(w, before, `${d.object}[${d.action}] pressed`);
}

/** `suppressed`: the UI does not offer the action; the invocation is then sent and refused. */
async function suppressedStep(w: World, step: Step, row: MatrixRow): Promise<Outcome> {
  const d = step.do;
  if (d.type !== "invoke") throw new MatrixMismatch("suppressed is for invoke steps");
  const { id } = await liveObject(w, d.object);
  const { chain, board } = await containment(w, id);
  checkBoard(row, board);
  await navigate(w, step.actor as string, board);
  await expandDown(w, [...chain, id]);
  const button = buttonOf(mustLocate(faces(w), id).drawing, d.action);
  if (button !== undefined) {
    if (button.enabled) throw new UiScenarioFailure(`${id}'s ${d.action} button is enabled`);
    const p = await reveal(w, (scene) => {
      const l = mustLocate(scene, id);
      const b = buttonOf(l.drawing, d.action);
      if (b === undefined) throw new UiScenarioFailure(`${id}'s ${d.action} button went away`);
      return { p: apply(l.toBoard, centre(b.rect)), clips: l.clips };
    });
    setCamera(w, { x: p[0], y: p[1], zoom: 1 });
    const hit = faceHitAt(faces(w), p, camera(w));
    if (hit?.object !== id || hit.target.type !== "button" || hit.target.enabled) {
      throw new UiScenarioFailure(
        `${id}'s disabled ${d.action} button is not hit: ${describeHit(hit)}`,
      );
    }
    const revision = w.host.revision;
    const sent = invokeCount(w);
    click(w, p);
    await settle(150);
    if (invokeCount(w) !== sent || w.host.revision !== revision) {
      throw new UiScenarioFailure(
        `pressing ${id}'s disabled ${d.action} button sent an invocation`,
      );
    }
  }
  return invokeOverProtocol(w, actorParam(w, step.actor), d.object, d.action);
}

/**
 * Clears the selection with Escape on the canvas (the select tool, no
 * gesture in progress): a press on an object under a selected one (an
 * object inside a selected zone) would otherwise drag the selection.
 */
async function clearSelection(w: World): Promise<void> {
  if (w.ui.getState().selection.length === 0) return;
  act(() => {
    fireEvent.keyDown(w.canvas, { key: "Escape", code: "Escape" });
  });
  await until(() => w.ui.getState().selection.length === 0, "the selection cleared");
}

/** `drag`: the GM drags the object on the destination board (an entry drag when it is contained). */
async function dragStep(w: World, step: Step, row: MatrixRow): Promise<Outcome> {
  const d = step.do;
  if (d.type !== "move" || d.to.type !== "board") {
    throw new MatrixMismatch("drag is for moves onto a board");
  }
  if (step.actor !== "gm") throw new MatrixMismatch("drags are the GM's");
  const { id } = await liveObject(w, d.object);
  const dest = resolveName(w, d.to.board);
  const { chain, board } = await containment(w, id);
  if (board !== dest)
    throw new MatrixMismatch(`${d.object} is on ${board}, the drag goes to ${dest}`);
  checkBoard(row, dest);
  await navigate(w, "gm", dest);
  const to: Point = [d.to.position[0], d.to.position[1]];
  await clearSelection(w);
  const before = w.commits();
  if (chain.length === 0) {
    const anchor = await anchorOf(w, id);
    const delta: Point = [to[0] - anchor[0], to[1] - anchor[1]];
    setCamera(w, cameraFor([anchor, to]));
    const scene = faces(w);
    const from = bodyPoint(w, scene, id, (p) => {
      const release: Point = [p[0] + delta[0], p[1] + delta[1]];
      return onScreen(w, release) && dropTargetAt(scene, release, camera(w), [id]).kind === "board";
    });
    const release: Point = [from[0] + delta[0], from[1] + delta[1]];
    wholePixel(w, from);
    wholePixel(w, release);
    drag(w, from, release);
  } else {
    await expandDown(w, chain);
    const from = await rowPoint(w, id);
    setCamera(w, cameraFor([from, to]));
    const scene = faces(w);
    const hit = faceHitAt(scene, from, camera(w));
    if (hit?.target.type !== "entry" || hit.target.id !== id) {
      throw new UiScenarioFailure(`${id}'s row is not hit: ${describeHit(hit)}`);
    }
    if (dropTargetAt(scene, to, camera(w), [id]).kind !== "board") {
      throw new UiScenarioFailure(`dropping at ${JSON.stringify(to)} would not reach the board`);
    }
    wholePixel(w, to);
    drag(w, from, to);
  }
  return committed(w, before, `${d.object} dragged`);
}

/** Selects `id` with a click: its body on the board, or its row (the entry click). */
async function selectByClick(w: World, id: ObjectId, chain: readonly ObjectId[]): Promise<void> {
  if (chain.length === 0) {
    setCamera(w, cameraFor([await anchorOf(w, id)]));
    click(w, bodyPoint(w, faces(w), id));
  } else {
    await expandDown(w, chain);
    const p = await rowPoint(w, id);
    setCamera(w, { x: p[0], y: p[1], zoom: 1 });
    click(w, p);
  }
  await until(() => w.ui.getState().selection.join() === id, `${id} selected`);
  await settle(30);
}

function inspector(): HTMLElement {
  return screen.getByRole("complementary", { name: "Inspector panel" });
}

async function inspectorTab(w: World, name: "Inspector" | "Log"): Promise<void> {
  const tab = within(inspector()).getByRole("tab", { name });
  if (tab.getAttribute("aria-selected") !== "true") await w.user.click(tab);
}

async function cellRow(id: ObjectId, cell: string): Promise<HTMLElement> {
  let row: HTMLElement | null = null;
  await until(() => {
    row = inspector().querySelector<HTMLElement>(`li[data-cell="${cell}"]`);
    return row !== null;
  }, `the inspector row ${id}.${cell}`);
  return row as unknown as HTMLElement;
}

/** `edit`: the GM selects the target and types into its inspector value cell (or presses Clear). */
async function editStep(w: World, step: Step, row: MatrixRow): Promise<Outcome> {
  const d = step.do;
  if (d.type !== "set" && d.type !== "override" && d.type !== "clear_override") {
    throw new MatrixMismatch("edit is for set, override and clear_override");
  }
  if (step.actor !== "gm") throw new MatrixMismatch("the UI edits only as the GM");
  const { id, view } = await liveObject(w, d.object);
  const kind = view.cells[d.cell]?.kind;
  if (d.type === "set" && kind === "formula") {
    throw new ScenarioError(`set on "${d.object}.${d.cell}", which holds a formula`);
  }
  if (d.type === "override" && kind !== "formula") {
    throw new ScenarioError(`override on "${d.object}.${d.cell}", which holds no formula`);
  }
  if (d.type === "clear_override" && view.cells[d.cell]?.overridden !== true) {
    throw new ScenarioError(`clear_override on "${d.object}.${d.cell}", which has none`);
  }
  const { chain, board } = await containment(w, id);
  checkBoard(row, board);
  await navigate(w, "gm", board);
  await inspectorTab(w, "Inspector");
  const located = mustLocate(faces(w), id);
  if (located.drawing?.primitives.some((p) => p.kind === "editor" && p.cell === d.cell)) {
    throw new UiScenarioFailure(
      `${d.object}.${d.cell} has a face editor; typing into it is not driven yet`,
    );
  }
  await selectByClick(w, id, chain);
  const li = await cellRow(id, d.cell);
  const before = w.commits();
  if (d.type === "clear_override") {
    await w.user.click(li);
    await until(
      () => w.ui.getState().focusedCell?.cell === d.cell,
      `${d.object}.${d.cell} focused`,
    );
    const bar = document.querySelector<HTMLElement>('[data-part="formula-bar"]');
    if (bar === null) throw new UiScenarioFailure("no formula bar");
    let clear: HTMLElement | null = null;
    await until(() => {
      clear = within(bar).queryByRole("button", { name: "Clear" });
      return clear !== null;
    }, "the formula bar's Clear");
    await w.user.click(clear as unknown as HTMLElement);
    return committed(w, before, `${d.object}.${d.cell} override cleared in the formula bar`);
  }
  const value = resolveValue(w, d.value);
  const input = valueToInputText(value, d.cell);
  if (input.kind !== "literal") {
    throw new UiScenarioFailure(`${JSON.stringify(value)} cannot be typed: ${input.reason}`);
  }
  const shown = li.querySelector<HTMLElement>('[data-part="value"]');
  if (shown === null) throw new UiScenarioFailure(`no value in the row ${d.object}.${d.cell}`);
  await w.user.dblClick(shown);
  const box = within(li).getByRole("textbox", { name: `Value of ${d.cell}` });
  await w.user.clear(box);
  await w.user.type(box, `${input.text}{Enter}`);
  return committed(w, before, `${d.object}.${d.cell} ← ${input.text} typed in the inspector`);
}

/** `log`: the Log tab's Undo on the newest group that is neither undone nor an undo. */
async function logStep(w: World, step: Step, row: MatrixRow): Promise<Outcome> {
  if (step.do.type !== "undo") throw new MatrixMismatch("log is for undo steps");
  if (step.actor !== "gm") throw new MatrixMismatch("the log panel undoes as the GM");
  if (row.board === null) throw new MatrixMismatch("a log step names its board");
  await navigate(w, "gm", row.board);
  const newest = (await w.session.client.request("log", { limit: 1 })).groups[0]?.index;
  await inspectorTab(w, "Log");
  const list = await (async () => {
    let el: HTMLElement | null = null;
    await until(() => {
      el = within(inspector()).queryByRole("list", { name: "Log entries" });
      return el !== null && el.querySelector(`li[data-log-index="${newest}"]`) !== null;
    }, "the log panel's newest group");
    return el as unknown as HTMLElement;
  })();
  const undoable = [...list.querySelectorAll<HTMLElement>("li[data-log-index]")]
    .filter((li) => within(li).queryByRole("button", { name: /^Undo / }) !== null)
    .sort((a, b) => Number(b.dataset.logIndex) - Number(a.dataset.logIndex));
  const target = undoable[0];
  if (target === undefined) throw new UiScenarioFailure("no group in the log panel has an Undo");
  const before = w.commits();
  await w.user.click(within(target).getByRole("button", { name: /^Undo / }));
  const outcome = await committed(w, before, `Undo of group ${target.dataset.logIndex}`);
  await inspectorTab(w, "Inspector");
  return outcome;
}

function checkBoard(row: MatrixRow, board: BoardId): void {
  if (row.board !== board) {
    throw new MatrixMismatch(
      `step ${row.step}: the matrix says board ${row.board}, the rule gives ${board}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Expectations

const show = (x: unknown): string => JSON.stringify(x);

function holds(ok: boolean, message: () => string): void {
  if (!ok) throw new UiScenarioFailure(message());
}

async function retainedGroups(w: World): Promise<GroupView[]> {
  const newestFirst: GroupView[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await w.session.client.request("log", {
      limit: 50,
      ...(before === undefined ? {} : { before }),
    });
    newestFirst.push(...page.groups);
    const oldest = page.groups.at(-1);
    if (oldest === undefined || oldest.index <= page.first_index) break;
    before = oldest.index;
  }
  return newestFirst.reverse();
}

function writtenValue(after: CellStateView | null): Value | undefined {
  if (after === null) return undefined;
  if (after.kind === "literal") return after.value as Value;
  return after.override as Value | undefined;
}

function effectMatches(w: World, want: LogEffect, e: EffectView): boolean {
  if (e.type !== "cell") return false;
  if (want.type === "roll" && e.cause !== "roll") return false;
  if (e.object !== resolveName(w, want.object) || e.cell !== want.cell) return false;
  const written = writtenValue(e.after);
  return written !== undefined && fixtureValueEquals(resolveValue(w, want.value), written);
}

/** `face_element`: the face drawn for the viewer, on the object's board. */
async function checkFaceElement(
  w: World,
  e: Extract<Expectation, { type: "face_element" }>,
): Promise<void> {
  const { id, view } = await liveObject(w, e.object);
  const list = e.list ?? "full";
  if (list !== "full") throw new ScenarioError("the UI driver checks full-face elements only");
  if (view.face === undefined) throw new ScenarioError(`${e.object} has no face layout`);
  if (e.element >= view.face.elements.length) {
    throw new ScenarioError(`${e.object} face: the stored list has ${view.face.elements.length}`);
  }
  const viewer = e.viewer ?? "gm";
  const { board } = await containment(w, id);
  await navigate(w, viewer, board);
  const located = locate(faces(w), id);
  const drawing =
    located === null || (located.entry !== null && !located.entry.entry.expanded)
      ? null
      : located.drawing;
  const drawn = drawing?.primitives.some((p) => p.element === e.element) ?? false;
  holds(
    drawn === e.shown,
    () =>
      `${e.object} face element ${e.element} for ${viewer}: expected shown ${e.shown}, drawn ${drawn}`,
  );
}

async function checkExpectation(w: World, e: Expectation): Promise<void> {
  switch (e.type) {
    case "rejected":
      throw new Error("rejected belongs to the rejection protocol");
    case "action": {
      const { view } = await liveObject(w, e.object);
      if (!view.actions.some((a) => a.name === e.action)) {
        throw new ScenarioError(`${e.object} has no action "${e.action}"`);
      }
      const state = (view.action_states ?? []).find((s) => s.name === e.action);
      const got = state?.enabled ?? false;
      holds(
        got === e.enabled,
        () => `${e.object}[${e.action}]: expected enabled ${e.enabled}, got ${show(state)}`,
      );
      return;
    }
    case "face_element":
      return checkFaceElement(w, e);
    case "cell": {
      const { view } = await liveObject(w, e.object);
      const want = resolveValue(w, e.value);
      const got = cellValue(view, e.cell);
      holds(
        fixtureValueEquals(want, got),
        () => `${e.object}.${e.cell}: expected ${show(want)}, got ${show(got)}`,
      );
      return;
    }
    case "cell_error": {
      const { view } = await liveObject(w, e.object);
      const got = cellValue(view, e.cell);
      holds(
        got.type === "error" && got.code === e.code,
        () => `${e.object}.${e.cell}: expected ${e.code}, got ${show(got)}`,
      );
      return;
    }
    case "override": {
      const { view } = await liveObject(w, e.object);
      const got = view.cells[e.cell]?.overridden === true;
      holds(
        got === e.overridden,
        () => `${e.object}.${e.cell}: expected overridden ${e.overridden}`,
      );
      return;
    }
    case "exists": {
      const id = resolveName(w, e.object);
      const result = await w.session.client.request("get_objects", { ids: [id] });
      const got = !result.missing.includes(id);
      holds(got === e.exists, () => `${e.object}: expected exists ${e.exists}, got ${got}`);
      return;
    }
    case "container": {
      const { id } = await liveObject(w, e.object);
      const { view } = await liveObject(w, e.container);
      const contents = refIds(cellValue(view, "contents"));
      holds(
        contents.indexOf(id) === e.index,
        () => `${e.object}: expected at ${e.index} of ${e.container}, contents ${show(contents)}`,
      );
      return;
    }
    case "placement": {
      const { view } = await liveObject(w, e.object);
      const board = resolveName(w, e.board);
      const onBoard = refOf(cellValue(view, "board"));
      const position = cellValue(view, "position");
      const at =
        position.type === "list" &&
        position.items.length === 2 &&
        position.items.every((p, i) => p.type === "number" && p.value === e.position[i]);
      holds(
        onBoard === board && at,
        () =>
          `${e.object}: expected on ${e.board} at ${show(e.position)}, got ${show(onBoard)} ${show(position)}`,
      );
      return;
    }
    case "contents": {
      const { view } = await liveObject(w, e.object);
      const want = e.contents.map((name) => resolveName(w, name));
      const got = refIds(cellValue(view, "contents"));
      holds(
        want.length === got.length && want.every((x, i) => x === got[i]),
        () => `${e.object}: expected contents ${show(want)}, got ${show(got)}`,
      );
      return;
    }
    case "cell_visible": {
      const { id } = await liveObject(w, e.object);
      const seen = await viewOf(w, id, toViewer(w, e.viewer));
      const got = seen !== undefined && Object.hasOwn(seen.cells, e.cell);
      holds(
        got === e.visible,
        () => `${e.object}.${e.cell} for ${e.viewer}: expected visible ${e.visible}`,
      );
      return;
    }
    case "object_visible": {
      const { id } = await liveObject(w, e.object);
      const got = (await viewOf(w, id, toViewer(w, e.viewer))) !== undefined;
      holds(got === e.visible, () => `${e.object} for ${e.viewer}: expected visible ${e.visible}`);
      return;
    }
    case "log_groups": {
      const got = (await retainedGroups(w)).length;
      holds(got === e.count, () => `expected ${e.count} log groups, got ${got}`);
      return;
    }
    case "log_includes": {
      await liveObject(w, e.effect.object);
      const groups = await retainedGroups(w);
      const header = e.group < 0 ? groups.at(e.group) : groups.find((g) => g.index === e.group);
      if (header === undefined) throw new UiScenarioFailure(`no log group ${e.group}`);
      const { group } = await w.session.client.request("explain_group", { index: header.index });
      const effects = group.effects ?? [];
      holds(
        effects.some((x) => effectMatches(w, e.effect, x)),
        () => `group ${group.index} "${group.label}" does not record ${show(e.effect)}`,
      );
      return;
    }
    case "replay": {
      const before = w.dice.remaining();
      const { snapshot, log } = await w.session.client.request("document", {});
      const replayed = replay(w.setup, log.groups as readonly OpGroup[]);
      holds(
        storedStateEqual(replayed, snapshot),
        () => `replay differs: ${diffStoredState(replayed, snapshot).join("; ")}`,
      );
      holds(w.dice.remaining() === before, () => "replay consumed dice script entries");
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// The rejection protocol

const SCHEMA_REJECTIONS: ReadonlySet<string> = new Set([
  "protected_cell",
  "containment_cycle",
  "undo_conflict",
  "nothing_to_undo",
  "type_error",
  "invalid",
  "when_false",
  "when_error",
  "step_error",
]);

function reasonMatches(want: RejectionReason, got: ProtocolRejection): boolean {
  if (!SCHEMA_REJECTIONS.has(got.type)) return false;
  const mapped = toFixtureReason(got as Rejection);
  if (mapped === null || mapped.type !== want.type) return false;
  if (want.type === "when_error") return mapped.type === "when_error" && mapped.code === want.code;
  if (want.type === "step_error" && want.code !== undefined) {
    return mapped.type === "step_error" && mapped.code === want.code;
  }
  return true;
}

interface Before {
  snapshot: string;
  groups: number;
  dice: number;
}

async function snapshotBefore(w: World): Promise<Before> {
  const doc = await w.session.client.request("document", {});
  return {
    snapshot: canonicalJson(doc.snapshot),
    groups: doc.log.first_index + doc.log.groups.length,
    dice: w.dice.remaining(),
  };
}

async function checkRejection(
  w: World,
  where: string,
  list: readonly Expectation[],
  outcome: Outcome | { type: "bound" },
  prior: Before,
): Promise<void> {
  const predicted = list.find((e) => e.type === "rejected");
  if (outcome.type === "refused") {
    if (predicted?.type !== "rejected") {
      throw new UiScenarioFailure(`${where}: unpredicted refusal ${show(outcome.rejection)}`);
    }
    holds(
      reasonMatches(predicted.reason, outcome.rejection),
      () => `${where}: expected ${show(predicted.reason)}, refused ${show(outcome.rejection)}`,
    );
    const after = await snapshotBefore(w);
    holds(
      after.snapshot === prior.snapshot && after.groups === prior.groups,
      () => `${where}: the refused step changed the document or the log`,
    );
    holds(after.dice === prior.dice, () => `${where}: the refused step consumed dice`);
  } else if (predicted !== undefined) {
    throw new UiScenarioFailure(
      `${where}: predicted ${show(predicted)}, but the step was not refused`,
    );
  }
}

// ---------------------------------------------------------------------------
// The run

/** Runs `step` by `row`'s path; returns its outcome and the path taken (board: the active one after it). */
async function runStep(
  w: World,
  step: Step,
  row: MatrixRow,
  index: number,
): Promise<{ outcome: Outcome | { type: "bound" }; taken: MatrixRow }> {
  let outcome: Outcome | { type: "bound" };
  let path: UiPath;
  switch (row.path) {
    case "protocol":
      outcome = await protocolStep(w, step);
      path = "protocol";
      break;
    case "click":
      outcome = await clickStep(w, step, row);
      path = "click";
      break;
    case "suppressed":
      outcome = await suppressedStep(w, step, row);
      path = "suppressed";
      break;
    case "drag":
      outcome = await dragStep(w, step, row);
      path = "drag";
      break;
    case "edit":
    case "edit (formula bar Clear)":
      outcome = await editStep(w, step, row);
      path = step.do.type === "clear_override" ? "edit (formula bar Clear)" : "edit";
      break;
    case "log":
      outcome = await logStep(w, step, row);
      path = "log";
      break;
  }
  const board = path === "protocol" ? null : w.session.getSnapshot().activeBoard;
  return { outcome, taken: { step: index, actor: step.actor ?? null, path, board } };
}

function checkRow(
  scenario: Scenario,
  index: number,
  step: Step,
  row: MatrixRow | undefined,
): MatrixRow {
  const where = `${scenario.title}: step ${index}`;
  if (row === undefined || row.step !== index) throw new MatrixMismatch(`${where}: no matrix row`);
  if ((step.actor ?? null) !== row.actor) {
    throw new MatrixMismatch(
      `${where}: the matrix says actor ${row.actor}, the step's is ${step.actor}`,
    );
  }
  if (!PATHS_BY_STEP[step.do.type].includes(row.path)) {
    throw new MatrixMismatch(`${where}: path ${row.path} cannot run a ${step.do.type} step`);
  }
  if ((row.path === "protocol") !== (row.board === null)) {
    throw new MatrixMismatch(`${where}: a protocol row has no board, any other row has one`);
  }
  const refused = (step.expect ?? []).some((e) => e.type === "rejected");
  if (refused && row.path !== "suppressed" && row.path !== "protocol") {
    throw new MatrixMismatch(`${where}: a predicted refusal cannot go through ${row.path}`);
  }
  if (row.path === "suppressed" && !refused) {
    throw new MatrixMismatch(`${where}: a suppressed invocation must be predicted refused`);
  }
  return row;
}

/** Runs `scenario` through the app with `matrix` (one row per step, in step order). */
export async function runScenarioInUi(
  scenario: Scenario,
  matrix: readonly MatrixRow[],
): Promise<UiRunReport> {
  if (matrix.length !== scenario.steps.length) {
    throw new MatrixMismatch(
      `${scenario.title}: the matrix has ${matrix.length} rows for ${scenario.steps.length} steps`,
    );
  }
  const rows = scenario.steps.map((step, i) => checkRow(scenario, i, step, matrix[i]));
  const w = await openWorld(scenario);
  try {
    const title = scenario.title;
    let checked = 0;
    const checkList = async (where: string, list: readonly Expectation[]) => {
      for (const [i, e] of list.entries()) {
        checked++;
        if (e.type === "rejected") continue;
        try {
          await checkExpectation(w, e);
        } catch (err) {
          if (err instanceof Error)
            err.message = `${where}, expect #${i} (${e.type}): ${err.message}`;
          throw err;
        }
      }
    };
    await checkList(`${title}: setup`, scenario.expect ?? []);
    const paths: MatrixRow[] = [];
    for (const [i, step] of scenario.steps.entries()) {
      const row = rows[i] as MatrixRow;
      const where = `${title}: step ${i} (${row.path})`;
      const prior = await snapshotBefore(w);
      let outcome: Outcome | { type: "bound" };
      try {
        const ran = await runStep(w, step, row, i);
        outcome = ran.outcome;
        paths.push(ran.taken);
      } catch (err) {
        if (err instanceof Error) err.message = `${where}: ${err.message}`;
        throw err;
      }
      await w.session.whenRevision(w.host.revision);
      await settle(30);
      await checkRejection(w, where, step.expect ?? [], outcome, prior);
      await checkList(where, step.expect ?? []);
    }
    const leftoverDice = w.dice.remaining();
    if (leftoverDice > 0) {
      throw new ScenarioError(`${title}: ${leftoverDice} scripted dice entries unused`);
    }
    return {
      title,
      complete: paths.length === scenario.steps.length,
      stepsRun: paths.length,
      stepsTotal: scenario.steps.length,
      leftoverDice,
      expectationsChecked: checked,
      paths,
    };
  } finally {
    await w.close();
  }
}
