/**
 * The first-visit fit (review r3 finding 11): when the camera store marks
 * the active board `needsFit` and its board view has arrived, the camera is
 * fitted to the board's items (or centered on 0,0 for an empty board) and
 * the mark is cleared. Unit tests over fakes, and jsdom tests against a real
 * authority with the real camera store.
 */
import { cleanup, render } from "@testing-library/react";
import type { ObjectView, WireOp } from "@vtt/protocol";
import {
  type BoardViewState,
  type CameraStore,
  createCameraStore,
  createUiStore,
  FIT_MARGIN_PX,
  firstVisitCamera,
  fitBounds,
  type SessionSnapshot,
  startFirstVisitFit,
  type TableSession,
  type UiStore,
  useFirstVisitFit,
} from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

const VIEWPORT = { width: 800, height: 600, dpr: 1 };

function view(id: string, board: string, x: number, y: number, width?: number): ObjectView {
  return {
    id,
    is_template: false,
    is_character: false,
    actions: [],
    cells: {
      board: { kind: "structural", value: { type: "ref", object: board } },
      position: {
        kind: "literal",
        value: {
          type: "list",
          items: [
            { type: "number", value: x },
            { type: "number", value: y },
          ],
        },
      },
      ...(width === undefined
        ? {}
        : {
            shape: {
              kind: "literal" as const,
              value: {
                type: "shape" as const,
                shape: { type: "rect" as const, width, height: width },
              },
            },
          }),
    },
  } as ObjectView;
}

