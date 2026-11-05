/**
 * The select tool's keyboard commands (vtt-3l6.7; DESIGN.md §3.3, §4.1;
 * FORMULAS.md §3.1 landing rule; docs/PROTOCOL.md §5, §6). Each command
 * captures a stamp at the key press and acts on the selection as one write:
 *
 * - Delete / Backspace: one `remove` per selected object.
 * - `F`: `set_value face_up` toggled per selected object.
 * - `]`: bring to front, a `move` of each selected object on the active
 *   board to its own position (the landing rule raises it).
 * - `[`: send to back, `set_value z` below the lowest literal `z` on the
 *   active board.
 * - Arrows: nudge each selected object on the active board by
 *   `NUDGE_STEP` (Shift: `NUDGE_STEP_LARGE`) via `set_value position`.
 *
 * Escape is the machine's: it reaches the tool as `cancel(state, "escape")`,
 * where the select tool clears the selection when no gesture is in progress.
 */
import type { CellView, InputValue, ObjectView, WireOp } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import type { DrawItem } from "../scene/scene";
import type { Effect } from "./effects";
import type { InteractionEvent } from "./events";
import { captureStamp, type ToolInput } from "./tool";

/** A nudge, in board units. */
export const NUDGE_STEP = 0.1;
/** A nudge with Shift, in board units. */
export const NUDGE_STEP_LARGE = 1;

/** A `key_down` event. */
export type KeyDownEvent = Extract<InteractionEvent, { type: "key_down" }>;

/** The `name` of an object as its label, else its id. */
function objectLabel(view: ObjectView | null, id: ObjectId): string {
  const name = view?.cells.name?.value;
  return name?.type === "text" && name.value !== "" ? name.value : id;
}

/** `<verb> <name>` for one object, `<verb> N objects` for several, with an optional suffix. */
function labelFor(verb: string, ids: readonly ObjectId[], input: ToolInput, suffix = ""): string {
  const what =
    ids.length === 1
      ? objectLabel(input.views(ids[0] as ObjectId), ids[0] as ObjectId)
      : `${ids.length} objects`;
  return `${verb} ${what}${suffix}`;
}

/** The selected objects drawn on the active board, back to front. */
function placedSelection(input: ToolInput): DrawItem[] {
  const selected = new Set(input.selection);
  return input.scene.items.filter((item) => selected.has(item.id));
}

/** Rounds away binary noise from repeated nudges (1e-9 units). */
function tidy(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/** Whether a view's `face_up` reads as face up: a literal `true`, or absent (the default). */
function isFaceUp(view: ObjectView | null): boolean {
  const cell = view?.cells.face_up;
  if (cell === undefined) return true;
  return cell.value.type === "boolean" && cell.value.value;
}

/**
 * A literal `z` as the landing rule counts it (FORMULAS.md §3.1): an absent
 * or empty `z` is 0, an overridden formula counts as literal, a formula
 * without an override does not count (null).
 */
function literalZ(cell: CellView | undefined): number | null {
  if (cell === undefined) return 0;
  if (cell.kind === "formula" && cell.overridden !== true) return null;
  const v = cell.value;
  if (v.type === "number" && Number.isFinite(v.value)) return v.value;
  if (v.type === "empty") return 0;
  return null;
}

const ARROWS: Record<string, Point> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function write(input: ToolInput, ops: WireOp[], label: string): Effect[] | null {
  const stamp = captureStamp(input);
  if (stamp === null || ops.length === 0) return null;
  return [{ type: "write", stamp, ops, label, continuations: [] }];
}

/**
 * The effects of a select-tool key command, or null when `event` is not one
 * (or there is nothing to act on, or no active board). Keys with Ctrl or
 * Meta held are never commands here (they belong to the app's keybindings).
 */
export function selectKeyEffects(event: KeyDownEvent, input: ToolInput): Effect[] | null {
  if (event.modifiers.ctrl || event.modifiers.meta) return null;
  if (input.activeBoard === null || input.selection.length === 0) return null;
  const selection = [...input.selection];
  const key = event.key;

  if (key === "Delete" || key === "Backspace") {
    const ops: WireOp[] = selection.map((object) => ({ type: "remove", object }));
    return write(input, ops, labelFor("Delete", selection, input));
  }

  if (key === "f" || key === "F") {
    const ids = selection.filter((id) => input.views(id) !== null);
    const ops: WireOp[] = ids.map((object) => ({
      type: "set_value",
      object,
      cell: "face_up",
      value: { type: "boolean", value: !isFaceUp(input.views(object)) },
    }));
    return write(input, ops, labelFor("Flip", ids, input));
  }

  if (key === "]") {
    const items = placedSelection(input);
    const board = input.activeBoard;
    const ops: WireOp[] = items.map((item) => ({
      type: "move",
      object: item.id,
      to: { type: "board", board, position: [item.anchor[0], item.anchor[1]] },
    }));
    return write(
      input,
      ops,
      labelFor(
        "Bring",
        items.map((i) => i.id),
        input,
        " to front",
      ),
    );
  }

  if (key === "[") {
    const items = placedSelection(input);
    let lowest: number | null = null;
    for (const item of input.scene.items) {
      const z = literalZ(input.views(item.id)?.cells.z);
      if (z !== null && (lowest === null || z < lowest)) lowest = z;
    }
    const base = (lowest ?? 0) - items.length;
    const ops: WireOp[] = items.map((item, i) => ({
      type: "set_value",
      object: item.id,
      cell: "z",
      value: { type: "number", value: base + i },
    }));
    return write(
      input,
      ops,
      labelFor(
        "Send",
        items.map((i) => i.id),
        input,
        " to back",
      ),
    );
  }

  const arrow = ARROWS[key];
  if (arrow !== undefined) {
    const step = event.modifiers.shift ? NUDGE_STEP_LARGE : NUDGE_STEP;
    const items = placedSelection(input);
    const ops: WireOp[] = items.map((item) => {
      const value: InputValue = {
        type: "list",
        items: [
          { type: "number", value: tidy(item.anchor[0] + arrow[0] * step) },
          { type: "number", value: tidy(item.anchor[1] + arrow[1] * step) },
        ],
      };
      return { type: "set_value", object: item.id, cell: "position", value };
    });
    return write(
      input,
      ops,
      labelFor(
        "Nudge",
        items.map((i) => i.id),
        input,
      ),
    );
  }

  return null;
}
