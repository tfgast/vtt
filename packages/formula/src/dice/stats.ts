/**
 * Static dice functions (FORMULAS.md §2.2): `max_roll`, `min_roll`, `faces`,
 * `sides`. Max and min ignore explosion and rerolls and respect keep/drop.
 */

import type { DiceExpr, DiceTerm } from "./notation";

/** Sides a Fudge die counts as in `sides`. */
const FUDGE_SIDES = 3;

function kept(term: DiceTerm): number {
  if (!term.keep) return term.count;
  return term.keep.mode === "kh" || term.keep.mode === "kl"
    ? term.keep.n
    : term.count - term.keep.n;
}

/** Highest and lowest total of a pool, before its sign. */
function poolBounds(term: DiceTerm): { high: number; low: number } {
  const n = kept(term);
  return term.faces === "F" ? { high: n, low: -n } : { high: n * term.faces, low: n };
}

export function maxRoll(expr: DiceExpr): number {
  return expr.terms.reduce((total, term) => {
    const { high, low } = poolBounds(term);
    return total + (term.sign === 1 ? high : -low);
  }, expr.constant);
}

export function minRoll(expr: DiceExpr): number {
  return expr.terms.reduce((total, term) => {
    const { high, low } = poolBounds(term);
    return total + (term.sign === 1 ? low : -high);
  }, expr.constant);
}

/** Number of dice in the expression, counting kept and dropped. */
export function faces(expr: DiceExpr): number {
  return expr.terms.reduce((total, term) => total + term.count, 0);
}

/** The size of each die in term order; a Fudge die counts as 3. */
export function sides(expr: DiceExpr): number[] {
  return expr.terms.flatMap((term) =>
    Array<number>(term.count).fill(term.faces === "F" ? FUDGE_SIDES : term.faces),
  );
}
