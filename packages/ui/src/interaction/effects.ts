/**
 * What reducers ask for (M4 plan review r1 finding 2, r2 findings 3, 4 and
 * 8; M5 plan Q1 A1). Reducers return effects and never execute them; the
 * runtime (vtt-3l6.23) executes them in order. Stamped effects (`write`,
 * `pick_file`, `upload`, a stamped `extension`) settle back to the tool that
 * emitted them as a `settled` event with the stamp's `interactionId`.
 */
import type { WireOp } from "@vtt/protocol";
import type { Bounds, ObjectId, Point } from "@vtt/schema";
import type { Camera } from "../scene/camera";
import type { CommittedWrite, InteractionStamp, NoticeLevel, Previews } from "./contracts";
import type { ToolOverlay } from "./overlays";
import type { SetToolRequest } from "./tool";

/**
 * Run in list order, only when the write is `committed` (and, per
 * vtt-3l6.23, only while the interaction is not cancelled and its board is
 * still active). A tool records any decision taken at the starting event in
 * the list it emits, e.g. "select the created object, then switch to select
 * unless Shift was held".
 */
export type Continuation =
  /** Select the object created by op `opIndex` (`createdIdAt`). */
  | { type: "select_created"; opIndex: number }
  | { type: "select"; ids: ObjectId[] }
  | ({ type: "set_tool" } & SetToolRequest)
  /**
   * A named runtime extension (M5 Q1 A1/A2), given the id created by op
   * `opIndex` (resolved as `select_created` resolves it), or null without
   * `opIndex`.
   */
  | { type: "extension"; name: string; opIndex?: number; payload?: unknown };

export type Effect =
  /** One transaction against `stamp.board` with `stamp.baseRevision` (M4-D7). */
  | {
      type: "write";
      stamp: InteractionStamp;
      ops: WireOp[];
      label: string;
      continuations: Continuation[];
    }
  | { type: "select"; ids: ObjectId[] }
  | { type: "camera"; camera: Camera }
  /** Replaces the previews; with `hold`, kept until that stamp's write is visible. */
  | { type: "previews"; previews: Previews; hold?: { stamp: InteractionStamp } }
  /** Replaces the tool overlays. */
  | { type: "overlays"; overlays: ToolOverlay[] }
  | { type: "hover"; id: ObjectId | null; zone: ObjectId | null }
  /** The object an Alt-held drag hovers, whose `when_selected` lists show (M6-D12); null ends it. */
  | { type: "alt_hover"; id: ObjectId | null }
  | { type: "notice"; level: NoticeLevel; text: string }
  | ({ type: "set_tool" } & SetToolRequest)
  | { type: "pick_file"; stamp: InteractionStamp; accept: string }
  | { type: "upload"; stamp: InteractionStamp; file: File }
  /**
   * Opens the in-place editor on `object` (the editor picks the cell when
   * `cell` is absent). `rect`, a board-space axis-aligned rectangle,
   * positions it instead of the object's bounds (M5 Q1 A5).
   */
  | { type: "open_editor"; stamp: InteractionStamp; object: ObjectId; cell?: string; rect?: Bounds }
  | { type: "close_editor" }
  /** A named runtime extension (M5 Q1 A1/A2); with a stamp it settles back as `extension`. */
  | { type: "extension"; name: string; stamp?: InteractionStamp; payload: unknown };

/** The snap step in board units (M6-D13): positions snap to half units. */
export const SNAP_STEP = 0.5;

/**
 * `point` snapped to the nearest half-unit point per axis when `snap` is on
 * (M6-D13; DESIGN.md §4.6 On the canvas), else `point` unchanged. Never -0.
 */
export function snapPoint(point: Point, snap: boolean): Point {
  if (!snap) return point;
  const to = (v: number) => Math.round(v / SNAP_STEP) * SNAP_STEP + 0;
  return [to(point[0]), to(point[1])];
}

/**
 * The id created by op `opIndex` of a committed write: the `created` record
 * with that `op_index`, else the `root` of the `copies` record with it; null
 * when that op created nothing. Never by array position (review r2 finding 4).
 */
export function createdIdAt(result: CommittedWrite, opIndex: number): ObjectId | null {
  const created = result.created.find((c) => c.op_index === opIndex);
  if (created !== undefined) return created.id;
  return result.copies.find((c) => c.op_index === opIndex)?.root ?? null;
}

/** Effects that settle back to their tool: the interaction id, or null. */
export function settlingInteraction(effect: Effect): string | null {
  switch (effect.type) {
    case "write":
    case "pick_file":
    case "upload":
      return effect.stamp.interactionId;
    case "extension":
      return effect.stamp?.interactionId ?? null;
    default:
      return null;
  }
}
