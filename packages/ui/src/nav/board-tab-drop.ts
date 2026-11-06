/**
 * Dropping a canvas drag on a board tab (vtt-qf5.35; DESIGN.md §4.6 On the
 * canvas, M6-D27). Canvas drags are pointer gestures of the interaction
 * runtime, and the board tabs are DOM chrome: the canvas captures the
 * pointer, so a release over a tab still arrives as the canvas's
 * `pointer_up`. `BoardCanvas` asks `boardTabResolver`'s function which tab,
 * if any, is under the release point (`document.elementFromPoint`, then the
 * nearest `[data-board-tab]`, which `BoardTabs` puts on every tab) and
 * passes it on the event as `boardTab`; the select tool turns a drag
 * released there into the write, and its `SHOW_BOARD_EXTENSION`
 * continuation (`showBoardHandler`) activates that board once committed.
 */
import type { BoardId } from "@vtt/schema";
import type { BoardTabDrop } from "../interaction/events";
import type { ExtensionContinuationHandler } from "../interaction/runtime";
import type { TableSession } from "../session/table-session";
import type { CameraStore } from "../state/camera-store";
import type { UiStore } from "../state/ui-state";
import { boardLabel } from "./BoardTabs";

/** The attribute holding a board tab's board id. */
export const BOARD_TAB_ATTRIBUTE = "data-board-tab";

/** The board id of the board tab at a client point of `doc`, or null. */
export function boardTabAt(doc: Document, clientX: number, clientY: number): BoardId | null {
  // Not every DOM implements hit testing (jsdom does not): no tab is found there.
  if (typeof doc.elementFromPoint !== "function") return null;
  const element = doc.elementFromPoint(clientX, clientY);
  const tab = element?.closest(`[${BOARD_TAB_ATTRIBUTE}]`) ?? null;
  return tab?.getAttribute(BOARD_TAB_ATTRIBUTE) ?? null;
}

export interface BoardTabResolverOptions {
  session: Pick<TableSession, "getSnapshot">;
  cameraStore: Pick<CameraStore, "peek">;
  /** Default: the global `document`. */
  doc?: Document;
}

/**
 * `BoardCanvas`'s `boardTabAt`: the tab under a client point as a drop
 * target, with its board's label and the centre of its view (the camera
 * remembered for it, else the default view's centre, 0,0).
 */
export function boardTabResolver(
  options: BoardTabResolverOptions,
): (clientX: number, clientY: number) => BoardTabDrop | null {
  const { session, cameraStore } = options;
  return (clientX, clientY) => {
    const doc = options.doc ?? document;
    const id = boardTabAt(doc, clientX, clientY);
    if (id === null) return null;
    const board = session.getSnapshot().boards.find((b) => b.id === id);
    if (board === undefined) return null;
    const camera = cameraStore.peek(id);
    return {
      board: id,
      name: boardLabel(board),
      centre: camera === null ? [0, 0] : [camera.x, camera.y],
    };
  };
}

/** The `SHOW_BOARD_EXTENSION` continuation: activates the payload's `board`. */
export function showBoardHandler(
  ui: Pick<UiStore, "setActiveBoard">,
): ExtensionContinuationHandler {
  return (_id, payload) => {
    const board = (payload as { board?: unknown } | undefined)?.board;
    if (typeof board === "string") void ui.setActiveBoard(board);
  };
}
