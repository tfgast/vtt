/**
 * The board canvas (DESIGN.md §7 Platform; M4 plan Q16, Q18; review r1
 * finding 2): a `<canvas>` sized to its container, drawn by a `Renderer` on
 * animation frames, and the source of vtt-3l6.22's `InteractionEvent`s in
 * screen coordinates (CSS pixels from the canvas's top-left corner) and board
 * coordinates under the current camera. `overlay` is an absolutely positioned
 * DOM layer over the canvas (the in-place editor, vtt-3l6.13).
 *
 * Keys come from the container (focus inside the canvas or its overlay),
 * except Space, which is heard on the window so Space-drag pans wherever
 * focus is (M6-D11): a Space pressed in a text field (`isTextField`: a
 * text-taking input, a textarea or contenteditable) is ignored (and never
 * prevented, so it types), and a Space released anywhere ends a held Space.
 * A Space pressed with focus inside the container carries `canvasFocused`.
 * A key_down `onEvent` answers with `true` is prevented (vtt-qf5.26).
 */
import type { Point } from "@vtt/schema";
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef } from "react";
import { isTextField } from "../app/keybindings";
import type { Viewport } from "../interaction/contracts";
import type { BoardTabDrop, InteractionEvent, Modifiers } from "../interaction/events";
import type { ToolOverlay } from "../interaction/overlays";
import { createCanvas2DRenderer } from "../render/canvas2d";
import { ImageCache } from "../render/image-cache";
import type { Renderer } from "../render/renderer";
import { type Camera, toBoard } from "../scene/camera";
import type { Scene } from "../scene/scene";

export interface CreateRendererOptions {
  /** Schedules a redraw with the current props (for an image cache's `onLoad`). */
  requestRedraw: () => void;
}

export type CreateRenderer<S extends Scene = Scene> = (
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions,
) => Renderer<S>;

export interface BoardCanvasProps<S extends Scene = Scene> {
  scene: S;
  toolOverlays: readonly ToolOverlay[];
  camera: Camera;
  /**
   * Receives every event. Returning `true` for a key_down (the runtime's
   * `dispatch` does when a tool answered the key, vtt-qf5.26) prevents the
   * key's browser default, so a Tab the face focus takes stays on the canvas.
   */
  onEvent: (event: InteractionEvent) => unknown;
  /**
   * Called once on mount; the renderer is disposed on unmount. Defaults to the
   * Canvas2D renderer over the canvas's 2D context with an `ImageCache` that
   * loads asset paths as given.
   */
  createRenderer?: CreateRenderer<S>;
  /** Receives the canvas's size and device pixel ratio on mount and whenever they change. */
  setViewport?: (viewport: Viewport) => void;
  /** DOM children positioned absolutely, in screen coordinates, above the canvas. */
  overlay?: ReactNode;
  /**
   * The board tab at a client point, if any (vtt-qf5.35). Asked on every
   * `pointer_up`, whose event then carries it as `boardTab`: the canvas
   * captures the pointer, so a release over the tab strip still reaches it.
   */
  boardTabAt?: (clientX: number, clientY: number) => BoardTabDrop | null;
}

/** CSS pixels per wheel line (`deltaMode` 1). */
export const WHEEL_LINE_PX = 16;

const VTT_MIME_PREFIX = "application/x-vtt-";

export const defaultCreateRenderer: CreateRenderer = (canvas, { requestRedraw }) => {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("BoardCanvas: the canvas has no 2D context");
  return createCanvas2DRenderer(ctx, {
    images: new ImageCache({ resolve: (path) => path, onLoad: requestRedraw }),
  });
};

function modifiers(e: MouseEvent | KeyboardEvent): Modifiers {
  return { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
}

function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

function isSpaceKey(e: KeyboardEvent): boolean {
  return e.code === "Space" || e.key === " ";
}

function typesOf(dt: DataTransfer | null): string[] {
  return dt?.types ? Array.from(dt.types) : [];
}

const CONTAINER_STYLE: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
};
const CANVAS_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: "100%",
  height: "100%",
  display: "block",
  touchAction: "none",
  userSelect: "none",
  outline: "none",
};
const OVERLAY_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  overflow: "visible",
  zIndex: 1,
};

