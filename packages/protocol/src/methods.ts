/**
 * Methods (PROTOCOL.md §4, §6, §9, §10): every method's params (strict,
 * client to server) and result (loose, server to client), the `METHODS`
 * table, and `ProtocolRejection`, which results carry.
 */
import {
  ActorSchema,
  CellNameSchema,
  ERROR_CODES,
  type ObjectId,
  OpGroupSchema,
  SnapshotSchema,
} from "@vtt/schema";
import { z } from "zod";
import { WireOpSchema } from "./ops";
import {
  BindingNameSchema,
  looseNoProto,
  looseObject,
  ObjectIdSchema,
  type WireResult,
  WireResultSchema,
} from "./values";
import { LIMITS } from "./version";
import {
  CellViewSchema,
  CoverSchema,
  GROUP_HEADER_SHAPE,
  GroupViewSchema,
  ObjectViewSchema,
  ViewerSchema,
  WireActorSchema,
} from "./views";

/** Every object and board id in a result is a real id, never a `$binding` (§5). */
const Id = ObjectIdSchema;
const Count = z.int().nonnegative();
const Point = z.tuple([z.number(), z.number()]);
const ActionName = z.string().min(1);
const viewer = ViewerSchema.optional();
const limit = (max: number) => z.int().min(1).max(max).optional();
/** `cells` of `list_objects` and `get_objects`. */
const CellsSelector = z.union([z.enum(["all", "structural"]), z.array(CellNameSchema)]);

// ---------------------------------------------------------------------------
// Rejections (§6, §10)

/** `@vtt/schema`'s `Rejection` plus the protocol's own, loose. */
export const ProtocolRejectionSchema = looseNoProto(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("protected_cell"), object: Id, cell: z.string() }),
    z.object({ type: z.literal("containment_cycle"), object: Id, container: Id }),
    z.object({
      type: z.literal("undo_conflict"),
      target: Count,
      conflicting: z.array(Count),
      message: z.string(),
    }),
    z.object({ type: z.literal("nothing_to_undo") }),
    z.object({
      type: z.literal("type_error"),
      object: Id,
      cell: z.string(),
      expected: z.string(),
    }),
    z.object({ type: z.literal("invalid"), message: z.string() }),
    z.object({ type: z.literal("when_false"), object: Id, action: z.string() }),
    z.object({
      type: z.literal("when_error"),
      object: Id,
      action: z.string(),
      code: z.enum(ERROR_CODES),
      message: z.string().optional(),
    }),
    z.object({
      type: z.literal("step_error"),
      object: Id,
      action: z.string(),
      step: Count,
      code: z.enum(ERROR_CODES).optional(),
      message: z.string(),
    }),
    z.object({
      type: z.literal("stale_write"),
      base_revision: Count,
      revision: Count,
      floor: Count,
      truncated: z.boolean(),
      conflicts: z.array(
        looseObject({
          index: Count,
          revision: Count,
          actor: WireActorSchema,
          label: z.string(),
          keys: z.array(z.string()),
        }),
      ),
    }),
    z.object({
      type: z.literal("undo_target_changed"),
      expected: Count,
      actual: Count.nullable(),
    }),
  ]),
);
export type ProtocolRejection = z.infer<typeof ProtocolRejectionSchema>;

// ---------------------------------------------------------------------------
// Write methods

export const TransactParamsSchema = z
  .strictObject({
    base_revision: Count,
    ops: z.array(WireOpSchema).min(1).max(LIMITS.max_ops),
    label: z.string().max(200).optional(),
    txn_id: z.string().min(1).max(64).optional(),
    /** Only with `txn_id`; set on a client resend (§6). */
    retry: z.literal(true).optional(),
    /** The GM driving a character (§3). */
    actor: z.strictObject({ type: z.literal("character"), id: ObjectIdSchema }).optional(),
    /**
     * The read set (§6; M6-D31): cells the ops were computed from. A group
     * after `base_revision` touching one rejects `stale_write`; `[]` is the
     * same as absent.
     */
    expect: z
      .array(z.strictObject({ object: ObjectIdSchema, cell: CellNameSchema }))
      .max(LIMITS.max_ops)
      .optional(),
  })
  .refine((p) => p.retry === undefined || p.txn_id !== undefined, {
    message: "retry requires txn_id",
    path: ["retry"],
  });
