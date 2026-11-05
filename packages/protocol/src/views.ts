/**
 * Views (PROTOCOL.md §4, §7.2–§7.6): what the authority sends about objects,
 * covers and groups. Every schema here is loose (unknown keys stripped, §12)
 * except `ViewerSchema`, which only appears in client-to-server params.
 */
import { type Actor, ERROR_CODES } from "@vtt/schema";
import { z } from "zod";
import {
  looseNoProto,
  looseObject,
  ObjectIdSchema,
  WireResultSchema,
  WireShapeSchema,
  WireValueSchema,
  WireViewersSchema,
} from "./values";

/** Every object and board id in a view is a real id, never a `$binding` (§5). */
const Id = ObjectIdSchema;
const Count = z.int().nonnegative();
const Point = z.tuple([z.number(), z.number()]);
/** A loose record (values stripped of unknown keys) that rejects `__proto__`. */
const looseRecord = <K extends z.core.$ZodRecordKey, V extends z.ZodType>(key: K, value: V) =>
  looseNoProto(z.record(key, value));

// ---------------------------------------------------------------------------
// Viewers and actors

/** Whose view is computed (§4); strict, since it only appears in params. */
export const ViewerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("gm") }),
  z.strictObject({ type: z.literal("character"), id: ObjectIdSchema }),
]);
export type Viewer = z.infer<typeof ViewerSchema>;

/**
 * An actor in server-to-client data (loose). Client-to-server params use
 * `@vtt/schema`'s strict `ActorSchema`.
 */
export const WireActorSchema: z.ZodType<Actor> = looseNoProto(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("gm") }),
    z.object({ type: z.literal("character"), id: Id }),
    z.object({ type: z.literal("agent"), name: z.string().optional() }),
  ]),
);

// ---------------------------------------------------------------------------
// Object views (§7.2)

/**
 * An action's definition (M5-D23): `name`, and for the GM `when` and `steps`.
 * The type of object views' `actions`, `field: "actions"` effects and
 * snapshots' `actions`; it never carries live state.
 */
export const ActionDefinitionViewSchema = looseObject({
  name: z.string(),
  when: z.string().optional(),
  steps: z.array(z.string()).optional(),
});
export type ActionDefinitionView = z.infer<typeof ActionDefinitionViewSchema>;
/** @deprecated Renamed `ActionDefinitionView` (PROTOCOL.md §7.2). */
export type ActionView = ActionDefinitionView;

export const CellViewSchema = looseObject({
  value: WireResultSchema,
  kind: z.enum(["literal", "formula", "structural"]),
  source: z.string().optional(),
  overridden: z.boolean().optional(),
  visibility: WireViewersSchema.optional(),
});
export type CellView = z.infer<typeof CellViewSchema>;

/**
 * An action's live state (M5-D23): `enabled` as `explain_action` computes it
 * (§9), `reason` only when not enabled. Only in live object views.
 */
export const ActionStateViewSchema = looseObject({
  name: z.string(),
  enabled: z.boolean(),
  reason: z.enum(["when_false", "when_error"]).optional(),
});
export type ActionStateView = z.infer<typeof ActionStateViewSchema>;

/** A board as sent on the wire; also the `Board` of `board` effects. */
export const BoardViewSchema = looseObject({ id: Id, name: z.string().optional() });
export type BoardView = z.infer<typeof BoardViewSchema>;

// ---------------------------------------------------------------------------
// Covers (§7.5)

export const CoverSchema = looseObject({
  /** Opaque; never contains the zone id. */
  key: z.string(),
  board: Id,
  region: z.union([
    looseObject({ position: Point, rotation: z.number(), shape: WireShapeSchema }),
    looseObject({ whole_board: z.literal(true) }),
  ]),
});
export type Cover = z.infer<typeof CoverSchema>;

// ---------------------------------------------------------------------------
// Group views (§7.6)

/** The fields of `GroupHeader`, for schemas that extend it. */
export const GROUP_HEADER_SHAPE = {
  index: Count,
  revision: Count,
  actor: WireActorSchema,
  kind: z.enum(["edit", "action", "undo"]),
  /** `null` only in character group views. */
  label: z.string().nullable(),
};

export const GroupHeaderSchema = looseObject(GROUP_HEADER_SHAPE);
export type GroupHeader = z.infer<typeof GroupHeaderSchema>;

export const CellStateViewSchema = looseNoProto(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: WireValueSchema }),
    z.object({
      kind: z.literal("formula"),
      source: z.string().optional(),
      override: WireValueSchema.optional(),
    }),
  ]),
);
export type CellStateView = z.infer<typeof CellStateViewSchema>;

export const LocationViewSchema = looseNoProto(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("board"), board: Id }),
    z.object({ type: z.literal("container"), container: Id.nullable(), index: Count }),
  ]),
);
export type LocationView = z.infer<typeof LocationViewSchema>;

