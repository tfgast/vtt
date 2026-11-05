/**
 * The list methods of FORMULAS.md §5: `list.where(expr)` and
 * `list.sort(expr)` / `list.sort(expr, desc)`. Both are lazy: the target is
 * evaluated once, then `expr` once per item in order with the item as `it`
 * and its cells as bare names (`this` is unchanged). Errors are strict: the
 * first item whose expression is an error makes the whole result that error.
 */
import { err, list, type Result, type Value } from "@vtt/schema";
import { itemScope } from "../eval/scope";
import { compare, truthy } from "../eval/values";
import type { Expr } from "../syntax/ast";
import { orderableError } from "./aggregates";
import type { LazyContext, LazyFunctionDef } from "./registry";

/** The target's items: `[]` for empty, `#TYPE` for a non-list. */
function targetItems(name: string, ctx: LazyContext): readonly Value[] | Result {
  if (ctx.target === undefined) return err("#NAME", `${name} is only a method`);
  const t = ctx.evaluate(ctx.target);
  if (t.type === "error") return t;
  if (t.type === "empty") return [];
  if (t.type !== "list") return err("#TYPE", `.${name} needs a list, got ${t.type}`);
  return t.items;
}

const isItems = (x: readonly Value[] | Result): x is readonly Value[] => Array.isArray(x);

const where: LazyFunctionDef = {
  name: "where",
  minArgs: 1,
  maxArgs: 1,
  kind: "lazy",
  broadcast: "none",
  impl: (args, ctx) => {
    const items = targetItems("where", ctx);
    if (!isItems(items)) return items;
    const expr = args[0] as Expr;
    const kept: Value[] = [];
    for (const item of items) {
      const r = ctx.evaluate(expr, itemScope(ctx.scope, item));
      if (r.type === "error") return r;
      if (truthy(r)) kept.push(item);
    }
    return list(kept);
  },
};

const sort: LazyFunctionDef = {
  name: "sort",
  minArgs: 1,
  maxArgs: 1,
  kind: "lazy",
  broadcast: "none",
  impl: (args, ctx) => {
    const items = targetItems("sort", ctx);
    if (!isItems(items)) return items;
    const expr = args[0] as Expr;
    const keyed: { item: Value; key: Value }[] = [];
    for (const item of items) {
      const key = ctx.evaluate(expr, itemScope(ctx.scope, item));
      if (key.type === "error") return key;
      keyed.push({ item, key });
    }
    const keys = keyed.map((k) => k.key).filter((k) => k.type !== "empty");
    const error = orderableError(keys, "sort");
    if (error) return error;
    const direction = ctx.desc ? -1 : 1;
    // Array.prototype.sort is stable, and ties compare 0 in either direction.
    keyed.sort((a, b) => {
      const ae = a.key.type === "empty";
      const be = b.key.type === "empty";
      if (ae || be) return ae === be ? 0 : ae ? 1 : -1;
      const c = compare(a.key, b.key);
      return c.type === "error" ? 0 : c.value * direction;
    });
    return list(keyed.map((k) => k.item));
  },
};

export const FILTER_FUNCTIONS: readonly LazyFunctionDef[] = [where, sort];
