/**
 * Values (FORMULAS.md §2, §2.4): the tagged encoding of FIXTURES.md §2, plus
 * the shape value and the error value.
 */
import type { ObjectId } from "./ids";
import type { Point, Shape } from "./shape";

export interface NumberValue {
  type: "number";
  value: number;
}

export interface TextValue {
  type: "text";
  value: string;
}

export interface BooleanValue {
  type: "boolean";
  value: boolean;
}

export interface EmptyValue {
  type: "empty";
}

export interface ListValue {
  type: "list";
  items: Value[];
}

export interface RefValue {
  type: "ref";
  object: ObjectId;
}

/** A dice expression, not a roll (FORMULAS §2.2). */
export interface DiceValue {
  type: "dice";
  expr: string;
}

/** A roll result (FORMULAS §2.2): kept dice in roll order, dropped dice, total. */
export interface RollValue {
  type: "roll";
  expr: string;
  dice: number[];
  dropped: number[];
  total: number;
}

/** One member of a viewer set (DESIGN.md §4.4). */
export type ViewerEntry = "all" | "gm" | "owner" | RefValue;

export interface ViewersValue {
  type: "viewers";
  viewers: ViewerEntry[];
}

/**
 * A stroke with its own pen (DESIGN.md §4.6 Ink and text; M6-D28): its
 * points plus an optional `color` (`#rrggbb`, `INK_COLOR_PATTERN`) and an
 * optional `width` in board units (`0 < width <= INK_MAX_WIDTH`). An absent
 * field is the default pen's.
 */
export interface PenStroke {
  points: Point[];
  color?: string;
  width?: number;
}

/** One ink stroke: a bare point list (the default pen) or a `PenStroke`. */
export type Stroke = Point[] | PenStroke;

export interface InkValue {
  type: "ink";
  strokes: Stroke[];
}

/** A stroke's `color`: `#` and six hex digits (M6-D28). */
export const INK_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** The widest stroke `width`, in board units (M6-D28). */
export const INK_MAX_WIDTH = 1;

/** Whether `x` is a valid stroke `color`. */
export const isInkColor = (x: unknown): x is string =>
  typeof x === "string" && INK_COLOR_PATTERN.test(x);

/** Whether `x` is a valid stroke `width`: finite, positive, at most INK_MAX_WIDTH. */
export const isInkWidth = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 && x <= INK_MAX_WIDTH;

/** The points of a stroke of either form. */
export const strokePoints = (s: Stroke): Point[] => (Array.isArray(s) ? s : s.points);

export interface ShapeValue {
  type: "shape";
  shape: Shape;
}

/** Every storable value. Records and errors are not storable. */
export type Value =
  | NumberValue
  | TextValue
  | BooleanValue
  | EmptyValue
  | ListValue
  | RefValue
  | DiceValue
  | RollValue
  | ViewersValue
  | InkValue
  | ShapeValue;

/** FORMULAS §2.3. */
export const ERROR_CODES = [
  "#CYCLE",
  "#NAME",
  "#TYPE",
  "#REF",
  "#DIV0",
  "#LIMIT",
  "#SYNTAX",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Where an error originated; preserved through propagation. */
export interface ErrorOrigin {
  object: ObjectId;
  cell: string;
}

/** An evaluation error. Only ever a result, never stored. */
export interface ErrorValue {
  type: "error";
  code: ErrorCode;
  message?: string;
  origin?: ErrorOrigin;
}

/** What evaluation produces. */
export type Result = Value | ErrorValue;

export const num = (value: number): NumberValue => ({ type: "number", value });
export const text = (value: string): TextValue => ({ type: "text", value });
export const bool = (value: boolean): BooleanValue => ({ type: "boolean", value });
export const EMPTY: EmptyValue = Object.freeze({ type: "empty" }) as EmptyValue;
export const list = (items: Value[]): ListValue => ({ type: "list", items });
export const ref = (object: ObjectId): RefValue => ({ type: "ref", object });
export const dice = (expr: string): DiceValue => ({ type: "dice", expr });
export const shape = (s: Shape): ShapeValue => ({ type: "shape", shape: s });

export function err(code: ErrorCode, message?: string, origin?: ErrorOrigin): ErrorValue {
  const e: ErrorValue = { type: "error", code };
  if (message !== undefined) e.message = message;
  if (origin !== undefined) e.origin = origin;
  return e;
}

export function isError(r: Result): r is ErrorValue {
  return r.type === "error";
}
