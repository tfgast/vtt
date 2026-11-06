/**
 * The M5 app composition (vtt-1xv.23; DESIGN.md §7 Platform, §4.5–§4.8,
 * §8.1; M5 plan Q1, Q12, Q19, Q20; review r1 findings 8, 10, 11, r2
 * findings 1, 4, 13): the real `App` in jsdom against an in-process
 * authority over a stocked table (vtt-1xv.22) with scripted dice, drawn by
 * the app's face renderer (`createAppRenderer`) into a `RecordingContext`.
 * Pointer events go to the canvas in screen coordinates; targets are
 * located on the face scene built with the app's own `FaceStateStore`
 * (injected through `faceState`).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ScriptedDiceEntry, ScriptedDiceSource, stockedTableSnapshot } from "@vtt/authority";
import type { WireOp } from "@vtt/protocol";
import type { ObjectId, Point, Rect } from "@vtt/schema";
import {
  type Affine,
  App,
  apply,
  BUTTON_FILL,
  buildFaceScene,
  COVER_FILL,
  compose,
  contentsRect,
  createAppRenderer,
  createFaceStateStore,
  createUiStore,
  entryTransform,
  type FaceDrawing,
  type FaceScene,
  type FaceStateStore,
  faceHitAt,
  pathContents,
  type RecordedCall,
  RecordingContext,
  sessionNotices,
  type TableSession,
  TEMPLATE_REFUSAL,
  toScreen,
  type UiStore,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startAuthority, until, whenReady } from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const VIEWPORT = { width: 800, height: 600 };
const BOARD = "gm_board";
const BINDER = "gm_binder";
/** The GM binder's contents element (its face: name, then the list). */
const LIST_ELEMENT = 1;
/** The camera the tests work under: 48 px per unit, centred on the binder. */
const CAMERA = { x: 0, y: 0, zoom: 0.75 };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    x: 0,
    y: 0,
    right: RECT.width,
    bottom: RECT.height,
    toJSON: () => ({}),
  });
  localStorage.clear();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// The table

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const ALL = { type: "viewers" as const, viewers: ["all" as const] };
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: BOARD,
  position: [x, y] as [number, number],
});
const square = (side: number) => ({ type: "rect" as const, width: side, height: side });

/** A goblin token east of the binder. */
const GOBLIN: WireOp = {
  type: "create_object",
  id: "goblin",
  to: at(6, 0),
  init: { shape: square(1), cells: { name: text("Goblin"), visible_to: ALL, ac: num(13) } },
};

/** A token template placed directly on the board, with a default action. */
const TEMPLATE_TOKEN: WireOp = {
  type: "create_object",
  id: "board_tpl",
  to: at(6, -3),
  init: {
    is_template: true,
    shape: square(1),
    cells: { name: text("Ogre"), visible_to: ALL, hp: num(5) },
    actions: [{ name: "Hurt", steps: ["set(hp, 4)"] }],
    face: {
      elements: [{ type: "value", cell: "name", rect: [-0.5, -0.5, 1, 0.3] }],
      default_action: "Hurt",
    },
  },
};

const roll = (value: number): ScriptedDiceEntry => ({
  type: "roll",
  expr: "1d20",
  dice: [value],
  dropped: [],
  total: value,
});

// ---------------------------------------------------------------------------
// The world

interface WorldOptions {
  dice?: ScriptedDiceEntry[];
  seed?: WireOp[];
}

