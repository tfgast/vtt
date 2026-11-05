/**
 * The in-process authority server (DESIGN.md §7 Platform; PROTOCOL.md §1,
 * §2, §8, §10; D1–D4, D21, D22, D27): a Node HTTP server on 127.0.0.1 that
 * answers `GET /healthz`, refuses every other HTTP path with 404, and
 * accepts WebSocket upgrades (ws, `noServer`) only on `/ws`, after the
 * Origin check. Each socket is a `Connection`; requests go through the
 * router to the command, query, explain and subscription modules; the
 * server's one `SubscriptionHub` produces commit events, which are sent
 * synchronously as they are produced, and the host's save results are
 * broadcast as `save` events.
 *
 * No CLI, discovery file or signals here (vtt-5su.14); no static files
 * (M4: the HTTP fallback in `#onHttp` is where route handlers plug in).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { basename } from "node:path";
import {
  type BoardView,
  DEFAULT_PORT,
  LIMITS,
  type SaveEvent as WireSaveEvent,
} from "@vtt/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { TableHost } from "../host/table-host";
import { TxnCache } from "../protocol/commands";
import { createSubscriptionHub } from "../protocol/log-window";
import { Connection, type ConnectionHost, type ConnectionTimers } from "./connection";
import { type RouterDeps, routeRequest } from "./router";

export {
  actorFor,
  Connection,
  type ConnectionHost,
  type ConnectionState,
  type ConnectionTimers,
  type ServerSocket,
  tokensEqual,
} from "./connection";
export {
  type RequestContext,
  type RequestOutcome,
  ROUTES,
  type RouteHandler,
  type RouterDeps,
  type RouteTable,
  routeRequest,
} from "./router";

/** The timers the server schedules with (hello timeouts, heartbeat); injectable for tests. */
export interface ServerTimers extends ConnectionTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StartServerOptions {
  host: TableHost;
  /** Default 4747; 0 picks a free port. */
  port?: number;
  /** Default and v1's only supported value: "127.0.0.1" (PROTOCOL.md §2). */
  hostname?: string;
  /** Default: 32 random bytes, base64url. */
  token?: string;
  /** Origins accepted besides `http://127.0.0.1:<port>` and `http://localhost:<port>`. */
  allowOrigins?: readonly string[];
  /** Default 5000 (PROTOCOL.md §2). */
  helloTimeoutMs?: number;
  /** Default 15000 (PROTOCOL.md §8). */
  heartbeatMs?: number;
  timers?: ServerTimers;
}

export interface RunningServer {
  /** `ws://127.0.0.1:<port>/ws`. */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Random, fixed for this `startServer` call (PROTOCOL.md §2). */
  readonly session: string;
  /**
   * Stops accepting, sends `goodbye {reason}` and closes every connection
   * with 1001, stops the heartbeat and closes the HTTP server. Resolves when
   * every socket is closed. Does not close the host. Idempotent.
   */
  close(reason?: string): Promise<void>;
}

/** The global timers, looked up at each call (so fake timers apply). */
export const systemServerTimers: ServerTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>),
  now: () => performance.now(),
};

/** How long `close` waits for a client's closing handshake before terminating its socket. */
const CLOSE_GRACE_MS = 2000;

