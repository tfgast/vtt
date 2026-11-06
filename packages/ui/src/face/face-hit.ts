/**
 * Hit testing and drop resolution on a face scene (DESIGN.md §4.6 Gestures:
 * drops, contents scrolling, nested objects; §4.4 nothing interactive under
 * a cover; M5 plan review r1 finding 8, r2 findings 1, 3, r3 findings 1, 2,
 * 3, 5). Candidates are the items whose presentation bounds (or footprint)
 * contain the point, in vtt-3l6.5's `hitsAt` order (`hitOrder`, M6-D10);
 * each is tested in its own frame, primitives last-drawn first, then its
 * footprint. Pure.
 */
import { type Bounds, type ObjectId, type Point, pointInRegion, type Rect } from "@vtt/schema";
import { type Camera, cameraScale } from "../scene/camera";
import { HIT_SLOP_PX, hitOrder, isCovered } from "../scene/hit-test";
import type { DrawItem } from "../scene/scene";
import type { DropTarget, FaceHit, FaceHitTarget, FaceList, FacePathEntry } from "./face-contracts";
import {
  type ContentsPrimitive,
  contentsRect,
  entryTransform,
  type FaceDrawing,
  type FaceEntry,
  type FacePrimitive,
} from "./face-model";
import type { FaceScene } from "./face-scene";
import {
  type Affine,
  aabb,
  apply,
  compose,
  invert,
  itemTransform,
  screenHeight,
} from "./face-transform";

/** One drawing being tested: whose it is, which list, its frame → board, and the contents around it. */
interface Level {
  object: ObjectId;
  list: FaceList;
  toBoard: Affine;
  path: FacePathEntry[];
}

/** How a drawing is placed: on the board, in a collapsed row, or as an expanded entry. */
type Mode = "board" | "collapsed" | "expanded";

function inRect(p: Point, r: Rect): boolean {
  return p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];
}

function inBounds(p: Point, b: Bounds): boolean {
  return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
}

/** Whether `prim` is drawn (and so hit) at its on-screen size under `toBoard` and `camera`. */
function shown(prim: FacePrimitive, toBoard: Affine, camera: Camera): boolean {
  return screenHeight(prim.rect, toBoard, camera) >= prim.minSize;
}

/** A shapeless footprint at the origin of a frame scaled by `toBoard`: within HIT_SLOP_PX on screen. */
function nearMarker(p: Point, toBoard: Affine, camera: Camera): boolean {
  const unit = Math.hypot(toBoard[0], toBoard[1]);
  return Math.hypot(p[0], p[1]) * unit * cameraScale(camera) <= HIT_SLOP_PX;
}

/** A board item's footprint, as vtt-3l6.5's `hitsAt` tests it. */
function footprint(item: DrawItem, point: Point, camera: Camera): boolean {
  if (item.shape !== null) return pointInRegion(point, item.shape, item.anchor, item.rotation);
  const distance = Math.hypot(point[0] - item.anchor[0], point[1] - item.anchor[1]);
  return distance * cameraScale(camera) <= HIT_SLOP_PX;
}

/**
 * The items whose presentation bounds or footprint contain `point`, in
 * `hitOrder` (as `hitsAt` orders them; M6-D10).
 */
function candidates(scene: FaceScene, point: Point, camera: Camera): DrawItem[] {
  return hitOrder(scene, (item) => {
    const p = scene.presentation.get(item.id) ?? item.bounds;
    return inBounds(point, p) || footprint(item, point, camera);
  });
}

function toBoardOf(scene: FaceScene, item: DrawItem): Affine {
  return scene.transforms.get(item.id) ?? itemTransform(item);
}

function hit(level: Level, rect: Rect, target: FaceHitTarget, rectFrame = level.toBoard): FaceHit {
  return {
    object: level.object,
    path: level.path,
    toLocal: invert(level.toBoard),
    rect: aabb(rect, rectFrame),
    target,
  };
}

/** The insertion index at element-local `y`: before a row on its upper half, after it on its lower half. */
function insertionIndex(c: ContentsPrimitive, y: number): number {
  let index = 0;
  c.entries.forEach((e, i) => {
    if (y >= e.row[1] + e.row[3] / 2) index = i + 1;
  });
  return index;
}

/** `p` (in the container's frame) as element-local, scrolled. */
function elementLocal(c: ContentsPrimitive, p: Point): Point {
  return [p[0] - c.rect[0], p[1] - c.rect[1] + c.offset];
}