describe("firstVisitCamera", () => {
  test("fits the union of the items' bounds", () => {
    const objects = new Map([
      ["a", view("a", "b1", 0, 0, 2)],
      ["b", view("b", "b1", 10, 4)],
      ["c", view("c", "other", 100, 100)],
    ]);
    const camera = firstVisitCamera(
      { board: "b1", objects, covers: new Map(), revision: 1 },
      { type: "gm" },
      VIEWPORT,
    );
    expect(camera).toEqual(
      fitBounds({ minX: -1, minY: -1, maxX: 10, maxY: 4 }, VIEWPORT, FIT_MARGIN_PX),
    );
  });

  test("an empty board is centered on 0,0", () => {
    const camera = firstVisitCamera(
      { board: "b1", objects: new Map(), covers: new Map(), revision: 1 },
      { type: "gm" },
      VIEWPORT,
    );
    expect(camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

/** A fake session whose snapshot and board view the test sets. */
function fakeSession() {
  const listeners = new Set<() => void>();
  let snapshot = { activeBoard: "b1", viewer: { type: "gm" } } as unknown as SessionSnapshot;
  let current: BoardViewState | null = null;
  return {
    session: {
      getSnapshot: () => snapshot,
      subscribe(fn: () => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      boardView: () => current,
    } as Pick<TableSession, "getSnapshot" | "subscribe" | "boardView">,
    set(next: { activeBoard?: string | null; view?: BoardViewState | null }) {
      if (next.activeBoard !== undefined) {
        snapshot = { ...snapshot, activeBoard: next.activeBoard };
      }
      if (next.view !== undefined) current = next.view;
      for (const fn of [...listeners]) fn();
    },
  };
}

function fakeCameraStore(marked: Set<string>) {
  const listeners = new Set<() => void>();
  const store: Pick<CameraStore, "needsFit" | "clearNeedsFit" | "subscribe"> = {
    needsFit: (b) => marked.has(b),
    clearNeedsFit(b) {
      marked.delete(b);
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return store;
}

describe("startFirstVisitFit", () => {
  test("waits until the active board's view arrives, then fits once and clears the mark", () => {
    const fake = fakeSession();
    const ui = createUiStore({
      session: fake.session as unknown as TableSession,
      viewport: VIEWPORT,
    });
    const marked = new Set(["b1"]);
    const stop = startFirstVisitFit({
      session: fake.session,
      ui,
      cameraStore: fakeCameraStore(marked),
    });
    expect(ui.getState().camera).toEqual({ x: 0, y: 0, zoom: 1 });
    // Another board's view is not this board's.
    fake.set({
      view: {
        board: "b0",
        objects: new Map([["x", view("x", "b0", 50, 50)]]),
        covers: new Map(),
        revision: 1,
      },
    });
    expect(ui.getState().camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(marked.has("b1")).toBe(true);

    const objects = new Map([
      ["a", view("a", "b1", 4, 4)],
      ["b", view("b", "b1", 8, 6)],
    ]);
    fake.set({ view: { board: "b1", objects, covers: new Map(), revision: 2 } });
    expect(ui.getState().camera).toEqual(
      fitBounds({ minX: 4, minY: 4, maxX: 8, maxY: 6 }, VIEWPORT, FIT_MARGIN_PX),
    );
    expect(marked.has("b1")).toBe(false);

    // Panned afterwards: later view changes do not fit again.
    ui.setCamera({ x: 100, y: 100, zoom: 2 });
    fake.set({ view: { board: "b1", objects: new Map(objects), covers: new Map(), revision: 3 } });
    expect(ui.getState().camera).toEqual({ x: 100, y: 100, zoom: 2 });
    stop();
  });

  test("a board that is not marked is left alone; stopping unsubscribes", () => {
    const fake = fakeSession();
    const ui = createUiStore({
      session: fake.session as unknown as TableSession,
      viewport: VIEWPORT,
    });
    const marked = new Set<string>();
    const store = fakeCameraStore(marked);
    const stop = startFirstVisitFit({ session: fake.session, ui, cameraStore: store });
    fake.set({
      view: {
        board: "b1",
        objects: new Map([["a", view("a", "b1", 9, 9)]]),
        covers: new Map(),
        revision: 1,
      },
    });
    expect(ui.getState().camera).toEqual({ x: 0, y: 0, zoom: 1 });
    stop();
    marked.add("b1");
    fake.set({});
    expect(ui.getState().camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

// ---------------------------------------------------------------------------
// Against a real authority, with the real camera store.

const at = (board: string, x: number, y: number) => ({
  type: "board" as const,
  board,
  position: [x, y] as [number, number],
});

const SETUP: WireOp[] = [
  {
    type: "create_object",
    id: "a",
    to: at("gm_board", 2, 3),
    init: { shape: { type: "rect", width: 2, height: 2 } },
  },
  { type: "create_object", id: "b", to: at("gm_board", 12, 9) },
  { type: "add_board", id: "crypt", name: "Crypt" },
  { type: "create_object", id: "c", to: at("crypt", -10, -10) },
  { type: "create_object", id: "d", to: at("crypt", 30, 20) },
];

function Fit(props: { session: TableSession; ui: UiStore; cameraStore: CameraStore }) {
  useFirstVisitFit(props);
  return null;
}

async function setup() {
  const authority = await startAuthority();
  const other = await authority.client("other");
  await other.transact(SETUP);
  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session, viewport: VIEWPORT });
  const cameraStore = createCameraStore({ ui, session, storage: null });
  return { session, ui, cameraStore, other };
}

describe("useFirstVisitFit", () => {
  test("fits each board's items on its first visit, and a revisited board keeps its camera", async () => {
    const t = await setup();
    render(<Fit session={t.session} ui={t.ui} cameraStore={t.cameraStore} />);
    const disconnect = t.cameraStore.connect();
    const gmFit = fitBounds({ minX: 1, minY: 2, maxX: 12, maxY: 9 }, VIEWPORT, FIT_MARGIN_PX);
    await until(() => t.ui.getState().camera.x === gmFit.x, "the GM board fit");
    expect(t.ui.getState().camera).toEqual(gmFit);
    expect(t.cameraStore.needsFit("gm_board")).toBe(false);

    t.ui.setCamera({ x: 7, y: 7, zoom: 3 });
    await t.ui.setActiveBoard("crypt");
    const cryptFit = fitBounds(
      { minX: -10, minY: -10, maxX: 30, maxY: 20 },
      VIEWPORT,
      FIT_MARGIN_PX,
    );
    await until(() => t.ui.getState().camera.x === cryptFit.x, "the Crypt fit");
    expect(t.ui.getState().camera).toEqual(cryptFit);

    await t.ui.setActiveBoard("gm_board");
    await until(() => t.session.getSnapshot().activeBoard === "gm_board", "back on gm_board");
    expect(t.ui.getState().camera).toEqual({ x: 7, y: 7, zoom: 3 });
    disconnect();
  });

  test("does nothing for a board whose camera was restored", async () => {
    const t = await setup();
    t.ui.setCamera({ x: -4, y: 5, zoom: 0.5 });
    t.cameraStore.save("gm_board");
    t.ui.setCamera({ x: 0, y: 0, zoom: 1 });
    render(<Fit session={t.session} ui={t.ui} cameraStore={t.cameraStore} />);
    const disconnect = t.cameraStore.connect();
    expect(t.cameraStore.needsFit("gm_board")).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.ui.getState().camera).toEqual({ x: -4, y: 5, zoom: 0.5 });
    disconnect();
  });

  test("an empty board is centered on 0,0", async () => {
    const t = await setup();
    await t.other.transact([{ type: "add_board", id: "attic", name: "Attic" }]);
    await until(() => t.session.getSnapshot().boards.some((b) => b.id === "attic"), "attic");
    render(<Fit session={t.session} ui={t.ui} cameraStore={t.cameraStore} />);
    const disconnect = t.cameraStore.connect();
    await until(() => !t.cameraStore.needsFit("gm_board"), "the GM board fit");
    t.ui.setCamera({ x: 3, y: 3, zoom: 2 });
    await t.ui.setActiveBoard("attic");
    await until(() => !t.cameraStore.needsFit("attic"), "the Attic fit");
    expect(t.ui.getState().camera).toEqual({ x: 0, y: 0, zoom: 1 });
    disconnect();
  });
});
