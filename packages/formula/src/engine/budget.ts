/**
 * The evaluation budget (FORMULAS.md §7 "Budget"; DESIGN.md §7, decision log
 * 2026-11-05).
 *
 * Each formula evaluation may spend a fixed number of units. The recording
 * env charges, per evaluation attempt:
 *
 * - 1 per `read`, whatever the cell holds (a missing cell, a literal, or a
 *   formula's memoized result, however costly that result was to compute);
 * - 1 per existence check, including each one made while validating the
 *   references in a literal that was read;
 * - 1 per candidate id a spatial query receives (`objectsOnBoard`);
 * - 1 per id `allObjects` or `objectsNamed` returns.
 *
 * Every charged quantity is defined by the document alone (the candidate set
 * is over literal geometry), so the charge is the same on every host.
 * Spending more than the budget aborts the attempt; when the attempt is
 * final (it saw no uncomputed dependency) its result is `#LIMIT`.
 */
import { type ErrorOrigin, type ErrorValue, err } from "@vtt/schema";

/** Units each formula evaluation may spend unless `EngineOptions.budget` says otherwise. */
export const DEFAULT_BUDGET = 20_000;

/** Thrown by `Budget.charge` to abort an attempt; never escapes the engine. */
export class BudgetExceeded extends Error {
  constructor() {
    super("evaluation budget exceeded");
    this.name = "BudgetExceeded";
  }
}

/** One attempt's spending. A fresh `Budget` per attempt keeps charges order-independent. */
export class Budget {
  private spentUnits = 0;

  constructor(readonly limit: number) {}

  /** Units spent so far. */
  get spent(): number {
    return this.spentUnits;
  }

  /** Spend `units`; throws `BudgetExceeded` once the total exceeds the limit. */
  charge(units = 1): void {
    this.spentUnits += units;
    if (this.spentUnits > this.limit) throw new BudgetExceeded();
  }
}

/** The `#LIMIT` result; `origin` is the evaluated cell (absent for ad hoc evaluation). */
export function limitError(limit: number, origin?: ErrorOrigin): ErrorValue {
  return err("#LIMIT", `evaluation exceeded its budget of ${limit}`, origin);
}

/**
 * `run()`, or `onLimit()` if it exceeded its budget. Any other exception
 * (a host failure) propagates.
 */
export function withBudget<T>(run: () => T, onLimit: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof BudgetExceeded) return onLimit();
    throw e;
  }
}
