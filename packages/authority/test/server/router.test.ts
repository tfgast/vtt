import {
  createSubscriptionHub,
  type RequestContext,
  ROUTES,
  type RouterDeps,
  routeRequest,
  TxnCache,
} from "@vtt/authority";
import { ProtocolFailure, type RequestMessage } from "@vtt/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, connect, memoryHost, RawClient, serve, setHp } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

/** The ProtocolError a client request rejects with. */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolFailure);
    return (e as ProtocolFailure).error;
  }
  throw new Error("expected a rejection");
}

describe("routing over a real server", () => {
  test("queries, explain and subscriptions reach their modules", async () => {
    const { server } = await serve();
    const c = await connect(server);
    expect((await c.request("list_objects", { limit: 2 })).objects.map((o) => o.id)).toEqual([
      "bag",
      "chest",
    ]);
    const got = await c.request("get_objects", { ids: ["goblin", "nobody"] });
    expect(got.missing).toEqual(["nobody"]);
    expect(got.objects[0]?.cells.hp?.value).toEqual({ type: "number", value: 7 });
    expect((await c.request("evaluate", { source: "1 + 2" })).value).toEqual({
      type: "number",
      value: 3,
    });
    expect((await c.request("zones", { board: "map" })).zones).toEqual([]);
    expect(await failure(c.request("zones", { board: "nowhere" }))).toMatchObject({
      code: "not_found",
    });
    expect((await c.request("at_position", { board: "map", position: [1, 2] })).objects).toEqual([
      "goblin",
    ]);
    expect((await c.request("changes_since", { revision: 3 })).groups).toEqual([]);
    expect((await c.request("log", {})).groups).toEqual([]);
    expect((await c.request("document", {})).snapshot.revision).toBe(3);
    expect((await c.request("explain_cell", { object: "goblin", cell: "hp" })).view.value).toEqual({
      type: "number",
      value: 7,
    });
    expect(await failure(c.request("explain_group", { index: 0 }))).toMatchObject({
      code: "not_found",
    });
    expect(
      await failure(c.request("explain_action", { object: "goblin", action: "nope" })),
    ).toMatchObject({ code: "not_found" });
    const sub = await c.request("subscribe", { scope: { type: "board", board: "shelf" } });
    expect(sub).toMatchObject({ revision: 3, objects: [], covers: [] });
    expect(await c.request("unsubscribe", { subscription: sub.subscription })).toEqual({});
    expect(
      await failure(c.request("unsubscribe", { subscription: sub.subscription })),
    ).toMatchObject({ code: "not_found" });
    const log = await c.request("subscribe", { scope: { type: "log" } });
    expect(log.groups).toEqual([]);
  });

  test("transact and undo use the connection's actor and kind", async () => {
    const { server, host } = await serve();
    const agent = await connect(server, {
      client: { name: "bot", kind: "agent" },
      agent_name: "Claude",
    });
    const gm = await connect(server, { client: { name: "ui", kind: "ui" } });
    const r = await agent.transact(setHp(agent.revision, 2).ops as never);
    expect(r).toMatchObject({ status: "committed", revision: 4 });
    expect(host.table.store.history.groups.at(-1)?.actor).toEqual({
      type: "agent",
      name: "Claude",
    });
    expect(await gm.request("undo", { target: { type: "mine" } })).toMatchObject({
      status: "rejected",
      rejection: { type: "nothing_to_undo" },
    });
    expect(await agent.request("undo", { target: { type: "mine" } })).toMatchObject({
      status: "committed",
      revision: 5,
    });
    // An agent passing `actor` is bad_request (PROTOCOL.md §3).
    expect(
      await failure(
        agent.request("transact", {
          ...setHp(agent.revision, 1),
          actor: { type: "character", id: "goblin" },
        } as never),
      ),
    ).toMatchObject({ code: "bad_request" });
  });

  test("txn_id deduplication is per client instance", async () => {
    const { server, host } = await serve();
    const a = await connect(server, { instance: "inst-a" });
    const b = await connect(server, { instance: "inst-b" });
    const ra = await a.request("transact", setHp(3, 1, { txn_id: "t1" }) as never);
    const rb = await b.request("transact", setHp(3, 2, { txn_id: "t1" }) as never);
    expect(ra).toMatchObject({ status: "committed", revision: 4 });
    expect(rb).toMatchObject({ status: "committed", revision: 5 });
    const again = await a.request("transact", setHp(3, 1, { txn_id: "t1" }) as never);
    expect(again).toEqual(ra);
    expect(host.revision).toBe(5);
    // A reconnect with the same instance still finds it (one server-wide cache).
    const a2 = await connect(server, { instance: "inst-a" });
    const retried = await a2.request(
      "transact",
      setHp(3, 1, { txn_id: "t1", retry: true }) as never,
    );
    expect(retried).toEqual(ra);
    expect(
      await failure(a2.request("transact", setHp(5, 1, { txn_id: "t9", retry: true }) as never)),
    ).toMatchObject({ code: "retry_unknown" });
    expect(host.revision).toBe(5);
  });

  test("invoke answers unsupported", async () => {
    const { server } = await serve();
    const c = await connect(server);
    expect(
      await failure(c.request("invoke", { object: "goblin", action: "a", base_revision: 3 })),
    ).toMatchObject({ code: "unsupported" });
  });

  test("an unknown method answers unknown_method", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    raw.request("m1", "frobnicate", {});
    expect(await raw.response("m1")).toMatchObject({
      ok: false,
      error: { code: "unknown_method" },
    });
  });

  test("a handler that throws answers internal; the connection survives", async () => {
    const { server, host } = await serve();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const save = vi.spyOn(host, "save");
    const raw = await RawClient.open(server);
    save.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    raw.request("s1", "save");
    expect(await raw.response("s1")).toMatchObject({ ok: false, error: { code: "internal" } });
    save.mockImplementationOnce(() => Promise.reject(new Error("later boom")));
    raw.request("s2", "save");
    expect(await raw.response("s2")).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(logged.mock.calls.some((args) => args.join(" ").includes("s1"))).toBe(true);
    expect(logged.mock.calls.some((args) => args.join(" ").includes("s2"))).toBe(true);
    raw.request("q", "list_objects", {});
    expect(await raw.response("q")).toMatchObject({ ok: true });
  });

  test("save on an in-memory table answers failed after its save event", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    raw.request("s", "save");
    const response = await raw.response("s");
    expect(response).toMatchObject({
      ok: true,
      result: { status: "failed", revision: 3, message: "no file" },
    });
    const event = raw.indexOf((f) => f.type === "event" && f.event === "save");
    expect(event).toBeGreaterThan(-1);
    expect(event).toBeLessThan(raw.indexOf((f) => f.id === "s"));
  });
});

