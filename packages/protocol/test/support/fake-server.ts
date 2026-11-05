/**
 * An in-memory, WebSocket-shaped peer for client tests (vtt-5su.7; imported
 * unchanged by vtt-5su.19). `new FakeServer()` exposes a `WebSocket`
 * constructor to inject into `ProtocolClient`; every socket the client opens
 * gets a server-side `FakePeer` the test scripts.
 *
 * Timing model: the `open` event, the scripted `hello` answer and scripted
 * request replies are delivered on a later microtask (never synchronously
 * inside the client's `send`), so `await flush()` settles them, also under
 * fake timers. Frames and closes a test sends through a peer
 * (`peer.send`, `peer.respond`, `peer.close`) are delivered synchronously.
 *
 * Defaults: `hello` with `server.token` is answered with `server.welcome()`;
 * any other token with `goodbye` then close 4401. Requests with no handler
 * stay unanswered until the test responds.
 */
import {
  type Cover,
  type GroupHeader,
  type GroupView,
  LIMITS,
  type ObjectView,
  type ProtocolError,
  type SubscriptionDelta,
} from "@vtt/protocol";

type Listener = (event: unknown) => void;

/** One parsed client frame, with the raw text. */
export type ClientFrame = { text: string; message: Record<string, unknown> };

/** A request as received. */
export type ReceivedRequest = {
  type: "request";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

/** What a request handler replies; `undefined` leaves the request unanswered. */
export type Reply =
  | { result: unknown }
  | { error: ProtocolError }
  /** Raw frames sent in order, e.g. a commit event followed by the response. */
  | { frames: unknown[] }
  | undefined;

export type RequestHandler = (request: ReceivedRequest, peer: FakePeer) => Reply;

/** The answer to a `hello`: a welcome (`server.welcome()` by default) or a refusal. */
export type HelloReply =
  | { welcome: unknown }
  | { goodbye: string; close: number }
  /** Leave the hello unanswered. */
  | undefined;

export type HelloHandler = (hello: Record<string, unknown>, peer: FakePeer) => HelloReply;

/** Yields to pending microtasks a number of times; fine under fake timers. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const later = (fn: () => void) => {
  Promise.resolve().then(fn);
};

/** The client-facing socket: the subset of the WHATWG `WebSocket` the client uses. */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  readonly url: string;
  /** The server side of this connection. */
  readonly peer: FakePeer;
  readonly #listeners = new Map<string, Listener[]>();

  constructor(url: string, server: FakeServer) {
    this.url = url;
    this.peer = new FakePeer(server, this);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type);
    if (list)
      this.#listeners.set(
        type,
        list.filter((l) => l !== listener),
      );
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("FakeSocket: send while not open");
    this.peer.receive(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeSocket.CLOSING || this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSING;
    this.peer.closedByClient = { code, reason };
    later(() => this.dispatchClose(code, reason));
  }

  /** @internal */
  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }

  /** @internal */
  dispatchClose(code: number, reason: string): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.peer.closed = { code, reason };
    this.dispatch("close", { code, reason, wasClean: code !== 1006 });
  }
}

/** The server side of one connection. */
export class FakePeer {
  readonly server: FakeServer;
  readonly socket: FakeSocket;
  /** Every frame the client sent on this connection, in order. */
  readonly frames: ClientFrame[] = [];
  /** Set when the client called `close` on its socket. */
  closedByClient: { code: number; reason: string } | null = null;
  /** Set once the close event was delivered to the client. */
  closed: { code: number; reason: string } | null = null;

  constructor(server: FakeServer, socket: FakeSocket) {
    this.server = server;
    this.socket = socket;
  }

  get url(): string {
    return this.socket.url;
  }

  /** The `hello` frame, if one arrived. */
  get hello(): Record<string, unknown> | undefined {
    return this.frames.find((f) => f.message.type === "hello")?.message;
  }

  /** Requests received on this connection, optionally of one method. */
  requests(method?: string): ReceivedRequest[] {
    return this.frames
      .map((f) => f.message as ReceivedRequest)
      .filter((m) => m.type === "request" && (method === undefined || m.method === method));
  }

  /** The most recent request (of one method). */
  lastRequest(method?: string): ReceivedRequest {
    const all = this.requests(method);
    const last = all[all.length - 1];
    if (!last) throw new Error(`FakePeer: no ${method ?? ""} request received`);
    return last;
  }

  /** Delivers one frame to the client now; objects are JSON-encoded, strings sent as is. */
  send(message: unknown): void {
    if (this.socket.readyState !== FakeSocket.OPEN) return;
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.socket.dispatch("message", { data });
  }

  respond(id: string, result: unknown): void {
    this.send({ type: "response", id, ok: true, result });
  }

  respondError(id: string | null, error: ProtocolError): void {
    this.send({ type: "response", id, ok: false, error });
  }

