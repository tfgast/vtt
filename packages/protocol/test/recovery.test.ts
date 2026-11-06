import { readFileSync } from "node:fs";
import {
  enableRecovery,
  ProtocolClient,
  type ProtocolClientOptions,
  type ProtocolError,
  ProtocolFailure,
  type RecoveryCredentials,
  type RecoveryOptions,
  type ResyncInfo,
  type Subscription,
  transactWithRetry,
} from "@vtt/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  commit,
  delta,
  FakeServer,
  flush,
  obj,
  type ReceivedRequest,
  subscribeResult,
} from "./support/fake-server";

const URL_ = "ws://127.0.0.1:4747/ws";
const TABLE = { path: "/tables/game.json", id: "table-id-1" };
const OPS = [{ type: "remove" as const, object: "a" }];
const COMMITTED = {
  status: "committed",
  revision: 1,
  index: 0,
  created: [],
  copies: [],
  bindings: {},
};

function setup(options: Partial<ProtocolClientOptions> = {}) {
  vi.useFakeTimers();
  const server = new FakeServer();
  let n = 0;
  server.handle("subscribe", () => {
    n++;
    return { result: subscribeResult(`s${n}`, server.revision, { objects: [obj(`o${n}`)] }) };
  });
  const client = new ProtocolClient({
    url: URL_,
    token: "tok",
    client: { name: "tester", kind: "test" },
    instance: "inst-1",
    WebSocket: server.WebSocket,
    onWarning: () => {},
    requestTimeoutMs: 1000,
    ...options,
  });
  return { server, client };
}

async function connected(
  recovery: RecoveryOptions = {},
  options: Partial<ProtocolClientOptions> = {},
) {
  const ctx = setup(options);
  await ctx.client.connect();
  const stop = enableRecovery(ctx.client, recovery);
  return { ...ctx, stop };
}

async function subscribe(client: ProtocolClient, board: string): Promise<Subscription> {
  const pending = client.subscribe({ scope: { type: "board", board } });
  await flush();
  return pending;
}

/** The `ProtocolError` a promise rejects with (it must be a `ProtocolFailure`). */
async function failure(promise: Promise<unknown>): Promise<ProtocolError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolFailure);
    return (e as ProtocolFailure).error;
  }
  throw new Error("expected a rejection");
}

/** Records a promise's settlement without awaiting it. */
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

const discovery = (overrides: Partial<RecoveryCredentials> = {}): RecoveryCredentials => ({
  url: URL_,
  token: "tok",
  table_path: TABLE.path,
  table_id: TABLE.id,
  ...overrides,
});

const transacts = (server: FakeServer) => server.requests("transact");

afterEach(() => {
  vi.useRealTimers();
});

describe("first connection", () => {
  test("an unreachable authority keeps disconnected; connects when it accepts; records the table pair", async () => {
    const { server, client } = setup();
    server.accepting = false;
    enableRecovery(client);
    await flush();
    expect(server.peers).toHaveLength(1);
    expect(client.connectionError()?.code).toBe("disconnected");
    expect(client.ready).toBe(false);
    await advance(250);
    expect(server.peers).toHaveLength(2);
    expect(client.connectionError()?.code).toBe("disconnected");
    server.accepting = true;
    await advance(499);
    expect(server.peers).toHaveLength(2);
    await advance(1);
    expect(server.peers).toHaveLength(3);
    expect(client.ready).toBe(true);
    expect(client.state).toBe("open");
    expect(client.connectionError()).toBeNull();

    // The recorded pair is the first welcome's: a later welcome naming another table is wrong_table.
    server.table = { name: "game.json", path: TABLE.path, id: "other-id" };
    server.peer.drop();
    await advance(250);
    expect(client.state).toBe("closed");
    expect(client.connectionError()?.code).toBe("wrong_table");
  });

  test("with credentials and no session file yet, it waits for the file and uses it", async () => {
    const { server, client } = setup({ url: "", token: "" });
    let file: RecoveryCredentials | null = null;
    const credentials = vi.fn(async () => file);
    enableRecovery(client, { credentials });
    await advance(2000);
    expect(server.peers).toHaveLength(0);
    expect(client.connectionError()?.code).toBe("disconnected");
    expect(credentials.mock.calls.length).toBeGreaterThan(1);
    file = discovery({ url: "ws://127.0.0.1:4800/ws", token: "fresh" });
    server.token = "fresh";
    await advance(5000);
    expect(server.peers).toHaveLength(1);
    expect(server.peer.url).toBe("ws://127.0.0.1:4800/ws");
    expect(server.peer.hello).toMatchObject({ token: "fresh" });
    expect(client.ready).toBe(true);
  });

  test("a first attempt that never gets a welcome times out and the backoff retries", async () => {
    const { server, client } = setup({ handshakeTimeoutMs: 2000 });
    let answer = false;
    server.onHello = () => (answer ? { welcome: server.welcome() } : undefined);
    enableRecovery(client);
    await flush();
    expect(server.peers).toHaveLength(1);
    await advance(1999);
    expect(server.peers).toHaveLength(1);
    expect(server.peer.closedByClient).toBeNull();
    answer = true;
    await advance(1);
    expect(server.peers[0]?.closedByClient?.code).toBe(4000);
    expect(client.connectionError()?.code).toBe("disconnected");
    await advance(249);
    expect(server.peers).toHaveLength(1);
    await advance(1);
    expect(server.peers).toHaveLength(2);
    expect(client.ready).toBe(true);
    expect(client.state).toBe("open");
  });

  test("explicit credentials refused 4401 on the first connection end recovery", async () => {
    const { server, client } = setup({ token: "wrong" });
    enableRecovery(client);
    await flush();
    expect(client.state).toBe("closed");
    expect(client.connectionError()?.code).toBe("unauthorized");
    await advance(10000);
    expect(server.peers).toHaveLength(1);
  });
});

