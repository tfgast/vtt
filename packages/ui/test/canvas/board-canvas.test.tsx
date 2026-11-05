import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  BoardCanvas,
  type Camera,
  COVER_FILL,
  createCanvas2DRenderer,
  ImageCache,
  type InteractionEvent,
  RecordingContext,
  type Renderer,
  type Scene,
  type ToolOverlay,
  type Viewport,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const RECT = { left: 10, top: 20, width: 800, height: 600 };
const CAMERA: Camera = { x: 5, y: 5, zoom: 1 };
const SCENE: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };
const NO_MODS = { shift: false, alt: false, ctrl: false, meta: false };

interface RenderCall {
  scene: Scene;
  overlays: readonly ToolOverlay[];
  camera: Camera;
  viewport: Viewport;
}

function fakeRenderer() {
  const calls: RenderCall[] = [];
  const dispose = vi.fn();
  const created: HTMLCanvasElement[] = [];
  const createRenderer = (canvas: HTMLCanvasElement): Renderer => {
    created.push(canvas);
    return {
      render: (scene, overlays, camera, viewport) =>
        calls.push({ scene, overlays, camera, viewport }),
      dispose,
    };
  };
  return { calls, dispose, created, createRenderer };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    x: RECT.left,
    y: RECT.top,
    right: RECT.left + RECT.width,
    bottom: RECT.top + RECT.height,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(extra: { overlay?: React.ReactNode; camera?: Camera } = {}) {
  const events: InteractionEvent[] = [];
  const viewports: Viewport[] = [];
  const fake = fakeRenderer();
  const utils = render(
    <BoardCanvas
      scene={SCENE}
      toolOverlays={[]}
      camera={extra.camera ?? CAMERA}
      createRenderer={fake.createRenderer}
      onEvent={(e) => events.push(e)}
      setViewport={(v) => viewports.push(v)}
      overlay={extra.overlay}
    />,
  );
  const canvas = utils.container.querySelector("canvas") as HTMLCanvasElement;
  return { ...utils, events, viewports, fake, canvas };
}

describe("BoardCanvas", () => {
  test("renders the scene through the injected renderer and reports the viewport", async () => {
    const { fake, viewports, canvas, unmount } = setup();
    expect(fake.created).toEqual([canvas]);
    await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
    const last = fake.calls.at(-1);
    expect(last?.scene).toBe(SCENE);
    expect(last?.camera).toEqual(CAMERA);
    expect(last?.viewport).toEqual({ width: 800, height: 600, dpr: 1 });
    expect(viewports).toEqual([{ width: 800, height: 600, dpr: 1 }]);
    unmount();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  test("re-renders when props change", async () => {
    const fake = fakeRenderer();
    const props = {
      scene: SCENE,
      toolOverlays: [] as ToolOverlay[],
      createRenderer: fake.createRenderer,
      onEvent: () => {},
    };
    const { rerender } = render(<BoardCanvas {...props} camera={CAMERA} />);
    await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
    const moved = { x: 9, y: 9, zoom: 2 };
    rerender(<BoardCanvas {...props} camera={moved} />);
    await waitFor(() => expect(fake.calls.at(-1)?.camera).toEqual(moved));
  });

  test("pointer down, move and up become pointer events in screen and board coordinates", () => {
    const { canvas, events } = setup();
    // Screen (400, 300) is the viewport center: board (5, 5).
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      clientX: 410,
      clientY: 320,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1,
      clientX: 474,
      clientY: 352,
      buttons: 1,
      shiftKey: true,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      clientX: 474,
      clientY: 352,
      button: 0,
      buttons: 0,
    });
    expect(events).toEqual([
      {
        type: "pointer_down",
        pointerId: 1,
        screen: [400, 300],
        board: [5, 5],
        button: 0,
        buttons: 1,
        modifiers: NO_MODS,
      },
      {
        type: "pointer_move",
        pointerId: 1,
        screen: [464, 332],
        board: [6, 5.5],
        button: -1,
        buttons: 1,
        modifiers: { ...NO_MODS, shift: true },
      },
      {
        type: "pointer_up",
        pointerId: 1,
        screen: [464, 332],
        board: [6, 5.5],
        button: 0,
        buttons: 0,
        modifiers: NO_MODS,
      },
    ]);
  });

  test("the pointer is captured during a drag", () => {
    const { canvas } = setup();
    const set = vi.fn();
    const release = vi.fn();
    Object.assign(canvas, { setPointerCapture: set, releasePointerCapture: release });
    fireEvent.pointerDown(canvas, { pointerId: 7, clientX: 10, clientY: 20 });
    expect(set).toHaveBeenCalledWith(7);
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 10, clientY: 20 });
    expect(release).toHaveBeenCalledWith(7);
  });

  test("double-click, wheel and keys reach onEvent", () => {
    const { canvas, events } = setup({ camera: { x: 0, y: 0, zoom: 2 } });
    fireEvent.doubleClick(canvas, { clientX: 538, clientY: 320, altKey: true });
    fireEvent.wheel(canvas, { clientX: 410, clientY: 320, deltaY: 3, deltaMode: 1 });
    fireEvent.keyDown(canvas, { key: "Delete", code: "Delete", ctrlKey: true });
    fireEvent.keyUp(canvas, { key: "Delete", code: "Delete" });
    expect(events).toEqual([
      {
        type: "double_click",
        screen: [528, 300],
        board: [1, 0],
        modifiers: { ...NO_MODS, alt: true },
      },
      {
        type: "wheel",
        screen: [400, 300],
        board: [0, 0],
        deltaX: 0,
        deltaY: 48,
        modifiers: NO_MODS,
      },
      {
        type: "key_down",
        key: "Delete",
        code: "Delete",
        modifiers: { ...NO_MODS, ctrl: true },
        inTextField: false,
      },
      { type: "key_up", key: "Delete", code: "Delete", modifiers: NO_MODS, inTextField: false },
    ]);
  });

  test("a key typed in an input of the overlay has inTextField", () => {
    const { events } = setup({ overlay: <input aria-label="editor" /> });
    fireEvent.keyDown(screen.getByLabelText("editor"), { key: "a", code: "KeyA" });
    expect(events).toEqual([
      { type: "key_down", key: "a", code: "KeyA", modifiers: NO_MODS, inTextField: true },
    ]);
  });

  test("overlay children render above the canvas", () => {
    const { canvas } = setup({ overlay: <div data-testid="editor">edit</div> });
    const editor = screen.getByTestId("editor");
    expect(canvas.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const layer = editor.parentElement as HTMLElement;
    expect(layer.style.position).toBe("absolute");
    expect(Number(layer.style.zIndex)).toBeGreaterThan(0);
  });

  function drop(
    target: Element,
    dataTransfer: { types: string[]; files?: File[]; getData?: (t: string) => string },
    at: [number, number],
  ) {
    const over = new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: at[0],
      clientY: at[1],
    });
    Object.defineProperty(over, "dataTransfer", {
      value: { files: [], getData: () => "", ...dataTransfer },
    });
    const ev = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: at[0],
      clientY: at[1],
    });
    Object.defineProperty(ev, "dataTransfer", {
      value: { files: [], getData: () => "", ...dataTransfer },
    });
    act(() => {
      target.dispatchEvent(over);
      target.dispatchEvent(ev);
    });
    return { over, ev };
  }

  test("a dropped file becomes a file_drop event at its board point", () => {
    const { canvas, events } = setup();
    const file = new File(["png"], "map.png", { type: "image/png" });
    const { over, ev } = drop(canvas, { types: ["Files"], files: [file] }, [474, 320]);
    expect(over.defaultPrevented).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(events).toEqual([
      { type: "file_drop", files: [file], screen: [464, 300], board: [6, 5] },
    ]);
  });

  test("a drop carrying application/x-vtt-cell data becomes a data_drop event", () => {
    const { canvas, events } = setup();
    const payload = JSON.stringify({ object: "o1", cell: "hp" });
    const { over } = drop(
      canvas,
      {
        types: ["text/plain", "application/x-vtt-cell"],
        getData: (t) => (t === "application/x-vtt-cell" ? payload : "hp"),
      },
      [410, 384],
    );
    expect(over.defaultPrevented).toBe(true);
    expect(events).toEqual([
      {
        type: "data_drop",
        mime: "application/x-vtt-cell",
        data: payload,
        screen: [400, 364],
        board: [5, 6],
      },
    ]);
  });

  test("a drop of something else is ignored", () => {
    const { canvas, events } = setup();
    const { over } = drop(canvas, { types: ["text/plain"], getData: () => "hi" }, [410, 320]);
    expect(over.defaultPrevented).toBe(false);
    expect(events).toEqual([]);
  });

  test("works with the real renderer over a recording context", async () => {
    const ctx = new RecordingContext();
    render(
      <BoardCanvas
        scene={{ ...SCENE, covers: [{ key: "all", wholeBoard: true }] }}
        toolOverlays={[]}
        camera={CAMERA}
        createRenderer={() =>
          createCanvas2DRenderer(ctx, { images: new ImageCache({ resolve: (p) => p }) })
        }
        onEvent={() => {}}
      />,
    );
    await waitFor(() =>
      expect(ctx.paints.some((c) => c.style?.fillStyle === COVER_FILL)).toBe(true),
    );
    expect(ctx.canvas).toMatchObject({ width: 800, height: 600 });
  });
});
