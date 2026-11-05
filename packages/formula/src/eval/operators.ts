/**
 * The operators of FORMULAS.md §4 over values: arithmetic, `&`, equality,
 * ordering, `has`, and unary minus, with broadcasting over lists and error
 * propagation (§2.3). `and`, `or`, and `not` are not here: they short-circuit
 * on unevaluated operands, which is the AST evaluator's business.
 */
import { dice, type ErrorValue, err, num, type Result, text, type Value } from "@vtt/schema";
import {
  addDice,
  type DiceExpr,
  isDiceError,
  negateDice,
  parseDice,
  renderDice,
} from "../dice/index";
import type { BinaryOp, ComparisonOp, UnaryOp } from "../syntax/ast";
import { collectList, firstError } from "./errors";
import { compare, equals, toNumber, toText } from "./values";

/** The binary operators that act on values (every one but `and` and `or`). */
export type ValueBinaryOp = Exclude<BinaryOp, "and" | "or">;

/** The unary operators that act on values (`not` is truthiness, not here). */
export type ValueUnaryOp = Exclude<UnaryOp, "not">;

export interface BinaryOptions {
  /**
   * The AST node is a chained comparison (`a < b < c`): the result is `#TYPE`
   * once the operands are known not to be errors.
   */
  chained?: boolean;
}

type ArithOp = "+" | "-" | "*" | "/" | "%";
type OrderOp = "<" | "<=" | ">" | ">=";

const COMPARISONS: ReadonlySet<string> = new Set<ComparisonOp>(["=", "!=", "<", "<=", ">", ">="]);

const typeError = (message: string): ErrorValue => err("#TYPE", message);

/** -0 becomes 0; every other number is unchanged. */
const unsigned = (n: number): number => n + 0;

/**
 * Applies `f` elementwise. A list against a scalar maps over the list,
 * recursively; two lists pair up by index when `pairLists` is set and their
 * lengths agree, and are `#TYPE` otherwise. A list is built with
 * `collectList`, so the first error in list order wins.
 */
function broadcast(
  a: Value,
  b: Value,
  f: (a: Value, b: Value) => Result,
  pairLists: boolean,
): Result {
  if (a.type === "list" && b.type === "list") {
    if (!pairLists) return typeError("cannot compare two lists in order");
    if (a.items.length !== b.items.length) {
      return typeError(`list lengths differ: ${a.items.length} and ${b.items.length}`);
    }
    return collectList(a.items.map((x, i) => broadcast(x, b.items[i] as Value, f, pairLists)));
  }
  if (a.type === "list") return collectList(a.items.map((x) => broadcast(x, b, f, pairLists)));
  if (b.type === "list") return collectList(b.items.map((y) => broadcast(a, y, f, pairLists)));
  return f(a, b);
}

/** A dice operand as a parsed expression, or a number, or `#TYPE`. */
function diceOperand(v: Value): DiceExpr | number | ErrorValue {
  if (v.type === "dice") {
    const parsed = parseDice(v.expr);
    return isDiceError(parsed) ? typeError(parsed.error) : parsed;
  }
  const n = toNumber(v);
  return n.type === "error" ? n : n.value;
}

/** `+` and `-` with at least one dice operand (FORMULAS §2.2). */
function diceArithmetic(op: ArithOp, a: Value, b: Value): Result {
  if (op !== "+" && op !== "-") return typeError(`${op} is not defined on dice`);
  const x = diceOperand(a);
  const y = diceOperand(b);
  if (typeof x === "object" && "type" in x) return x;
  if (typeof y === "object" && "type" in y) return y;
  let result: ReturnType<typeof addDice>;
  if (typeof x === "number") {
    // number ± dice; y is dice because at least one operand is.
    const d = y as DiceExpr;
    result = addDice(op === "+" ? d : negateDice(d), x);
  } else if (typeof y === "number") {
    result = addDice(x, op === "+" ? y : -y);
  } else {
    result = addDice(x, op === "+" ? y : negateDice(y));
  }
  if (isDiceError(result)) return typeError(result.error);
  return dice(renderDice(result));
}

