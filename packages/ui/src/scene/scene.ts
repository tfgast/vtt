/**
 * The scene model (DESIGN.md §4.1, §4.3, §4.4, §4.6 Appearance cells and
 * Default rendering until faces; FORMULAS.md §3.1, §5; docs/PROTOCOL.md §7.2,
 * §7.5): what one board looks like to one viewer, derived from object views
 * and covers. Pure geometry and appearance; drawing is vtt-3l6.6.
 */
import type { Cover, ObjectView, Viewer, WireResult, WireValue } from "@vtt/protocol";
import {
  type BoardId,
  type Bounds,
  type ObjectId,
  type Point,
  type Shape,
  shapeBounds,
} from "@vtt/schema";
import { formatValue } from "../values/format";
import { type Appearance, readAppearance } from "./appearance";
import { type Camera, cameraScale } from "./camera";

/** Fill of a non-zone without a `color`. */
export const NEUTRAL_FILL = "#c9c4b8";
/** On-screen size of a shapeless object's marker. */
export const MARKER_PX = 10;
/** Labels hide when the item is smaller than this on screen (M4-D10). */
export const LABEL_MIN_PX = 24;

/** Geometry that overrides an object's own during a gesture (vtt-3l6.22's `Previews`). */
export interface ScenePreview {
  position?: Point;
  rotation?: number;
  shape?: Shape;
}
export type ScenePreviews = ReadonlyMap<ObjectId, ScenePreview>;

export interface SceneInput {
  views: Iterable<ObjectView>;
  covers: readonly Cover[];
  board: BoardId;
  viewer: Viewer;
  selection?: readonly ObjectId[];
  hover?: ObjectId | null;
  highlight?: readonly ObjectId[];
  previews?: ScenePreviews;
  /** Formats a `text` value; defaults to compact `formatValue` with refs labelled by name. */
  formatText?: (value: WireValue) => string;
}

export interface DrawItem {
  id: ObjectId;
  anchor: Point;
  /** Degrees clockwise about the anchor. */
  rotation: number;
  /** Query order key (FORMULAS.md §5); items are already sorted by it. */
  z: number;
  /** `null`: shapeless, drawn as a MARKER_PX marker at the anchor. */
  shape: Shape | null;
  /** The rotated footprint's axis-aligned box; a point for a shapeless object. */
  bounds: Bounds;
  isZone: boolean;
  /** `null`: transparent (a zone without `color`, or a face-down object's back). */
  fill: string | null;
  image?: string;
  pattern?: "hatch";
  /** The `text` cell, formatted compact. */
  text?: string;
  /** The `name` label, drawn below the object when `labelVisible`. */
  label?: string;
  /** Drawn as the generic back plus the label only (M4-D5). */
  faceDown: boolean;
  /** The GM's face-down glyph (DESIGN.md §4.6). */
  faceDownGlyph: boolean;
  /** GM scene: an opaque zone, drawn with a 35 % dark fill and a dashed outline. */
  opaqueGm: boolean;
  /** GM scene: `visible_to` is not exactly `all`. */
  hiddenBadge: boolean;
  /** False only for a revealed opaque zone in a character scene, which shows only its color and pattern. */
  outline: boolean;
  alpha: number;
}

export type CoverItem =
  | { key: string; wholeBoard: true }
  | {
      key: string;
      wholeBoard: false;
      anchor: Point;
      rotation: number;
      shape: Shape;
      bounds: Bounds;
    };

/** Object-related outlines, drawn before covers (DESIGN.md §4.4, §4.6; M4-D16). */
export interface OverlayItem {
  kind: "selection" | "highlight" | "hover";
  id: ObjectId;
  bounds: Bounds;
}

export interface Scene {
  /** Back to front. */
  items: DrawItem[];
  covers: CoverItem[];
  objectOverlays: OverlayItem[];
  /** Views not drawn on this board (contained, on another board, or no valid position), by id. */
  skipped: ObjectId[];
  /**
   * Draw the 1-unit grid under the items (M6-D13): set from the session's
   * Snap by whoever builds the scene for drawing; absent is no grid.
   */
  grid?: boolean;
}

