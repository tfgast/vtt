/** The HTTP route hook and the `Host` check (PROTOCOL.md §1; vtt-3l6.14). */
import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import type { HttpHandler } from "@vtt/authority";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, RawClient, serve } from "./helpers";

afterEach(cleanup);

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw HTTP request; `host: null` sends no `Host` header at all. */
function send(
  port: number,
  path: string,
  options: { method?: string; host?: string | null } = {},
): Promise<Reply> {
  const headers: OutgoingHttpHeaders = {};
  if (typeof options.host === "string") headers.host = options.host;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers,
        setHost: options.host !== null,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A handler that records its calls and answers `path` with `text`. */
function answering(path: string, text: string, calls: string[]): HttpHandler {
  return (req, res) => {
    calls.push(`${text}:${req.url}`);
    if (req.url !== path) return false;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(text);
    return true;
  };
}

describe("Host check", () => {
  test("a foreign Host is 421, before any handler runs", async () => {
    const calls: string[] = [];
    const { server } = await serve({ http: [answering("/x", "a", calls)] });
    const port = server.port;
    for (const host of [
      `evil.example:${port}`,
      "evil.example",
      `127.0.0.1:${port + 1}`,
      `localhost:${port + 1}`,
      "127.0.0.1",
      "localhost",
      `[::1]:${port}`,
      `127.0.0.1:${port}.evil.example`,
    ]) {
      const res = await send(port, "/x", { host });
      expect(res.status, host).toBe(421);
    }
    // Node's HTTP server refuses an HTTP/1.1 request without `Host` (400) before routing.
    expect((await send(port, "/x", { host: null })).status).toBe(400);
    expect((await send(port, "/nowhere", { host: `evil.example:${port}` })).status).toBe(421);
    expect((await send(port, "/x", { method: "POST", host: `evil.example:${port}` })).status).toBe(
      421,
    );
    expect(calls).toEqual([]);
  });

  test("its own loopback Hosts are routed", async () => {
    const calls: string[] = [];
    const { server } = await serve({ http: [answering("/x", "a", calls)] });
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
      const res = await send(server.port, "/x", { host });
      expect(res.status).toBe(200);
      expect(res.body).toBe("a");
    }
  });

  test("with no handlers the check still applies, otherwise everything but /healthz is 404", async () => {
    const { server } = await serve();
    expect((await send(server.port, "/", { host: `evil.example:${server.port}` })).status).toBe(
      421,
    );
    expect((await send(server.port, "/")).status).toBe(404);
    expect((await send(server.port, "/index.html")).status).toBe(404);
    expect((await send(server.port, "/healthz", { method: "POST" })).status).toBe(404);
  });

  test("GET /healthz answers with any Host", async () => {
    const { server, host } = await serve();
    for (const h of [`evil.example:${server.port}`, "evil.example", `localhost:${server.port}`]) {
      const res = await send(server.port, "/healthz", { host: h });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, revision: host.revision });
    }
    // Only GET is exempt.
    expect(
      (await send(server.port, "/healthz", { method: "POST", host: "evil.example" })).status,
    ).toBe(421);
  });

  test("/ws upgrades work as before, with handlers installed", async () => {
    const calls: string[] = [];
    const { server } = await serve({ http: [answering("/x", "a", calls)] });
    const raw = await RawClient.open(server);
    expect(raw.frames[0].type).toBe("welcome");
    const other = new RawClient(`ws://127.0.0.1:${server.port}/x`);
    await expect(other.opened).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("route hook", () => {
  test("handlers are tried in order until one handles the request, then 404", async () => {
    const calls: string[] = [];
    const { server } = await serve({
      http: [answering("/a", "first", calls), answering("/b", "second", calls)],
    });
    expect((await send(server.port, "/a")).body).toBe("first");
    expect(calls).toEqual(["first:/a"]);
    calls.length = 0;
    expect((await send(server.port, "/b")).body).toBe("second");
    expect(calls).toEqual(["first:/b", "second:/b"]);
    calls.length = 0;
    const miss = await send(server.port, "/c");
    expect(miss.status).toBe(404);
    expect(calls).toEqual(["first:/c", "second:/c"]);
  });

  test("an earlier handler that claims a path shadows a later one", async () => {
    const calls: string[] = [];
    const { server } = await serve({
      http: [answering("/a", "first", calls), answering("/a", "second", calls)],
    });
    expect((await send(server.port, "/a")).body).toBe("first");
    expect(calls).toEqual(["first:/a"]);
  });

  test("async handlers are awaited", async () => {
    const order: string[] = [];
    const slowMiss: HttpHandler = async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
      return false;
    };
    const hit: HttpHandler = async (_req, res) => {
      order.push("hit");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return true;
    };
    const { server } = await serve({ http: [slowMiss, hit] });
    const res = await send(server.port, "/anything");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
    expect(order).toEqual(["slow", "hit"]);
  });

  test("handlers get the server's url, port and token", async () => {
    let seen: unknown = null;
    const { server } = await serve({
      token: "tok",
      http: [
        (_req, res, ctx) => {
          seen = ctx;
          res.end();
          return true;
        },
      ],
    });
    await send(server.port, "/");
    expect(seen).toEqual({ url: server.url, port: server.port, token: "tok" });
  });

  test("a throwing or rejecting handler answers 500 and the server keeps serving", async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      const { server } = await serve({
        http: [
          (req) => {
            if (req.url === "/throw") throw new Error("boom");
            return false;
          },
          async (req) => {
            if (req.url === "/reject") throw new Error("boom");
            return false;
          },
        ],
      });
      expect((await send(server.port, "/throw")).status).toBe(500);
      expect((await send(server.port, "/reject")).status).toBe(500);
      expect((await send(server.port, "/other")).status).toBe(404);
      expect((await send(server.port, "/healthz")).status).toBe(200);
    } finally {
      console.error = original;
    }
  });
});
