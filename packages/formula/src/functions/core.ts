/**
 * The core functions the evaluator itself relies on (FORMULAS.md §2.3, §5):
 * `if` and `iserror`. Library and query functions live in library.ts and
 * queries.ts.
 */
import { bool } from "@vtt/schema";
import { truthy } from "../eval/values";
import type { Expr } from "../syntax/ast";
import { createRegistry, type FunctionDef, type Registry } from "./registry";

/** `if(cond, a, b)`: evaluates only the chosen branch and returns it unchanged. */
const ifFunction: FunctionDef = {
  name: "if",
  minArgs: 3,
  maxArgs: 3,
  kind: "lazy",
  broadcast: "none",
  impl: (args, ctx) => {
    const [cond, then, otherwise] = args as readonly [Expr, Expr, Expr];
    const c = ctx.evaluate(cond);
    if (c.type === "error") return c;
    return ctx.evaluate(truthy(c) ? then : otherwise);
  },
};

/** `iserror(x)`: true iff `x` is an error. */
const iserror: FunctionDef = {
  name: "iserror",
  minArgs: 1,
  maxArgs: 1,
  kind: "eager",
  broadcast: "none",
  acceptsErrors: true,
  impl: ([x]) => bool(x?.type === "error"),
};

export const CORE_FUNCTIONS: readonly FunctionDef[] = [ifFunction, iserror];

/** A registry of only the core functions (no library, no queries). */
export function coreRegistry(): Registry {
  return createRegistry(CORE_FUNCTIONS);
}