export type TransactParams = z.infer<typeof TransactParamsSchema>;

export const TransactResultSchema = looseNoProto(
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("committed"),
      revision: Count,
      index: Count,
      created: z.array(looseObject({ op_index: Count, id: Id })),
      copies: z.array(
        looseObject({ op_index: Count, root: Id, copies: looseNoProto(z.record(Id, Id)) }),
      ),
      bindings: looseNoProto(z.record(BindingNameSchema, Id)),
    }),
    z.object({
      status: z.literal("rejected"),
      rejection: ProtocolRejectionSchema,
      op_index: Count.optional(),
    }),
  ]),
);
export type TransactResult = z.infer<typeof TransactResultSchema>;

export const UndoParamsSchema = z.strictObject({
  target: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("latest") }),
    z.strictObject({ type: z.literal("mine") }),
    z.strictObject({ type: z.literal("actor"), actor: ActorSchema }),
    z.strictObject({ type: z.literal("group"), index: Count }),
    z.strictObject({ type: z.literal("human") }),
  ]),
  expect_index: Count.optional(),
  label: z.string().max(200).optional(),
});
export type UndoParams = z.infer<typeof UndoParamsSchema>;
/** `TransactResult` with `created`, `copies` and `bindings` empty. */
export const UndoResultSchema = TransactResultSchema;
export type UndoResult = TransactResult;

/** `invoke` (M5-D1): runs an object's named action as one `action` group (§4, §6). */
export const InvokeParamsSchema = z
  .strictObject({
    object: ObjectIdSchema,
    action: ActionName,
    base_revision: Count,
    txn_id: z.string().min(1).max(64).optional(),
    /** Only with `txn_id`; set on a client resend (§6). */
    retry: z.literal(true).optional(),
    /** The GM driving a character (§3); non-agent connections only. */
    actor: z.strictObject({ type: z.literal("character"), id: ObjectIdSchema }).optional(),
    label: z.string().max(200).optional(),
    /** What the `table` destination resolves to (FORMULAS.md §8.2). */
    table: z.strictObject({ board: ObjectIdSchema, position: Point }).optional(),
  })
  .refine((p) => p.retry === undefined || p.txn_id !== undefined, {
    message: "retry requires txn_id",
    path: ["retry"],
  });
export type InvokeParams = z.infer<typeof InvokeParamsSchema>;
/** `created`: the ids the action spawned, in creation order; `step`: the refusing step (0-based). */
export const InvokeResultSchema = looseNoProto(
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("committed"),
      revision: Count,
      index: Count,
      created: z.array(Id),
    }),
    z.object({
      status: z.literal("rejected"),
      rejection: ProtocolRejectionSchema,
      step: Count.optional(),
    }),
  ]),
);
export type InvokeResult = z.infer<typeof InvokeResultSchema>;

export const SaveParamsSchema = z.strictObject({});
export type SaveParams = z.infer<typeof SaveParamsSchema>;
export const SaveResultSchema = looseObject({
  status: z.enum(["saved", "saved_not_durable", "failed"]),
  /** The revision the save captured. */
  revision: Count,
  message: z.string().optional(),
});
export type SaveResult = z.infer<typeof SaveResultSchema>;

/** `collect_assets` (M6-D32): unlist assets nothing references; `delete` also removes their files. */
export const CollectAssetsParamsSchema = z.strictObject({ delete: z.boolean().optional() });
export type CollectAssetsParams = z.infer<typeof CollectAssetsParamsSchema>;
export const CollectAssetsResultSchema = looseObject({
  /** The asset paths nothing referenced, now unlisted, in list order. */
  unreferenced: z.array(z.string()),
  /** Those whose files were deleted from the table's assets directory. */
  deleted: z.array(z.string()),
});
export type CollectAssetsResult = z.infer<typeof CollectAssetsResultSchema>;

// ---------------------------------------------------------------------------
// Query methods

