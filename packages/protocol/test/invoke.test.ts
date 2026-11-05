/**
 * `invoke` on the wire (vtt-1xv.11; PROTOCOL.md §4, §6, §9, §10; M5-D1):
 * params and results round-trip, unknown keys and `retry` without `txn_id`
 * are refused, `explain_action`'s GM parse fields, and the client treating
 * `invoke` as a write (`isWrite`): `client.invoke` with a required
 * `base_revision` and a UUID `txn_id`, never retrying, and `uncertain` (never
 * `disconnected`) once sent.
 *
 * `actor` from an agent connection is the authority's structural check
 * (PROTOCOL §3): the wire schema cannot know the connection kind; it is
 * tested in `@vtt/authority`'s `test/protocol/invoke.test.ts`.
 */
import {
  type ExplainActionResult,
  type InvokeParams,
  InvokeParamsSchema,
  type InvokeResult,
  METHODS,
  ProtocolClient,
  type ProtocolError,
  ProtocolFailure,
  parseClientMessage,
  parseResult,
  parseServerMessage,
} from "@vtt/protocol";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { FakeServer, flush } from "./support/fake-server";

const FULL: InvokeParams = {
  object: "attack1",
  action: "Roll damage",
  base_revision: 4,
  txn_id: "t-1",
  retry: true,
  actor: { type: "character", id: "aldric" },
  label: "Aldric rolls damage",
  table: { board: "map", position: [3.5, -2] },
};

/** A client request through the server's parser. */
function serverParse(params: unknown) {
  return parseClientMessage(
    JSON.stringify({ type: "request", id: "r1", method: "invoke", params }),
  );
}

/** Runs both client stages on a success response: envelope, then `parseResult`. */
function twoStage(method: "invoke" | "explain_action", result: unknown) {
  const env = parseServerMessage(JSON.stringify({ type: "response", id: "r1", ok: true, result }));
  if (env.ok !== true) throw new Error(`envelope failed: ${JSON.stringify(env)}`);
  const message = env.message;
  if (message.type !== "response" || !message.ok) throw new Error("not a success response");
  return parseResult(method, message.result);
}

