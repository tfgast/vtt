/**
 * Face drops (vtt-1xv.25; DESIGN.md §4.6 Gestures: dropping onto editor and
 * contents elements; §4.7 copy to a binder, "gives a template"; §4.1 spawn,
 * containment; docs/PROTOCOL.md §5 `move`, `spawn`, `set_value`,
 * `set_template_flag`; M4-D8; M5 plan Q1 A4 as amended in review r1, Q11,
 * Q14, Q17c, review r1 finding 9, r2 finding 2, r3 finding 2).
 *
 * A drop resolves with vtt-1xv.26's `dropTargetAt` only, then:
 *
 * - an editor element of another object → `set_value {object, cell, value:
 *   {type: "ref", object: dragged}}` (for either intent; nothing moves or
 *   spawns);
 * - the contents element of the dragged object's own container → nothing
 *   (reordering is the inspector's);
 * - another contents element → with the copy intent into a binder (its
 *   `tag` contains `"binder"`) the give-a-template write (`spawn … as:
 *   "$copy"` then `set_template_flag $copy true`, selected); with the copy
 *   intent into any other container a `spawn` at the insertion index
 *   (selected); with the move intent a `move` there;
 * - the board → the caller's own drop.
 *
 * `faceDropOverride` is vtt-3l6.7's `dropOverride` hook for the select tool
 * (one dragged object; the board is the select tool's own drop). The hook
 * receives no face state, so it resolves on `input.scene` when that already
 * carries faces (a `FaceScene`) and otherwise on faces with every entry in
 * its mode's default and no scroll; `createFaceDropOverride(faceState)`
 * resolves on the session's real expansion and scroll, and is what an app
 * wires. Faces it attaches itself carry `input.selection` and, when given,
 * the Alt-hover, so a `when_selected` list of an unselected object takes no
 * drop (DESIGN.md §4.6 Only when selected, M6-D12). Pure: every result is
 * data for the caller's single write.
 */
import type { ObjectView, WireOp } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import type { DropTarget } from "../face/face-contracts";
import { dropTargetAt } from "../face/face-hit";
import type { FaceDrawing } from "../face/face-model";
import { attachFaces, type FaceScene, type FaceSceneState } from "../face/face-scene";
import type { Continuation } from "./effects";
import type { DropIntent, DropOverride, DropOverrideResult } from "./select-tool";
import type { ReducerInput } from "./tool";

/** The tag that makes a container a binder (DESIGN.md §4.7). */
export const BINDER_TAG = "binder";

/** Face state with every entry in its mode's default and nothing scrolled. */
const DEFAULT_FACE_STATE: FaceSceneState = {
  isExpanded: (_id, mode) => mode === "full",
  scrollOffset: () => 0,
};

/** What a face drop comes to: one write, nothing at all, or the caller's board drop. */
export type FaceDropResolution =
  | { kind: "write"; write: Required<DropOverrideResult> }
  | { kind: "nothing" }
  | { kind: "board" };

export interface FaceDropRequest {
  /** The dragged object. */
  dragged: ObjectId;
  /** The intent captured at pointer down (M4-D8). */
  intent: DropIntent;
  /** The container the dragged object is in, or null on a board. */
  from: ObjectId | null;
}

function isFaceScene(scene: ReducerInput["scene"]): scene is FaceScene {
  return (scene as Partial<FaceScene>).faces instanceof Map;
}

export interface FaceSceneForOptions {
  /** The object an Alt-held drag hovers (`altHoverAt`), whose `when_selected` lists show. */
  altHover?: ObjectId | null;
}

/**
 * The face scene a drop resolves on: `input.scene` with faces attached under
 * `faceState`, `input.selection` and `opts.altHover`; without a face state
 * or an Alt-hover, `input.scene` itself when it already carries faces, else
 * faces in their default expansion with no scroll.
 */
export function faceSceneFor(
  input: ReducerInput,
  faceState?: FaceSceneState,
  opts: FaceSceneForOptions = {},
): FaceScene {
  const altHover = opts.altHover ?? null;
  if (faceState === undefined && altHover === null && isFaceScene(input.scene)) return input.scene;
  return attachFaces(input.scene, input.views, faceState ?? DEFAULT_FACE_STATE, {
    gm: input.viewer.type === "gm",
    selection: input.selection,
    ...(altHover !== null ? { altHover } : {}),
  });
}

export interface FaceDropOverrideOptions {
  /** The current Alt-hover of the drag being dropped (`altHoverAt`), read at the drop. */
  altHover?: () => ObjectId | null;
}

/** The display name of `id`: its non-empty text `name`, else its id. */
export function objectName(view: ObjectView | null, id: ObjectId): string {
  const name = view?.cells.name?.value;
  return name?.type === "text" && name.value !== "" ? name.value : id;
}

/** Whether `view`'s `tag` cell lists `"binder"`. */
export function isBinder(view: ObjectView | null): boolean {
  const tag = view?.cells.tag?.value;
  if (tag?.type !== "list") return false;
  return tag.items.some((t) => t.type === "text" && t.value === BINDER_TAG);
}

