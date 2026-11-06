/**
 * Keyboard focus over a face's targets (vtt-qf5.26; DESIGN.md §4.6 On the
 * canvas, Gestures; M5 plan section 5). Pure: `withFaces` keeps the focus
 * and activates it through its pointer path; this module lists the targets
 * and steps through them.
 *
 * `faceFocusTargets(scene, object, camera)` lists the targets a click on
 * board item `object` could press: its buttons, editor elements, and each
 * contents entry's chevron and gear, as `FaceHit`s shaped exactly as
 * `faceHitAt` would return them for a click at the target's centre. Reading
 * order: a drawing's primitives top to bottom, then left to right (by their
 * rect's top-left corner, ties in list order); a contents element stands
 * where its rect does and yields, entry by entry in list order, the entry's
 * chevron, its gear, then the targets of the entry's own drawing (collapsed
 * or expanded), recursively. A primitive not drawn at `camera` (below its
 * `min_size`) is skipped with everything in it, as is a target whose centre
 * lies under a cover; a target scrolled out of its lists is kept, with the
 * scroll offsets that reveal it (`reveal`): through every list around it,
 * the entry's row reveal when that shows the target, else the target's own
 * rect brought into view (an expanded entry taller than its list).
 */
import type { ObjectId, Point, Rect } from "@vtt/schema";
import type { Camera } from "../scene/camera";
import { isCovered } from "../scene/hit-test";
import type { FaceHit, FaceHitTarget, FaceList, FacePathEntry } from "./face-contracts";
import {
  type ContentsPrimitive,
  contentsRect,
  entryTransform,
  type FaceDrawing,
  type FaceEntry,
  type FacePrimitive,
  revealOffset,
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

/** The face target kinds keyboard focus visits. */
export type FaceFocusKind = "button" | "editor" | "chevron" | "gear";

/** A list scroll that brings a focused entry into view. */
export interface FaceFocusReveal {
  container: ObjectId;
  element: number;
  offset: number;
  max: number;
}

/** One focusable target of a board item's face. */
export interface FaceFocusTarget {
  /** Stable across re-resolves of the face: the path, the object, the kind and its name. */
  key: string;
  /** What a click at the target's centre hits. */
  hit: FaceHit;
  /** The target's rect in the board item's frame (origin at its anchor, unrotated). */
  rect: Rect;
  /** The scrolls, outermost first, that show the target's entries in their lists. */
  reveal: FaceFocusReveal[];
}

/** The keyboard face focus `withFaces` keeps: one target of the single selected board item. */
export interface FaceFocus {
  object: ObjectId;
  key: string;
  /** The target's position in the last listing, kept when the target goes away. */
  index: number;
}

interface Level {
  object: ObjectId;
  list: FaceList;
  toBoard: Affine;
  /** This drawing's frame → the board item's frame. */
  toItem: Affine;
  path: FacePathEntry[];
  /** The lists around this drawing, outermost first: each list and the entry drawn in it. */
  lists: { container: ObjectId; c: ContentsPrimitive; e: FaceEntry }[];
}

function shown(rect: Rect, minSize: number, toBoard: Affine, camera: Camera): boolean {
  return screenHeight(rect, toBoard, camera) >= minSize;
}

/** `rect` after `m` as a rect: exact for a scale and translation (entries' transforms). */
function asRect(rect: Rect, m: Affine): Rect {
  const [a, b0, c, d, e, f] = m;
  const [x, y, w, h] = rect;
  if (b0 === 0 && c === 0 && a > 0 && d > 0) return [a * x + e, d * y + f, a * w, d * h];
  const b = aabb(rect, m);
  return [b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY];
}

function centreOf(rect: Rect): Point {
  return [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
}

/** Reading order: top, then left, then list order (a stable sort). */
function readingOrder(primitives: readonly FacePrimitive[]): FacePrimitive[] {
  return [...primitives].sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
}

/** Element-local `rect` of list `c` would be wholly shown at scroll `offset`. */
function showsAt(c: ContentsPrimitive, rect: Rect, offset: number): boolean {
  const eps = 1e-9;
  return rect[1] >= offset - eps && rect[1] + rect[3] <= offset + c.rect[3] + eps;
}

/**
 * The scroll of list `c` that shows element-local `rect` of entry `id`: the
 * entry's own reveal (`revealOffset`) when that shows the rect; else the
 * smallest change from the current offset that shows it whole, or its top
 * at the list's top when it is taller than the list. Clamped.
 */
function revealRect(c: ContentsPrimitive, id: ObjectId, rect: Rect): number {
  const row = revealOffset(c, id);
  if (showsAt(c, rect, row)) return row;
  const [, top, , height] = rect;
  let offset = c.offset;
  if (height > c.rect[3] || top < offset) offset = top;
  else if (top + height > offset + c.rect[3]) offset = top + height - c.rect[3];
  return Math.min(c.maxOffset, Math.max(0, offset));
}

/**
 * The scrolls, outermost first, that bring a target into view through every
 * list around it: `rect` in the innermost entry's drawing frame, or
 * `elementLocal` already in the innermost list's element-local frame (a
 * chevron or row gear). Computed innermost first, each outer list seeing the
 * target where the inner scrolls leave it.
 */
function revealFor(
  lists: Level["lists"],
  rect: Rect,
  elementLocal: Rect | null,
): FaceFocusReveal[] {
  const out: FaceFocusReveal[] = [];
  let r = rect;
  for (let k = lists.length - 1; k >= 0; k--) {
    const { container, c, e } = lists[k] as Level["lists"][number];
    let local: Rect;
    if (k === lists.length - 1 && elementLocal !== null) local = elementLocal;
    else {
      const u = asRect(r, e.transform);
      local = [u[0] - c.rect[0], u[1] - c.rect[1], u[2], u[3]];
    }
    const offset = revealRect(c, e.id as ObjectId, local);
    out.unshift({ container, element: c.element, offset, max: c.maxOffset });
    r = [local[0] + c.rect[0], local[1] + c.rect[1] - offset, local[2], local[3]];
  }
  return out;
}

function keyOf(level: Level, kind: FaceFocusKind, name: string, element: number | null): string {
  const path = level.path.map((p) => `${p.container}#${p.element}`).join(">");
  return JSON.stringify([path, level.object, kind, name, element]);
}

/**
 * The board item `object`'s focusable face targets on `scene` at `camera`,
 * in reading order (see the module comment); empty when it has no face.
 */
export function faceFocusTargets(
  scene: FaceScene,
  object: ObjectId,
  camera: Camera,
): FaceFocusTarget[] {
  const item = scene.items.find((i) => i.id === object);
  const drawing = scene.faces.get(object);
  if (item === undefined || drawing === undefined) return [];
  const toBoard = scene.transforms.get(object) ?? itemTransform(item);
  const out: FaceFocusTarget[] = [];

  const push = (
    level: Level,
    rect: Rect,
    rectFrame: Level,
    target: FaceHitTarget,
    kind: FaceFocusKind,
    name: string,
    element: number | null,
    elementLocal: Rect | null = null,
  ) => {
    if (isCovered(scene, apply(rectFrame.toBoard, centreOf(rect)))) return;
    out.push({
      key: keyOf(level, kind, name, element),
      hit: {
        object: level.object,
        path: level.path,
        toLocal: invert(level.toBoard),
        rect: aabb(rect, rectFrame.toBoard),
        target,
      },
      rect: asRect(rect, rectFrame.toItem),
      reveal: revealFor(level.lists, rect, elementLocal),
    });
  };

  const contents = (c: ContentsPrimitive, level: Level) => {
    for (const e of c.entries) {
      if (e.id === null) continue;
      const t = entryTransform(c, e);
      const row: Level = {
        object: e.id,
        list: e.list,
        toBoard: compose(level.toBoard, t),
        toItem: compose(level.toItem, t),
        path: [
          ...level.path,
          {
            container: level.object,
            element: c.element,
            list: level.list,
            transform: level.toBoard,
          },
        ],
        lists: [...level.lists, { container: level.object, c, e }],
      };
      push(
        row,
        contentsRect(c, e.chevron),
        level,
        { type: "chevron", id: e.id },
        "chevron",
        e.id,
        null,
        e.chevron,
      );
      if (e.gear !== undefined) {
        const gear = contentsRect(c, e.gear);
        push(row, gear, level, { type: "gear", id: e.id }, "gear", e.id, null, e.gear);
      }
      if (e.drawing !== null) walk(e.drawing, row);
    }
  };

  const walk = (d: FaceDrawing, level: Level) => {
    for (const prim of readingOrder(d.primitives)) {
      if (!shown(prim.rect, prim.minSize, level.toBoard, camera)) continue;
      switch (prim.kind) {
        case "button":
          push(level, prim.rect, level, prim.target, "button", prim.action, prim.element);
          break;
        case "editor":
          push(level, prim.rect, level, prim.target, "editor", prim.cell, prim.element);
          break;
        case "gear":
          push(level, prim.rect, level, prim.target, "gear", prim.id, prim.element);
          break;
        case "contents":
          contents(prim, level);
          break;
        default:
          break;
      }
    }
  };

  walk(drawing, {
    object,
    list: "full",
    toBoard,
    toItem: [1, 0, 0, 1, 0, 0],
    path: [],
    lists: [],
  });
  return out;
}

/**
 * The focus after a Tab (`backwards`: Shift+Tab) over `targets` from
 * `current`: the next target in order, wrapping at either end. Without a
 * current focus on `object` the first (backwards: the last); with one whose
 * key is gone, the target now at its index (clamped) counts as current.
 * Null when there are no targets.
 */
export function stepFaceFocus(
  targets: readonly FaceFocusTarget[],
  object: ObjectId,
  current: FaceFocus | null,
  backwards: boolean,
): FaceFocus | null {
  const n = targets.length;
  if (n === 0) return null;
  let next: number;
  if (current === null || current.object !== object) {
    next = backwards ? n - 1 : 0;
  } else {
    const at = targets.findIndex((t) => t.key === current.key);
    const from = at >= 0 ? at : Math.min(current.index, n - 1);
    next = (from + (backwards ? -1 : 1) + n) % n;
  }
  const t = targets[next] as FaceFocusTarget;
  return { object, key: t.key, index: next };
}

/**
 * `focus` against a fresh listing: the same target, re-indexed; when its key
 * is gone, the target now at its index (clamped); null when there are no
 * targets. Returns the target too.
 */
export function resolveFaceFocus(
  targets: readonly FaceFocusTarget[],
  focus: FaceFocus,
): { focus: FaceFocus; target: FaceFocusTarget } | null {
  const n = targets.length;
  if (n === 0) return null;
  const at = targets.findIndex((t) => t.key === focus.key);
  const index = at >= 0 ? at : Math.min(focus.index, n - 1);
  const target = targets[index] as FaceFocusTarget;
  return { focus: { object: focus.object, key: target.key, index }, target };
}
