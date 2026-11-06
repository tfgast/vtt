/**
 * The MCP request tools (PROTOCOL.md §11; DESIGN.md §5.2, §5.3; M3-D17):
 * their strict input schemas, derived from `@vtt/protocol`'s params schemas,
 * their descriptions, and their handlers over a `ProtocolClient`. Every
 * handler is registered through the connection gate (`withConnection`).
 * The subscription tools are vtt-5su.15's, added through `createMcpServer`'s
 * extension hook.
 */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  AtPositionParamsSchema,
  ChangesSinceParamsSchema,
  EvaluateParamsSchema,
  ExplainActionParamsSchema,
  ExplainCellParamsSchema,
  ExplainGroupParamsSchema,
  GetObjectsParamsSchema,
  ListObjectsParamsSchema,
  LogParamsSchema,
  type MethodName,
  type ProtocolClient,
  SaveParamsSchema,
  TransactParamsSchema,
  type TransactResult,
  transactWithRetry,
  UndoParamsSchema,
  type WireOp,
  ZonesParamsSchema,
} from "@vtt/protocol";
import { z } from "zod";
import { failureResult, toolError, toolResult, withConnection } from "./gate";
import { INVOKE_TOOL, invokeHandler } from "./invoke-tool";

/** How long a `transact` whose socket dropped after the send waits to resend (PROTOCOL.md §6, §11). */
export const TRANSACT_RETRY_MS = 10_000;

/** A params schema made strict: the same fields, unknown keys refused. */
const strict = <S extends z.core.$ZodLooseShape>(schema: { shape: S }) =>
  z.strictObject(schema.shape);

const [UndoLatest, UndoMine, , UndoGroup] = UndoParamsSchema.shape.target.options;

// ---------------------------------------------------------------------------
// Input schemas (PROTOCOL.md §11): strict, transport-managed fields removed.

export const TableInfoInputSchema = z.strictObject({});
export const ListObjectsInputSchema = strict(ListObjectsParamsSchema);
export const GetObjectsInputSchema = strict(GetObjectsParamsSchema);
export const EvaluateInputSchema = strict(EvaluateParamsSchema);
export const ZonesInputSchema = strict(ZonesParamsSchema);
export const AtPositionInputSchema = strict(AtPositionParamsSchema);
export const ChangesSinceInputSchema = strict(ChangesSinceParamsSchema);
export const LogInputSchema = strict(LogParamsSchema);
export const ExplainCellInputSchema = strict(ExplainCellParamsSchema);
export const ExplainGroupInputSchema = strict(ExplainGroupParamsSchema);
export const ExplainActionInputSchema = strict(ExplainActionParamsSchema);
/**
 * `transact` without `actor`, `retry` and `txn_id` (the MCP server always
 * generates `txn_id`). Built from the params' shape: zod refuses `omit` on
 * the refined params schema, and the refinement only relates the omitted
 * `retry` and `txn_id`.
 */
export const TransactInputSchema = strict(TransactParamsSchema).omit({
  actor: true,
  retry: true,
  txn_id: true,
});
/** `undo` with `target` narrowed to `latest`, `mine` and `group`. */
export const UndoInputSchema = UndoParamsSchema.extend({
  target: z.discriminatedUnion("type", [UndoLatest, UndoMine, UndoGroup]),
}).strict();
export const SaveInputSchema = strict(SaveParamsSchema);

// ---------------------------------------------------------------------------
// Descriptions (PROTOCOL.md §11 tool descriptions)

const IDS =
  "Object ids should be human-meaningful (token_12, room_4, fireball_aldric), not random (DESIGN.md §5.3).";
const REVISION =
  "Writes need the latest `revision` as `base_revision`: take it from table_info, from the `revision` of any result, or from poll_changes. A write is rejected `stale_write` when a group committed after that revision touched the same things.";
const GROUP =
  "One transact is one undoable group: put everything that belongs together in one call; it commits atomically or not at all.";
const FORMULAS =
  "Formulas and actions follow docs/FORMULAS.md (resource vtt://docs/formulas); op shapes are in vtt://schema/ops.";
const VIEWER = "`viewer` selects whose view is computed (default: the GM's).";

