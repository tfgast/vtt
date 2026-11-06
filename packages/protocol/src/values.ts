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
  INK_COLOR_PATTERN,
  INK_MAX_WIDTH,
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

export const PROTO_KEY_MESSAGE = '"__proto__" is not allowed as a key';

/**
 * Accepts anything without an own `__proto__` key. It sees the raw input:
 * zod's records drop such a key and its loose objects strip it, so a check on
 * their output could never see it (FIXTURES.md §1).
 */
const NoOwnProtoKey = z
  .unknown()
  .refine((v) => !(typeof v === "object" && v !== null && Object.hasOwn(v, "__proto__")), {
    message: PROTO_KEY_MESSAGE,
    path: ["__proto__"],
  });

/**
 * A strict schema that also rejects an own `__proto__` key, as an
 * intersection (exported to JSON Schema as `allOf` with `{}`). Only for
 * schemas whose output equals their input (strict, no stripping), since an
 * intersection merges both sides' outputs.
 */
export function strictNoProto<T extends z.ZodType>(schema: T) {
  return z.intersection(NoOwnProtoKey, schema);
}

/**
 * A loose schema that also rejects an own `__proto__` key, as a pipe from the
 * raw check into the schema, so the stripped output is kept (exported to JSON
 * Schema in output mode as the schema itself).
 */
export function looseNoProto<T extends z.ZodType>(schema: T) {
  return NoOwnProtoKey.pipe(schema);
}

/** A loose object (unknown keys stripped) that rejects an own `__proto__` key. */
export const looseObject = <S extends z.core.$ZodLooseShape>(shape: S) =>
  looseNoProto(z.object(shape));

const NonBlank = z.string().regex(/\S/);
const Point = z.tuple([z.number(), z.number()]);
const StrokePoints = z.array(Point).min(1);
const InkColor = z.string().regex(INK_COLOR_PATTERN);
const InkWidth = z.number().positive().max(INK_MAX_WIDTH);
/** An input stroke (M6-D28): a bare point list or a strict pen stroke. */
const InputStroke = z.union([
  StrokePoints,
  z.strictObject({ points: StrokePoints, color: InkColor.optional(), width: InkWidth.optional() }),
]);
const InputStrokes = z.array(InputStroke).min(1);
/** A wire stroke: as input, but a pen stroke's unknown keys are stripped. */
const WireStroke = z.union([
  StrokePoints,
  looseObject({ points: StrokePoints, color: InkColor.optional(), width: InkWidth.optional() }),
]);
const WireStrokes = z.array(WireStroke).min(1);
const ViewerWord = z.enum(["all", "gm", "owner"]);

/** A shape in server-to-client data: unknown keys stripped. */
export const WireShapeSchema: z.ZodType<Shape> = looseNoProto(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("rect"), width: z.number(), height: z.number() }),
    z.object({ type: z.literal("circle"), radius: z.number() }),
    z.object({ type: z.literal("polygon"), points: z.array(Point) }),
  ]),
);

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
  z.strictObject({ type: z.literal("ink"), strokes: InputStrokes }),
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

// The raw objects are discriminated-union options; the exported schemas and
// the unions are guarded against `__proto__`.
const RedactedObject = z.object({ type: z.literal("redacted") });
/** A ref in a view: always a real id, never a `$binding` (§5). */
const WireRefObject = z.object({ type: z.literal("ref"), object: ObjectIdSchema });
const WireViewersObject = z.object({
  type: z.literal("viewers"),
  viewers: z
    .array(z.union([ViewerWord, looseNoProto(WireRefObject), looseNoProto(RedactedObject)]))
    .min(1),
});
const WireErrorObject = z.object({
  type: z.literal("error"),
  code: z.enum(ERROR_CODES),
  message: z.string().optional(),
  origin: looseObject({ object: ObjectIdSchema, cell: z.string() }).optional(),
});

export const RedactedValueSchema = looseNoProto(RedactedObject);
export const WireViewersSchema = looseNoProto(WireViewersObject);
export const WireErrorSchema = looseNoProto(WireErrorObject);

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
  z.object({ type: z.literal("ink"), strokes: WireStrokes }),
  z.object({ type: z.literal("shape"), shape: WireShapeSchema }),
  z.object({
    type: z.literal("list"),
    get items() {
      return z.array(WireValueSchema);
    },
  }),
  WireRefObject,
  WireViewersObject,
  RedactedObject,
] as const;

export const WireValueSchema: z.ZodType<WireValue> = looseNoProto(
  z.discriminatedUnion("type", [...wireVariants]),
);

export const WireResultSchema: z.ZodType<WireResult> = looseNoProto(
  z.discriminatedUnion("type", [...wireVariants, WireErrorObject]),
);
