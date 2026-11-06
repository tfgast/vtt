/**
 * The Canvas2D renderer (DESIGN.md §4.6 Appearance cells and Default
 * rendering until faces, §7 Platform; M4-D4, M4-D5, M4-D10, M4-D15, M4-D16).
 * One frame: clear; the grid when the scene asks for it (M6-D13); scene
 * items back to front, culled against the view; the
 * object-related overlays (the scene's outlines, then the object kinds of the
 * tool overlays); covers; then chrome overlays only. Nothing object-related is
 * drawn after the first cover. No per-object bitmap cache (vtt-qf5.10).
 */
import { type Bounds, boundsIntersect, type Point, type Shape } from "@vtt/schema";
import {
  type ChromeToolOverlay,
  type ObjectToolOverlay,
  splitOverlays,
} from "../interaction/overlays";
import { type Camera, cameraScale, toScreen, visibleBounds } from "../scene/camera";
import {
  type CoverItem,
  type DrawItem,
  labelVisible,
  MARKER_PX,
  type OverlayItem,
  type Scene,
} from "../scene/scene";
import type { ImageCache } from "./image-cache";
import type { Ctx2D, Renderer } from "./renderer";

// Colors.
export const COVER_FILL = "#101014";
export const OUTLINE_STROKE = "#3a3a42";
export const OPAQUE_GM_FILL = "rgba(0, 0, 0, 0.35)";
/** The generic back of a face-down object (M4-D5). */
export const BACK_FILL = "#4a5170";
export const BACK_MARK = "#8a93b8";
export const GLYPH_FILL = "#1f2333";
export const GLYPH_TEXT = "#ffffff";
export const BADGE_FILL = "#8b5cf6";
export const BADGE_MARK = "#ffffff";
export const PLACEHOLDER_STROKE = "#b3261e";
export const HATCH_STROKE = "rgba(16, 16, 20, 0.55)";
export const TEXT_FILL = "#1b1b1f";
export const LABEL_FILL = "#1b1b1f";
export const LABEL_BACKGROUND = "rgba(255, 255, 255, 0.8)";
export const SELECTION_STROKE = "#2f7cf6";
export const HIGHLIGHT_STROKE = "#f59e0b";
export const HOVER_STROKE = "rgba(47, 124, 246, 0.5)";
export const HANDLE_FILL = "#ffffff";
export const HANDLE_STROKE = "#2f7cf6";
export const GHOST_FILL = "rgba(47, 124, 246, 0.25)";
export const GHOST_STROKE = "#2f7cf6";
export const PREVIEW_FILL = "rgba(47, 124, 246, 0.15)";
export const PREVIEW_STROKE = "#2f7cf6";
export const DRAFT_STROKE = "#2f7cf6";
export const MARQUEE_FILL = "rgba(47, 124, 246, 0.1)";
export const MARQUEE_STROKE = "#1d5fd1";
export const CROSSHAIR_STROKE = "#e11d48";
/** The faint 1-unit grid drawn under the items while Snap is on (M6-D13). */
export const GRID_STROKE = "rgba(60, 60, 70, 0.14)";

// Sizes fixed on screen, in CSS pixels.
export const HATCH_SPACING_PX = 8;
export const HANDLE_PX = 8;
export const TEXT_FONT_PX = 14;
export const LABEL_FONT_PX = 12;
/** The grid is drawn only while one board unit is at least this many CSS pixels (M6-D13). */
export const GRID_MIN_PX = 8;
const FONT_FAMILY = "system-ui, sans-serif";
const TEXT_PADDING_PX = 4;
const TEXT_LINE_HEIGHT = 1.25;
const LABEL_GAP_PX = 4;
const BADGE_RADIUS_PX = 6;
const GLYPH_RADIUS_PX = 8;
const OVERLAY_PAD_PX = 3;
const CROSSHAIR_ARM_PX = 12;
const DRAFT_VERTEX_PX = 6;

export interface PaintHelpers {
  camera: Camera;
  images: ImageCache;
}

export interface DrawItemHelpers<S extends Scene = Scene> extends PaintHelpers {
  /** The scene being rendered. */
  scene: S;
}

/**
 * Called for every drawn item inside its transform (anchor at the origin,
 * rotated), after `paintItem` and with no clip active, before any
 * object-related overlay and every cover (M5 faces).
 */