/** Ids are compared by code point (FORMULAS.md §5). */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  const ai = Array.from(a, (c) => c.codePointAt(0) as number);
  const bi = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
    if (ai[i] !== bi[i]) return (ai[i] as number) < (bi[i] as number) ? -1 : 1;
  }
  return ai.length < bi.length ? -1 : 1;
}

/** Two finite numbers, as the evaluator reads a position (FORMULAS.md §6). */
function anchorOf(v: WireResult | undefined): Point | null {
  if (v?.type !== "list" || v.items.length !== 2) return null;
  const [x, y] = v.items;
  if (x?.type !== "number" || y?.type !== "number") return null;
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return null;
  return [x.value, y.value];
}

/** A rotation or z: a finite number, a roll as its total, anything else 0. */
function geometryNumber(v: WireResult | undefined): number {
  const n = v?.type === "number" ? v.value : v?.type === "roll" ? v.total : 0;
  return Number.isFinite(n) ? n : 0;
}

function isEmpty(v: WireResult | undefined): boolean {
  return v === undefined || v.type === "empty";
}

/** Exactly the viewer set `[all]`; an absent `visible_to` reads as `all`. */
function visibleToAll(a: Appearance): boolean {
  if (a.visibleTo === "absent") return true;
  if (a.visibleTo === "invalid") return false;
  const { viewers } = a.visibleTo;
  return viewers.length === 1 && viewers[0] === "all";
}

interface Placed {
  view: ObjectView;
  anchor: Point;
  rotation: number;
  z: number;
  shape: Shape | null;
}

function place(view: ObjectView, board: BoardId, preview: ScenePreview | undefined): Placed | null {
  const { cells } = view;
  const boardCell = cells.board?.value;
  if (boardCell?.type !== "ref" || boardCell.object !== board) return null;
  if (!isEmpty(cells.container?.value)) return null;
  const anchor = preview?.position ?? anchorOf(cells.position?.value);
  if (anchor === null) return null;
  const shapeCell = cells.shape?.value;
  return {
    view,
    anchor: [anchor[0], anchor[1]],
    rotation: preview?.rotation ?? geometryNumber(cells.rotation?.value),
    z: geometryNumber(cells.z?.value),
    shape: preview?.shape ?? (shapeCell?.type === "shape" ? shapeCell.shape : null),
  };
}

function drawItem(p: Placed, gm: boolean, formatText: (v: WireValue) => string): DrawItem {
  const a = readAppearance(p.view);
  const isZone = p.view.cells.is_zone?.value.type === "boolean" && p.view.cells.is_zone.value.value;
  // The GM is unaffected by the fail-closed rules (DESIGN.md §4.4).
  const faceDown = gm ? a.faceUp === false : a.faceUp !== true;
  // Opaque as the cover table reads it (PROTOCOL.md §7.5): anything but `false`. For a
  // character an absent cell (omitted by per-cell visibility) fails closed; for the GM it is
  // the default, false.
  const opaque = isZone && a.opaque !== false && (!gm || a.opaque !== "absent");
  // A character sees a revealed opaque zone only through its color and pattern (§4.6).
  const colorAndPatternOnly = !gm && opaque;
  const item: DrawItem = {
    id: p.view.id,
    anchor: p.anchor,
    rotation: p.rotation,
    z: p.z,
    shape: p.shape,
    bounds: shapeBounds(p.shape, p.anchor, p.rotation),
    isZone,
    fill: null,
    faceDown,
    faceDownGlyph: gm && faceDown,
    opaqueGm: gm && opaque,
    hiddenBadge: gm && !visibleToAll(a),
    outline: !colorAndPatternOnly,
    alpha: 1,
  };
  if (a.name !== null && !colorAndPatternOnly) item.label = a.name;
  if (faceDown) return item;
  item.fill = a.color ?? (isZone ? null : NEUTRAL_FILL);
  if (colorAndPatternOnly) {
    if (a.pattern !== null) item.pattern = a.pattern;
    return item;
  }
  if (a.image !== null) item.image = a.image;
  if (a.pattern !== null) item.pattern = a.pattern;
  if (a.text !== null) {
    const text = formatText(a.text);
    if (text !== "") item.text = text;
  }
  return item;
}

