import { readFileSync } from "node:fs";
import {
  type ClientState,
  type DeltaEvent,
  ProtocolClient,
  type ProtocolClientOptions,
  type ProtocolError,
  ProtocolFailure,
  type ResyncInfo,
  type SocketClosedInfo,
  type SubscribeResult,
  type Subscription,
  type WebSocketConstructor,
} from "@vtt/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { commit, delta, FakeServer, flush, obj, subscribeResult } from "./support/fake-server";

const URL_ = "ws://127.0.0.1:4747/ws";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setup(options: Partial<ProtocolClientOptions> = {}) {
  const server = new FakeServer();
  const warnings: string[] = [];
  const client = new ProtocolClient({
    url: URL_,
    token: "tok",
    client: { name: "tester", kind: "test" },
    instance: "inst-1",
    WebSocket: server.WebSocket,
    onWarning: (message) => warnings.push(message),
    ...options,
  });
  return { server, client, warnings };
}

async function connected(options: Partial<ProtocolClientOptions> = {}) {
  const ctx = setup(options);
  await ctx.client.connect();
  return ctx;
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

const getObjectsResult = (revision = 0) => ({ revision, objects: [], missing: [] });

/** Subscribes, answering with `result`, and returns the subscription. */
async function subscribed(
  ctx: Awaited<ReturnType<typeof connected>>,
  result: object,
  params: Parameters<ProtocolClient["subscribe"]>[0] = { scope: { type: "board", board: "map" } },
): Promise<Subscription> {
  const pending = ctx.client.subscribe(params);
  ctx.server.peer.respond(ctx.server.peer.lastRequest("subscribe").id, result);
  return pending;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handshake", () => {
  test("hello is the first frame and carries the token and client.instance", async () => {
    const { server, client } = setup({
      agent_name: "claude",
      client: { name: "a", kind: "agent" },
    });
    const welcome = await client.connect();
    const first = server.peer.frames[0]?.message;
    expect(first).toEqual({
      type: "hello",
      protocol: 1,
      token: "tok",
      client: { name: "a", kind: "agent", instance: "inst-1" },
      agent_name: "claude",
    });
    expect(server.peer.url).toBe(URL_);
    expect(welcome.session).toBe("session-1");
  });

  test("instance defaults to a UUID; agent_name may be a function read at each hello", async () => {
    let name: string | undefined;
    const { server, client } = setup({ instance: undefined, agent_name: () => name });
    name = "late-name";
    await client.connect();
    const hello = server.peer.hello as { client: { instance: string }; agent_name?: string };
    expect(hello.client.instance).toMatch(UUID);
    expect(hello.agent_name).toBe("late-name");
  });

  test("an absent agent_name is not sent", async () => {
    const { server, client } = setup();
    await client.connect();
    expect(server.peer.hello).not.toHaveProperty("agent_name");
  });

  test("state, connectionError and welcome identity around connect", async () => {
    const { server, client } = setup();
    server.revision = 7;
    server.session = "s-7";
    const states: ClientState[] = [];
    client.on("state", (s) => states.push(s));
    expect(client.state).toBe("idle");
    expect(client.connectionError()?.code).toBe("disconnected");
    expect(client.ready).toBe(false);
    const pending = client.connect();
    expect(client.state).toBe("connecting");
    expect(client.connectionError()?.code).toBe("disconnected");
    await pending;
    expect(client.state).toBe("open");
    expect(client.connectionError()).toBeNull();
    expect(client.ready).toBe(true);
    expect(states).toEqual(["connecting", "open"]);
    expect(client.session).toBe("s-7");
    expect(client.revision).toBe(7);
    expect(client.actor).toEqual({ type: "gm" });
    expect(client.table).toEqual({
      name: "game.json",
      path: "/tables/game.json",
      id: "table-id-1",
    });
    expect(client.boards).toEqual([{ id: "gm_board", name: "GM" }]);
    expect(client.limits?.max_ops).toBe(1000);
  });

  test("connect against a 4401 rejects unauthorized and connectionError reports it", async () => {
    const { client } = setup({ token: "wrong" });
    const error = await failure(client.connect());
    expect(error.code).toBe("unauthorized");
    expect(client.connectionError()?.code).toBe("unauthorized");
    expect(client.state).toBe("idle");
  });

  test("connect against a 4400 rejects protocol_version", async () => {
    const { server, client } = setup();
    server.onHello = () => ({ goodbye: "protocol 1 unsupported", close: 4400 });
    expect((await failure(client.connect())).code).toBe("protocol_version");
    expect(client.connectionError()?.code).toBe("disconnected");
  });

  test("a transport failure rejects connect with disconnected", async () => {
    const { server, client } = setup();
    server.accepting = false;
    expect((await failure(client.connect())).code).toBe("disconnected");
    expect(client.connectionError()?.code).toBe("disconnected");
  });

  test("an unknown key in a welcome is ignored", async () => {
    const { server, client, warnings } = setup();
    server.onHello = () => ({
      welcome: server.welcome({ future: true, table: { ...server.table, extra: 1 } }),
    });
    const welcome = await client.connect();
    expect(welcome).not.toHaveProperty("future");
    expect(client.table).toEqual(server.table);
    expect(warnings).toEqual([]);
  });
});

