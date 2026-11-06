/**
 * The face model (DESIGN.md §4.6 The face, Zoom as level of detail, Face
 * elements, Collapsed face, Default face, Gestures: contents scrolling and
 * nested objects, Ink; §4.4 face-down objects show their back; §4.7 contents
 * entries collapsed by default; docs/PROTOCOL.md §7.2; M5 plan Q8, Q9, Q11,
 * Q19 and reviews r1 8, 11, 16, r2 1, 3, r3 1, 8; Only when selected,
 * M6-D12): what an object's face
 * looks like to one viewer, as primitives in the object's local frame
 * (origin at the anchor, y down, unrotated). Pure: drawing is vtt-1xv.15's,
 * hit testing vtt-1xv.26's.
 */
import type { ActionStateView, FaceElementView, ObjectView, WireValue } from "@vtt/protocol";
import {
  type Bounds,
  COLLAPSED_FRAME,
  defaultFaceFrame,
  type ObjectId,
  type Point,
  type Rect,
} from "@vtt/schema";
import { readAppearance } from "../scene/appearance";
import { type DrawItem, drawItemFor } from "../scene/scene";
import { type FormatTone, formatValue, type RefLabel } from "../values/format";
import type { FaceHitTarget, FaceList } from "./face-contracts";
import type { EntriesMode, FaceStateStore } from "./face-state";
import {
  type Affine,
  aabb,
  compose,
  itemTransform,
  rectToRect,
  translate,
  unionRect,
} from "./face-transform";

/** The `element` of a default face's contents list, which no stored element backs. */
export const DEFAULT_CONTENTS_ELEMENT = -1;
/** A contents row (collapsed) is this fraction of the element's width high: a 6 × 0.6 row frame. */
export const CONTENTS_ROW_RATIO = 0.1;
/** Default face action strip (Q11): button size, spacing and gap below the frame, in units. */
export const STRIP_BUTTON_WIDTH = 1.5;
export const STRIP_BUTTON_HEIGHT = 0.45;
export const STRIP_BUTTON_GAP = 0.1;
export const STRIP_TOP_GAP = 0.15;
/** Default face contents list: width in units and the most rows shown before it scrolls. */
export const DEFAULT_CONTENTS_WIDTH = 6;
export const DEFAULT_CONTENTS_ROWS = 8;
/** `minSize` of the default face's strip buttons and contents list, in CSS px. */
export const DEFAULT_FACE_MIN_PX = 12;
/** The board-template gear: its size in units and its `minSize` in CSS px. */
export const BOARD_GEAR_SIZE = 0.3;
export const BOARD_GEAR_MIN_PX = 10;
/**
 * The count badge standing in for a hidden `when_selected` list (M6-D12):
 * its height in units (at most the element's) and its width as a multiple
 * of its height (at most the element's).
 */
export const COUNT_BADGE_SIZE = 0.5;
export const COUNT_BADGE_ASPECT = 1.6;
/** A row gear's side as a fraction of the collapsed row height. */
const ROW_GEAR_RATIO = 0.7;

export type FaceTextSize = "small" | "normal" | "large" | "huge";
export type FaceTextAlign = "left" | "center" | "right";

/** The target of a value element (also an image or ink one). */
export type ValueTarget = { type: "value"; cell: string };
export type ButtonTarget = Extract<FaceHitTarget, { type: "button" }>;
/** No specific target: hit as the object's body (or, in a collapsed row, the entry). */
export type BodyTarget = { type: "body" };

interface PrimitiveCommon {
  /** In the drawing's frame. */
  rect: Rect;
  /** Not drawn or hit while `screenHeight(rect, accumulated, camera)` is below this (CSS px). */
  minSize: number;
  /** The face element's `index`; null for what no stored element backs (default faces, gears). */
  element: number | null;
}

/** A cell shown as its value, formatted compact (vtt-3l6.3's `formatValue`). */
export interface TextPrimitive extends PrimitiveCommon {
  kind: "text";
  text: string;
  tone: FormatTone;
  size: FaceTextSize;
  align: FaceTextAlign;
  /** The caption to prefix (the cell name), when the element's style asks for one. */
  caption?: string;
  target: ValueTarget | BodyTarget;
}