describe("reconnection and resubscription", () => {
  test("backoff 250, 500, 1000; same instance; same params; resync with the same Subscription", async () => {
    const { server, client } = await connected();
    const a = await subscribe(client, "map");
    const b = await subscribe(client, "cave");
    const resyncs: [Subscription, ResyncInfo][] = [];
    for (const sub of [a, b]) sub.on("resync", (s, info) => resyncs.push([s, info]));
    server.handlers.delete("subscribe");

    server.accepting = false;
    server.peer.drop();
    expect(client.state).toBe("reconnecting");
    expect(client.connectionError()?.code).toBe("disconnected");
    await advance(249);
    expect(server.peers).toHaveLength(1);
    await advance(1);
    expect(server.peers).toHaveLength(2);
    await advance(499);
    expect(server.peers).toHaveLength(2);
    await advance(1);
    expect(server.peers).toHaveLength(3);
    server.accepting = true;
    server.revision = 4;
    await advance(999);
    expect(server.peers).toHaveLength(3);
    await advance(1);
    expect(server.peers).toHaveLength(4);
    const peer = server.peer;
    expect(peer.hello).toMatchObject({ client: { instance: "inst-1" } });

    expect(client.state).toBe("recovering");
    expect(client.connectionError()).toMatchObject({ code: "disconnected", recovering: true });
    const requests = peer.requests("subscribe");
    expect(requests.map((r) => r.params)).toEqual([a.params, b.params]);

    peer.respond(requests[0]?.id ?? "", subscribeResult("n1", 4, { objects: [obj("x")] }));
    await flush();
    expect(client.connectionError()).toMatchObject({ code: "disconnected", recovering: true });
    expect(client.ready).toBe(false);
    peer.respond(requests[1]?.id ?? "", subscribeResult("n2", 4, { objects: [obj("y")] }));
    await flush();
    expect(client.connectionError()).toBeNull();
    expect(client.state).toBe("open");
    expect(client.ready).toBe(true);

    expect(a.id).toBe("n1");
    expect([...a.mirror.objects.keys()]).toEqual(["x"]);
    expect(a.mirror.revision).toBe(4);
    expect(client.liveSubscriptions()).toEqual([a, b]);
    expect(resyncs).toEqual([
      [a, { from_revision: 0, to_revision: 4, session_changed: false }],
      [b, { from_revision: 0, to_revision: 4, session_changed: false }],
    ]);
    // Deltas follow the new ids.
    peer.send(commit(5, [delta("n2", { objects: [obj("z")] })]));
    expect(b.mirror.objects.has("z")).toBe(true);
  });

  test("a reconnect attempt that never gets a welcome times out and the next attempt succeeds", async () => {
    const { server, client } = await connected({}, { handshakeTimeoutMs: 2000 });
    const a = await subscribe(client, "map");
    server.onHello = () => undefined;
    server.peer.drop();
    expect(client.state).toBe("reconnecting");
    await advance(250);
    expect(server.peers).toHaveLength(2);
    server.onHello = () => ({ welcome: server.welcome() });
    await advance(2000);
    expect(server.peers[1]?.closedByClient?.code).toBe(4000);
    expect(client.state).toBe("reconnecting");
    await advance(499);
    expect(server.peers).toHaveLength(2);
    await advance(1);
    expect(server.peers).toHaveLength(3);
    expect(client.state).toBe("open");
    expect(client.ready).toBe(true);
    expect(a.state).toBe("live");
  });

  test("a new session reports session_changed true", async () => {
    const { server, client } = await connected();
    const a = await subscribe(client, "map");
    const resyncs: ResyncInfo[] = [];
    a.on("resync", (_s, info) => resyncs.push(info));
    server.session = "session-2";
    server.peer.drop();
    await advance(250);
    expect(client.ready).toBe(true);
    expect(resyncs).toEqual([{ from_revision: 0, to_revision: 0, session_changed: true }]);
    // A later reconnect to that same session is not a change.
    server.peer.drop();
    await advance(250);
    expect(resyncs[1]?.session_changed).toBe(false);
  });

  test("drops during resubscription keep every subscription recovering until a connection succeeds", async () => {
    const { server, client } = await connected();
    const subs = [
      await subscribe(client, "a"),
      await subscribe(client, "b"),
      await subscribe(client, "c"),
    ];
    const errors: ProtocolError[] = [];
    const resyncs: Subscription[] = [];
    for (const sub of subs) {
      sub.on("error", (_s, e) => errors.push(e));
      sub.on("resync", (s) => resyncs.push(s));
    }
    server.handlers.delete("subscribe");

    server.peer.drop();
    for (const delay of [250, 500]) {
      await advance(delay);
      expect(server.peer.requests("subscribe")).toHaveLength(3);
      server.peer.drop();
      await flush();
      expect(subs.map((s) => s.state)).toEqual(["recovering", "recovering", "recovering"]);
      expect(subs.map((s) => [...s.mirror.objects.keys()])).toEqual([["o1"], ["o2"], ["o3"]]);
      expect(errors).toEqual([]);
      expect(client.state).toBe("reconnecting");
    }
    let n = 10;
    server.handle("subscribe", () => ({ result: subscribeResult(`r${++n}`, 0) }));
    await advance(1000);
    expect(subs.map((s) => s.state)).toEqual(["live", "live", "live"]);
    expect(subs.map((s) => s.id)).toEqual(["r11", "r12", "r13"]);
    expect(resyncs).toEqual(subs);
    expect(errors).toEqual([]);
    expect(client.ready).toBe(true);
  });

  test("a resubscribe answered not_found fails that subscription; another resyncs", async () => {
    const { server, client } = await connected();
    const gone = await subscribe(client, "gone");
    const kept = await subscribe(client, "kept");
    const errors: ProtocolError[] = [];
    gone.on("error", (_s, e) => errors.push(e));
    const resyncs: ResyncInfo[] = [];
    kept.on("resync", (_s, info) => resyncs.push(info));
    server.handle("subscribe", (req) =>
      (req.params.scope as { board: string }).board === "gone"
        ? { error: { code: "not_found", message: "no board gone" } }
        : { result: subscribeResult("k2", 0, { objects: [obj("k")] }) },
    );
    server.peer.drop();
    await advance(250);
    expect(errors).toEqual([{ code: "not_found", message: "no board gone" }]);
    expect(gone.state).toBe("failed");
    expect(gone.mirror.objects.size).toBe(0);
    expect(kept.state).toBe("live");
    expect(resyncs).toHaveLength(1);
    expect(client.liveSubscriptions()).toEqual([kept]);
    expect(client.ready).toBe(true);
  });

  test.each([
    ["disconnected", { code: "disconnected", message: "server says disconnected" }],
    ["disconnected (sent: true)", { code: "disconnected", message: "x", details: { sent: true } }],
    [
      "disconnected (sent: false)",
      { code: "disconnected", message: "x", details: { sent: false } },
    ],
    ["timeout", { code: "timeout", message: "server says timeout" }],
    [
      "timeout (client-like)",
      {
        code: "timeout",
        message: "subscribe: no response within 1000 ms",
        details: { sent: true },
      },
    ],
  ] as const)(
    "a server error response coded %s (client-only) fails the subscription terminally",
    async (_n, error) => {
      const { server, client } = await connected();
      const sub = await subscribe(client, "a");
      const errors: ProtocolError[] = [];
      sub.on("error", (_s, e) => errors.push(e));
      server.handle("subscribe", () => ({ error: { ...error } }));
      server.peer.drop();
      await advance(250);
      const peer = server.peer;
      expect(sub.state).toBe("failed");
      // A client-only code from the server is a protocol violation (PROTOCOL.md §10).
      expect(errors).toEqual([
        {
          code: "internal",
          message: expect.stringContaining(error.code),
          details: { type: "protocol", method: "subscribe" },
        },
      ]);
      expect(sub.mirror.objects.size).toBe(0);
      expect(peer.closedByClient).toBeNull();
      expect(client.ready).toBe(true);
      expect(client.connectionError()).toBeNull();
      await advance(10000);
      expect(server.peers).toHaveLength(2);
    },
  );

  test.each([
    [
      "disconnected (sent: false) with the client's wording",
      () =>
        new ProtocolFailure("disconnected", "cannot send subscribe: not connected", {
          sent: false,
        }),
    ],
    [
      "timeout with the client's wording",
      () => new ProtocolFailure("timeout", "subscribe: no response within 1000 ms", { sent: true }),
    ],
  ] as const)(
    "a resubscribe failure not marked local, %s, fails the subscription terminally",
    async (_n, make) => {
      const { server, client } = await connected();
      const sub = await subscribe(client, "a");
      const errors: ProtocolError[] = [];
      sub.on("error", (_s, e) => errors.push(e));
      const remote = make();
      vi.spyOn(client, "requestDuringRecovery").mockImplementation(() => Promise.reject(remote));
      server.peer.drop();
      await advance(1000);
      expect(sub.state).toBe("failed");
      expect(errors).toEqual([remote.error]);
      expect(server.peer.closedByClient).toBeNull();
      expect(client.ready).toBe(true);
      expect(server.peers).toHaveLength(2);
    },
  );

  test.each([
    ["disconnected (sent: false)", "send_failed", { sent: false }, "resubscribe_send_failed"],
    ["timeout", "timeout", { sent: true }, "resubscribe_timeout"],
  ] as const)(
    "a local %s resubscribe failure aborts the socket whatever its message",
    async (_n, kind, details, reason) => {
      const { server, client } = await connected();
      const sub = await subscribe(client, "a");
      const code = kind === "timeout" ? "timeout" : "disconnected";
      const during = vi
        .spyOn(client, "requestDuringRecovery")
        .mockImplementationOnce(() =>
          Promise.reject(new ProtocolFailure(code, "unusual wording", details, { local: true })),
        );
      server.peer.drop();
      await advance(250);
      const first = server.peers[1];
      expect(first?.closedByClient).toEqual({ code: 4000, reason });
      expect(sub.state).toBe("recovering");
      during.mockRestore();
      await advance(5000);
      expect(sub.state).toBe("live");
      expect(client.ready).toBe(true);
    },
  );

  test("a resubscribe timing out with the socket open aborts it and rebinds on a new connection", async () => {
    const { server, client } = await connected();
    const subs = [await subscribe(client, "a"), await subscribe(client, "b")];
    const request = vi.spyOn(client, "request");
    const during = vi.spyOn(client, "requestDuringRecovery");
    server.handlers.delete("subscribe");
    server.peer.drop();
    await advance(250);
    const stuck = server.peer;
    expect(stuck.requests("subscribe")).toHaveLength(2);
    await advance(1000);
    expect(stuck.closedByClient).toEqual({ code: 4000, reason: "resubscribe_timeout" });
    expect(client.state).toBe("reconnecting");
    expect(subs.map((s) => s.state)).toEqual(["recovering", "recovering"]);
    let n = 0;
    server.handle("subscribe", () => ({ result: subscribeResult(`t${++n}`, 0) }));
    await advance(5000);
    expect(server.peer).not.toBe(stuck);
    expect(subs.map((s) => s.state)).toEqual(["live", "live"]);
    expect(subs.map((s) => s.id)).toEqual(["t1", "t2"]);
    expect(client.ready).toBe(true);
    expect(request.mock.calls.filter(([m]) => m === "subscribe")).toEqual([]);
    expect(during.mock.calls.filter(([m]) => m === "subscribe")).toHaveLength(4);
  });

  test("ordinary requests are refused while recovering", async () => {
    const { server, client } = await connected();
    await subscribe(client, "a");
    server.handlers.delete("subscribe");
    server.peer.drop();
    await advance(250);
    expect(client.state).toBe("recovering");
    expect(await failure(client.request("log", {}))).toMatchObject({
      code: "disconnected",
      details: { sent: false },
    });
  });
});

