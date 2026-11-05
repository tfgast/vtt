/**
 * The scalar functions of FORMULAS.md §2.2, §4, §6: numbers (`round`,
 * `floor`, `ceil`, `abs`, `clamp`, `number`), text (`text`, `upper`,
 * `lower`, `join`), and dice (`max_roll`, `min_roll`, `faces`, `sides`).
 * All but `join` broadcast over lists.
 */
import { EMPTY, type ErrorValue, err, list, num, type Result, text, type Value } from "@vtt/schema";
import {
  type DiceExpr,
  faces,
  isDiceError,
  maxRoll,
  minRoll,
  parseDice,
  sides,
} from "../dice/index";
import { toNumber, toText } from "../eval/values";
import type { EagerFunctionDef } from "./registry";

const typeError = (message: string): ErrorValue => err("#TYPE", message);

/** A finite number result with -0 as 0, else `#TYPE` (FORMULAS §4). */
function finite(n: number): Result {
  return Number.isFinite(n) ? num(n + 0) : typeError("result is not a finite number");
}

/**
 * A broadcasting function of `minArgs` to `maxArgs` numeric arguments.
 * Arguments coerce as in arithmetic: a roll result is its total, `empty` 0.
 */
function numeric(
  name: string,
  minArgs: number,
  maxArgs: number,
  f: (args: readonly number[]) => Result,
): EagerFunctionDef {
  return {
    name,
    minArgs,
    maxArgs,
    kind: "eager",
    broadcast: "scalar",
    impl: (args) => {
      const values: number[] = [];
      for (const a of args) {
        const n = toNumber(a);
        if (n.type === "error") return typeError(`${name}: ${n.message ?? "expected a number"}`);
        values.push(n.value);
      }
      return f(values);
    },
  };
}

/** Half away from zero (FORMULAS §4) on `|x|`, with Math.round's half-up. */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** Powers of ten are applied in steps of at most this, so no factor overflows. */
const MAX_STEP = 300;

/** `round(x, places)`: `places` decimal digits (negative rounds to tens, hundreds, …). */
function round([x, places = 0]: readonly number[]): Result {
  const v = x as number;
  if (!Number.isInteger(places))
    return typeError(`round: places must be an integer, got ${places}`);
  if (v === 0) return num(0);
  if (places >= 0) {
    // Scale up in steps so a tiny (even subnormal) x meets a large places
    // without an infinite multiplier. Once the scaled value cannot carry a
    // fraction, x is already as precise as that many places: return it.
    const steps: number[] = [];
    let scaled = v;
    for (let left = places; left > 0; left -= MAX_STEP) {
      const step = 10 ** Math.min(left, MAX_STEP);
      scaled *= step;
      steps.push(step);
      if (!Number.isFinite(scaled) || Math.abs(scaled) >= 2 ** 52) return finite(v);
    }
    let result = roundHalfAway(scaled);
    for (const step of steps) result /= step;
    return finite(result);
  }
  const m = 10 ** -places;
  if (!Number.isFinite(m)) return num(0);
  return finite(roundHalfAway(v / m) * m);
}

const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

/** `number(x)`: text parsed strictly, a number as is, a roll its total, empty as empty. */
function toNumberFunction(x: Value): Result {
  switch (x.type) {
    case "number":
      return x;
    case "roll":
      return num(x.total);
    case "empty":
      return EMPTY;
    case "text": {
      const trimmed = x.value.trim();
      if (!NUMBER_TEXT.test(trimmed)) return typeError(`number: "${x.value}" is not a number`);
      return finite(Number(trimmed));
    }
    default:
      return typeError(`number takes text, got ${x.type}`);
  }
}

/** A one-argument broadcasting function over a non-error, non-list value. */
function scalar(name: string, f: (x: Value) => Result): EagerFunctionDef {
  return {
    name,
    minArgs: 1,
    maxArgs: 1,
    kind: "eager",
    broadcast: "scalar",
    impl: ([x]) => f(x as Value),
  };
}

/** `upper` / `lower`: text, with `empty` as "". */
function caseFunction(name: string, f: (s: string) => string): EagerFunctionDef {
  return scalar(name, (x) => {
    if (x.type === "empty") return text("");
    if (x.type === "text") return text(f(x.value));
    return typeError(`${name} takes text, got ${x.type}`);
  });
}

/** `join(list, sep)`: items through text conversion, empty items skipped. */
const join: EagerFunctionDef = {
  name: "join",
  minArgs: 2,
  maxArgs: 2,
  kind: "eager",
  broadcast: "none",
  impl: ([xs, sep]) => {
    const s = sep as Value;
    if (s.type !== "text" && s.type !== "empty") {
      return typeError(`join: the separator must be text, got ${s.type}`);
    }
    const separator = s.type === "text" ? s.value : "";
    const v = xs as Value;
    const items = v.type === "list" ? v.items : v.type === "empty" ? [] : [v];
    const parts: string[] = [];
    for (const item of items) {
      if (item.type === "empty") continue;
      const t = toText(item);
      if (t.type === "error") return t;
      parts.push(t.value);
    }
    return text(parts.join(separator));
  },
};

/** A dice function's argument: a dice value, or a roll result's expression. */
function diceFunction(name: string, f: (expr: DiceExpr) => Result): EagerFunctionDef {
  return scalar(name, (x) => {
    if (x.type !== "dice" && x.type !== "roll") {
      return typeError(`${name} takes dice or a roll result, got ${x.type}`);
    }
    const parsed = parseDice(x.expr);
    if (isDiceError(parsed)) return typeError(parsed.error);
    return f(parsed);
  });
}

export const SCALAR_FUNCTIONS: readonly EagerFunctionDef[] = [
  numeric("round", 1, 2, round),
  numeric("floor", 1, 1, ([x]) => finite(Math.floor(x as number))),
  numeric("ceil", 1, 1, ([x]) => finite(Math.ceil(x as number))),
  numeric("abs", 1, 1, ([x]) => finite(Math.abs(x as number))),
  numeric("clamp", 3, 3, ([x, lo, hi]) => {
    const [v, l, h] = [x, lo, hi] as [number, number, number];
    if (l > h) return typeError(`clamp: lo ${l} is greater than hi ${h}`);
    return finite(Math.min(Math.max(v, l), h));
  }),
  scalar("number", toNumberFunction),
  scalar("text", toText),
  caseFunction("upper", (s) => s.toUpperCase()),
  caseFunction("lower", (s) => s.toLowerCase()),
  join,
  diceFunction("max_roll", (d) => num(maxRoll(d))),
  diceFunction("min_roll", (d) => num(minRoll(d))),
  diceFunction("faces", (d) => num(faces(d))),
  diceFunction("sides", (d) => list(sides(d).map(num))),
];