  /** Closes the connection from the server side; the client sees it now. */
  close(code = 1001, reason = ""): void {
    if (this.socket.readyState === FakeSocket.CLOSED) return;
    this.socket.dispatchClose(code, reason);
  }

  /** Drops the connection abnormally (1006), as a lost transport. */
  drop(): void {
    this.close(1006, "");
  }

  /** @internal Called by the fake socket's `send`. */
  receive(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    this.frames.push({ text, message });
    this.server.received.push({ text, message });
    if (message.type === "hello") {
      const reply = this.server.onHello(message, this);
      later(() => this.#replyHello(reply));
    } else if (message.type === "request") {
      const request = message as ReceivedRequest;
      const handler = this.server.handlers.get(request.method);
      if (!handler) return;
      const reply = handler(request, this);
      later(() => this.#reply(request, reply));
    }
  }

  #replyHello(reply: HelloReply): void {
    if (reply === undefined) return;
    if ("welcome" in reply) {
      this.send(reply.welcome);
    } else {
      this.send({ type: "goodbye", reason: reply.goodbye });
      this.close(reply.close, reply.goodbye);
    }
  }

  #reply(request: ReceivedRequest, reply: Reply): void {
    if (reply === undefined) return;
    if ("result" in reply) this.respond(request.id, reply.result);
    else if ("error" in reply) this.respondError(request.id, reply.error);
    else for (const frame of reply.frames) this.send(frame);
  }
}

/** The server: a `WebSocket` constructor for the client plus the connections it made. */
export class FakeServer {
  token = "tok";
  session = "session-1";
  revision = 0;
  boards: unknown[] = [{ id: "gm_board", name: "GM" }];
  table: { name: string; path: string | null; id: string | null } = {
    name: "game.json",
    path: "/tables/game.json",
    id: "table-id-1",
  };
  actor: unknown = { type: "gm" };
  /** When false, new sockets fail: an `error` event, then close 1006. */
  accepting = true;
  /** Every connection ever made, oldest first. */
  readonly peers: FakePeer[] = [];
  /** Every frame received on any connection, in order. */
  readonly received: ClientFrame[] = [];
  /** Scripted request replies by method. */
  readonly handlers = new Map<string, RequestHandler>();
  /** Answers a `hello`; replace to script refusals or silence. */
  onHello: HelloHandler = (hello) =>
    hello.token === this.token
      ? { welcome: this.welcome() }
      : { goodbye: "unauthorized", close: 4401 };

  /** Inject as the client's `WebSocket` option. */
  readonly WebSocket: new (
    url: string,
  ) => FakeSocket;

  constructor() {
    const server = this;
    this.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url, server);
        server.peers.push(this.peer);
        const accepting = server.accepting;
        later(() => {
          if (accepting) {
            this.readyState = FakeSocket.OPEN;
            this.dispatch("open", {});
          } else {
            this.dispatch("error", {});
            this.dispatchClose(1006, "");
          }
        });
      }
    };
  }

  /** The latest connection. */
  get peer(): FakePeer {
    const peer = this.peers[this.peers.length - 1];
    if (!peer) throw new Error("FakeServer: no connection yet");
    return peer;
  }

  /** A `welcome` from the server's current fields, with overrides. */
  welcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "welcome",
      protocol: 1,
      session: this.session,
      actor: this.actor,
      revision: this.revision,
      boards: this.boards,
      table: this.table,
      limits: { ...LIMITS },
      ...overrides,
    };
  }

  /** Scripts replies for a method. */
  handle(method: string, handler: RequestHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Requests received on every connection, optionally of one method. */
  requests(method?: string): ReceivedRequest[] {
    return this.received
      .map((f) => f.message as ReceivedRequest)
      .filter((m) => m.type === "request" && (method === undefined || m.method === method));
  }
}

// ---------------------------------------------------------------------------
// Builders for views, covers, groups and events

export function obj(id: string, hp?: number): ObjectView {
  return {
    id,
    is_template: false,
    is_character: false,
    cells:
      hp === undefined ? {} : { hp: { value: { type: "number", value: hp }, kind: "literal" } },
    actions: [],
  };
}

export function cover(key: string, board = "map"): Cover {
  return { key, board, region: { whole_board: true } };
}

export function header(index: number, revision = index + 1): GroupHeader {
  return { index, revision, actor: { type: "gm" }, kind: "edit", label: `edit ${index}` };
}

export function group(index: number, undone = false): GroupView {
  return { ...header(index), base_revision: index, undone, names: {} };
}

export function delta(subscription: string, fields: Partial<SubscriptionDelta> = {}) {
  return { subscription, objects: [], removed: [], ...fields };
}

export function commit(revision: number, deltas: unknown[] = [], extra: object = {}) {
  return {
    type: "event",
    event: "commit",
    revision,
    group: header(revision - 1, revision),
    deltas,
    ...extra,
  };
}

export function subscribeResult(subscription: string, revision: number, fields: object = {}) {
  return { subscription, revision, objects: [], covers: [], ...fields };
}
