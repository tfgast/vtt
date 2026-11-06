/**
 * Contents entries dragged out onto the canvas (vtt-qf5.13; DESIGN.md §4.1
 * Containment: moving out of a container onto a board; §4.6 The inspector,
 * On the canvas, M6-D13; §7 Undo; PROTOCOL.md §5 `move`).
 *
 * The inspector's contents list rows are drag sources of `OBJECT_DRAG_MIME`
 * with data `{object, container}` (`objectDragData`). `createObjectDropHandler`
 * makes the `DataDropHandler` the app registers in the runtime's
 * `dataDropHandlers`: for that mime, with an active board, the effects are
 * one `move` of the object to that board at the drop point, the anchor
 * snapped to the nearest half-unit point while Snap is on (`snapPoint` with
 * `input.snap`, as an entry drag's board drop), stamped with the revision at
 * the drop. Anything else (another mime, malformed data, no active board) is
 * not handled (null).
 */
import type { ObjectId } from "@vtt/schema";
import type { InteractionStamp } from "../interaction/contracts";
import { objectName } from "../interaction/drop-targets";
import { type Effect, snapPoint } from "../interaction/effects";
import type { DataDropEvent, DataDropHandler } from "../interaction/runtime";
import type { ReducerInput } from "../interaction/tool";

/** The drag type of an inspector contents entry. */
export const OBJECT_DRAG_MIME = "application/x-vtt-object";

/** What a contents entry carries: the object and the container it is listed in. */
export interface ObjectDragData {
  object: ObjectId;
  container: ObjectId;
}

/** The `OBJECT_DRAG_MIME` data of entry `object` of `container`. */
export function objectDragData(object: ObjectId, container: ObjectId): string {
  return JSON.stringify({ object, container } satisfies ObjectDragData);
}

/** `data` as `{object, container}` (two non-empty strings), or null. */
export function parseObjectDragData(data: string): ObjectDragData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { object, container } = parsed as Record<string, unknown>;
  if (typeof object !== "string" || typeof container !== "string") return null;
  if (object === "" || container === "") return null;
  return { object, container };
}

let dropCounter = 0;

/** The contents-entry drop handler (see the module comment). */
export function createObjectDropHandler(): DataDropHandler {
  return (event: DataDropEvent, input: ReducerInput): Effect[] | null => {
    if (event.mime !== OBJECT_DRAG_MIME || input.activeBoard === null) return null;
    const data = parseObjectDragData(event.data);
    if (data === null) return null;
    dropCounter += 1;
    const stamp: InteractionStamp = {
      interactionId: `object-drop-${dropCounter}`,
      board: input.activeBoard,
      viewer: input.viewer,
      baseRevision: input.revision,
    };
    const position = snapPoint(event.board, input.snap === true);
    const name = objectName(input.views(data.object), data.object);
    const container = objectName(input.views(data.container), data.container);
    return [
      {
        type: "write",
        stamp,
        ops: [
          {
            type: "move",
            object: data.object,
            to: { type: "board", board: input.activeBoard, position },
          },
        ],
        label: `Take ${name} out of ${container}`,
        continuations: [],
      },
    ];
  };
}
