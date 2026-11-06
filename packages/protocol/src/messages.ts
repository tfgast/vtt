/**
 * Messages (PROTOCOL.md §1, §2, §4, §8, §10, §12): the envelopes, protocol
 * errors, and the three parse functions. Client messages are parsed strictly;
 * server messages forward-compatibly, in two stages: `parseServerMessage`
 * validates the envelope, `parseResult` a response's result against the
 * pending request's method. None of the parse functions throws.
 */
import { z } from "zod";
import { isMethodName, METHODS, type MethodName, type Params, type Result } from "./methods";
import { looseNoProto, looseObject, ObjectIdSchema } from "./values";
import { LIMITS, PROTOCOL_VERSION } from "./version";
import {
  BoardViewSchema,
  CoverSchema,
  dropUnknownEffects,
  GroupHeaderSchema,
  GroupViewSchema,
  ObjectPatchSchema,
  ObjectViewSchema,
  WireActorSchema,
} from "./views";

const Count = z.int().nonnegative();

// ---------------------------------------------------------------------------
// Errors (§10)

export const PROTOCOL_ERROR_CODES = [
  "bad_request",
  "unknown_method",
  "unauthorized",
  "protocol_version",
  "busy",
  "too_large",
  "not_found",
  "unsupported",
  "internal",
  "disconnected",
  "timeout",
  "uncertain",
  "wrong_table",
  "retry_unknown",
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export type ProtocolError = { code: ProtocolErrorCode; message: string; details?: unknown };

export const ProtocolErrorSchema = looseObject({
  code: z.enum(PROTOCOL_ERROR_CODES),
  message: z.string(),
  details: z.unknown().optional(),
});

/**
 * A protocol failure, thrown by authority handlers and turned into an error
 * response by the router; the client rejects requests with it.
 */
export class ProtocolFailure extends Error {
  readonly error: ProtocolError;
  /**
   * True for a failure the client library synthesized itself (a request never
   * sent or not answered in time, a lost socket, a malformed or
   * protocol-violating response); false for an error response passed on from
   * the server and for failures thrown by authority handlers.
   */
  readonly local: boolean;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    details?: unknown,
    options: { local?: boolean } = {},
  ) {
    super(message);
    this.name = "ProtocolFailure";
    this.error = details === undefined ? { code, message } : { code, message, details };
    this.local = options.local ?? false;
  }
}

// ---------------------------------------------------------------------------
// Client to server (strict)

export const HelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  token: z.string(),
  client: z.strictObject({
    name: z.string().min(1).max(100),
    kind: z.enum(["ui", "agent", "test"]),
    /** Chosen by the client and reused across its reconnects (§2). */
    instance: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  }),
  agent_name: z.string().min(1).max(100).optional(),
  /**
   * Optional capabilities the client supports (vtt-qf5.4); unknown names
   * are ignored by the authority. See `CAPABILITIES`.
   */
  capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

const RequestId = z.string().min(1).max(64);

/** A request for method `M` (or, by default, for any method). */
export type RequestMessage<M extends MethodName = MethodName> = {
  [K in M]: { type: "request"; id: string; method: K; params: Params<K> };
}[M];

const requestSchemas = new Map<MethodName, z.ZodType>(
  (Object.keys(METHODS) as MethodName[]).map((method) => [
    method,
    z.strictObject({
      type: z.literal("request"),
      id: RequestId,
      method: z.literal(method),
      params: METHODS[method].params,
    }),
  ]),
);

/** Every request, discriminated on `method`. */
export const RequestSchema = z.discriminatedUnion("method", [
  ...requestSchemas.values(),
] as unknown as [
  z.ZodObject<{ method: z.ZodLiteral<MethodName> }>,
  ...z.ZodObject<{ method: z.ZodLiteral<MethodName> }>[],
]) as unknown as z.ZodType<RequestMessage>;

export type ClientMessage = Hello | RequestMessage;

// ---------------------------------------------------------------------------
// Server to client (loose)

