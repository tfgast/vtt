/**
 * Cell drops (vtt-1xv.27; DESIGN.md §4.6 The inspector: "A layout mode lets
 * the GM drag cells onto the face", Gestures: "A cell dragged from the
 * inspector onto an object adds a value element"; §7 Undo; PROTOCOL.md §5
 * `set_face`, §6; M5 plan Q1 A2/A3, review r1 finding 10, r3 finding 5).
 *
 * The inspector's cell rows are drag sources of `CELL_DRAG_MIME` with data
 * `{object, cell}` (`cellDragData`). `createCellDropHandler` makes the
 * vtt-3l6.23 `DataDropHandler` that vtt-1xv.23 registers in the runtime's
 * `dataDropHandlers` (consulted before the active tool for every
 * `data_drop`). For that mime, in the GM view, when vtt-1xv.26's
 * `faceHitAt` at the drop point hits that same object (any target on it;
 * on the board, or contained and drawn with its full face in a contents row,
 * e.g. expanded in a binder), the drop point is converted to the object's
 * frame with the hit's `toLocal` (the inverse of the accumulated transform
 * along its `path`) and the effects are one `set_face` write of vtt-1xv.18's
 * `addCellElement(face, view, cell, localPoint)`, stamped at the drop.
 * Anything else (another mime, malformed data, another object, a row
 * showing a collapsed face, view-as, no active board) is not handled (null),
 * so the event goes on to the active tool.
 */
import type { ObjectId, Point } from "@vtt/schema";
import type { FaceHit } from "../face/face-contracts";
import { faceHitAt, pathContents } from "../face/face-hit";
import { attachFaces, type FaceScene, type FaceSceneState } from "../face/face-scene";
import { apply } from "../face/face-transform";
import type { InteractionStamp } from "../interaction/contracts";
import type { Effect } from "../interaction/effects";
import type { DataDropEvent, DataDropHandler } from "../interaction/runtime";
import type { ReducerInput } from "../interaction/tool";
import type { Scene } from "../scene/scene";
import { addCellElement, layoutOfView, setFaceOps } from "./face-ops";
import { layoutLabel, objectLabel } from "./layout-tool";

/** The drag type of an inspector cell row. */
export const CELL_DRAG_MIME = "application/x-vtt-cell";

/** What a cell row carries. */
export interface CellDragData {
  object: ObjectId;
  cell: string;
}

/** The `CELL_DRAG_MIME` data of cell `cell` of `object`. */
export function cellDragData(object: ObjectId, cell: string): string {
  return JSON.stringify({ object, cell } satisfies CellDragData);
}

/** `data` as `{object, cell}` (two strings), or null. */
export function parseCellDragData(data: string): CellDragData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { object, cell } = parsed as Record<string, unknown>;
  if (typeof object !== "string" || typeof cell !== "string") return null;
  if (object === "" || cell === "") return null;
  return { object, cell };
}

export interface CellDropOptions {
  /** The session's face state (which entries are expanded, how far lists scroll). */
  faceState: FaceSceneState;
}

function isFaceScene(scene: Scene): scene is FaceScene {
  const s = scene as Partial<FaceScene>;
  return s.faces !== undefined && s.transforms !== undefined && s.presentation !== undefined;
}

let dropCounter = 0;

/**
 * The hit's object drawn with its full face: a board object, or a
 * contained one whose row shows its full list.
 */
function showsFullFace(scene: FaceScene, hit: FaceHit): boolean {
  if (hit.path.length === 0) return true;
  const lists = pathContents(scene, hit.path);
  const holder = lists.at(-1);
  if (holder === undefined || lists.length !== hit.path.length) return false;
  return holder.entries.find((e) => e.id === hit.object)?.list === "full";
}

/**
 * The cell-drop handler. The runtime's scene is used as it is when it is
 * already a face scene, else faces are attached with `faceState` (as
 * vtt-1xv.16's `withFaces` does).
 */
export function createCellDropHandler(options: CellDropOptions): DataDropHandler {
  const { faceState } = options;
  // Drops are rare: faces are attached per drop (expansion changes without a new scene).
  const facesOf = (input: ReducerInput): FaceScene =>
    isFaceScene(input.scene)
      ? input.scene
      : attachFaces(input.scene, input.views, faceState, { gm: true });
  return (event: DataDropEvent, input: ReducerInput): Effect[] | null => {
    if (event.mime !== CELL_DRAG_MIME) return null;
    if (input.viewer.type !== "gm" || input.activeBoard === null) return null;
    const data = parseCellDragData(event.data);
    if (data === null) return null;
    const scene = facesOf(input);
    const hit = faceHitAt(scene, event.board, input.camera);
    if (hit === null || hit.object !== data.object || !showsFullFace(scene, hit)) return null;
    const view = input.views(data.object);
    if (view === null) return null;
    const local: Point = apply(hit.toLocal, event.board);
    const result = addCellElement(layoutOfView(view), view, data.cell, local);
    if (!result.ok) {
      return [
        { type: "notice", level: "warning", text: `The face was not changed: ${result.message}` },
      ];
    }
    dropCounter += 1;
    const stamp: InteractionStamp = {
      interactionId: `cell-drop-${dropCounter}`,
      board: input.activeBoard,
      viewer: input.viewer,
      baseRevision: input.revision,
    };
    return [
      {
        type: "write",
        stamp,
        ops: setFaceOps(data.object, result.face),
        label: layoutLabel(`Add ${data.cell} to the face of ${objectLabel(view, data.object)}`),
        continuations: [],
      },
    ];
  };
}