export function BoardCanvas<S extends Scene = Scene>(props: BoardCanvasProps<S>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  const scheduleRef = useRef<() => void>(() => {});

  // Latest props for event handlers and frames; every commit requests a frame.
  useLayoutEffect(() => {
    propsRef.current = props;
    scheduleRef.current();
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) return;
    let viewport: Viewport = { width: 0, height: 0, dpr: 1 };
    let frame: number | null = null;
    let disposed = false;
    const raf =
      typeof window.requestAnimationFrame === "function"
        ? (cb: () => void) => window.requestAnimationFrame(cb)
        : (cb: () => void) => window.setTimeout(cb, 16);
    const cancel =
      typeof window.cancelAnimationFrame === "function"
        ? (id: number) => window.cancelAnimationFrame(id)
        : (id: number) => window.clearTimeout(id);

    const draw = () => {
      frame = null;
      if (disposed) return;
      const p = propsRef.current;
      renderer.render(p.scene, p.toolOverlays, p.camera, viewport);
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = raf(draw);
    };
    const createRenderer = propsRef.current.createRenderer ?? defaultCreateRenderer;
    const renderer = createRenderer(canvas, { requestRedraw: schedule });
    scheduleRef.current = schedule;

    const measure = () => {
      const rect = container.getBoundingClientRect();
      const next = { width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 };
      if (
        next.width === viewport.width &&
        next.height === viewport.height &&
        next.dpr === viewport.dpr
      ) {
        return;
      }
      viewport = next;
      propsRef.current.setViewport?.(next);
      schedule();
    };

    const emit = (event: InteractionEvent) => propsRef.current.onEvent(event);
    const at = (clientX: number, clientY: number): { screen: Point; board: Point } => {
      const rect = canvas.getBoundingClientRect();
      const screen: Point = [clientX - rect.left, clientY - rect.top];
      const size = { width: rect.width, height: rect.height };
      return { screen, board: toBoard(propsRef.current.camera, screen, size) };
    };

    const pointer =
      (type: "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel") =>
      (e: PointerEvent) => {
        if (type === "pointer_down") {
          canvas.focus({ preventScroll: true });
          if (typeof canvas.setPointerCapture === "function") {
            try {
              canvas.setPointerCapture(e.pointerId);
            } catch {
              // Not an active pointer: nothing to capture.
            }
          }
        }
        if (
          (type === "pointer_up" || type === "pointer_cancel") &&
          typeof canvas.releasePointerCapture === "function"
        ) {
          try {
            canvas.releasePointerCapture(e.pointerId);
          } catch {
            // Not captured.
          }
        }
        const boardTab =
          type === "pointer_up"
            ? (propsRef.current.boardTabAt?.(e.clientX, e.clientY) ?? null)
            : null;
        emit({
          type,
          pointerId: e.pointerId,
          ...at(e.clientX, e.clientY),
          button: type === "pointer_move" ? -1 : e.button,
          buttons: e.buttons,
          modifiers: modifiers(e),
          ...(boardTab === null ? {} : { boardTab }),
        });
      };
    const onDoubleClick = (e: MouseEvent) =>
      emit({ type: "double_click", ...at(e.clientX, e.clientY), modifiers: modifiers(e) });
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unitX = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? viewport.width : 1;
      const unitY = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? viewport.height : 1;
      emit({
        type: "wheel",
        ...at(e.clientX, e.clientY),
        deltaX: e.deltaX * unitX,
        deltaY: e.deltaY * unitY,
        modifiers: modifiers(e),
      });
    };
    /** Emits a key event; a key_down the receiver answers with `true` is prevented. */
    const keyEvent = (
      type: "key_down" | "key_up",
      e: KeyboardEvent,
      textField: boolean,
      canvasFocused?: boolean,
    ) => {
      const handled = emit({
        type,
        key: e.key,
        code: e.code,
        modifiers: modifiers(e),
        inTextField: textField,
        ...(canvasFocused === true ? { canvasFocused } : {}),
      });
      if (type === "key_down" && handled === true) e.preventDefault();
    };
    // Space is the window listener's.
    const key = (type: "key_down" | "key_up") => (e: KeyboardEvent) => {
      if (!isSpaceKey(e)) keyEvent(type, e, inTextField(e.target));
    };
    const onSpace = (type: "key_down" | "key_up") => (e: KeyboardEvent) => {
      if (!isSpaceKey(e)) return;
      // Text-taking fields only: a focused checkbox or button still lets Space pan.
      if (type === "key_down" && isTextField(e.target)) return;
      const focused =
        type === "key_down" && e.target instanceof Node && container.contains(e.target);
      keyEvent(type, e, false, focused);
    };
    const onWindowKeyDown = onSpace("key_down");
    const onWindowKeyUp = onSpace("key_up");
    const onDragOver = (e: DragEvent) => {
      const types = typesOf(e.dataTransfer);
      if (types.includes("Files") || types.some((t) => t.startsWith(VTT_MIME_PREFIX))) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (dt === null || dt === undefined) return;
      const mime = typesOf(dt).find((t) => t.startsWith(VTT_MIME_PREFIX));
      if (mime !== undefined) {
        e.preventDefault();
        emit({ type: "data_drop", mime, data: dt.getData(mime), ...at(e.clientX, e.clientY) });
        return;
      }
      const files = dt.files ? Array.from(dt.files) : [];
      if (files.length > 0) {
        e.preventDefault();
        emit({ type: "file_drop", files, ...at(e.clientX, e.clientY) });
      }
    };

    const canvasListeners: [string, EventListener, AddEventListenerOptions?][] = [
      ["pointerdown", pointer("pointer_down") as EventListener],
      ["pointermove", pointer("pointer_move") as EventListener],
      ["pointerup", pointer("pointer_up") as EventListener],
      ["pointercancel", pointer("pointer_cancel") as EventListener],
      ["dblclick", onDoubleClick as EventListener],
      ["wheel", onWheel as EventListener, { passive: false }],
    ];
    const containerListeners: [string, EventListener][] = [
      ["keydown", key("key_down") as EventListener],
      ["keyup", key("key_up") as EventListener],
      ["dragover", onDragOver as EventListener],
      ["drop", onDrop as EventListener],
    ];
    for (const [name, fn, opts] of canvasListeners) canvas.addEventListener(name, fn, opts);
    for (const [name, fn] of containerListeners) container.addEventListener(name, fn);

    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    observer?.observe(container);
    window.addEventListener("resize", measure);
    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    measure();
    schedule();

    return () => {
      disposed = true;
      if (frame !== null) cancel(frame);
      scheduleRef.current = () => {};
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      for (const [name, fn, opts] of canvasListeners) canvas.removeEventListener(name, fn, opts);
      for (const [name, fn] of containerListeners) container.removeEventListener(name, fn);
      renderer.dispose();
    };
  }, []);

  return (
    <div ref={containerRef} style={CONTAINER_STYLE}>
      <canvas ref={canvasRef} tabIndex={0} style={CANVAS_STYLE} />
      <div style={OVERLAY_STYLE}>{props.overlay}</div>
    </div>
  );
}