/** A value element on the `image` cell holding a non-empty path. */
export interface ImagePrimitive extends PrimitiveCommon {
  kind: "image";
  path: string;
  target: ValueTarget;
}

/** An ink value, strokes in the object's local units (DESIGN.md §4.6 Ink and text). */
export interface InkPrimitive extends PrimitiveCommon {
  kind: "ink";
  strokes: Point[][];
  target: ValueTarget | BodyTarget;
}

/** A button bound to an action; `enabled`/`reason` from the view's `action_states`. */
export interface ButtonPrimitive extends PrimitiveCommon {
  kind: "button";
  action: string;
  label: string;
  enabled: boolean;
  reason?: ActionStateView["reason"];
  template: boolean;
  target: ButtonTarget;
}

/** A cell shown as an in-place editor. */
export interface EditorPrimitive extends PrimitiveCommon {
  kind: "editor";
  cell: string;
  text: string;
  tone: FormatTone;
  size: FaceTextSize;
  align: FaceTextAlign;
  caption?: string;
  target: { type: "editor"; cell: string };
}

/** The edit-template gear of a template placed directly on a board (M5 plan r1 finding 11). */
export interface GearPrimitive extends PrimitiveCommon {
  kind: "gear";
  id: ObjectId;
  target: { type: "gear"; id: ObjectId };
}

/**
 * One row of a contents element. Rects are element-local (origin at the
 * element rect's top-left) and before the scroll offset.
 */
export interface FaceEntry {
  /** Null for a redacted entry. */
  id: ObjectId | null;
  expanded: boolean;
  /** The child's list drawn in the row. */
  list: FaceList;
  template: boolean;
  row: Rect;
  chevron: Rect;
  /** Template entries only. */
  gear?: Rect;
  /**
   * Child frame → container frame: the element rect, the row and one
   * uniform scale. Without the scroll offset (`entryTransform` adds it).
   */
  transform: Affine;
  /** Null only for a redacted or missing entry, drawn as "hidden". */
  drawing: FaceDrawing | null;
}

/** An object's `contents` rendered inline (clipped to `rect` by consumers). */
export interface ContentsPrimitive extends PrimitiveCommon {
  kind: "contents";
  element: number;
  /** The scroll offset, clamped to `[0, maxOffset]`. */
  offset: number;
  /** `max(0, total rows height − rect height)`. */
  maxOffset: number;
  entries: FaceEntry[];
  /** Where no row is; `index` here is the end of the list (hit testing computes the real one). */
  target: { type: "contents"; container: ObjectId; element: number; index: number };
}

export type FacePrimitive =
  | TextPrimitive
  | ImagePrimitive
  | InkPrimitive
  | ButtonPrimitive
  | EditorPrimitive
  | GearPrimitive
  | ContentsPrimitive;

/** An object's face in its local frame (origin at the anchor, y down, unrotated). */
export interface FaceDrawing {
  /** The full-face frame (the shape's box) or `COLLAPSED_FRAME`. */
  frame: Rect;
  /** The union of the frame and every primitive's rect. */
  bounds: Rect;
  /** Nested drawings only: the board drawing of the object at the origin, drawn first. */
  base: DrawItem | null;
  primitives: FacePrimitive[];
}

export type ViewLookup = (id: ObjectId) => ObjectView | null | undefined;

export interface ResolveFaceOptions {
  views: ViewLookup;
  faceState: Pick<FaceStateStore, "isExpanded" | "scrollOffset">;
  list: FaceList;
  gm: boolean;
  /** Formats a base's `text` cell; defaults to `buildScene`'s compact formatting with names. */
  formatText?: (value: WireValue) => string;
  /**
   * Whether object `id`'s `when_selected` contents elements are shown (it or
   * a descendant is selected, or an Alt-held drag hovers it; M6-D12).
   * Default: none is.
   */
  revealed?: (id: ObjectId) => boolean;
}

interface Ctx {
  views: ViewLookup;
  faceState: Pick<FaceStateStore, "isExpanded" | "scrollOffset">;
  gm: boolean;
  revealed: (id: ObjectId) => boolean;
  formatText: (value: WireValue) => string;
  refLabel: RefLabel;
}

const BODY: BodyTarget = { type: "body" };

