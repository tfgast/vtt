import {
  Connection,
  type ConnectionHost,
  type RequestContext,
  type RequestOutcome,
  type ServerSocket,
} from "@vtt/authority";
import { LIMITS, type RequestMessage } from "@vtt/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Frame } from "./helpers";

class FakeSocket implements ServerSocket {
  readonly sent: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  terminated = false;
  pings = 0;
  bufferedAmount = 0;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings++;
  }
  responses(): Frame[] {
    return this.sent.filter((f) => f.type === "response");
  }
}

type Route = (ctx: RequestContext, req: RequestMessage) => RequestOutcome | Promise<RequestOutcome>;

function setup(route: Route = (_c, r) => ({ ok: true, result: { echo: r.id } })) {
  const socket = new FakeSocket();
  const readied: Connection[] = [];
  const closed: Connection[] = [];
  const contexts: RequestContext[] = [];
  const host: ConnectionHost = {
    token: "secret",
    session: "sess",
    helloTimeoutMs: 5000,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    welcome: () => ({
      revision: 7,
      boards: [{ id: "map", name: "Map" }],
      table: { name: "t.json", path: "/x/t.json", id: "tid" },
    }),
    ready: (c) => readied.push(c),
    route: (ctx, req) => {
      contexts.push(ctx);
      return route(ctx, req);
    },
    closed: (c) => closed.push(c),
  };
  const conn = new Connection("c1", socket, host);
  return { socket, conn, readied, closed, contexts };
}

const hello = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "hello",
    protocol: 1,
    token: "secret",
    client: { name: "n", kind: "test", instance: "inst" },
    ...over,
  });
const req = (id: string, method = "list_objects", params: unknown = {}) =>
  JSON.stringify({ type: "request", id, method, params });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("handshake", () => {
  test("no hello within helloTimeoutMs closes 4408", () => {
    const { socket, conn } = setup();
    vi.advanceTimersByTime(4999);
    expect(socket.closed).toBeNull();
    vi.advanceTimersByTime(1);
    expect(socket.closed?.code).toBe(4408);
    expect(conn.state).toBe("closed");
  });

  test("hello in time: welcome, ready, and no timeout later", () => {
    const { socket, conn, readied } = setup();
    conn.receive(hello({ agent_name: "ignored-for-test-kind" }));
    expect(socket.sent).toEqual([
      {
        type: "welcome",
        protocol: 1,
        session: "sess",
        actor: { type: "gm" },
        revision: 7,
        boards: [{ id: "map", name: "Map" }],
        table: { name: "t.json", path: "/x/t.json", id: "tid" },
        limits: { ...LIMITS },
      },
    ]);
    expect(conn.state).toBe("ready");
    expect(readied).toEqual([conn]);
    expect(conn.instance).toBe("inst");
    vi.advanceTimersByTime(60000);
    expect(socket.closed).toBeNull();
  });

  test("agent actor: agent_name, else client.name", () => {
    const a = setup();
    a.conn.receive(
      hello({ client: { name: "cc", kind: "agent", instance: "i" }, agent_name: "Bob" }),
    );
    expect(a.conn.actor).toEqual({ type: "agent", name: "Bob" });
    expect(a.conn.kind).toBe("agent");
    const b = setup();
    b.conn.receive(hello({ client: { name: "cc", kind: "agent", instance: "i" } }));
    expect(b.conn.actor).toEqual({ type: "agent", name: "cc" });
    const c = setup();
    c.conn.receive(hello({ client: { name: "cc", kind: "ui", instance: "i" } }));
    expect(c.conn.actor).toEqual({ type: "gm" });
  });

  test.each([
    ["a wrong token", hello({ token: "nope" }), 4401],
    ["a token of another length", hello({ token: "secret-but-longer" }), 4401],
    ["a request first", req("r1"), 4401],
    ["unparseable JSON", "{", 4401],
    ["a malformed hello", hello({ client: { name: "", kind: "test", instance: "i" } }), 4401],
    ["another protocol", hello({ protocol: 2 }), 4400],
  ])("%s: goodbye then close", (_name, frame, code) => {
    const { socket, conn, readied } = setup();
    conn.receive(frame);
    expect(socket.sent).toEqual([{ type: "goodbye", reason: expect.any(String) }]);
    expect(socket.closed?.code).toBe(code);
    expect(readied).toEqual([]);
    conn.receive(hello());
    expect(socket.sent).toHaveLength(1);
  });

  test("the goodbye reason names the failure for the client", () => {
    const a = setup();
    a.conn.receive(hello({ token: "nope" }));
    expect(a.socket.sent[0].reason).toMatch(/unauthorized/);
    const b = setup();
    b.conn.receive(hello({ protocol: 2 }));
    expect(b.socket.sent[0].reason).toMatch(/protocol/);
  });
});

