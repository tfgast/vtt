/**
 * Operation records (DESIGN.md §7): committed groups of resolved effects, the
 * actors that make them, and the rejections that refuse them.
 */
import { z } from "zod";
import { type Cell, CellNameSchema, CellSchema, strictRecord } from "./cell";
import { type Board, BoardSchema } from "./document";
import type { BoardId, ObjectId } from "./ids";
import {
  type ActionDef,
  ActionDefSchema,
  type TableObject,
  TableObjectSchema,
  ViewersValueSchema,
} from "./object";
import { type Shape, ShapeSchema } from "./shape";
import type { ErrorCode, ViewersValue } from "./values";

/** Who made a change. The GM is not a character (DESIGN.md §4.4). */
export type Actor =
  | { type: "gm" }
  | { type: "character"; id: ObjectId }
  | { type: "agent"; name?: string };

/** Where an object is: on a board, or at an index of a container's contents. */
export type Location =
  | { type: "board"; board: BoardId }
  | { type: "container"; container: ObjectId; index: number };

/** A cell's stored state; `null` means absent. */
export type CellState = Cell | null;

/**
 * A cell's state before and after. `after` is resolved: for an add the sum,
 * for an override the override, for a roll the roll result (cause `roll`).
 */
export interface CellEffect {
  type: "cell";
  object: ObjectId;
  cell: string;
  before: CellState;
  after: CellState;
  cause: "edit" | "roll";
}

/** A change to one entry of `cell_visibility`; `null` means no entry. */
export interface CellVisibilityEffect {
  type: "cell_visibility";
  object: ObjectId;
  cell: string;
  before: ViewersValue | null;
  after: ViewersValue | null;
}

/** A change to a field of an object that is not a cell or placement. */
export type FieldEffect =
  | { type: "field"; object: ObjectId; field: "tag"; before: string[]; after: string[] }
  | { type: "field"; object: ObjectId; field: "shape"; before: Shape | null; after: Shape | null }
  | { type: "field"; object: ObjectId; field: "is_template"; before: boolean; after: boolean }
  | { type: "field"; object: ObjectId; field: "is_character"; before: boolean; after: boolean }
  | {
      type: "field";
      object: ObjectId;
      field: "actions";
      before: ActionDef[];
      after: ActionDef[];
    };

/**
 * A move: board to board, board to container, container to board, or within
 * a container. Position, rotation and z changes are separate cell effects.
 */
export interface PlaceEffect {
  type: "place";
  object: ObjectId;
  before: Location;
  after: Location;
}

/** A created subtree, in preorder, root first; `location` is the root's. */
export interface CreateEffect {
  type: "create";
  objects: TableObject[];
  location: Location;
}

/** A removed subtree, the same shape as a create; its inverse. */
export interface RemoveEffect {
  type: "remove";
  objects: TableObject[];
  location: Location;
}

/** A change of order, not membership, of a container's contents. */
export interface ReorderEffect {
  type: "reorder";
  container: ObjectId;
  before: ObjectId[];
  after: ObjectId[];
}

/** A board created (`before` null), changed, or removed (`after` null). */
export interface BoardEffect {
  type: "board";
  before: Board | null;
  after: Board | null;
}

/** Ids reserved by this group, and the `next_seq` change (DESIGN.md §4.1). */
export interface AllocateEffect {
  type: "allocate";
  ids: ObjectId[];
  seq_before: number;
  seq_after: number;
}

/** Ids this group newly added to `retired_ids`; never ids already retired. */
export interface RetireEffect {
  type: "retire";
  ids: ObjectId[];
}

/**
 * Every persisted effect. User undo never reverses `allocate` or `retire`;
 * historical rewind has its own internal inverse, which is not an Effect.
 */
export type Effect =
  | CellEffect
  | CellVisibilityEffect
  | FieldEffect
  | PlaceEffect
  | CreateEffect
  | RemoveEffect
  | ReorderEffect
  | BoardEffect
  | AllocateEffect
  | RetireEffect;

/** One committed change (DESIGN.md §7). */
export interface OpGroup {
  /** Absolute; stable across compaction. */
  index: number;
  base_revision: number;
  revision: number;
  actor: Actor;
  kind: "edit" | "action" | "undo";
  label: string;
  origin?: { object: ObjectId; action: string };
  /** The absolute index of the group reversed, for kind `undo`. */
  undoes?: number;
  /** The name of every touched object at commit time (removed: just before removal). */
  names: Record<ObjectId, string>;
  effects: Effect[];
}

/** Why the table refused a change. Nothing is applied. */
export type Rejection =
  | { type: "protected_cell"; object: ObjectId; cell: string }
  | { type: "containment_cycle"; object: ObjectId; container: ObjectId }
  | { type: "undo_conflict"; target: number; conflicting: number[]; message: string }
  | { type: "nothing_to_undo" }
  | { type: "type_error"; object: ObjectId; cell: string; expected: string }
  /** Unknown object, bad index, retired id, and the like. */
  | { type: "invalid"; message: string };