describe("routeRequest", () => {
  function deps(): RouterDeps {
    const host = memoryHost();
    return { host, hub: createSubscriptionHub(host.table), txns: new TxnCache() };
  }
  const ctx: RequestContext = { conn: "c1", actor: { type: "gm" }, kind: "test", instance: "i1" };
  const req = (method: string, params: unknown = {}) =>
    ({ type: "request", id: "r1", method, params }) as RequestMessage;

  test("has a route for every method", () => {
    expect(Object.keys(ROUTES).sort()).toEqual(
      [
        "transact",
        "undo",
        "invoke",
        "save",
        "list_objects",
        "get_objects",
        "evaluate",
        "zones",
        "at_position",
        "changes_since",
        "log",
        "document",
        "explain_cell",
        "explain_group",
        "explain_action",
        "subscribe",
        "unsubscribe",
      ].sort(),
    );
  });

  test("synchronous methods answer synchronously; save answers with a promise", async () => {
    const d = deps();
    const out = routeRequest(d, ctx, req("list_objects", { limit: 1 }));
    expect(out).toMatchObject({ ok: true, result: { revision: 3 } });
    const saved = routeRequest(d, ctx, req("save"));
    expect(saved).toBeInstanceOf(Promise);
    expect(await saved).toMatchObject({ ok: true, result: { status: "failed" } });
  });

  test("ProtocolFailure maps to its error; other exceptions to internal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = deps();
    expect(routeRequest(d, ctx, req("invoke", {}))).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    const routes = {
      ...ROUTES,
      log: () => {
        throw new TypeError("bad");
      },
      save: () => Promise.reject(new ProtocolFailure("busy", "later")),
    };
    expect(routeRequest(d, ctx, req("log"), routes)).toEqual({
      ok: false,
      error: { code: "internal", message: expect.any(String) },
    });
    expect(await routeRequest(d, ctx, req("save"), routes)).toEqual({
      ok: false,
      error: { code: "busy", message: "later" },
    });
  });
});
