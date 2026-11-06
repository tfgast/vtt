/**
 * The face scene (DESIGN.md §4.6 faces on the canvas, zoom as level of
 * detail; §4.4 face-down objects show their back and name; M5 plan Q8, Q11,
 * review r1 finding 8, r2 findings 1, 3; Only when selected, M6-D12):
 * vtt-3l6.5's scene with each board item's face resolved, the bounds its
 * face occupies (for culling and hit candidates) and its frame transform.
 * Pure: drawing is vtt-1xv.15's, hit testing `face-hit.ts`.
 */
import type { ObjectView, WireValue } from "@vtt/protocol";
import type { Bounds, ObjectId, Point, Rect } from "@vtt/schema";
import { decoratedBounds } from "../render/canvas2d";
import { persistentTextBounds } from "../render/face-draw";
import type { Camera } from "../scene/camera";
import { hitsAt } from "../scene/hit-test";
import { buildScene, type DrawItem, type Scene, type SceneInput } from "../scene/scene";
import {
  defaultContentsRect,
  type FaceDrawing,
  faceBaseItem,
  presentationBounds,
  resolveFace,
  type ViewLookup,
} from "./face-model";
import type { FaceStateStore } from "./face-state";
import { type Affine, apply, invert, itemTransform } from "./face-transform";

export type FaceScene = Scene & {
  /** Each board item's full-list face, by id; absent for a face-down item with nothing on its face. */
  faces: ReadonlyMap<ObjectId, FaceDrawing>;
  /** Board-space bounds of each item with its face (`presentationBounds`). */
  presentation: ReadonlyMap<ObjectId, Bounds>;
  /** Each item's frame → board (`itemTransform`). */
  transforms: ReadonlyMap<ObjectId, Affine>;
};

export type FaceSceneState = Pick<FaceStateStore, "isExpanded" | "scrollOffset">;

export interface AttachFacesOptions {
  gm: boolean;
  /** Formats a nested base's `text` cell (`SceneInput.formatText`); resolveFace's default when absent. */
  formatText?: (value: WireValue) => string;
  /**
   * The selection, board and contained objects alike (M6-D12: a
   * `when_selected` list shows while its object or a descendant is
   * selected). Absent: the board items `scene` outlines as selected.
   */
  selection?: readonly ObjectId[];
  /** The object an Alt-held drag hovers (`altHoverAt`), whose `when_selected` lists show. */
  altHover?: ObjectId | null;
}

/** The container `view` is in, or null. */
function containerOf(view: ObjectView | null | undefined): ObjectId | null {
  const c = view?.cells.container?.value;
  return c?.type === "ref" ? c.object : null;
}

/**
 * The objects whose `when_selected` lists show (M6-D12): each of `ids` and
 * every container above it, at any depth.
 */
export function revealedObjects(ids: Iterable<ObjectId>, views: ViewLookup): Set<ObjectId> {
  const out = new Set<ObjectId>();
  for (const id of ids) {
    let current: ObjectId | null = id;
    while (current !== null && !out.has(current)) {
      out.add(current);
      current = containerOf(views(current));
    }
  }
  return out;
}

/** `scene`'s selection outlines: the selected board items. */
function outlinedSelection(scene: Scene): ObjectId[] {
  return scene.objectOverlays.filter((o) => o.kind === "selection").map((o) => o.id);
}

/**
 * `scene` with faces: one `resolveFace` drawing (full list) per board item.
 * An item whose view has a layout loses its `image`, `text` and `label`
 * (`faceBaseItem`: the face shows them; a face-down item keeps its label).
 * A face-down item gets no drawing, except a board template's gear-only one
 * (vtt-1xv.14). An item without a view keeps its footprint only. A
 * `when_selected` contents element is resolved only for the objects
 * `revealedObjects` gives for the selection and the Alt-hover (M6-D12),
 * else as its count badge.
 */
export function attachFaces(
  scene: Scene,
  views: ViewLookup,
  faceState: FaceSceneState,
  opts: AttachFacesOptions,
): FaceScene {
  const faces = new Map<ObjectId, FaceDrawing>();
  const presentation = new Map<ObjectId, Bounds>();
  const transforms = new Map<ObjectId, Affine>();
  const selected = opts.selection ?? outlinedSelection(scene);
  const shown = revealedObjects(
    opts.altHover == null ? selected : [...selected, opts.altHover],
    views,
  );
  const revealed = (id: ObjectId) => shown.has(id);
  const items: DrawItem[] = scene.items.map((item) => {
    const view = views(item.id) ?? null;
    let out = item;
    let drawing: FaceDrawing | null = null;
    if (view !== null) {
      out = faceBaseItem(item, view);
      const resolved = resolveFace(view, {
        views,
        faceState,
        list: "full",
        gm: opts.gm,
        revealed,
        ...(opts.formatText ? { formatText: opts.formatText } : {}),
      });
      if (!item.faceDown || resolved.primitives.length > 0) drawing = resolved;
    }
    if (drawing !== null) faces.set(item.id, drawing);
    presentation.set(item.id, presentationBounds(out, drawing));
    transforms.set(item.id, itemTransform(out));
    return out;
  });
  return { ...scene, items, faces, presentation, transforms };
}

