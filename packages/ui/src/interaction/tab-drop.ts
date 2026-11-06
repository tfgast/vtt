/**
 * The write of a drag released over a board tab (vtt-qf5.35; DESIGN.md §4.6
 * On the canvas, M6-D27), shared by the select tool and entry drags. Over
 * the active board's own tab there is none (the drag ends with no write).
 * Over another board's tab: a copy is spawned on that board at the tab's
 * view centre and selected; a move puts each object on that board at its
 * given position. Either ends with the `SHOW_BOARD_EXTENSION` continuation,
 * which activates that board once the write commits.
 */
import type { WireOp } from "@vtt/protocol";
import type { BoardId, ObjectId, Point } from "@vtt/schema";
import type { Continuation } from "./effects";
import type { BoardTabDrop } from "./events";

/**
 * The continuation extension a board tab drop ends with: its payload
 * `{board}` names the board to activate once the write commits.
 */
export const SHOW_BOARD_EXTENSION = "show_board";

/** What a tab drop writes: a copy of a template, or moves of objects to positions. */
export type TabDropRequest =
  | { kind: "copy"; template: ObjectId; name: string }
  | { kind: "move"; items: { id: ObjectId; position: Point }[]; name: string };

export interface TabDropWrite {
  ops: WireOp[];
  label: string;
  continuations: Continuation[];
}

/**
 * The write of a drop on `tab` by a drag stamped on `stampBoard`, or null
 * when `tab` is that board's own tab. `name` labels the write: the
 * template's name for a copy ("Copy <name>"), the dragged objects' for a
 * move ("Move <name> to <board>").
 */
export function tabDropWrite(
  tab: BoardTabDrop,
  stampBoard: BoardId,
  request: TabDropRequest,
): TabDropWrite | null {
  if (tab.board === stampBoard) return null;
  const show: Continuation = {
    type: "extension",
    name: SHOW_BOARD_EXTENSION,
    payload: { board: tab.board },
  };
  if (request.kind === "copy") {
    return {
      ops: [
        {
          type: "spawn",
          template: request.template,
          to: { type: "board", board: tab.board, position: [tab.centre[0], tab.centre[1]] },
        },
      ],
      label: `Copy ${request.name}`,
      continuations: [{ type: "select_created", opIndex: 0 }, show],
    };
  }
  return {
    ops: request.items.map(
      ({ id, position }): WireOp => ({
        type: "move",
        object: id,
        to: { type: "board", board: tab.board, position: [position[0], position[1]] },
      }),
    ),
    label: `Move ${request.name} to ${tab.name}`,
    continuations: [show],
  };
}
