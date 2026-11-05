/**
 * The aggregates of FORMULAS.md §6: `sum`, `count`, `len`, `min`, `max`,
 * `avg`, `any`, `all`, `first`, `last`. Each takes exactly one argument: a
 * list is consumed, `empty` is `[]`, and any other value is a one-item list.
 * They never broadcast. Every aggregate but `len` skips `empty` items.
 */
import { bool, EMPTY, type ErrorValue, err, num, type Result, type Value } from "@vtt/schema";
import { compare, truthy } from "../eval/values";
import type { EagerFunctionDef } from "./registry";

/** The items an aggregate consumes: a list's items, `[]` for empty, else `[v]`. */
function itemsOf(v: Value): readonly Value[] {
  if (v.type === "list") return v.items;
  if (v.type === "empty") return [];
  return [v];
}

const nonEmpty = (items: readonly Value[]): Value[] => items.filter((v) => v.type !== "empty");

/**
 * The kind an orderable value sorts as (FORMULAS §4): numbers and roll
 * results together, text on its own, anything else `undefined`.
 */
export function orderKind(v: Value): "number" | "text" | undefined {
  if (v.type === "number" || v.type === "roll") return "number";
  if (v.type === "text") return "text";
  return undefined;
}

/**
 * `#TYPE` unless every value is orderable and all are of one kind (numbers
 * and rolls, or text); `undefined` when they are mutually orderable.
 */
export function orderableError(values: readonly Value[], what: string): ErrorValue | undefined {
  let kind: "number" | "text" | undefined;
  for (const v of values) {
    const k = orderKind(v);
    if (k === undefined) return err("#TYPE", `${what}: cannot order ${v.type}`);
    if (kind === undefined) kind = k;
    else if (k !== kind) return err("#TYPE", `${what}: cannot order ${kind} with ${k}`);
  }
  return undefined;
}

/** The sum of numbers and roll totals among the non-empty items, or `#TYPE`. */
function total(name: string, items: readonly Value[]): number | ErrorValue {
  let sum = 0;
  for (const v of items) {
    if (v.type === "number") sum += v.value;
    else if (v.type === "roll") sum += v.total;
    else return err("#TYPE", `${name} takes numbers and roll results, got ${v.type}`);
  }
  return Number.isFinite(sum) ? sum : err("#TYPE", `${name}: result is not a finite number`);
}

/** -0 becomes 0. */
const unsigned = (n: number): number => n + 0;

/**
 * The winning item: the first one that no later item beats. `sign` is 1 for
 * `max`, -1 for `min`. `[]` gives `empty`.
 */
function extreme(name: string, items: readonly Value[], sign: 1 | -1): Result {
  const error = orderableError(items, name);
  if (error) return error;
  let best: Value | undefined;
  for (const v of items) {
    if (best === undefined) {
      best = v;
      continue;
    }
    const c = compare(v, best);
    if (c.type === "error") return c;
    if (c.value * sign > 0) best = v;
  }
  return best ?? EMPTY;
}

function aggregate(
  name: string,
  f: (items: readonly Value[], arg: Value) => Result,
): EagerFunctionDef {
  return {
    name,
    minArgs: 1,
    maxArgs: 1,
    kind: "eager",
    broadcast: "none",
    // Without acceptsErrors the evaluator has already returned any error argument.
    impl: ([arg]) => f(itemsOf(arg as Value), arg as Value),
  };
}

export const AGGREGATE_FUNCTIONS: readonly EagerFunctionDef[] = [
  aggregate("sum", (items) => {
    const t = total("sum", nonEmpty(items));
    return typeof t === "number" ? num(unsigned(t)) : t;
  }),
  aggregate("count", (items) => num(nonEmpty(items).length)),
  aggregate("len", (items, arg) =>
    arg.type === "text" ? num([...arg.value].length) : num(items.length),
  ),
  aggregate("min", (items) => extreme("min", nonEmpty(items), -1)),
  aggregate("max", (items) => extreme("max", nonEmpty(items), 1)),
  aggregate("avg", (items) => {
    const kept = nonEmpty(items);
    const t = total("avg", kept);
    if (typeof t !== "number") return t;
    return kept.length === 0 ? EMPTY : num(unsigned(t / kept.length));
  }),
  aggregate("any", (items) => bool(nonEmpty(items).some(truthy))),
  aggregate("all", (items) => bool(nonEmpty(items).every(truthy))),
  aggregate("first", (items) => nonEmpty(items)[0] ?? EMPTY),
  aggregate("last", (items) => nonEmpty(items).at(-1) ?? EMPTY),
];