/** The container `view` is in (its `container` cell), or null. */
export function containerOf(view: ObjectView | null): ObjectId | null {
  const c = view?.cells.container?.value;
  return c?.type === "ref" ? c.object : null;
}

/** The cell of editor element `element` of `object` as drawn in `faces` (board or nested), or null. */
export function editorCellAt(faces: FaceScene, object: ObjectId, element: number): string | null {
  const search = (drawing: FaceDrawing, owner: ObjectId): string | null => {
    for (const prim of drawing.primitives) {
      if (owner === object && prim.kind === "editor" && prim.element === element) return prim.cell;
      if (prim.kind !== "contents") continue;
      for (const entry of prim.entries) {
        if (entry.id === null || entry.drawing === null) continue;
        const found = search(entry.drawing, entry.id);
        if (found !== null) return found;
      }
    }
    return null;
  };
  for (const [id, drawing] of faces.faces) {
    const found = search(drawing, id);
    if (found !== null) return found;
  }
  return null;
}

const SELECT_SPAWNED: Continuation[] = [{ type: "select_created", opIndex: 0 }];

/**
 * Giving a template (DESIGN.md §4.7; M5 plan review r2 finding 2): one write
 * spawning `template` into `binder` at `index` and marking the copy a
 * template, selected, so the recipient holds a reusable template.
 */
export function giveTemplateWrite(
  input: ReducerInput,
  template: ObjectId,
  binder: ObjectId,
  index: number,
): Required<DropOverrideResult> {
  return {
    ops: [
      {
        type: "spawn",
        template,
        to: { type: "container", container: binder, index },
        as: "$copy",
      },
      { type: "set_template_flag", object: "$copy", value: true },
    ],
    label: `Give ${objectName(input.views(template), template)}`,
    continuations: SELECT_SPAWNED,
  };
}

/** The write for dropping `request.dragged` on `target` (see the module comment). */
export function resolveFaceDrop(
  input: ReducerInput,
  faces: FaceScene,
  target: DropTarget,
  request: FaceDropRequest,
): FaceDropResolution {
  const { dragged, intent, from } = request;
  const name = objectName(input.views(dragged), dragged);
  switch (target.kind) {
    case "board":
      return { kind: "board" };
    case "editor": {
      if (target.object === dragged) return { kind: "nothing" };
      const cell = editorCellAt(faces, target.object, target.element);
      if (cell === null) return { kind: "nothing" };
      const ops: WireOp[] = [
        {
          type: "set_value",
          object: target.object,
          cell,
          value: { type: "ref", object: dragged },
        },
      ];
      const owner = objectName(input.views(target.object), target.object);
      return {
        kind: "write",
        write: { ops, label: `Set ${owner} ${cell} to ${name}`, continuations: [] },
      };
    }
    case "contents": {
      const { container, index } = target;
      if (container === from || container === dragged) return { kind: "nothing" };
      const view = input.views(container);
      const into = objectName(view, container);
      if (intent.copy && isBinder(view)) {
        return { kind: "write", write: giveTemplateWrite(input, dragged, container, index) };
      }
      if (intent.copy) {
        return {
          kind: "write",
          write: {
            ops: [
              {
                type: "spawn",
                template: dragged,
                to: { type: "container", container, index },
              },
            ],
            label: `Copy ${name} into ${into}`,
            continuations: SELECT_SPAWNED,
          },
        };
      }
      return {
        kind: "write",
        write: {
          ops: [{ type: "move", object: dragged, to: { type: "container", container, index } }],
          label: `Put ${name} into ${into}`,
          continuations: [],
        },
      };
    }
  }
}

/**
 * A `dropOverride` (vtt-3l6.7, M5 Q1 A4 as amended) resolving drops on
 * faces under `faceState` (see `faceSceneFor` without one) and
 * `options.altHover`: with exactly one
 * dragged object, an editor or contents drop is replaced by its face write;
 * anything else (several objects, the board) is the select tool's own drop.
 */
export function createFaceDropOverride(
  faceState?: FaceSceneState,
  options: FaceDropOverrideOptions = {},
): DropOverride {
  return (input, point, draggedIds, intent) => {
    if (draggedIds.length !== 1) return null;
    const dragged = draggedIds[0] as ObjectId;
    const faces = faceSceneFor(input, faceState, { altHover: options.altHover?.() ?? null });
    const target = dropTargetAt(faces, point, input.camera, [dragged]);
    const from = containerOf(input.views(dragged));
    const out = resolveFaceDrop(input, faces, target, { dragged, intent, from });
    return out.kind === "write" ? out.write : null;
  };
}

/**
 * `createFaceDropOverride()`: the hook as vtt-3l6.7 calls it, resolving on
 * `input.scene`'s faces when it carries them (else default expansion).
 */
export const faceDropOverride: (
  input: ReducerInput,
  point: Point,
  draggedIds: ObjectId[],
  intent: DropIntent,
) => DropOverrideResult | null = createFaceDropOverride();
