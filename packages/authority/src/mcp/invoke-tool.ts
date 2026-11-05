/**
 * The MCP tool `invoke` (PROTOCOL.md §4, §6, §11; DESIGN.md §5.2 "define and
 * invoke actions"; D19, M3-D19: the tool arrives with the UI's buttons):
 * `{object, action, base_revision, label?, table?}` → protocol `invoke`
 * through `invokeWithRetry` with a `txn_id` the MCP server generates, and a
 * lost response retried within {@link INVOKE_RETRY_MS} as for `transact`.
 * A committed result is the normal result; a rejection is `isError: true`
 * with the rejection and `step`; `uncertain` and every other
 * `ProtocolError` are `isError: true` with `{code, message}`. The request
 * tools table (`tools.ts`) lists it after `transact` and registers it
 * through the connection gate like the others.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  InvokeParamsSchema,
  type InvokeResult,
  invokeWithRetry,
  type ProtocolClient,
} from "@vtt/protocol";
import { z } from "zod";
import { failureResult, toolError, toolResult } from "./gate";
import type { ToolSpec } from "./tools";

/** How long an `invoke` whose socket dropped after the send waits to resend (PROTOCOL.md §6, §11; as `transact`). */
export const INVOKE_RETRY_MS = 10_000;

/**
 * `invoke` without `actor`, `retry` and `txn_id` (PROTOCOL.md §11): strict,
 * built from the params' shape (zod refuses `omit` on the refined params
 * schema; the refinement only relates the omitted `retry` and `txn_id`).
 */
export const InvokeInputSchema = z.strictObject(InvokeParamsSchema.shape).omit({
  actor: true,
  retry: true,
  txn_id: true,
});

export type InvokeToolInput = z.infer<typeof InvokeInputSchema>;

export const INVOKE_DESCRIPTION =
  "Runs an object's named action (its button) as one undoable group, exactly as a player pressing it would: the action's `when` guard is checked now, then its steps run in order (docs/FORMULAS.md §8, resource vtt://docs/formulas). Actions are defined with transact `set_actions` (get_objects shows an object's actions; explain_action whether one is enabled now). `base_revision` is the latest `revision` you read (table_info, any result, or poll_changes); a group committed after it that touched the same things rejects the call `stale_write`. `table` is the board and point you want the `table` destination (e.g. `spawn(x, table)`) to mean, as a player's board and viewport centre would; without it a step using `table` is refused. `label` names the log group (default: the action's name). A refusal (`when_false`, `when_error`, `step_error`, ...) returns isError with the rejection and the refusing `step`, and changes nothing. A lost response is retried automatically; if the outcome cannot be known it returns isError `uncertain`: check with changes_since before invoking again.";

/** The tool's entry in the request tools table (PROTOCOL.md §11). */
export const INVOKE_TOOL: ToolSpec = Object.freeze({
  name: "invoke",
  description: INVOKE_DESCRIPTION,
  input: InvokeInputSchema,
});

/** A committed invoke is the normal result; a rejection is `isError` with the rejection and `step`. */
function invokeResult(result: InvokeResult): CallToolResult {
  return result.status === "rejected" ? toolError(result) : toolResult(result);
}

/** The tool's handler over `client` (the connection gate is applied by the caller). */
export function invokeHandler(
  client: ProtocolClient,
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    const input = args as InvokeToolInput;
    try {
      const result = await invokeWithRetry(
        client,
        {
          object: input.object,
          action: input.action,
          base_revision: input.base_revision,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.table === undefined ? {} : { table: input.table }),
          txn_id: globalThis.crypto.randomUUID(),
        },
        { retry: { timeoutMs: INVOKE_RETRY_MS } },
      );
      return invokeResult(result);
    } catch (e) {
      return failureResult(e);
    }
  };
}