export interface DrawItemOptions {
  anchor: Point;
  /** Degrees clockwise about the anchor. */
  rotation: number;
  gm: boolean;
  /** Formats the `text` cell (`SceneInput.formatText`). */
  formatText: (value: WireValue) => string;
}

/**
 * The draw item `buildScene` makes for `view` placed at `anchor` with
 * `rotation` (z and shape read from the view; no preview), for a GM scene
 * when `gm`. Faces draw a contained object with it at the origin (M5 plan
 * review r2 finding 3).
 */
export function drawItemFor(view: ObjectView, opts: DrawItemOptions): DrawItem {
  const shapeCell = view.cells.shape?.value;
  const placed: Placed = {
    view,
    anchor: [opts.anchor[0], opts.anchor[1]],
    rotation: opts.rotation,
    z: geometryNumber(view.cells.z?.value),
    shape: shapeCell?.type === "shape" ? shapeCell.shape : null,
  };
  return drawItem(placed, opts.gm, opts.formatText);
}

function coverItem(cover: Cover): CoverItem {
  const { region } = cover;
  if ("whole_board" in region) return { key: cover.key, wholeBoard: true };
  const anchor: Point = [region.position[0], region.position[1]];
  return {
    key: cover.key,
    wholeBoard: false,
    anchor,
    rotation: region.rotation,
    shape: region.shape,
    bounds: shapeBounds(region.shape, anchor, region.rotation),
  };
}

export function buildScene(input: SceneInput): Scene {
  const views = new Map<ObjectId, ObjectView>();
  for (const view of input.views) if (!views.has(view.id)) views.set(view.id, view);
  const formatText =
    input.formatText ??
    ((value: WireValue) =>
      formatValue(value, {
        mode: "compact",
        refLabel: (id) => {
          const name = views.get(id)?.cells.name?.value;
          return name?.type === "text" && name.value !== "" ? name.value : null;
        },
      }).text);
  const gm = input.viewer.type === "gm";

  const placed: Placed[] = [];
  const skipped: ObjectId[] = [];
  for (const view of views.values()) {
    const p = place(view, input.board, input.previews?.get(view.id));
    if (p === null) skipped.push(view.id);
    else placed.push(p);
  }
  placed.sort((a, b) => (a.z !== b.z ? (a.z < b.z ? -1 : 1) : compareIds(a.view.id, b.view.id)));
  skipped.sort(compareIds);
  const items = placed.map((p) => drawItem(p, gm, formatText));

  const byId = new Map(items.map((i) => [i.id, i]));
  const objectOverlays: OverlayItem[] = [];
  const outline = (kind: OverlayItem["kind"], ids: Iterable<ObjectId>) => {
    for (const id of ids) {
      const found = byId.get(id);
      if (found) objectOverlays.push({ kind, id, bounds: found.bounds });
    }
  };
  outline("highlight", input.highlight ?? []);
  outline("hover", input.hover ? [input.hover] : []);
  outline("selection", input.selection ?? []);

  const covers = input.covers.filter((c) => c.board === input.board).map(coverItem);
  return { items, covers, objectOverlays, skipped };
}

/** Whether `item`'s name label is drawn at `camera`: it has one and is at least LABEL_MIN_PX on screen (M4-D10). */
export function labelVisible(item: DrawItem, camera: Camera): boolean {
  if (item.label === undefined) return false;
  const size =
    item.shape === null
      ? MARKER_PX
      : Math.max(item.bounds.maxX - item.bounds.minX, item.bounds.maxY - item.bounds.minY) *
        cameraScale(camera);
  return size >= LABEL_MIN_PX;
}