async function world(options: WorldOptions = {}) {
  const dice = new ScriptedDiceSource(options.dice ?? []);
  const authority = await startAuthority({ snapshot: stockedTableSnapshot(), dice });
  const { host } = authority;
  cleanups.push(() => authority.cleanup());
  const gm = await authority.client("seed");
  if (options.seed !== undefined && options.seed.length > 0) {
    const seeded = await gm.transact(options.seed, { label: "Seed" });
    if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));
  }

  const session: TableSession = authority.session();
  const request = vi.spyOn(session.client, "request");
  const ui: UiStore = createUiStore({ session });
  const faceState: FaceStateStore = createFaceStateStore();
  const ctx = new RecordingContext();
  const utils = render(
    <App
      session={session}
      ui={ui}
      faceState={faceState}
      createRenderer={(_canvas, { requestRedraw }) =>
        createAppRenderer(ctx, { resolve: (p) => p, requestRedraw })
      }
    />,
  );
  await whenReady(session);
  await until(() => session.boardView()?.objects.has(BINDER) === true, "the binder's view");
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  // The first-visit fit, then the tests' camera.
  await waitFor(() => expect(ui.getState().camera.zoom).not.toBe(1));
  act(() => ui.setCamera(CAMERA));

  const store = host.table.store;
  const object = (id: ObjectId) => store.getObject(id);
  const ids = () => new Set(store.objectIds());
  const calls = (method: string) =>
    request.mock.calls.filter(([m]) => m === method).map(([, p]) => p);
  const invokes = () => calls("invoke") as { object: ObjectId; action: string }[];
  const notices = () =>
    sessionNotices(session)
      .list()
      .map((n) => n.text);

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
  const dblClick = (p: Point) => {
    click(p);
    click(p);
    const [x, y] = screenOf(p);
    act(() => {
      fireEvent.doubleClick(canvas, { clientX: x, clientY: y });
    });
  };
  const wheel = (p: Point, deltaY: number) => {
    const [x, y] = screenOf(p);
    act(() => {
      fireEvent.wheel(canvas, { clientX: x, clientY: y, deltaY, deltaMode: 0 });
    });
  };

  return {
    host,
    dice,
    gm,
    session,
    ui,
    faceState,
    ctx,
    canvas,
    container: utils.container,
    object,
    ids,
    calls,
    invokes,
    notices,
    faces,
    screenOf,
    fire,
    drag,
    click,
    dblClick,
    wheel,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Lets pending writes and renders settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];

/** The recorded frames (each starts at the renderer's `clearRect`). */
function frames(ctx: RecordingContext): RecordedCall[][] {
  const out: RecordedCall[][] = [];
  for (const call of ctx.calls) {
    if (call.name === "clearRect") out.push([]);
    out.at(-1)?.push(call);
  }
  return out;
}
const lastFrame = (w: World): RecordedCall[] => frames(w.ctx).at(-1) ?? [];
const textsOf = (calls: readonly RecordedCall[]) =>
  calls.filter((c) => c.name === "fillText").map((c) => c.args[0] as string);

/** The binder's list as drawn now. */
function binderList(w: World) {
  const scene = w.faces();
  const list = pathContents(scene, [{ container: BINDER, element: LIST_ELEMENT }])[0];
  if (list === undefined) throw new Error("the binder has no list");
  return { scene, list, toBoard: scene.transforms.get(BINDER) as Affine };
}

function entryOf(w: World, id: ObjectId) {
  const { list } = binderList(w);
  const e = list.entries.find((x) => x.id === id);
  if (e === undefined) throw new Error(`${id} is not in the binder`);
  return e;
}

/** The board point of `id`'s chevron in the binder's list (asserted hittable). */
function chevronOf(w: World, id: ObjectId): Point {
  const { scene, list, toBoard } = binderList(w);
  const p = apply(toBoard, centre(contentsRect(list, entryOf(w, id).chevron)));
  expect(faceHitAt(scene, p, w.ui.getState().camera)?.target).toEqual({ type: "chevron", id });
  return p;
}

/** A point on the collapsed row of `id`, left of its middle (no chevron or gear). */
function rowOf(w: World, id: ObjectId): Point {
  const { list, toBoard } = binderList(w);
  const r = contentsRect(list, entryOf(w, id).row);
  return apply(toBoard, [r[0] + r[2] * 0.4, r[1] + r[3] / 2]);
}

/** The board point of local point `local` of expanded binder entry `id`. */
function onEntry(w: World, id: ObjectId, local: Point): Point {
  const { list, toBoard } = binderList(w);
  const e = entryOf(w, id);
  if (!e.expanded) throw new Error(`${id} is not expanded`);
  return apply(compose(toBoard, entryTransform(list, e)), local);
}

/** Whether `id`'s row is drawn entirely inside the binder's list rect. */
function wholeRowShown(w: World, id: ObjectId): boolean {
  const { list } = binderList(w);
  const e = list.entries.find((x) => x.id === id);
  if (e === undefined) return false;
  const top = e.row[1] - list.offset;
  return top >= -1e-9 && top + e.row[3] <= list.rect[3] + 1e-9;
}

