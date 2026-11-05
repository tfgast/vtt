/**
 * Appearance cells (DESIGN.md §4.6 Appearance cells; M4-D4, M4-D5): the
 * ordinary user cells the renderer reads by name, plus the visibility inputs
 * that change how an object is drawn. A cell of the wrong kind (an error, a
 * `color` that is not text) is as good as absent.
 */
import type { CellView, ObjectView, WireValue, WireViewers } from "@vtt/protocol";

/**
 * A boolean cell as read: its value, `"absent"` when the view has no such
 * cell, `"invalid"` when it is an error or not a boolean.
 */
export type BooleanCell = boolean | "absent" | "invalid";

export interface Appearance {
  /** Asset path (M4-D2); non-empty text only. */
  image: string | null;
  /** CSS color; non-empty text only. */
  color: string | null;
  /** Only `"hatch"`; other values are ignored. */
  pattern: "hatch" | null;
  /** Any value but an error or `empty`, formatted compact by the scene. */
  text: WireValue | null;
  /** The label; non-empty text only. */
  name: string | null;
  faceUp: BooleanCell;
  opaque: BooleanCell;
  visibleTo: WireViewers | "absent" | "invalid";
}

function nonEmptyText(cell: CellView | undefined): string | null {
  const v = cell?.value;
  return v?.type === "text" && v.value !== "" ? v.value : null;
}

function booleanCell(cell: CellView | undefined): BooleanCell {
  if (cell === undefined) return "absent";
  return cell.value.type === "boolean" ? cell.value.value : "invalid";
}

export function readAppearance(view: ObjectView): Appearance {
  const { cells } = view;
  const text = cells.text?.value;
  const visibleTo = cells.visible_to;
  return {
    image: nonEmptyText(cells.image),
    color: nonEmptyText(cells.color),
    pattern: nonEmptyText(cells.pattern) === "hatch" ? "hatch" : null,
    text: text === undefined || text.type === "error" || text.type === "empty" ? null : text,
    name: nonEmptyText(cells.name),
    faceUp: booleanCell(cells.face_up),
    opaque: booleanCell(cells.opaque),
    visibleTo:
      visibleTo === undefined
        ? "absent"
        : visibleTo.value.type === "viewers"
          ? visibleTo.value
          : "invalid",
  };
}