export const ListObjectsParamsSchema = z.strictObject({
  viewer,
  filter: z
    .strictObject({
      board: ObjectIdSchema.optional(),
      container: ObjectIdSchema.optional(),
      tag: z.string().optional(),
      name: z.string().optional(),
      is_template: z.boolean().optional(),
      is_zone: z.boolean().optional(),
      is_character: z.boolean().optional(),
    })
    .optional(),
  cells: CellsSelector.optional(),
  cursor: z.string().optional(),
  limit: limit(LIMITS.max_page),
});
export type ListObjectsParams = z.infer<typeof ListObjectsParamsSchema>;
export const ListObjectsResultSchema = looseObject({
  revision: Count,
  objects: z.array(ObjectViewSchema),
  next_cursor: z.string().nullable(),
});
export type ListObjectsResult = z.infer<typeof ListObjectsResultSchema>;

export const GetObjectsParamsSchema = z.strictObject({
  ids: z.array(ObjectIdSchema).min(1).max(LIMITS.max_ids),
  viewer,
  cells: CellsSelector.optional(),
});
export type GetObjectsParams = z.infer<typeof GetObjectsParamsSchema>;
export const GetObjectsResultSchema = looseObject({
  revision: Count,
  objects: z.array(ObjectViewSchema),
  missing: z.array(Id),
});
export type GetObjectsResult = z.infer<typeof GetObjectsResultSchema>;

export const EvaluateParamsSchema = z.strictObject({
  source: z.string().max(LIMITS.max_source_length),
  this: ObjectIdSchema.optional(),
});
export type EvaluateParams = z.infer<typeof EvaluateParamsSchema>;
export const EvaluateResultSchema = looseObject({ revision: Count, value: WireResultSchema });
export type EvaluateResult = z.infer<typeof EvaluateResultSchema>;

export const ZonesParamsSchema = z.strictObject({ board: ObjectIdSchema, viewer });
export type ZonesParams = z.infer<typeof ZonesParamsSchema>;
export const ZonesResultSchema = looseObject({
  revision: Count,
  zones: z.array(
    looseObject({
      id: Id,
      contents: z.array(Id),
      error: z.enum(ERROR_CODES).optional(),
      view: ObjectViewSchema,
    }),
  ),
});
export type ZonesResult = z.infer<typeof ZonesResultSchema>;

export const AtPositionParamsSchema = z.strictObject({
  board: ObjectIdSchema,
  position: Point,
  viewer,
});
export type AtPositionParams = z.infer<typeof AtPositionParamsSchema>;
export const AtPositionResultSchema = looseObject({
  revision: Count,
  objects: z.array(Id),
  zones: z.array(Id),
});
export type AtPositionResult = z.infer<typeof AtPositionResultSchema>;

export const ChangesSinceParamsSchema = z.strictObject({
  revision: Count,
  viewer,
  limit: limit(LIMITS.max_groups),
});
export type ChangesSinceParams = z.infer<typeof ChangesSinceParamsSchema>;
export const ChangesSinceResultSchema = looseObject({
  revision: Count,
  floor: Count,
  groups: z.array(GroupViewSchema),
  truncated: z.boolean(),
  more: z.boolean(),
  next_revision: Count,
});
export type ChangesSinceResult = z.infer<typeof ChangesSinceResultSchema>;

export const LogParamsSchema = z.strictObject({
  before: Count.optional(),
  limit: limit(LIMITS.max_page),
  viewer,
  effects: z.boolean().optional(),
});
export type LogParams = z.infer<typeof LogParamsSchema>;
/** Newest first. */
export const LogResultSchema = looseObject({
  first_index: Count,
  next_index: Count,
  undo_barrier: Count,
  groups: z.array(GroupViewSchema),
});
export type LogResult = z.infer<typeof LogResultSchema>;

export const DocumentParamsSchema = z.strictObject({});
export type DocumentParams = z.infer<typeof DocumentParamsSchema>;
/** Canonical and unfiltered: `@vtt/schema`'s schemas unchanged (no MCP tool, D30). */
export const DocumentResultSchema = looseObject({
  snapshot: SnapshotSchema,
  log: looseObject({ first_index: Count, groups: z.array(OpGroupSchema), undo_barrier: Count }),
});
export type DocumentResult = z.infer<typeof DocumentResultSchema>;

