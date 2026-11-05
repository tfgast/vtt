/**
 * One client connection (PROTOCOL.md §2, §3, §8, §10; D4, D9, D21, D22):
 * the handshake (`awaiting_hello` → `ready`), the per-connection request
 * queue, the token bucket, the slow-consumer check and the heartbeat count.
 * Transport-free: it speaks to a `ServerSocket` (a `ws` socket in the
 * server, a fake in tests) and to its server through `ConnectionHost`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  type BoardView,
  CLOSE_CODES,
  type Hello,
  LIMITS,
  PROTOCOL_VERSION,
  parseClientMessage,
  type RequestMessage,
  type ServerMessage,
  type Welcome,
} from "@vtt/protocol";
import type { Actor } from "@vtt/schema";
import type { CommandKind } from "../protocol/commands";
import type { RequestContext, RequestOutcome } from "./router";

/** The subset of a `ws` WebSocket a connection uses. */
export interface ServerSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  ping(): void;
  readonly bufferedAmount: number;
}

/** Timers and the clock; injectable for tests. */
export interface ConnectionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds, monotonic enough for the token bucket. */
  now(): number;
}

/** What a connection needs from its server. */
export interface ConnectionHost {
  readonly token: string;
  readonly session: string;
  readonly helloTimeoutMs: number;
  readonly timers: ConnectionTimers;
  /** The table state for `welcome`, read when the handshake completes. */
  welcome(): Pick<Welcome, "revision" | "boards" | "table">;
  /** The handshake completed (register with the hub). */
  ready(conn: Connection): void;
  route(ctx: RequestContext, request: RequestMessage): RequestOutcome | Promise<RequestOutcome>;
  /** The socket closed; called once. */
  closed(conn: Connection): void;
}

export type ConnectionState = "awaiting_hello" | "ready" | "closed";