describe("requests", () => {
  test("ids are a per-client counter; responses correlate out of order", async () => {
    const { server, client } = await connected();
    const a = client.request("get_objects", { ids: ["a"] });
    const b = client.request("list_objects", {});
    const [ra, rb] = server.peer.requests();
    expect([ra?.id, rb?.id]).toEqual(["1", "2"]);
    expect(rb?.method).toBe("list_objects");
    server.peer.respond("2", { revision: 0, objects: [obj("x")], next_cursor: null });
    server.peer.respond("1", { revision: 0, objects: [], missing: ["a"] });
    expect(await a).toEqual({ revision: 0, objects: [], missing: ["a"] });
    expect((await b).objects).toEqual([obj("x")]);
  });

  test("error responses reject with their ProtocolError", async () => {
    const { server, client } = await connected();
    const p = client.request("zones", { board: "nope" });
    const error = { code: "not_found" as const, message: "no board nope", details: { id: "nope" } };
    server.peer.respondError(server.peer.lastRequest().id, error);
    expect(await failure(p)).toEqual(error);
    expect(client.state).toBe("open");
  });

  test("a request while not open rejects disconnected with sent: false and sends nothing", async () => {
    const { server, client } = setup();
    expect(await failure(client.request("get_objects", { ids: ["a"] }))).toMatchObject({
      code: "disconnected",
      details: { sent: false },
    });
    expect(server.peers).toHaveLength(0);
  });

  test("a query times out with timeout; a write times out uncertain", async () => {
    vi.useFakeTimers();
    const { server, client } = await connected({ requestTimeoutMs: 1000 });
    const q = client.request("get_objects", { ids: ["a"] });
    const t = client.transact([{ type: "remove", object: "a" }], { txn_id: "t-1" });
    const u = client.request("undo", { target: { type: "latest" } });
    vi.advanceTimersByTime(999);
    server.peer.respond("1", getObjectsResult());
    await q;
    vi.advanceTimersByTime(1);
    expect(await failure(t)).toEqual({
      code: "uncertain",
      message: expect.any(String),
      details: { sent: true, reason: "timeout", txn_id: "t-1" },
    });
    expect(await failure(u)).toEqual({
      code: "uncertain",
      message: expect.any(String),
      details: { sent: true, reason: "timeout" },
    });
    const q2 = client.request("evaluate", { source: "1" });
    vi.advanceTimersByTime(1000);
    expect((await failure(q2)).code).toBe("timeout");
    // A late response for a timed-out request is ignored with a warning.
    server.peer.respond("4", { revision: 0, value: { type: "number", value: 1 } });
    expect(client.state).toBe("open");
  });

  test("a dropped socket rejects pending queries disconnected and writes uncertain", async () => {
    const { server, client } = await connected();
    const closed: SocketClosedInfo[] = [];
    const q = client.request("get_objects", { ids: ["a"] });
    const t = client.transact([{ type: "remove", object: "a" }], { txn_id: "t-9" });
    const u = client.request("undo", { target: { type: "mine" } });
    client.on("socket_closed", (info) => closed.push(info));
    server.peer.drop();
    expect(await failure(q)).toMatchObject({ code: "disconnected", details: { sent: true } });
    expect(await failure(t)).toMatchObject({
      code: "uncertain",
      details: { sent: true, reason: "socket_closed", txn_id: "t-9" },
    });
    expect(await failure(u)).toMatchObject({
      code: "uncertain",
      details: { sent: true, reason: "socket_closed" },
    });
    expect(client.connectionError()?.code).toBe("disconnected");
    expect(client.state).toBe("idle");
    expect(await failure(client.request("log", {}))).toMatchObject({
      code: "disconnected",
      details: { sent: false },
    });
    expect(server.peer.requests("log")).toHaveLength(0);
    expect(closed).toEqual([{ code: 1006, reason: "", byClose: false }]);
  });

  test("a 4401 close on an open connection sets connectionError unauthorized", async () => {
    const { server, client } = await connected();
    server.peer.close(4401, "unauthorized");
    expect(client.connectionError()?.code).toBe("unauthorized");
  });

  test("transact fills base_revision and a UUID txn_id", async () => {
    const { server, client } = await connected();
    server.peer.send(commit(5));
    const p = client.transact([{ type: "remove", object: "a" }], { label: "zap" });
    const req = server.peer.lastRequest("transact");
    expect(req.params).toEqual({
      base_revision: 5,
      ops: [{ type: "remove", object: "a" }],
      label: "zap",
      txn_id: expect.stringMatching(UUID),
    });
    const result = {
      status: "committed",
      revision: 6,
      index: 5,
      created: [],
      copies: [],
      bindings: {},
    };
    server.peer.respond(req.id, result);
    expect(await p).toEqual(result);
    client.transact([{ type: "remove", object: "b" }], {
      base_revision: 2,
      txn_id: "mine",
      actor: { type: "character", id: "aldric" },
    });
    expect(server.peer.lastRequest("transact").params).toEqual({
      base_revision: 2,
      ops: [{ type: "remove", object: "b" }],
      txn_id: "mine",
      actor: { type: "character", id: "aldric" },
    });
  });
});