// ---------------------------------------------------------------------------
// Explain methods (§9)

export type DepNode =
  | {
      type: "cell";
      object: ObjectId | null;
      cell: string;
      value?: WireResult;
      hidden?: true;
      dependencies?: DepNode[];
    }
  | { type: "exists"; object: ObjectId | null; exists?: boolean }
  | { type: "index" };

export const DepNodeSchema: z.ZodType<DepNode> = looseNoProto(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("cell"),
      object: Id.nullable(),
      cell: z.string(),
      value: WireResultSchema.optional(),
      hidden: z.literal(true).optional(),
      get dependencies() {
        return z.array(DepNodeSchema).optional();
      },
    }),
    z.object({
      type: z.literal("exists"),
      object: Id.nullable(),
      exists: z.boolean().optional(),
    }),
    z.object({ type: z.literal("index") }),
  ]),
);

export const ExplainCellParamsSchema = z.strictObject({
  object: ObjectIdSchema,
  cell: CellNameSchema,
  viewer,
  depth: z.int().min(1).max(LIMITS.max_explain_depth).optional(),
});
export type ExplainCellParams = z.infer<typeof ExplainCellParamsSchema>;
export const ExplainCellResultSchema = looseObject({
  revision: Count,
  object: Id,
  cell: z.string(),
  view: CellViewSchema,
  content: looseNoProto(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("literal") }),
      z.object({ type: z.literal("structural") }),
      z.object({
        type: z.literal("formula"),
        source: z.string().optional(),
        overridden: z.boolean(),
        parses: z.boolean(),
        syntax_error: z.string().optional(),
      }),
    ]),
  ),
  dependencies: z.array(DepNodeSchema),
  truncated: z.boolean(),
  error_chain: z
    .array(looseObject({ object: Id.nullable(), cell: z.string().nullable(), code: z.string() }))
    .optional(),
  last_write: looseObject({ ...GROUP_HEADER_SHAPE, cause: z.enum(["edit", "roll"]) }).optional(),
});
export type ExplainCellResult = z.infer<typeof ExplainCellResultSchema>;

export const ExplainGroupParamsSchema = z.strictObject({ index: Count, viewer });
export type ExplainGroupParams = z.infer<typeof ExplainGroupParamsSchema>;
export const ExplainGroupResultSchema = looseObject({
  group: GroupViewSchema,
  action: z
    .object({
      object: Id,
      name: z.string(),
      when: z.string().optional(),
      steps: z.array(z.string()),
      current: z.literal(true),
    })
    .optional(),
});
export type ExplainGroupResult = z.infer<typeof ExplainGroupResultSchema>;

export const ExplainActionParamsSchema = z.strictObject({
  object: ObjectIdSchema,
  action: ActionName,
  viewer,
});
export type ExplainActionParams = z.infer<typeof ExplainActionParamsSchema>;
export const ExplainActionResultSchema = looseObject({
  object: Id,
  action: z.string(),
  enabled: z.boolean(),
  reason: z.enum(["when_false", "when_error"]).optional(),
  /** Present only when the action has a `when`. */
  guard: looseObject({ source: z.string().optional(), value: WireResultSchema }).optional(),
  steps: z.array(z.string()).optional(),
  /** GM only, present when the action has a `when`: whether it parses. */
  when_parses: z.boolean().optional(),
  /** GM only: the parser's message when `when` does not parse. */
  when_syntax_error: z.string().optional(),
  /** GM only: one entry per step, in order, from the step parser (FORMULAS.md §8.4). */
  step_status: z
    .array(
      looseNoProto(
        z.discriminatedUnion("ok", [
          z.object({ ok: z.literal(true) }),
          z.object({ ok: z.literal(false), message: z.string(), offset: Count }),
        ]),
      ),
    )
    .optional(),
});
export type ExplainActionResult = z.infer<typeof ExplainActionResultSchema>;

// ---------------------------------------------------------------------------
// Subscribe methods (§8)

