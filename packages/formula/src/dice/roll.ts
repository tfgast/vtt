/**
 * Rolling dice and validating roll results (FORMULAS.md §2.2, FIXTURES.md §2
 * and §5). The only random part of dice; randomness comes from a caller's
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

/** Dice a term keeps out of `total` dice: all of them without keep/drop. */
function keptCount(term: DiceTerm, total: number): number {
  if (!term.keep) return total;
  return term.keep.mode === "kh" || term.keep.mode === "kl" ? term.keep.n : total - term.keep.n;
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

function describeTerm(index: number, term: DiceTerm): string {
  return `term ${index + 1} (${renderDice({ terms: [{ ...term, sign: 1 }], constant: 0 })})`;
}

/**
 * Checks a roll result against its expression, for roll results that come
 * from outside the engine (a fixture dice script, FIXTURES.md §5, or a
 * replayed effect). Returns a list of problems; empty means valid.
 *
 * `expr` must parse, and every die must be an integer. Terms are then walked
 * in order over the flat `dice` and `dropped` lists. A term without explode or
 * reroll contributes exactly its kept count to `dice` and the rest of its
 * count to `dropped`, so its slice of each list is known; for such a term the
 * counts must fit, every die must lie in its range (1..S, or -1..1 for F), and
 * keep/drop must be consistent (kh: every kept die ≥ every dropped one; kl:
 * ≤; dh: every dropped die ≥ every kept one; dl: ≤). From the first term that
 * explodes or rerolls on, slices are unknown: every remaining die must lie in
 * the range of some remaining term, the remaining kept dice must number at
 * least the remaining terms' minimum kept count, and the remaining dropped
 * dice at least their minimum dropped count. `total` is checked exactly when
 * every term's slice is known, and also when all remaining terms share one
 * sign (their kept dice then sum with that sign).
 *
 * What this cannot verify: which die belongs to which term once a term
 * explodes or rerolls (so neither per-term ranges nor keep/drop consistency
 * from that term on); the exact total once the remaining terms have both
 * signs; and whether an explosion or reroll actually happened, or should have.
 */
export function validateRoll(roll: RollValue): string[] {
  const parsed = parseDice(roll.expr);
  if (isDiceError(parsed))
    return [`expr ${JSON.stringify(roll.expr)} does not parse: ${parsed.error}`];
  const errors: string[] = [];
  const check = (list: number[], name: string) => {
    list.forEach((v, i) => {
      if (!Number.isInteger(v)) errors.push(`${name}[${i}] = ${v} is not an integer`);
    });
  };
  check(roll.dice, "dice");
  check(roll.dropped, "dropped");
  if (!Number.isFinite(roll.total)) errors.push(`total ${roll.total} is not a number`);
  if (errors.length > 0) return errors;

  const { terms } = parsed;
  let ki = 0;
  let di = 0;
  let sum = parsed.constant;
  let t = 0;
  for (; t < terms.length; t++) {
    const term = terms[t] as DiceTerm;
    if (term.explode || term.reroll) break;
    const name = describeTerm(t, term);
    const nKept = keptCount(term, term.count);
    const nDropped = term.count - nKept;
    if (roll.dice.length - ki < nKept || roll.dropped.length - di < nDropped) {
      errors.push(
        `${name} needs ${nKept} kept and ${nDropped} dropped dice; ` +
          `${roll.dice.length - ki} kept and ${roll.dropped.length - di} dropped remain`,
      );
      return errors;
    }
    const kept = roll.dice.slice(ki, ki + nKept);
    const dropped = roll.dropped.slice(di, di + nDropped);
    ki += nKept;
    di += nDropped;
    const [min, max] = faceRange(term);
    for (const v of [...kept, ...dropped]) {
      if (v < min || v > max) errors.push(`${name}: die ${v} is outside ${min}..${max}`);
    }
    if (term.keep && dropped.length > 0) {
      const lowKept = Math.min(...kept);
      const highKept = Math.max(...kept);
      const lowDropped = Math.min(...dropped);
      const highDropped = Math.max(...dropped);
      const mode = term.keep.mode;
      const consistent =
        mode === "kh" || mode === "dl" ? lowKept >= highDropped : highKept <= lowDropped;
      if (!consistent) {
        errors.push(`${name}: kept [${kept}] and dropped [${dropped}] contradict ${mode}`);
      }
    }
    for (const v of kept) sum += term.sign * v;
  }

  const remaining = terms.slice(t);
  const restKept = roll.dice.slice(ki);
  const restDropped = roll.dropped.slice(di);
  if (remaining.length === 0) {
    if (restKept.length > 0) errors.push(`${restKept.length} kept dice beyond the expression`);
    if (restDropped.length > 0) {
      errors.push(`${restDropped.length} dropped dice beyond the expression`);
    }
    if (errors.length === 0 && roll.total !== sum) {
      errors.push(`total ${roll.total} does not match the dice (${sum})`);
    }
    return errors;
  }

  const ranges = remaining.map(faceRange);
  for (const v of [...restKept, ...restDropped]) {
    if (!ranges.some(([min, max]) => v >= min && v <= max)) {
      errors.push(`die ${v} is outside the range of every remaining term`);
    }
  }
  // An exploding term has at least `count` dice; rerolls only add dropped dice.
  let minKept = 0;
  let minDropped = 0;
  for (const term of remaining) {
    const nKept = keptCount(term, term.count);
    minKept += nKept;
    minDropped +=
      term.keep?.mode === "kh" || term.keep?.mode === "kl"
        ? term.count - nKept
        : (term.keep?.n ?? 0);
  }
  if (restKept.length < minKept) {
    errors.push(
      `${restKept.length} kept dice remain; the remaining terms keep at least ${minKept}`,
    );
  }
  if (restDropped.length < minDropped) {
    errors.push(
      `${restDropped.length} dropped dice remain; the remaining terms drop at least ${minDropped}`,
    );
  }
  const sign = (remaining[0] as DiceTerm).sign;
  if (errors.length === 0 && remaining.every((term) => term.sign === sign)) {
    for (const v of restKept) sum += sign * v;
    if (roll.total !== sum) errors.push(`total ${roll.total} does not match the dice (${sum})`);
  }
  return errors;
}