describe("credentials", () => {
  test("a reconnect after a token change uses the token the callback returns", async () => {
    let file = discovery();
    const { server, client } = await connected({ credentials: async () => file });
    server.token = "tok2";
    file = discovery({ token: "tok2", url: "ws://127.0.0.1:4748/ws" });
    server.peer.drop();
    await advance(250);
    expect(server.peer.hello).toMatchObject({ token: "tok2", client: { instance: "inst-1" } });
    expect(server.peer.url).toBe("ws://127.0.0.1:4748/ws");
    expect(client.ready).toBe(true);
    expect(client.credentials).toEqual({ url: "ws://127.0.0.1:4748/ws", token: "tok2" });
  });

  test.each([
    ["table_id", { table_id: "other-id" }],
    ["table_path", { table_path: "/tables/other.json" }],
  ])("a callback naming a different %s closes the client with wrong_table", async (_n, change) => {
    let file = discovery();
    const { server, client } = await connected({ credentials: async () => file });
    file = discovery(change);
    server.peer.drop();
    await advance(250);
    expect(client.state).toBe("closed");
    expect(client.connectionError()?.code).toBe("wrong_table");
    expect(server.peers).toHaveLength(1);
    await advance(10000);
    expect(server.peers).toHaveLength(1);
  });

  test("null retries with the old credentials", async () => {
    let file: RecoveryCredentials | null = discovery();
    const { server, client } = await connected({ credentials: async () => file });
    file = null;
    server.peer.drop();
    await advance(250);
    expect(server.peers).toHaveLength(2);
    expect(server.peer.url).toBe(URL_);
    expect(server.peer.hello).toMatchObject({ token: "tok" });
    expect(client.ready).toBe(true);
    expect(client.credentials).toEqual({ url: URL_, token: "tok" });
  });

  test("a 4401 on an attempt is not terminal: the next attempt re-reads", async () => {
    let file = discovery();
    const credentials = vi.fn(async () => file);
    const { server, client } = await connected({ credentials });
    server.token = "tok2";
    server.peer.drop();
    await advance(250);
    expect(server.peers).toHaveLength(2);
    expect(client.state).toBe("reconnecting");
    expect(client.connectionError()?.code).toBe("disconnected");
    file = discovery({ token: "tok2" });
    await advance(500);
    expect(server.peers).toHaveLength(3);
    expect(client.ready).toBe(true);
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  test("a 4401 close in discovery mode reconnects", async () => {
    const { server, client } = await connected({ credentials: async () => discovery() });
    server.peer.close(4401, "unauthorized");
    expect(client.state).toBe("reconnecting");
    expect(client.connectionError()?.code).toBe("disconnected");
    await advance(250);
    expect(client.ready).toBe(true);
  });

  test("without credentials a 4401 on an attempt closes the client with unauthorized", async () => {
    const { server, client } = await connected();
    server.token = "rotated";
    server.peer.drop();
    await advance(250);
    expect(client.state).toBe("closed");
    expect(client.connectionError()?.code).toBe("unauthorized");
    await advance(10000);
    expect(server.peers).toHaveLength(2);
  });

  test("without credentials a 4401 close closes the client with unauthorized", async () => {
    const { server, client } = await connected();
    server.peer.close(4401, "unauthorized");
    expect(client.state).toBe("closed");
    expect(client.connectionError()?.code).toBe("unauthorized");
    await advance(10000);
    expect(server.peers).toHaveLength(1);
  });
});

describe("wrong_table on welcome", () => {
  async function mismatch(file: () => RecoveryCredentials | null) {
    const credentials = vi.fn(async () => file());
    const ctx = await connected({ credentials });
    await subscribe(ctx.client, "a");
    ctx.server.handle("transact", () => undefined);
    const write = track(
      transactWithRetry(ctx.client, OPS, { txn_id: "t1", retry: { timeoutMs: 60000 } }),
    );
    await flush();
    ctx.server.table = { name: "game.json", path: TABLE.path, id: "other-id" };
    const subscribes = ctx.server.requests("subscribe").length;
    ctx.server.peer.drop();
    await advance(250);
    return { ...ctx, credentials, write, subscribes };
  }

  test("discovery file unchanged: re-read, reconnect once, second mismatch is wrong_table", async () => {
    const ctx = await mismatch(() => discovery());
    expect(ctx.server.peers).toHaveLength(3);
    expect(ctx.server.peers[1]?.closedByClient).toEqual({ code: 4000, reason: "wrong_table" });
    expect(ctx.credentials).toHaveBeenCalledTimes(2);
    expect(ctx.client.state).toBe("closed");
    expect(ctx.client.connectionError()?.code).toBe("wrong_table");
    expect(ctx.server.requests("subscribe")).toHaveLength(ctx.subscribes);
    expect(ctx.client.liveSubscriptions()).toEqual([]);
    expect(ctx.write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "wrong_table" },
    });
    expect(transacts(ctx.server)).toHaveLength(1);
    await advance(10000);
    expect(ctx.server.peers).toHaveLength(3);
  });

  test("discovery file missing: the same", async () => {
    let calls = 0;
    const ctx = await mismatch(() => (calls++ === 0 ? discovery() : null));
    expect(ctx.server.peers).toHaveLength(3);
    expect(ctx.client.connectionError()?.code).toBe("wrong_table");
    expect(ctx.client.state).toBe("closed");
    expect(ctx.server.requests("subscribe")).toHaveLength(ctx.subscribes);
    expect(ctx.write.error?.details).toMatchObject({ reason: "wrong_table" });
    expect(transacts(ctx.server)).toHaveLength(1);
  });

  test("a mismatch then a matching welcome recovers", async () => {
    const credentials = vi.fn(async () => discovery());
    const { server, client } = await connected({ credentials });
    server.table = { name: "game.json", path: TABLE.path, id: "other-id" };
    server.onHello = (_hello, peer) => {
      if (server.peers.indexOf(peer) === 2) server.table = { name: "game.json", ...TABLE };
      return { welcome: server.welcome() };
    };
    server.peer.drop();
    await advance(250);
    expect(server.peers).toHaveLength(3);
    expect(client.ready).toBe(true);
  });

  test("explicit credentials: the first mismatched welcome is wrong_table", async () => {
    const { server, client } = await connected();
    await subscribe(client, "a");
    const subscribes = server.requests("subscribe").length;
    server.table = { name: "game.json", path: "/tables/other.json", id: TABLE.id };
    server.peer.drop();
    await advance(250);
    expect(server.peers).toHaveLength(2);
    expect(client.state).toBe("closed");
    expect(client.connectionError()?.code).toBe("wrong_table");
    expect(server.requests("subscribe")).toHaveLength(subscribes);
  });
});

