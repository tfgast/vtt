// @vitest-environment node
/**
 * Local UI state, runtime inputs and the camera store (vtt-3l6.21; review r1
 * finding 10, r3 findings 2 and 11), against a real in-process authority
 * where the session matters.
 */
import type { WireOp } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import {
  type CameraPort,
  type CameraStorage,
  createCameraStore,
  createRuntimeInputs,
  createToolContext,
  createUiStore,
  createWritePort,
  type RuntimeInputs,
  sessionNotices,
  type TableSession,
  type ToolContext,
  type UiSession,
  type WritePort,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(cleanupAuthorities);

const token = (id: string, board = "gm_board", position: [number, number] = [1, 2]): WireOp => ({
  type: "create_object",
  id,
  to: { type: "board", board, position },
  init: { cells: { name: { type: "text", value: id } } },
});

/** A session stand-in for the pure store tests. */
function fakeSession(): UiSession & { watched: ObjectId[][] } {
  const watched: ObjectId[][] = [];
  const snapshot = {
    connection: null,
    ready: true,
    revision: 0,
    boards: [{ id: "gm_board", name: "GM" }],
    table: null,
    activeBoard: "gm_board",
    viewer: { type: "gm" as const },
    viewVersion: 0,
  };
  return {
    watched,
    getSnapshot: () => snapshot,
    setView: vi.fn(async () => undefined),
    watchObjects: async (ids) => {
      watched.push([...ids]);
    },
  };
}

async function ready(options: { file?: boolean } = {}) {
  const authority = await startAuthority(options);
  const gm = await authority.client("gm");
  const session = authority.session();
  await whenReady(session);
  return { authority, gm, session };
}

describe("UiStore", () => {
  test("defaults", () => {
    const ui = createUiStore({ session: fakeSession() });
    expect(ui.getState()).toEqual({
      selection: [],
      focusedCell: null,
      hover: null,
      hoveredCell: null,
      hoveredZone: null,
      altHover: null,
      highlight: [],
      tool: { id: "select", options: {} },
      camera: { x: 0, y: 0, zoom: 1 },
      viewport: { width: 0, height: 0, dpr: 1 },
    });
  });

  test("every setter notifies subscribers once and changes only its field", () => {
    const ui = createUiStore({ session: fakeSession() });
    const listener = vi.fn();
    ui.subscribe(listener);
    const steps: [() => void, (s: ReturnType<typeof ui.getState>) => unknown, unknown][] = [
      [() => ui.select(["a", "b"]), (s) => s.selection, ["a", "b"]],
      [
        () => ui.focusCell({ object: "a", cell: "hp" }),
        (s) => s.focusedCell,
        { object: "a", cell: "hp" },
      ],
      [() => ui.setHover("a"), (s) => s.hover, "a"],
      [
        () => ui.setHoveredCell({ object: "a", cell: "ac" }),
        (s) => s.hoveredCell,
        { object: "a", cell: "ac" },
      ],
      [() => ui.setHoveredZone("room"), (s) => s.hoveredZone, "room"],
      [() => ui.setAltHover("tok"), (s) => s.altHover, "tok"],
      [() => ui.setHighlight(["d1"]), (s) => s.highlight, ["d1"]],
      [() => ui.setTool("token"), (s) => s.tool, { id: "token", options: {} }],
      [() => ui.setCamera({ x: 3, y: 4, zoom: 2 }), (s) => s.camera, { x: 3, y: 4, zoom: 2 }],
      [
        () => ui.setViewport({ width: 800, height: 600, dpr: 2 }),
        (s) => s.viewport,
        { width: 800, height: 600, dpr: 2 },
      ],
    ];
    let calls = 0;
    for (const [run, read, expected] of steps) {
      const before = ui.getState();
      run();
      calls++;
      expect(listener).toHaveBeenCalledTimes(calls);
      const after = ui.getState();
      expect(after).not.toBe(before);
      expect(read(after)).toEqual(expected);
      // The same value again is no change.
      run();
      expect(listener).toHaveBeenCalledTimes(calls);
      expect(ui.getState()).toBe(after);
    }
    ui.setHover(null);
    ui.setHoveredZone(null);
    ui.setHoveredCell(null);
    ui.focusCell(null);
    expect(ui.getState()).toMatchObject({
      hover: null,
      hoveredZone: null,
      hoveredCell: null,
      focusedCell: null,
    });
  });

  test("an unsubscribed listener is not called", () => {
    const ui = createUiStore({ session: fakeSession() });
    const listener = vi.fn();
    const off = ui.subscribe(listener);
    off();
    ui.setHover("x");
    expect(listener).not.toHaveBeenCalled();
  });

  test("selection changes call session.watchObjects", () => {
    const session = fakeSession();
    const ui = createUiStore({ session });
    ui.select(["a", "b", "a"]);
    expect(ui.getState().selection).toEqual(["a", "b"]);
    ui.select([]);
    expect(session.watched).toEqual([["a", "b"], []]);
  });

  test("setTool keeps each tool's options", () => {
    const ui = createUiStore({ session: fakeSession() });
    ui.setTool("zone-rect", { fog: true });
    expect(ui.getState().tool).toEqual({ id: "zone-rect", options: { fog: true } });
    ui.setTool("select");
    expect(ui.getState().tool).toEqual({ id: "select", options: {} });
    ui.setTool("zone-rect");
    expect(ui.getState().tool).toEqual({ id: "zone-rect", options: { fog: true } });
    ui.setTool("zone-circle");
    expect(ui.getState().tool).toEqual({ id: "zone-circle", options: { fog: false } });
  });

  test("cameraPort reads and sets the store's camera", () => {
    const ui = createUiStore({ session: fakeSession() });
    const port: CameraPort = ui.cameraPort();
    expect(port.get()).toEqual({ x: 0, y: 0, zoom: 1 });
    const listener = vi.fn();
    ui.subscribe(listener);
    port.set({ x: 10, y: -2, zoom: 0.5 });
    expect(ui.getState().camera).toEqual({ x: 10, y: -2, zoom: 0.5 });
    expect(port.get()).toEqual({ x: 10, y: -2, zoom: 0.5 });
    expect(listener).toHaveBeenCalledTimes(1);
    ui.setCamera({ x: 1, y: 1, zoom: 1 });
    expect(port.get()).toEqual({ x: 1, y: 1, zoom: 1 });
  });

  test("activeBoard and viewer are read from and set through the session", async () => {
    const { gm, session } = await ready();
    await gm.transact([{ type: "add_board", id: "crypt", name: "Crypt" }]);
    await session.whenRevision(1);
    const ui = createUiStore({ session });
    expect(ui.activeBoard()).toBe("gm_board");
    expect(ui.viewer()).toEqual({ type: "gm" });
    await ui.setActiveBoard("crypt");
    expect(session.getSnapshot().activeBoard).toBe("crypt");
    expect(ui.activeBoard()).toBe("crypt");
  });
});

describe("type test", () => {
  test("the factories implement the contracts without casts", async () => {
    const { session } = await ready();
    const ui = createUiStore({ session });
    const write: WritePort = createWritePort(session);
    const camera: CameraPort = ui.cameraPort();
    const inputs: RuntimeInputs = createRuntimeInputs(session, ui);
    const context: ToolContext = createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "a.png", width: 1, height: 1 }),
    });
    expect([write, camera, inputs, context].every((x) => x !== null)).toBe(true);
  });
});

