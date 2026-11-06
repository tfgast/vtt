/**
 * The minimap (vtt-qf5.19; DESIGN.md §4.3, §8.1) in jsdom with a recording
 * renderer: the view rectangle follows the camera, a click recenters the
 * camera on the board point under it at the current zoom, a drag keeps
 * recentring, the toggle collapses it, and it is hidden on an empty board.
 * Then the composed app against a real authority.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Point } from "@vtt/schema";
import {
  App,
  type Camera,
  type CreateRenderer,
  createCanvas2DRenderer,
  createMinimapRenderer,
  createUiStore,
  ImageCache,
  MINIMAP_SIZE,
  MINIMAP_VIEW_STROKE,
  Minimap,
  minimapFrame,
  minimapLayout,
  minimapRect,
  minimapToBoard,
  RecordingContext,
  visibleBounds,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, whenReady } from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };

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
});

const VIEWPORT = { width: 800, height: 600, dpr: 1 };
const ITEMS = [
  { bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 } },
  { bounds: { minX: 19, minY: 9, maxX: 21, maxY: 11 } },
];
const LAYOUT = minimapLayout({ minX: -1, minY: -1, maxX: 21, maxY: 11 }, MINIMAP_SIZE);

function recording() {
  const ctx = new RecordingContext();
  const created: HTMLCanvasElement[] = [];
  return {
    ctx,
    created,
    createRenderer: (canvas: HTMLCanvasElement) => {
      created.push(canvas);
      return createMinimapRenderer(ctx);
    },
  };
}

/** The last view rectangle stroked. */
function lastView(ctx: RecordingContext): unknown[] | undefined {
  return ctx.paints
    .filter((c) => c.name === "strokeRect" && c.style?.strokeStyle === MINIMAP_VIEW_STROKE)
    .at(-1)?.args;
}

function viewArgs(camera: Camera): number[] {
  const r = minimapRect(visibleBounds(camera, VIEWPORT), LAYOUT);
  return [r.x, r.y, r.width, r.height];
}