describe("result validation", () => {
  test("malformed results and results of another method fail only that request", async () => {
    const { server, client } = await connected();
    const cases: [Promise<unknown>, string, unknown][] = [
      [client.request("get_objects", { ids: ["a"] }), "get_objects", { revision: 0, objects: [] }],
      [client.request("list_objects", {}), "list_objects", subscribeResult("s1", 0)],
      [client.request("get_objects", { ids: ["a"] }), "get_objects", {}],
    ];
    for (const [i, [, , result]] of cases.entries()) server.peer.respond(String(i + 1), result);
    for (const [p, method] of cases) {
      expect(await failure(p)).toEqual({
        code: "internal",
        message: expect.any(String),
        details: { type: "protocol", method },
      });
    }
    expect(client.state).toBe("open");
    const later = client.request("get_objects", { ids: ["a"] });
    server.peer.respond(server.peer.lastRequest().id, getObjectsResult(0));
    expect(await later).toEqual(getObjectsResult(0));
  });

  test("a malformed subscribe result creates no mirror", async () => {
    const ctx = await connected();
    const p = ctx.client.subscribe({ scope: { type: "all" } });
    ctx.server.peer.respond(ctx.server.peer.lastRequest().id, { subscription: "s1", revision: 0 });
    expect((await failure(p)).details).toEqual({ type: "protocol", method: "subscribe" });
    expect(ctx.client.liveSubscriptions()).toEqual([]);
    // A delta naming that id is not applied anywhere.
    ctx.server.peer.send(commit(1, [delta("s1", { objects: [obj("a")] })]));
    expect(ctx.client.revision).toBe(1);
  });

  test("unknown keys in a result and an object view are ignored", async () => {
    const { server, client, warnings } = await connected();
    const p = client.request("get_objects", { ids: ["a"] });
    server.peer.respond("1", {
      revision: 0,
      objects: [{ ...obj("a", 3), glow: "red" }],
      missing: [],
      cursor_v2: "x",
    });
    expect(await p).toEqual({ revision: 0, objects: [obj("a", 3)], missing: [] });
    expect(warnings).toEqual([]);
  });
});