function arithmetic(op: ArithOp, a: Value, b: Value): Result {
  if (a.type === "dice" || b.type === "dice") return diceArithmetic(op, a, b);
  const x = toNumber(a);
  const y = toNumber(b);
  const e = firstError(x, y);
  if (e) return e;
  const l = (x as { value: number }).value;
  const r = (y as { value: number }).value;
  if ((op === "/" || op === "%") && r === 0) return err("#DIV0", `${op} by zero`);
  let n: number;
  switch (op) {
    case "+":
      n = l + r;
      break;
    case "-":
      n = l - r;
      break;
    case "*":
      n = l * r;
      break;
    case "/":
      n = l / r;
      break;
    case "%":
      // JS % takes the sign of the dividend, as FORMULAS §4 requires.
      n = l % r;
      break;
  }
  if (!Number.isFinite(n)) return typeError("result is not a finite number");
  return num(unsigned(n));
}

function concat(a: Value, b: Value): Result {
  const x = toText(a);
  const y = toText(b);
  const e = firstError(x, y);
  if (e) return e;
  return text((x as { value: string }).value + (y as { value: string }).value);
}

function ordering(op: OrderOp, a: Value, b: Value): Result {
  const c = compare(a, b);
  if (c.type === "error") return c;
  const s = c.value;
  switch (op) {
    case "<":
      return { type: "boolean", value: s < 0 };
    case "<=":
      return { type: "boolean", value: s <= 0 };
    case ">":
      return { type: "boolean", value: s > 0 };
    case ">=":
      return { type: "boolean", value: s >= 0 };
  }
}

function equality(op: "=" | "!=", a: Value, b: Value): Result {
  const r = equals(a, b);
  if (r.type === "error" || op === "=") return r;
  return { type: "boolean", value: !r.value };
}

/** `list has item`: whole-value equality per item, no broadcasting. */
function has(a: Value, b: Value): Result {
  if (a.type === "empty") return { type: "boolean", value: false };
  if (a.type !== "list") return typeError(`has needs a list on the left, got ${a.type}`);
  for (const item of a.items) {
    const r = equals(item, b);
    if (r.type === "error" || r.value) return r;
  }
  return { type: "boolean", value: false };
}

/**
 * Applies a binary operator to two evaluated operands (FORMULAS §4). An
 * error operand is returned unchanged, the left one if both are errors.
 * Arithmetic, `&`, ordering, and equality with exactly one list operand
 * broadcast; two lists pair up under arithmetic and `&`, are `#TYPE` under
 * ordering, and compare as whole lists under `=` and `!=`. `has` never
 * broadcasts.
 */
export function binary(
  op: ValueBinaryOp,
  a: Result,
  b: Result,
  options: BinaryOptions = {},
): Result {
  const e = firstError(a, b);
  if (e) return e;
  const x = a as Value;
  const y = b as Value;
  if (options.chained && COMPARISONS.has(op)) return typeError("comparisons do not chain");
  switch (op) {
    case "has":
      return has(x, y);
    case "=":
    case "!=":
      if (x.type === "list" && y.type === "list") return equality(op, x, y);
      return broadcast(x, y, (p, q) => equality(op, p, q), false);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return broadcast(x, y, (p, q) => ordering(op, p, q), false);
    case "&":
      return broadcast(x, y, concat, true);
    default:
      return broadcast(x, y, (p, q) => arithmetic(op, p, q), true);
  }
}

function negate(a: Value): Result {
  if (a.type === "list") return collectList(a.items.map(negate));
  if (a.type === "dice") {
    const parsed = parseDice(a.expr);
    if (isDiceError(parsed)) return typeError(parsed.error);
    return dice(renderDice(negateDice(parsed)));
  }
  const n = toNumber(a);
  return n.type === "error" ? n : num(unsigned(-n.value));
}

/**
 * Applies a unary operator to an evaluated operand. Unary minus negates a
 * number (through the arithmetic coercion) or a dice value, and broadcasts
 * over lists. An error operand is returned unchanged.
 */
export function unary(_op: ValueUnaryOp, a: Result): Result {
  if (a.type === "error") return a;
  return negate(a);
}
