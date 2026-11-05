/**
 * Drawing faces (DESIGN.md §4.6 The face, Zoom as level of detail, Face
 * elements, Collapsed face, Gestures: contents scrolling and nested objects,
 * Ink and text; §4.4 face-down objects and covers; §7 Platform: canvas text
 * is weak at small sizes, which `min_size` accommodates; M5 plan Q1 A3, Q8,
 * Q19, reviews r1 8, r2 1 and 3, r3 1). `drawFaceItem` is vtt-3l6.6's
 * `drawItem` hook: inside each item's transform, unclipped, after the item's
 * own drawing and before every object-related overlay and cover. The face
 * model (vtt-1xv.14) decides what is drawn; this file only paints it.
 */
import type { ObjectId, Rect } from "@vtt/schema";
import type {
  ButtonPrimitive,
  ContentsPrimitive,
  EditorPrimitive,
  FaceDrawing,
  FaceEntry,
  FacePrimitive,
  FaceTextAlign,
  FaceTextSize,
  ImagePrimitive,
  InkPrimitive,
  TextPrimitive,
} from "../face/face-model";
import { entryTransform } from "../face/face-model";
import type { FaceScene } from "../face/face-scene";
import { type Affine, compose, itemTransform, screenHeight } from "../face/face-transform";
import { type Camera, cameraScale } from "../scene/camera";
import type { DrawItem } from "../scene/scene";
import type { FormatTone } from "../values/format";
import {
  type DrawItemHelpers,
  type PaintHelpers,
  PLACEHOLDER_STROKE,
  paintItem,
  SELECTION_STROKE,
  TEXT_FILL,
} from "./canvas2d";
import type { Ctx2D } from "./renderer";

// Colors.
export const INK_STROKE = "#202020";
export const MUTED_TEXT = "#6b6b75";
export const ERROR_TEXT = "#b3261e";
export const BUTTON_FILL = "#ecebf3";
export const BUTTON_STROKE = "#55546a";
export const EDITOR_FILL = "#ffffff";
export const EDITOR_STROKE = "#8a8a96";
export const GEAR_FILL = "#55546a";
export const GEAR_MARK = "#ffffff";
export const CHEVRON_FILL = "#7a798e";
export const CONTENTS_FILL = "rgba(255, 255, 255, 0.6)";
export const CONTENTS_STROKE = "#b8b6c4";
export const SCROLL_FILL = "rgba(60, 60, 72, 0.45)";

/** The one pen (DESIGN.md §4.6 Ink and text; M5-D20): its width in object-local units. */
export const INK_WIDTH = 0.04;
/** A disabled button, or any button of a template, is drawn at this alpha. */
export const DISABLED_ALPHA = 0.4;
/** Font size as a fraction of the element rect's height, by `style.size`. */
export const FACE_TEXT_SCALE: Readonly<Record<FaceTextSize, number>> = Object.freeze({
  small: 0.45,
  normal: 0.6,
  large: 0.8,
  huge: 1.0,
});
/** Text shrinks to fit its width down to this fraction of its style size, then truncates with `…`. */
export const FACE_TEXT_MIN_SHRINK = 0.5;
/** What a redacted or missing contents entry shows. */
export const HIDDEN_TEXT = "hidden";
/** The scroll indicator's width, in CSS px. */
export const SCROLL_BAR_PX = 3;

const FONT_FAMILY = "system-ui, sans-serif";
const ELLIPSIS = "…";
/** Horizontal text padding as a fraction of the rect's height. */
const TEXT_PAD_RATIO = 0.15;
/** An editor box's inset as a fraction of the rect's height. */
const EDITOR_INSET_RATIO = 0.08;
/** A button's corner radius as a fraction of its smaller side. */
const BUTTON_RADIUS_RATIO = 0.25;
/** Below this many CSS px wide, a rect gets no text. */
const MIN_TEXT_PX = 1;
/** Rows within this distance of the visible window's edge count as outside it. */
const ROW_EPSILON = 1e-9;

export interface FaceDrawHelpers extends PaintHelpers {
  /** Selected objects: their contents entries are outlined. */
  selection?: readonly ObjectId[] | ReadonlySet<ObjectId>;
}

export interface DrawFaceOptions extends FaceDrawHelpers {
  /** The drawing's frame → board, accumulated through every enclosing entry. */
  transform: Affine;
}

export type DrawFaceItemHelpers = DrawItemHelpers<FaceScene> & FaceDrawHelpers;

/**
 * vtt-3l6.6's `drawItem` hook (vtt-1xv.23 wires it, with `faceCullBounds`
 * as `cullBounds`): draws `scene.faces.get(item.id)` with `drawFace` in the
 * item's frame. Pass `selection` by wrapping it to outline selected entries.
 */