describe("transactWithRetry", () => {
  /** Leaves first sends unanswered and answers resends with `resend`. */
  function script(server: FakeServer, resend: (req: ReceivedRequest) => object | undefined) {
    server.handle("transact", (req) =>
      req.params.retry === true ? (resend(req) as never) : undefined,
    );
  }

  test("committed outright", async () => {
    const { server, client } = await connected();
    server.handle("transact", () => ({ result: COMMITTED }));
    const result = await transactWithRetry(client, OPS, {
      label: "zap",
      retry: { timeoutMs: 1000 },
    });
    expect(result).toEqual(COMMITTED);
    const req = server.peer.lastRequest("transact");
    expect(req.params).toMatchObject({ base_revision: 0, ops: OPS, label: "zap" });
    expect(req.params.txn_id).toEqual(expect.any(String));
    expect(req.params).not.toHaveProperty("retry");
  });

  test("a socket dropped after the send is resent once with retry: true to the same session", async () => {
    const { server, client } = await connected();
    await subscribe(client, "a");
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      transactWithRetry(client, OPS, {
        txn_id: "t1",
        base_revision: 0,
        actor: { type: "character", id: "hero" },
        retry: { timeoutMs: 5000 },
      }),
    );
    await flush();
    const original = server.peer.lastRequest("transact");
    server.peer.drop();
    await advance(250);
    expect(write.value).toEqual(COMMITTED);
    const all = transacts(server);
    expect(all).toHaveLength(2);
    expect(all[1]?.params).toEqual({ ...original.params, retry: true });
    expect(all[1]?.params.txn_id).toBe("t1");
    // The resend went only after recovery completed.
    const frames = server.peer.frames.map((f) => f.message as ReceivedRequest);
    const methods = frames.filter((m) => m.type === "request").map((m) => m.method);
    expect(methods).toEqual(["subscribe", "transact"]);
  });

  test("the resend uses a snapshot of the params; caller mutations do not leak", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const ops: { type: "remove"; object: string }[] = [{ type: "remove", object: "a" }];
    const actor = { type: "character" as const, id: "hero" };
    const write = track(
      transactWithRetry(client, ops, { txn_id: "t1", actor, retry: { timeoutMs: 5000 } }),
    );
    await flush();
    const original = server.peer.lastRequest("transact").params;
    server.peer.drop();
    (ops[0] as { object: string }).object = "b";
    ops.push({ type: "remove", object: "c" });
    actor.id = "villain";
    await advance(250);
    expect(write.value).toEqual(COMMITTED);
    const resend = transacts(server)[1]?.params;
    expect(resend).toEqual({ ...original, retry: true });
    expect(resend).toMatchObject({
      ops: [{ type: "remove", object: "a" }],
      actor: { type: "character", id: "hero" },
    });
  });

  test("a rejected resend result is returned", async () => {
    const { server, client } = await connected();
    const rejected = { status: "rejected", rejection: { type: "nothing_to_undo" } };
    script(server, () => ({ result: rejected }));
    const write = track(transactWithRetry(client, OPS, { retry: { timeoutMs: 5000 } }));
    await flush();
    server.peer.drop();
    await advance(250);
    expect(write.value).toEqual(rejected);
  });

  test("the original timing out rejects uncertain timeout with no resend", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 5000 } }),
    );
    await advance(1000);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "timeout" },
    });
    expect(write.local).toBe(true);
    server.peer.drop();
    await advance(10000);
    expect(transacts(server)).toHaveLength(1);
  });

  test("recovery not ready within timeoutMs rejects uncertain not_ready", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 2000 } }),
    );
    await flush();
    server.accepting = false;
    server.peer.drop();
    await advance(1999);
    expect(write.settled).toBe(false);
    await advance(1);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "not_ready" },
    });
    server.accepting = true;
    await advance(10000);
    expect(client.ready).toBe(true);
    expect(transacts(server)).toHaveLength(1);
  });

  test("a session change rejects uncertain session_changed", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 5000 } }),
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
    await advance(10000);
    expect(transacts(server)).toHaveLength(1);
  });

  test("retry_unknown rejects uncertain retry_unknown", async () => {
    const { server, client } = await connected();
    script(server, () => ({ error: { code: "retry_unknown", message: "not retained" } }));
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.peer.drop();
    await advance(250);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "retry_unknown" },
    });
    await advance(10000);
    expect(transacts(server)).toHaveLength(2);
  });

  test("the resend's response lost rejects uncertain resend_lost", async () => {
    const { server, client } = await connected();
    script(server, () => undefined);
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.peer.drop();
    await advance(250);
    expect(transacts(server)).toHaveLength(2);
    server.peer.drop();
    await flush();
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "resend_lost" },
    });
    await advance(10000);
    expect(client.ready).toBe(true);
    expect(transacts(server)).toHaveLength(2);
  });

  test("the resend timing out rejects uncertain resend_lost", async () => {
    const { server, client } = await connected();
    script(server, () => undefined);
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.peer.drop();
    await advance(250);
    await advance(1000);
    expect(write.error).toMatchObject({ code: "uncertain", details: { reason: "resend_lost" } });
    expect(write.local).toBe(true);
    expect(transacts(server)).toHaveLength(2);
  });

  test("a 4401 with explicit credentials rejects uncertain unauthorized", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.token = "rotated";
    server.peer.drop();
    await advance(250);
    expect(client.connectionError()?.code).toBe("unauthorized");
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "unauthorized" },
    });
    expect(transacts(server)).toHaveLength(1);
  });

  test("wrong_table with explicit credentials rejects uncertain wrong_table", async () => {
    const { server, client } = await connected();
    script(server, () => ({ result: COMMITTED }));
    const write = track(
      transactWithRetry(client, OPS, { txn_id: "t1", retry: { timeoutMs: 5000 } }),
    );
    await flush();
    server.table = { name: "game.json", path: TABLE.path, id: "other-id" };
    server.peer.drop();
    await advance(250);
    expect(write.error).toMatchObject({
      code: "uncertain",
      details: { txn_id: "t1", reason: "wrong_table" },
    });
    expect(transacts(server)).toHaveLength(1);
  });

  test("a send while closed rejects disconnected without waiting or a frame", async () => {
    const { server, client } = await connected();
    client.close();
    const write = track(transactWithRetry(client, OPS, { retry: { timeoutMs: 60000 } }));
    await flush();
    expect(write.error).toMatchObject({ code: "disconnected", details: { sent: false } });
    expect(transacts(server)).toHaveLength(0);
  });

  test("a send while reconnecting rejects disconnected without a frame", async () => {
    const { server, client } = await connected();
    server.peer.drop();
    const error = await failure(transactWithRetry(client, OPS, { retry: { timeoutMs: 60000 } }));
    expect(error).toMatchObject({ code: "disconnected", details: { sent: false } });
    expect(transacts(server)).toHaveLength(0);
  });

  test("an error response to the original passes through", async () => {
    const { server, client } = await connected();
    server.handle("transact", () => ({ error: { code: "bad_request", message: "nope" } }));
    const error = await failure(transactWithRetry(client, OPS, { retry: { timeoutMs: 1000 } }));
    expect(error).toEqual({ code: "bad_request", message: "nope" });
  });
});