/** The rect of `drawing`'s button for `action`, or undefined. */
function buttonRect(drawing: FaceDrawing | null | undefined, action: string): Rect | undefined {
  const b = drawing?.primitives.find((p) => p.kind === "button" && p.action === action);
  return b?.rect;
}

/** The binder entries copied from `template` (working copies). */
const copiesOf = (w: World, template: ObjectId): ObjectId[] =>
  (w.object(BINDER)?.contents ?? []).filter((id) => {
    const t = w.object(id)?.cells.template?.content;
    return t?.type === "ref" && t.object === template && w.object(id)?.is_template === false;
  });

/** Scrolls the binder's list to its end with the wheel. */
function wheelToEnd(w: World) {
  const { list, toBoard } = binderList(w);
  w.wheel(apply(toBoard, [list.rect[0] + list.rect[2] / 2, list.rect[1] + list.rect[3] / 2]), 2000);
}

/** Expands `template` by its chevron and waits for its working copy, selected. */
async function expandTemplate(w: World, template: ObjectId): Promise<ObjectId> {
  const before = new Set(copiesOf(w, template));
  w.click(chevronOf(w, template));
  await until(() => copiesOf(w, template).some((id) => !before.has(id)), "the working copy");
  const copy = copiesOf(w, template).find((id) => !before.has(id)) as ObjectId;
  await waitFor(() => expect(w.ui.getState().selection).toEqual([copy]));
  await until(() => w.session.objectView(copy) !== null, "the copy's view");
  return copy;
}

const inspector = () => screen.getByRole("complementary", { name: "Inspector panel" });

// ---------------------------------------------------------------------------