export const SubscribeParamsSchema = z.strictObject({
  scope: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("board"), board: ObjectIdSchema }),
    z.strictObject({
      type: z.literal("objects"),
      ids: z.array(ObjectIdSchema).min(1).max(LIMITS.max_ids),
      subtree: z.boolean().optional(),
    }),
    z.strictObject({ type: z.literal("all") }),
    z.strictObject({ type: z.literal("log") }),
  ]),
  viewer,
  cells: z.enum(["all", "structural"]).optional(),
});
export type SubscribeParams = z.infer<typeof SubscribeParamsSchema>;
export const SubscribeResultSchema = looseObject({
  subscription: z.string(),
  revision: Count,
  objects: z.array(ObjectViewSchema),
  covers: z.array(CoverSchema),
  groups: z.array(GroupViewSchema).optional(),
});
export type SubscribeResult = z.infer<typeof SubscribeResultSchema>;

export const UnsubscribeParamsSchema = z.strictObject({ subscription: z.string().min(1) });
export type UnsubscribeParams = z.infer<typeof UnsubscribeParamsSchema>;
export const UnsubscribeResultSchema = looseObject({});
export type UnsubscribeResult = z.infer<typeof UnsubscribeResultSchema>;

// ---------------------------------------------------------------------------
// The table

export type MethodKind = "write" | "query" | "explain" | "subscribe";

/** The 18 methods of PROTOCOL.md §4: kind, params schema, result schema. */
export const METHODS = Object.freeze({
  transact: { kind: "write", params: TransactParamsSchema, result: TransactResultSchema },
  undo: { kind: "write", params: UndoParamsSchema, result: UndoResultSchema },
  invoke: { kind: "write", params: InvokeParamsSchema, result: InvokeResultSchema },
  save: { kind: "write", params: SaveParamsSchema, result: SaveResultSchema },
  collect_assets: {
    kind: "write",
    params: CollectAssetsParamsSchema,
    result: CollectAssetsResultSchema,
  },
  list_objects: { kind: "query", params: ListObjectsParamsSchema, result: ListObjectsResultSchema },
  get_objects: { kind: "query", params: GetObjectsParamsSchema, result: GetObjectsResultSchema },
  evaluate: { kind: "query", params: EvaluateParamsSchema, result: EvaluateResultSchema },
  zones: { kind: "query", params: ZonesParamsSchema, result: ZonesResultSchema },
  at_position: { kind: "query", params: AtPositionParamsSchema, result: AtPositionResultSchema },
  changes_since: {
    kind: "query",
    params: ChangesSinceParamsSchema,
    result: ChangesSinceResultSchema,
  },
  log: { kind: "query", params: LogParamsSchema, result: LogResultSchema },
  document: { kind: "query", params: DocumentParamsSchema, result: DocumentResultSchema },
  explain_cell: {
    kind: "explain",
    params: ExplainCellParamsSchema,
    result: ExplainCellResultSchema,
  },
  explain_group: {
    kind: "explain",
    params: ExplainGroupParamsSchema,
    result: ExplainGroupResultSchema,
  },
  explain_action: {
    kind: "explain",
    params: ExplainActionParamsSchema,
    result: ExplainActionResultSchema,
  },
  subscribe: { kind: "subscribe", params: SubscribeParamsSchema, result: SubscribeResultSchema },
  unsubscribe: {
    kind: "subscribe",
    params: UnsubscribeParamsSchema,
    result: UnsubscribeResultSchema,
  },
} as const satisfies Record<string, { kind: MethodKind; params: z.ZodType; result: z.ZodType }>);

export type MethodName = keyof typeof METHODS;

/** The method names, in PROTOCOL.md §4 table order. */
export const METHOD_NAMES = Object.freeze(Object.keys(METHODS)) as readonly MethodName[];

export type Params<M extends MethodName> = z.infer<(typeof METHODS)[M]["params"]>;
export type Result<M extends MethodName> = z.infer<(typeof METHODS)[M]["result"]>;

export function isMethodName(name: unknown): name is MethodName {
  return typeof name === "string" && Object.hasOwn(METHODS, name);
}
