import { request as httpRequest } from "node:http";
import { startServer } from "@vtt/authority";
import { DEFAULT_PORT, LIMITS, ProtocolFailure } from "@vtt/protocol";
import { afterEach, describe, expect, test } from "vitest";
import WebSocketClient from "ws";
import { cleanup, connect, helloFor, memoryHost, RawClient, serve, setHp, until } from "./helpers";

afterEach(cleanup);

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens a `ws` client with an Origin header; resolves with "open" or the refusal status. */
function upgradeWithOrigin(url: string, origin: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocketClient(url, { origin });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("error", () => undefined);
  });
}

describe("startServer", () => {
  test("listens on a free port with url, token and session", async () => {
    const { server } = await serve();
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(DEFAULT_PORT);
    expect(server.url).toBe(`ws://127.0.0.1:${server.port}/ws`);
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.session.length).toBeGreaterThan(0);
  });

  test("a non-loopback hostname is refused before anything listens", async () => {
    const host = memoryHost();
    for (const hostname of ["0.0.0.0", "::", "192.168.1.10", "example.test", ""]) {
      await expect(startServer({ host, port: 0, hostname })).rejects.toThrow(/127\.0\.0\.1 only/);
    }
  });

  test("localhost binds 127.0.0.1", async () => {
    const { server } = await serve({ hostname: "localhost" });
    expect(server.url).toBe(`ws://127.0.0.1:${server.port}/ws`);
    expect((await get(server.port, "/healthz")).status).toBe(200);
  });

  test("a given token is used", async () => {
    const { server } = await serve({ token: "fixed-token" });
    expect(server.token).toBe("fixed-token");
    const client = await connect(server);
    expect(client.ready).toBe(true);
  });
});

describe("HTTP", () => {
  test("/healthz answers with the revision", async () => {
    const { server, host } = await serve();
    const res = await get(server.port, "/healthz");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, revision: host.revision });
    const client = await connect(server);
    await client.transact(setHp(client.revision, 3).ops as never);
    expect(JSON.parse((await get(server.port, "/healthz")).body)).toEqual({
      ok: true,
      revision: host.revision,
    });
  });

  test("every other path is 404", async () => {
    const { server } = await serve();
    expect((await get(server.port, "/")).status).toBe(404);
    expect((await get(server.port, "/ws")).status).toBe(404);
    expect((await get(server.port, "/healthz/x")).status).toBe(404);
  });

  test("upgrades are accepted only on /ws", async () => {
    const { server } = await serve();
    const raw = new RawClient(`ws://127.0.0.1:${server.port}/other`);
    await expect(raw.opened).rejects.toThrow();
  });
});

describe("Origin", () => {
  test("a foreign Origin gets 403; own origins and allowOrigins connect", async () => {
    const { server } = await serve({ allowOrigins: ["http://example.test:8080"] });
    expect(await upgradeWithOrigin(server.url, "http://evil.test")).toBe(403);
    expect(await upgradeWithOrigin(server.url, "http://localhost:1")).toBe(403);
    expect(await upgradeWithOrigin(server.url, `http://127.0.0.1:${server.port}`)).toBe("open");
    expect(await upgradeWithOrigin(server.url, `http://localhost:${server.port}`)).toBe("open");
    expect(await upgradeWithOrigin(server.url, "http://example.test:8080")).toBe("open");
  });

  test("no Origin header connects", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    expect(raw.frames[0].type).toBe("welcome");
  });
});

describe("handshake", () => {
  test("a wrong token: goodbye, then 4401", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server, false);
    raw.send(helloFor(server, { token: "wrong" }));
    expect(await raw.closed).toMatchObject({ code: 4401 });
    expect(raw.frames).toEqual([{ type: "goodbye", reason: expect.any(String) }]);
  });

  test("a wrong protocol: goodbye, then 4400", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server, false);
    raw.send(helloFor(server, { protocol: 2 }));
    expect(await raw.closed).toMatchObject({ code: 4400 });
    expect(raw.frames).toEqual([{ type: "goodbye", reason: expect.any(String) }]);
  });

  test("a first message that is not hello: goodbye, then 4401", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server, false);
    raw.request("r1", "list_objects", {});
    expect(await raw.closed).toMatchObject({ code: 4401 });
    expect(raw.frames).toEqual([{ type: "goodbye", reason: expect.any(String) }]);
  });

  test("no hello within helloTimeoutMs: 4408", async () => {
    const { server } = await serve({ helloTimeoutMs: 100 });
    const raw = await RawClient.open(server, false);
    expect(await raw.closed).toMatchObject({ code: 4408 });
  });

  test("ProtocolClient sees unauthorized for a wrong token", async () => {
    const { server } = await serve();
    await expect(connect(server, { token: "nope" })).rejects.toBeInstanceOf(ProtocolFailure);
  });

  test("welcome: gm actor for ui, agent actor for agent, limits, table, revision, boards", async () => {
    const { server, host } = await serve();
    const ui = await RawClient.open(server, {
      client: { name: "Browser", kind: "ui", instance: "ui-1" },
    });
    expect(ui.frames[0]).toEqual({
      type: "welcome",
      protocol: 1,
      session: server.session,
      actor: { type: "gm" },
      revision: host.revision,
      boards: [
        { id: "map", name: "Map" },
        { id: "shelf", name: "Shelf" },
      ],
      table: { name: expect.any(String), path: null, id: null },
      limits: { ...LIMITS },
    });
    const named = await RawClient.open(server, {
      client: { name: "claude-code", kind: "agent", instance: "a-1" },
      agent_name: "Claude",
    });
    expect(named.frames[0].actor).toEqual({ type: "agent", name: "Claude" });
    const unnamed = await RawClient.open(server, {
      client: { name: "claude-code", kind: "agent", instance: "a-2" },
    });
    expect(unnamed.frames[0].actor).toEqual({ type: "agent", name: "claude-code" });
    const tester = await connect(server);
    expect(tester.actor).toEqual({ type: "gm" });
  });

  test("the same session for two connections; a different one after a restart", async () => {
    const host = memoryHost();
    const first = await serve({ host });
    const a = await connect(first.server);
    const b = await connect(first.server);
    expect(a.session).toBe(first.server.session);
    expect(b.session).toBe(first.server.session);
    await first.server.close();
    const second = await serve({ host });
    const c = await connect(second.server);
    expect(c.session).toBe(second.server.session);
    expect(c.session).not.toBe(a.session);
  });
});