describe("the GM binder", () => {
  test("is drawn with collapsed entries; the wheel scrolls it to tpl_d20, whose expansion spawns a working copy scrolled into view whose Roll button rolls", async () => {
    const w = await world({ dice: [roll(17)] });
    await waitFor(() => expect(textsOf(lastFrame(w))).toContain("GM binder"));
    const { list } = binderList(w);
    expect(list.entries.map((e) => e.id)).toEqual(w.object(BINDER)?.contents);
    expect(list.entries.every((e) => !e.expanded)).toBe(true);
    expect(textsOf(lastFrame(w))).toEqual(expect.arrayContaining(["Character", "Attack"]));
    expect(list.maxOffset).toBeGreaterThan(0);
    expect(wholeRowShown(w, "tpl_d20")).toBe(false);

    wheelToEnd(w);
    expect(w.ui.getState().camera).toEqual(CAMERA);
    expect(w.faceState.scrollOffset(BINDER, LIST_ELEMENT)).toBeCloseTo(list.maxOffset, 9);
    expect(wholeRowShown(w, "tpl_d20")).toBe(true);

    const copy = await expandTemplate(w, "tpl_d20");
    expect(copy).toMatch(/^tpl_d20_\d+$/);
    expect(w.object(BINDER)?.contents.slice(-2)).toEqual(["tpl_d20", copy]);
    expect(w.faceState.isExpanded(copy, "collapsed")).toBe(true);
    expect(w.faceState.isExpanded("tpl_d20", "collapsed")).toBe(false);
    await waitFor(() => expect(wholeRowShown(w, copy)).toBe(true));

    const rect = buttonRect(entryOf(w, copy).drawing, "Roll");
    if (rect === undefined) throw new Error("the copy has no Roll button");
    const press = onEntry(w, copy, centre(rect));
    expect(faceHitAt(w.faces(), press, w.ui.getState().camera)).toMatchObject({
      object: copy,
      target: { type: "button", action: "Roll" },
    });
    w.click(press);
    await until(() => w.object(copy)?.cells.value?.content.type === "roll", "the copy's roll");
    expect(w.invokes()).toMatchObject([{ object: copy, action: "Roll" }]);
    expect(w.object(copy)?.cells.value?.content).toMatchObject({ type: "roll", total: 17 });
    expect(w.object("tpl_d20")?.cells.value?.content).toEqual({ type: "empty" });
  }, 30_000);

  test("dragging tpl_d20 out spawns a die on the board, and double-clicking the die rolls it", async () => {
    const w = await world({ dice: [roll(9)] });
    wheelToEnd(w);
    const before = w.ids();
    w.drag(rowOf(w, "tpl_d20"), [
      [5, 3],
      [6, 3],
    ]);
    await until(
      () => [...w.ids()].some((id) => !before.has(id) && id.startsWith("tpl_d20_")),
      "the die",
    );
    const die = [...w.ids()].find((id) => !before.has(id) && id.startsWith("tpl_d20_")) as ObjectId;
    expect(w.object(die)?.board).toBe(BOARD);
    expect(w.object(die)?.is_template).toBe(false);
    expect(w.object(BINDER)?.contents).toContain("tpl_d20");
    await until(() => w.session.boardView()?.objects.has(die) === true, "the die's view");

    // Zoomed in, a point of the die's body that is neither its value nor its button.
    act(() => w.ui.select([]));
    act(() => w.ui.setCamera({ x: 6, y: 3, zoom: 2 }));
    const body: Point = [6 + 0.43, 3 - 0.2];
    expect(faceHitAt(w.faces(), body, w.ui.getState().camera)).toMatchObject({
      object: die,
      target: { type: "body" },
    });
    w.dblClick(body);
    await until(() => w.object(die)?.cells.value?.content.type === "roll", "the die's roll");
    expect(w.invokes()).toMatchObject([{ object: die, action: "Roll" }]);
    expect(w.object(die)?.cells.value?.content).toMatchObject({ type: "roll", total: 9 });
  }, 30_000);

  test("the Attack card's working copy: a goblin dropped on its target, Roll pressed on its face; the face updates and the Log tab shows the roll", async () => {
    const w = await world({ dice: [roll(12)], seed: [GOBLIN] });
    await until(() => w.session.boardView()?.objects.has("goblin") === true, "the goblin");
    const copy = await expandTemplate(w, "tpl_attack");
    // The expanded copy is scrolled into the list: its top is shown.
    await waitFor(() => expect(entryOf(w, copy).expanded).toBe(true));
    const { list } = binderList(w);
    const top = entryOf(w, copy).row[1] - list.offset;
    expect(top).toBeGreaterThanOrEqual(-1e-9);
    expect(top).toBeLessThan(list.rect[3]);

    // The goblin dropped on the copy's target editor writes a reference and stays put.
    const target = onEntry(w, copy, centre([-1.2, -1.2, 2.4, 0.4]));
    expect(faceHitAt(w.faces(), target, w.ui.getState().camera)?.target).toEqual({
      type: "editor",
      cell: "target",
    });
    w.drag([6, 0], [[5, 0], target]);
    await until(
      () => w.object(copy)?.cells.target?.content.type === "ref",
      "the copy's target reference",
    );
    expect(w.object(copy)?.cells.target?.content).toEqual({ type: "ref", object: "goblin" });
    expect(w.object("goblin")?.cells.position?.content).toEqual({
      type: "list",
      items: [num(6), num(0)],
    });
    await until(
      () =>
        w.session.objectView(copy)?.action_states?.find((s) => s.name === "Roll")?.enabled === true,
      "Roll enabled on the copy",
    );

    const rect = buttonRect(entryOf(w, copy).drawing, "Roll");
    if (rect === undefined) throw new Error("the copy has no Roll button");
    w.click(onEntry(w, copy, centre(rect)));
    await until(() => w.object(copy)?.cells.roll?.content.type === "roll", "the copy's roll");
    expect(w.invokes()).toMatchObject([{ object: copy, action: "Roll" }]);
    // The face follows: Roll (shown while roll = empty) is gone.
    await waitFor(() => expect(buttonRect(entryOf(w, copy).drawing, "Roll")).toBeUndefined());
    expect(buttonRect(entryOf(w, copy).drawing, "Discard")).toBeDefined();
    expect(JSON.stringify(w.object("tpl_attack")?.cells.roll?.content)).toBe(
      JSON.stringify({ type: "empty" }),
    );

    const user = userEvent.setup();
    await user.click(within(inspector()).getByRole("tab", { name: "Log" }));
    const log = within(inspector()).getByRole("tabpanel");
    const rollGroup = () =>
      log.querySelector<HTMLElement>('[data-log-index][aria-label="GM: Roll"]');
    await until(() => rollGroup() !== null, "the Roll group in the log");
    expect(rollGroup()?.textContent).toContain("Rolled 1d20 → 12 into Attack.roll");
  }, 30_000);
});

