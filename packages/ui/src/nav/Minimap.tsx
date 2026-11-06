/**
 * The minimap (vtt-qf5.19; DESIGN.md §4.3 very large maps, §8.1 infinite
 * canvas; M6-D39): a small overview of the active board's item bounds with
 * the current view rectangle, drawn on its own canvas by a
 * `MinimapRenderer` (injectable, like the board's renderer) and redrawn on
 * every commit, so it follows the scene and the camera. A press recenters
 * the camera on the board point under it at the current zoom, and moving
 * while pressed keeps recentring (a drag pans). A toggle collapses it;
 * nothing renders when the board has no items. The app places it in the
 * bottom-right corner of the canvas area.
 */
import type { Bounds, Point } from "@vtt/schema";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Viewport } from "../interaction/contracts";
import type { Camera } from "../scene/camera";
import {
  createMinimapRenderer,
  MINIMAP_SIZE,
  type MinimapFrame,
  type MinimapRenderer,
  type MinimapSize,
  minimapFrame,
  minimapToBoard,
} from "./minimap-layout";

/** Creates the minimap's renderer for its canvas; null draws nothing. */
export type CreateMinimapRenderer = (canvas: HTMLCanvasElement) => MinimapRenderer | null;

/** `createMinimapRenderer` over the canvas's 2D context; null without one. */
export const defaultCreateMinimapRenderer: CreateMinimapRenderer = (canvas) => {
  const ctx = canvas.getContext("2d");
  return ctx === null ? null : createMinimapRenderer(ctx);
};

export interface MinimapProps {
  /** The active board's scene items (their `bounds`). */
  items: readonly { readonly bounds: Bounds }[];
  camera: Camera;
  /** The board canvas's viewport. */
  viewport: Viewport;
  /** Called with the board point to center the camera on. */
  onRecenter: (point: Point) => void;
  /** Default: `defaultCreateMinimapRenderer`; null draws nothing (clicks still recenter). */
  createRenderer?: CreateMinimapRenderer | null;
  /** Default: `MINIMAP_SIZE`. */
  size?: MinimapSize;
}

const ROOT_STYLE: CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 8,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 2,
};
const TOGGLE_STYLE: CSSProperties = { fontSize: "0.75em", padding: "0 6px" };
const CANVAS_BORDER = "1px solid #b8b8c0";

export function Minimap(props: MinimapProps) {
  const size = props.size ?? MINIMAP_SIZE;
  const [open, setOpen] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MinimapRenderer | null>(null);
  const dragging = useRef<number | null>(null);
  const frame = minimapFrame({
    items: props.items,
    camera: props.camera,
    viewport: props.viewport,
    size,
  });
  const frameRef = useRef<MinimapFrame | null>(frame);
  frameRef.current = frame;
  const onRecenterRef = useRef(props.onRecenter);
  onRecenterRef.current = props.onRecenter;
  const shown = open && frame !== null;
  const factory =
    props.createRenderer === undefined ? defaultCreateMinimapRenderer : props.createRenderer;

  // One renderer per mounted canvas.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!shown || canvas === null || factory === null) return;
    const renderer = factory(canvas);
    rendererRef.current = renderer;
    return () => {
      renderer?.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [shown, factory]);

  // Every commit redraws: the scene or the camera may have changed.
  useLayoutEffect(() => {
    const current = frameRef.current;
    if (current !== null) rendererRef.current?.render(current);
  });

  if (frame === null) return null;

  const recenter = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const layout = frameRef.current?.layout;
    if (layout === undefined) return;
    // The layout maps content pixels: the bounding rect includes the border.
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - canvas.clientLeft;
    const y = e.clientY - rect.top - canvas.clientTop;
    onRecenterRef.current(minimapToBoard([x, y], layout));
  };

  return (
    <div style={ROOT_STYLE}>
      <button
        type="button"
        style={TOGGLE_STYLE}
        aria-expanded={open}
        title={open ? "Hide the minimap" : "Show the minimap"}
        onClick={() => setOpen((o) => !o)}
      >
        Minimap
      </button>
      {open ? (
        <canvas
          ref={canvasRef}
          aria-label="Board overview"
          style={{
            width: size.width,
            height: size.height,
            display: "block",
            border: CANVAS_BORDER,
            cursor: "pointer",
            touchAction: "none",
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging.current = e.pointerId;
            try {
              e.currentTarget.setPointerCapture?.(e.pointerId);
            } catch {
              // Not an active pointer: nothing to capture.
            }
            recenter(e);
          }}
          onPointerMove={(e) => {
            if (dragging.current === e.pointerId && e.buttons !== 0) recenter(e);
          }}
          onPointerUp={(e) => {
            if (dragging.current === e.pointerId) dragging.current = null;
          }}
          onPointerCancel={(e) => {
            if (dragging.current === e.pointerId) dragging.current = null;
          }}
        />
      ) : null}
    </div>
  );
}