export interface BuildFaceSceneOptions {
  faceState: FaceSceneState;
  /** `AttachFacesOptions.altHover`. */
  altHover?: ObjectId | null;
}

/**
 * vtt-3l6.5's `buildScene`, then `attachFaces` with the same views, viewer,
 * selection and formatter (and `opts.altHover`).
 */
export function buildFaceScene(input: SceneInput, opts: BuildFaceSceneOptions): FaceScene {
  const list: ObjectView[] = [...input.views];
  const byId = new Map<ObjectId, ObjectView>();
  for (const view of list) if (!byId.has(view.id)) byId.set(view.id, view);
  const scene = buildScene({ ...input, views: list });
  return attachFaces(scene, (id) => byId.get(id) ?? null, opts.faceState, {
    gm: input.viewer.type === "gm",
    selection: input.selection ?? [],
    ...(opts.altHover != null ? { altHover: opts.altHover } : {}),
    ...(input.formatText ? { formatText: input.formatText } : {}),
  });
}

/**
 * The board bounds vtt-3l6.6's renderer culls `item` by (its `cullBounds`
 * option): the presentation bounds, or the item's own bounds without them.
 * Given the `camera`, they also hold its persistent text as magnified to
 * the legibility floor at that zoom (`persistentTextBounds`, M6-D17,
 * vtt-qf5.66) and the default renderer's screen-size padding for the marker,
 * the hidden badge and the label strip (`decoratedBounds`, vtt-qf5.41).
 * Draw culling only: hit testing keeps the presentation bounds.
 */
export function faceCullBounds(item: DrawItem, scene: FaceScene, camera?: Camera): Bounds {
  const b = scene.presentation.get(item.id) ?? item.bounds;
  if (camera === undefined) return b;
  const grown = union(b, decoratedBounds(item, camera));
  const drawing = scene.faces.get(item.id);
  if (drawing === undefined) return grown;
  const transform = scene.transforms.get(item.id) ?? itemTransform(item);
  const t = persistentTextBounds(drawing, transform, camera);
  return t === null ? grown : union(grown, t);
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * The `when_selected` contents element of `view`'s full list that its face
 * shows, if any; for an object without a face, its default contents list
 * (`defaultContentsRect`), which shows only when selected too (M6-D12).
 */
function whenSelectedRect(view: ObjectView | null | undefined): Rect | null {
  if (view == null) return null;
  if (view.face == null) return defaultContentsRect(view);
  const e = view.face.elements.find((x) => x.type === "contents" && x.when_selected === true);
  return e === undefined || !e.shown ? null : e.rect;
}

function inRect(p: Point, r: Rect): boolean {
  return p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];
}

export interface AltHoverInput {
  /** The board scene (faces not needed). */
  scene: Scene;
  views: ViewLookup;
  /** The Alt-hover so far in this drag, or null. */
  previous: ObjectId | null;
  /** The pointer, in board units. */
  point: Point;
  camera: Camera;
  /** Alt held at this event. */
  alt: boolean;
  /** The dragged objects, which are never hovered. */
  dragged: readonly ObjectId[];
}

/**
 * The object an Alt-held drag hovers after this pointer event (DESIGN.md
 * §4.6 Only when selected, M6-D12), for `AttachFacesOptions.altHover`.
 * Without Alt, null. The hover holds while the pointer stays in `previous`'s
 * footprint or its revealed list's rect, tested in the object's rotated
 * local frame (so a drag from the object onto its
 * list keeps the list); otherwise it starts on the first non-dragged object
 * whose footprint is under the pointer (`hitsAt` order, as the Alt drop
 * picks its target) when that object is not a zone and its face shows a
 * `when_selected` contents element (or, without a face, has contents);
 * else null.
 */
export function altHoverAt(input: AltHoverInput): ObjectId | null {
  const { scene, views, previous, point, camera, alt } = input;
  if (!alt) return null;
  const dragged = new Set(input.dragged);
  const hits = hitsAt(scene, point, camera).filter((id) => !dragged.has(id));
  if (previous !== null && !dragged.has(previous)) {
    const item = scene.items.find((i) => i.id === previous);
    if (item !== undefined) {
      if (hits.includes(previous)) return previous;
      const r = whenSelectedRect(views(previous));
      // The list's rect in the object's frame, so a rotated list is tested as drawn.
      if (r !== null && inRect(apply(invert(itemTransform(item)), point), r)) return previous;
    }
  }
  const first = hits[0];
  if (first === undefined) return null;
  const item = scene.items.find((i) => i.id === first);
  if (item === undefined || item.isZone) return null;
  return whenSelectedRect(views(first)) === null ? null : first;
}