const Id = z.string();
const Count = z.int().nonnegative();

export const ActorSchema: z.ZodType<Actor> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("gm") }),
  z.strictObject({ type: z.literal("character"), id: Id }),
  z.strictObject({ type: z.literal("agent"), name: z.string().optional() }),
]);

export const LocationSchema: z.ZodType<Location> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("board"), board: Id }),
  z.strictObject({ type: z.literal("container"), container: Id, index: Count }),
]);

export const CellStateSchema: z.ZodType<CellState> = CellSchema.nullable();

const field = <F extends string, T extends z.ZodType>(name: F, value: T) =>
  z.strictObject({
    type: z.literal("field"),
    object: Id,
    field: z.literal(name),
    before: value,
    after: value,
  });

const FieldEffectSchema = z.discriminatedUnion("field", [
  field("tag", z.array(z.string())),
  field("shape", ShapeSchema.nullable()),
  field("is_template", z.boolean()),
  field("is_character", z.boolean()),
  field("actions", z.array(ActionDefSchema)),
]);

const subtree = <T extends string>(type: T) =>
  z.strictObject({
    type: z.literal(type),
    objects: z.array(TableObjectSchema),
    location: LocationSchema,
  });

/** Structural shape only; whether an effect applies is the authority's concern. */
export const EffectSchema: z.ZodType<Effect> = z.union([
  z.strictObject({
    type: z.literal("cell"),
    object: Id,
    cell: CellNameSchema,
    before: CellStateSchema,
    after: CellStateSchema,
    cause: z.enum(["edit", "roll"]),
  }),
  z.strictObject({
    type: z.literal("cell_visibility"),
    object: Id,
    cell: CellNameSchema,
    before: ViewersValueSchema.nullable(),
    after: ViewersValueSchema.nullable(),
  }),
  FieldEffectSchema,
  z.strictObject({
    type: z.literal("place"),
    object: Id,
    before: LocationSchema,
    after: LocationSchema,
  }),
  subtree("create"),
  subtree("remove"),
  z.strictObject({
    type: z.literal("reorder"),
    container: Id,
    before: z.array(Id),
    after: z.array(Id),
  }),
  z.strictObject({
    type: z.literal("board"),
    before: BoardSchema.nullable(),
    after: BoardSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("allocate"),
    ids: z.array(Id),
    seq_before: Count,
    seq_after: Count,
  }),
  z.strictObject({ type: z.literal("retire"), ids: z.array(Id) }),
]);

/**
 * Structural shape only. The history invariants (contiguous indices, revision
 * chaining, `undoes` exactly on undo groups) are checked on load.
 */
export const OpGroupSchema: z.ZodType<OpGroup> = z.strictObject({
  index: Count,
  base_revision: Count,
  revision: Count,
  actor: ActorSchema,
  kind: z.enum(["edit", "action", "undo"]),
  label: z.string(),
  origin: z.strictObject({ object: Id, action: z.string() }).optional(),
  undoes: Count.optional(),
  names: strictRecord(z.string()),
  effects: z.array(EffectSchema),
});

export const RejectionSchema: z.ZodType<Rejection> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("protected_cell"), object: Id, cell: CellNameSchema }),
  z.strictObject({ type: z.literal("containment_cycle"), object: Id, container: Id }),
  z.strictObject({
    type: z.literal("undo_conflict"),
    target: Count,
    conflicting: z.array(Count),
    message: z.string(),
  }),
  z.strictObject({ type: z.literal("nothing_to_undo") }),
  z.strictObject({
    type: z.literal("type_error"),
    object: Id,
    cell: CellNameSchema,
    expected: z.string(),
  }),
  z.strictObject({ type: z.literal("invalid"), message: z.string() }),
]);

/**
 * A rejection reason of the fixture format (FIXTURES.md §6). The action-level
 * reasons `when_false` and `when_error` arrive with M5.
 */
export type FixtureRejectionReason =
  | { type: "protected_cell" }
  | { type: "containment_cycle" }
  | { type: "undo_conflict" }
  | { type: "nothing_to_undo" }
  | { type: "step_error"; code?: ErrorCode };

/**
 * The fixture reason for a rejection. `type_error` is the step error `#TYPE`.
 * `invalid` has none: the fixture format treats it as a scenario error.
 */
export function toFixtureReason(r: Rejection): FixtureRejectionReason | null {
  switch (r.type) {
    case "protected_cell":
    case "containment_cycle":
    case "undo_conflict":
    case "nothing_to_undo":
      return { type: r.type };
    case "type_error":
      return { type: "step_error", code: "#TYPE" };
    case "invalid":
      return null;
  }
}
