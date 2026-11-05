/**
 * Wire values (PROTOCOL.md §4, §5, §7.1). Two flavours (§12): input values
 * (client to server) are strict, may name `$binding`s in refs, and never hold
 * `redacted` or errors; wire values (server to client) are loose (unknown keys
 * stripped), never hold a `$binding`, and may hold `{type:"redacted"}` at any
 * depth. Both structurally match `@vtt/schema`'s value types, whose
 * `ValueSchema` delegates to a hand-written guard (not JSON-Schema
 * exportable) and so is never used on the wire.
 */
import {
  type BooleanValue,
  type DiceValue,
  type EmptyValue,
  ERROR_CODES,
  type ErrorCode,
  type FormulaContent,
  ID_PATTERN,
  type InkValue,
  type NumberValue,
  type ObjectId,
  type RollValue,
  type Shape,
  ShapeSchema,
  type ShapeValue,
  type TextValue,
} from "@vtt/schema";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Ids and bindings

/** A batch-local name for an id allocated in the same `transact` (§5). */
export type BindingName = string;

/** An id position in an op or input value: a real id or a binding (§4). */
export type ObjRef = ObjectId | BindingName;

/** `$` followed by id characters (letters, digits, underscores, starting with a letter). */
export const BINDING_NAME_PATTERN = /^\$[A-Za-z][A-Za-z0-9_]*$/;

/** An id or a binding name. */
export const OBJ_REF_PATTERN = /^\$?[A-Za-z][A-Za-z0-9_]*$/;

/** An object or board id, by syntax (FIXTURES.md §2). */
export const ObjectIdSchema = z.string().regex(ID_PATTERN);

export const BindingNameSchema = z.string().regex(BINDING_NAME_PATTERN);

export const ObjRefSchema = z.string().regex(OBJ_REF_PATTERN);

// ---------------------------------------------------------------------------
// Shared pieces

const NonBlank = z.string().regex(/\S/);
const Point = z.tuple([z.number(), z.number()]);
const Stroke = z.array(Point).min(1);
const Strokes = z.array(Stroke).min(1);
const ViewerWord = z.enum(["all", "gm", "owner"]);

/** A shape in server-to-client data: unknown keys stripped. */
export const WireShapeSchema: z.ZodType<Shape> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rect"), width: z.number(), height: z.number() }),
  z.object({ type: z.literal("circle"), radius: z.number() }),
  z.object({ type: z.literal("polygon"), points: z.array(Point) }),
]);

// ---------------------------------------------------------------------------
// Input values (strict)

export interface InputListValue {
  type: "list";
  items: InputValue[];
}

export interface InputRefValue {
  type: "ref";
  object: ObjRef;
}

export interface InputViewers {
  type: "viewers";
  viewers: ("all" | "gm" | "owner" | InputRefValue)[];
}

export type InputValue =
  | NumberValue
  | TextValue
  | BooleanValue
  | EmptyValue
  | DiceValue
  | RollValue
  | InkValue
  | ShapeValue
  | InputListValue
  | InputRefValue
  | InputViewers;

export type InputCellContent = InputValue | FormulaContent;

const InputRefSchema = z.strictObject({ type: z.literal("ref"), object: ObjRefSchema });

export const InputViewersSchema = z.strictObject({
  type: z.literal("viewers"),
  viewers: z.array(z.union([ViewerWord, InputRefSchema])).min(1),
});

const inputScalars = [
  z.strictObject({ type: z.literal("number"), value: z.number() }),
  z.strictObject({ type: z.literal("text"), value: z.string() }),
  z.strictObject({ type: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ type: z.literal("empty") }),
  z.strictObject({ type: z.literal("dice"), expr: NonBlank }),
  z.strictObject({
    type: z.literal("roll"),
    expr: NonBlank,
    dice: z.array(z.int()),
    dropped: z.array(z.int()),
    total: z.number(),
  }),
  z.strictObject({ type: z.literal("ink"), strokes: Strokes }),
  z.strictObject({ type: z.literal("shape"), shape: ShapeSchema }),
] as const;

const InputListSchema = z.strictObject({
  type: z.literal("list"),
  get items() {
    return z.array(InputValueSchema);
  },
});

export const InputValueSchema: z.ZodType<InputValue> = z.discriminatedUnion("type", [
  ...inputScalars,
  InputListSchema,
  InputRefSchema,
  InputViewersSchema,
]);

/** Formula content: non-blank source, as `@vtt/schema`'s `isCellContent`. */
export const FormulaContentSchema = z.strictObject({
  type: z.literal("formula"),
  source: NonBlank,
});

export const InputCellContentSchema: z.ZodType<InputCellContent> = z.discriminatedUnion("type", [
  ...inputScalars,
  InputListSchema,
  InputRefSchema,
  InputViewersSchema,
  FormulaContentSchema,
]);

// ---------------------------------------------------------------------------
// Wire values (loose)

export type RedactedValue = { type: "redacted" };

export interface WireListValue {
  type: "list";
  items: WireValue[];
}

export interface WireRefValue {
  type: "ref";
  object: ObjectId;
}

export interface WireViewers {
  type: "viewers";
  viewers: ("all" | "gm" | "owner" | WireRefValue | RedactedValue)[];
}

export type WireValue =
  | NumberValue
  | TextValue
  | BooleanValue
  | EmptyValue
  | DiceValue
  | RollValue
  | InkValue
  | ShapeValue
  | WireListValue
  | WireRefValue
  | WireViewers
  | RedactedValue;

export type WireError = {
  type: "error";
  code: ErrorCode;
  message?: string;
  origin?: { object: ObjectId; cell: string };
};

export type WireResult = WireValue | WireError;

export const RedactedValueSchema = z.object({ type: z.literal("redacted") });

/** A ref in a view: always a real id, never a `$binding` (§5). */
const WireRefSchema = z.object({ type: z.literal("ref"), object: ObjectIdSchema });

export const WireViewersSchema = z.object({
  type: z.literal("viewers"),
  viewers: z.array(z.union([ViewerWord, WireRefSchema, RedactedValueSchema])).min(1),
});

export const WireErrorSchema = z.object({
  type: z.literal("error"),
  code: z.enum(ERROR_CODES),
  message: z.string().optional(),
  origin: z.object({ object: z.string(), cell: z.string() }).optional(),
});

const wireVariants = [
  z.object({ type: z.literal("number"), value: z.number() }),
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("boolean"), value: z.boolean() }),
  z.object({ type: z.literal("empty") }),
  z.object({ type: z.literal("dice"), expr: NonBlank }),
  z.object({
    type: z.literal("roll"),
    expr: NonBlank,
    dice: z.array(z.int()),
    dropped: z.array(z.int()),
    total: z.number(),
  }),
  z.object({ type: z.literal("ink"), strokes: Strokes }),
  z.object({ type: z.literal("shape"), shape: WireShapeSchema }),
  z.object({
    type: z.literal("list"),
    get items() {
      return z.array(WireValueSchema);
    },
  }),
  WireRefSchema,
  WireViewersSchema,
  RedactedValueSchema,
] as const;

export const WireValueSchema: z.ZodType<WireValue> = z.discriminatedUnion("type", [
  ...wireVariants,
]);

export const WireResultSchema: z.ZodType<WireResult> = z.discriminatedUnion("type", [
  ...wireVariants,
  WireErrorSchema,
]);