const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const faceElementCommon = {
  rect: RectSchema,
  show_when: z.string().optional(),
  min_size: z.number().optional(),
  /** Its position in the stored list, kept when a character's view omits others (M5-D23). */
  index: Count,
};

const faceCellElement = <T extends "value" | "editor">(type: T) =>
  z.object({
    type: z.literal(type),
    cell: z.string(),
    ...faceElementCommon,
    style: looseObject({
      size: z.enum(["small", "normal", "large", "huge"]).optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      caption: z.boolean().optional(),
    }).optional(),
  });

/**
 * A stored face element with its `index` (PROTOCOL.md §7.6): the element of
 * a historical face. It carries no live `shown`.
 */
export const FaceLayoutElementViewSchema = looseNoProto(
  z.discriminatedUnion("type", [
    faceCellElement("value"),
    faceCellElement("editor"),
    z.object({
      type: z.literal("button"),
      action: z.string(),
      ...faceElementCommon,
      label: z.string().optional(),
    }),
    z.object({
      type: z.literal("contents"),
      ...faceElementCommon,
      entries: z.enum(["collapsed", "full"]).optional(),
    }),
  ]),
);
export type FaceLayoutElementView = z.infer<typeof FaceLayoutElementViewSchema>;

/**
 * The wire type of historical faces (PROTOCOL.md §7.6, M5-D7): the stored
 * `FaceLayout` with each element's `index`, in `field: "face"` effects and
 * snapshots. Lossless for the GM; for a character, without `show_when` and
 * without elements naming a cell it cannot read. `FaceLayout` stays the
 * storage and op type.
 */
export const FaceLayoutViewSchema = looseObject({
  elements: z.array(FaceLayoutElementViewSchema),
  collapsed: z.array(FaceLayoutElementViewSchema).optional(),
  default_action: z.string().optional(),
});
export type FaceLayoutView = z.infer<typeof FaceLayoutViewSchema>;

/** What a live face element adds to the stored element and its index (M5-D8). */
const faceElementLive = {
  shown: z.boolean(),
  /** Only when not shown, in GM views (character views omit hidden elements). */
  reason: z.enum(["show_when_false", "show_when_error", "no_action"]).optional(),
  /** The `show_when` error's code, with `reason: "show_when_error"`. */
  error: z.enum(ERROR_CODES).optional(),
};

/**
 * A live face element (PROTOCOL.md §7.2, M5-D8, M5-D23): the stored element
 * with its `index` and `shown`; when hidden (GM views only), `reason` and,
 * for an error, its code.
 */
export const FaceElementViewSchema = looseNoProto(
  z.discriminatedUnion("type", [
    faceCellElement("value").extend(faceElementLive),
    faceCellElement("editor").extend(faceElementLive),
    z.object({
      type: z.literal("button"),
      action: z.string(),
      ...faceElementCommon,
      label: z.string().optional(),
      ...faceElementLive,
    }),
    z.object({
      type: z.literal("contents"),
      ...faceElementCommon,
      entries: z.enum(["collapsed", "full"]).optional(),
      ...faceElementLive,
    }),
  ]),
);
export type FaceElementView = z.infer<typeof FaceElementViewSchema>;

/**
 * An object view's live face (PROTOCOL.md §7.2): present when the view's
 * `cells` is `"all"` and the object has a layout. GM: every stored element,
 * `show_when` kept. Character: only shown elements whose cell it can read,
 * without `show_when`, each keeping its stored `index`; `default_action`
 * only when it names an existing action.
 */
export const FaceViewSchema = looseObject({
  elements: z.array(FaceElementViewSchema),
  collapsed: z.array(FaceElementViewSchema).optional(),
  default_action: z.string().optional(),
});
export type FaceView = z.infer<typeof FaceViewSchema>;

export const ObjectViewSchema = looseObject({
  id: Id,
  is_template: z.boolean(),
  is_character: z.boolean(),
  cells: looseRecord(z.string(), CellViewSchema),
  actions: z.array(ActionDefinitionViewSchema),
  /**
   * Live object views only (M5-D23): one per action, in the order of
   * `actions`. The authority always sends it there; optional so views built
   * elsewhere (and older authorities, §12) still parse.
   */
  action_states: z.array(ActionStateViewSchema).optional(),
  /** M5-D8: when `cells` is `"all"` and the object has a layout. */
  face: FaceViewSchema.optional(),
  /** GM views only (M4-D12): per-cell visibility entries for names not in `cells`. */
  absent_cell_visibility: looseRecord(z.string(), WireViewersSchema).optional(),
});
export type ObjectView = z.infer<typeof ObjectViewSchema>;

