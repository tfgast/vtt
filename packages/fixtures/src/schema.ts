/**
 * Zod schema for acceptance scenarios (docs/FIXTURES.md).
 *
 * Every tagged form discriminates on a field named `type`. Objects are strict:
 * an unknown key is a validation error, so a typo in a fixture fails loudly.
 * The shapes here are structural; cross-references (ids, bindings, placement,
 * containment) are checked by `checkScenario` in check.ts, attached below.
 */
import { z } from "zod";
import { checkScenario } from "./check";

// ---------------------------------------------------------------- primitives

/** Object, board, and binding names. `gm`, `all`, `owner` are reserved. */
export const NameSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    "names are letters, digits, underscores, starting with a letter",
  );

/** A cell name. FORMULAS §3 allows non-identifier names (written in backticks). */
export const CellNameSchema = z.string().min(1);

export const PointSchema = z.tuple([z.number(), z.number()]);

/** FORMULAS §2.3. Errors are only ever expected, never stored. */
export const ErrorCodeSchema = z.enum([
  "#CYCLE",
  "#NAME",
  "#TYPE",
  "#REF",
  "#DIV0",
  "#LIMIT",
  "#SYNTAX",
]);

/** A source text: a formula, a `when` precondition, or an action step. */
const SourceSchema = z.string().trim().min(1);

// -------------------------------------------------------------------- values

export const RefValueSchema = z.strictObject({
  type: z.literal("ref"),
  object: NameSchema,
});

/** A roll result (FORMULAS §2.2): the expression rolled, kept and dropped dice, total. */
export const RollValueSchema = z.strictObject({
  type: z.literal("roll"),
  expr: SourceSchema,
  dice: z.array(z.int()),
  dropped: z.array(z.int()),
  total: z.number(),
});

/** One member of a viewer set: `all`, `gm`, `owner`, or a character reference. */
export const ViewerEntrySchema = z.union([z.enum(["all", "gm", "owner"]), RefValueSchema]);

export const ViewersValueSchema = z.strictObject({
  type: z.literal("viewers"),
  viewers: z.array(ViewerEntrySchema).min(1),
});

const NumberValueSchema = z.strictObject({ type: z.literal("number"), value: z.number() });
const TextValueSchema = z.strictObject({ type: z.literal("text"), value: z.string() });
const BooleanValueSchema = z.strictObject({ type: z.literal("boolean"), value: z.boolean() });
const EmptyValueSchema = z.strictObject({ type: z.literal("empty") });
const DiceValueSchema = z.strictObject({ type: z.literal("dice"), expr: SourceSchema });
const InkValueSchema = z.strictObject({
  type: z.literal("ink"),
  strokes: z.array(z.array(PointSchema).min(1)).min(1),
});

/** Lists hold tagged values; a list literal may nest. */
const ListValueSchema = z.strictObject({
  type: z.literal("list"),
  get items(): z.ZodArray<typeof ValueSchema> {
    return z.array(ValueSchema);
  },
});

/** Every storable value of FORMULAS §2. Records and errors are not storable. */
export const ValueSchema = z.discriminatedUnion("type", [
  NumberValueSchema,
  TextValueSchema,
  BooleanValueSchema,
  EmptyValueSchema,
  ListValueSchema,
  RefValueSchema,
  DiceValueSchema,
  RollValueSchema,
  ViewersValueSchema,
  InkValueSchema,
]);

/** Formula source. Distinct from text: `{type:"text"}` is a literal string. */
export const FormulaSchema = z.strictObject({
  type: z.literal("formula"),
  source: SourceSchema,
});

/** What a cell holds in setup or at spawn: a literal value or a formula. */
export const CellContentSchema = z.union([ValueSchema, FormulaSchema]);

// ----------------------------------------------------------------- the table

/** A region (zone) or outline (token), relative to the object's anchor `position`. */
export const ShapeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("rect"),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  z.strictObject({ type: z.literal("circle"), radius: z.number().positive() }),
  z.strictObject({ type: z.literal("polygon"), points: z.array(PointSchema).min(3) }),
]);

/** Board placement. `position` is the anchor, or a formula (FORMULAS §3.1). */
export const PlacementSchema = z.strictObject({
  board: NameSchema,
  position: z.union([PointSchema, FormulaSchema]),
});

export const ActionSchema = z.strictObject({
  name: z.string().min(1),
  when: SourceSchema.optional(),
  steps: z.array(SourceSchema).min(1),
});

// ------------------------------------------------------------------- faces

/** `[x, y, w, h]` in the object's unrotated local frame (DESIGN §4.6); `w`, `h` > 0. */
const RectSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

