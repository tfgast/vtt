import type { Value } from "./values";

/** Formula source. Distinct from text, which is always a literal string. */
export interface FormulaContent {
  type: "formula";
  source: string;
}

/** What a cell holds: a literal value or a formula. */
export type CellContent = Value | FormulaContent;