export const ObjectSnapshotViewSchema = looseObject({
  id: Id,
  is_template: z.boolean(),
  is_zone: z.boolean(),
  is_character: z.boolean(),
  tag: z.array(z.string()).optional(),
  shape: WireShapeSchema.nullable().optional(),
  contents: z.array(Id.nullable()).optional(),
  cells: looseRecord(z.string(), CellStateViewSchema),
  cell_visibility: looseRecord(z.string(), WireViewersSchema).optional(),
  actions: z.array(ActionDefinitionViewSchema),
  /** The object's face layout (M5-D7); absent when it has none. */
  face: FaceLayoutViewSchema.nullable().optional(),
});
export type ObjectSnapshotView = z.infer<typeof ObjectSnapshotViewSchema>;

const fieldEffect = <F extends string, T extends z.ZodType>(field: F, value: T) =>
  z.object({
    type: z.literal("field"),
    object: Id,
    field: z.literal(field),
    before: value,
    after: value,
  });

const subtreeEffect = <T extends string>(type: T) =>
  z.object({
    type: z.literal(type),
    location: LocationViewSchema,
    objects: z.array(ObjectSnapshotViewSchema),
  });

export const EffectViewSchema = looseNoProto(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("cell"),
      object: Id,
      cell: z.string(),
      before: CellStateViewSchema.nullable(),
      after: CellStateViewSchema.nullable(),
      cause: z.enum(["edit", "roll"]),
    }),
    z.object({
      type: z.literal("cell_visibility"),
      object: Id,
      cell: z.string(),
      before: WireViewersSchema.nullable(),
      after: WireViewersSchema.nullable(),
    }),
    z.discriminatedUnion("field", [
      fieldEffect("tag", z.array(z.string())),
      fieldEffect("shape", WireShapeSchema.nullable()),
      fieldEffect("is_template", z.boolean()),
      fieldEffect("is_character", z.boolean()),
      fieldEffect("actions", z.array(ActionDefinitionViewSchema)),
      fieldEffect("face", FaceLayoutViewSchema.nullable()),
    ]),
    z.object({
      type: z.literal("place"),
      object: Id,
      before: LocationViewSchema,
      after: LocationViewSchema,
    }),
    subtreeEffect("create"),
    subtreeEffect("remove"),
    z.object({
      type: z.literal("reorder"),
      container: Id,
      before: z.array(Id.nullable()),
      after: z.array(Id.nullable()),
    }),
    z.object({
      type: z.literal("board"),
      before: BoardViewSchema.nullable(),
      after: BoardViewSchema.nullable(),
    }),
    z.object({
      type: z.literal("allocate"),
      ids: z.array(Id),
      seq_before: Count,
      seq_after: Count,
    }),
    z.object({ type: z.literal("retire"), ids: z.array(Id) }),
  ]),
);
export type EffectView = z.infer<typeof EffectViewSchema>;

export const GroupViewSchema = looseObject({
  ...GROUP_HEADER_SHAPE,
  base_revision: Count,
  origin: looseObject({ object: Id, action: z.string() }).optional(),
  undoes: Count.optional(),
  undone: z.boolean(),
  names: looseRecord(Id, z.string()),
  effects: z.array(EffectViewSchema).optional(),
});
export type GroupView = z.infer<typeof GroupViewSchema>;

// ---------------------------------------------------------------------------
// Unknown effect variants (§12)

/** The `type` of every `EffectView` variant this version knows. */
export const EFFECT_VIEW_TYPES = [
  "cell",
  "cell_visibility",
  "field",
  "place",
  "create",
  "remove",
  "reorder",
  "board",
  "allocate",
  "retire",
] as const;

/** The `field` of every `field` effect variant this version knows. */
export const FIELD_EFFECT_FIELDS = [
  "tag",
  "shape",
  "is_template",
  "is_character",
  "actions",
  "face",
] as const;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The name of `effect`'s variant when it is a variant this version does not
 * know (a string `type`, or a `field` effect's string `field`, outside the
 * known sets), else null. Malformed effects of a known variant are not
 * unknown: they are left for the schema to reject.
 */
export function unknownEffectVariant(effect: unknown): string | null {
  if (!isRecord(effect) || typeof effect.type !== "string") return null;
  if (!(EFFECT_VIEW_TYPES as readonly string[]).includes(effect.type)) return effect.type;
  if (
    effect.type === "field" &&
    typeof effect.field === "string" &&
    !(FIELD_EFFECT_FIELDS as readonly string[]).includes(effect.field)
  ) {
    return `field:${effect.field}`;
  }
  return null;
}

/**
 * Before schema parsing: a copy of a raw group view with its unknown
 * `EffectView` variants removed, one warning pushed per removed effect. Input
 * that is not a group view with an `effects` array is returned as is. Never
 * mutates its input.
 */
export function dropUnknownEffects(group: unknown, warnings: string[]): unknown {
  if (!isRecord(group) || !Array.isArray(group.effects)) return group;
  const kept = group.effects.filter((effect) => {
    const variant = unknownEffectVariant(effect);
    if (variant === null) return true;
    warnings.push(`dropped unknown effect variant "${variant}" in group ${String(group.index)}`);
    return false;
  });
  return kept.length === group.effects.length ? group : { ...group, effects: kept };
}