const LimitsSchema = looseObject({
  max_message_bytes: z.literal(LIMITS.max_message_bytes),
  max_ops: z.literal(LIMITS.max_ops),
  max_page: z.literal(LIMITS.max_page),
  max_ids: z.literal(LIMITS.max_ids),
  max_subscriptions: z.literal(LIMITS.max_subscriptions),
  max_explain_depth: z.literal(LIMITS.max_explain_depth),
  max_explain_nodes: z.literal(LIMITS.max_explain_nodes),
  max_source_length: z.literal(LIMITS.max_source_length),
  max_groups: z.literal(LIMITS.max_groups),
  max_log_window: z.literal(LIMITS.max_log_window),
  max_txn_ids_per_client: z.literal(LIMITS.max_txn_ids_per_client),
  max_requests_per_second: z.literal(LIMITS.max_requests_per_second),
  max_buffered_bytes: z.literal(LIMITS.max_buffered_bytes),
  max_each_items: z.literal(LIMITS.max_each_items),
  max_action_writes: z.literal(LIMITS.max_action_writes),
  max_face_elements: z.literal(LIMITS.max_face_elements),
});

export const WelcomeSchema = looseObject({
  type: z.literal("welcome"),
  protocol: z.literal(PROTOCOL_VERSION),
  /** The authority process run; different after every restart. */
  session: z.string(),
  actor: WireActorSchema,
  revision: Count,
  boards: z.array(BoardViewSchema),
  /** `path` and `id` are null for an in-memory table. */
  table: looseObject({ name: z.string(), path: z.string().nullable(), id: z.string().nullable() }),
  limits: LimitsSchema,
  /** The accepted `hello.capabilities` (vtt-qf5.4); present only when the hello had some. */
  capabilities: z.array(z.string()).optional(),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

export const GoodbyeSchema = looseObject({ type: z.literal("goodbye"), reason: z.string() });
export type Goodbye = z.infer<typeof GoodbyeSchema>;

/** A success response's envelope; its `result` is validated by `parseResult`. */
export type SuccessResponse<R = unknown> = { type: "response"; id: string; ok: true; result: R };
/** `id` is null when the request id could not be read. */
export type ErrorResponse = {
  type: "response";
  id: string | null;
  ok: false;
  error: ProtocolError;
};
export type ResponseMessage = SuccessResponse | ErrorResponse;

export const ResponseSchema = looseNoProto(
  z.discriminatedUnion("ok", [
    z.object({
      type: z.literal("response"),
      id: z.string(),
      ok: z.literal(true),
      result: z.unknown(),
    }),
    z.object({
      type: z.literal("response"),
      id: z.string().nullable(),
      ok: z.literal(false),
      error: ProtocolErrorSchema,
    }),
  ]),
);

export const SubscriptionDeltaSchema = looseObject({
  subscription: z.string(),
  objects: z.array(ObjectViewSchema),
  removed: z.array(ObjectIdSchema),
  covers: looseObject({ upsert: z.array(CoverSchema), removed: z.array(z.string()) }).optional(),
  groups_upserted: z.array(GroupViewSchema).optional(),
  groups_removed: z.array(Count).optional(),
  /** Cell-level patches (vtt-qf5.4); only with the `cell_patches` capability. */
  patches: z.array(ObjectPatchSchema).optional(),
});
export type SubscriptionDelta = z.infer<typeof SubscriptionDeltaSchema>;

const CommitEventObject = z.object({
  type: z.literal("event"),
  event: z.literal("commit"),
  revision: Count,
  group: GroupHeaderSchema,
  /** All boards; present when the group has a `board` effect. */
  boards: z.array(BoardViewSchema).optional(),
  deltas: z.array(SubscriptionDeltaSchema),
});
export const CommitEventSchema = looseNoProto(CommitEventObject);
export type CommitEvent = z.infer<typeof CommitEventSchema>;

const SaveEventObject = z.object({
  type: z.literal("event"),
  event: z.literal("save"),
  status: z.enum(["saved", "saved_not_durable", "failed"]),
  revision: Count,
  message: z.string().optional(),
  /**
   * The retained log's new `first_index` when this save's compaction dropped
   * groups (M6-D33, vtt-qf5.71); absent otherwise.
   */
  first_index: Count.optional(),
  /**
   * With `first_index`: this connection's `log` subscription deltas
   * (`groups_removed` only), as in a commit event; the revision is unchanged.
   */
  deltas: z.array(SubscriptionDeltaSchema).optional(),
});
export const SaveEventSchema = looseNoProto(SaveEventObject);
export type SaveEvent = z.infer<typeof SaveEventSchema>;

export const EventSchema = looseNoProto(
  z.discriminatedUnion("event", [CommitEventObject, SaveEventObject]),
);
export type EventMessage = CommitEvent | SaveEvent;

export type ServerMessage = Welcome | ResponseMessage | EventMessage | Goodbye;

// ---------------------------------------------------------------------------
// Parsing

export type ParseClientMessageResult =
  | { ok: true; message: ClientMessage }
  /** `id` is the request's id when it could be read, for the error response. */
  | { ok: false; error: ProtocolError; id: string | null };

export type ParseServerMessageResult =
  | { ok: true; message: ServerMessage; warnings: string[] }
  | { ok: false; error: ProtocolError }
  | { ok: "ignored"; reason: string };

export type ParseResultResult<M extends MethodName> =
  | { ok: true; value: Result<M>; warnings: string[] }
  | { ok: false; error: ProtocolError };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The path of the first own `__proto__` key anywhere in a JSON value, or
 * null. zod's records drop such keys silently and its loose objects strip
 * them, so they are looked for before any schema runs (FIXTURES.md §1).
 */
export function findProtoKey(value: unknown): (string | number)[] | null {
  const stack: { value: unknown; path: (string | number)[] }[] = [{ value, path: [] }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const v = item.value;
    if (Array.isArray(v)) {
      v.forEach((child, i) => {
        stack.push({ value: child, path: [...item.path, i] });
      });
    } else if (typeof v === "object" && v !== null) {
      if (Object.hasOwn(v, "__proto__")) return [...item.path, "__proto__"];
      for (const [key, child] of Object.entries(v)) {
        stack.push({ value: child, path: [...item.path, key] });
      }
    }
  }
  return null;
}

const protoMessage = (path: (string | number)[]) =>
  `"__proto__" is not allowed as a key (at ${path.join(".")})`;

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const describe = (error: z.ZodError) => z.prettifyError(error);

function clientFail(
  code: ProtocolErrorCode,
  message: string,
  id: string | null,
): ParseClientMessageResult {
  return { ok: false, error: { code, message }, id };
}

/**
 * Parses a client-to-server frame strictly (§12): unknown keys anywhere and
 * `__proto__` keys are `bad_request`; an unknown method is `unknown_method`;
 * a `hello` with another protocol is `protocol_version`.
 */
export function parseClientMessage(text: string): ParseClientMessageResult {
  let id: string | null = null;
  try {
    const json = parseJson(text);
    if (!json.ok) return clientFail("bad_request", json.message, null);
    const raw = json.value;
    if (!isRecord(raw)) return clientFail("bad_request", "a message must be an object", null);
    if (raw.type === "request" && RequestId.safeParse(raw.id).success) id = raw.id as string;
    const proto = findProtoKey(raw);
    if (proto) return clientFail("bad_request", protoMessage(proto), id);

    if (raw.type === "hello") {
      if (Object.hasOwn(raw, "protocol") && raw.protocol !== PROTOCOL_VERSION) {
        return clientFail(
          "protocol_version",
          `unsupported protocol ${JSON.stringify(raw.protocol)}; this is protocol ${PROTOCOL_VERSION}`,
          null,
        );
      }
      const parsed = HelloSchema.safeParse(raw);
      if (!parsed.success) return clientFail("bad_request", describe(parsed.error), null);
      return { ok: true, message: parsed.data };
    }

    if (raw.type === "request") {
      if (typeof raw.method !== "string") {
        return clientFail("bad_request", "a request needs a string method", id);
      }
      if (!isMethodName(raw.method)) {
        return clientFail("unknown_method", `unknown method ${JSON.stringify(raw.method)}`, id);
      }
      const schema = requestSchemas.get(raw.method) as z.ZodType<RequestMessage>;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return clientFail("bad_request", describe(parsed.error), id);
      return { ok: true, message: parsed.data };
    }

    return clientFail("bad_request", `unknown client message type ${JSON.stringify(raw.type)}`, id);
  } catch (e) {
    return clientFail("bad_request", `unparseable message: ${String(e)}`, id);
  }
}

const serverFail = (message: string): ParseServerMessageResult => ({
  ok: false,
  error: { code: "internal", message, details: { type: "protocol" } },
});

/** A commit event with unknown effect variants dropped from its log deltas. */
function dropUnknownEventEffects(
  raw: Record<string, unknown>,
  warnings: string[],
): Record<string, unknown> {
  if (!Array.isArray(raw.deltas)) return raw;
  const deltas = raw.deltas.map((delta) =>
    isRecord(delta) && Array.isArray(delta.groups_upserted)
      ? {
          ...delta,
          groups_upserted: delta.groups_upserted.map((g) => dropUnknownEffects(g, warnings)),
        }
      : delta,
  );
  return { ...raw, deltas };
}

/**
 * Parses a server-to-client frame forward-compatibly (§12). It validates and
 * normalizes `welcome`, `goodbye` and events fully, and a `response` as an
 * envelope only: its `result` is returned untouched, for `parseResult`.
 * Unknown keys are stripped; a message of unknown `type` or an event of
 * unknown `event` kind is `ignored`; an unknown `EffectView` variant in a
 * commit event's group views is dropped with a warning. A known envelope
 * missing a required field is an error (`internal`, `details.type:
 * "protocol"`).
 */
export function parseServerMessage(text: string): ParseServerMessageResult {
  try {
    const json = parseJson(text);
    if (!json.ok) return serverFail(json.message);
    const raw = json.value;
    if (!isRecord(raw)) return serverFail("a message must be an object");
    if (typeof raw.type !== "string") return serverFail("a message needs a string type");
    const proto = findProtoKey(raw);
    if (proto) return serverFail(protoMessage(proto));

    const warnings: string[] = [];
    let schema: z.ZodType<ServerMessage>;
    let input: unknown = raw;
    switch (raw.type) {
      case "welcome":
        schema = WelcomeSchema;
        break;
      case "goodbye":
        schema = GoodbyeSchema;
        break;
      case "response":
        if (raw.ok === true && !Object.hasOwn(raw, "result")) {
          return serverFail("a success response needs a result");
        }
        schema = ResponseSchema;
        break;
      case "event":
        if (typeof raw.event !== "string") return serverFail("an event needs a string event kind");
        if (raw.event === "commit") {
          input = dropUnknownEventEffects(raw, warnings);
        } else if (raw.event !== "save") {
          return { ok: "ignored", reason: `unknown event kind ${JSON.stringify(raw.event)}` };
        }
        schema = EventSchema;
        break;
      default:
        return { ok: "ignored", reason: `unknown message type ${JSON.stringify(raw.type)}` };
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) return serverFail(`malformed ${raw.type}: ${describe(parsed.error)}`);
    return { ok: true, message: parsed.data, warnings };
  } catch (e) {
    return serverFail(`unparseable message: ${String(e)}`);
  }
}

/** A result with unknown effect variants dropped from its group views. */
function dropUnknownResultEffects(method: MethodName, raw: unknown, warnings: string[]): unknown {
  if (!isRecord(raw)) return raw;
  switch (method) {
    case "changes_since":
    case "log":
    case "subscribe":
      return Array.isArray(raw.groups)
        ? { ...raw, groups: raw.groups.map((g) => dropUnknownEffects(g, warnings)) }
        : raw;
    case "explain_group":
      return { ...raw, group: dropUnknownEffects(raw.group, warnings) };
    default:
      return raw;
  }
}

/**
 * The second stage (§10, §12): validates and normalizes a success result
 * against `METHODS[method]`'s loose result schema, stripping unknown keys in
 * the result and its nested views and effects, and dropping unknown
 * `EffectView` variants with a warning. A failure is `internal` with
 * `details: {type: "protocol", method}`.
 */
export function parseResult<M extends MethodName>(
  method: M,
  result: unknown,
): ParseResultResult<M> {
  const fail = (message: string): ParseResultResult<M> => ({
    ok: false,
    error: { code: "internal", message, details: { type: "protocol", method } },
  });
  try {
    if (!isMethodName(method)) return fail(`unknown method ${JSON.stringify(method)}`);
    const proto = findProtoKey(result);
    if (proto) return fail(protoMessage(proto));
    const warnings: string[] = [];
    const input = dropUnknownResultEffects(method, result, warnings);
    const schema = METHODS[method].result as z.ZodType;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return fail(`malformed ${method} result: ${describe(parsed.error)}`);
    }
    return { ok: true, value: parsed.data as Result<M>, warnings };
  } catch (e) {
    return fail(`unparseable ${String(method)} result: ${String(e)}`);
  }
}