const DESCRIPTIONS = {
  table_info: `The table's current revision, boards, name, limits, this agent's actor and the authority session. Call it first: writes need the latest revision. ${IDS}`,
  list_objects: `Lists objects, paged (\`limit\` up to 200, \`next_cursor\` for the next page), filtered by board, container, tag, name or flags; \`cells\` selects all, structural or named cells. ${VIEWER}`,
  get_objects: `Reads objects by id (up to 200) with their cell values; unknown ids are listed in \`missing\`. ${VIEWER}`,
  evaluate: `Evaluates a formula without writing anything, optionally with \`this\` bound to an object. ${FORMULAS}`,
  zones: `Lists a board's zones with the objects inside each. ${VIEWER}`,
  at_position: `Lists the objects and zones at a point on a board. ${VIEWER}`,
  changes_since: `The groups committed after a revision, oldest first (\`limit\` up to 500; follow \`next_revision\` while \`more\`). ${VIEWER}`,
  log: `The undo log, newest first (\`before\` an index, \`limit\` up to 200), optionally with each group's effects. ${VIEWER}`,
  explain_cell: `Explains a cell: its formula, its value, its dependency tree (\`depth\` up to 4) and the group that last wrote it. ${FORMULAS}`,
  explain_group: `Explains a log entry: its ops' effects and, for an action, the action's steps. ${VIEWER}`,
  explain_action: `Explains an action: whether its \`when\` guard allows it now, and its steps. ${FORMULAS}`,
  transact: `Applies a batch of ops (up to 1000; create, move, remove objects; set values and formulas; define actions; change visibility; boards). ${REVISION} ${GROUP} ${IDS} ${FORMULAS} \`expect\` lists the cells (\`{object, cell}\`) your ops were computed from but do not write: a group committed after \`base_revision\` that touched one rejects the batch \`stale_write\`, so a value derived from a cell that changed meanwhile is caught. A rejected batch returns isError with the rejection and the failing op's index. A lost response is retried automatically; if the outcome cannot be known it returns isError \`uncertain\`: check with changes_since before writing again.`,
  undo: `Undoes a group: the latest group (\`latest\`), this agent's latest (\`mine\`), or a group by log index (\`group\`); \`expect_index\` refuses it (\`undo_target_changed\`) if the target is not that group. An undo is itself one undoable group; it carries no base revision. ${GROUP}`,
  save: "Saves the table file now and reports whether it was saved.",
} as const;

// ---------------------------------------------------------------------------
// The tool table

export type ToolName = keyof typeof DESCRIPTIONS | "invoke";

export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  /** The strict MCP input schema; `z.toJSONSchema(input, {io: "input"})` is what `tools/list` shows. */
  readonly input: z.ZodObject;
}

const spec = (name: keyof typeof DESCRIPTIONS, input: z.ZodObject): ToolSpec =>
  Object.freeze({ name, description: DESCRIPTIONS[name], input });

/** The 15 request tools of PROTOCOL.md §11, in its table order (`invoke`: invoke-tool.ts). */
export const TOOLS: readonly ToolSpec[] = Object.freeze([
  spec("table_info", TableInfoInputSchema),
  spec("list_objects", ListObjectsInputSchema),
  spec("get_objects", GetObjectsInputSchema),
  spec("evaluate", EvaluateInputSchema),
  spec("zones", ZonesInputSchema),
  spec("at_position", AtPositionInputSchema),
  spec("changes_since", ChangesSinceInputSchema),
  spec("log", LogInputSchema),
  spec("explain_cell", ExplainCellInputSchema),
  spec("explain_group", ExplainGroupInputSchema),
  spec("explain_action", ExplainActionInputSchema),
  spec("transact", TransactInputSchema),
  INVOKE_TOOL,
  spec("undo", UndoInputSchema),
  spec("save", SaveInputSchema),
]);

// ---------------------------------------------------------------------------
// Handlers

/** A write result: committed is normal, rejected is `isError` with the rejection and `op_index`. */
function writeResult(result: TransactResult): CallToolResult {
  return result.status === "rejected" ? toolError(result) : toolResult(result);
}

async function run<T extends Record<string, unknown>>(
  request: () => Promise<T>,
  map: (value: T) => CallToolResult = toolResult,
): Promise<CallToolResult> {
  try {
    return map(await request());
  } catch (e) {
    return failureResult(e);
  }
}

type Args = Record<string, unknown>;

function handlerFor(
  name: ToolName,
  client: ProtocolClient,
): (args: Args) => Promise<CallToolResult> {
  switch (name) {
    case "table_info":
      return async () =>
        toolResult({
          revision: client.revision,
          boards: client.boards,
          table: client.table,
          limits: client.limits,
          actor: client.actor,
          session: client.session,
        });
    case "transact":
      return (args) => {
        const input = args as z.infer<typeof TransactInputSchema>;
        return run(
          () =>
            transactWithRetry(client, input.ops as WireOp[], {
              base_revision: input.base_revision,
              ...(input.label === undefined ? {} : { label: input.label }),
              ...(input.expect === undefined ? {} : { expect: input.expect }),
              txn_id: globalThis.crypto.randomUUID(),
              retry: { timeoutMs: TRANSACT_RETRY_MS },
            }),
          writeResult,
        );
      };
    case "invoke":
      return invokeHandler(client);
    case "undo":
      return (args) =>
        run(() => client.request("undo", args as z.infer<typeof UndoInputSchema>), writeResult);
    default:
      return (args) => run(() => client.request(name as MethodName, args as never));
  }
}

/** Registers the 15 request tools on `server`, each through the connection gate. */
export function registerTools(server: McpServer, client: ProtocolClient): void {
  for (const tool of TOOLS) {
    const handle = handlerFor(tool.name, client);
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      withConnection(client, (args: Args) => handle(args)),
    );
  }
}