const FaceStyleSchema = z.strictObject({
  size: z.enum(["small", "normal", "large", "huge"]).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  caption: z.boolean().optional(),
  format: z
    .strictObject({
      sign: z.enum(["always", "auto"]).optional(),
      decimals: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
});

const faceCommon = {
  rect: RectSchema,
  show_when: SourceSchema.optional(),
  min_size: z.number().nonnegative().optional(),
};

/** One face element (DESIGN §4.6): a cell's value or editor, a button, or the contents. */
export const FaceElementSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("value"),
    cell: CellNameSchema,
    ...faceCommon,
    style: FaceStyleSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("editor"),
    cell: CellNameSchema,
    ...faceCommon,
    style: FaceStyleSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("button"),
    action: z.string().min(1),
    ...faceCommon,
    label: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("contents"),
    ...faceCommon,
    entries: z.enum(["collapsed", "full"]).optional(),
    /** Shown only while selected or Alt-drop hovered (M6-D12); absent is unset. */
    when_selected: z.boolean().optional(),
    /** How entries are arranged (M6-D30); absent is `"list"`. */
    layout: z.enum(["list", "grid", "fan"]).optional(),
  }),
]);

/**
 * A face layout (DESIGN §4.6; FIXTURES §3 Face, §11): the encoding of the
 * object field `face`, copied verbatim on spawn. Structural only; the
 * engine's limits (element counts, name lengths) are its own.
 */
export const FaceLayoutSchema = z.strictObject({
  elements: z.array(FaceElementSchema),
  collapsed: z.array(FaceElementSchema).optional(),
  default_action: z.string().min(1).optional(),
});

export const ObjectSchema = z.strictObject({
  id: NameSchema,
  note: z.string().optional(),
  is_template: z.boolean().optional(),
  is_zone: z.boolean().optional(),
  tag: z.array(z.string().min(1)).optional(),
  shape: ShapeSchema.optional(),
  placement: PlacementSchema.optional(),
  contents: z.array(NameSchema).optional(),
  cells: z.record(CellNameSchema, CellContentSchema).optional(),
  cell_visibility: z.record(CellNameSchema, ViewersValueSchema).optional(),
  actions: z.array(ActionSchema).optional(),
  face: FaceLayoutSchema.optional(),
});

export const BoardSchema = z.strictObject({
  id: NameSchema,
  name: z.string().optional(),
});

export const SetupSchema = z.strictObject({
  boards: z.array(BoardSchema),
  characters: z.array(NameSchema),
  objects: z.array(ObjectSchema),
});

// --------------------------------------------------------------- dice script

export const PermutationSchema = z.strictObject({
  type: z.literal("permutation"),
  order: z.array(z.int().nonnegative()),
});

export const DiceScriptEntrySchema = z.discriminatedUnion("type", [
  RollValueSchema,
  PermutationSchema,
]);

// --------------------------------------------------------------------- steps

/** Who performs a step: the GM or a character id. */
export const ActorSchema = NameSchema;
/** Who is looking, for visibility expectations: the GM or a character id. */
export const ViewerSchema = NameSchema;

export const DestinationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("board"), board: NameSchema, position: PointSchema }),
  z.strictObject({
    type: z.literal("container"),
    container: NameSchema,
    index: z.int().nonnegative(),
  }),
]);

export const DoSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("set"),
    object: NameSchema,
    cell: CellNameSchema,
    value: ValueSchema,
  }),
  z.strictObject({
    type: z.literal("override"),
    object: NameSchema,
    cell: CellNameSchema,
    value: ValueSchema,
  }),
  z.strictObject({ type: z.literal("clear_override"), object: NameSchema, cell: CellNameSchema }),
  z.strictObject({ type: z.literal("invoke"), object: NameSchema, action: z.string().min(1) }),
  z.strictObject({ type: z.literal("move"), object: NameSchema, to: DestinationSchema }),
  z.strictObject({
    type: z.literal("spawn"),
    template: NameSchema,
    to: DestinationSchema,
    cells: z.record(CellNameSchema, CellContentSchema).optional(),
    as: NameSchema,
    owned: z.record(NameSchema, NameSchema).optional(),
  }),
  z.strictObject({ type: z.literal("undo") }),
  z.strictObject({
    type: z.literal("bind"),
    as: NameSchema,
    tag: z.string().min(1),
    where: z.strictObject({ cell: CellNameSchema, value: ValueSchema }).optional(),
    in: NameSchema.optional(),
  }),
]);

// -------------------------------------------------------------- expectations

export const RejectionReasonSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("when_false") }),
  z.strictObject({ type: z.literal("when_error"), code: ErrorCodeSchema }),
  z.strictObject({ type: z.literal("step_error"), code: ErrorCodeSchema.optional() }),
  z.strictObject({ type: z.literal("protected_cell") }),
  z.strictObject({ type: z.literal("containment_cycle") }),
  z.strictObject({ type: z.literal("undo_conflict") }),
  z.strictObject({ type: z.literal("nothing_to_undo") }),
]);

