/** Arithmetic on dice values (FORMULAS.md §2.2): dice + dice, dice + integer, negation. */

import type { DiceError, DiceExpr, DiceTerm } from "./notation";

function copyTerm(term: DiceTerm): DiceTerm {
  const out: DiceTerm = {
    sign: term.sign,
    count: term.count,
    faces: term.faces,
    explode: term.explode,
  };
  if (term.reroll) out.reroll = { ...term.reroll };
  if (term.keep) out.keep = { ...term.keep };
  return out;
}

/**
 * `a + b`: with dice, the terms are concatenated in order and the constants
 * summed; with a number, it must be a safe integer and is added to the
 * constant. `number + dice` is `addDice(dice, number)`: the normalized result
 * is the same because constants always trail.
 */
export function addDice(a: DiceExpr, b: DiceExpr | number): DiceExpr | DiceError {
  const bConstant = typeof b === "number" ? b : b.constant;
  if (!Number.isSafeInteger(bConstant)) {
    return { error: `cannot add ${bConstant} to dice: only integers combine with dice` };
  }
  const constant = a.constant + bConstant;
  if (!Number.isSafeInteger(constant)) return { error: "dice constant is too large" };
  const terms = a.terms.map(copyTerm);
  if (typeof b !== "number") terms.push(...b.terms.map(copyTerm));
  return { terms, constant: constant + 0 };
}

/** `-a`: every term's sign and the constant flipped. */
export function negateDice(a: DiceExpr): DiceExpr {
  return {
    terms: a.terms.map((t) => ({ ...copyTerm(t), sign: t.sign === 1 ? -1 : 1 })),
    constant: 0 - a.constant,
  };
}
