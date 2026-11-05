/**
 * The composed app (vtt-3l6.17; DESIGN.md §7 Platform, Undo, §8.1, §4.4,
 * §4.6; PROTOCOL.md §2, §6; M4 plan Q9, Q14) in jsdom against a real
 * in-process authority, with the real Canvas2D renderer over a recording
 * context and `BoardCanvas` pointer events in screen coordinates.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SaveEvent, WebSocketConstructor, WebSocketLike, WireOp } from "@vtt/protocol";
import type { Point } from "@vtt/schema";
import {
  App,
  COVER_FILL,
  type CreateRenderer,
  createCanvas2DRenderer,
  createUiStore,
  FIT_MARGIN_PX,
  fitBounds,
  ImageCache,
  type RecordedCall,
  RecordingContext,
  SELECTION_STROKE,
  sessionNotices,
  type TableSession,
  toScreen,
  type UiStore,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket as NodeWs } from "ws";
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
  vi.unstubAllGlobals();
  await cleanupAuthorities();
  localStorage.clear();
});

const text = (value: string) => ({ type: "text" as const, value });
const on = (board: string, x: number, y: number) => ({
  type: "board" as const,
  board,
  position: [x, y] as [number, number],
});
const square = (side: number) => ({ type: "rect" as const, width: side, height: side });

interface Rendered {
  session: TableSession;
  ui: UiStore;
  ctx: RecordingContext;
  canvas: HTMLCanvasElement;
}

async function renderApp(authority: TestAuthority, session?: TableSession): Promise<Rendered> {
  const s = session ?? authority.session();
  const ui = createUiStore({ session: s });
  const ctx = new RecordingContext();
  const createRenderer: CreateRenderer = (_canvas, { requestRedraw }) =>
    createCanvas2DRenderer(ctx, {
      images: new ImageCache({ resolve: (p) => p, onLoad: requestRedraw }),
    });
  const utils = render(<App session={s} ui={ui} createRenderer={createRenderer} />);
  await whenReady(s);
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  return { session: s, ui, ctx, canvas };
}

/** The screen point of board point `p` under the store's current camera. */
function screenOf(ui: UiStore, p: Point): Point {
  return toScreen(ui.getState().camera, p, VIEWPORT);
}

function pointer(
  canvas: HTMLCanvasElement,
  type: "down" | "move" | "up",
  [x, y]: Point,
  button = 0,
) {
  const buttons = type === "up" ? 0 : button === 1 ? 4 : 1;
  const init = {
    pointerId: 1,
    clientX: x,
    clientY: y,
    button: type === "move" ? -1 : button,
    buttons,
  };
  act(() => {
    if (type === "down") fireEvent.pointerDown(canvas, init);
    else if (type === "move") fireEvent.pointerMove(canvas, init);
    else fireEvent.pointerUp(canvas, init);
  });
}

function clickAt(canvas: HTMLCanvasElement, p: Point) {
  pointer(canvas, "down", p);
  pointer(canvas, "up", p);
}

/** The recorded frames (each starts at the renderer's `clearRect`). */
function frames(ctx: RecordingContext): RecordedCall[][] {
  const out: RecordedCall[][] = [];
  for (const call of ctx.calls) {
    if (call.name === "clearRect") out.push([]);
    out.at(-1)?.push(call);
  }
  return out;
}

const isPaint = (c: RecordedCall) => c.style !== undefined;

