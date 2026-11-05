/**
 * The MCP subscription tools (PROTOCOL.md §8, §11; DESIGN.md §5.2 Subscribe;
 * vtt-5su.15): `subscribe`, `poll_changes` and `unsubscribe`, registered
 * through the connection gate, and the resource `vtt://subscriptions/<handle>`.
 * A handle (`"m"` + counter, owned by this server) maps to a client
 * `Subscription` and its `ChangeBuffer`; it stays valid across reconnects
 * while the protocol subscription id behind it changes, and after the
 * subscription fails, until `unsubscribe`. Added to `createMcpServer` as an
 * extension: `createMcpServer({client, extensions: [subscriptionTools()]})`.
 */
import {
  type CallToolResult,
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import {
  type ProtocolClient,
  SubscribeParamsSchema,
  type Subscription,
  ViewerSchema,
} from "@vtt/protocol";
import { z } from "zod";
import { ChangeBuffer, feedChanges } from "./changes";
import { failureResult, toolError, toolResult, withConnection } from "./gate";
import type { McpExtension } from "./server";

export {
  type CellChange,
  CHANGE_BUFFER_LIMIT,
  ChangeBuffer,
  type ChangeRecord,
  type CommitRecord,
  commitRecord,
  type FailedRecord,
  feedChanges,
  type ObjectChange,
  type ObjectFacts,
  objectFacts,
  type ResyncRecord,
  type SubscriptionFailure,
} from "./changes";

/** The longest `poll_changes` wait (PROTOCOL.md §11). */
export const MAX_POLL_WAIT_MS = 30_000;

/** The URI template of a handle's resource. */
export const SUBSCRIPTION_RESOURCE_TEMPLATE = "vtt://subscriptions/{handle}";

/** The resource URI of `handle`. */
export const subscriptionUri = (handle: string) => `vtt://subscriptions/${handle}`;

// ---------------------------------------------------------------------------
// Input schemas (PROTOCOL.md §11): strict; subscribe narrowed to the scopes
// `board`, `objects`, `all` and the GM viewer.

const [BoardScope, ObjectsScope, AllScope] = SubscribeParamsSchema.shape.scope.options;
const [GmViewer] = ViewerSchema.options;

export const SubscribeInputSchema = z.strictObject({
  scope: z.discriminatedUnion("type", [BoardScope, ObjectsScope, AllScope]),
  viewer: GmViewer.optional(),
  cells: SubscribeParamsSchema.shape.cells,
});
export const PollChangesInputSchema = z.strictObject({
  subscription: z.string(),
  wait_ms: z.number().int().min(0).max(MAX_POLL_WAIT_MS).optional(),
});
export const UnsubscribeInputSchema = z.strictObject({ subscription: z.string() });

export const SUBSCRIPTION_TOOL_DESCRIPTIONS = {
  subscribe:
    "Subscribes to changes of a board (`board`), of objects by id (`objects`, with `subtree` for their contents) or of the whole table (`all`), as the GM sees them. Returns a handle (`subscription`), the current `revision` and the number of objects in scope. Poll the handle with poll_changes, or read the resource vtt://subscriptions/<handle> for the current objects. The handle stays valid across reconnects until unsubscribe.",
  poll_changes:
    "Returns and clears the change records buffered for a subscription handle, waiting up to `wait_ms` (0..30000, default 0) for the first. Records: `commit` (created and removed ids, every changed cell with before/after, every object whose flags, actions or face changed), `resync` (the connection was re-established; `session_changed` means the authority restarted, so re-read what you rely on), `failed` (the subscription ended, e.g. its board was removed). `revision` is the subscription's current revision, usable as a write's `base_revision`. `overflowed: true` means older records were dropped: read vtt://subscriptions/<handle> for the current state.",
  unsubscribe: "Ends a subscription and forgets its handle.",
} as const;

// ---------------------------------------------------------------------------

type Entry = {
  readonly sub: Subscription;
  readonly buffer: ChangeBuffer;
  readonly off: () => void;
};

const notFound = (handle: string) =>
  toolError({ code: "not_found", message: `no subscription handle ${handle}` });

/**
 * The subscription extension (PROTOCOL.md §11). Each server it extends gets
 * its own handles. Every buffered record sends
 * `notifications/resources/updated` for the handle's resource.
 */
export function subscriptionTools(): McpExtension {
  return (server: McpServer, client: ProtocolClient) => {
    const handles = new Map<string, Entry>();
    let counter = 0;

    const notify = (handle: string) => {
      if (!server.isConnected()) return;
      server.server.sendResourceUpdated({ uri: subscriptionUri(handle) }).catch(() => undefined);
    };

    /** Pending `poll_changes` waits by handle; `unsubscribe` releases them. */
    const waiters = new Map<string, Set<() => void>>();

    /**
     * Waits until the handle has a record while the client reports no
     * connection error, or the handle is gone, or `ms` passed.
     */
    const waitForRecord = (handle: string, entry: Entry, ms: number) =>
      new Promise<void>((resolve) => {
        const done = () =>
          !handles.has(handle) || (entry.buffer.size > 0 && client.connectionError() === null);
        if (done()) {
          resolve();
          return;
        }
        const check = () => {
          if (done()) finish();
        };
        const offs = [entry.buffer.onPush(check), client.on("state", check)];
        const timer = setTimeout(finish, ms);
        const set = waiters.get(handle) ?? new Set();
        set.add(finish);
        waiters.set(handle, set);
        function finish() {
          clearTimeout(timer);
          for (const off of offs) off();
          set.delete(finish);
          if (set.size === 0) waiters.delete(handle);
          resolve();
        }
      });

    const subscribe = async (
      args: z.infer<typeof SubscribeInputSchema>,
    ): Promise<CallToolResult> => {
      let sub: Subscription;
      try {
        sub = await client.subscribe(args);
      } catch (e) {
        return failureResult(e);
      }
      counter++;
      const handle = `m${counter}`;
      const buffer = new ChangeBuffer();
      const offFeed = feedChanges(sub, buffer);
      const offNotify = buffer.onPush(() => notify(handle));
      handles.set(handle, {
        sub,
        buffer,
        off: () => {
          offFeed();
          offNotify();
        },
      });
      return toolResult({
        subscription: handle,
        revision: sub.mirror.revision,
        objects: sub.mirror.objects.size,
      });
    };

    const poll = async (args: z.infer<typeof PollChangesInputSchema>): Promise<CallToolResult> => {
      const handle = args.subscription;
      const entry = handles.get(handle);
      if (entry === undefined) return notFound(handle);
      const waitMs = args.wait_ms ?? 0;
      const ended = entry.sub.state === "failed" || entry.sub.state === "closed";
      if (waitMs > 0 && !ended) await waitForRecord(handle, entry, waitMs);
      const error = client.connectionError();
      if (error !== null) return toolError({ code: error.code, message: error.message });
      if (!handles.has(handle)) return notFound(handle);
      const { changes, overflowed } = entry.buffer.take();
      return toolResult({
        subscription: handle,
        revision: entry.sub.mirror.revision,
        changes,
        overflowed,
      });
    };

    const unsubscribe = async (
      args: z.infer<typeof UnsubscribeInputSchema>,
    ): Promise<CallToolResult> => {
      const handle = args.subscription;
      const entry = handles.get(handle);
      if (entry === undefined) return notFound(handle);
      handles.delete(handle);
      entry.off();
      for (const finish of [...(waiters.get(handle) ?? [])]) finish();
      try {
        await entry.sub.close();
      } catch (e) {
        return failureResult(e);
      }
      return toolResult({ subscription: handle });
    };

    server.registerTool(
      "subscribe",
      { description: SUBSCRIPTION_TOOL_DESCRIPTIONS.subscribe, inputSchema: SubscribeInputSchema },
      withConnection(client, subscribe),
    );
    server.registerTool(
      "poll_changes",
      {
        description: SUBSCRIPTION_TOOL_DESCRIPTIONS.poll_changes,
        inputSchema: PollChangesInputSchema,
      },
      withConnection(client, poll),
    );
    server.registerTool(
      "unsubscribe",
      {
        description: SUBSCRIPTION_TOOL_DESCRIPTIONS.unsubscribe,
        inputSchema: UnsubscribeInputSchema,
      },
      withConnection(client, unsubscribe),
    );

    server.registerResource(
      "subscription",
      new ResourceTemplate(SUBSCRIPTION_RESOURCE_TEMPLATE, {
        list: async () => ({
          resources: [...handles.keys()].map((handle) => ({
            uri: subscriptionUri(handle),
            name: `subscription ${handle}`,
            mimeType: "application/json",
          })),
        }),
      }),
      {
        title: "Subscription",
        description:
          "A subscription handle's state: its revision, whether records overflowed, whether it failed, the current objects in scope, and the buffered change records (read without clearing).",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const raw = variables.handle;
        const handle = Array.isArray(raw) ? raw.join("/") : String(raw);
        const entry = handles.get(handle);
        if (entry === undefined) throw new Error(`no subscription handle ${handle}`);
        const value = {
          subscription: handle,
          revision: entry.sub.mirror.revision,
          overflowed: entry.buffer.overflowed,
          failed: entry.buffer.failed,
          objects: [...entry.sub.mirror.objects.values()],
          changes: entry.buffer.records(),
        };
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }],
        };
      },
    );
  };
}
