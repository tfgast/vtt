/**
 * The value steps (FORMULAS.md §8.3 `set`, `add`, `append`, `roll`,
 * `shuffle`, `each`; §8.2 paths; §2.2 rolls act as totals; M5-D3, M5-D5):
 * `coreHandlers`, written against the executor's `StepContext` (invoke.ts).
 *
 * - `set(path, v)`: `writeValue` (an override on a formula cell; `tag`
 *   takes a list of text and `name` text, by the primitive's type checks).
 * - `add(path, v)`: the current value (read-your-writes) and `v` each a
 *   number, a roll (its total) or `empty` (0); writes the sum as a number,
 *   recording the addend on the cell effect (`addWrite`, M6-D22).
 * - `append(path, v)`: the current value a list or `empty` (as `[]`);
 *   writes it with `v` appended as one item.
 * - `roll(d) -> path`: `d` a dice value; `rollInto` (cause `roll`).
 * - `shuffle(r)`: `shuffleWith` on `r`'s contents.
 * - `each(list, step)`: the list evaluated once (a list; `empty` as `[]`; a
 *   scalar as one item), then the step per item with `it` bound; at most
 *   `MAX_EACH_ITEMS` items, else `#LIMIT`.
 *
 * Every writing step refuses the protected cells of FORMULAS §8.3 (`id`,
 * `contents`, `container`, `board`, `is_zone`, `template`, `shape`) with
 * `protected_cell`. An expression error is a step error with its code; the
 * evaluator already makes a record `#TYPE`. An absent current cell reads as
 * `empty`; a current value that is an error refuses with its code.
 */
import type { PathNode, Step } from "@vtt/formula";
import { MAX_EACH_ITEMS, type Result, type Value } from "@vtt/schema";
import { Rejected } from "../store/transaction";
import type { StepContext, StepHandlerEntry, StepOutcome } from "./invoke";

const OK: StepOutcome = { ok: true };

/** Cells no step may write (FORMULAS §8.3, M5-D3). */
const PROTECTED: ReadonlySet<string> = new Set([
  "id",
  "contents",
  "container",
  "board",
  "is_zone",
  "template",
  "shape",
]);

/** The path's target, refusing protected cells; or the refusal. */
function target(
  ctx: StepContext,
  path: PathNode,
): { ok: true; object: string; cell: string } | { ok: false; outcome: StepOutcome } {
  const r = ctx.resolvePath(path);
  if (!r.ok) return { ok: false, outcome: r };
  if (PROTECTED.has(r.cell)) {
    throw new Rejected({ type: "protected_cell", object: r.object, cell: r.cell });
  }
  return r;
}

const errorOutcome = (ctx: StepContext, r: Result & { type: "error" }) =>
  ctx.refuse({ code: r.code, message: r.message ?? r.code });

/** A number, a roll's total, or 0 for empty; undefined for anything else. */
function addend(v: Value): number | undefined {
  switch (v.type) {
    case "number":
      return v.value;
    case "roll":
      return v.total;
    case "empty":
      return 0;
    default:
      return undefined;
  }
}

/** The current value of a cell: `empty` when absent. */
function current(ctx: StepContext, object: string, cell: string): Result {
  return ctx.read(object, cell) ?? { type: "empty" };
}

function set(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "set") throw new Error(`set handler got ${step.kind}`);
  const t = target(ctx, step.path);
  if (!t.ok) return t.outcome;
  const v = ctx.evaluate(step.value);
  if (v.type === "error") return errorOutcome(ctx, v);
  ctx.primitives.writeValue(t.object, t.cell, v);
  return OK;
}

function add(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "add") throw new Error(`add handler got ${step.kind}`);
  const t = target(ctx, step.path);
  if (!t.ok) return t.outcome;
  const v = ctx.evaluate(step.value);
  if (v.type === "error") return errorOutcome(ctx, v);
  const now = current(ctx, t.object, t.cell);
  if (now.type === "error") return errorOutcome(ctx, now);
  const a = addend(now);
  if (a === undefined) {
    return ctx.refuse({
      code: "#TYPE",
      message: `add needs a number, a roll or empty in ${t.cell}, found ${now.type}`,
    });
  }
  const b = addend(v);
  if (b === undefined) {
    return ctx.refuse({
      code: "#TYPE",
      message: `add needs a number, a roll or empty to add, found ${v.type}`,
    });
  }
  ctx.primitives.addWrite(t.object, t.cell, a + b, b);
  return OK;
}

function append(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "append") throw new Error(`append handler got ${step.kind}`);
  const t = target(ctx, step.path);
  if (!t.ok) return t.outcome;
  const v = ctx.evaluate(step.value);
  if (v.type === "error") return errorOutcome(ctx, v);
  const now = current(ctx, t.object, t.cell);
  if (now.type === "error") return errorOutcome(ctx, now);
  if (now.type !== "list" && now.type !== "empty") {
    return ctx.refuse({
      code: "#TYPE",
      message: `append needs a list or empty in ${t.cell}, found ${now.type}`,
    });
  }
  const items = now.type === "list" ? now.items : [];
  ctx.primitives.writeValue(t.object, t.cell, { type: "list", items: [...items, v] });
  return OK;
}

function roll(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "roll") throw new Error(`roll handler got ${step.kind}`);
  const d = ctx.evaluate(step.dice);
  if (d.type === "error") return errorOutcome(ctx, d);
  if (d.type !== "dice") {
    return ctx.refuse({ code: "#TYPE", message: `roll needs dice, found ${d.type}` });
  }
  const t = target(ctx, step.path);
  if (!t.ok) return t.outcome;
  ctx.primitives.rollInto(t.object, t.cell, d.expr);
  return OK;
}

function shuffle(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "shuffle") throw new Error(`shuffle handler got ${step.kind}`);
  const r = ctx.resolveRef(step.object);
  if (!r.ok) return r;
  ctx.primitives.shuffleWith(r.object);
  return OK;
}

function each(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "each") throw new Error(`each handler got ${step.kind}`);
  const v = ctx.evaluate(step.list);
  if (v.type === "error") return errorOutcome(ctx, v);
  const items: readonly Value[] = v.type === "list" ? v.items : v.type === "empty" ? [] : [v];
  if (items.length > MAX_EACH_ITEMS) {
    return ctx.refuse({
      code: "#LIMIT",
      message: `each runs at most ${MAX_EACH_ITEMS} items, found ${items.length}`,
    });
  }
  for (const it of items) {
    const outcome = ctx.runStep(step.step, { it });
    if (!outcome.ok) return outcome;
  }
  return OK;
}

/** The value steps' handlers: `set`, `add`, `append`, `roll`, `shuffle`, `each`. */
export const coreHandlers: StepHandlerEntry[] = [
  { kind: "set", handle: set },
  { kind: "add", handle: add },
  { kind: "append", handle: append },
  { kind: "roll", handle: roll },
  { kind: "shuffle", handle: shuffle },
  { kind: "each", handle: each },
];