function nonEmptyName(view: ObjectView | null | undefined): string | null {
  const name = view?.cells.name?.value;
  return name?.type === "text" && name.value !== "" ? name.value : null;
}

/**
 * The face of `view` in `list` for one viewer. A full list draws the
 * layout's elements, or the default face when the view has none; a
 * collapsed list draws `face.collapsed`, or the default collapsed face (the
 * `name`). A face-down object has no face primitives (collapsed: its
 * name). A template not in a container gets the board gear, face down too.
 */
export function resolveFace(view: ObjectView, opts: ResolveFaceOptions): FaceDrawing {
  const refLabel: RefLabel = (id) => nonEmptyName(opts.views(id));
  const ctx: Ctx = {
    views: opts.views,
    faceState: opts.faceState,
    gm: opts.gm,
    revealed: opts.revealed ?? (() => false),
    refLabel,
    formatText:
      opts.formatText ?? ((value) => formatValue(value, { mode: "compact", refLabel }).text),
  };
  return resolveDrawing(view, opts.list, ctx, false, new Set([view.id]));
}

/** Face down as the scene reads it: for a character, anything but `face_up = true` (fail closed). */
function isFaceDown(view: ObjectView, gm: boolean): boolean {
  const faceUp = readAppearance(view).faceUp;
  return gm ? faceUp === false : faceUp !== true;
}

function isContained(view: ObjectView): boolean {
  const c = view.cells.container?.value;
  return c !== undefined && c.type !== "empty";
}

function shapeFrame(view: ObjectView): Rect {
  const s = view.cells.shape?.value;
  return defaultFaceFrame(s?.type === "shape" ? s.shape : null);
}

function finish(frame: Rect, base: DrawItem | null, primitives: FacePrimitive[]): FaceDrawing {
  return { frame, bounds: unionRect(frame, ...primitives.map((p) => p.rect)), base, primitives };
}

function resolveDrawing(
  view: ObjectView,
  list: FaceList,
  ctx: Ctx,
  nested: boolean,
  ancestors: ReadonlySet<ObjectId>,
): FaceDrawing {
  const faceDown = isFaceDown(view, ctx.gm);
  if (list === "collapsed") {
    const custom = faceDown ? undefined : view.face?.collapsed;
    const primitives = custom
      ? elementPrimitives(view, custom, ctx, ancestors)
      : [defaultCollapsedName(view, ctx)];
    return finish([...COLLAPSED_FRAME], null, primitives);
  }
  const frame = shapeFrame(view);
  const base = nested
    ? faceBaseItem(
        drawItemFor(view, { anchor: [0, 0], rotation: 0, gm: ctx.gm, formatText: ctx.formatText }),
        view,
      )
    : null;
  // Face down: no face content (DESIGN.md §4.4), but a board template keeps its gear.
  const primitives = faceDown
    ? []
    : view.face
      ? elementPrimitives(view, view.face.elements, ctx, ancestors)
      : defaultPrimitives(view, frame, ctx, ancestors);
  if (!nested && view.is_template && !isContained(view)) {
    primitives.push({
      kind: "gear",
      rect: [frame[0] + frame[2], frame[1] - BOARD_GEAR_SIZE, BOARD_GEAR_SIZE, BOARD_GEAR_SIZE],
      minSize: BOARD_GEAR_MIN_PX,
      element: null,
      id: view.id,
      target: { type: "gear", id: view.id },
    });
  }
  return finish(frame, base, primitives);
}

/**
 * `item` as drawn under `view`'s face: for a face-up object with a layout,
 * without `image`, `text` and `label` (the face shows them); otherwise
 * unchanged. A face-down object keeps its name label (DESIGN.md §4.4).
 */
export function faceBaseItem(item: DrawItem, view: ObjectView): DrawItem {
  if (view.face === undefined || item.faceDown) return item;
  const { image: _image, text: _text, label: _label, ...rest } = item;
  return rest;
}

function defaultCollapsedName(view: ObjectView, ctx: Ctx): TextPrimitive {
  const name = view.cells.name?.value;
  const f =
    name === undefined
      ? { text: "", tone: "muted" as const }
      : formatValue(name, { mode: "compact", refLabel: ctx.refLabel });
  return {
    kind: "text",
    rect: [...COLLAPSED_FRAME],
    minSize: 0,
    element: null,
    text: f.text,
    tone: f.tone,
    size: "normal",
    align: "left",
    target: BODY,
  };
}