/** The `ProtocolFailure` a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<ProtocolFailure> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolFailure);
    return e as ProtocolFailure;
  }
  throw new Error("expected a rejection");
}

describe("local failures are tagged", () => {
  test("ProtocolFailure is not local unless constructed so", () => {
    expect(new ProtocolFailure("not_found", "x").local).toBe(false);
    expect(new ProtocolFailure("timeout", "x", { sent: true }).local).toBe(false);
    const local = new ProtocolFailure("timeout", "x", { sent: true }, { local: true });
    expect(local.local).toBe(true);
    expect(local.error).toEqual({ code: "timeout", message: "x", details: { sent: true } });
  });

  test("an error response from the server is not local", async () => {
    const { server, client } = await connected();
    const p = client.request("zones", { board: "nope" });
    server.peer.respondError(server.peer.lastRequest().id, { code: "not_found", message: "no" });
    const e = await rejection(p);
    expect(e.error.code).toBe("not_found");
    expect(e.local).toBe(false);
  });

  test("a request while not connected fails local disconnected", async () => {
    const { client } = setup();
    const e = await rejection(client.request("get_objects", { ids: ["a"] }));
    expect(e.error).toMatchObject({ code: "disconnected", details: { sent: false } });
    expect(e.local).toBe(true);
  });

  test("a send that throws fails local disconnected", async () => {
    const { server, client } = await connected();
    vi.spyOn(server.peer.socket, "send").mockImplementation(() => {
      throw new Error("socket refused the write");
    });
    const e = await rejection(client.request("get_objects", { ids: ["a"] }));
    expect(e.error).toMatchObject({ code: "disconnected", details: { sent: false } });
    expect(e.local).toBe(true);
  });

  test("timeouts are local: timeout for a query, uncertain for a write", async () => {
    vi.useFakeTimers();
    const { client } = await connected({ requestTimeoutMs: 1000 });
    const q = rejection(client.request("get_objects", { ids: ["a"] }));
    const t = rejection(client.transact([{ type: "remove", object: "a" }], { txn_id: "t-1" }));
    vi.advanceTimersByTime(1000);
    const [eq, et] = await Promise.all([q, t]);
    expect(eq.error.code).toBe("timeout");
    expect(eq.local).toBe(true);
    expect(et.error.code).toBe("uncertain");
    expect(et.local).toBe(true);
  });

  test("a dropped socket's failures are local: disconnected and uncertain", async () => {
    const { server, client } = await connected();
    const q = rejection(client.request("get_objects", { ids: ["a"] }));
    const t = rejection(client.transact([{ type: "remove", object: "a" }], { txn_id: "t-1" }));
    server.peer.drop();
    const [eq, et] = await Promise.all([q, t]);
    expect(eq.error).toMatchObject({ code: "disconnected", details: { sent: true } });
    expect(eq.local).toBe(true);
    expect(et.error.code).toBe("uncertain");
    expect(et.local).toBe(true);
  });

  test("a malformed result fails local internal, also through rebind", async () => {
    const ctx = await connected();
    const p = ctx.client.request("get_objects", { ids: ["a"] });
    ctx.server.peer.respond(ctx.server.peer.lastRequest().id, {});
    const e = await rejection(p);
    expect(e.error.code).toBe("internal");
    expect(e.local).toBe(true);
    const a = await subscribed(ctx, subscribeResult("s1", 0));
    const info = { from_revision: 0, to_revision: 0, session_changed: false };
    let thrown: unknown;
    try {
      a.rebind("s2", { subscription: "s2" } as unknown as SubscribeResult, info);
    } catch (x) {
      thrown = x;
    }
    expect(thrown).toBeInstanceOf(ProtocolFailure);
    expect((thrown as ProtocolFailure).local).toBe(true);
  });

  test("connection failures are local", async () => {
    const { server, client } = setup();
    server.accepting = false;
    const e = await rejection(client.connect());
    expect(e.error.code).toBe("disconnected");
    expect(e.local).toBe(true);
  });

  test.each(["disconnected", "timeout"] as const)(
    "a server response coded %s (client-only) fails the request internal, protocol",
    async (code) => {
      const { server, client, warnings } = await connected();
      const p = client.request("get_objects", { ids: ["a"] });
      server.peer.respondError(server.peer.lastRequest().id, {
        code,
        message: "server says so",
        details: { sent: true },
      });
      const e = await rejection(p);
      expect(e.error).toEqual({
        code: "internal",
        message: expect.stringContaining(code),
        details: { type: "protocol", method: "get_objects" },
      });
      expect(e.local).toBe(true);
      expect(client.state).toBe("open");
      expect(server.peer.closedByClient).toBeNull();
      expect(warnings).toEqual([]);
      const later = client.request("get_objects", { ids: ["a"] });
      server.peer.respond(server.peer.lastRequest().id, getObjectsResult(0));
      expect(await later).toEqual(getObjectsResult(0));
    },
  );
});

describe("forward compatibility and envelopes", () => {
  test("unknown event kinds and message types are ignored with a warning", async () => {
    const { server, client, warnings } = await connected();
    server.peer.send({ type: "event", event: "presence", who: "x" });
    server.peer.send({ type: "telemetry", n: 1 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/presence/);
    expect(warnings[1]).toMatch(/telemetry/);
    expect(client.state).toBe("open");
    expect(server.peer.closedByClient).toBeNull();
    const p = client.request("get_objects", { ids: ["a"] });
    server.peer.respond("1", getObjectsResult());
    await p;
  });

  test("a known envelope with a missing required field closes the socket", async () => {
    const { server, client, warnings } = await connected();
    const closed: SocketClosedInfo[] = [];
    client.on("socket_closed", (info) => closed.push(info));
    const p = client.request("get_objects", { ids: ["a"] });
    const { revision: _r, ...noRevision } = commit(1);
    server.peer.send(noRevision);
    expect(server.peer.closedByClient?.code).toBe(4400);
    expect(await failure(p)).toMatchObject({ code: "disconnected", details: { sent: true } });
    expect(client.connectionError()?.code).toBe("disconnected");
    expect(closed).toEqual([{ code: 4400, reason: expect.any(String), byClose: false }]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a save event is emitted to save listeners", async () => {
    const { server, client } = await connected();
    const saves: unknown[] = [];
    client.on("save", (e) => saves.push(e));
    server.peer.send({ type: "event", event: "save", status: "saved", revision: 2, extra: 1 });
    expect(saves).toEqual([{ type: "event", event: "save", status: "saved", revision: 2 }]);
  });
});

describe("commit events and subscriptions", () => {
  test("revision, session and table follow welcome and commit events; boards follow both", async () => {
    const { server, client } = await connected();
    const commits: unknown[] = [];
    client.on("commit", (e) => commits.push(e));
    server.peer.send(commit(1));
    expect(client.revision).toBe(1);
    expect(client.boards).toEqual([{ id: "gm_board", name: "GM" }]);
    const boards = [{ id: "gm_board", name: "GM" }, { id: "cave" }];
    server.peer.send(commit(2, [], { boards }));
    expect(client.revision).toBe(2);
    expect(client.boards).toEqual(boards);
    expect(commits).toHaveLength(2);
    // A new connection's welcome replaces session, table and revision.
    server.peer.drop();
    server.session = "session-2";
    server.revision = 40;
    server.table = { name: "other.json", path: "/t/other.json", id: "table-id-2" };
    await client.reopen();
    expect(client.session).toBe("session-2");
    expect(client.revision).toBe(40);
    expect(client.table).toEqual(server.table);
  });

  test("delta listeners get before/after and see the mirror updated; commit listeners run last", async () => {
    const ctx = await connected();
    const sub = await subscribed(
      ctx,
      subscribeResult("s1", 0, { objects: [obj("a", 1), obj("b")] }),
    );
    expect(sub.id).toBe("s1");
    expect(sub.state).toBe("live");
    expect(sub.params).toEqual({ scope: { type: "board", board: "map" } });
    expect([...sub.mirror.objects.keys()]).toEqual(["a", "b"]);
    const calls: string[] = [];
    let seen: DeltaEvent | undefined;
    sub.on("delta", (s, e) => {
      expect(s).toBe(sub);
      expect(sub.mirror.objects.get("a")).toEqual(obj("a", 2));
      expect(sub.mirror.objects.has("b")).toBe(false);
      expect(sub.mirror.revision).toBe(1);
      seen = e;
      calls.push("delta");
    });
    ctx.client.on("commit", () => calls.push("commit"));
    ctx.server.peer.send(commit(1, [delta("s1", { objects: [obj("a", 2)], removed: ["b"] })]));
    expect(calls).toEqual(["delta", "commit"]);
    expect(seen?.revision).toBe(1);
    expect(seen?.group.index).toBe(0);
    expect(seen?.before).toEqual(
      new Map([
        ["a", obj("a", 1)],
        ["b", obj("b")],
      ]),
    );
    expect(seen?.after).toEqual(
      new Map([
        ["a", obj("a", 2)],
        ["b", undefined],
      ]),
    );
  });

  test("a commit with deltas: [] advances every live mirror", async () => {
    const ctx = await connected();
    const a = await subscribed(ctx, subscribeResult("s1", 0));
    const b = await subscribed(ctx, subscribeResult("s2", 0), { scope: { type: "log" } });
    ctx.server.peer.send(commit(1, [delta("s1", { objects: [obj("x")] })]));
    expect([a.mirror.revision, b.mirror.revision]).toEqual([1, 1]);
    ctx.server.peer.send(commit(2, []));
    expect([a.mirror.revision, b.mirror.revision, ctx.client.revision]).toEqual([2, 2, 2]);
    expect(a.mirror.objects.has("x")).toBe(true);
  });

  test("a commit event that arrives right after the subscribe response is applied", async () => {
    const ctx = await connected();
    const p = ctx.client.subscribe({ scope: { type: "all" } });
    const id = ctx.server.peer.lastRequest().id;
    ctx.server.peer.respond(id, subscribeResult("s1", 0));
    ctx.server.peer.send(commit(1, [delta("s1", { objects: [obj("a")] })]));
    const sub = await p;
    expect(sub.mirror.objects.has("a")).toBe(true);
    expect(sub.mirror.revision).toBe(1);
  });

  test("subscription close sends unsubscribe; a failed subscription closes without a request", async () => {
    const ctx = await connected();
    const sub = await subscribed(ctx, subscribeResult("s1", 0));
    const closing = sub.close();
    const req = ctx.server.peer.lastRequest("unsubscribe");
    expect(req.params).toEqual({ subscription: "s1" });
    ctx.server.peer.respond(req.id, {});
    await closing;
    expect(sub.state).toBe("closed");
    expect(ctx.client.liveSubscriptions()).toEqual([]);
    ctx.server.peer.send(commit(1, [delta("s1", { objects: [obj("a")] })]));
    expect(sub.mirror.objects.size).toBe(0);
    expect(sub.mirror.revision).toBe(0);

    const other = await subscribed(ctx, subscribeResult("s2", 1));
    other.fail({ code: "not_found", message: "gone" });
    const before = ctx.server.peer.requests().length;
    await other.close();
    expect(ctx.server.peer.requests()).toHaveLength(before);
    expect(other.state).toBe("closed");
  });

  test("a listener that throws is reported and does not stop the others", async () => {
    const { server, client, warnings } = await connected();
    const seen: number[] = [];
    client.on("commit", () => {
      throw new Error("boom");
    });
    client.on("commit", (e) => seen.push(e.revision));
    server.peer.send(commit(1));
    expect(seen).toEqual([1]);
    expect(warnings.some((w) => w.includes("boom"))).toBe(true);
  });

  test("on returns an unsubscribe function", async () => {
    const { server, client } = await connected();
    const seen: number[] = [];
    const off = client.on("commit", (e) => seen.push(e.revision));
    server.peer.send(commit(1));
    off();
    server.peer.send(commit(2));
    expect(seen).toEqual([1]);
  });
});

describe("close", () => {
  test("close() is terminal: state closed, socket closed, nothing further", async () => {
    const ctx = await connected();
    const sub = await subscribed(ctx, subscribeResult("s1", 0));
    const pending = ctx.client.request("log", {});
    const closed: SocketClosedInfo[] = [];
    ctx.client.on("socket_closed", (info) => closed.push(info));
    ctx.client.close();
    expect(ctx.client.state).toBe("closed");
    expect(ctx.server.peer.closedByClient?.code).toBe(1000);
    expect((await failure(pending)).code).toBe("disconnected");
    expect(closed).toEqual([{ code: 1000, reason: expect.any(String), byClose: true }]);
    expect(ctx.client.connectionError()?.code).toBe("disconnected");
    expect(sub.state).toBe("closed");
    expect((await failure(ctx.client.request("log", {}))).details).toEqual({ sent: false });
    expect((await failure(ctx.client.connect())).code).toBe("disconnected");
    expect((await failure(ctx.client.reopen())).code).toBe("disconnected");
    await flush();
    expect(ctx.server.peers).toHaveLength(1);
  });
});

describe("close is terminal through the seam", () => {
  const seamCalls: [string, (client: ProtocolClient) => void][] = [
    ["setState idle", (c) => c.setState("idle")],
    ["setState connecting", (c) => c.setState("connecting")],
    ["setState open", (c) => c.setState("open")],
    ["setState reconnecting", (c) => c.setState("reconnecting")],
    ["setState recovering", (c) => c.setState("recovering")],
    ["setState closed", (c) => c.setState("closed")],
    ["setConnectionError null", (c) => c.setConnectionError(null)],
    ["abortSocket", (c) => c.abortSocket("x")],
  ];

  for (const [name, call] of seamCalls) {
    test(`after close(), ${name} then connect() and reopen() construct no socket`, async () => {
      const { server, client } = await connected();
      client.close();
      call(client);
      expect(client.state).toBe("closed");
      for (const attempt of [
        client.connect(),
        client.reopen(),
        client.reopen({ url: "ws://127.0.0.1:1/ws", token: "t" }),
        client.requestDuringRecovery("log", {}),
        client.request("log", {}),
      ]) {
        expect(await failure(attempt)).toMatchObject({
          code: "disconnected",
          details: { sent: false },
        });
      }
      await flush();
      expect(server.peers).toHaveLength(1);
      expect(server.received.filter((f) => f.message.type === "hello")).toHaveLength(1);
      expect(client.state).toBe("closed");
    });
  }

  test("a never-connected client closed stays closed through the seam", async () => {
    const { server, client } = setup();
    client.close();
    client.setState("idle");
    expect(client.state).toBe("closed");
    expect((await failure(client.connect())).details).toEqual({ sent: false });
    expect((await failure(client.reopen())).details).toEqual({ sent: false });
    await flush();
    expect(server.peers).toHaveLength(0);
  });
});

describe("goodbye refuses the handshake", () => {
  test("goodbye without a close rejects at once; the client closes the socket later", async () => {
    vi.useFakeTimers();
    const { server, client } = setup();
    server.onHello = () => undefined;
    const closed: SocketClosedInfo[] = [];
    client.on("socket_closed", (info) => closed.push(info));
    const pending = client.connect();
    await flush();
    server.peer.send({ type: "goodbye", reason: "unauthorized" });
    expect(await failure(pending)).toMatchObject({ code: "unauthorized" });
    expect(client.connectionError()?.code).toBe("unauthorized");
    expect(client.state).toBe("idle");
    expect(server.peer.closedByClient).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(server.peer.closedByClient?.code).toBe(1000);
    await flush();
    expect(closed).toEqual([]);
    // The refused socket does not block a new attempt.
    server.onHello = () => ({ welcome: server.welcome() });
    await client.reopen();
    expect(server.peers).toHaveLength(2);
  });

  test("goodbye then welcome: the welcome is ignored", async () => {
    const { server, client } = setup();
    server.onHello = () => undefined;
    const pending = client.connect();
    await flush();
    const refused = server.peer;
    refused.send({ type: "goodbye", reason: "protocol 2 is not supported" });
    refused.send(server.welcome());
    expect((await failure(pending)).code).toBe("protocol_version");
    expect(client.session).toBeNull();
    expect(client.state).toBe("idle");
    expect(client.connectionError()?.code).toBe("disconnected");
    refused.close(4400, "protocol");
    expect(client.connectionError()?.code).toBe("disconnected");
    expect(client.state).toBe("idle");
  });

  test("a goodbye during reopen rejects reopen and leaves state and error alone", async () => {
    const { server, client } = await connected();
    server.peer.drop();
    server.onHello = () => undefined;
    const pending = client.reopen();
    await flush();
    server.peer.send({ type: "goodbye", reason: "invalid token" });
    expect((await failure(pending)).code).toBe("unauthorized");
    expect(client.connectionError()?.code).toBe("disconnected");
    server.peer.close(4401, "unauthorized");
    expect(client.connectionError()?.code).toBe("disconnected");
  });

  test("the close code that follows a goodbye is authoritative for connectionError", async () => {
    const { server, client } = setup();
    server.onHello = () => undefined;
    const pending = client.connect();
    await flush();
    server.peer.send({ type: "goodbye", reason: "go away" });
    expect((await failure(pending)).code).toBe("disconnected");
    expect(client.connectionError()?.code).toBe("disconnected");
    server.peer.close(4401, "unauthorized");
    expect(client.connectionError()?.code).toBe("unauthorized");
  });
});

describe("close during connect", () => {
  test("close() while connecting rejects connect with disconnected", async () => {
    const { server, client } = setup();
    const pending = client.connect();
    client.close();
    expect((await failure(pending)).code).toBe("disconnected");
    expect(client.state).toBe("closed");
    await flush();
    expect(server.peer.closedByClient?.code).toBe(1000);
  });
});

describe("recovery seam", () => {
  test("requestDuringRecovery works in state recovering while request rejects", async () => {
    const { server, client } = await connected();
    client.setState("recovering");
    expect(client.state).toBe("recovering");
    expect(await failure(client.request("get_objects", { ids: ["a"] }))).toMatchObject({
      code: "disconnected",
      details: { sent: false },
    });
    const p = client.requestDuringRecovery("get_objects", { ids: ["a"] });
    server.peer.respond(server.peer.lastRequest().id, { revision: 0, objects: [] });
    expect((await failure(p)).details).toEqual({ type: "protocol", method: "get_objects" });
    const q = client.requestDuringRecovery("get_objects", { ids: ["a"] });
    server.peer.respond(server.peer.lastRequest().id, getObjectsResult());
    expect(await q).toEqual(getObjectsResult());
  });

  test("requestDuringRecovery times out like request", async () => {
    vi.useFakeTimers();
    const { client } = await connected({ requestTimeoutMs: 50 });
    client.setState("recovering");
    const p = client.requestDuringRecovery("subscribe", { scope: { type: "all" } });
    vi.advanceTimersByTime(50);
    expect((await failure(p)).code).toBe("timeout");
  });

  test("abortSocket closes an open socket, rejects pending, emits socket_closed, leaves idle; reopen connects", async () => {
    const { server, client } = await connected();
    const closed: SocketClosedInfo[] = [];
    client.on("socket_closed", (info) => closed.push(info));
    const q = client.request("log", {});
    const t = client.transact([{ type: "remove", object: "a" }], { txn_id: "t1" });
    client.abortSocket("resubscribe_timeout");
    expect(server.peer.closedByClient).toEqual({ code: 4000, reason: "resubscribe_timeout" });
    expect(await failure(q)).toMatchObject({ code: "disconnected", details: { sent: true } });
    expect(await failure(t)).toMatchObject({
      code: "uncertain",
      details: { reason: "socket_closed", txn_id: "t1" },
    });
    expect(closed).toEqual([{ code: 4000, reason: "resubscribe_timeout", byClose: false }]);
    expect(client.state).toBe("idle");
    await flush();
    expect(closed).toHaveLength(1);
    const welcome = await client.reopen();
    expect(welcome.type).toBe("welcome");
    expect(server.peers).toHaveLength(2);
    expect(server.peer.hello).toMatchObject({ client: { instance: "inst-1" } });
  });

  test("reopen after a drop sends the same instance and leaves connectionError set", async () => {
    const { server, client } = await connected();
    server.peer.drop();
    expect(client.connectionError()?.code).toBe("disconnected");
    server.token = "tok2";
    await client.reopen({ url: "ws://127.0.0.1:4748/ws", token: "tok2" });
    expect(server.peer.url).toBe("ws://127.0.0.1:4748/ws");
    expect(server.peer.hello).toMatchObject({ token: "tok2", client: { instance: "inst-1" } });
    expect(client.connectionError()?.code).toBe("disconnected");
    client.setConnectionError({ code: "disconnected", message: "resubscribing", recovering: true });
    expect(client.connectionError()).toEqual({
      code: "disconnected",
      message: "resubscribing",
      recovering: true,
    });
    client.setState("open");
    expect(client.ready).toBe(false);
    client.setConnectionError(null);
    expect(client.ready).toBe(true);
    // The new credentials are kept for the next reopen.
    server.peer.drop();
    await client.reopen();
    expect(server.peer.url).toBe("ws://127.0.0.1:4748/ws");
  });

  test("credentials reports the pair in use, updated by a reopen with new credentials", async () => {
    const { server, client } = await connected();
    const before = client.credentials;
    expect(before).toEqual({ url: URL_, token: "tok" });
    server.peer.drop();
    server.token = "tok2";
    await client.reopen({ url: "ws://127.0.0.1:4748/ws", token: "tok2" });
    expect(client.credentials).toEqual({ url: "ws://127.0.0.1:4748/ws", token: "tok2" });
    // A snapshot: the earlier value is unchanged and not shared.
    expect(before).toEqual({ url: URL_, token: "tok" });
    // A reopen without credentials keeps the pair.
    server.peer.drop();
    await client.reopen();
    expect(client.credentials).toEqual({ url: "ws://127.0.0.1:4748/ws", token: "tok2" });
  });

  test("reopen rejects with the close code's error", async () => {
    const { server, client } = await connected();
    server.peer.drop();
    server.token = "rotated";
    expect((await failure(client.reopen())).code).toBe("unauthorized");
    // A failed attempt leaves state and connection error to the caller (recovery).
    expect(client.connectionError()?.code).toBe("disconnected");
    expect(client.state).toBe("idle");
    server.accepting = false;
    expect((await failure(client.reopen())).code).toBe("disconnected");
  });

  test("connect that never succeeded can be retried through reopen", async () => {
    const { server, client } = setup();
    server.accepting = false;
    await failure(client.connect());
    server.accepting = true;
    await client.reopen();
    expect(client.session).toBe("session-1");
    expect(client.connectionError()?.code).toBe("disconnected");
  });

  test("liveSubscriptions, markRecovering, rebind and fail", async () => {
    const ctx = await connected();
    const a = await subscribed(ctx, subscribeResult("s1", 0, { objects: [obj("a")] }));
    const b = await subscribed(ctx, subscribeResult("s2", 0, { objects: [obj("b")] }), {
      scope: { type: "board", board: "cave" },
    });
    expect(ctx.client.liveSubscriptions()).toEqual([a, b]);
    const resyncs: ResyncInfo[] = [];
    const errors: ProtocolError[] = [];
    a.on("resync", (s, info) => {
      expect(s).toBe(a);
      resyncs.push(info);
    });
    b.on("error", (_s, e) => errors.push(e));

    ctx.server.peer.drop();
    a.markRecovering();
    b.markRecovering();
    expect(a.state).toBe("recovering");
    expect(a.mirror.objects.has("a")).toBe(true);
    expect(ctx.client.liveSubscriptions()).toEqual([a, b]);

    ctx.server.revision = 5;
    await ctx.client.reopen();
    ctx.client.setState("recovering");
    const info = { from_revision: 0, to_revision: 5, session_changed: false };
    a.rebind("s9", subscribeResult("s9", 5, { objects: [obj("z")] }), info);
    expect(a.id).toBe("s9");
    expect(a.state).toBe("live");
    expect(resyncs).toEqual([info]);
    expect([...a.mirror.objects.keys()]).toEqual(["z"]);
    expect(a.mirror.revision).toBe(5);

    b.fail(new ProtocolFailure("not_found", "no board cave"));
    b.fail({ code: "not_found", message: "again" });
    expect(errors).toEqual([{ code: "not_found", message: "no board cave" }]);
    expect(b.state).toBe("failed");
    expect(b.mirror.objects.size).toBe(0);
    expect(ctx.client.liveSubscriptions()).toEqual([a]);

    // Deltas follow the new id.
    ctx.server.peer.send(commit(6, [delta("s9", { objects: [obj("y")] })]));
    expect(a.mirror.objects.has("y")).toBe(true);
    expect(a.mirror.revision).toBe(6);
  });

  test("rebind validates the result with parseResult", async () => {
    const ctx = await connected();
    const a = await subscribed(ctx, subscribeResult("s1", 0, { objects: [obj("a")] }));
    const info = { from_revision: 0, to_revision: 0, session_changed: false };
    const malformed = { subscription: "s2" } as unknown as SubscribeResult;
    expect(() => a.rebind("s2", malformed, info)).toThrow(ProtocolFailure);
    expect(a.id).toBe("s1");
    expect(a.mirror.objects.has("a")).toBe(true);
  });

  test("subscriptions of a dead connection are not fed by the new one until rebound", async () => {
    const ctx = await connected();
    const a = await subscribed(ctx, subscribeResult("s1", 0, { objects: [obj("a")] }));
    ctx.server.peer.drop();
    await ctx.client.reopen();
    // The new connection reuses "s1" for someone else's subscription.
    ctx.server.peer.send(commit(1, [delta("s1", { removed: ["a"] })]));
    expect(a.mirror.objects.has("a")).toBe(true);
    expect(a.mirror.revision).toBe(0);
  });

  test("setState('closed') closes the client and keeps the connection error", async () => {
    const { server, client } = await connected();
    client.setConnectionError({ code: "wrong_table", message: "another table" });
    client.setState("closed");
    expect(client.state).toBe("closed");
    expect(client.connectionError()).toEqual({ code: "wrong_table", message: "another table" });
    expect(server.peer.closedByClient?.code).toBe(1000);
  });

  test("setState emits state; setConnectionError emits state with the current state", async () => {
    const { client } = await connected();
    const states: ClientState[] = [];
    client.on("state", (s) => states.push(s));
    client.setState("reconnecting");
    client.setConnectionError({ code: "wrong_table", message: "other table" });
    expect(states).toEqual(["reconnecting", "reconnecting"]);
    expect(client.connectionError()?.code).toBe("wrong_table");
  });
});

describe("browser safety", () => {
  test("the platform WebSocket fits the WebSocket option", () => {
    const platform: WebSocketConstructor = WebSocket;
    expect(typeof platform).toBe("function");
  });

  test("client.ts and mirror.ts import no node: modules", () => {
    for (const file of ["client.ts", "mirror.ts"]) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/from\s+["']node:/);
      expect(text, file).not.toMatch(/import\(\s*["']node:/);
      expect(text, file).not.toMatch(/require\(\s*["']node:/);
    }
  });
});