describe("RuntimeInputs", () => {
  async function inputsSetup() {
    const { authority, gm, session } = await ready();
    const ui = createUiStore({ session });
    const inputs = createRuntimeInputs(session, ui);
    return { authority, gm, session, ui, inputs };
  }

  test("reads the session and the UiStore", async () => {
    const { gm, session, ui, inputs } = await inputsSetup();
    expect(inputs.activeBoard()).toBe("gm_board");
    expect(inputs.viewer()).toEqual({ type: "gm" });
    expect(inputs.revision()).toBe(0);
    expect(inputs.views("t1")).toBeNull();
    ui.setViewport({ width: 640, height: 480, dpr: 1 });
    expect(inputs.viewport()).toEqual({ width: 640, height: 480, dpr: 1 });
    await gm.transact([token("t1")]);
    await session.whenRevision(1);
    expect(inputs.revision()).toBe(1);
    expect(inputs.views("t1")?.id).toBe("t1");
  });

  test("onChange fires on a commit, a board switch, a viewer switch and setViewport", async () => {
    const { gm, session, ui, inputs } = await inputsSetup();
    const fired = vi.fn();
    const off = inputs.onChange(fired);

    // A commit.
    await gm.transact([
      { type: "add_board", id: "crypt", name: "Crypt" },
      {
        type: "create_object",
        id: "aldric",
        to: { type: "board", board: "gm_board", position: [0, 0] },
        init: { is_character: true, cells: { name: { type: "text", value: "Aldric" } } },
      },
    ]);
    await until(() => fired.mock.calls.length > 0, "onChange after a commit");
    expect(inputs.revision()).toBe(1);

    // A board switch.
    fired.mockClear();
    await session.setView("crypt", { type: "gm" });
    expect(inputs.activeBoard()).toBe("crypt");
    expect(fired).toHaveBeenCalled();

    // A viewer switch.
    fired.mockClear();
    await session.setView("crypt", { type: "character", id: "aldric" });
    expect(inputs.viewer()).toEqual({ type: "character", id: "aldric" });
    expect(fired).toHaveBeenCalled();

    // setViewport.
    fired.mockClear();
    ui.setViewport({ width: 100, height: 100, dpr: 1 });
    expect(fired).toHaveBeenCalledTimes(1);
    ui.setViewport({ width: 100, height: 100, dpr: 1 });
    expect(fired).toHaveBeenCalledTimes(1);

    // Hover and selection are not inputs that fire onChange.
    fired.mockClear();
    ui.setHover("aldric");
    expect(fired).not.toHaveBeenCalled();

    off();
    ui.setViewport({ width: 200, height: 100, dpr: 1 });
    expect(fired).not.toHaveBeenCalled();
  });

  test("scene() reflects a commit, the selection and the highlight, and is memoized", async () => {
    const { gm, session, ui, inputs } = await inputsSetup();
    const empty = inputs.scene();
    expect(empty.items).toEqual([]);
    expect(inputs.scene()).toBe(empty);
    await gm.transact([token("t1"), token("t2", "gm_board", [5, 5])]);
    await session.whenRevision(1);
    const scene = inputs.scene();
    expect(scene.items.map((i) => i.id).sort()).toEqual(["t1", "t2"]);
    expect(inputs.scene()).toBe(scene);
    ui.select(["t1"]);
    const selected = inputs.scene();
    expect(selected).not.toBe(scene);
    expect(selected.objectOverlays).toContainEqual(
      expect.objectContaining({ kind: "selection", id: "t1" }),
    );
    ui.setHighlight(["t2"]);
    expect(inputs.scene().objectOverlays).toContainEqual(
      expect.objectContaining({ kind: "highlight", id: "t2" }),
    );
    // No previews and no hover outline.
    ui.setHover("t2");
    expect(inputs.scene().objectOverlays.some((o) => o.kind === "hover")).toBe(false);
  });

  test("scene() is empty with no active board", async () => {
    const { gm, session, inputs } = await inputsSetup();
    await gm.transact([{ type: "remove_board", id: "gm_board" }]);
    await until(() => session.getSnapshot().activeBoard === null, "no active board");
    expect(inputs.activeBoard()).toBeNull();
    expect(inputs.scene()).toEqual({ items: [], covers: [], objectOverlays: [], skipped: [] });
  });
});