describe("requests", () => {
  test("a malformed request gets bad_request and the next request works", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    raw.send("{not json");
    const bad = await raw.next((f) => f.type === "response");
    expect(bad).toMatchObject({ id: null, ok: false, error: { code: "bad_request" } });
    raw.send({ type: "request", id: "r2", method: "list_objects", params: { bogus: 1 } });
    expect(await raw.response("r2")).toMatchObject({ ok: false, error: { code: "bad_request" } });
    raw.request("r3", "list_objects", {});
    expect(await raw.response("r3")).toMatchObject({ ok: true, result: { revision: 3 } });
  });

  test("an oversize client frame closes the connection", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    raw.send(
      JSON.stringify({ type: "request", id: "big", method: "evaluate", params: { source: "x" } }) +
        " ".repeat(LIMITS.max_message_bytes),
    );
    const info = await raw.closed;
    expect(info.code).toBe(1009);
    expect(raw.indexOf((f) => f.type === "response" && f.id === "big")).toBe(-1);
  });

  test("300 requests in one burst get some busy, and every request is answered", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    for (let i = 0; i < 300; i++) raw.request(`q${i}`, "list_objects", { limit: 1 });
    await until(() => raw.frames.filter((f) => f.type === "response").length === 300);
    const responses = raw.frames.filter((f) => f.type === "response");
    const busy = responses.filter((f) => !f.ok && f.error.code === "busy");
    expect(busy.length).toBeGreaterThan(0);
    expect(responses.filter((f) => f.ok).length).toBeGreaterThanOrEqual(
      LIMITS.max_requests_per_second,
    );
    // Responses come in arrival order.
    expect(responses.map((f) => f.id)).toEqual(Array.from({ length: 300 }, (_, i) => `q${i}`));
  });

  test("a second hello after the handshake is bad_request", async () => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    raw.send(helloFor(server));
    expect(await raw.next((f) => f.type === "response")).toMatchObject({
      id: null,
      ok: false,
      error: { code: "bad_request" },
    });
    raw.request("ok", "list_objects", {});
    expect(await raw.response("ok")).toMatchObject({ ok: true });
  });
});

describe("heartbeat", () => {
  test("a connection that misses two pongs is terminated", async () => {
    const { server } = await serve({ heartbeatMs: 40 });
    const ws = new WebSocketClient(server.url, { autoPong: false });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify(helloFor(server)));
    let pings = 0;
    ws.on("ping", () => {
      pings++;
    });
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(code).toBe(1006);
  });

  test("a connection answering pings stays open", async () => {
    const { server } = await serve({ heartbeatMs: 20 });
    const client = await connect(server);
    await new Promise((r) => setTimeout(r, 150));
    expect(client.ready).toBe(true);
    expect((await client.request("list_objects", {})).revision).toBe(3);
  });
});

describe("close", () => {
  test('close("shutdown") sends goodbye and closes clients with 1001', async () => {
    const { server } = await serve();
    const a = await RawClient.open(server);
    const b = await RawClient.open(server, {
      client: { name: "raw", kind: "ui", instance: "raw-2" },
    });
    await server.close("shutdown");
    expect(await a.closed).toMatchObject({ code: 1001 });
    expect(await b.closed).toMatchObject({ code: 1001 });
    expect(a.frames.at(-1)).toEqual({ type: "goodbye", reason: "shutdown" });
    expect(b.frames.at(-1)).toEqual({ type: "goodbye", reason: "shutdown" });
    await expect(get(server.port, "/healthz")).rejects.toThrow();
  });

  test.each([
    ["a long ASCII reason", "x".repeat(300)],
    ["a long multibyte reason", "é€😀".repeat(40)],
  ])("%s: full goodbye, close 1001", async (_name, reason) => {
    const { server } = await serve();
    const raw = await RawClient.open(server);
    await server.close(reason);
    const info = await raw.closed;
    expect(info.code).toBe(1001);
    expect(Buffer.byteLength(info.reason)).toBeLessThanOrEqual(123);
    expect(reason.startsWith(info.reason)).toBe(true);
    expect(raw.frames.at(-1)).toEqual({ type: "goodbye", reason });
  });

  test("close does not close the host, and is idempotent", async () => {
    const { server, host } = await serve();
    await server.close();
    await server.close();
    expect(host.revision).toBe(3);
    const again = await serve({ host });
    const client = await connect(again.server);
    expect(client.revision).toBe(3);
  });
});
