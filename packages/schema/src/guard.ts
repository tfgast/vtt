/**
 * Hand-written runtime guards for values and cell content. Every object is
 * strict: an unknown key fails, and `type` must be a known tag.
 */
import type { CellContent } from "./cell";
import { ID_PATTERN } from "./ids";
import { isInkColor, isInkWidth, type Value } from "./values";

type Obj = Record<string, unknown>;

function isPlainObject(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Exactly the keys `type` plus `keys`, all own properties. */
function hasExactKeys(x: Obj, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(x);
  if (own.length !== keys.length + 1 || !Object.hasOwn(x, "type")) return false;
  return keys.every((k) => Object.hasOwn(x, k));
}

/** Like `Array.prototype.every`, but a hole fails instead of being skipped. */
function everyIndex(arr: unknown[], pred: (item: unknown) => boolean): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr) || !pred(arr[i])) return false;
  }
  return true;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

const isNonBlank = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

const isIntArray = (x: unknown): boolean =>
  Array.isArray(x) && everyIndex(x, (n) => Number.isInteger(n));

const isPoint = (x: unknown): boolean =>
  Array.isArray(x) && x.length === 2 && isFiniteNumber(x[0]) && isFiniteNumber(x[1]);

const isPointList = (x: unknown): boolean =>
  Array.isArray(x) && x.length > 0 && everyIndex(x, isPoint);

/** A stroke: a non-empty point list, or `{points, color?, width?}` (M6-D28). */
function isStroke(x: unknown): boolean {
  if (Array.isArray(x)) return isPointList(x);
  if (!isPlainObject(x)) return false;
  const own = Reflect.ownKeys(x);
  const allowed = ["points", "color", "width"];
  if (!own.every((k) => typeof k === "string" && allowed.includes(k))) return false;
  if (!Object.hasOwn(x, "points") || !isPointList(x.points)) return false;
  if (Object.hasOwn(x, "color") && !isInkColor(x.color)) return false;
  if (Object.hasOwn(x, "width") && !isInkWidth(x.width)) return false;
  return true;
}

function isRef(x: unknown): boolean {
  return (
    isPlainObject(x) &&
    x.type === "ref" &&
    hasExactKeys(x, ["object"]) &&
    typeof x.object === "string" &&
    ID_PATTERN.test(x.object)
  );
}

const isViewerEntry = (x: unknown): boolean =>
  x === "all" || x === "gm" || x === "owner" || isRef(x);

function isShape(x: unknown): boolean {
  if (!isPlainObject(x)) return false;
  switch (x.type) {
    case "rect":
      return (
        hasExactKeys(x, ["width", "height"]) && isFiniteNumber(x.width) && isFiniteNumber(x.height)
      );
    case "circle":
      return hasExactKeys(x, ["radius"]) && isFiniteNumber(x.radius);
    case "polygon":
      return (
        hasExactKeys(x, ["points"]) && Array.isArray(x.points) && everyIndex(x.points, isPoint)
      );
    default:
      return false;
  }
}

export function isValue(x: unknown): x is Value {
  if (!isPlainObject(x)) return false;
  switch (x.type) {
    case "number":
      return hasExactKeys(x, ["value"]) && isFiniteNumber(x.value);
    case "text":
      return hasExactKeys(x, ["value"]) && typeof x.value === "string";
    case "boolean":
      return hasExactKeys(x, ["value"]) && typeof x.value === "boolean";
    case "empty":
      return hasExactKeys(x, []);
    case "list":
      return hasExactKeys(x, ["items"]) && Array.isArray(x.items) && everyIndex(x.items, isValue);
    case "ref":
      return isRef(x);
    case "dice":
      return hasExactKeys(x, ["expr"]) && isNonBlank(x.expr);
    case "roll":
      return (
        hasExactKeys(x, ["expr", "dice", "dropped", "total"]) &&
        isNonBlank(x.expr) &&
        isIntArray(x.dice) &&
        isIntArray(x.dropped) &&
        isFiniteNumber(x.total)
      );
    case "viewers":
      return (
        hasExactKeys(x, ["viewers"]) &&
        Array.isArray(x.viewers) &&
        x.viewers.length > 0 &&
        everyIndex(x.viewers, isViewerEntry)
      );
    case "ink":
      return (
        hasExactKeys(x, ["strokes"]) &&
        Array.isArray(x.strokes) &&
        x.strokes.length > 0 &&
        everyIndex(x.strokes, isStroke)
      );
    case "shape":
      return hasExactKeys(x, ["shape"]) && isShape(x.shape);
    default:
      // Includes "error": errors are results, never storable.
      return false;
  }
}

export function isCellContent(x: unknown): x is CellContent {
  if (isPlainObject(x) && x.type === "formula") {
    return hasExactKeys(x, ["source"]) && isNonBlank(x.source);
  }
  return isValue(x);
}
