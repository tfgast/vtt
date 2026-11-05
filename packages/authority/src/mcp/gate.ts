/**
 * The MCP connection gate and result mapping (PROTOCOL.md §11): every tool
 * handler is wrapped in `withConnection`, which answers the client's
 * connection error instead of running the handler; results are
 * `structuredContent` plus one JSON text block; a `ProtocolError` and a
 * rejected write are `isError: true`. vtt-5su.15's subscription tools use
 * the same functions.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type ProtocolClient, type ProtocolError, ProtocolFailure } from "@vtt/protocol";

/** A successful tool result: `value` as `structuredContent` plus one JSON text block. */
export function toolResult(value: Record<string, unknown>): CallToolResult {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** An `isError` tool result carrying `value` the same way. */
export function toolError(value: Record<string, unknown>): CallToolResult {
  return { ...toolResult(value), isError: true };
}

/** `{code, message, details?}` of a `ProtocolError` as an `isError` result. */
export function protocolErrorResult(error: ProtocolError): CallToolResult {
  const value: Record<string, unknown> = { code: error.code, message: error.message };
  if (error.details !== undefined) value.details = error.details;
  return toolError(value);
}

/**
 * The `isError` result for anything a handler's request threw: a
 * `ProtocolFailure`'s error, else `internal` with the thrown value's text.
 */
export function failureResult(e: unknown): CallToolResult {
  if (e instanceof ProtocolFailure) return protocolErrorResult(e.error);
  return protocolErrorResult({
    code: "internal",
    message: e instanceof Error ? e.message : String(e),
  });
}

/**
 * Wraps a tool handler in the connection gate (PROTOCOL.md §11): while
 * `client.connectionError()` is non-null (`disconnected`, also while
 * `recovering` and before the first `welcome`; `unauthorized`;
 * `wrong_table`), the wrapper returns `isError: true` with `{code, message}`
 * of that error and does not call `handler`; otherwise it calls `handler`.
 */
export function withConnection<A extends unknown[]>(
  client: ProtocolClient,
  handler: (...args: A) => CallToolResult | Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    const error = client.connectionError();
    if (error !== null) return toolError({ code: error.code, message: error.message });
    return handler(...args);
  };
}
