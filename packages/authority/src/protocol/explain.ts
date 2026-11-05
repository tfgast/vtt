/** Explain methods (vtt-5su.16): stub for the red commit. */
import type {
  ExplainActionParams,
  ExplainActionResult,
  ExplainCellParams,
  ExplainCellResult,
  ExplainGroupParams,
  ExplainGroupResult,
} from "@vtt/protocol";
import type { Table } from "../engine/table";

export function explainCell(_table: Table, _params: ExplainCellParams): ExplainCellResult {
  throw new Error("not implemented");
}

export function explainGroup(_table: Table, _params: ExplainGroupParams): ExplainGroupResult {
  throw new Error("not implemented");
}

export function explainAction(_table: Table, _params: ExplainActionParams): ExplainActionResult {
  throw new Error("not implemented");
}