export type DrawItemHook<S extends Scene = Scene> = (
  ctx: Ctx2D,
  item: DrawItem,
  helpers: DrawItemHelpers<S>,
) => void;

export interface Canvas2DRendererOptions<S extends Scene = Scene> {
  images: ImageCache;
  drawItem?: DrawItemHook<S>;
  /**
   * Board bounds an item is culled by, intersected exactly with the view (no
   * padding). Without it, an item is culled by its bounds padded for what
   * `paintItem` draws at a fixed screen size outside the footprint: the
   * shapeless marker, the hidden badge and, when visible, the label strip.
   * Gets the camera, for what grows on screen as it zooms out (vtt-qf5.66).
   * A hook that keeps those decorations includes `decoratedBounds(item,
   * camera)`, as `faceCullBounds` does (vtt-qf5.41).
   */
  cullBounds?: (item: DrawItem, scene: S, camera: Camera) => Bounds;
}

const radians = (deg: number) => (deg * Math.PI) / 180;

function localBox(shape: Shape): Bounds {
  if (shape.type === "rect") {
    const w = shape.width / 2;
    const h = shape.height / 2;
    return { minX: -w, minY: -h, maxX: w, maxY: h };
  }
  if (shape.type === "circle") {
    const r = shape.radius;
    return { minX: -r, minY: -r, maxX: r, maxY: r };
  }
  const xs = shape.points.map((p) => p[0]);
  const ys = shape.points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** The shape's outline as the current path, relative to the origin. */
function shapePath(ctx: Ctx2D, shape: Shape): void {
  ctx.beginPath();
  if (shape.type === "rect") {
    ctx.rect(-shape.width / 2, -shape.height / 2, shape.width, shape.height);
  } else if (shape.type === "circle") {
    ctx.arc(0, 0, shape.radius, 0, Math.PI * 2);
  } else {
    shape.points.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
}

function circle(ctx: Ctx2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/** Lines at 45° (`x + y = c`) every HATCH_SPACING_PX across `box`, aligned to the origin. */
function hatch(ctx: Ctx2D, box: Bounds, px: number): void {
  const step = HATCH_SPACING_PX * Math.SQRT2 * px;
  const from = Math.ceil((box.minX + box.minY) / step);
  const to = Math.floor((box.maxX + box.maxY) / step);
  ctx.beginPath();
  for (let k = from; k <= to; k++) {
    const c = k * step;
    ctx.moveTo(c - box.maxY, box.maxY);
    ctx.lineTo(c - box.minY, box.minY);
  }
  ctx.strokeStyle = HATCH_STROKE;
  ctx.lineWidth = px;
  ctx.stroke();
}

/** Greedy word wrap to `maxWidth`; explicit newlines are kept. */
function wrap(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w !== "");
    let line = "";
    for (const word of words) {
      const next = line === "" ? word : `${line} ${word}`;
      if (line !== "" && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** `text` wrapped to the shape's width, centered, in screen pixels; the caller clips. */
function paintText(ctx: Ctx2D, text: string, box: Bounds, s: number): void {
  ctx.save();
  ctx.scale(1 / s, 1 / s);
  ctx.font = `${TEXT_FONT_PX}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = TEXT_FILL;
  const maxWidth = Math.max(0, (box.maxX - box.minX) * s - 2 * TEXT_PADDING_PX);
  const lines = wrap(ctx, text, maxWidth);
  const lineHeight = TEXT_FONT_PX * TEXT_LINE_HEIGHT;
  const cx = ((box.minX + box.maxX) / 2) * s;
  const cy = ((box.minY + box.maxY) / 2) * s;
  lines.forEach((line, i) => {
    ctx.fillText(line, cx, cy + (i - (lines.length - 1) / 2) * lineHeight);
  });
  ctx.restore();
}

function paintPlaceholder(ctx: Ctx2D, box: Bounds, px: number): void {
  ctx.beginPath();
  ctx.rect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
  ctx.moveTo(box.minX, box.minY);
  ctx.lineTo(box.maxX, box.maxY);
  ctx.moveTo(box.maxX, box.minY);
  ctx.lineTo(box.minX, box.maxY);
  ctx.strokeStyle = PLACEHOLDER_STROKE;
  ctx.lineWidth = 1.5 * px;
  ctx.stroke();
}

function paintShape(ctx: Ctx2D, item: DrawItem, shape: Shape, s: number, images: ImageCache): void {
  const px = 1 / s;
  const box = localBox(shape);
  // Clipped body: fill, image, hatch.
  ctx.save();
  shapePath(ctx, shape);
  ctx.clip();
  if (item.faceDown) {
    ctx.fillStyle = BACK_FILL;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(box.minX, box.minY);
    ctx.lineTo(box.maxX, box.maxY);
    ctx.moveTo(box.maxX, box.minY);
    ctx.lineTo(box.minX, box.maxY);
    ctx.strokeStyle = BACK_MARK;
    ctx.lineWidth = 2 * px;
    ctx.stroke();
  } else {
    if (item.fill !== null) {
      ctx.fillStyle = item.fill;
      ctx.fill();
    }
    if (item.opaqueGm) {
      ctx.fillStyle = OPAQUE_GM_FILL;
      ctx.fill();
    }
    if (item.image !== undefined) {
      const image = images.get(item.image);
      if (image === "error") paintPlaceholder(ctx, box, px);
      else if (image !== null) {
        ctx.drawImage(image, box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
      }
    }
    if (item.pattern === "hatch") hatch(ctx, box, px);
  }
  ctx.restore();
  // Outline, unclipped.
  if (item.outline) {
    ctx.save();
    shapePath(ctx, shape);
    ctx.strokeStyle = OUTLINE_STROKE;
    ctx.lineWidth = px;
    if (item.opaqueGm) ctx.setLineDash([6 * px, 4 * px]);
    ctx.stroke();
    ctx.restore();
  }
  // Text, clipped.
  if (!item.faceDown && item.text !== undefined) {
    ctx.save();
    shapePath(ctx, shape);
    ctx.clip();
    paintText(ctx, item.text, box, s);
    ctx.restore();
  }
}

function paintMarker(ctx: Ctx2D, item: DrawItem, s: number): void {
  ctx.save();
  ctx.scale(1 / s, 1 / s);
  circle(ctx, 0, 0, MARKER_PX / 2);
  const fill = item.faceDown ? BACK_FILL : item.fill;
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (item.outline) {
    ctx.strokeStyle = OUTLINE_STROKE;
    ctx.lineWidth = 1;
    if (item.opaqueGm) ctx.setLineDash([3, 2]);
    ctx.stroke();
  }
  ctx.restore();
}

/** Below the item's axis-aligned bounds, horizontal whatever the rotation. */
function paintLabel(ctx: Ctx2D, item: DrawItem, label: string, s: number): void {
  ctx.save();
  ctx.rotate(-radians(item.rotation));
  ctx.translate(0, item.bounds.maxY - item.anchor[1]);
  ctx.scale(1 / s, 1 / s);
  ctx.font = `${LABEL_FONT_PX}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const top = LABEL_GAP_PX + (item.shape === null ? MARKER_PX / 2 : 0);
  const width = ctx.measureText(label).width;
  ctx.fillStyle = LABEL_BACKGROUND;
  ctx.fillRect(-width / 2 - 2, top - 1, width + 4, LABEL_FONT_PX + 2);
  ctx.fillStyle = LABEL_FILL;
  ctx.fillText(label, 0, top);
  ctx.restore();
}

/** The GM's face-down glyph, at the item's center (DESIGN.md §4.6). */
function paintGlyph(ctx: Ctx2D, s: number): void {
  ctx.save();
  ctx.scale(1 / s, 1 / s);
  circle(ctx, 0, 0, GLYPH_RADIUS_PX);
  ctx.fillStyle = GLYPH_FILL;
  ctx.fill();
  ctx.font = `${GLYPH_RADIUS_PX + 3}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = GLYPH_TEXT;
  ctx.fillText("↓", 0, 0);
  ctx.restore();
}

/** The GM's hidden badge (`visible_to` not exactly `all`), at the bounds' top-right corner. */
function paintBadge(ctx: Ctx2D, item: DrawItem, s: number): void {
  ctx.save();
  ctx.rotate(-radians(item.rotation));
  ctx.translate(item.bounds.maxX - item.anchor[0], item.bounds.minY - item.anchor[1]);
  ctx.scale(1 / s, 1 / s);
  const at = item.shape === null ? MARKER_PX / 2 : 0;
  circle(ctx, at, -at, BADGE_RADIUS_PX);
  ctx.fillStyle = BADGE_FILL;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(at - BADGE_RADIUS_PX / 2, -at + BADGE_RADIUS_PX / 2);
  ctx.lineTo(at + BADGE_RADIUS_PX / 2, -at - BADGE_RADIUS_PX / 2);
  ctx.strokeStyle = BADGE_MARK;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/**
 * Paints one item in its own coordinates: the context's origin is the item's
 * anchor and its axes are rotated by the item's rotation. Draws fill, image,
 * hatch (clipped to the shape), outline, text (clipped), the label when
 * `labelVisible`, the face-down back and glyph, and the hidden badge. Leaves
 * the context as it found it, with no clip. `render` uses it for every item.
 */
export function paintItem(ctx: Ctx2D, item: DrawItem, helpers: PaintHelpers): void {
  const s = cameraScale(helpers.camera);
  ctx.save();
  ctx.globalAlpha = ctx.globalAlpha * item.alpha;
  if (item.shape === null) paintMarker(ctx, item, s);
  else paintShape(ctx, item, item.shape, s, helpers.images);
  if (item.label !== undefined && labelVisible(item, helpers.camera)) {
    paintLabel(ctx, item, item.label, s);
  }
  if (item.faceDownGlyph) paintGlyph(ctx, s);
  if (item.hiddenBadge) paintBadge(ctx, item, s);
  ctx.restore();
}

/**
 * `item.bounds` grown by what `paintItem` draws at a fixed screen size outside
 * the footprint, converted to board units at `camera`'s zoom: the shapeless
 * marker, the hidden badge and, when visible, the label strip. The default
 * cull bounds; a `cullBounds` hook includes it to keep those decorations
 * (`faceCullBounds`, vtt-qf5.41). Draw culling only, never hit testing.
 */
export function decoratedBounds(item: DrawItem, camera: Camera): Bounds {
  const bounds = item.bounds;
  const px = 1 / cameraScale(camera);
  let pad = item.shape === null ? MARKER_PX / 2 : 0;
  if (item.hiddenBadge) pad += BADGE_RADIUS_PX;
  const grown = {
    minX: bounds.minX - pad * px,
    minY: bounds.minY - pad * px,
    maxX: bounds.maxX + pad * px,
    maxY: bounds.maxY + pad * px,
  };
  if (item.label !== undefined && labelVisible(item, camera)) {
    const half = (Array.from(item.label).length * LABEL_FONT_PX * 0.6) / 2 + 2;
    const cx = item.anchor[0];
    grown.minX = Math.min(grown.minX, cx - half * px);
    grown.maxX = Math.max(grown.maxX, cx + half * px);
    grown.maxY += (LABEL_GAP_PX + LABEL_FONT_PX + 2) * px;
  }
  return grown;
}

function paintOutlineOverlay(ctx: Ctx2D, overlay: OverlayItem, px: number): void {
  const b = overlay.bounds;
  const degenerate = b.minX === b.maxX && b.minY === b.maxY;
  const pad = (OVERLAY_PAD_PX + (degenerate ? MARKER_PX / 2 : 0)) * px;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad);
  if (overlay.kind === "selection") {
    ctx.strokeStyle = SELECTION_STROKE;
    ctx.lineWidth = 2 * px;
  } else if (overlay.kind === "highlight") {
    ctx.strokeStyle = HIGHLIGHT_STROKE;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([4 * px, 3 * px]);
  } else {
    ctx.strokeStyle = HOVER_STROKE;
    ctx.lineWidth = px;
  }
  ctx.stroke();
  ctx.restore();
}

function handleSquare(ctx: Ctx2D, at: Point, px: number, round: boolean): void {
  const h = (HANDLE_PX / 2) * px;
  if (round) circle(ctx, at[0], at[1], h);
  else {
    ctx.beginPath();
    ctx.rect(at[0] - h, at[1] - h, 2 * h, 2 * h);
  }
  ctx.fillStyle = HANDLE_FILL;
  ctx.fill();
  ctx.strokeStyle = HANDLE_STROKE;
  ctx.lineWidth = px;
  ctx.stroke();
}

/**
 * The keyboard face focus ring (vtt-qf5.26): `HIGHLIGHT_STROKE`, solid, 2 px,
 * `OVERLAY_PAD_PX` outside the target's rect, in the object's frame; nothing
 * unless the object is drawn and outlined as selected.
 */
function paintFaceFocus(
  ctx: Ctx2D,
  overlay: Extract<ObjectToolOverlay, { kind: "face_focus" }>,
  scene: Scene,
  px: number,
): void {
  const item = scene.items.find((i) => i.id === overlay.object);
  const selected = scene.objectOverlays.some(
    (o) => o.kind === "selection" && o.id === overlay.object,
  );
  if (item === undefined || !selected) return;
  const [x, y, w, h] = overlay.rect;
  const pad = OVERLAY_PAD_PX * px;
  ctx.translate(item.anchor[0], item.anchor[1]);
  ctx.rotate(radians(item.rotation));
  ctx.beginPath();
  ctx.rect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
  ctx.strokeStyle = HIGHLIGHT_STROKE;
  ctx.lineWidth = 2 * px;
  ctx.stroke();
}

function paintObjectToolOverlay(
  ctx: Ctx2D,
  overlay: ObjectToolOverlay,
  scene: Scene,
  px: number,
): void {
  ctx.save();
  switch (overlay.kind) {
    case "drag_ghost":
      for (const ghost of overlay.items) {
        ctx.save();
        ctx.translate(ghost.anchor[0], ghost.anchor[1]);
        ctx.rotate(radians(ghost.rotation));
        if (ghost.shape === null) circle(ctx, 0, 0, (MARKER_PX / 2) * px);
        else shapePath(ctx, ghost.shape);
        ctx.fillStyle = GHOST_FILL;
        ctx.fill();
        ctx.strokeStyle = GHOST_STROKE;
        ctx.lineWidth = px;
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.stroke();
        ctx.restore();
      }
      break;
    case "handles":
      for (const mark of overlay.handles) {
        if (mark.from !== undefined) {
          ctx.beginPath();
          ctx.moveTo(mark.from[0], mark.from[1]);
          ctx.lineTo(mark.at[0], mark.at[1]);
          ctx.strokeStyle = HANDLE_STROKE;
          ctx.lineWidth = px;
          ctx.stroke();
        }
        handleSquare(ctx, mark.at, px, mark.role === "rotate");
      }
      break;
    case "creation_preview":
      ctx.translate(overlay.anchor[0], overlay.anchor[1]);
      shapePath(ctx, overlay.shape);
      ctx.fillStyle = overlay.zone ? PREVIEW_FILL : GHOST_FILL;
      ctx.fill();
      ctx.strokeStyle = PREVIEW_STROKE;
      ctx.lineWidth = px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.stroke();
      break;
    case "polygon_draft": {
      const [first, ...rest] = overlay.points;
      if (first === undefined) break;
      ctx.beginPath();
      ctx.moveTo(first[0], first[1]);
      for (const p of rest) ctx.lineTo(p[0], p[1]);
      ctx.strokeStyle = DRAFT_STROKE;
      ctx.lineWidth = 1.5 * px;
      ctx.stroke();
      const last = rest.at(-1) ?? first;
      if (overlay.cursor !== null) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(last[0], last[1]);
        ctx.lineTo(overlay.cursor[0], overlay.cursor[1]);
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.stroke();
        ctx.restore();
      }
      const v = (DRAFT_VERTEX_PX / 2) * px;
      for (const p of overlay.points) {
        ctx.beginPath();
        ctx.rect(p[0] - v, p[1] - v, 2 * v, 2 * v);
        ctx.fillStyle = HANDLE_FILL;
        ctx.fill();
        ctx.lineWidth = px;
        ctx.stroke();
      }
      if (overlay.closing) {
        circle(ctx, first[0], first[1], 2 * v);
        ctx.lineWidth = 2 * px;
        ctx.stroke();
      }
      break;
    }
    case "face_focus":
      paintFaceFocus(ctx, overlay, scene, px);
      break;
  }
  ctx.restore();
}

/**
 * The 1-unit grid lines within `view`, one CSS pixel wide (M6-D13); nothing
 * when a unit is under `GRID_MIN_PX` on screen.
 */
function paintGrid(ctx: Ctx2D, view: Bounds, camera: Camera): void {
  const s = cameraScale(camera);
  if (!(s >= GRID_MIN_PX)) return;
  const x0 = Math.ceil(view.minX);
  const x1 = Math.floor(view.maxX);
  const y0 = Math.ceil(view.minY);
  const y1 = Math.floor(view.maxY);
  if (x0 > x1 && y0 > y1) return;
  ctx.save();
  ctx.beginPath();
  for (let x = x0; x <= x1; x++) {
    ctx.moveTo(x, view.minY);
    ctx.lineTo(x, view.maxY);
  }
  for (let y = y0; y <= y1; y++) {
    ctx.moveTo(view.minX, y);
    ctx.lineTo(view.maxX, y);
  }
  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth = 1 / s;
  ctx.globalAlpha = 1;
  ctx.stroke();
  ctx.restore();
}

function paintCover(ctx: Ctx2D, cover: CoverItem, view: Bounds): void {
  ctx.save();
  ctx.fillStyle = COVER_FILL;
  ctx.globalAlpha = 1;
  if (cover.wholeBoard) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  } else if (boundsIntersect(cover.bounds, view)) {
    ctx.translate(cover.anchor[0], cover.anchor[1]);
    ctx.rotate(radians(cover.rotation));
    shapePath(ctx, cover.shape);
    ctx.fill();
  }
  ctx.restore();
}

function paintChrome(
  ctx: Ctx2D,
  overlay: ChromeToolOverlay,
  camera: Camera,
  viewport: { width: number; height: number; dpr: number },
): void {
  const px = 1 / cameraScale(camera);
  ctx.save();
  if (overlay.kind === "marquee") {
    const r = overlay.rect;
    const minX = Math.min(r.minX, r.maxX);
    const minY = Math.min(r.minY, r.maxY);
    ctx.beginPath();
    ctx.rect(minX, minY, Math.abs(r.maxX - r.minX), Math.abs(r.maxY - r.minY));
    ctx.fillStyle = MARQUEE_FILL;
    ctx.fill();
    ctx.strokeStyle = MARQUEE_STROKE;
    ctx.lineWidth = px;
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.stroke();
  } else {
    const [x, y] = toScreen(camera, overlay.at, viewport);
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    ctx.beginPath();
    ctx.moveTo(x - CROSSHAIR_ARM_PX, y);
    ctx.lineTo(x + CROSSHAIR_ARM_PX, y);
    ctx.moveTo(x, y - CROSSHAIR_ARM_PX);
    ctx.lineTo(x, y + CROSSHAIR_ARM_PX);
    ctx.strokeStyle = CROSSHAIR_STROKE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

export function createCanvas2DRenderer<S extends Scene = Scene>(
  ctx: Ctx2D,
  options: Canvas2DRendererOptions<S>,
): Renderer<S> {
  let disposed = false;
  return {
    render(scene, toolOverlays, camera, viewport) {
      if (disposed) return;
      const { width, height, dpr } = viewport;
      const cw = Math.max(0, Math.round(width * dpr));
      const ch = Math.max(0, Math.round(height * dpr));
      if (ctx.canvas.width !== cw) ctx.canvas.width = cw;
      if (ctx.canvas.height !== ch) ctx.canvas.height = ch;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      const s = cameraScale(camera);
      const px = 1 / s;
      ctx.setTransform(
        dpr * s,
        0,
        0,
        dpr * s,
        dpr * (width / 2 - camera.x * s),
        dpr * (height / 2 - camera.y * s),
      );
      const view = visibleBounds(camera, viewport);
      const { images, drawItem, cullBounds } = options;

      // 0. The grid, under everything (M6-D13).
      if (scene.grid === true) paintGrid(ctx, view, camera);

      // 1. Scene items, back to front.
      for (const item of scene.items) {
        const bounds = cullBounds ? cullBounds(item, scene, camera) : decoratedBounds(item, camera);
        if (!boundsIntersect(bounds, view)) continue;
        ctx.save();
        ctx.translate(item.anchor[0], item.anchor[1]);
        ctx.rotate(radians(item.rotation));
        paintItem(ctx, item, { camera, images });
        drawItem?.(ctx, item, { camera, images, scene });
        ctx.restore();
      }

      // 2. Object-related overlays.
      const { object, chrome } = splitOverlays(toolOverlays);
      for (const overlay of scene.objectOverlays) paintOutlineOverlay(ctx, overlay, px);
      for (const overlay of object) paintObjectToolOverlay(ctx, overlay, scene, px);

      // 3. Covers: nothing object-related after this point (M4-D16).
      for (const cover of scene.covers) paintCover(ctx, cover, view);

      // 4. Viewer-independent chrome.
      for (const overlay of chrome) paintChrome(ctx, overlay, camera, viewport);
    },
    dispose() {
      disposed = true;
    },
  };
}