/** The row level for `entry` of `c` in `level`'s drawing. */
function rowLevel(c: ContentsPrimitive, e: FaceEntry, id: ObjectId, level: Level): Level {
  return {
    object: id,
    list: e.list,
    toBoard: compose(level.toBoard, entryTransform(c, e)),
    path: [
      ...level.path,
      { container: level.object, element: c.element, list: level.list, transform: level.toBoard },
    ],
  };
}

/** A point inside contents primitive `c` (its rect, the clip): always a hit. */
function hitContents(c: ContentsPrimitive, p: Point, level: Level, camera: Camera): FaceHit {
  const q = elementLocal(c, p);
  const i = c.entries.findIndex((e) => inRect(q, e.row));
  const e = c.entries[i];
  if (e === undefined || e.id === null) {
    // No row, or a redacted one (nothing to target): the list itself.
    const index = insertionIndex(c, q[1]);
    return hit(level, c.rect, {
      type: "contents",
      container: level.object,
      element: c.element,
      index,
    });
  }
  const row = rowLevel(c, e, e.id, level);
  if (inRect(q, e.chevron)) {
    return hit(row, contentsRect(c, e.chevron), { type: "chevron", id: e.id }, level.toBoard);
  }
  if (e.gear !== undefined && inRect(q, e.gear)) {
    return hit(row, contentsRect(c, e.gear), { type: "gear", id: e.id }, level.toBoard);
  }
  if (e.drawing !== null) {
    const local = apply(invert(entryTransform(c, e)), p);
    const found = hitDrawing(e.drawing, local, row, e.expanded ? "expanded" : "collapsed", camera);
    if (found !== null) return found;
  }
  return hit(
    row,
    contentsRect(c, e.row),
    { type: "entry", id: e.id, container: level.object, element: c.element },
    level.toBoard,
  );
}

/**
 * `drawing` at `p` (in its frame): its primitives last-drawn first, then,
 * expanded, its base footprint. A primitive without a target of its own (a
 * default name, default ink) is the drawing's body: the entry in a
 * collapsed row (null here), the object's body elsewhere.
 */
function hitDrawing(
  drawing: FaceDrawing,
  p: Point,
  level: Level,
  mode: Mode,
  camera: Camera,
): FaceHit | null {
  for (let i = drawing.primitives.length - 1; i >= 0; i--) {
    const prim = drawing.primitives[i] as FacePrimitive;
    if (!inRect(p, prim.rect) || !shown(prim, level.toBoard, camera)) continue;
    if (prim.kind === "contents") return hitContents(prim, p, level, camera);
    if (prim.target.type === "body") {
      return mode === "collapsed" ? null : hit(level, prim.rect, { type: "body" });
    }
    return hit(level, prim.rect, prim.target);
  }
  const base = drawing.base;
  if (mode === "expanded" && base !== null) {
    const inside =
      base.shape === null
        ? nearMarker(p, level.toBoard, camera)
        : pointInRegion(p, base.shape, [0, 0], 0);
    if (inside) return hit(level, drawing.frame, { type: "body" });
  }
  return null;
}

/** A board item at `point`: its face, then its footprint. */
function hitItem(scene: FaceScene, item: DrawItem, point: Point, camera: Camera): FaceHit | null {
  const toBoard = toBoardOf(scene, item);
  const level: Level = { object: item.id, list: "full", toBoard, path: [] };
  const drawing = scene.faces.get(item.id);
  if (drawing !== undefined) {
    const found = hitDrawing(drawing, apply(invert(toBoard), point), level, "board", camera);
    if (found !== null) return found;
  }
  if (!footprint(item, point, camera)) return null;
  return {
    object: item.id,
    path: [],
    toLocal: invert(toBoard),
    rect: { ...item.bounds },
    target: { type: "body" },
  };
}

/**
 * What board point `point` hits on `scene` at `camera`: the topmost target,
 * or null (also under a cover). See vtt-1xv.14's `FaceHit` for `path` and
 * `toLocal`; a hit inside a contents element is always a row target, a
 * target on the row's child, or the list itself with the insertion index.
 */
export function faceHitAt(scene: FaceScene, point: Point, camera: Camera): FaceHit | null {
  if (isCovered(scene, point)) return null;
  for (const item of candidates(scene, point, camera)) {
    const found = hitItem(scene, item, point, camera);
    if (found !== null) return found;
  }
  return null;
}

/** A drawing searched for drops: whose it is, its frame → board, and the point in its frame. */
interface DropLevel {
  drawing: FaceDrawing;
  object: ObjectId;
  toBoard: Affine;
  p: Point;
}

