/**
 * Image files dropped from the operating system onto the canvas
 * (vtt-qf5.33; DESIGN.md §4.6 Appearance cells, §8.1; §7 Undo and writes in
 * the UI; PROTOCOL.md §1 `POST /assets`; M6 plan Q7 alternative a).
 *
 * `createImageFileDropHandler` makes the runtime's `FileDropHandler`, offered
 * every `file_drop` before the active tool, whatever tool is active. With an
 * active board:
 * - The first dropped file of an accepted type (`IMAGE_ACCEPT`: PNG, JPEG,
 *   WebP, GIF, the types the authority stores) is used; when other files
 *   were dropped with it, an info notice says they were ignored. No
 *   accepted file: a warning notice, nothing written.
 * - The stamp (board, viewer, base revision) is captured at the drop, and
 *   the topmost object under the drop point (`hitTest`, the select tool's
 *   order) decides the target.
 * - On an object: when its `image` cell holds a formula, a warning notice
 *   and nothing else (a drop never overwrites or overrides a formula).
 *   Otherwise the file is uploaded with the tool context's `upload` and one
 *   `set_value {image: text path}` write follows, stamped at the drop,
 *   labelled "Set image of <name>".
 * - On empty board space: the file is uploaded and created as the image
 *   tool creates it (`imageCreation`), anchored at the drop point (snapped
 *   with Snap on), selected, and the select tool made active. The drop is a
 *   runtime interaction from the drop on (`FileDropContext.begin`): when the
 *   tool active at the drop is cancelled during the upload (Escape, a tool,
 *   board or viewer switch), the object is still created but neither
 *   selected nor the tool changed, as for the image tool's own uploads.
 * An upload failure is an error notice and writes nothing; a refused write
 * is a notice from the write path. Without an active board the event goes
 * on to the active tool.
 */
import type { WireOp } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { objectLabel } from "../face-editor/layout-tool";
import type { InteractionStamp } from "../interaction/contracts";
import {
  DROP_IMAGE_NOTICE,
  fileStem,
  imageCreation,
  isAcceptedImage,
  MAX_LABEL_LENGTH,
} from "../interaction/create-tools";
import { type Effect, snapPoint } from "../interaction/effects";
import type { FileDropContext, FileDropEvent, FileDropHandler } from "../interaction/runtime";
import type { ReducerInput } from "../interaction/tool";
import { hitTest } from "../scene/hit-test";

let dropCounter = 0;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "Set image of <name>", shortened with an ellipsis to fit MAX_LABEL_LENGTH. */
export function setImageLabel(name: string): string {
  const full = `Set image of ${name}`;
  if (full.length <= MAX_LABEL_LENGTH) return full;
  let label = "";
  for (const ch of full) {
    if (label.length + ch.length + 1 > MAX_LABEL_LENGTH) break;
    label += ch;
  }
  return `${label}…`;
}

/** The image file-drop handler for the runtime's `fileDropHandlers`. */
export function createImageFileDropHandler(): FileDropHandler {
  return (event: FileDropEvent, input: ReducerInput, ctx: FileDropContext): Effect[] | null => {
    if (input.activeBoard === null) return null;
    const file = event.files.find(isAcceptedImage);
    if (file === undefined) {
      return [{ type: "notice", level: "warning", text: DROP_IMAGE_NOTICE }];
    }
    const effects: Effect[] = [];
    const ignored = event.files.length - 1;
    if (ignored > 0) {
      effects.push({
        type: "notice",
        level: "info",
        text: `Only "${file.name}" was used; ${ignored} other ${ignored === 1 ? "file was" : "files were"} ignored.`,
      });
    }
    dropCounter += 1;
    const stamp: InteractionStamp = {
      interactionId: `file-drop-${dropCounter}`,
      board: input.activeBoard,
      viewer: input.viewer,
      baseRevision: input.revision,
    };
    const name = fileStem(file.name);
    const target = hitTest(input.scene, event.board, input.camera);
    if (target !== null) {
      const view = input.views(target);
      const label = objectLabel(view, target);
      if (view?.cells.image?.kind === "formula") {
        effects.push({
          type: "notice",
          level: "warning",
          text: `The image of ${label} is a formula; the dropped image was not used.`,
        });
        return effects;
      }
      uploadThen(ctx, stamp, file, name, (asset) => [
        setImageWrite(stamp, target, label, asset.path),
      ]);
      return effects;
    }
    const at = snapPoint(event.board, input.snap === true);
    uploadThen(ctx, stamp, file, name, (asset) => [
      imageCreation({ stamp, shift: false }, at, name, asset),
    ]);
    return effects;
  };
}

function setImageWrite(
  stamp: InteractionStamp,
  object: ObjectId,
  label: string,
  path: string,
): Effect {
  const op: WireOp = {
    type: "set_value",
    object,
    cell: "image",
    value: { type: "text", value: path },
  };
  return { type: "write", stamp, ops: [op], label: setImageLabel(label), continuations: [] };
}

/**
 * Begins the drop's interaction (so a cancel of the tool active at the drop
 * suppresses its continuations), uploads `file`, then executes `then`'s
 * effects; an upload failure is an error notice.
 */
function uploadThen(
  ctx: FileDropContext,
  stamp: InteractionStamp,
  file: File,
  name: string,
  then: (asset: { path: string; width: number; height: number }) => Effect[],
): void {
  const end = ctx.begin(stamp.interactionId);
  ctx.toolContext
    .upload(file)
    .then(
      (asset) => ctx.execute(then(asset)),
      (e: unknown) =>
        ctx.toolContext.notify("error", `The image "${name}" was not used: ${messageOf(e)}`),
    )
    .finally(end);
}
