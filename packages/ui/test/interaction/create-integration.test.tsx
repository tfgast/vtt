/**
 * The creation tools against a real in-process authority (vtt-3l6.8; M4-D13):
 * the shared helper with vtt-3l6.16's asset handler over a file-backed host,
 * the real session, `UiStore`, `RuntimeInputs`, tool context and write port,
 * and vtt-3l6.23's runtime with an injected `upload` that posts the file
 * with `uploadAsset` and reports a fixed measured size. The polygon test
 * draws through `BoardCanvas`, so the DOM's double-click order (down, up,
 * down, up, dblclick) is the real one.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createAssetHttpHandler } from "@vtt/authority";
import type { Point, TableObject } from "@vtt/schema";
import {
  BoardCanvas,
  createCanvas2DRenderer,
  createInteractionRuntime,
  createRuntimeInputs,
  createToolContext,
  createUiStore,
  ImageCache,
  type InteractionEvent,
  type InteractionRuntime,
  type Modifiers,
  RecordingContext,
  registerCreationTools,
  type Scene,
  type Tool,
  ToolRegistry,
  type ToolState,
  toScreen,
  type UploadedAsset,
  uploadAsset,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  startAuthority,
  type TestAuthority,
  until,
  whenReady,
} from "../support/authority";

const GM_BOARD = "gm_board";
const RECT = { left: 0, top: 0, width: 800, height: 600 };
const VIEWPORT = { width: 800, height: 600 };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const SHIFT: Modifiers = { ...NO_MODS, shift: true };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** What the injected upload reports as the measured size. */
const MEASURED = { width: 300, height: 200 };

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

/** A select tool that does nothing: the target of the creation tools' `set_tool`. */
const selectStub: Tool<null, "select"> = {
  id: "select",
  init: (options) => ({ tool: "select", options, phase: null }) as ToolState<null, "select">,
  cursor: () => "default",
  reduce: (state) => ({ state, effects: [] }),
  cancel: (state) => ({ state, effects: [] }),
};

/** A gate the injected upload waits on, so a test can act during an upload. */
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function setup(
  options: { holdUpload?: Promise<void>; measured?: { width: number; height: number } } = {},
) {
  const authority: TestAuthority = await startAuthority({
    file: true,
    http: (host) => [createAssetHttpHandler({ host })],
  });
  const base = `http://127.0.0.1:${authority.server.port}`;
  const gm = await authority.client("gm");
  await gm.transact([{ type: "add_board", id: "crypt", name: "Crypt" }]);

  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session });
  await ui.setActiveBoard(GM_BOARD);
  await until(() => session.getSnapshot().activeBoard === GM_BOARD, "the GM board");
  const uploads: { started: number } = { started: 0 };
  const upload = async (file: File): Promise<UploadedAsset> => {
    uploads.started++;
    const { path } = await uploadAsset(file, { token: authority.token, base });
    if (options.holdUpload !== undefined) await options.holdUpload;
    return { path, ...(options.measured ?? MEASURED) };
  };
  const picked: { file: File | null } = { file: null };
  const toolContext = createToolContext(session, ui, {
    pickFile: async () => picked.file,
    upload,
  });
  const registry = new ToolRegistry();
  registry.register(selectStub);
  registerCreationTools(registry);
  const runtime = createInteractionRuntime({
    registry,
    inputs: createRuntimeInputs(session, ui),
    toolContext,
    ui,
    editor: { open: () => undefined, close: () => undefined },
    whenRevision: (r) => session.whenRevision(r),
  });

  const object = (id: string): TableObject | undefined =>
    authority.host.table.store.getObject(id) as TableObject | undefined;
  const createdOn = (board: string): string[] =>
    authority.host.table.store.objectsOnBoard(board).filter((id) => /_\d+$/.test(id));
  const cellValue = (id: string, cell: string) => object(id)?.cells[cell]?.content;
  const position = (id: string) => {
    const content = cellValue(id, "position");
    if (content?.type !== "list") return null;
    return content.items.map((v) => (v.type === "number" ? v.value : Number.NaN));
  };
  return {
    authority,
    gm,
    session,
    ui,
    runtime,
    picked,
    uploads,
    object,
    createdOn,
    cellValue,
    position,
  };
}