describe("lifecycle", () => {
  test("close() stops recovery", async () => {
    const { server, client } = await connected();
    server.accepting = false;
    server.peer.drop();
    await advance(250);
    client.close();
    await advance(10000);
    expect(server.peers).toHaveLength(2);
    expect(client.state).toBe("closed");
  });

  test("the disposer stops reconnecting", async () => {
    const { server, stop } = await connected();
    server.accepting = false;
    server.peer.drop();
    await advance(250);
    stop();
    await advance(10000);
    expect(server.peers).toHaveLength(2);
  });

  test("a protocol_version handshake refusal on a reconnect ends recovery", async () => {
    const { server, client } = await connected();
    server.onHello = () => ({ goodbye: "protocol 1 is not supported", close: 4400 });
    server.peer.drop();
    await advance(250);
    expect(server.peers).toHaveLength(2);
    expect(client.state).toBe("closed");
    expect(client.connectionError()?.code).toBe("disconnected");
    await advance(10000);
    expect(server.peers).toHaveLength(2);
  });

  test("a protocol_version handshake refusal on the first connection ends recovery", async () => {
    const { server, client } = setup();
    server.onHello = () => ({ goodbye: "protocol 1 is not supported", close: 4400 });
    enableRecovery(client);
    await flush();
    expect(client.state).toBe("closed");
    await advance(10000);
    expect(server.peers).toHaveLength(1);
  });

  test("a 4400 close (protocol violation) ends recovery", async () => {
    const { server, client } = await connected();
    server.peer.send("not json");
    expect(server.peer.closedByClient?.code).toBe(4400);
    await advance(10000);
    expect(server.peers).toHaveLength(1);
    expect(client.state).toBe("closed");
  });

  test("the backoff is capped at maxMs and resets after recovery", async () => {
    const { server, client } = await connected({
      reconnect: { initialMs: 100, maxMs: 300, factor: 3 },
    });
    server.accepting = false;
    server.peer.drop();
    const times: number[] = [];
    const start = Date.now();
    const seen = () => {
      while (times.length < server.peers.length - 1) times.push(Date.now() - start);
    };
    for (let i = 0; i < 12; i++) {
      await advance(100);
      seen();
    }
    expect(times).toEqual([100, 400, 700, 1000]);
    server.accepting = true;
    await advance(300);
    expect(client.ready).toBe(true);
    const before = server.peers.length;
    server.peer.drop();
    await advance(100);
    expect(server.peers).toHaveLength(before + 1);
  });
});

describe("browser safety", () => {
  test("client/recovery.ts imports no node: modules", () => {
    const text = readFileSync(new URL("../src/client/recovery.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/from\s+["']node:/);
    expect(text).not.toMatch(/import\(\s*["']node:/);
    expect(text).not.toMatch(/require\(\s*["']node:/);
  });
});
