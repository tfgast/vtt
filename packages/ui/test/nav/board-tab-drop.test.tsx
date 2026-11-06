/**
 * Dropping a canvas drag on a board tab (vtt-qf5.35; DESIGN.md §4.6 On the
 * canvas, M6-D27) in the composed app, in jsdom against a real in-process
 * authority. jsdom has no hit testing, so a release "over a tab" stubs
 * `document.elementFromPoint` to answer that tab for the release, as a
 * browser's hit test would while the canvas holds the pointer capture.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WebSocketConstructor, WebSocketLike, WireOp } from "@vtt/protocol";
import type { Point } from "@vtt/schema";
import {
  App,
  type CreateRenderer,
  createCanvas2DRenderer,
  createUiStore,
  ImageCache,
  RecordingContext,
  type TableSession,
  toScreen,
  type UiStore,
  undo,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  NodeWebSocket,
  startAuthority,
  until,
  whenReady,
} from "../support/authority";

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
  await cleanupAuthorities();
  localStorage.clear();
});

const text = (value: string) => ({ type: "text" as const, value });
const create = (
  id: string,
  position: Point,
  init: Extract<WireOp, { type: "create_object" }>["init"],
): WireOp => ({
  type: "create_object",
  id,
  to: { type: "board", board: "gm_board", position },
  init,
});

const SETUP: WireOp[] = [
  { type: "add_board", id: "crypt", name: "Crypt" },
  create("a", [1, 1], {
    shape: { type: "rect", width: 1, height: 1 },
    cells: { name: text("Aldric") },
  }),
  create("b", [3, 1], {
    shape: { type: "rect", width: 1, height: 1 },
    cells: { name: text("Brenna") },
  }),
  create("orc", [-3, -3], {
    is_template: true,
    shape: { type: "rect", width: 1, height: 1 },
    cells: { name: text("Orc") },
  }),
];

/** A `ws` client recording every transact the UI sends. */
function recordingWebSocket(sent: Sent[]): WebSocketConstructor {
  return class RecordingSocket implements WebSocketLike {
    readonly #inner: WebSocketLike;
    constructor(url: string) {
      this.#inner = new NodeWebSocket(url);
    }
    send(data: string): void {
      const frame = JSON.parse(data);
      if (frame.method === "transact") sent.push(frame.params);
      this.#inner.send(data);
    }
    close(code?: number, reason?: string): void {
      this.#inner.close(code, reason);
    }
    // biome-ignore lint/suspicious/noExplicitAny: matches WebSocketLike
    addEventListener(type: string, listener: (event: any) => void): void {
      this.#inner.addEventListener(type, listener);
    }
  };
}

interface Sent {
  base_revision: number;
  ops: WireOp[];
  label?: string;
}

interface Rendered {
  session: TableSession;
  ui: UiStore;
  canvas: HTMLCanvasElement;
  sent: Sent[];
}

async function renderApp(): Promise<Rendered> {
  const authority = await startAuthority();
  const other = await authority.client("other");
  await other.transact(SETUP);
  const sent: Sent[] = [];
  const session = authority.session({ WebSocket: recordingWebSocket(sent) });
  const ui = createUiStore({ session });
  const ctx = new RecordingContext();
  const createRenderer: CreateRenderer = (_canvas, { requestRedraw }) =>
    createCanvas2DRenderer(ctx, {
      images: new ImageCache({ resolve: (p) => p, onLoad: requestRedraw }),
    });
  const utils = render(<App session={session} ui={ui} createRenderer={createRenderer} />);
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("orc") === true, "the board view");
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  // Let the first-visit fit settle the camera before any screen point is computed.
  await act(() => new Promise<void>((r) => setTimeout(r, 50)));
  return { session, ui, canvas, sent };
}

const tab = (name: string) =>
  within(screen.getByRole("tablist", { name: "Boards" })).getByRole("tab", { name });

function pointer(canvas: HTMLCanvasElement, type: "down" | "move" | "up", [x, y]: Point) {
  const init = {
    pointerId: 1,
    clientX: x,
    clientY: y,
    button: type === "move" ? -1 : 0,
    buttons: type === "up" ? 0 : 1,
  };
  act(() => {
    if (type === "down") fireEvent.pointerDown(canvas, init);
    else if (type === "move") fireEvent.pointerMove(canvas, init);
    else fireEvent.pointerUp(canvas, init);
  });
}

/**
 * Presses board point `from`, drags beyond the threshold toward the top of
 * the canvas, and releases over `target` (the tab strip is above the canvas).
 */
function dragOntoTab(r: Rendered, from: Point, target: HTMLElement) {
  const start = toScreen(r.ui.getState().camera, from, VIEWPORT);
  pointer(r.canvas, "down", start);
  pointer(r.canvas, "move", [start[0], start[1] - 20]);
  pointer(r.canvas, "move", [start[0], 2]);
  const release: Point = [start[0], -10];
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number) => (x === release[0] && y === release[1] ? target : null),
  });
  try {
    pointer(r.canvas, "up", release);
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
}

const placeOf = (s: TableSession, id: string) => {
  const cells = s.directory().get(id)?.cells;
  return { board: cells?.board?.value, position: cells?.position?.value };
};
const at = (x: number, y: number) => ({
  type: "list",
  items: [
    { type: "number", value: x },
    { type: "number", value: y },
  ],
});