describe("Minimap", () => {
  test("draws the items and a view rectangle that follows the camera", () => {
    const rec = recording();
    const camera = { x: 0, y: 0, zoom: 1 };
    const props = { items: ITEMS, viewport: VIEWPORT, onRecenter: () => {} };
    const { rerender } = render(
      <Minimap {...props} camera={camera} createRenderer={rec.createRenderer} />,
    );
    expect(rec.created).toHaveLength(1);
    expect(rec.created[0]).toBe(screen.getByLabelText("Board overview"));
    const frame = minimapFrame({ items: ITEMS, camera, viewport: VIEWPORT, size: MINIMAP_SIZE });
    const fills = rec.ctx.paints.filter((c) => c.name === "fillRect").slice(-2);
    expect(fills.map((c) => c.args)).toEqual(
      frame?.items.map((r) => [r.x, r.y, r.width, r.height]),
    );
    expect(lastView(rec.ctx)).toEqual(viewArgs(camera));

    const moved = { x: 15, y: 8, zoom: 0.5 };
    rerender(<Minimap {...props} camera={moved} createRenderer={rec.createRenderer} />);
    expect(lastView(rec.ctx)).toEqual(viewArgs(moved));
    expect(lastView(rec.ctx)).not.toEqual(viewArgs(camera));
  });

  test("a click recenters on the board point under it; a drag keeps recentring", () => {
    const rec = recording();
    const onRecenter = vi.fn<(point: Point) => void>();
    render(
      <Minimap
        items={ITEMS}
        camera={{ x: 0, y: 0, zoom: 1 }}
        viewport={VIEWPORT}
        onRecenter={onRecenter}
        createRenderer={rec.createRenderer}
      />,
    );
    const canvas = screen.getByLabelText("Board overview");
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: 120,
      clientY: 40,
    });
    expect(onRecenter).toHaveBeenLastCalledWith(minimapToBoard([120, 40], LAYOUT));
    fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: 30, clientY: 70 });
    expect(onRecenter).toHaveBeenLastCalledWith(minimapToBoard([30, 70], LAYOUT));
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, buttons: 0, clientX: 30, clientY: 70 });
    fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 0, clientX: 90, clientY: 90 });
    expect(onRecenter).toHaveBeenCalledTimes(2);
  });

  test("a click maps the content point, inside the canvas's border", () => {
    const rec = recording();
    const onRecenter = vi.fn<(point: Point) => void>();
    render(
      <Minimap
        items={ITEMS}
        camera={{ x: 0, y: 0, zoom: 1 }}
        viewport={VIEWPORT}
        onRecenter={onRecenter}
        createRenderer={rec.createRenderer}
      />,
    );
    const canvas = screen.getByLabelText("Board overview");
    // A 1 px border: the bounding rect starts at the border's outer edge.
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 500,
      top: 300,
      x: 500,
      y: 300,
      width: 162,
      height: 122,
      right: 662,
      bottom: 422,
      toJSON: () => ({}),
    });
    Object.defineProperty(canvas, "clientLeft", { configurable: true, value: 1 });
    Object.defineProperty(canvas, "clientTop", { configurable: true, value: 1 });
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: 581,
      clientY: 361,
    });
    expect(onRecenter).toHaveBeenLastCalledWith(minimapToBoard([80, 60], LAYOUT));
  });

  test("the toggle collapses and reopens it", () => {
    const rec = recording();
    render(
      <Minimap
        items={ITEMS}
        camera={{ x: 0, y: 0, zoom: 1 }}
        viewport={VIEWPORT}
        onRecenter={() => {}}
        createRenderer={rec.createRenderer}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Minimap" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Board overview")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Board overview")).toBeDefined();
    expect(rec.created).toHaveLength(2);
  });

  test("is hidden when the board has no items", () => {
    const rec = recording();
    const { container } = render(
      <Minimap
        items={[]}
        camera={{ x: 0, y: 0, zoom: 1 }}
        viewport={VIEWPORT}
        onRecenter={() => {}}
        createRenderer={rec.createRenderer}
      />,
    );
    expect(container.innerHTML).toBe("");
    expect(rec.created).toHaveLength(0);
  });
});

describe("the app's minimap", () => {
  test("is hidden on an empty board, appears with an item and a click recenters the camera", async () => {
    const authority = await startAuthority();
    const session = authority.session();
    const ui = createUiStore({ session });
    const board = new RecordingContext();
    const createRenderer: CreateRenderer = (_canvas, { requestRedraw }) =>
      createCanvas2DRenderer(board, {
        images: new ImageCache({ resolve: (p) => p, onLoad: requestRedraw }),
      });
    const rec = recording();
    render(
      <App
        session={session}
        ui={ui}
        createRenderer={createRenderer}
        createMinimapRenderer={rec.createRenderer}
      />,
    );
    await whenReady(session);
    await screen.findByRole("tab", { name: "GM" });
    expect(screen.queryByRole("button", { name: "Minimap" })).toBeNull();

    const client = await authority.client("other");
    await client.transact([
      {
        type: "create_object",
        id: "a",
        to: { type: "board", board: "gm_board", position: [0, 0] },
        init: { shape: { type: "rect", width: 2, height: 2 } },
      },
      {
        type: "create_object",
        id: "b",
        to: { type: "board", board: "gm_board", position: [20, 10] },
        init: { shape: { type: "rect", width: 2, height: 2 } },
      },
    ]);
    const canvas = await screen.findByLabelText("Board overview");
    act(() => ui.setCamera({ x: 3, y: 4, zoom: 0.75 }));
    await waitFor(() => expect(lastView(rec.ctx)).toEqual(viewArgs({ x: 3, y: 4, zoom: 0.75 })));

    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: 140,
      clientY: 90,
    });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, buttons: 0, clientX: 140, clientY: 90 });
    const [x, y] = minimapToBoard([140, 90], LAYOUT);
    expect(ui.getState().camera).toEqual({ x, y, zoom: 0.75 });
  });
});