describe("requests", () => {
  test("parse failures answer bad_request with the id when readable", () => {
    const { socket, conn } = setup();
    conn.receive(hello());
    conn.receive("[]");
    conn.receive(JSON.stringify({ type: "request", id: "x", method: "log", params: { nope: 1 } }));
    conn.receive(Buffer.from(req("bin")), true);
    expect(socket.responses()).toEqual([
      {
        type: "response",
        id: null,
        ok: false,
        error: expect.objectContaining({ code: "bad_request" }),
      },
      {
        type: "response",
        id: "x",
        ok: false,
        error: expect.objectContaining({ code: "bad_request" }),
      },
      {
        type: "response",
        id: null,
        ok: false,
        error: expect.objectContaining({ code: "bad_request" }),
      },
    ]);
    expect(conn.state).toBe("ready");
  });

  test("text delivered as a Buffer (ws's text frames) is parsed", () => {
    const { socket, conn } = setup();
    conn.receive(Buffer.from(hello()), false);
    conn.receive(Buffer.from(req("r1")), false);
    expect(socket.responses()).toEqual([
      { type: "response", id: "r1", ok: true, result: { echo: "r1" } },
    ]);
  });

  test("the request context carries the actor, kind, instance and connection id", () => {
    const { conn, contexts } = setup();
    conn.receive(hello({ client: { name: "cc", kind: "agent", instance: "inst-9" } }));
    conn.receive(req("r1"));
    expect(contexts).toEqual([
      { conn: "c1", actor: { type: "agent", name: "cc" }, kind: "agent", instance: "inst-9" },
    ]);
  });

  test("a route that throws answers internal and the connection stays", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { socket, conn } = setup(() => {
      throw new Error("boom");
    });
    conn.receive(hello());
    conn.receive(req("r1"));
    expect(socket.responses()).toEqual([
      {
        type: "response",
        id: "r1",
        ok: false,
        error: expect.objectContaining({ code: "internal" }),
      },
    ]);
    expect(conn.state).toBe("ready");
  });

  test("one message at a time: the next waits for an async response", async () => {
    let releaseSave: (o: RequestOutcome) => void = () => undefined;
    const { socket, conn } = setup((_c, r) =>
      r.method === "save"
        ? new Promise<RequestOutcome>((resolve) => {
            releaseSave = resolve;
          })
        : { ok: true, result: { echo: r.id } },
    );
    conn.receive(hello());
    conn.receive(req("s", "save"));
    conn.receive(req("q1"));
    conn.receive("garbage");
    conn.receive(req("q2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.responses()).toEqual([]);
    releaseSave({ ok: true, result: { status: "saved" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.responses().map((f) => f.id)).toEqual(["s", "q1", null, "q2"]);
  });

  test("an async response after the socket closed is dropped", async () => {
    let releaseSave: (o: RequestOutcome) => void = () => undefined;
    const { socket, conn, closed } = setup(
      () =>
        new Promise<RequestOutcome>((resolve) => {
          releaseSave = resolve;
        }),
    );
    conn.receive(hello());
    conn.receive(req("s", "save"));
    conn.socketClosed();
    expect(closed).toEqual([conn]);
    releaseSave({ ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.responses()).toEqual([]);
  });

  test("token bucket: beyond max_requests_per_second in a burst is busy; it refills", () => {
    const { socket, conn } = setup();
    conn.receive(hello());
    const n = LIMITS.max_requests_per_second;
    for (let i = 0; i < n + 5; i++) conn.receive(req(`r${i}`));
    const res = socket.responses();
    expect(res.filter((f) => f.ok)).toHaveLength(n);
    expect(res.slice(n).map((f) => f.error.code)).toEqual(Array(5).fill("busy"));
    expect(res.slice(n).map((f) => f.id)).toEqual(["r200", "r201", "r202", "r203", "r204"]);
    vi.advanceTimersByTime(100);
    for (let i = 0; i < 25; i++) conn.receive(req(`later${i}`));
    const later = socket.responses().slice(n + 5);
    expect(later.filter((f) => f.ok)).toHaveLength(20);
    expect(later.filter((f) => !f.ok)).toHaveLength(5);
  });

  test("bufferedAmount beyond max_buffered_bytes closes 4429", () => {
    const { socket, conn } = setup();
    conn.receive(hello());
    socket.bufferedAmount = LIMITS.max_buffered_bytes + 1;
    conn.receive(req("r1"));
    expect(socket.closed?.code).toBe(4429);
    expect(conn.state).toBe("closed");
    conn.receive(req("r2"));
    expect(socket.responses().map((f) => f.id)).toEqual(["r1"]);
  });

  test("events are sent only to ready connections", () => {
    const { socket, conn } = setup();
    const event = { type: "event", event: "save", status: "saved", revision: 1 } as const;
    expect(conn.send(event)).toBe(false);
    conn.receive(hello());
    expect(conn.send(event)).toBe(true);
    expect(socket.sent.at(-1)).toEqual(event);
  });
});

describe("heartbeat and shutdown", () => {
  test("two missed pongs terminate; a pong resets the count", () => {
    const { socket, conn } = setup();
    conn.receive(hello());
    conn.heartbeat();
    conn.heartbeat();
    expect(socket.pings).toBe(2);
    conn.pong();
    conn.heartbeat();
    conn.heartbeat();
    expect(socket.terminated).toBe(false);
    conn.heartbeat();
    expect(socket.terminated).toBe(true);
    expect(socket.pings).toBe(4);
  });

  test("shutdown sends goodbye and closes 1001", () => {
    const { socket, conn } = setup();
    conn.receive(hello());
    conn.shutdown("shutdown");
    expect(socket.sent.at(-1)).toEqual({ type: "goodbye", reason: "shutdown" });
    expect(socket.closed).toEqual({ code: 1001, reason: "shutdown" });
  });

  test("socketClosed clears the hello timer and reports once", () => {
    const { socket, conn, closed } = setup();
    conn.socketClosed();
    conn.socketClosed();
    expect(closed).toEqual([conn]);
    vi.advanceTimersByTime(10000);
    expect(socket.closed).toBeNull();
  });
});
