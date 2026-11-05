/**
 * The function library (FORMULAS.md §5, §6): aggregates, numbers, text,
 * dice functions, `where`, and `sort`. Registered into the default registry.
 */
import { AGGREGATE_FUNCTIONS } from "./aggregates";
import { FILTER_FUNCTIONS } from "./filters";
import type { FunctionDef } from "./registry";
import { SCALAR_FUNCTIONS } from "./scalars";

export const LIBRARY_FUNCTIONS: readonly FunctionDef[] = [
  ...AGGREGATE_FUNCTIONS,
  ...SCALAR_FUNCTIONS,
  ...FILTER_FUNCTIONS,
];
