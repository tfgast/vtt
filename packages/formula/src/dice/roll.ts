/**
 * Rolling dice (FORMULAS.md §2.2, FIXTURES.md §2). The only random part of dice; randomness comes from a caller's
 * `RandomSource`, so a scripted source makes rolls deterministic.
 */

import type { RollValue } from "@vtt/schema";
import { type DiceExpr, type DiceTerm, isDiceError, parseDice, renderDice } from "./notation";

/** A source of uniformly random integers. */
export interface RandomSource {
  /** An integer in `min..max`, both inclusive. */
  int(min: number, max: number): number;
}

/** Explosion extras allowed per original die (FORMULAS.md §2.2). */
export const MAX_EXPLOSIONS_PER_DIE = 100;

function parseOrThrow(dice: string | DiceExpr): DiceExpr {
  if (typeof dice !== "string") return dice;
  const parsed = parseDice(dice);
  if (isDiceError(parsed)) throw new RangeError(`invalid dice expression: ${parsed.error}`);
  return parsed;
}

function faceRange(term: DiceTerm): [number, number] {
  return term.faces === "F" ? [-1, 1] : [1, term.faces];
}

function rerollHolds(reroll: NonNullable<DiceTerm["reroll"]>, value: number): boolean {
  switch (reroll.op) {
    case "<":
      return value < reroll.n;
    case ">":
      return value > reroll.n;
    case "=":
      return value === reroll.n;
  }
}

/**
 * Indices into `values` that keep/drop discards: ranks all of them (descending
 * for kh and dh, ascending for kl and dl, ties by index), then drops the
 * ranking's tail for kh/kl or its first N for dh/dl.
 */
function droppedIndices(keep: NonNullable<DiceTerm["keep"]>, values: number[]): Set<number> {
  const descending = keep.mode === "kh" || keep.mode === "dh";
  const ranking = values
    .map((_, i) => i)
    .sort((a, b) => {
      const va = values[a] as number;
      const vb = values[b] as number;
      return (descending ? vb - va : va - vb) || a - b;
    });
  const isKeep = keep.mode === "kh" || keep.mode === "kl";
  return new Set(isKeep ? ranking.slice(keep.n) : ranking.slice(0, keep.n));
}

/**
 * Rolls a dice value. Terms roll in order; within a term each die rolls in
 * order and is settled before the next die rolls: first a reroll (once, when
 * the reroll condition holds; the original goes to `dropped`), then explosion
 * (while the die or its latest extra shows the maximum, an extra die is rolled
 * and placed right after it, at most 100 extras per original die; extras are
 * not rerolled). Keep/drop then ranks all of the term's dice, extras included.
 * `dice` and `dropped` are in roll order; `total` is the signed sum of kept
 * dice plus the constant; `expr` is the normalized expression.
 *
 * A string `dice` that does not parse throws a `RangeError`.
 */
export function rollDice(dice: string | DiceExpr, rng: RandomSource): RollValue {
  const expr = parseOrThrow(dice);
  // Terms and their dice are walked in roll order, so both lists come out in it.
  const kept: number[] = [];
  const dropped: number[] = [];
  let total = expr.constant;
  for (const term of expr.terms) {
    const [min, max] = faceRange(term);
    const pool: { value: number; rerolled?: number }[] = [];
    for (let i = 0; i < term.count; i++) {
      const first = rng.int(min, max);
      if (term.reroll && rerollHolds(term.reroll, first)) {
        pool.push({ value: rng.int(min, max), rerolled: first });
      } else {
        pool.push({ value: first });
      }
      if (term.explode) {
        let last = (pool[pool.length - 1] as { value: number }).value;
        for (let extras = 0; last === max && extras < MAX_EXPLOSIONS_PER_DIE; extras++) {
          last = rng.int(min, max);
          pool.push({ value: last });
        }
      }
    }
    const values = pool.map((d) => d.value);
    const discarded = term.keep ? droppedIndices(term.keep, values) : new Set<number>();
    pool.forEach((die, i) => {
      if (die.rerolled !== undefined) dropped.push(die.rerolled);
      if (discarded.has(i)) {
        dropped.push(die.value);
      } else {
        kept.push(die.value);
        total += term.sign * die.value;
      }
    });
  }
  return { type: "roll", expr: renderDice(expr), dice: kept, dropped, total: total + 0 };
}
