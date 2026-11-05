/**
 * Ad hoc evaluation (FORMULAS.md §7, §8.1; DESIGN.md §4.6): a formula that
 * is not a cell, such as an action's `when` guard or a button's show-when,
 * evaluated against the current revision.
 *
 * It uses the same recording env as cell evaluation, so its reads use and
 * populate the memo and it is budgeted, but it keeps no dependency entry:
 * nothing is invalidated on its behalf. An attempt that reads uncomputed
 * formula cells collects them; each is computed with the core's iterative
 * resolver (`resolve`), and the expression is retried. The expression is
 * not a cell, so it is never in a cycle: it reads a cycle member's memoized
 * `#CYCLE` as any reader outside the cycle would.
 */
import { err, type ObjectId, type Result } from "@vtt/schema";
import { evaluate } from "../eval/evaluate";
import type { CellKey } from "../host";
import { limitError, withBudget } from "./budget";
import { createRecordingEnv } from "./env";
import { PENDING, type ResolveContext, resolve } from "./resolve";

export interface AdhocOptions {
  /** The object the formula is evaluated on: `this`, and the owner of bare names. */
  thisId: ObjectId;
}

/**
 * Evaluate `source` on `thisId` at the current revision. New errors have no
 * origin cell. `#REF` if `thisId` does not exist, `#SYNTAX` if `source` does
 * not parse, `#LIMIT` if the final attempt exceeds the budget.
 */
export function evaluateAdhoc(ctx: ResolveContext, source: string, options: AdhocOptions): Result {
  const { thisId } = options;
  if (!ctx.host.exists(thisId)) return err("#REF", `reference to deleted object ${thisId}`);
  const parsed = ctx.parse(source);
  if (!parsed.ok) return err("#SYNTAX", parsed.message);
  const scope = { thisId };
  for (;;) {
    const pending: { key: CellKey; id: ObjectId; cell: string }[] = [];
    const collected = new Set<CellKey>();
    const env = createRecordingEnv({
      host: ctx.host,
      budget: ctx.budget,
      stats: ctx.stats,
      memoized: (key) => ctx.memoized(key),
      uncomputed(key, id, cell) {
        if (!collected.has(key)) {
          collected.add(key);
          pending.push({ key, id, cell });
        }
        return PENDING;
      },
    });
    ctx.stats.attempts++;
    // As in resolve: a budget stop keeps the pending cells collected so far;
    // with none, the attempt was final and the result is #LIMIT.
    const result = withBudget(
      () =>
        ctx.registry === undefined
          ? evaluate(parsed.ast, scope, env)
          : evaluate(parsed.ast, scope, env, ctx.registry),
      () => limitError(ctx.budget),
    );
    if (pending.length === 0) return result;
    // The first pending cell is a true dependency; the rest may be
    // speculative (read after a pending marker changed control flow).
    // Computing them is harmless: each is resolved from its own root, so no
    // speculative edge can join a cycle, and each result is the cell's value
    // at this revision. Every pass memoizes at least the first, so this ends.
    for (const p of pending) {
      if (ctx.memoized(p.key) === undefined) resolve(ctx, p.id, p.cell);
    }
  }
}