export const LogEffectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("write"),
    object: NameSchema,
    cell: CellNameSchema,
    value: ValueSchema,
  }),
  z.strictObject({
    type: z.literal("roll"),
    object: NameSchema,
    cell: CellNameSchema,
    value: RollValueSchema,
  }),
]);

/** Optional prose on an expectation: the line of the doc that justifies it. */
const note = { note: z.string().optional() };

/**
 * Replaying the log reproduces the stored state (docs/FIXTURES.md §7, §11):
 * the recorded effects of every group, applied to the post-setup document,
 * yield the current snapshot without consuming dice-script entries.
 */
export const ReplayExpectationSchema = z.strictObject({ type: z.literal("replay"), ...note });

/**
 * A face element is shown in a viewer's face view (FIXTURES §7, §11):
 * `element` is its index in the stored list (`list` `"full"`, the default,
 * for `elements`; `"collapsed"` for `collapsed`), `viewer` defaults to `gm`.
 */
export const FaceElementExpectationSchema = z.strictObject({
  type: z.literal("face_element"),
  object: NameSchema,
  element: z.int().nonnegative(),
  list: z.enum(["full", "collapsed"]).optional(),
  viewer: ViewerSchema.optional(),
  shown: z.boolean(),
  ...note,
});

export const ExpectationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cell"),
    object: NameSchema,
    cell: CellNameSchema,
    value: ValueSchema,
    ...note,
  }),
  z.strictObject({
    type: z.literal("cell_error"),
    object: NameSchema,
    cell: CellNameSchema,
    code: ErrorCodeSchema,
    ...note,
  }),
  z.strictObject({
    type: z.literal("override"),
    object: NameSchema,
    cell: CellNameSchema,
    overridden: z.boolean(),
    ...note,
  }),
  z.strictObject({
    type: z.literal("action"),
    object: NameSchema,
    action: z.string().min(1),
    enabled: z.boolean(),
    ...note,
  }),
  z.strictObject({ type: z.literal("rejected"), reason: RejectionReasonSchema, ...note }),
  z.strictObject({ type: z.literal("exists"), object: NameSchema, exists: z.boolean(), ...note }),
  z.strictObject({
    type: z.literal("container"),
    object: NameSchema,
    container: NameSchema,
    index: z.int().nonnegative(),
    ...note,
  }),
  z.strictObject({
    type: z.literal("placement"),
    object: NameSchema,
    board: NameSchema,
    position: PointSchema,
    ...note,
  }),
  z.strictObject({
    type: z.literal("contents"),
    object: NameSchema,
    contents: z.array(NameSchema),
    ...note,
  }),
  z.strictObject({
    type: z.literal("cell_visible"),
    object: NameSchema,
    cell: CellNameSchema,
    viewer: ViewerSchema,
    visible: z.boolean(),
    ...note,
  }),
  z.strictObject({
    type: z.literal("object_visible"),
    object: NameSchema,
    viewer: ViewerSchema,
    visible: z.boolean(),
    ...note,
  }),
  z.strictObject({ type: z.literal("log_groups"), count: z.int().nonnegative(), ...note }),
  z.strictObject({
    type: z.literal("log_includes"),
    group: z.int(),
    effect: LogEffectSchema,
    ...note,
  }),
  ReplayExpectationSchema,
  FaceElementExpectationSchema,
]);

export const StepSchema = z.strictObject({
  actor: ActorSchema.optional(),
  note: z.string().optional(),
  do: DoSchema,
  expect: z.array(ExpectationSchema).optional(),
});

// ------------------------------------------------------------------ scenario

const ScenarioShapeSchema = z.strictObject({
  title: z.string().min(1),
  source: z.string().min(1),
  description: z.string().optional(),
  setup: SetupSchema,
  dice: z.array(DiceScriptEntrySchema),
  expect: z.array(ExpectationSchema).optional(),
  steps: z.array(StepSchema),
});

export type ScenarioShape = z.infer<typeof ScenarioShapeSchema>;

/**
 * zod's records silently drop an own `__proto__` key (JSON.parse creates one),
 * which would lose a cell without a word. Reject it anywhere in the input.
 */
function rejectProtoKeys(input: unknown, ctx: z.RefinementCtx): void {
  const walk = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        walk(item, [...path, i]);
      });
    } else if (typeof v === "object" && v !== null) {
      for (const key of Object.keys(v)) {
        if (key === "__proto__") {
          ctx.addIssue({
            code: "custom",
            path: [...path, key],
            message: '"__proto__" is not allowed as a key',
          });
        } else {
          walk((v as Record<string, unknown>)[key], [...path, key]);
        }
      }
    }
  };
  walk(input, []);
}

/** The validator: structural shape plus cross-reference checks. */
export const ScenarioSchema = z
  .unknown()
  .superRefine(rejectProtoKeys)
  .pipe(ScenarioShapeSchema.superRefine(checkScenario));