describe("dropping a drag on a board tab", () => {
  test("a move drop puts the dragged selection on that board at its positions, in one group, and activates it", async () => {
    const r = await renderApp();
    act(() => r.ui.select(["a", "b"]));
    const base = r.session.getSnapshot().revision;
    dragOntoTab(r, [1, 1], tab("Crypt"));

    await waitFor(() => expect(r.session.getSnapshot().activeBoard).toBe("crypt"));
    await waitFor(() => expect(tab("Crypt").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(r.session.boardView()?.objects.has("a")).toBe(true));
    expect(placeOf(r.session, "a")).toEqual({
      board: { type: "ref", object: "crypt" },
      position: at(1, 1),
    });
    expect(placeOf(r.session, "b")).toEqual({
      board: { type: "ref", object: "crypt" },
      position: at(3, 1),
    });
    expect(placeOf(r.session, "orc").board).toEqual({ type: "ref", object: "gm_board" });
    expect(r.ui.getState().selection).toEqual(["a", "b"]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({
      base_revision: base,
      label: "Move 2 objects to Crypt",
      ops: [
        { type: "move", object: "a", to: { type: "board", board: "crypt", position: [1, 1] } },
        { type: "move", object: "b", to: { type: "board", board: "crypt", position: [3, 1] } },
      ],
    });

    // One group: one undo puts both back.
    expect((await undo(r.session)).status).toBe("committed");
    await waitFor(() =>
      expect([placeOf(r.session, "a").board, placeOf(r.session, "b").board]).toEqual([
        { type: "ref", object: "gm_board" },
        { type: "ref", object: "gm_board" },
      ]),
    );
  });

  test("a template drag dropped on a tab spawns the copy on that board at its view's centre, in one group", async () => {
    const r = await renderApp();
    // Visit Crypt and leave it with a known camera, so it has a remembered view.
    const user = userEvent.setup();
    await user.click(tab("Crypt"));
    await waitFor(() => expect(r.session.boardView()?.board).toBe("crypt"));
    await act(() => new Promise<void>((res) => setTimeout(res, 50)));
    // A fractional centre, with Snap on (the default): the copy lands on it unsnapped.
    expect(r.ui.getState().snap).toBe(true);
    act(() => r.ui.setCamera({ x: 5.2, y: 7.3, zoom: 1.5 }));
    await user.click(tab("GM"));
    await waitFor(() => expect(r.session.boardView()?.objects.has("orc")).toBe(true));
    await act(() => new Promise<void>((res) => setTimeout(res, 50)));
    act(() => r.ui.select([]));

    const known = new Set(r.session.directory().keys());
    const base = r.session.getSnapshot().revision;
    dragOntoTab(r, [-3, -3], tab("Crypt"));

    await waitFor(() => expect(r.session.getSnapshot().activeBoard).toBe("crypt"));
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({
      base_revision: base,
      label: "Copy Orc",
      ops: [
        {
          type: "spawn",
          template: "orc",
          to: { type: "board", board: "crypt", position: [5.2, 7.3] },
        },
      ],
    });
    const copy = await waitFor(() => {
      const id = [...r.session.directory().keys()].find((k) => !known.has(k));
      expect(id).toBeDefined();
      return id as string;
    });
    expect(placeOf(r.session, copy)).toEqual({
      board: { type: "ref", object: "crypt" },
      position: at(5.2, 7.3),
    });
    // The template stays where it was; the copy is selected and shown on Crypt.
    expect(placeOf(r.session, "orc")).toEqual({
      board: { type: "ref", object: "gm_board" },
      position: at(-3, -3),
    });
    await waitFor(() => expect(r.ui.getState().selection).toEqual([copy]));
    await waitFor(() => expect(r.session.boardView()?.objects.has(copy)).toBe(true));
    // Crypt opens on the remembered camera the copy was centred in.
    expect(r.ui.getState().camera).toEqual({ x: 5.2, y: 7.3, zoom: 1.5 });

    // One group: one undo removes the copy.
    expect((await undo(r.session)).status).toBe("committed");
    await waitFor(() => expect(r.session.directory().has(copy)).toBe(false));
  });

  test("a drop on the active board's own tab does nothing", async () => {
    const r = await renderApp();
    act(() => r.ui.select(["a"]));
    dragOntoTab(r, [1, 1], tab("GM"));
    await act(() => new Promise<void>((res) => setTimeout(res, 100)));
    expect(r.sent).toEqual([]);
    expect(r.session.getSnapshot().activeBoard).toBe("gm_board");
    expect(placeOf(r.session, "a")).toEqual({
      board: { type: "ref", object: "gm_board" },
      position: at(1, 1),
    });

    // The same for a template drag: no copy.
    act(() => r.ui.select([]));
    const known = r.session.directory().size;
    dragOntoTab(r, [-3, -3], tab("GM"));
    await act(() => new Promise<void>((res) => setTimeout(res, 100)));
    expect(r.sent).toEqual([]);
    expect(r.session.directory().size).toBe(known);

    // The tool is idle again: a plain click still selects.
    const p = toScreen(r.ui.getState().camera, [3, 1], VIEWPORT);
    pointer(r.canvas, "down", p);
    pointer(r.canvas, "up", p);
    expect(r.ui.getState().selection).toEqual(["b"]);
  });
});
