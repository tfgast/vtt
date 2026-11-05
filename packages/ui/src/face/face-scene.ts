/**
 * The face scene (DESIGN.md §4.6 faces on the canvas, zoom as level of
 * detail; §4.4 face-down objects show their back and name; M5 plan Q8, Q11,
 * review r1 finding 8, r2 findings 1, 3): vtt-3l6.5's scene with each board
 * item's face resolved, the bounds its face occupies (for culling and hit
 * candidates) and its frame transform. Pure: drawing is vtt-1xv.15's, hit
 * testing `face-hit.ts`.
 */
import type { ObjectView, WireValue } from "@vtt/protocol";
import type { Bounds, ObjectId } from "@vtt/schema";
import { buildScene, type DrawItem, type Scene, type SceneInput } from "../scene/scene";
import {
  type FaceDrawing,
  faceBaseItem,
  presentationBounds,
  resolveFace,
  type ViewLookup,
} from "./face-model";
import type { FaceStateStore } from "./face-state";
import { type Affine, itemTransform } from "./face-transform";

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
}

/**
 * `scene` with faces: one `resolveFace` drawing (full list) per board item.
 * An item whose view has a layout loses its `image`, `text` and `label`
 * (`faceBaseItem`: the face shows them; a face-down item keeps its label).
 * A face-down item gets no drawing, except a board template's gear-only one
 * (vtt-1xv.14). An item without a view keeps its footprint only.
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

/** vtt-3l6.5's `buildScene`, then `attachFaces` with the same views, viewer and formatter. */
export function buildFaceScene(input: SceneInput, opts: { faceState: FaceSceneState }): FaceScene {
  const list: ObjectView[] = [...input.views];
  const byId = new Map<ObjectId, ObjectView>();
  for (const view of list) if (!byId.has(view.id)) byId.set(view.id, view);
  const scene = buildScene({ ...input, views: list });
  return attachFaces(scene, (id) => byId.get(id) ?? null, opts.faceState, {
    gm: input.viewer.type === "gm",
    ...(input.formatText ? { formatText: input.formatText } : {}),
  });
}

/**
 * The board bounds vtt-3l6.6's renderer culls `item` by (its `cullBounds`
 * option): the presentation bounds, or the item's own bounds without them.
 */
export function faceCullBounds(item: DrawItem, scene: FaceScene): Bounds {
  return scene.presentation.get(item.id) ?? item.bounds;
}
