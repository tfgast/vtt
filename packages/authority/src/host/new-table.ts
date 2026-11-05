/**
 * The document of a new table (PROTOCOL.md §2, New table; DESIGN.md §7,
 * New tables and ownership; decision D25).
 */
import type { BoardId, Snapshot } from "@vtt/schema";

/** The id of the board every new table starts with. */
export const GM_BOARD_ID: BoardId = "gm_board";

/**
 * A new table's snapshot: one board `gm_board` named "GM", no objects,
 * revision 0. A fresh value on every call. Saved with an empty log and no
 * assets.
 */
export function newTableSnapshot(): Snapshot {
  return {
    revision: 0,
    next_seq: 1,
    boards: [{ id: GM_BOARD_ID, name: "GM" }],
    objects: {},
    retired_ids: [],
  };
}
