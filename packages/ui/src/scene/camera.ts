/**
 * The camera (DESIGN.md §7 Scale; M4 plan Q18): a board point at the
 * viewport center and a zoom. Pure: no DOM, no canvas. Screen points are CSS
 * pixels from the viewport's top-left corner; board points are board units,
 * x to the right, y down (FORMULAS.md §3.1).
 */
import type { Bounds, Point } from "@vtt/schema";

/** The board point at the viewport center, and the zoom. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** The viewport size in CSS pixels (vtt-3l6.22's `Viewport` also carries `dpr`). */
export interface ViewportSize {
  width: number;
  height: number;
}

/** Screen pixels per board unit at zoom 1. */
export const PX_PER_UNIT = 64;
export const MIN_ZOOM = 1 / 32;
export const MAX_ZOOM = 8;

/** `zoom` clamped to [MIN_ZOOM, MAX_ZOOM]; NaN is 1. */
export function clampZoom(zoom: number): number {
  if (Number.isNaN(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Screen pixels per board unit for `camera`. */
export function cameraScale(camera: Camera): number {
  return PX_PER_UNIT * camera.zoom;
}

export function toScreen(camera: Camera, point: Point, viewport: ViewportSize): Point {
  const s = cameraScale(camera);
  return [
    (point[0] - camera.x) * s + viewport.width / 2,
    (point[1] - camera.y) * s + viewport.height / 2,
  ];
}

export function toBoard(camera: Camera, screen: Point, viewport: ViewportSize): Point {
  const s = cameraScale(camera);
  return [
    (screen[0] - viewport.width / 2) / s + camera.x,
    (screen[1] - viewport.height / 2) / s + camera.y,
  ];
}

/**
 * The camera zoomed by `factor` about `screenPoint` (clamped): the board
 * point under `screenPoint` stays under it.
 */
export function zoomAt(
  camera: Camera,
  screenPoint: Point,
  factor: number,
  viewport: ViewportSize,
): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  const [bx, by] = toBoard(camera, screenPoint, viewport);
  const s = PX_PER_UNIT * zoom;
  return {
    x: bx - (screenPoint[0] - viewport.width / 2) / s,
    y: by - (screenPoint[1] - viewport.height / 2) / s,
    zoom,
  };
}

/** The camera after the board is dragged by `screenDelta` pixels (the board follows the pointer). */
export function panBy(camera: Camera, screenDelta: Point): Camera {
  const s = cameraScale(camera);
  return { x: camera.x - screenDelta[0] / s, y: camera.y - screenDelta[1] / s, zoom: camera.zoom };
}

/**
 * The camera centered on `bounds` at the largest zoom (clamped) that fits
 * them inside the viewport less `margin` pixels on every side. Bounds with
 * no extent are centered at zoom 1.
 */
export function fitBounds(bounds: Bounds, viewport: ViewportSize, margin: number): Camera {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const fits: number[] = [];
  if (width > 0) fits.push(Math.max(0, viewport.width - 2 * margin) / (width * PX_PER_UNIT));
  if (height > 0) fits.push(Math.max(0, viewport.height - 2 * margin) / (height * PX_PER_UNIT));
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    zoom: fits.length === 0 ? 1 : clampZoom(Math.min(...fits)),
  };
}

/** The board region the viewport shows. */
export function visibleBounds(camera: Camera, viewport: ViewportSize): Bounds {
  const [minX, minY] = toBoard(camera, [0, 0], viewport);
  const [maxX, maxY] = toBoard(camera, [viewport.width, viewport.height], viewport);
  return { minX, minY, maxX, maxY };
}