describe("ToolContext", () => {
  test("assembles the ports: write, camera, notify and the session reads", async () => {
    const { session } = await ready();
    const ui = createUiStore({ session });
    const pickFile = vi.fn(async () => null);
    const upload = vi.fn(async () => ({ path: "x.png", width: 2, height: 3 }));
    const context = createToolContext(session, ui, { pickFile, upload });
    expect(context.activeBoard()).toBe("gm_board");
    expect(context.viewer()).toEqual({ type: "gm" });
    expect(context.revision()).toBe(0);
    context.camera.set({ x: 1, y: 2, zoom: 3 });
    expect(ui.getState().camera).toEqual({ x: 1, y: 2, zoom: 3 });
    context.notify("warning", "Heads up");
    expect(sessionNotices(session).list()).toMatchObject([{ level: "warning", text: "Heads up" }]);
    expect(await context.pickFile("image/*")).toBeNull();
    expect(pickFile).toHaveBeenCalledWith("image/*");
    const outcome = await context.write.write([token("t1")], { baseRevision: 0, label: "Token" });
    expect(outcome.status).toBe("committed");
  });
});

describe("camera store", () => {
  class MemoryStorage implements CameraStorage {
    readonly items = new Map<string, string>();
    getItem(key: string) {
      return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      this.items.set(key, value);
    }
  }

  async function boards(options: { file?: boolean } = {}) {
    const { authority, gm, session } = await ready(options);
    await gm.transact([{ type: "add_board", id: "b", name: "B" }]);
    await session.whenRevision(1);
    const ui = createUiStore({ session });
    return { authority, session, ui };
  }

  const switchTo = async (session: TableSession, board: string) => {
    await session.setView(board, { type: "gm" });
    expect(session.getSnapshot().activeBoard).toBe(board);
  };

  test("saves A on switching to B, restores A on return, marks an unseen board needsFit", async () => {
    const { session, ui } = await boards();
    const storage = new MemoryStorage();
    const cameras = createCameraStore({ ui, session, storage });
    const disconnect = cameras.connect();
    // The first board, never seen: needs a fit.
    expect(cameras.needsFit("gm_board")).toBe(true);
    cameras.clearNeedsFit("gm_board");
    expect(cameras.needsFit("gm_board")).toBe(false);
    ui.setCamera({ x: 5, y: 6, zoom: 2 });

    const marks = vi.fn();
    cameras.subscribe(marks);
    await switchTo(session, "b");
    expect(cameras.needsFit("b")).toBe(true);
    expect(marks).toHaveBeenCalled();
    ui.setCamera({ x: -1, y: -1, zoom: 0.5 });

    await switchTo(session, "gm_board");
    expect(ui.getState().camera).toEqual({ x: 5, y: 6, zoom: 2 });
    expect(cameras.needsFit("gm_board")).toBe(false);

    await switchTo(session, "b");
    expect(ui.getState().camera).toEqual({ x: -1, y: -1, zoom: 0.5 });
    expect(cameras.needsFit("b")).toBe(false);

    disconnect();
    ui.setCamera({ x: 9, y: 9, zoom: 1 });
    await switchTo(session, "gm_board");
    expect(ui.getState().camera).toEqual({ x: 9, y: 9, zoom: 1 });
  });

  test("save and restore persist through storage keyed by table and board", async () => {
    const { session, ui } = await boards({ file: true });
    const table = session.getSnapshot().table;
    const tableKey = table?.id ?? table?.path;
    expect(tableKey).toBeTruthy();
    const storage = new MemoryStorage();
    const first = createCameraStore({ ui, session, storage });
    expect(first.restore("b")).toBe(false);
    ui.setCamera({ x: 2, y: 3, zoom: 4 });
    first.save("b");
    const keys = [...storage.items.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(String(tableKey));
    expect(keys[0]).toContain("b");
    // A new store (a reload) restores from storage.
    ui.setCamera({ x: 0, y: 0, zoom: 1 });
    const second = createCameraStore({ ui, session, storage });
    expect(second.restore("b")).toBe(true);
    expect(ui.getState().camera).toEqual({ x: 2, y: 3, zoom: 4 });
    // Unreadable stored values are ignored.
    storage.items.set(keys[0] ?? "", "{not json");
    const third = createCameraStore({ ui, session, storage });
    expect(third.restore("b")).toBe(false);
  });

  test("tolerates a throwing localStorage", async () => {
    const { session, ui } = await boards({ file: true });
    const throwing: CameraStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    const cameras = createCameraStore({ ui, session, storage: throwing });
    const disconnect = cameras.connect();
    ui.setCamera({ x: 7, y: 8, zoom: 1.5 });
    await switchTo(session, "b");
    expect(cameras.needsFit("b")).toBe(true);
    await switchTo(session, "gm_board");
    // Remembered for this page even though storage refused it.
    expect(ui.getState().camera).toEqual({ x: 7, y: 8, zoom: 1.5 });
    expect(() => cameras.save("b")).not.toThrow();
    disconnect();
  });

  test("defaults to the global localStorage and tolerates its absence", async () => {
    const { session, ui } = await boards();
    const cameras = createCameraStore({ ui, session });
    expect(() => cameras.save("b")).not.toThrow();
    expect(cameras.restore("b")).toBe(true);
  });
});