function buttonPrimitive(
  view: ObjectView,
  action: string,
  label: string,
  rect: Rect,
  minSize: number,
  element: number | null,
): ButtonPrimitive {
  const state = (view.action_states ?? []).find((s) => s.name === action);
  const enabled = state?.enabled ?? false;
  const target: ButtonTarget = { type: "button", action, enabled, template: view.is_template };
  if (!enabled && state?.reason !== undefined) target.reason = state.reason;
  const out: ButtonPrimitive = {
    kind: "button",
    rect,
    minSize,
    element,
    action,
    label,
    enabled,
    template: view.is_template,
    target,
  };
  if (target.reason !== undefined) out.reason = target.reason;
  return out;
}

type CellElementView = Extract<FaceElementView, { type: "value" | "editor" }>;

function cellPrimitive(view: ObjectView, e: CellElementView, ctx: Ctx): FacePrimitive {
  const v = view.cells[e.cell]?.value;
  const common = { rect: e.rect, minSize: e.min_size ?? 0, element: e.index };
  if (e.type === "value") {
    const target: ValueTarget = { type: "value", cell: e.cell };
    if (v?.type === "ink") return { kind: "ink", ...common, strokes: v.strokes, target };
    if (e.cell === "image" && v?.type === "text" && v.value !== "") {
      return { kind: "image", ...common, path: v.value, target };
    }
  }
  const f =
    v === undefined
      ? { text: "", tone: "muted" as const }
      : formatValue(v, { mode: "compact", refLabel: ctx.refLabel });
  const style = {
    size: e.style?.size ?? "normal",
    align: e.style?.align ?? "center",
    ...(e.style?.caption ? { caption: e.cell } : {}),
  };
  if (e.type === "editor") {
    return {
      kind: "editor",
      ...common,
      cell: e.cell,
      text: f.text,
      tone: f.tone,
      ...style,
      target: { type: "editor", cell: e.cell },
    };
  }
  return {
    kind: "text",
    ...common,
    text: f.text,
    tone: f.tone,
    ...style,
    target: { type: "value", cell: e.cell },
  };
}

/** The shown elements, in list order, each keeping its `index`. */
function elementPrimitives(
  view: ObjectView,
  elements: readonly FaceElementView[],
  ctx: Ctx,
  ancestors: ReadonlySet<ObjectId>,
): FacePrimitive[] {
  const out: FacePrimitive[] = [];
  for (const e of elements) {
    if (!e.shown) continue;
    switch (e.type) {
      case "value":
      case "editor":
        out.push(cellPrimitive(view, e, ctx));
        break;
      case "button":
        out.push(
          buttonPrimitive(view, e.action, e.label ?? e.action, e.rect, e.min_size ?? 0, e.index),
        );
        break;
      case "contents":
        if (e.when_selected === true && !ctx.revealed(view.id)) {
          const badge = countBadge(view, e.rect, e.index);
          if (badge !== null) out.push(badge);
          break;
        }
        out.push(
          layoutContents(
            view,
            e.rect,
            e.index,
            e.entries ?? "collapsed",
            e.min_size ?? 0,
            ctx,
            ancestors,
          ),
        );
        break;
    }
  }
  return out;
}

/**
 * The badge in a hidden `when_selected` list's place (M6-D12): the number
 * of readable entries (redacted ones are not counted), at the lower right
 * of the element's rect, drawn at any zoom (no `minSize`, M6-D16) and hit
 * as the object's body; null when there is nothing readable to count.
 */
function countBadge(view: ObjectView, rect: Rect, element: number): TextPrimitive | null {
  const count = contentsRefs(view).filter((id) => id !== null).length;
  if (count === 0) return null;
  const [x, y, w, h] = rect;
  const bh = Math.min(COUNT_BADGE_SIZE, h);
  const bw = Math.min(w, bh * COUNT_BADGE_ASPECT);
  return {
    kind: "text",
    rect: [x + w - bw, y + h - bh, bw, bh],
    minSize: 0,
    element,
    text: String(count),
    tone: "normal",
    size: "large",
    align: "right",
    target: BODY,
  };
}