function ptr(
  type: "pointer_down" | "pointer_up" | "pointer_move",
  board: Point,
  modifiers: Modifiers = NO_MODS,
): InteractionEvent {
  return {
    type,
    pointerId: 1,
    screen: toScreen({ x: 0, y: 0, zoom: 1 }, board, VIEWPORT),
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" ? 0 : 1,
    modifiers,
  };
}

function clickAt(runtime: InteractionRuntime, board: Point, modifiers: Modifiers = NO_MODS) {
  act(() => {
    runtime.dispatch(ptr("pointer_down", board, modifiers));
    runtime.dispatch(ptr("pointer_up", board, modifiers));
  });
}

const png = (name: string) => new File([PNG], name, { type: "image/png" });

describe("image tool", () => {
  test("a picked PNG becomes a selected image object sized from the measurement; back to select", async () => {
    const c = await setup();
    c.ui.setTool("image");
    c.picked.file = png("Crypt Map.png");
    clickAt(c.runtime, [2, -1]);
    await until(() => c.createdOn(GM_BOARD).length === 1, "the image object");
    const [id] = c.createdOn(GM_BOARD) as [string];
    expect(id).toMatch(/^image_\d+$/);
    const obj = c.object(id);
    expect(obj?.shape).toEqual({ type: "rect", width: 3, height: 2 });
    const image = c.cellValue(id, "image");
    expect(image?.type).toBe("text");
    const path = (image as { value: string }).value;
    expect(c.authority.host.assets).toContain(path);
    expect(c.cellValue(id, "name")).toEqual({ type: "text", value: "Crypt Map" });
    expect(c.position(id)).toEqual([2, -1]);
    await until(() => c.ui.getState().selection.includes(id), "the selection");
    expect(c.ui.getState().selection).toEqual([id]);
    await until(() => c.ui.getState().tool.id === "select", "the select tool");
    expect(c.runtime.machine().tool).toBe("select");
  });

  test("with Shift at the click, the tool stays", async () => {
    const c = await setup();
    c.ui.setTool("image");
    c.picked.file = png("tile.png");
    clickAt(c.runtime, [0, 0], SHIFT);
    await until(() => c.createdOn(GM_BOARD).length === 1, "the image object");
    const [id] = c.createdOn(GM_BOARD) as [string];
    await until(() => c.ui.getState().selection.includes(id), "the selection");
    expect(c.ui.getState().tool.id).toBe("image");
    expect(c.runtime.machine().tool).toBe("image");
  });

  test("switching boards during the upload still creates it on the original board, changing neither selection nor tool", async () => {
    const hold = gate();
    const c = await setup({ holdUpload: hold.promise });
    c.ui.setTool("image");
    c.picked.file = png("map.png");
    clickAt(c.runtime, [1, 1]);
    await until(() => c.uploads.started === 1, "the upload to start");
    await act(async () => {
      await c.ui.setActiveBoard("crypt");
    });
    await until(() => c.session.getSnapshot().activeBoard === "crypt", "the Crypt board");
    hold.open();
    await until(() => c.createdOn(GM_BOARD).length === 1, "the image object");
    expect(c.createdOn("crypt")).toEqual([]);
    const [id] = c.createdOn(GM_BOARD) as [string];
    expect(id).toMatch(/^image_\d+$/);
    // Let any continuation that would run do so.
    await c.session.whenRevision(c.authority.host.revision);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.ui.getState().selection).toEqual([]);
    expect(c.ui.getState().tool.id).toBe("image");
  });

  test("switching tools during the upload also creates it and leaves the new tool active", async () => {
    const hold = gate();
    const c = await setup({ holdUpload: hold.promise });
    c.ui.setTool("image");
    c.picked.file = png("map.png");
    clickAt(c.runtime, [1, 1]);
    await until(() => c.uploads.started === 1, "the upload to start");
    act(() => c.ui.setTool("zone-rect"));
    expect(c.runtime.machine().tool).toBe("zone-rect");
    hold.open();
    await until(() => c.createdOn(GM_BOARD).length === 1, "the image object");
    const [id] = c.createdOn(GM_BOARD) as [string];
    expect(c.object(id)?.shape).toEqual({ type: "rect", width: 3, height: 2 });
    await c.session.whenRevision(c.authority.host.revision);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.ui.getState().selection).toEqual([]);
    expect(c.ui.getState().tool.id).toBe("zone-rect");
    expect(c.runtime.machine().tool).toBe("zone-rect");
  });
});