describe("drawing", () => {
  test("face calls precede covers in a character view", async () => {
    const w = await world({
      seed: [
        {
          type: "create_object",
          id: "hero",
          to: at(14, 0),
          init: { is_character: true, shape: square(1), cells: { name: text("Hero") } },
        },
        {
          type: "create_object",
          id: "room",
          to: at(22, 0),
          init: {
            is_zone: true,
            shape: square(4),
            cells: {
              visible_to: { type: "viewers", viewers: ["gm"] },
              opaque: { type: "boolean", value: true },
            },
          },
        },
        {
          type: "create_object",
          id: "lamp",
          to: at(18, 0),
          init: {
            shape: square(2),
            cells: { name: text("Lamp"), visible_to: ALL, lit: num(1) },
            actions: [{ name: "Toggle", steps: ["set(lit, 0)"] }],
            face: {
              elements: [
                { type: "value", cell: "lit", rect: [-1, -1, 2, 0.8] },
                { type: "button", action: "Toggle", rect: [-1, 0.2, 2, 0.6] },
              ],
            },
          },
        },
      ],
    });
    act(() => w.ui.setCamera({ x: 20, y: 0, zoom: 1 }));
    await act(async () => {
      await w.ui.setViewer({ type: "character", id: "hero" });
    });
    await until(() => w.session.viewerKey() === "character:hero", "the character view");
    await waitFor(() => {
      const frame = lastFrame(w);
      expect(frame.some((c) => c.style?.fillStyle === COVER_FILL)).toBe(true);
      expect(frame.some((c) => c.style?.fillStyle === BUTTON_FILL)).toBe(true);
    });
    const frame = lastFrame(w).filter((c) => c.style !== undefined);
    const firstCover = frame.findIndex((c) => c.style?.fillStyle === COVER_FILL);
    const faceCalls = frame
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.style?.fillStyle === BUTTON_FILL || c.args[0] === "Toggle");
    expect(faceCalls.length).toBeGreaterThan(1);
    expect(faceCalls.every(({ i }) => i < firstCover)).toBe(true);
  }, 30_000);

  test("a faceless die just off screen has its on-screen button strip drawn and pressable", async () => {
    const w = await world({
      dice: [roll(4)],
      seed: [
        {
          type: "create_object",
          id: "die",
          to: at(40, -5.3),
          init: {
            shape: square(1),
            cells: { name: text("Die"), visible_to: ALL, value: { type: "empty" } },
            actions: [{ name: "Roll", steps: ["roll(1d20) -> value"] }],
          },
        },
      ],
    });
    // View y ∈ [-4.6875, 4.6875]: the footprint [-5.8, -4.8] is above it, the strip below it is in.
    act(() => w.ui.setCamera({ x: 40, y: 0, zoom: 1 }));
    await waitFor(() => expect(textsOf(lastFrame(w))).toContain("Roll"));
    const rect = buttonRect(w.faces().faces.get("die"), "Roll");
    if (rect === undefined) throw new Error("no strip button");
    const press = apply(w.faces().transforms.get("die") as Affine, centre(rect));
    expect(press[1]).toBeGreaterThan(-4.6875);
    w.click(press);
    await until(() => w.object("die")?.cells.value?.content.type === "roll", "the die's roll");
    expect(w.invokes()).toMatchObject([{ object: "die", action: "Roll" }]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cell drops

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
  const [x, y] = at ?? [0, 0];
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  act(() => {
    target.dispatchEvent(ev);
  });
}

/** Drags the inspector's row of `cell` (of the selected object) and drops it on the canvas at `p`. */
function dropRow(w: World, cell: string, p: Point) {
  const row = inspector().querySelector(`li[data-cell="${cell}"]`);
  if (row === null) throw new Error(`no row ${cell}`);
  const dt = new FakeDataTransfer();
  dispatchDrag(row, "dragstart", dt);
  dispatchDrag(w.canvas, "dragover", dt, w.screenOf(p));
  dispatchDrag(w.canvas, "drop", dt, w.screenOf(p));
}

const faceOf = (w: World, id: ObjectId) => w.object(id)?.face;

describe("cell drops", () => {
  test("dropping an inspector cell row on its object adds a face element, with select and with ink active", async () => {
    const w = await world({ seed: [GOBLIN] });
    await until(() => w.session.boardView()?.objects.has("goblin") === true, "the goblin");
    act(() => w.ui.select(["goblin"]));
    await waitFor(() => expect(inspector().querySelector('li[data-cell="ac"]')).not.toBeNull());

    expect(w.ui.getState().tool.id).toBe("select");
    expect(faceOf(w, "goblin")).toBeUndefined();
    dropRow(w, "ac", [6, 0]);
    // The first drop stores the default layout (name, ac) plus the dropped element.
    await until(() => faceOf(w, "goblin") !== undefined, "the goblin's face");
    const first = faceOf(w, "goblin")?.elements ?? [];
    expect(first.at(-1)).toMatchObject({ type: "value", cell: "ac" });

    act(() => w.ui.setTool("ink"));
    await settle();
    dropRow(w, "name", [6, 0.2]);
    await until(
      () => (faceOf(w, "goblin")?.elements.length ?? 0) === first.length + 1,
      "the second element",
    );
    expect(faceOf(w, "goblin")?.elements.at(-1)).toMatchObject({ type: "value", cell: "name" });
    expect(w.ui.getState().tool.id).toBe("ink");
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe("templates are not played", () => {
  test("a template on the board: its gear selects it with the banner; double-clicking it and Run in the inspector send no request", async () => {
    const w = await world({ seed: [TEMPLATE_TOKEN] });
    await until(() => w.session.boardView()?.objects.has("board_tpl") === true, "the template");
    const gear: Point = [6 + 0.5 + 0.15, -3 - 0.5 - 0.15];
    expect(faceHitAt(w.faces(), gear, w.ui.getState().camera)?.target).toEqual({
      type: "gear",
      id: "board_tpl",
    });
    await waitFor(() =>
      expect(lastFrame(w).some((c) => c.style?.fillStyle === "#55546a")).toBe(true),
    );
    w.click(gear);
    await waitFor(() => expect(w.ui.getState().selection).toEqual(["board_tpl"]));
    const banner = await screen.findByRole("status", { name: "Editing template" });
    expect(banner.textContent).toContain("Editing template Ogre");

    const revision = w.host.revision;
    const sent = w.session.client.request as unknown as { mock: { calls: unknown[] } };
    const before = sent.mock.calls.length;
    w.dblClick([6, -2.9]);
    await until(() => w.notices().includes(TEMPLATE_REFUSAL), "the template notice");

    const actions = within(inspector()).getByRole("region", { name: "Actions" });
    fireEvent.click(within(actions).getByRole("button", { name: "Run Hurt" }));
    await settle();
    expect(sent.mock.calls.length).toBe(before);
    expect(w.invokes()).toEqual([]);
    expect(w.host.revision).toBe(revision);
    expect(w.object("board_tpl")?.cells.hp?.content).toEqual(num(5));
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe("tools and panels", () => {
  test("L, D and W switch to the layout, ink and text tools; the toolbar lists them", async () => {
    const w = await world();
    const tools = screen.getByRole("toolbar", { name: "Tools" });
    for (const [label, key] of [
      ["Layout", "L"],
      ["Ink", "D"],
      ["Text", "W"],
    ] as const) {
      expect(within(tools).getByRole("button", { name: label }).getAttribute("title")).toBe(
        `${label} (${key})`,
      );
    }
    fireEvent.keyDown(document.body, { key: "l" });
    expect(w.ui.getState().tool.id).toBe("layout");
    fireEvent.keyDown(document.body, { key: "d" });
    expect(w.ui.getState().tool.id).toBe("ink");
    fireEvent.keyDown(document.body, { key: "w" });
    expect(w.ui.getState().tool.id).toBe("text");
    fireEvent.keyDown(document.body, { key: "v" });
    expect(w.ui.getState().tool.id).toBe("select");
  }, 30_000);

  test("the inspector shows the Face section and the action editor for a selected card", async () => {
    const w = await world();
    const copy = await expandTemplate(w, "tpl_attack");
    const panel = inspector();
    await waitFor(() => expect(within(panel).getByRole("region", { name: "Face" })).toBeDefined());
    const actions = within(panel).getByRole("region", { name: "Actions" });
    expect(within(actions).getByRole("button", { name: "Edit Roll" })).toBeDefined();
    expect(within(actions).getByRole("button", { name: "Run Roll" })).toBeDefined();
    const user = userEvent.setup();
    await user.click(within(actions).getByRole("button", { name: "Add action" }));
    expect(within(actions).getByRole("group", { name: "New action" })).toBeDefined();
    expect(w.ui.getState().selection).toEqual([copy]);
  }, 30_000);
});