/**
 * The default face's contents list rect, in `view`'s frame: below the frame
 * and its action strip, centred, one row per entry up to
 * `DEFAULT_CONTENTS_ROWS`; null when `contents` has no entries.
 */
export function defaultContentsRect(view: ObjectView): Rect | null {
  const count = contentsRefs(view).length;
  if (count === 0) return null;
  const frame = shapeFrame(view);
  const centre = frame[0] + frame[2] / 2;
  let bottom = frame[1] + frame[3];
  if (view.actions.length > 0) bottom += STRIP_TOP_GAP + STRIP_BUTTON_HEIGHT;
  const w = DEFAULT_CONTENTS_WIDTH;
  const rows = Math.min(count, DEFAULT_CONTENTS_ROWS);
  return [centre - w / 2, bottom + STRIP_TOP_GAP, w, rows * rowHeight(w)];
}

/**
 * The default face (Q11): the `ink` cell over the frame, a strip of action
 * buttons below the frame, and a collapsed contents list below that, each
 * centred under the frame. The list behaves as a `when_selected` one
 * (M6-D12, amending M5-D10): while `view` is not revealed, its count badge
 * stands at the lower right of the list's first row.
 */
function defaultPrimitives(
  view: ObjectView,
  frame: Rect,
  ctx: Ctx,
  ancestors: ReadonlySet<ObjectId>,
): FacePrimitive[] {
  const out: FacePrimitive[] = [];
  const ink = view.cells.ink?.value;
  if (ink?.type === "ink") {
    out.push({
      kind: "ink",
      rect: frame,
      minSize: 0,
      element: null,
      strokes: ink.strokes,
      target: BODY,
    });
  }
  const centre = frame[0] + frame[2] / 2;
  const bottom = frame[1] + frame[3];
  const n = view.actions.length;
  if (n > 0) {
    const width = n * STRIP_BUTTON_WIDTH + (n - 1) * STRIP_BUTTON_GAP;
    const top = bottom + STRIP_TOP_GAP;
    view.actions.forEach(({ name }, i) => {
      const x = centre - width / 2 + i * (STRIP_BUTTON_WIDTH + STRIP_BUTTON_GAP);
      const rect: Rect = [x, top, STRIP_BUTTON_WIDTH, STRIP_BUTTON_HEIGHT];
      out.push(buttonPrimitive(view, name, name, rect, DEFAULT_FACE_MIN_PX, null));
    });
  }
  const rect = defaultContentsRect(view);
  if (rect !== null && !ctx.revealed(view.id)) {
    // At the lower right of the list's first row, however many rows it has.
    const firstRow: Rect = [rect[0], rect[1], rect[2], rowHeight(rect[2])];
    const badge = countBadge(view, firstRow, DEFAULT_CONTENTS_ELEMENT);
    if (badge !== null) out.push(badge);
  } else if (rect !== null) {
    out.push(
      layoutContents(
        view,
        rect,
        DEFAULT_CONTENTS_ELEMENT,
        "collapsed",
        DEFAULT_FACE_MIN_PX,
        ctx,
        ancestors,
      ),
    );
  }
  return out;
}

/** The `contents` cell's entries in order: an id, or null for a redacted one. */
function contentsRefs(view: ObjectView): (ObjectId | null)[] {
  const v = view.cells.contents?.value;
  if (v?.type !== "list") return [];
  return v.items.map((item) => (item.type === "ref" ? item.object : null));
}

function rowHeight(width: number): number {
  return width / (1 / CONTENTS_ROW_RATIO); // 6 / 10 is exactly 0.6; 6 * 0.1 is not
}

