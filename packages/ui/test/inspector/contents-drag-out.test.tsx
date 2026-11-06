/**
 * Dragging an entry out of the inspector's contents list onto the canvas
 * (vtt-qf5.13; DESIGN.md §4.1 Containment, §4.6 The inspector, On the
 * canvas, M6-D13): the real `App` in jsdom against an in-process authority.
 * The entry's row is a drag source of `OBJECT_DRAG_MIME`; a drop on the
 * canvas moves the object onto the active board at the drop point, snapped
 * to half units while Snap is on, in one write.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { WireOp } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import {
  App,
  createAppRenderer,
  createFaceStateStore,
  createObjectDropHandler,
  createUiStore,
  OBJECT_DRAG_MIME,
  objectDragData,
  parseObjectDragData,
  RecordingContext,
  type TableSession,
  toScreen,
  type UiStore,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const VIEWPORT = { width: 800, height: 600 };
const BOARD = "gm_board";
const CAMERA = { x: 0, y: 0, zoom: 1 };

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

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await cleanupAuthorities();
  localStorage.clear();
});

const text = (value: string) => ({ type: "text" as const, value });

/** A goblin token at (6, 0) holding a die. */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "goblin",
    to: { type: "board", board: BOARD, position: [6, 0] },
    init: { shape: { type: "rect", width: 1, height: 1 }, cells: { name: text("Goblin") } },
  },
  {
    type: "create_object",
    id: "die",
    to: { type: "container", container: "goblin" },
    init: { shape: { type: "rect", width: 1, height: 1 }, cells: { name: text("d20") } },
  },
];

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

function dispatchDrag(target: Element, type: string, dt: FakeDataTransfer, at?: Point): boolean {
  const [x, y] = at ?? [0, 0];
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

const inspector = () => screen.getByRole("complementary", { name: "Inspector panel" });

async function world() {
  const authority = await startAuthority();
  const gm = await authority.client("seed");
  const seeded = await gm.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));
  const session: TableSession = authority.session();
  const ui: UiStore = createUiStore({ session });
  const ctx = new RecordingContext();
  const utils = render(
    <App
      session={session}
      ui={ui}
      faceState={createFaceStateStore()}
      createRenderer={(_canvas, { requestRedraw }) =>
        createAppRenderer(ctx, { resolve: (p) => p, requestRedraw })
      }
    />,
  );
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("goblin") === true, "the goblin's view");
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await waitFor(() => expect(ui.getState().camera.zoom).not.toBe(1));
  act(() => ui.setCamera(CAMERA));
  const store = authority.host.table.store;
  const screenOf = (board: Point): Point => toScreen(ui.getState().camera, board, VIEWPORT);

  /** Selects `container`, drags its entry `id` from the inspector and drops it on the canvas at `p`. */
  const dragOut = async (container: ObjectId, id: ObjectId, p: Point) => {
    act(() => ui.select([container]));
    const row = await waitFor(() => {
      const li = inspector().querySelector(
        `section[aria-label="Contents"] li[data-object="${id}"]`,
      );
      if (li === null) throw new Error(`no contents row ${id}`);
      return li;
    });
    const dt = new FakeDataTransfer();
    dispatchDrag(row, "dragstart", dt);
    const accepted = dispatchDrag(canvas, "dragover", dt, screenOf(p));
    dispatchDrag(canvas, "drop", dt, screenOf(p));
    return { dt, accepted };
  };

  return { session, ui, store, dragOut };
}

describe("dragging an entry out of the inspector's contents list", () => {
  test("drops the die on the board at the drop point, snapped while Snap is on", async () => {
    const w = await world();
    expect(w.ui.getState().snap).toBe(true);
    const { dt, accepted } = await w.dragOut("goblin", "die", [2.3, 1.2]);
    expect(dt.types).toContain(OBJECT_DRAG_MIME);
    expect(parseObjectDragData(dt.getData(OBJECT_DRAG_MIME))).toEqual({
      object: "die",
      container: "goblin",
    });
    expect(accepted).toBe(true);

    await until(() => (w.store.getObject("die")?.board ?? null) !== null, "the die on a board");
    const die = w.store.getObject("die");
    expect(die?.board).toBe(BOARD);
    expect(die?.cells.position?.content).toEqual({
      type: "list",
      items: [
        { type: "number", value: 2.5 },
        { type: "number", value: 1 },
      ],
    });
    expect(w.store.getObject("goblin")?.contents).toEqual([]);
    await until(() => w.session.boardView()?.objects.has("die") === true, "the die's view");
  }, 30_000);

  test("with Snap off the die lands exactly at the drop point", async () => {
    const w = await world();
    act(() => w.ui.setSnap(false));
    await w.dragOut("goblin", "die", [-2.25, 1.75]);
    await until(() => (w.store.getObject("die")?.board ?? null) !== null, "the die on a board");
    expect(w.store.getObject("die")?.cells.position?.content).toEqual({
      type: "list",
      items: [
        { type: "number", value: -2.25 },
        { type: "number", value: 1.75 },
      ],
    });
    expect(w.store.getObject("goblin")?.contents).toEqual([]);
  }, 30_000);
});

describe("objectDragData", () => {
  test("round-trips and rejects malformed data", () => {
    expect(parseObjectDragData(objectDragData("die", "goblin"))).toEqual({
      object: "die",
      container: "goblin",
    });
    expect(parseObjectDragData("die")).toBeNull();
    expect(parseObjectDragData(JSON.stringify({ object: "" }))).toBeNull();
    expect(parseObjectDragData(JSON.stringify({ object: "die", container: 3 }))).toBeNull();
  });

  test("the handler passes other mimes and drops without an active board", () => {
    const handler = createObjectDropHandler();
    const input = { activeBoard: null } as unknown as Parameters<typeof handler>[1];
    const event = {
      type: "data_drop" as const,
      mime: OBJECT_DRAG_MIME,
      data: objectDragData("die", "goblin"),
      screen: [0, 0] as Point,
      board: [0, 0] as Point,
    };
    expect(handler(event, input)).toBeNull();
    expect(handler({ ...event, mime: "application/x-vtt-cell" }, input)).toBeNull();
  });
});
