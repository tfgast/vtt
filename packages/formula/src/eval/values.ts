/**
 * Value semantics (FORMULAS.md §2.1, §2.2, §4; DESIGN.md §4.4): truthiness,
 * coercion to number and text, equality, ordering, and the conversion of an
 * evaluated `visible_to` to a viewer set. Pure functions over values.
 */
import {
  type BooleanValue,
  bool,
  type ErrorValue,
  err,
  isError,
  type NumberValue,
  num,
  type Result,
  type TextValue,
  text,
  type Value,
  type ViewerEntry,
  type ViewersValue,
} from "@vtt/schema";
import { isDiceError, parseDice, renderDice } from "../dice/index";
import { firstError } from "./errors";

/**
 * Truthiness (FORMULAS §2.1): `false`, `empty`, `0`, `""`, and `[]` are
 * false; everything else is true, including every reference, every roll
 * result (even of total 0), dice, viewers, ink, and shapes. Errors are
 * neither: the caller propagates them before asking.
 */
export function truthy(v: Value): boolean {
  switch (v.type) {
    case "boolean":
      return v.value;
    case "empty":
      return false;
    case "number":
      return v.value !== 0;
    case "text":
      return v.value !== "";
    case "list":
      return v.items.length > 0;
    default:
      return true;
  }
}

/**
 * The arithmetic coercion: a number as is, `empty` as 0, a roll result as
 * its total, anything else `#TYPE`. An error is returned unchanged.
 */
export function toNumber(r: Result): NumberValue | ErrorValue {
  switch (r.type) {
    case "error":
      return r;
    case "number":
      return r;
    case "empty":
      return num(0);
    case "roll":
      return num(r.total);
    default:
      return err("#TYPE", `expected a number, got ${r.type}`);
  }
}

/** JS `String(n)`, except that -0 renders as "0". */
function numberText(n: number): string {
  return n === 0 ? "0" : String(n);
}

/**
 * The text coercion used by `&`: text as is, `empty` as "", numbers by JS
 * `String` (-0 as "0"), booleans as "true"/"false", dice as their normalized
 * notation, a roll result as its total. References, viewers, ink, shapes,
 * and lists are `#TYPE`. An error is returned unchanged.
 */
export function toText(r: Result): TextValue | ErrorValue {
  switch (r.type) {
    case "error":
      return r;
    case "text":
      return r;
    case "empty":
      return text("");
    case "number":
      return text(numberText(r.value));
    case "boolean":
      return text(r.value ? "true" : "false");
    case "roll":
      return text(numberText(r.total));
    case "dice": {
      const parsed = parseDice(r.expr);
      if (isDiceError(parsed)) return err("#TYPE", parsed.error);
      return text(renderDice(parsed));
    }
    default:
      return err("#TYPE", `cannot convert ${r.type} to text`);
  }
}

/** Structural equality of plain data (shapes): arrays, objects, primitives. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  const bo = b as Record<string, unknown>;
  const ao = a as Record<string, unknown>;
  return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/** A key identifying a viewer entry: refs by id, keywords by name. */
function viewerKey(entry: ViewerEntry): string {
  return typeof entry === "string" ? entry : `@${entry.object}`;
}

function viewerKeys(v: ViewersValue): Set<string> {
  return new Set(v.viewers.map(viewerKey));
}

/** Normalized dice notation, or the raw text if it does not parse. */
function diceKey(expr: string): string {
  const parsed = parseDice(expr);
  return isDiceError(parsed) ? expr : renderDice(parsed);
}

/** A number or roll result's numeric value, else `undefined`. */
function numeric(v: Value): number | undefined {
  if (v.type === "number") return v.value;
  if (v.type === "roll") return v.total;
  return undefined;
}

function valueEquals(a: Value, b: Value): boolean | ErrorValue {
  if (a.type === "ink" || b.type === "ink") {
    if (a.type === "empty" || b.type === "empty") return false;
    return err("#TYPE", "ink can only be compared with empty");
  }
  const an = numeric(a);
  const bn = numeric(b);
  if (an !== undefined && bn !== undefined) return an === bn;
  switch (a.type) {
    case "empty":
      return b.type === "empty";
    case "text":
    case "boolean":
      return b.type === a.type && a.value === b.value;
    case "ref":
      return b.type === "ref" && a.object === b.object;
    case "dice":
      return b.type === "dice" && diceKey(a.expr) === diceKey(b.expr);
    case "viewers": {
      if (b.type !== "viewers") return false;
      const ak = viewerKeys(a);
      const bk = viewerKeys(b);
      return ak.size === bk.size && [...ak].every((k) => bk.has(k));
    }
    case "shape":
      return b.type === "shape" && deepEqual(a.shape, b.shape);
    case "list": {
      if (b.type !== "list" || a.items.length !== b.items.length) return false;
      // Every pair is compared so that an ink item is #TYPE wherever it sits.
      let equal = true;
      for (let i = 0; i < a.items.length; i++) {
        const r = valueEquals(a.items[i] as Value, b.items[i] as Value);
        if (typeof r !== "boolean") return r;
        if (!r) equal = false;
      }
      return equal;
    }
    default:
      return false;
  }
}