export function drawFaceItem(ctx: Ctx2D, item: DrawItem, helpers: DrawFaceItemHelpers): void {
  const drawing = helpers.scene.faces.get(item.id);
  if (drawing === undefined) return;
  const opts: DrawFaceOptions = {
    camera: helpers.camera,
    images: helpers.images,
    transform: helpers.scene.transforms.get(item.id) ?? itemTransform(item),
  };
  if (helpers.selection !== undefined) opts.selection = helpers.selection;
  drawFace(ctx, drawing, opts);
}

/**
 * Draws `drawing` in the context's current frame, which is the drawing's
 * frame (origin at the object's anchor, y down). A nested drawing's `base`
 * is painted first as on a board (vtt-3l6.6's `paintItem`, its fixed
 * screen sizes at the accumulated scale), then the primitives in order. A
 * primitive whose on-screen height (`screenHeight` through `transform`) is
 * below its `minSize` is skipped. Leaves the context as it found it.
 */
export function drawFace(ctx: Ctx2D, drawing: FaceDrawing, opts: DrawFaceOptions): void {
  const k = Math.hypot(opts.transform[0], opts.transform[1]);
  const s = cameraScale(opts.camera) * k;
  if (!(s > 0) || !Number.isFinite(s)) return;
  const selected = selectionSet(opts.selection);
  const env: Env = { ...opts, s, px: 1 / s, selected };
  if (drawing.base !== null) {
    paintItem(ctx, drawing.base, { camera: scaledCamera(opts.camera, k), images: opts.images });
  }
  for (const p of drawing.primitives) {
    if (screenHeight(p.rect, opts.transform, opts.camera) < p.minSize) continue;
    drawPrimitive(ctx, p, env);
  }
}

interface Env extends DrawFaceOptions {
  /** CSS px per drawing unit. */
  s: number;
  /** Drawing units per CSS px. */
  px: number;
  selected: ReadonlySet<ObjectId>;
}

function selectionSet(sel: DrawFaceOptions["selection"]): ReadonlySet<ObjectId> {
  if (sel === undefined) return new Set();
  return sel instanceof Set ? sel : new Set(sel as readonly ObjectId[]);
}

/** The camera whose scale is `camera`'s times `k`: fixed screen sizes stay fixed in a scaled frame. */
function scaledCamera(camera: Camera, k: number): Camera {
  return k === 1 ? camera : { ...camera, zoom: camera.zoom * k };
}

function drawPrimitive(ctx: Ctx2D, p: FacePrimitive, env: Env): void {
  switch (p.kind) {
    case "text":
      drawText(ctx, p, env);
      break;
    case "editor":
      drawEditor(ctx, p, env);
      break;
    case "button":
      drawButton(ctx, p, env);
      break;
    case "image":
      drawImagePrimitive(ctx, p, env);
      break;
    case "ink":
      drawInk(ctx, p, env);
      break;
    case "gear":
      drawGear(ctx, p.rect, env);
      break;
    case "contents":
      drawContents(ctx, p, env);
      break;
  }
}

// ---------------------------------------------------------------------------
// Text

function toneFill(tone: FormatTone): string {
  if (tone === "error") return ERROR_TEXT;
  if (tone === "normal") return TEXT_FILL;
  return MUTED_TEXT;
}

/**
 * One line of `text` in `rect`, vertically centred: font size = the rect's
 * height × the style's factor, shrunk to fit the width (down to
 * FACE_TEXT_MIN_SHRINK of it), then cut with `…`. Drawn in CSS px so the
 * font is a whole-pixel-friendly size.
 */
function fitText(
  ctx: Ctx2D,
  text: string,
  rect: Rect,
  size: FaceTextSize,
  align: FaceTextAlign,
  fill: string,
  s: number,
): void {
  if (text === "") return;
  const [x, y, w, h] = rect.map((n) => n * s) as [number, number, number, number];
  const pad = h * TEXT_PAD_RATIO;
  const maxWidth = w - 2 * pad;
  if (maxWidth < MIN_TEXT_PX) return;
  const full = h * FACE_TEXT_SCALE[size];
  ctx.save();
  ctx.scale(1 / s, 1 / s);
  ctx.font = fontOf(full);
  let font = full;
  let line = text;
  const width = ctx.measureText(text).width;
  if (width > maxWidth) {
    font = Math.max(full * FACE_TEXT_MIN_SHRINK, (full * maxWidth) / width);
    ctx.font = fontOf(font);
    line = truncate(ctx, text, maxWidth);
  }
  ctx.textBaseline = "middle";
  ctx.fillStyle = fill;
  let tx: number;
  if (align === "left") {
    ctx.textAlign = "left";
    tx = x + pad;
  } else if (align === "right") {
    ctx.textAlign = "right";
    tx = x + w - pad;
  } else {
    ctx.textAlign = "center";
    tx = x + w / 2;
  }
  if (line !== "") ctx.fillText(line, tx, y + h / 2);
  ctx.restore();
}