describe("zone tools", () => {
  test("a fog rect zone is a zone, opaque and visible to the GM", async () => {
    const c = await setup();
    c.ui.setTool("zone-rect", { fog: true });
    act(() => {
      c.runtime.dispatch(ptr("pointer_down", [0, 0]));
      c.runtime.dispatch(ptr("pointer_move", [4, 2]));
      c.runtime.dispatch(ptr("pointer_up", [4, 2]));
    });
    await until(() => c.createdOn(GM_BOARD).length === 1, "the zone");
    const [id] = c.createdOn(GM_BOARD) as [string];
    expect(id).toMatch(/^zone_\d+$/);
    const obj = c.object(id);
    expect(obj?.is_zone).toBe(true);
    expect(obj?.shape).toEqual({ type: "rect", width: 4, height: 2 });
    expect(c.position(id)).toEqual([2, 1]);
    expect(c.cellValue(id, "opaque")).toEqual({ type: "boolean", value: true });
    expect(c.cellValue(id, "visible_to")).toEqual({ type: "viewers", viewers: ["gm"] });
    await until(() => c.ui.getState().selection.includes(id), "the selection");
    await until(() => c.ui.getState().tool.id === "select", "the select tool");
  });

  test("a polygon drawn on the canvas round-trips with the same world-space vertices", async () => {
    const c = await setup();
    c.ui.setTool("zone-polygon");
    const ctx = new RecordingContext();
    const empty: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };
    const utils = render(
      <BoardCanvas
        scene={empty}
        toolOverlays={[]}
        camera={{ x: 0, y: 0, zoom: 1 }}
        setViewport={c.ui.setViewport}
        createRenderer={() =>
          createCanvas2DRenderer(ctx, { images: new ImageCache({ resolve: (p) => p }) })
        }
        onEvent={(e) => c.runtime.dispatch(e)}
      />,
    );
    const canvas = utils.container.querySelector("canvas");
    if (canvas === null) throw new Error("no canvas");
    const world: Point[] = [
      [-1, -1],
      [3, -1],
      [4, 2],
      [0, 3],
    ];
    const screen = (p: Point) => toScreen({ x: 0, y: 0, zoom: 1 }, p, VIEWPORT);
    const domClick = (p: Point) => {
      const [x, y] = screen(p);
      fireEvent.pointerDown(canvas, {
        pointerId: 1,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
      });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x, clientY: y, button: 0, buttons: 0 });
    };
    act(() => {
      for (const p of world) domClick(p);
      // The double-click on the last vertex: a second click, then dblclick.
      const last = world.at(-1) as Point;
      domClick(last);
      const [x, y] = screen(last);
      fireEvent.dblClick(canvas, { clientX: x, clientY: y });
    });
    await until(() => c.createdOn(GM_BOARD).length === 1, "the polygon zone");
    const [id] = c.createdOn(GM_BOARD) as [string];
    const obj = c.object(id);
    expect(obj?.is_zone).toBe(true);
    const anchor = c.position(id) as number[];
    const shape = obj?.shape;
    if (shape?.type !== "polygon") throw new Error("not a polygon");
    const back = shape.points.map(([x, y]) => [x + (anchor[0] ?? 0), y + (anchor[1] ?? 0)]);
    expect(back).toHaveLength(world.length);
    back.forEach((p, i) => {
      expect(p[0]).toBeCloseTo((world[i] as Point)[0], 9);
      expect(p[1]).toBeCloseTo((world[i] as Point)[1], 9);
    });
    expect(anchor).toEqual([1.5, 1]);
  });

  test("Escape during a polygon draft creates nothing", async () => {
    const c = await setup();
    c.ui.setTool("zone-polygon");
    const before = c.authority.host.revision;
    clickAt(c.runtime, [0, 0]);
    clickAt(c.runtime, [3, 0]);
    clickAt(c.runtime, [1, 2]);
    expect(c.runtime.getView().overlays).toHaveLength(1);
    act(() => {
      c.runtime.dispatch({
        type: "key_down",
        key: "Escape",
        code: "Escape",
        modifiers: NO_MODS,
        inTextField: false,
      });
    });
    expect(c.runtime.getView().overlays).toEqual([]);
    act(() => {
      c.runtime.dispatch({
        type: "key_down",
        key: "Enter",
        code: "Enter",
        modifiers: NO_MODS,
        inTextField: false,
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.authority.host.revision).toBe(before);
    expect(c.createdOn(GM_BOARD)).toEqual([]);
  });
});

describe("creation with Snap (M6-D13, vtt-nb8.34)", () => {
  test("a zone dragged off the grid is stored on half units with Snap on", async () => {
    const c = await setup();
    expect(c.ui.getState().snap).toBe(true);
    c.ui.setTool("zone-rect");
    act(() => {
      c.runtime.dispatch(ptr("pointer_down", [0.1, -0.2]));
      c.runtime.dispatch(ptr("pointer_move", [2.4, 1.1]));
      c.runtime.dispatch(ptr("pointer_up", [3.3, 2.2]));
    });
    await until(() => c.createdOn(GM_BOARD).length === 1, "the zone");
    const [id] = c.createdOn(GM_BOARD) as [string];
    // Corners (0, 0) and (3.5, 2).
    expect(c.object(id)?.shape).toEqual({ type: "rect", width: 3.5, height: 2 });
    expect(c.position(id)).toEqual([1.75, 1]);
  });

  test("with Snap off the same drag is stored as drawn", async () => {
    const c = await setup();
    c.ui.setSnap(false);
    c.ui.setTool("zone-rect");
    act(() => {
      c.runtime.dispatch(ptr("pointer_down", [0.1, -0.2]));
      c.runtime.dispatch(ptr("pointer_up", [3.3, 2.2]));
    });
    await until(() => c.createdOn(GM_BOARD).length === 1, "the zone");
    const [id] = c.createdOn(GM_BOARD) as [string];
    const shape = c.object(id)?.shape;
    if (shape?.type !== "rect") throw new Error("not a rect");
    expect(shape.width).toBeCloseTo(3.2, 9);
    expect(shape.height).toBeCloseTo(2.4, 9);
  });

  test("a 250 × 130 px image keeps its exact size and lands on a half-unit anchor", async () => {
    const c = await setup({ measured: { width: 250, height: 130 } });
    c.ui.setTool("image");
    c.picked.file = png("odd.png");
    clickAt(c.runtime, [1.3, -0.8]);
    await until(() => c.createdOn(GM_BOARD).length === 1, "the image object");
    const [id] = c.createdOn(GM_BOARD) as [string];
    expect(c.object(id)?.shape).toEqual({ type: "rect", width: 2.5, height: 1.3 });
    expect(c.position(id)).toEqual([1.5, -1]);
  });
});