type Queued =
  | { type: "request"; message: RequestMessage }
  | {
      type: "error";
      id: string | null;
      code: "bad_request" | "unknown_method" | "busy";
      message: string;
    };

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time token comparison (lengths hidden by hashing first). */
export function tokensEqual(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** `client.kind: "agent"` → an agent actor named `agent_name ?? client.name`; otherwise the GM (§3). */
export function actorFor(hello: Hello): Actor {
  return hello.client.kind === "agent"
    ? { type: "agent", name: hello.agent_name ?? hello.client.name }
    : { type: "gm" };
}

export class Connection {
  readonly id: string;
  readonly #socket: ServerSocket;
  readonly #host: ConnectionHost;
  #state: ConnectionState = "awaiting_hello";
  #helloTimer: unknown;
  #actor: Actor | null = null;
  #kind: CommandKind | null = null;
  #instance: string | null = null;
  readonly #queue: Queued[] = [];
  #busy = false;
  #tokens: number = LIMITS.max_requests_per_second;
  #refilled: number;
  #missedPongs = 0;
  #reportedClosed = false;

  constructor(id: string, socket: ServerSocket, host: ConnectionHost) {
    this.id = id;
    this.#socket = socket;
    this.#host = host;
    this.#refilled = host.timers.now();
    this.#helloTimer = host.timers.setTimeout(() => {
      this.#helloTimer = undefined;
      if (this.#state === "awaiting_hello") this.#close(CLOSE_CODES.hello_timeout, "hello timeout");
    }, host.helloTimeoutMs);
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** The actor, after the handshake. */
  get actor(): Actor | null {
    return this.#actor;
  }

  get kind(): CommandKind | null {
    return this.#kind;
  }

  /** `hello` `client.instance`, after the handshake. */
  get instance(): string | null {
    return this.#instance;
  }

  /** A frame arrived. `isBinary` frames are not protocol messages. */
  receive(data: string | Buffer | ArrayBuffer | Buffer[], isBinary = false): void {
    if (this.#state === "closed") return;
    const text = isBinary ? null : toText(data);
    if (this.#state === "awaiting_hello") {
      this.#onHello(text);
      return;
    }
    if (!this.#take()) {
      // Read the id for the busy answer; the content is not processed.
      const parsed = text === null ? null : parseClientMessage(text);
      const id = parsed === null ? null : parsed.ok ? requestId(parsed.message) : parsed.id;
      this.#enqueue({
        type: "error",
        id,
        code: "busy",
        message: `more than ${LIMITS.max_requests_per_second} requests per second`,
      });
      return;
    }
    if (text === null) {
      this.#enqueue({
        type: "error",
        id: null,
        code: "bad_request",
        message: "binary frames are not supported",
      });
      return;
    }
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      const code = parsed.error.code === "unknown_method" ? "unknown_method" : "bad_request";
      this.#enqueue({ type: "error", id: parsed.id, code, message: parsed.error.message });
    } else if (parsed.message.type === "hello") {
      this.#enqueue({
        type: "error",
        id: null,
        code: "bad_request",
        message: "hello was already received",
      });
    } else {
      this.#enqueue({ type: "request", message: parsed.message });
    }
  }

  /** Sends a server message to a ready connection; false when not ready. */
  send(message: ServerMessage): boolean {
    if (this.#state !== "ready") return false;
    return this.#write(message);
  }

  /** A heartbeat tick: terminate after two missed pongs, otherwise ping. */
  heartbeat(): void {
    if (this.#reportedClosed) return;
    if (this.#missedPongs >= 2) {
      this.#state = "closed";
      this.#socket.terminate();
      return;
    }
    this.#missedPongs++;
    try {
      this.#socket.ping();
    } catch {
      // The socket is going away; its close event follows.
    }
  }

  pong(): void {
    this.#missedPongs = 0;
  }

  /** Server shutdown: `goodbye`, then close 1001. */
  shutdown(reason: string): void {
    if (this.#state === "closed") return;
    this.#write({ type: "goodbye", reason });
    this.#close(CLOSE_CODES.shutdown, reason);
  }

  /** The socket closed (for any reason). */
  socketClosed(): void {
    this.#state = "closed";
    this.#clearHelloTimer();
    this.#queue.length = 0;
    if (this.#reportedClosed) return;
    this.#reportedClosed = true;
    this.#host.closed(this);
  }

  // Handshake.

  #onHello(text: string | null): void {
    const parsed = text === null ? null : parseClientMessage(text);
    if (parsed !== null && !parsed.ok && parsed.error.code === "protocol_version") {
      this.#refuse(
        CLOSE_CODES.protocol,
        `unsupported protocol version; this is protocol ${PROTOCOL_VERSION}`,
      );
      return;
    }
    if (parsed === null || !parsed.ok || parsed.message.type !== "hello") {
      this.#refuse(
        CLOSE_CODES.unauthorized,
        "unauthorized: the first message must be a valid hello",
      );
      return;
    }
    const hello = parsed.message;
    if (!tokensEqual(hello.token, this.#host.token)) {
      this.#refuse(CLOSE_CODES.unauthorized, "unauthorized: wrong token");
      return;
    }
    this.#clearHelloTimer();
    this.#actor = actorFor(hello);
    this.#kind = hello.client.kind;
    this.#instance = hello.client.instance;
    this.#state = "ready";
    // Registered with the hub before the welcome is written: nothing runs in
    // between, and from here on every commit event reaches this connection.
    this.#host.ready(this);
    const state = this.#host.welcome();
    this.#write({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      session: this.#host.session,
      actor: structuredClone(this.#actor),
      revision: state.revision,
      boards: state.boards as BoardView[],
      table: state.table,
      limits: { ...LIMITS },
    });
  }

  #refuse(code: number, reason: string): void {
    this.#write({ type: "goodbye", reason });
    this.#close(code, reason);
  }

  // Requests.

  /** Takes a token from the bucket (capacity and rate `max_requests_per_second`). */
  #take(): boolean {
    const rate = LIMITS.max_requests_per_second;
    const now = this.#host.timers.now();
    const elapsed = Math.max(0, now - this.#refilled);
    this.#refilled = now;
    this.#tokens = Math.min(rate, this.#tokens + (elapsed * rate) / 1000);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  #enqueue(item: Queued): void {
    this.#queue.push(item);
    this.#drain();
  }

  /** Processes queued messages in order; an async answer holds the queue until it is sent. */
  #drain(): void {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (let item = this.#queue.shift(); item !== undefined; item = this.#queue.shift()) {
        if (this.#state !== "ready") return;
        if (item.type === "error") {
          this.#respond(item.id, { ok: false, error: { code: item.code, message: item.message } });
          continue;
        }
        const id = item.message.id;
        const outcome = this.#route(item.message);
        if (outcome instanceof Promise) {
          void outcome.then((o) => {
            this.#respond(id, o);
            this.#busy = false;
            this.#drain();
          });
          return;
        }
        this.#respond(id, outcome);
      }
      this.#busy = false;
    } finally {
      // Left busy only while an async answer is pending.
      if (this.#state !== "ready") this.#busy = false;
    }
  }

  #route(request: RequestMessage): RequestOutcome | Promise<RequestOutcome> {
    const ctx: RequestContext = {
      conn: this.id,
      actor: this.#actor as Actor,
      kind: this.#kind as CommandKind,
      instance: this.#instance as string,
    };
    try {
      const outcome = this.#host.route(ctx, request);
      if (outcome instanceof Promise) {
        return outcome.catch((err: unknown) => internal(err, request));
      }
      return outcome;
    } catch (err) {
      return internal(err, request);
    }
  }

  #respond(id: string | null, outcome: RequestOutcome): void {
    if (this.#state !== "ready") return;
    this.#write(
      outcome.ok
        ? { type: "response", id: id as string, ok: true, result: outcome.result }
        : { type: "response", id, ok: false, error: outcome.error },
    );
  }

  // Socket.

  #write(message: ServerMessage): boolean {
    if (this.#reportedClosed) return false;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch (err) {
      console.error(`vtt: could not send to connection ${this.id}:`, err);
      return false;
    }
    if (this.#socket.bufferedAmount > LIMITS.max_buffered_bytes) {
      this.#close(CLOSE_CODES.slow_consumer, "slow consumer");
      return false;
    }
    return true;
  }

  #close(code: number, reason: string): void {
    this.#state = "closed";
    this.#clearHelloTimer();
    this.#queue.length = 0;
    try {
      this.#socket.close(code, closeFrameReason(reason));
    } catch {
      this.#socket.terminate();
    }
  }

  #clearHelloTimer(): void {
    if (this.#helloTimer === undefined) return;
    this.#host.timers.clearTimeout(this.#helloTimer);
    this.#helloTimer = undefined;
  }
}

/** The longest close-frame reason, in UTF-8 bytes (RFC 6455 §5.5). */
export const MAX_CLOSE_REASON_BYTES = 123;

/** `reason` cut to at most 123 UTF-8 bytes on a code-point boundary. */
export function closeFrameReason(reason: string): string {
  let bytes = 0;
  let out = "";
  for (const ch of reason) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > MAX_CLOSE_REASON_BYTES) break;
    bytes += n;
    out += ch;
  }
  return out;
}

function internal(err: unknown, request: RequestMessage): RequestOutcome {
  console.error(`vtt: internal error in request ${request.id} (${request.method}):`, err);
  return { ok: false, error: { code: "internal", message: "internal error" } };
}

const requestId = (message: { type: string; id?: string }): string | null =>
  message.type === "request" ? (message.id ?? null) : null;

function toText(data: string | Buffer | ArrayBuffer | Buffer[]): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