function fontOf(px: number): string {
  return `${Math.round(px * 1000) / 1000}px ${FONT_FAMILY}`;
}

/** The longest prefix of `text` plus `…` that fits `maxWidth` (`text` itself when it fits). */
function truncate(ctx: Ctx2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(chars.slice(0, mid).join("") + ELLIPSIS).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return ctx.measureText(ELLIPSIS).width <= maxWidth ? ELLIPSIS : "";
  return chars.slice(0, lo).join("").trimEnd() + ELLIPSIS;
}

function captioned(p: { text: string; caption?: string }): string {
  return p.caption === undefined ? p.text : `${p.caption}: ${p.text}`;
}

function drawText(ctx: Ctx2D, p: TextPrimitive, env: Env): void {
  fitText(ctx, captioned(p), p.rect, p.size, p.align, toneFill(p.tone), env.s);
}

function drawEditor(ctx: Ctx2D, p: EditorPrimitive, env: Env): void {
  const [x, y, w, h] = p.rect;
  const inset = Math.min(h * EDITOR_INSET_RATIO, w / 4);
  const box: Rect = [x + inset, y + inset, w - 2 * inset, h - 2 * inset];
  ctx.save();
  ctx.beginPath();
  ctx.rect(...box);
  ctx.fillStyle = EDITOR_FILL;
  ctx.fill();
  ctx.strokeStyle = EDITOR_STROKE;
  ctx.lineWidth = env.px;
  ctx.stroke();
  ctx.restore();
  fitText(ctx, captioned(p), box, p.size, p.align, toneFill(p.tone), env.s);
}

// ---------------------------------------------------------------------------
// Buttons, gears, chevrons

/** A rounded rect as the current path (Ctx2D has no `roundRect`). */
function roundedRect(ctx: Ctx2D, [x, y, w, h]: Rect, r: number): void {
  const q = Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -q, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, q);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, q, 2 * q);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, 2 * q, 3 * q);
  ctx.closePath();
}

function drawButton(ctx: Ctx2D, p: ButtonPrimitive, env: Env): void {
  ctx.save();
  if (!p.enabled || p.template) ctx.globalAlpha = ctx.globalAlpha * DISABLED_ALPHA;
  roundedRect(ctx, p.rect, Math.min(p.rect[2], p.rect[3]) * BUTTON_RADIUS_RATIO);
  ctx.fillStyle = BUTTON_FILL;
  ctx.fill();
  ctx.strokeStyle = BUTTON_STROKE;
  ctx.lineWidth = env.px;
  ctx.stroke();
  fitText(ctx, p.label, p.rect, "normal", "center", TEXT_FILL, env.s);
  ctx.restore();
}

/** The edit-template gear: a filled disc with a gear mark, in `rect`. */
function drawGear(ctx: Ctx2D, rect: Rect, env: Env): void {
  const [x, y, w, h] = rect;
  const r = Math.min(w, h) / 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = GEAR_FILL;
  ctx.fill();
  ctx.scale(1 / env.s, 1 / env.s);
  ctx.font = fontOf(2 * r * env.s * 0.8);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = GEAR_MARK;
  ctx.fillText("⚙", cx * env.s, cy * env.s);
  ctx.restore();
}

/** A triangle in `rect`: pointing right when collapsed, down when expanded. */
function drawChevron(ctx: Ctx2D, rect: Rect, expanded: boolean): void {
  const [x, y, w, h] = rect;
  const side = Math.min(w, h) * 0.4;
  const cx = x + w / 2;
  const cy = y + Math.min(h, w) / 2;
  ctx.beginPath();
  if (expanded) {
    ctx.moveTo(cx - side / 2, cy - side / 4);
    ctx.lineTo(cx + side / 2, cy - side / 4);
    ctx.lineTo(cx, cy + side / 2);
  } else {
    ctx.moveTo(cx - side / 4, cy - side / 2);
    ctx.lineTo(cx + side / 2, cy);
    ctx.lineTo(cx - side / 4, cy + side / 2);
  }
  ctx.closePath();
  ctx.fillStyle = CHEVRON_FILL;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Images and ink

function drawImagePrimitive(ctx: Ctx2D, p: ImagePrimitive, env: Env): void {
  const image = env.images.get(p.path);
  const [x, y, w, h] = p.rect;
  if (image === null) return;
  ctx.save();
  if (image === "error") {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y);
    ctx.lineTo(x, y + h);
    ctx.strokeStyle = PLACEHOLDER_STROKE;
    ctx.lineWidth = 1.5 * env.px;
    ctx.stroke();
  } else {
    ctx.drawImage(image, x, y, w, h);
  }
  ctx.restore();
}

