/**
 * Op builders for cell writes (docs/PROTOCOL.md §5; DESIGN.md §4.6, M4-D6,
 * M4-D17). Pure: they build `WireOp`s; sending them is the write port's.
 */
import type { CellView, InputCellContent, InputValue, ObjRef, WireOp } from "@vtt/protocol";

/**
 * The ops that commit parsed input to `object.cell`: a formula is
 * `set_formula`; a literal is `set_value`, which on a formula cell writes an
 * override (M2 `writeValue`). `current` is the cell's view when it exists;
 * the op is the same either way.
 */
export function cellInputToOps(
  object: ObjRef,
  cell: string,
  content: InputCellContent,
  _current?: CellView,
): WireOp[] {
  if (content.type === "formula") {
    return [{ type: "set_formula", object, cell, source: content.source }];
  }
  return [{ type: "set_value", object, cell, value: content }];
}

/**
 * "Replace formula with value": one `set_value` with `replace: true`, which
 * replaces the formula and any override by the literal in one undoable cell
 * effect, also on structural cells such as `visible_to` (M4-D17).
 */
export function replaceFormulaOps(object: ObjRef, cell: string, value: InputValue): WireOp[] {
  return [{ type: "set_value", object, cell, value, replace: true }];
}
