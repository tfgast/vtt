/**
 * Ops (PROTOCOL.md §5): the 19 kinds of `transact`, one per M2 primitive.
 * Client-to-server, so every schema is strict (§12). Every `object`,
 * `container` and `template` field is an `ObjRef`.
 */
import { ActionDefSchema, CellNameSchema, ShapeSchema } from "@vtt/schema";
import { z } from "zod";
import {
  BindingNameSchema,
  InputCellContentSchema,
  InputValueSchema,
  InputViewersSchema,
  ObjectIdSchema,
  ObjRefSchema,
  strictNoProto,
} from "./values";

const Cell = CellNameSchema;
const Index = z.int().nonnegative();
const Point = z.tuple([z.number(), z.number()]);
const NonBlank = z.string().regex(/\S/);

/** A record keyed by cell names (never `__proto__`, never empty). */
const cellRecord = <T extends z.ZodType>(value: T) => strictNoProto(z.record(Cell, value));

export const DestinationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("board"), board: ObjectIdSchema, position: Point }),
  z.strictObject({
    type: z.literal("container"),
    container: ObjRefSchema,
    index: Index.optional(),
  }),
]);
export type Destination = z.infer<typeof DestinationSchema>;

export const ObjectInitSchema = z.strictObject({
  is_template: z.boolean().optional(),
  is_zone: z.boolean().optional(),
  is_character: z.boolean().optional(),
  tag: z.array(z.string()).optional(),
  shape: ShapeSchema.optional(),
  cells: cellRecord(InputCellContentSchema).optional(),
  cell_visibility: cellRecord(InputViewersSchema).optional(),
  actions: z.array(ActionDefSchema).optional(),
});
export type ObjectInit = z.infer<typeof ObjectInitSchema>;

const op = <T extends string, S extends z.core.$ZodLooseShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape });

const opSchemas = [
  op("set_value", { object: ObjRefSchema, cell: Cell, value: InputValueSchema }),
  op("set_formula", { object: ObjRefSchema, cell: Cell, source: NonBlank }),
  op("clear_override", { object: ObjRefSchema, cell: Cell }),
  op("delete_cell", { object: ObjRefSchema, cell: Cell }),
  op("rename_cell", { object: ObjRefSchema, from: Cell, to: Cell }),
  op("set_cell_visibility", {
    object: ObjRefSchema,
    cell: Cell,
    viewers: InputViewersSchema.nullable(),
  }),
  op("set_tag", { object: ObjRefSchema, tags: z.array(z.string()) }),
  op("set_shape", { object: ObjRefSchema, shape: ShapeSchema.nullable() }),
  op("set_template_flag", { object: ObjRefSchema, value: z.boolean() }),
  op("set_character_flag", { object: ObjRefSchema, value: z.boolean() }),
  op("set_actions", { object: ObjRefSchema, actions: z.array(ActionDefSchema) }),
  op("reorder", { container: ObjRefSchema, permutation: z.array(Index) }),
  op("add_board", { id: ObjectIdSchema, name: z.string().optional() }),
  op("rename_board", { id: ObjectIdSchema, name: z.string() }),
  op("remove_board", { id: ObjectIdSchema }),
  op("create_object", {
    id: ObjectIdSchema.optional(),
    as: BindingNameSchema.optional(),
    to: DestinationSchema,
    init: ObjectInitSchema.optional(),
  }),
  op("spawn", {
    template: ObjRefSchema,
    to: DestinationSchema,
    cells: cellRecord(InputCellContentSchema).optional(),
    as: BindingNameSchema.optional(),
    /** Template-subtree ids (plain ids) to bindings for their copies. */
    owned: strictNoProto(z.record(ObjectIdSchema, BindingNameSchema)).optional(),
  }),
  op("move", { object: ObjRefSchema, to: DestinationSchema }),
  op("remove", { object: ObjRefSchema }),
] as const;

export const WireOpSchema = z.discriminatedUnion("type", opSchemas);
export type WireOp = z.infer<typeof WireOpSchema>;
export type WireOpType = WireOp["type"];
/** The op of one kind. */
export type WireOpOf<T extends WireOpType> = Extract<WireOp, { type: T }>;

/** The 19 op kinds, in PROTOCOL.md §5 table order. */
export const WIRE_OP_TYPES: readonly WireOpType[] = Object.freeze(
  opSchemas.map((s) => s.shape.type.value),
);