type InkCtx = Ctx2D & Partial<Pick<CanvasRenderingContext2D, "lineJoin" | "lineCap">>;

/** Strokes in the drawing's frame: INK_WIDTH wide but at least one CSS px, round joins and caps. */
function drawInk(ctx: Ctx2D, p: InkPrimitive, env: Env): void {
  const ink = ctx as InkCtx;
  ctx.save();
  ctx.strokeStyle = INK_STROKE;
  ctx.lineWidth = Math.max(INK_WIDTH, env.px);
  ink.lineJoin = "round";
  ink.lineCap = "round";
  for (const stroke of p.strokes) {
    const [first, ...rest] = stroke;
    if (first === undefined) continue;
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    if (rest.length === 0) ctx.lineTo(first[0], first[1]);
    for (const q of rest) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Contents

/** `m` applied to the context; `m` is a similarity (rotation and uniform scale), as entry transforms are. */
function applyAffine(ctx: Ctx2D, m: Affine): void {
  ctx.translate(m[4], m[5]);
  const angle = Math.atan2(m[1], m[0]);
  if (angle !== 0) ctx.rotate(angle);
  const k = Math.hypot(m[0], m[1]);
  if (k !== 1) ctx.scale(k, k);
}

/**
 * The element's background, then, clipped to its rect and scrolled by
 * `-offset`, each row overlapping the visible window: its chevron, its gear,
 * its drawing under its transform (collapsed and expanded alike) or "hidden",
 * and its selection outline. Then a scroll indicator when it overflows.
 */
function drawContents(ctx: Ctx2D, p: ContentsPrimitive, env: Env): void {
  const [x, y, w, h] = p.rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fillStyle = CONTENTS_FILL;
  ctx.fill();
  ctx.strokeStyle = CONTENTS_STROKE;
  ctx.lineWidth = env.px;
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(0, -p.offset);
  for (const entry of p.entries) {
    const [, top, , height] = entry.row;
    if (top + height <= p.offset + ROW_EPSILON || top >= p.offset + h - ROW_EPSILON) continue;
    drawEntry(ctx, p, entry, env);
  }
  ctx.restore();
  if (p.maxOffset > 0) {
    const thumb = Math.max(h * (h / (h + p.maxOffset)), 2 * SCROLL_BAR_PX * env.px);
    const at = y + (h - thumb) * (p.offset / p.maxOffset);
    const bar = SCROLL_BAR_PX * env.px;
    ctx.save();
    ctx.fillStyle = SCROLL_FILL;
    ctx.fillRect(x + w - bar - env.px, at, bar, thumb);
    ctx.restore();
  }
}

/** One row, in the element's scrolled frame (element-local rects offset by the rect's corner). */
function drawEntry(ctx: Ctx2D, p: ContentsPrimitive, entry: FaceEntry, env: Env): void {
  const local = (r: Rect): Rect => [p.rect[0] + r[0], p.rect[1] + r[1], r[2], r[3]];
  const row = local(entry.row);
  if (entry.drawing === null) {
    const chevronW = entry.chevron[2];
    const inner: Rect = [row[0] + chevronW, row[1], row[2] - chevronW, entry.chevron[3]];
    fitText(ctx, HIDDEN_TEXT, inner, "normal", "left", MUTED_TEXT, env.s);
    return;
  }
  ctx.save();
  drawChevron(ctx, local(entry.chevron), entry.expanded);
  if (entry.gear !== undefined) drawGear(ctx, local(entry.gear), env);
  ctx.restore();
  ctx.save();
  applyAffine(ctx, entry.transform);
  const child: DrawFaceOptions = {
    camera: env.camera,
    images: env.images,
    transform: compose(env.transform, entryTransform(p, entry)),
    selection: env.selected,
  };
  drawFace(ctx, entry.drawing, child);
  ctx.restore();
  if (entry.id !== null && env.selected.has(entry.id)) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(row[0] + env.px, row[1] + env.px, row[2] - 2 * env.px, row[3] - 2 * env.px);
    ctx.strokeStyle = SELECTION_STROKE;
    ctx.lineWidth = 2 * env.px;
    ctx.stroke();
    ctx.restore();
  }
}