/** Starts the server; resolves once it is listening. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const server = new AuthorityServer(options);
  await server.listen(options.port ?? DEFAULT_PORT, options.hostname ?? "127.0.0.1");
  return server.handle();
}

class AuthorityServer {
  readonly #host: TableHost;
  readonly #token: string;
  readonly #session = randomUUID();
  readonly #allowOrigins: readonly string[];
  readonly #helloTimeoutMs: number;
  readonly #heartbeatMs: number;
  readonly #timers: ServerTimers;
  readonly #deps: RouterDeps;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #conns = new Map<
    string,
    { conn: Connection; socket: WebSocket; closed: Promise<void> }
  >();
  readonly #offSave: () => void;
  readonly #offCommit: () => void;
  #port = 0;
  #nextConn = 1;
  #heartbeat: unknown;
  #closing: Promise<void> | null = null;

  constructor(options: StartServerOptions) {
    this.#host = options.host;
    this.#token = options.token ?? randomBytes(32).toString("base64url");
    this.#allowOrigins = [...(options.allowOrigins ?? [])];
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 5000;
    this.#heartbeatMs = options.heartbeatMs ?? 15000;
    this.#timers = options.timers ?? systemServerTimers;
    const hub = createSubscriptionHub(this.#host.table);
    this.#deps = { host: this.#host, hub, txns: new TxnCache() };
    // Commit events are sent as the hub produces them, inside the commit,
    // so they precede the committing request's response (D22).
    this.#offCommit = hub.onCommitEvent((id, event) => {
      try {
        this.#conns.get(id)?.conn.send(event);
      } catch (err) {
        console.error(`vtt: could not send a commit event to connection ${id}:`, err);
      }
    });
    this.#offSave = this.#host.onSave((event) => this.#broadcastSave(event));
    this.#http = createServer((req, res) => this.#onHttp(req, res));
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.max_message_bytes });
    this.#http.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket as Socket, head));
  }

  listen(port: number, hostname: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.#dispose();
        reject(err);
      };
      this.#http.once("error", onError);
      this.#http.listen(port, hostname, () => {
        this.#http.off("error", onError);
        const address = this.#http.address();
        this.#port = typeof address === "object" && address !== null ? address.port : port;
        this.#heartbeat = this.#timers.setInterval(() => this.#tick(), this.#heartbeatMs);
        (this.#heartbeat as { unref?: () => void }).unref?.();
        resolve();
      });
    });
  }

  handle(): RunningServer {
    const port = this.#port;
    return Object.freeze({
      url: `ws://127.0.0.1:${port}/ws`,
      port,
      token: this.#token,
      session: this.#session,
      close: (reason?: string) => this.close(reason ?? "shutdown"),
    });
  }

  // HTTP.

  #onHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = pathOf(req);
    if (req.method === "GET" && path === "/healthz") {
      const body = JSON.stringify({ ok: true, revision: this.#host.revision });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    // Seam for M4 (vtt-3l6.14): further HTTP route handlers go here.
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  }

  #onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on("error", () => undefined);
    const refusal = this.#refusal(req);
    if (refusal !== null) {
      refuseUpgrade(socket, refusal);
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws));
  }

  /** Why an upgrade is refused, as an HTTP status line, or null to accept it. */
  #refusal(req: IncomingMessage): string | null {
    if (this.#closing !== null) return "503 Service Unavailable";
    if (pathOf(req) !== "/ws") return "404 Not Found";
    const origin = req.headers.origin;
    if (origin !== undefined && !this.#originAllowed(origin)) return "403 Forbidden";
    return null;
  }

  #originAllowed(origin: string): boolean {
    return (
      origin === `http://127.0.0.1:${this.#port}` ||
      origin === `http://localhost:${this.#port}` ||
      this.#allowOrigins.includes(origin)
    );
  }

  // Connections.

  #accept(ws: WebSocket): void {
    if (this.#closing !== null) {
      ws.terminate();
      return;
    }
    const id = `c${this.#nextConn++}`;
    const conn = new Connection(id, ws, this.#connectionHost());
    const closed = new Promise<void>((resolve) => {
      ws.once("close", () => {
        conn.socketClosed();
        resolve();
      });
    });
    this.#conns.set(id, { conn, socket: ws, closed });
    ws.on("message", (data, isBinary) => conn.receive(data, isBinary));
    ws.on("pong", () => conn.pong());
    ws.on("error", (err) => {
      // ws closes the socket after an error (e.g. 1009 for an oversize frame).
      if (!/max payload/i.test(err.message)) console.error(`vtt: connection ${id}:`, err.message);
    });
  }

  #connectionHost(): ConnectionHost {
    return {
      token: this.#token,
      session: this.#session,
      helloTimeoutMs: this.#helloTimeoutMs,
      timers: this.#timers,
      welcome: () => ({
        revision: this.#host.revision,
        boards: boardViews(this.#host),
        table: {
          name: this.#host.path === null ? "untitled" : basename(this.#host.path),
          path: this.#host.path,
          id: this.#host.tableId,
        },
      }),
      ready: (conn) => this.#deps.hub.addConnection(conn.id),
      route: (ctx, request) => routeRequest(this.#deps, ctx, request),
      closed: (conn) => {
        this.#conns.delete(conn.id);
        this.#deps.hub.dropConnection(conn.id);
      },
    };
  }

  #broadcastSave(event: {
    status: WireSaveEvent["status"];
    revision: number;
    message?: string;
  }): void {
    const wire: WireSaveEvent = {
      type: "event",
      event: "save",
      status: event.status,
      revision: event.revision,
    };
    if (event.message !== undefined) wire.message = event.message;
    for (const { conn } of this.#conns.values()) conn.send(wire);
  }

  #tick(): void {
    for (const { conn } of [...this.#conns.values()]) conn.heartbeat();
  }

  // Shutdown.

  close(reason: string): Promise<void> {
    this.#closing ??= this.#close(reason);
    return this.#closing;
  }

  async #close(reason: string): Promise<void> {
    const httpClosed = new Promise<void>((resolve) => this.#http.close(() => resolve()));
    this.#dispose();
    const entries = [...this.#conns.values()];
    for (const { conn } of entries) conn.shutdown(reason);
    await Promise.all(
      entries.map(async ({ socket, closed }) => {
        let timer: unknown;
        const grace = new Promise<void>((resolve) => {
          timer = this.#timers.setTimeout(() => {
            socket.terminate();
            resolve();
          }, CLOSE_GRACE_MS);
        });
        await Promise.race([closed, grace]);
        this.#timers.clearTimeout(timer);
        await closed;
      }),
    );
    this.#http.closeAllConnections();
    await httpClosed;
  }

  /** Stops the heartbeat and detaches from the host and its table. */
  #dispose(): void {
    if (this.#heartbeat !== undefined) this.#timers.clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#offSave();
    this.#offCommit();
    this.#deps.hub.close();
    this.#wss.close();
  }
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

function refuseUpgrade(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );
}

function boardViews(host: TableHost): BoardView[] {
  return host.table.store
    .boards()
    .map((b) => (b.name === undefined ? { id: b.id } : { id: b.id, name: b.name }));
}