/**
 * Value equality (FORMULAS §4), without broadcasting: values of different
 * kinds are unequal, except a number and a roll result (by total). Two lists
 * compare in order, recursively. Never `#TYPE`, except on ink against
 * anything but `empty`. An error operand is returned (the first of two).
 */
export function equals(a: Result, b: Result): BooleanValue | ErrorValue {
  const e = firstError(a, b);
  if (e) return e;
  const r = valueEquals(a as Value, b as Value);
  return typeof r === "boolean" ? bool(r) : r;
}

/** Compares strings by Unicode code point, not UTF-16 unit. */
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  const ra = a.length - i;
  const rb = b.length - j;
  return ra === rb ? 0 : ra < rb ? -1 : 1;
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

const textOf = (v: Value): string | undefined => (v.type === "text" ? v.value : undefined);

/** `stand` if the other operand is of the matching kind (`other` defined). */
const emptyAs = <T>(other: T | undefined, stand: T): T | undefined =>
  other === undefined ? undefined : stand;

/**
 * Ordering (FORMULAS §4): -1, 0, or 1. Numbers and roll results compare by
 * value (total); text by code point. `empty` acts as 0 against a number or
 * roll and as "" against text; `empty` against `empty` is 0. Anything else,
 * lists included, is `#TYPE`. An error operand is returned (the first of two).
 */
export function compare(a: Result, b: Result): NumberValue | ErrorValue {
  const e = firstError(a, b);
  if (e) return e;
  const av = a as Value;
  const bv = b as Value;
  if (av.type === "empty" && bv.type === "empty") return num(0);
  // empty takes the kind of the other operand: 0 beside a number, "" beside text.
  const an = av.type === "empty" ? emptyAs(numeric(bv), 0) : numeric(av);
  const bn = bv.type === "empty" ? emptyAs(numeric(av), 0) : numeric(bv);
  if (an !== undefined && bn !== undefined) return num(sign(an - bn));
  const at = av.type === "empty" ? emptyAs(textOf(bv), "") : textOf(av);
  const bt = bv.type === "empty" ? emptyAs(textOf(av), "") : textOf(bv);
  if (at !== undefined && bt !== undefined) return num(compareCodePoints(at, bt));
  return err("#TYPE", `cannot order ${av.type} and ${bv.type}`);
}

function collectViewers(v: Value, out: Map<string, ViewerEntry>): boolean {
  switch (v.type) {
    case "ref":
      if (!out.has(viewerKey(v))) out.set(viewerKey(v), v);
      return true;
    case "viewers":
      for (const entry of v.viewers)
        if (!out.has(viewerKey(entry))) out.set(viewerKey(entry), entry);
      return true;
    case "list":
      return v.items.every((item) => collectViewers(item, out));
    default:
      return false;
  }
}

/**
 * Converts an evaluated `visible_to` to a viewer set (FORMULAS §7 "Consuming
 * visible_to", DESIGN.md §4.4). A viewers value is returned as is; a
 * reference becomes a one-entry set (whether it names a character is the
 * consumer's check); a list of references, viewers values, and such lists
 * becomes the union of their entries, flattened, in first-seen order, with
 * duplicates removed. Anything else, including `empty`, a list with no
 * entries, and an error, is `#TYPE`: the consumer admits nobody. Visibility
 * code calls this; the evaluator never does.
 */
export function toViewers(r: Result): ViewersValue | ErrorValue {
  if (r.type === "viewers") return r;
  const fail = () => err("#TYPE", "visible_to is not a set of viewers");
  if (isError(r)) return fail();
  const out = new Map<string, ViewerEntry>();
  if (!collectViewers(r, out) || out.size === 0) return fail();
  return { type: "viewers", viewers: [...out.values()] };
}
