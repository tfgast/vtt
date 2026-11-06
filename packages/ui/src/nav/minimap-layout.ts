/**
 * The minimap's pure parts (vtt-qf5.19; DESIGN.md §4.3 very large maps,
 * §8.1 infinite canvas; M6-D39): the layout fitting the active board's item
 * bounds into the minimap, the mappings between minimap pixels and board
 * points, one frame (each item as a small rect, the camera's visible bounds
 * as the view rectangle) and its drawing over a `Ctx2D`.
 *
 * Layout rule: the union of the items' bounds (a side with no extent counts
 * as `MINIMAP_MIN_EXTENT` board units, about its centre) is scaled
 * uniformly to the largest size that fits inside the minimap less
 * `MINIMAP_PADDING_PX` on every side, and centred. The view rectangle is not
 * part of the extent: past the items it is cut by the minimap's edge.
 */
import type { Bounds, Point } from "@vtt/schema";
import type { Viewport } from "../interaction/contracts";
import type { Ctx2D } from "../render/renderer";
import { type Camera, visibleBounds } from "../scene/camera";
import { unionBounds } from "./first-visit-fit";

export interface MinimapSize {
  width: number;
  height: number;
}

/** Minimap pixels per board unit, and the minimap pixel of board point 0,0. */
export interface MinimapLayout {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** A box in minimap pixels. */
export interface MinimapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The minimap's size in CSS pixels. */
export const MINIMAP_SIZE: MinimapSize = { width: 160, height: 120 };
/** Pixels left free on every side of the items. */
export const MINIMAP_PADDING_PX = 6;
/** Board units a side with no extent counts as. */
export const MINIMAP_MIN_EXTENT = 1;
/** The smallest side of an item's rect, in pixels (a shapeless object is a dot). */
export const MINIMAP_ITEM_MIN_PX = 2;
export const MINIMAP_BACKGROUND = "rgba(255, 255, 255, 0.9)";
export const MINIMAP_ITEM_FILL = "#9a968c";
export const MINIMAP_VIEW_STROKE = "#2f6fd6";
export const MINIMAP_VIEW_LINE_WIDTH = 1.5;

/** The layout of `bounds` in a minimap of `size` (see the module comment). */
export function minimapLayout(
  bounds: Bounds,
  size: MinimapSize,
  padding: number = MINIMAP_PADDING_PX,
): MinimapLayout {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const bw = Math.max(bounds.maxX - bounds.minX, MINIMAP_MIN_EXTENT);
  const bh = Math.max(bounds.maxY - bounds.minY, MINIMAP_MIN_EXTENT);
  const scale = Math.max(
    0,
    Math.min((size.width - 2 * padding) / bw, (size.height - 2 * padding) / bh),
  );
  return {
    width: size.width,
    height: size.height,
    scale,
    offsetX: size.width / 2 - cx * scale,
    offsetY: size.height / 2 - cy * scale,
  };
}

export function boardToMinimap(point: Point, layout: MinimapLayout): Point {
  return [point[0] * layout.scale + layout.offsetX, point[1] * layout.scale + layout.offsetY];
}

/** The board point under a minimap pixel (a layout with zero scale maps everything to its centre). */
export function minimapToBoard(point: Point, layout: MinimapLayout): Point {
  if (layout.scale === 0) {
    return [-layout.offsetX, -layout.offsetY];
  }
  return [(point[0] - layout.offsetX) / layout.scale, (point[1] - layout.offsetY) / layout.scale];
}

/** `bounds` in minimap pixels, each side grown to at least `minPx` about its centre. */
export function minimapRect(bounds: Bounds, layout: MinimapLayout, minPx = 0): MinimapRect {
  const [x0, y0] = boardToMinimap([bounds.minX, bounds.minY], layout);
  const [x1, y1] = boardToMinimap([bounds.maxX, bounds.maxY], layout);
  const width = Math.max(x1 - x0, minPx);
  const height = Math.max(y1 - y0, minPx);
  return { x: (x0 + x1 - width) / 2, y: (y0 + y1 - height) / 2, width, height };
}

/** One minimap frame: its layout, the device pixel ratio, the items' rects and the view rectangle. */
export interface MinimapFrame {
  layout: MinimapLayout;
  dpr: number;
  items: MinimapRect[];
  view: MinimapRect;
}

export interface MinimapFrameInput {
  items: Iterable<{ readonly bounds: Bounds }>;
  camera: Camera;
  /** The board canvas's viewport (its size gives the view rectangle). */
  viewport: Viewport;
  size: MinimapSize;
}

/** The frame of `items` under `camera`; null with no items (the minimap is hidden then). */
export function minimapFrame(input: MinimapFrameInput): MinimapFrame | null {
  const list = [...input.items];
  const bounds = unionBounds(list);
  if (bounds === null) return null;
  const layout = minimapLayout(bounds, input.size);
  return {
    layout,
    dpr: input.viewport.dpr > 0 ? input.viewport.dpr : 1,
    items: list.map((item) => minimapRect(item.bounds, layout, MINIMAP_ITEM_MIN_PX)),
    view: minimapRect(visibleBounds(input.camera, input.viewport), layout),
  };
}

/** Draws minimap frames; shaped like the board's `Renderer`. */
export interface MinimapRenderer {
  render(frame: MinimapFrame): void;
  dispose(): void;
}

/**
 * Draws a frame over `ctx`: sizes its canvas to the minimap times the dpr,
 * clears it, fills the background, each item in `MINIMAP_ITEM_FILL` and
 * strokes the view rectangle in `MINIMAP_VIEW_STROKE`.
 */
export function createMinimapRenderer(ctx: Ctx2D): MinimapRenderer {
  return {
    render(frame) {
      const { layout, dpr } = frame;
      const width = Math.max(1, Math.round(layout.width * dpr));
      const height = Math.max(1, Math.round(layout.height * dpr));
      if (ctx.canvas.width !== width) ctx.canvas.width = width;
      if (ctx.canvas.height !== height) ctx.canvas.height = height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = MINIMAP_BACKGROUND;
      ctx.fillRect(0, 0, layout.width, layout.height);
      ctx.fillStyle = MINIMAP_ITEM_FILL;
      for (const r of frame.items) ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.strokeStyle = MINIMAP_VIEW_STROKE;
      ctx.lineWidth = MINIMAP_VIEW_LINE_WIDTH;
      ctx.setLineDash([]);
      const v = frame.view;
      ctx.strokeRect(v.x, v.y, v.width, v.height);
    },
    dispose() {},
  };
}