function layoutContents(
  view: ObjectView,
  rect: Rect,
  element: number,
  mode: EntriesMode,
  minSize: number,
  ctx: Ctx,
  ancestors: ReadonlySet<ObjectId>,
): ContentsPrimitive {
  const width = rect[2];
  const rowH = rowHeight(width);
  const chevronW = rowH;
  const inner = width - chevronW;
  const gear = rowH * ROW_GEAR_RATIO;
  const gearInset = (rowH - gear) / 2;
  const toContainer = translate(rect[0], rect[1]);
  const collapsedFrame: Rect = [...COLLAPSED_FRAME];

  const entries: FaceEntry[] = [];
  let y = 0;
  for (const id of contentsRefs(view)) {
    const chevron: Rect = [0, y, chevronW, rowH];
    // A missing view, or one already being drawn above this row (inconsistent views), is hidden.
    const child = id === null || ancestors.has(id) ? null : (ctx.views(id) ?? null);
    if (child === null) {
      entries.push({
        id,
        expanded: false,
        list: "collapsed",
        template: false,
        row: [0, y, width, rowH],
        chevron,
        transform: compose(toContainer, rectToRect(collapsedFrame, [chevronW, y, inner, rowH])),
        drawing: null,
      });
      y += rowH;
      continue;
    }
    const inside = new Set(ancestors).add(child.id);
    const expanded = ctx.faceState.isExpanded(child.id, mode);
    let drawing: FaceDrawing;
    let height: number;
    let transform: Affine;
    if (expanded) {
      drawing = resolveDrawing(child, "full", ctx, true, inside);
      const b = drawing.bounds;
      height = Math.max(rowH, b[3] * (inner / b[2]));
      transform = compose(toContainer, rectToRect(b, [chevronW, y, inner, height]));
    } else {
      drawing = resolveDrawing(child, "collapsed", ctx, true, inside);
      height = rowH;
      transform = compose(toContainer, rectToRect(collapsedFrame, [chevronW, y, inner, rowH]));
    }
    const entry: FaceEntry = {
      id: child.id,
      expanded,
      list: expanded ? "full" : "collapsed",
      template: child.is_template,
      row: [0, y, width, height],
      chevron,
      transform,
      drawing,
    };
    if (child.is_template) entry.gear = [width - gear - gearInset, y + gearInset, gear, gear];
    entries.push(entry);
    y += height;
  }
  const maxOffset = Math.max(0, y - rect[3]);
  const stored = ctx.faceState.scrollOffset(view.id, element);
  const offset = Number.isNaN(stored) ? 0 : Math.min(maxOffset, Math.max(0, stored));
  return {
    kind: "contents",
    rect,
    minSize,
    element,
    offset,
    maxOffset,
    entries,
    target: { type: "contents", container: view.id, element, index: entries.length },
  };
}

/** An entry's child frame → its container's frame, the scroll offset applied. */
export function entryTransform(contents: ContentsPrimitive, entry: FaceEntry): Affine {
  return compose(translate(0, -contents.offset), entry.transform);
}

/** An element-local rect of `contents` (a row, chevron or gear) in the container's frame, scrolled. */
export function contentsRect(contents: ContentsPrimitive, r: Rect): Rect {
  return [contents.rect[0] + r[0], contents.rect[1] + r[1] - contents.offset, r[2], r[3]];
}

/**
 * The scroll offset that reveals `entryId`'s row (expanded height
 * included): when it fits, the smallest change that shows it whole; when it
 * is taller than the rect, its top at the rect's top. Clamped to `[0,
 * maxOffset]`; the current offset for an unknown entry.
 */
export function revealOffset(contents: ContentsPrimitive, entryId: ObjectId): number {
  const entry = contents.entries.find((e) => e.id === entryId);
  if (entry === undefined) return contents.offset;
  const [, top, , height] = entry.row;
  const visible = contents.rect[3];
  const current = contents.offset;
  let offset = current;
  if (height > visible || top < current) offset = top;
  else if (top + height > current + visible) offset = top + height - visible;
  return Math.min(contents.maxOffset, Math.max(0, offset));
}

/**
 * Board-space bounds of an item with its face: the footprint's bounds ∪
 * the drawing's bounds after the item's anchor and rotation.
 */
export function presentationBounds(item: DrawItem, drawing: FaceDrawing | null): Bounds {
  const b = item.bounds;
  if (drawing === null) return { ...b };
  const d = aabb(drawing.bounds, itemTransform(item));
  return {
    minX: Math.min(b.minX, d.minX),
    minY: Math.min(b.minY, d.minY),
    maxX: Math.max(b.maxX, d.maxX),
    maxY: Math.max(b.maxY, d.maxY),
  };
}