/** The shown contents primitive of `level` containing its point, topmost first, or undefined. */
function contentsUnder(level: DropLevel, camera: Camera): ContentsPrimitive | undefined {
  const prims = level.drawing.primitives;
  for (let i = prims.length - 1; i >= 0; i--) {
    const c = prims[i] as FacePrimitive;
    if (c.kind === "contents" && inRect(level.p, c.rect) && shown(c, level.toBoard, camera)) {
      return c;
    }
  }
  return undefined;
}

/** The drawing of the (non-dragged) row of `c` under `level`'s point, as a level, or null. */
function rowUnder(
  c: ContentsPrimitive,
  level: DropLevel,
  dragged: ReadonlySet<ObjectId>,
): DropLevel | null {
  const q = elementLocal(c, level.p);
  const e = c.entries.find((x) => inRect(q, x.row));
  if (e === undefined || e.id === null || e.drawing === null || dragged.has(e.id)) return null;
  const t = entryTransform(c, e);
  return {
    drawing: e.drawing,
    object: e.id,
    toBoard: compose(level.toBoard, t),
    p: apply(invert(t), level.p),
  };
}

/** An editor element under the point in `level`'s drawing or, through its list's clip, a nested one. */
function editorIn(
  level: DropLevel,
  camera: Camera,
  dragged: ReadonlySet<ObjectId>,
): DropTarget | null {
  const prims = level.drawing.primitives;
  for (let i = prims.length - 1; i >= 0; i--) {
    const prim = prims[i] as FacePrimitive;
    if (prim.kind !== "editor" || prim.element === null) continue;
    if (inRect(level.p, prim.rect) && shown(prim, level.toBoard, camera)) {
      return { kind: "editor", object: level.object, element: prim.element };
    }
  }
  const c = contentsUnder(level, camera);
  const row = c === undefined ? null : rowUnder(c, level, dragged);
  return row === null ? null : editorIn(row, camera, dragged);
}

/** The innermost contents element under the point in `level`'s drawing, with its insertion index. */
function contentsIn(
  level: DropLevel,
  camera: Camera,
  dragged: ReadonlySet<ObjectId>,
): DropTarget | null {
  const c = contentsUnder(level, camera);
  if (c === undefined) return null;
  const row = rowUnder(c, level, dragged);
  const inner = row === null ? null : contentsIn(row, camera, dragged);
  if (inner !== null) return inner;
  const index = insertionIndex(c, elementLocal(c, level.p)[1]);
  return { kind: "contents", container: level.object, element: c.element, index };
}

/**
 * Where dropping `dragged` at board point `point` lands (DESIGN.md §4.6
 * Gestures; M5 plan review r3 finding 2), searching every object under the
 * point but the dragged ones, topmost first: an editor element under the
 * point (nested included), else the innermost contents element containing
 * it (at the row's index: before the row on its upper half, after it on its
 * lower half; or the end), else the board. Bodies hide neither; covers
 * block both.
 */
export function dropTargetAt(
  scene: FaceScene,
  point: Point,
  camera: Camera,
  dragged: readonly ObjectId[],
): DropTarget {
  if (isCovered(scene, point)) return { kind: "board" };
  const skip = new Set(dragged);
  const levels: DropLevel[] = [];
  for (const item of candidates(scene, point, camera)) {
    const drawing = scene.faces.get(item.id);
    if (skip.has(item.id) || drawing === undefined) continue;
    const toBoard = toBoardOf(scene, item);
    levels.push({ drawing, object: item.id, toBoard, p: apply(invert(toBoard), point) });
  }
  for (const level of levels) {
    const editor = editorIn(level, camera, skip);
    if (editor !== null) return editor;
  }
  for (const level of levels) {
    const contents = contentsIn(level, camera, skip);
    if (contents !== null) return contents;
  }
  return { kind: "board" };
}

/**
 * The contents primitive of each step of `path` (a hit's `path`, possibly
 * followed by its own `contents` target), walked from the board drawing
 * inward; stops early where the scene has no such element.
 */
export function pathContents(
  scene: FaceScene,
  path: readonly Pick<FacePathEntry, "container" | "element">[],
): ContentsPrimitive[] {
  const out: ContentsPrimitive[] = [];
  let drawing: FaceDrawing | null | undefined = scene.faces.get(path[0]?.container ?? "");
  for (const [i, step] of path.entries()) {
    if (i > 0) {
      const prev = out[i - 1] as ContentsPrimitive;
      drawing = prev.entries.find((e) => e.id === step.container)?.drawing;
    }
    const c = drawing?.primitives.find(
      (p): p is ContentsPrimitive => p.kind === "contents" && p.element === step.element,
    );
    if (c === undefined) break;
    out.push(c);
  }
  return out;
}
