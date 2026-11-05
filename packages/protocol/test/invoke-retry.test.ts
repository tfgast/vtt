/**
 * `invokeWithRetry` (vtt-1xv.11; PROTOCOL.md §6 client retries; M5-D1): the
 * same single same-session resend with `retry: true` and the same
 * `uncertain` reasons as `transactWithRetry`, against a scripted server.
 */
import {
  enableRecovery,
  type InvokeResult,
  invokeWithRetry,
  ProtocolClient,
  type ProtocolError,
  ProtocolFailure,
} from "@vtt/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeServer, flush, type ReceivedRequest } from "./support/fake-server";

const COMMITTED: InvokeResult = { status: "committed", revision: 5, index: 4, created: ["row_1"] };
const PARAMS = { object: "attack1", action: "Roll", base_revision: 4 } as const;

async function connected() {
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
  await client.connect();
  enableRecovery(client);
  return { server, client };
}

function track<T>(promise: Promise<T>) {
  const out: { value?: T; error?: ProtocolError; local?: boolean; settled: boolean } = {
    settled: false,
  };
  promise.then(
    (value) => {
      out.value = value;
      out.settled = true;
    },
    (e: unknown) => {
      out.error = e instanceof ProtocolFailure ? e.error : { code: "internal", message: String(e) };
      if (e instanceof ProtocolFailure) out.local = e.local;
      out.settled = true;
    },
  );
  return out;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const invokes = (server: FakeServer) => server.requests("invoke");

/** Leaves first sends unanswered and answers resends with `resend`. */
function script(server: FakeServer, resend: (req: ReceivedRequest) => object | undefined) {
  server.handle("invoke", (req) =>
    req.params.retry === true ? (resend(req) as never) : undefined,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("invokeWithRetry", () => {
  test("committed outright: one send with a UUID txn_id and no retry", async () => {
    const { server, client } = await connected();
    server.handle("invoke", () => ({ result: COMMITTED }));
    const result = await invokeWithRetry(
      client,
      { ...PARAMS, label: "zap" },
      {
        retry: { timeoutMs: 1000 },
      },
    );
    expect(result).toEqual(COMMITTED);
    const req = server.peer.lastRequest("invoke");
    expect(req.params).toMatchObject({ ...PARAMS, label: "zap" });
    expect(req.params.txn_id).toEqual(expect.any(String));
    expect(req.params).not.toHaveProperty("retry");
  });

  test("a socket dropped after the send is resent once with retry: true to the same session", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const params = {
      ...PARAMS,
      txn_id: "t1",
      actor: { type: "character" as const, id: "aldric" },
      table: { board: "map", position: [1, 2] as [number, number] },
    };
    const write = track(invokeWithRetry(client, params, { retry: { timeoutMs: 5000 } }));
    await flush();
    const original = server.peer.lastRequest("invoke");
    server.peer.drop();
    // Caller mutations after the send never reach the resend.
    params.actor.id = "villain";
    params.table.position[0] = 99;
    await advance(250);
    expect(write.value).toEqual(COMMITTED);
    const all = invokes(server);
    expect(all).toHaveLength(2);
    expect(all[1]?.params).toEqual({ ...original.params, retry: true });
    expect(all[1]?.params).toMatchObject({
      txn_id: "t1",
      actor: { id: "aldric" },
      table: { position: [1, 2] },
    });
  });

  test("a rejected resend result is returned", async () => {
    const { server, client } = await connected();
    const rejected = {
      status: "rejected",
      rejection: { type: "when_false", object: "attack1", action: "Roll" },
    };
    script(server, () => ({ result: rejected }));
    const write = track(invokeWithRetry(client, PARAMS, { retry: { timeoutMs: 5000 } }));
    await flush();
    server.peer.drop();
    await advance(250);
    expect(write.value).toEqual(rejected);
  });

  test("the original timing out rejects uncertain timeout with no resend", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      invokeWithRetry(client, { ...PARAMS, txn_id: "t1" }, { retry: { timeoutMs: 5000 } }),
    );
    await advance(1000);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "timeout" },
    });
    expect(write.local).toBe(true);
    server.peer.drop();
    await advance(10000);
    expect(invokes(server)).toHaveLength(1);
  });

  test("a session change rejects uncertain session_changed and never resends", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      invokeWithRetry(client, { ...PARAMS, txn_id: "t1" }, { retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.session = "session-2";
    server.peer.drop();
    await advance(250);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: {
        txn_id: "t1",
        reason: "session_changed",
        old_session: "session-1",
        new_session: "session-2",
      },
    });
    expect(write.error?.message).toContain("invoke t1");
    await advance(10000);
    expect(invokes(server)).toHaveLength(1);
  });

  test("retry_unknown rejects uncertain retry_unknown", async () => {
    const { server, client } = await connected();
    script(server, () => ({ error: { code: "retry_unknown", message: "not retained" } }));
    const write = track(
      invokeWithRetry(client, { ...PARAMS, txn_id: "t1" }, { retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.peer.drop();
    await advance(250);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "retry_unknown" },
    });
    await advance(10000);
    expect(invokes(server)).toHaveLength(2);
  });

  test("the resend's response lost rejects uncertain resend_lost; never a third send", async () => {
    const { server, client } = await connected();
    script(server, () => undefined);
    const write = track(
      invokeWithRetry(client, { ...PARAMS, txn_id: "t1" }, { retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.peer.drop();
    await advance(250);
    expect(invokes(server)).toHaveLength(2);
    server.peer.drop();
    await flush();
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "resend_lost" },
    });
    await advance(10000);
    expect(invokes(server)).toHaveLength(2);
  });

  test("recovery not ready within timeoutMs rejects uncertain not_ready", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      invokeWithRetry(client, { ...PARAMS, txn_id: "t1" }, { retry: { timeoutMs: 2000 } }),
    );
    await flush();
    server.accepting = false;
    server.peer.drop();
    await advance(2000);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "not_ready" },
    });
    server.accepting = true;
    await advance(10000);
    expect(invokes(server)).toHaveLength(1);
  });

  test("an invoke never sent rejects disconnected", async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    const client = new ProtocolClient({
      url: "ws://127.0.0.1:4747/ws",
      token: "tok",
      client: { name: "tester", kind: "test" },
      WebSocket: server.WebSocket,
      onWarning: () => {},
    });
    const write = track(invokeWithRetry(client, PARAMS, { retry: { timeoutMs: 1000 } }));
    await flush();
    expect(write.error).toMatchObject({ code: "disconnected", details: { sent: false } });
    expect(invokes(server)).toHaveLength(0);
  });
});