describe("layout", () => {
  test("shows the GM board tab, the toolbar and an empty inspector", async () => {
    const authority = await startAuthority();
    await renderApp(authority);
    const tab = await screen.findByRole("tab", { name: "GM" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const toolbar = screen.getByRole("toolbar", { name: "Tools" });
    for (const name of [
      "Select",
      "Token",
      "Card",
      "Note",
      "Rectangle zone",
      "Circle zone",
      "Polygon zone",
      "Image",
    ]) {
      expect(within(toolbar).getByRole("button", { name })).toBeDefined();
    }
    expect(
      within(toolbar).getByRole("button", { name: "Select" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "View as" })).toBeDefined();
    const inspector = screen.getByRole("complementary", { name: "Inspector panel" });
    expect(within(inspector).getByText("Nothing selected")).toBeDefined();
    const bar = document.querySelector('[data-part="formula-bar"]');
    expect(bar?.textContent).toContain("No cell focused");
  });

  test("the fog toggle edits the zone tools' options through the UI store", async () => {
    const authority = await startAuthority();
    const { ui } = await renderApp(authority);
    const toolbar = screen.getByRole("toolbar", { name: "Tools" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Rectangle zone" }));
    expect(ui.getState().tool).toEqual({ id: "zone-rect", options: { fog: false } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Fog" }));
    expect(ui.getState().tool).toEqual({ id: "zone-rect", options: { fog: true } });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Circle zone" }));
    expect(ui.getState().tool).toEqual({ id: "zone-circle", options: { fog: true } });
    fireEvent.keyDown(document.body, { key: "p", code: "KeyP" });
    expect(ui.getState().tool).toEqual({ id: "zone-polygon", options: { fog: true } });
    fireEvent.keyDown(document.body, { key: "v", code: "KeyV" });
    expect(ui.getState().tool.id).toBe("select");
  });
});

describe("tools, undo and save", () => {
  test("a token made with the toolbar tool fills the inspector when clicked; Ctrl+Z undoes it with a notice", async () => {
    const authority = await startAuthority();
    const { ui, canvas } = await renderApp(authority);
    const created = () =>
      authority.host.table.store.objectsOnBoard(GM_BOARD).filter((id) => id.startsWith("token_"));

    fireEvent.click(screen.getByRole("button", { name: "Token" }));
    expect(ui.getState().tool.id).toBe("token");
    clickAt(canvas, screenOf(ui, [2, 1]));
    await until(() => created().length === 1, "the token");
    const [id] = created() as [string];
    await until(() => ui.getState().tool.id === "select", "the select tool");

    // Clear the selection, then click the token on the canvas.
    act(() => ui.select([]));
    const inspector = screen.getByRole("complementary", { name: "Inspector panel" });
    await within(inspector).findByText("Nothing selected");
    clickAt(canvas, screenOf(ui, [2, 1]));
    await waitFor(() => expect(ui.getState().selection).toEqual([id]));
    const object = await within(inspector).findByRole("region", { name: "Object" });
    expect(within(object).getByRole("heading", { name: "Token" })).toBeDefined();

    // Ctrl+Z undoes the creation and names it.
    fireEvent.keyDown(document.body, { key: "z", code: "KeyZ", ctrlKey: true });
    await until(() => created().length === 0, "the undo");
    expect(await screen.findByText("Undid: Create token")).toBeDefined();
  });

  test("Ctrl+S saves the file-backed table: a save event arrives and the status shows Saved", async () => {
    const authority = await startAuthority({ file: true });
    const { session } = await renderApp(authority);
    const events: SaveEvent[] = [];
    session.client.on("save", (e) => events.push(e));
    const notPrevented = fireEvent.keyDown(document.body, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
    });
    expect(notPrevented).toBe(false);
    await until(() => events.length > 0, "the save event");
    expect(events[0]?.status).toBe("saved");
    const status = screen.getByRole("contentinfo");
    await within(status).findByText("Saved");
  });

  test("the Save and Undo buttons save and undo", async () => {
    const authority = await startAuthority({ file: true });
    const { ui, canvas } = await renderApp(authority);
    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    clickAt(canvas, screenOf(ui, [0, 0]));
    const notes = () =>
      authority.host.table.store.objectsOnBoard(GM_BOARD).filter((id) => id.startsWith("note_"));
    await until(() => notes().length === 1, "the note");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await within(screen.getByRole("contentinfo")).findByText("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await until(() => notes().length === 0, "the undo");
    expect(await screen.findByText("Undid: Create note")).toBeDefined();
  });
});

describe("cameras", () => {
  test("pan board A, switch to B, return to A: A's camera is restored", async () => {
    const authority = await startAuthority();
    const gm = await authority.client("gm");
    await gm.transact([{ type: "add_board", id: "b2", name: "Second" }]);
    const { ui, canvas } = await renderApp(authority);
    await screen.findByRole("tab", { name: "Second" });

    // Middle-drag pans board A.
    pointer(canvas, "down", [400, 300], 1);
    pointer(canvas, "move", [300, 250], 1);
    pointer(canvas, "up", [300, 250], 1);
    const panned = { ...ui.getState().camera };
    expect(panned).not.toEqual({ x: 0, y: 0, zoom: 1 });

    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    await until(() => ui.activeBoard() === "b2", "board B");
    await until(
      () => ui.getState().camera.x !== panned.x || ui.getState().camera.y !== panned.y,
      "board B's camera",
    );

    fireEvent.click(screen.getByRole("tab", { name: "GM" }));
    await until(() => ui.activeBoard() === GM_BOARD, "board A");
    await waitFor(() => expect(ui.getState().camera).toEqual(panned));
  });

  test("the first visit of a board fits its items once its board view has arrived", async () => {
    const authority = await startAuthority();
    const gm = await authority.client("gm");
    await gm.transact([
      { type: "add_board", id: "crypt", name: "Crypt" },
      {
        type: "create_object",
        id: "far_a",
        to: on("crypt", 50, 40),
        init: { shape: square(2), cells: { name: text("A") } },
      },
      {
        type: "create_object",
        id: "far_b",
        to: on("crypt", 60, 44),
        init: { shape: square(2), cells: { name: text("B") } },
      },
    ]);
    const { ui } = await renderApp(authority);
    await waitFor(() => expect(ui.getState().camera).toEqual({ x: 0, y: 0, zoom: 1 }));
    fireEvent.click(await screen.findByRole("tab", { name: "Crypt" }));
    const fitted = fitBounds({ minX: 49, minY: 39, maxX: 61, maxY: 45 }, VIEWPORT, FIT_MARGIN_PX);
    await waitFor(() => expect(ui.getState().camera).toEqual(fitted));
  });
});

describe("notices", () => {
  test("dismissing a sticky error notice removes it", async () => {
    const authority = await startAuthority();
    const { session } = await renderApp(authority);
    act(() => {
      sessionNotices(session).push({ level: "error", text: "Something broke." });
    });
    const notice = await screen.findByText("Something broke.");
    const item = notice.closest("li");
    if (item === null) throw new Error("the notice is not a list item");
    fireEvent.click(within(item).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Something broke.")).toBeNull());
  });

  test("another client's concurrent write makes the app's drag a stale-write notice", async () => {
    const authority = await startAuthority();
    const other = await authority.client("other");
    await other.transact([
      { type: "create_object", id: "t1", to: on(GM_BOARD, 0, 0), init: { shape: square(1) } },
    ]);
    const { session, ui, canvas } = await renderApp(authority);
    await until(() => session.boardView()?.objects.has("t1") ?? false, "t1 in the board view");
    await waitFor(() =>
      expect(ui.getState().camera).toEqual(
        fitBounds({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }, VIEWPORT, FIT_MARGIN_PX),
      ),
    );

    const start = screenOf(ui, [0, 0]);
    pointer(canvas, "down", start);
    pointer(canvas, "move", [start[0] + 60, start[1]]);
    const result = await other.transact(
      [
        {
          type: "set_value",
          object: "t1",
          cell: "position",
          value: {
            type: "list",
            items: [
              { type: "number", value: 3 },
              { type: "number", value: 3 },
            ],
          },
        },
      ],
      { label: "Agent moves t1" },
    );
    if (result.status !== "committed") throw new Error("the concurrent write was rejected");
    await session.whenRevision(result.revision);
    pointer(canvas, "up", [start[0] + 60, start[1]]);

    const notice = await screen.findByText(/Not applied: the table changed first/);
    expect(notice.textContent).toContain('"Agent moves t1"');
    expect(notice.closest("li")?.getAttribute("data-kind")).toBe("stale");
  });
});

describe("connection", () => {
  test("a same-token transport drop shows the disconnected banner, which clears after resync", async () => {
    const authority = await startAuthority();
    const sockets: NodeWs[] = [];
    const Droppable: WebSocketConstructor = class implements WebSocketLike {
      readonly #ws: NodeWs;
      constructor(url: string) {
        this.#ws = new NodeWs(url);
        this.#ws.on("error", () => undefined);
        sockets.push(this.#ws);
      }
      send(data: string) {
        this.#ws.send(data);
      }
      close(code?: number, reason?: string) {
        this.#ws.close(code, reason);
      }
      // biome-ignore lint/suspicious/noExplicitAny: matches WebSocketLike
      addEventListener(type: string, listener: (event: any) => void) {
        this.#ws.addEventListener(type as "message", listener);
      }
    };
    const session = authority.session({ WebSocket: Droppable });
    await renderApp(authority, session);
    const status = screen.getByRole("contentinfo");
    await waitFor(() => expect(within(status).queryByText(/Disconnected/)).toBeNull());

    act(() => sockets.at(-1)?.terminate());
    await within(status).findByText(/Disconnected/);
    await waitFor(
      () => expect(within(status).queryByText(/Disconnected|Resynchronizing/)).toBeNull(),
      {
        timeout: 4000,
      },
    );
    expect(session.getSnapshot().ready).toBe(true);
    expect(sockets.length).toBeGreaterThan(1);
  });

  test("a restart with a new token reaches the terminal unauthorized state; Reload reloads the page", async () => {
    const authority = await startAuthority();
    await renderApp(authority);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await authority.restart({ token: "a-new-token" });
    const status = screen.getByRole("contentinfo");
    await within(status).findByText(/restarted with a new token/, undefined, { timeout: 8000 });
    fireEvent.click(within(status).getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("render order (DESIGN.md §4.4, §4.6; M4-D16)", () => {
  test("a selected token under a cover in a character view draws no outline after the cover", async () => {
    const authority = await startAuthority();
    const other = await authority.client("other");
    const setup: WireOp[] = [
      {
        type: "create_object",
        id: "hero",
        to: on(GM_BOARD, -10, 0),
        init: { is_character: true, shape: square(1), cells: { name: text("Hero") } },
      },
      {
        type: "create_object",
        id: "room",
        to: on(GM_BOARD, 5, 0),
        init: {
          is_zone: true,
          shape: square(4),
          cells: {
            visible_to: { type: "viewers", viewers: ["gm"] },
            opaque: { type: "boolean", value: true },
          },
        },
      },
      { type: "create_object", id: "inside", to: on(GM_BOARD, 5, 0), init: { shape: square(1) } },
      { type: "create_object", id: "outside", to: on(GM_BOARD, -5, 0), init: { shape: square(1) } },
    ];
    await other.transact(setup);
    const { session, ui, ctx } = await renderApp(authority);
    await until(() => session.boardView()?.objects.has("inside") ?? false, "the setup");
    act(() => ui.select(["inside", "outside"]));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "View as" }), "Hero");
    await until(() => session.viewerKey() === "character:hero", "the character view");
    expect(ui.getState().selection).toEqual(["inside", "outside"]);

    await waitFor(() => {
      const last = frames(ctx).at(-1) ?? [];
      expect(last.some((c) => isPaint(c) && c.style?.fillStyle === COVER_FILL)).toBe(true);
    });
    const frame = (frames(ctx).at(-1) ?? []).filter(isPaint);
    const firstCover = frame.findIndex((c) => c.style?.fillStyle === COVER_FILL);
    const outlines = frame
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.name === "stroke" && c.style?.strokeStyle === SELECTION_STROKE);
    // The visible selected token is outlined, before the covers.
    expect(outlines.length).toBeGreaterThan(0);
    expect(outlines.every(({ i }) => i < firstCover)).toBe(true);
  });
});