describe("InvokeParams", () => {
  test("every param round-trips through the server's parser", () => {
    const parsed = serverParse(FULL);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok && parsed.message.type === "request") {
      expect(parsed.message.params).toEqual(FULL);
    }
  });

  test("the minimal params parse", () => {
    const min = { object: "attack1", action: "Roll", base_revision: 0 };
    expect(InvokeParamsSchema.parse(min)).toEqual(min);
  });

  test.each([
    ["an unknown key", { ...FULL, extra: 1 }],
    ["an unknown key in actor", { ...FULL, actor: { type: "character", id: "a", x: 1 } }],
    ["an unknown key in table", { ...FULL, table: { board: "map", position: [0, 0], z: 1 } }],
    ["retry without txn_id", { object: "a", action: "Roll", base_revision: 0, retry: true }],
    ["retry other than true", { ...FULL, retry: false }],
    ["a GM actor", { ...FULL, actor: { type: "gm" } }],
    ["an empty txn_id", { ...FULL, txn_id: "" }],
    ["a 65-character txn_id", { ...FULL, txn_id: "x".repeat(65) }],
    ["a 201-character label", { ...FULL, label: "x".repeat(201) }],
    ["an empty action", { ...FULL, action: "" }],
    ["a negative base_revision", { ...FULL, base_revision: -1 }],
    ["a missing base_revision", { object: "a", action: "Roll" }],
    [
      "a non-finite table position",
      { ...FULL, table: { board: "map", position: [0, Number.POSITIVE_INFINITY] } },
    ],
    ["a binding as object", { ...FULL, object: "$card" }],
  ])("refuses %s (bad_request)", (_, params) => {
    expect(InvokeParamsSchema.safeParse(params).success).toBe(false);
    expect(serverParse(params)).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  test("invoke is a write method", () => {
    expect(METHODS.invoke.kind).toBe("write");
  });
});

describe("InvokeResult", () => {
  const results: [string, InvokeResult][] = [
    ["committed", { status: "committed", revision: 7, index: 6, created: ["row_1", "row_2"] }],
    ["committed with nothing created", { status: "committed", revision: 1, index: 0, created: [] }],
    [
      "rejected with a step",
      {
        status: "rejected",
        rejection: { type: "protected_cell", object: "c", cell: "contents" },
        step: 1,
      },
    ],
    [
      "rejected without a step",
      { status: "rejected", rejection: { type: "when_false", object: "c", action: "Apply" } },
    ],
    [
      "stale_write",
      {
        status: "rejected",
        rejection: {
          type: "stale_write",
          base_revision: 3,
          revision: 5,
          floor: 0,
          truncated: false,
          conflicts: [
            {
              index: 4,
              revision: 5,
              actor: { type: "gm" },
              label: "set_value goblin1.damage_taken",
              keys: ["cell:goblin1/damage_taken"],
            },
          ],
        },
      },
    ],
  ];

  test.each(results)("%s round-trips", (_, result) => {
    expect(twoStage("invoke", result)).toEqual({ ok: true, value: result, warnings: [] });
  });

  test("unknown result keys are stripped (forward compatible)", () => {
    const r = twoStage("invoke", {
      status: "committed",
      revision: 2,
      index: 1,
      created: [],
      future: true,
    });
    expect(r).toMatchObject({
      ok: true,
      value: { status: "committed", revision: 2, index: 1, created: [] },
    });
    if (r.ok) expect(r.value).not.toHaveProperty("future");
  });

  test.each([
    ["created holding a binding", { status: "committed", revision: 1, index: 0, created: ["$a"] }],
    ["a missing created", { status: "committed", revision: 1, index: 0 }],
    ["a negative step", { status: "rejected", rejection: { type: "nothing_to_undo" }, step: -1 }],
    ["an unknown status", { status: "maybe" }],
  ])("refuses %s", (_, result) => {
    expect(twoStage("invoke", result)).toMatchObject({
      ok: false,
      error: { code: "internal", details: { type: "protocol", method: "invoke" } },
    });
  });
});

describe("ExplainActionResult parse fields (GM only)", () => {
  test("when_parses, when_syntax_error and step_status round-trip", () => {
    const result: ExplainActionResult = {
      object: "card",
      action: "Go",
      enabled: false,
      reason: "when_error",
      guard: { source: "1 +", value: { type: "error", code: "#SYNTAX" } },
      steps: ["set(a, 1)", "set(1, 2)"],
      when_parses: false,
      when_syntax_error: "unexpected end of input",
      step_status: [{ ok: true }, { ok: false, message: "bad path", offset: 4 }],
    };
    expect(twoStage("explain_action", result)).toEqual({ ok: true, value: result, warnings: [] });
  });

  test("a character result without them still parses", () => {
    const result = { object: "card", action: "Go", enabled: true };
    expect(twoStage("explain_action", result)).toEqual({ ok: true, value: result, warnings: [] });
  });

  test("a malformed step_status entry fails the result", () => {
    const bad = { object: "card", action: "Go", enabled: true, step_status: [{ ok: false }] };
    expect(twoStage("explain_action", bad)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// The client

function setup() {
  vi.useFakeTimers();
  const server = new FakeServer();
  const client = new ProtocolClient({
    url: "ws://127.0.0.1:4747/ws",
    token: "tok",
    client: { name: "tester", kind: "test" },
    instance: "inst-1",
    WebSocket: server.WebSocket,
    onWarning: () => {},
    requestTimeoutMs: 1000,
  });
  return { server, client };
}

async function failure(promise: Promise<unknown>): Promise<ProtocolFailure> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolFailure);
    return e as ProtocolFailure;
  }
  throw new Error("expected a rejection");
}

function track<T>(promise: Promise<T>) {
  const out: { value?: T; error?: ProtocolError; settled: boolean } = { settled: false };
  promise.then(
    (value) => {
      out.value = value;
      out.settled = true;
    },
    (e: unknown) => {
      out.error = e instanceof ProtocolFailure ? e.error : { code: "internal", message: String(e) };
      out.settled = true;
    },
  );
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("client.invoke", () => {
  test("requires base_revision; txn_id defaults to a UUID; label, actor and table pass through", async () => {
    expectTypeOf<
      Parameters<ProtocolClient["invoke"]>[0]["base_revision"]
    >().toEqualTypeOf<number>();
    const { server, client } = setup();
    await client.connect();
    const committed = { status: "committed", revision: 5, index: 4, created: [] };
    server.handle("invoke", () => ({ result: committed }));
    const result = await client.invoke({
      object: "attack1",
      action: "Roll",
      base_revision: 4,
      label: "zap",
      actor: { type: "character", id: "aldric" },
      table: { board: "map", position: [1, 2] },
    });
    expect(result).toEqual(committed);
    const req = server.peer.lastRequest("invoke");
    expect(req.params).toMatchObject({
      object: "attack1",
      action: "Roll",
      base_revision: 4,
      label: "zap",
      actor: { type: "character", id: "aldric" },
      table: { board: "map", position: [1, 2] },
    });
    expect(req.params.txn_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.params).not.toHaveProperty("retry");
  });

  test("an explicit txn_id is kept", async () => {
    const { server, client } = setup();
    await client.connect();
    server.handle("invoke", () => ({
      result: { status: "committed", revision: 1, index: 0, created: [] },
    }));
    await client.invoke({ object: "a", action: "Roll", base_revision: 0, txn_id: "mine" });
    expect(server.peer.lastRequest("invoke").params.txn_id).toBe("mine");
  });

  test("a socket drop after the send rejects uncertain with sent: true and never resends", async () => {
    const { server, client } = setup();
    await client.connect();
    server.handle("invoke", () => undefined);
    const write = track(
      client.invoke({ object: "a", action: "Roll", base_revision: 0, txn_id: "t1" }),
    );
    await flush();
    server.peer.drop();
    await flush();
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { sent: true, reason: "socket_closed", txn_id: "t1" },
    });
    expect(write.error?.code).not.toBe("disconnected");
    expect(server.requests("invoke")).toHaveLength(1);
  });

  test("no response in time rejects uncertain timeout, not timeout", async () => {
    const { server, client } = setup();
    await client.connect();
    server.handle("invoke", () => undefined);
    const write = track(
      client.invoke({ object: "a", action: "Roll", base_revision: 0, txn_id: "t1" }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { sent: true, reason: "timeout", txn_id: "t1" },
    });
  });

  test("an invoke never sent rejects disconnected with sent: false", async () => {
    const { server, client } = setup();
    const e = await failure(client.invoke({ object: "a", action: "Roll", base_revision: 0 }));
    expect(e.error).toMatchObject({ code: "disconnected", details: { sent: false } });
    expect(e.local).toBe(true);
    expect(server.requests("invoke")).toHaveLength(0);
  });
});
