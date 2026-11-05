/**
 * The protocol client (PROTOCOL.md §1–§3, §6, §8, §10, §12; DESIGN.md §7:
 * the UI and the agent are two clients of the same protocol): one WebSocket
 * connection, request correlation, per-method result validation, subscription
 * mirrors and events. Browser-safe: it takes a WebSocket constructor (the
 * global one by default) and uses only web-platform globals.
 *
 * It never reconnects, retries or resubscribes by itself. Those live in
 * `client/recovery.ts` (vtt-5su.19), which drives this class only through the
 * recovery seam documented on the members marked "Recovery seam":
 * `on("socket_closed")`, `reopen`, `setState`, `setConnectionError`,
 * `liveSubscriptions`, `requestDuringRecovery`, `abortSocket`, and on a
 * `Subscription`: `rebind`, `markRecovering`, `fail`.
 */
import type { Actor, ObjectId } from "@vtt/schema";
import {
  type CommitEvent,
  type ProtocolError,
  ProtocolFailure,
  parseResult,
  parseServerMessage,
  type ResponseMessage,
  type SaveEvent,
  type SubscriptionDelta,
  type Welcome,
} from "./messages";
import type {
  MethodName,
  Params,
  Result,
  SubscribeParams,
  SubscribeResult,
  TransactParams,
  TransactResult,
} from "./methods";
import { ViewMirror } from "./mirror";
import type { WireOp } from "./ops";
import { CLOSE_CODES, PROTOCOL_VERSION } from "./version";
import type { BoardView, GroupHeader, ObjectView } from "./views";

// ---------------------------------------------------------------------------
// Types

/**
 * `idle` before the first `connect` and after a socket closes; this class
 * enters `connecting` (during `connect`), `open` and `closed` by itself, and
 * `reconnecting` and `recovering` only through `setState`.
 */
export type ClientState = "idle" | "connecting" | "open" | "reconnecting" | "recovering" | "closed";

/** Why the client cannot serve ordinary callers (PROTOCOL.md §2, §8). */
export type ConnectionError = {
  code: "disconnected" | "unauthorized" | "wrong_table";
  message: string;
  /** Connected again, subscriptions still being resubscribed (§8). */
  recovering?: true;
};

/** The table a `welcome` names (§2). */
export type TableIdentity = Welcome["table"];

/** Payload of `socket_closed`. `byClose` is true only for `close()`. */
export type SocketClosedInfo = { code: number; reason: string; byClose: boolean };

/** Payload of a subscription's `resync` (§8). */
export type ResyncInfo = { from_revision: number; to_revision: number; session_changed: boolean };

/**
 * One delta entry of a commit event, emitted after the mirror applied it.
 * `before` and `after` are keyed by every id in `delta.objects` and
 * `delta.removed`; `undefined` means absent from the mirror.
 */
export type DeltaEvent = {
  revision: number;
  group: GroupHeader;
  delta: SubscriptionDelta;
  before: Map<ObjectId, ObjectView | undefined>;
  after: Map<ObjectId, ObjectView | undefined>;
};

export type SubscriptionState = "live" | "recovering" | "failed" | "closed";

export type SubscriptionEvents = {
  delta: DeltaEvent;
  /** Emitted only through `rebind`. */
  resync: ResyncInfo;
  /** Emitted only through `fail`, once. */
  error: ProtocolError;
};

export interface Subscription {
  /** The protocol id on the current connection; changes on `rebind`. */
  readonly id: string;
  readonly params: SubscribeParams;
  readonly mirror: ViewMirror;
  readonly state: SubscriptionState;
  /** Adds a listener; returns a function that removes it. */
  on<E extends keyof SubscriptionEvents>(
    event: E,
    fn: (sub: Subscription, payload: SubscriptionEvents[E]) => void,
  ): () => void;
  /**
   * Stops the subscription locally and, when it is bound to the current
   * connection, sends `unsubscribe`. A `failed`, `recovering` or already
   * closed subscription closes without a request; a `disconnected` failure
   * of the request is ignored (the server-side subscription died with the
   * socket).
   */
  close(): Promise<void>;
  /**
   * Recovery seam: validates `result` with `parseResult("subscribe", …)`
   * (throwing its `ProtocolFailure` when invalid, nothing changed), replaces
   * the protocol id, resets the mirror, sets `live` and emits `resync` with
   * `info`. On a subscription closed meanwhile it only unsubscribes `id`.
   */
  rebind(id: string, result: SubscribeResult, info: ResyncInfo): void;
  /** Recovery seam: `state: "recovering"`; the mirror is kept; no event. */
  markRecovering(): void;
  /** Recovery seam: `state: "failed"`, mirror emptied, `error` emitted once. */
  fail(error: ProtocolError | ProtocolFailure): void;
}

export type ClientEvents = {
  commit: CommitEvent;
  save: SaveEvent;
  /** The new state; also emitted, with the current state, when `connectionError()` changes. */
  state: ClientState;
  /** Recovery seam: after the socket's pending requests were rejected. */
  socket_closed: SocketClosedInfo;
};

/** The subset of the WHATWG `WebSocket` the client uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // `any`: the platform's listener types (DOM, undici) differ; the client reads only
  // `data` (message) and `code`/`reason` (close).
  // biome-ignore lint/suspicious/noExplicitAny: see above
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** Timer functions; the globals by default (fake timers patch those). */
export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ProtocolClientOptions = {
  url: string;
  token: string;
  client: { name: string; kind: "ui" | "agent" | "test" };
  /** Sent as `hello.client.instance` on every connect; never changes (§2, §6). */
  instance?: string;
  /** A function is evaluated each time a `hello` is sent. */
  agent_name?: string | (() => string | undefined);
  WebSocket?: WebSocketConstructor;
  requestTimeoutMs?: number;
  onWarning?: (message: string) => void;
  timers?: Timers;
};

export type TransactOptions = {
  label?: string;
  /** Defaults to `client.revision`. */
  base_revision?: number;
  /** Defaults to a new UUID. */
  txn_id?: string;
  actor?: TransactParams["actor"];
};

// ---------------------------------------------------------------------------
// Internals

type Listener<P> = (payload: P) => void;

/** Methods whose sent-but-unsettled outcome is `uncertain` (PROTOCOL.md §6). */
const isWrite = (method: MethodName) => method === "transact" || method === "undo";

type Pending = {
  method: MethodName;
  txn_id: string | undefined;
  timer: unknown;
  resolve(value: unknown): void;
  reject(failure: unknown): void;
};

type Attempt = {
  kind: "connect" | "reopen";
  resolve(welcome: Welcome): void;
  reject(failure: ProtocolFailure): void;
};

type CloseMode = "drop" | "abort" | "close";

/** How long a socket refused by `goodbye` may stay open before the client closes it. */
const GOODBYE_CLOSE_MS = 1000;

/**
 * The error a `goodbye` during the handshake refuses it with (PROTOCOL.md §2:
 * 4401 for a wrong token, 4400 for another protocol). The wire fixes no
 * reason strings, so this reads the reason; the close code, when it
 * follows, is authoritative for `connectionError()`.
 */
function goodbyeFailure(reason: string): ProtocolFailure {
  if (/unauthori[sz]ed|token/i.test(reason)) {
    return new ProtocolFailure("unauthorized", `the authority refused the token: ${reason}`);
  }
  if (/protocol|version/i.test(reason)) {
    return new ProtocolFailure("protocol_version", `the authority refused the protocol: ${reason}`);
  }
  return new ProtocolFailure("disconnected", `the authority refused the connection: ${reason}`);
}

const terminalFailure = () =>
  new ProtocolFailure("disconnected", "the client is closed", { sent: false });

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

/** A close reason within the 123-byte WebSocket limit. */
function closeReason(reason: string): string {
  return new TextEncoder().encode(reason).length <= 123 ? reason : reason.slice(0, 40);
}

function disconnectedError(message: string): ConnectionError {
  return { code: "disconnected", message };
}

const sameError = (a: ConnectionError | null, b: ConnectionError | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.code === b.code &&
    a.message === b.message &&
    a.recovering === b.recovering);

/** What the client's subscriptions need from it. */
interface SubscriptionHost {
  bind(sub: SubscriptionHandle, id: string): void;
  /** Forgets the subscription; returns whether it was bound to the current connection. */
  release(sub: SubscriptionHandle): boolean;
  unsubscribe(id: string): Promise<void>;
  warn(message: string): void;
}

class SubscriptionHandle implements Subscription {
  readonly params: SubscribeParams;
  readonly mirror: ViewMirror;
  #id: string;
  #state: SubscriptionState = "live";
  readonly #host: SubscriptionHost;
  readonly #listeners = new Map<string, Set<(sub: Subscription, payload: never) => void>>();

  constructor(host: SubscriptionHost, params: SubscribeParams, result: SubscribeResult) {
    this.#host = host;
    this.params = params;
    this.#id = result.subscription;
    this.mirror = new ViewMirror(result);
  }

  get id(): string {
    return this.#id;
  }

  get state(): SubscriptionState {
    return this.#state;
  }

  on<E extends keyof SubscriptionEvents>(
    event: E,
    fn: (sub: Subscription, payload: SubscriptionEvents[E]) => void,
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** @internal */
  emit<E extends keyof SubscriptionEvents>(event: E, payload: SubscriptionEvents[E]): void {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (fn as (sub: Subscription, payload: SubscriptionEvents[E]) => void)(this, payload);
      } catch (e) {
        this.#host.warn(`a subscription ${event} listener threw: ${String(e)}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    const wasLive = this.#state === "live";
    this.#state = "closed";
    const bound = this.#host.release(this);
    if (!wasLive || !bound) return;
    try {
      await this.#host.unsubscribe(this.#id);
    } catch (e) {
      if (e instanceof ProtocolFailure && e.error.code === "disconnected") return;
      throw e;
    }
  }

  /** @internal Marks the subscription closed without a request or event (client `close()`). */
  closeLocally(): void {
    this.#state = "closed";
  }

  rebind(id: string, result: SubscribeResult, info: ResyncInfo): void {
    const parsed = parseResult("subscribe", result);
    if (!parsed.ok) {
      throw new ProtocolFailure(parsed.error.code, parsed.error.message, parsed.error.details);
    }
    for (const warning of parsed.warnings) this.#host.warn(warning);
    if (this.#state === "closed" || this.#state === "failed") {
      this.#host.unsubscribe(id).catch(() => {});
      return;
    }
    this.#id = id;
    this.#host.bind(this, id);
    this.#state = "live";
    this.mirror.reset(parsed.value);
    this.emit("resync", info);
  }

  markRecovering(): void {
    if (this.#state === "live" || this.#state === "recovering") this.#state = "recovering";
  }

  fail(error: ProtocolError | ProtocolFailure): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#host.release(this);
    this.mirror.clear(this.mirror.revision);
    this.emit("error", error instanceof ProtocolFailure ? error.error : error);
  }
}

// ---------------------------------------------------------------------------
// The client

export class ProtocolClient {
  /** Sent as `hello.client.instance` on every connect of this object. */
  readonly instance: string;

  #url: string;
  #token: string;
  readonly #clientInfo: ProtocolClientOptions["client"];
  readonly #agentName: ProtocolClientOptions["agent_name"];
  readonly #WebSocket: WebSocketConstructor | undefined;
  readonly #requestTimeoutMs: number;
  readonly #onWarning: (message: string) => void;
  readonly #timers: Timers;

  #state: ClientState = "idle";
  #connectionError: ConnectionError | null = disconnectedError("not connected yet");

  #socket: WebSocketLike | null = null;
  /** The current socket completed the handshake. */
  #welcomed = false;
  #attempt: Attempt | null = null;
  #goodbye: string | null = null;
  /** Set by `close()`; nothing opens, sends or changes state afterwards. */
  #terminal = false;
  /** Sockets refused by `goodbye`, detached, waiting for their close. */
  readonly #refused = new Map<
    WebSocketLike,
    { kind: Attempt["kind"]; reason: string; timer: unknown }
  >();

  #nextId = 1;
  readonly #pending = new Map<string, Pending>();

  #session: string | null = null;
  #actor: Actor | null = null;
  #limits: Welcome["limits"] | null = null;
  #table: TableIdentity | null = null;
  #revision = 0;
  #boards: BoardView[] = [];

  /** Non-terminal subscriptions (`live` or `recovering`), in creation order. */
  readonly #subs = new Set<SubscriptionHandle>();
  /** Subscriptions bound to the current connection, by protocol id. */
  readonly #bound = new Map<string, SubscriptionHandle>();
  readonly #listeners = new Map<string, Set<Listener<never>>>();
  readonly #host: SubscriptionHost;

  constructor(options: ProtocolClientOptions) {
    this.#url = options.url;
    this.#token = options.token;
    this.#clientInfo = { ...options.client };
    this.instance = options.instance ?? globalThis.crypto.randomUUID();
    this.#agentName = options.agent_name;
    this.#WebSocket = options.WebSocket;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.#onWarning = options.onWarning ?? ((message) => console.warn(message));
    this.#timers = options.timers ?? defaultTimers;
    this.#host = {
      bind: (sub, id) => {
        for (const [key, value] of this.#bound) if (value === sub) this.#bound.delete(key);
        this.#bound.set(id, sub);
      },
      release: (sub) => {
        this.#subs.delete(sub);
        let bound = false;
        for (const [key, value] of this.#bound) {
          if (value === sub) {
            this.#bound.delete(key);
            bound = true;
          }
        }
        return bound;
      },
      unsubscribe: async (id) => {
        await this.#send("unsubscribe", { subscription: id }, true);
      },
      warn: (message) => this.#warn(message),
    };
  }

  // -------------------------------------------------------------------------
  // State

  get state(): ClientState {
    return this.#state;
  }

  /** `state === "open"` and no connection error. */
  get ready(): boolean {
    return this.#state === "open" && this.#connectionError === null;
  }

  /**
   * `disconnected` from construction until the first `welcome` of
   * `connect()`; `disconnected` or `unauthorized` (4401) after the socket
   * closes other than by `close()`. `reopen` does not clear it;
   * `wrong_table` and `recovering` are only set through `setConnectionError`.
   */
  connectionError(): ConnectionError | null {
    return this.#connectionError;
  }

  /** From the latest `welcome`; null before the first. */
  get session(): string | null {
    return this.#session;
  }

  get actor(): Actor | null {
    return this.#actor;
  }

  get limits(): Welcome["limits"] | null {
    return this.#limits;
  }

  get table(): TableIdentity | null {
    return this.#table;
  }

  /** From `welcome`, then from every commit event. */
  get revision(): number {
    return this.#revision;
  }

  /** From `welcome` and from commit events that carry `boards`. */
  get boards(): readonly BoardView[] {
    return this.#boards;
  }

  /** Adds a listener; returns a function that removes it. */
  on<E extends keyof ClientEvents>(event: E, fn: Listener<ClientEvents[E]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => {
      set.delete(fn as Listener<never>);
    };
  }

  // -------------------------------------------------------------------------
  // Connection

  /**
   * Opens the socket and sends `hello`. Resolves with the `welcome`, which
   * clears `connectionError()` and sets state `open`. Rejects on a close
   * (after `goodbye` when the server sends one): `unauthorized` for 4401,
   * `protocol_version` for 4400, `disconnected` otherwise.
   */
  connect(): Promise<Welcome> {
    return this.#open("connect");
  }

  /**
   * Recovery seam: opens a new socket to `creds.url` with `creds.token` (or
   * the current ones; given credentials are kept for later), sends `hello`
   * with the same `instance`, and applies the `welcome` (session, actor,
   * revision, boards, table, limits) without touching `state` or
   * `connectionError()`. Rejects with the close code's error, or
   * `disconnected` for a transport failure; a failed attempt changes neither
   * state nor connection error and emits no `socket_closed`.
   */
  reopen(creds?: { url: string; token: string }): Promise<Welcome> {
    if (creds && !this.#terminal && this.#socket === null) {
      this.#url = creds.url;
      this.#token = creds.token;
    }
    return this.#open("reopen");
  }

  /**
   * Terminal: state `closed`, the socket closed (`socket_closed` with
   * `byClose: true`), pending requests rejected, every subscription
   * `closed`; nothing happens afterwards. `connectionError()` becomes
   * `disconnected` unless it already holds an error.
   */
  close(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    for (const [socket, { timer }] of this.#refused) {
      this.#timers.clearTimeout(timer);
      this.#closeSocket(socket, 1000, "client closed");
    }
    this.#refused.clear();
    for (const sub of this.#subs) sub.closeLocally();
    this.#subs.clear();
    this.#bound.clear();
    const socket = this.#socket;
    if (socket) {
      this.#closeSocket(socket, 1000, "client closed");
      this.#socketClosed(socket, 1000, "client closed", "close");
    } else {
      this.#set("closed", this.#connectionError ?? disconnectedError("the client was closed"));
    }
  }

  /**
   * Recovery seam: sets the state; `"closed"` is `close()` keeping the
   * connection error. A no-op once the client is closed.
   */
  setState(state: ClientState): void {
    if (this.#terminal) return;
    if (state === "closed") this.close();
    else this.#set(state, this.#connectionError);
  }

  /** Recovery seam: sets or clears the connection error. */
  setConnectionError(error: ConnectionError | null): void {
    this.#set(this.#state, error === null ? null : { ...error });
  }

  /** Recovery seam: the subscriptions that are `live` or `recovering`, in creation order. */
  liveSubscriptions(): Subscription[] {
    return [...this.#subs];
  }

  /**
   * Recovery seam: closes the current socket with code 4000, rejects its
   * pending requests as a drop would, sets `connectionError()` to
   * `disconnected`, state `idle`, and emits `socket_closed` with `{code:
   * 4000, reason, byClose: false}`. `reopen` can connect again. Never
   * terminal; does nothing after `close()`.
   */
  abortSocket(reason: string): void {
    if (this.#terminal) return;
    const socket = this.#socket;
    if (!socket) {
      this.#set("idle", this.#connectionError);
      return;
    }
    this.#closeSocket(socket, 4000, reason);
    this.#socketClosed(socket, 4000, reason, "abort");
  }

  // -------------------------------------------------------------------------
  // Requests

  /**
   * Sends a request and resolves with its result, validated and normalized
   * by `parseResult(method, …)`. Rejects with a `ProtocolFailure`:
   * - not `open`: `disconnected`, `details: {sent: false}`, nothing sent;
   * - an error response: its `ProtocolError`;
   * - a result failing the method's schema: `internal`, `details: {type:
   *   "protocol", method}` (the connection stays open);
   * - no response in `requestTimeoutMs`: `timeout` for a query, `uncertain`
   *   with `details: {sent: true, reason: "timeout", txn_id?}` for a write
   *   (`transact`, `undo`);
   * - the socket closing first: `disconnected` with `details: {sent: true}`
   *   for a query, `uncertain` with `reason: "socket_closed"` for a write.
   */
  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.#send(method, params, false);
  }

  /**
   * Recovery seam: `request` with the same correlation, timeout and
   * validation, allowed in any state but `closed` while a socket is
   * connected (so in state `recovering`).
   */
  requestDuringRecovery<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.#send(method, params, true);
  }

  /** `transact` with `base_revision = client.revision` and a UUID `txn_id` by default; never retries. */
  transact(ops: WireOp[], options: TransactOptions = {}): Promise<TransactResult> {
    const params: TransactParams = {
      base_revision: options.base_revision ?? this.#revision,
      ops,
      txn_id: options.txn_id ?? globalThis.crypto.randomUUID(),
    };
    if (options.label !== undefined) params.label = options.label;
    if (options.actor !== undefined) params.actor = options.actor;
    return this.request("transact", params);
  }

  /**
   * Subscribes; the result is validated before the mirror is created, and the
   * subscription is registered before any later frame is processed.
   */
  subscribe(params: SubscribeParams): Promise<Subscription> {
    return this.#send("subscribe", params, false, (result) => {
      const sub = new SubscriptionHandle(this.#host, params, result);
      this.#subs.add(sub);
      this.#bound.set(result.subscription, sub);
      return sub;
    });
  }

  // -------------------------------------------------------------------------
  // Internals

  #warn(message: string): void {
    try {
      this.#onWarning(message);
    } catch {
      // A throwing warning sink must not break the client.
    }
  }

  #emit<E extends keyof ClientEvents>(event: E, payload: ClientEvents[E]): void {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (fn as Listener<ClientEvents[E]>)(payload);
      } catch (e) {
        this.#warn(`a ${event} listener threw: ${String(e)}`);
      }
    }
  }

  /** Sets state and connection error, emitting `state` once if either changed. */
  #set(state: ClientState, error: ConnectionError | null): void {
    const changed = state !== this.#state || !sameError(error, this.#connectionError);
    this.#state = state;
    this.#connectionError = error;
    if (changed) this.#emit("state", state);
  }

  #open(kind: Attempt["kind"]): Promise<Welcome> {
    if (this.#terminal) return Promise.reject(terminalFailure());
    if (this.#socket !== null) {
      return Promise.reject(new Error("ProtocolClient: a connection is already open or opening"));
    }
    const WS =
      this.#WebSocket ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ??
      undefined;
    let socket: WebSocketLike;
    try {
      if (!WS) throw new Error("no WebSocket implementation");
      socket = new WS(this.#url);
    } catch (e) {
      if (kind === "connect") this.#set("idle", this.#connectionError);
      return Promise.reject(
        new ProtocolFailure("disconnected", `cannot open ${this.#url}: ${String(e)}`),
      );
    }
    this.#socket = socket;
    this.#welcomed = false;
    this.#goodbye = null;
    const promise = new Promise<Welcome>((resolve, reject) => {
      this.#attempt = { kind, resolve, reject };
    });
    if (kind === "connect") this.#set("connecting", this.#connectionError);
    socket.addEventListener("open", () => this.#sendHello(socket));
    socket.addEventListener("message", (event: { data: unknown }) =>
      this.#onFrame(socket, event.data),
    );
    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      if (this.#refused.has(socket)) this.#refusedClosed(socket, event.code ?? 1006);
      else this.#socketClosed(socket, event.code ?? 1006, event.reason ?? "", "drop");
    });
    // A failed socket also fires `close`, which settles everything.
    socket.addEventListener("error", () => {});
    return promise;
  }

  #sendHello(socket: WebSocketLike): void {
    if (socket !== this.#socket) return;
    const agentName = typeof this.#agentName === "function" ? this.#agentName() : this.#agentName;
    const hello = {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      token: this.#token,
      client: { ...this.#clientInfo, instance: this.instance },
      ...(agentName === undefined ? {} : { agent_name: agentName }),
    };
    try {
      socket.send(JSON.stringify(hello));
    } catch (e) {
      this.#closeSocket(socket, 1000, "hello failed");
      this.#socketClosed(socket, 1006, `hello could not be sent: ${String(e)}`, "drop");
    }
  }

  #closeSocket(socket: WebSocketLike, code: number, reason: string): void {
    try {
      socket.close(code, closeReason(reason));
    } catch {
      // Already closed, or the implementation refused the code: either way we are done with it.
    }
  }

  /** A malformed envelope or binary frame: closes the socket (PROTOCOL.md §12). */
  #violation(socket: WebSocketLike, message: string): void {
    this.#warn(`closing the connection: ${message}`);
    const reason = "protocol error";
    this.#closeSocket(socket, CLOSE_CODES.protocol, reason);
    this.#socketClosed(
      socket,
      CLOSE_CODES.protocol,
      reason,
      "drop",
      new ProtocolFailure("internal", message, { type: "protocol" }),
    );
  }

  #onFrame(socket: WebSocketLike, data: unknown): void {
    if (socket !== this.#socket) return;
    if (typeof data !== "string") {
      this.#violation(socket, "a binary frame (the protocol uses JSON text frames)");
      return;
    }
    const parsed = parseServerMessage(data);
    if (parsed.ok === "ignored") {
      this.#warn(parsed.reason);
      return;
    }
    if (parsed.ok === false) {
      this.#violation(socket, parsed.error.message);
      return;
    }
    for (const warning of parsed.warnings) this.#warn(warning);
    const message = parsed.message;
    switch (message.type) {
      case "welcome":
        this.#onWelcome(message);
        return;
      case "goodbye":
        this.#onGoodbye(socket, message.reason);
        return;
      case "response":
        this.#onResponse(message);
        return;
      case "event":
        if (message.event === "commit") this.#onCommit(message);
        else this.#emit("save", message);
        return;
    }
  }

  /**
   * A `goodbye` during the handshake refuses it at once: the attempt rejects,
   * the socket is detached (a later `welcome` on it is ignored), and the
   * client closes it unless the server does within `GOODBYE_CLOSE_MS`. On an
   * established connection it only records the reason for the close.
   */
  #onGoodbye(socket: WebSocketLike, reason: string): void {
    this.#goodbye = reason;
    const attempt = this.#attempt;
    if (this.#welcomed || !attempt) return;
    const failure = goodbyeFailure(reason);
    const code =
      failure.error.code === "unauthorized"
        ? CLOSE_CODES.unauthorized
        : failure.error.code === "protocol_version"
          ? CLOSE_CODES.protocol
          : 1000;
    this.#socketClosed(socket, code, reason, "drop", failure);
    const timer = this.#timers.setTimeout(() => {
      if (!this.#refused.delete(socket)) return;
      this.#closeSocket(socket, 1000, "goodbye");
    }, GOODBYE_CLOSE_MS);
    this.#refused.set(socket, { kind: attempt.kind, reason, timer });
  }

  /** The close of a socket refused by `goodbye`: the close code is authoritative. */
  #refusedClosed(socket: WebSocketLike, code: number): void {
    const refused = this.#refused.get(socket);
    if (!refused) return;
    this.#refused.delete(socket);
    this.#timers.clearTimeout(refused.timer);
    // Only a refused `connect` owns the connection error, and only while no newer socket exists.
    if (this.#terminal || refused.kind !== "connect" || this.#socket !== null) return;
    const current = this.#connectionError;
    if (code === CLOSE_CODES.unauthorized && current?.code !== "unauthorized") {
      this.#set(this.#state, { code: "unauthorized", message: refused.reason });
    } else if (code !== CLOSE_CODES.unauthorized && current?.code === "unauthorized") {
      this.#set(this.#state, disconnectedError(`the connection closed (${code})`));
    }
  }

  #onWelcome(welcome: Welcome): void {
    const attempt = this.#attempt;
    if (!attempt || this.#welcomed) {
      this.#warn("ignored an unexpected welcome");
      return;
    }
    this.#attempt = null;
    this.#welcomed = true;
    this.#session = welcome.session;
    this.#actor = welcome.actor;
    this.#limits = welcome.limits;
    this.#table = welcome.table;
    this.#revision = welcome.revision;
    this.#boards = welcome.boards;
    if (attempt.kind === "connect") this.#set("open", null);
    attempt.resolve(welcome);
  }

  #onResponse(response: ResponseMessage): void {
    if (response.id === null) {
      const detail = response.ok ? "" : `: ${response.error.code}: ${response.error.message}`;
      this.#warn(`a response without a request id${detail}`);
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) {
      this.#warn(`a response for no pending request (id ${response.id})`);
      return;
    }
    this.#pending.delete(response.id);
    this.#timers.clearTimeout(pending.timer);
    if (!response.ok) {
      const { code, message, details } = response.error;
      pending.reject(new ProtocolFailure(code, message, details));
      return;
    }
    const parsed = parseResult(pending.method, response.result);
    if (!parsed.ok) {
      const { code, message, details } = parsed.error;
      pending.reject(new ProtocolFailure(code, message, details));
      return;
    }
    for (const warning of parsed.warnings) this.#warn(warning);
    pending.resolve(parsed.value);
  }

  #onCommit(event: CommitEvent): void {
    this.#revision = event.revision;
    if (event.boards) this.#boards = event.boards;
    const deltas: [SubscriptionHandle, DeltaEvent][] = [];
    const applied = new Set<SubscriptionHandle>();
    for (const delta of event.deltas) {
      const sub = this.#bound.get(delta.subscription);
      if (sub?.state !== "live") continue;
      const ids = [...delta.objects.map((view) => view.id), ...delta.removed];
      const before = new Map(ids.map((id) => [id, sub.mirror.objects.get(id)]));
      sub.mirror.apply(delta, event.revision);
      const after = new Map(ids.map((id) => [id, sub.mirror.objects.get(id)]));
      applied.add(sub);
      deltas.push([sub, { revision: event.revision, group: event.group, delta, before, after }]);
    }
    for (const sub of this.#bound.values()) {
      if (sub.state === "live" && !applied.has(sub)) sub.mirror.advance(event.revision);
    }
    for (const [sub, payload] of deltas) sub.emit("delta", payload);
    this.#emit("commit", event);
  }

  #send<M extends MethodName, T = Result<M>>(
    method: M,
    params: Params<M>,
    duringRecovery: boolean,
    onValue?: (value: Result<M>) => T,
  ): Promise<T> {
    const socket = this.#socket;
    const allowed = duringRecovery ? this.#state !== "closed" : this.#state === "open";
    if (this.#terminal || socket === null || !this.#welcomed || !allowed) {
      return Promise.reject(
        new ProtocolFailure("disconnected", `cannot send ${method}: not connected`, {
          sent: false,
        }),
      );
    }
    const id = String(this.#nextId++);
    const text = JSON.stringify({ type: "request", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        method,
        txn_id: method === "transact" ? (params as TransactParams).txn_id : undefined,
        timer: undefined,
        resolve: (value) => {
          try {
            resolve(onValue ? onValue(value as Result<M>) : (value as T));
          } catch (e) {
            reject(e);
          }
        },
        reject,
      };
      // Registered before the write, so even a synchronous reply correlates.
      this.#pending.set(id, pending);
      try {
        socket.send(text);
      } catch (e) {
        this.#pending.delete(id);
        reject(
          new ProtocolFailure("disconnected", `cannot send ${method}: ${String(e)}`, {
            sent: false,
          }),
        );
        return;
      }
      pending.timer = this.#timers.setTimeout(() => this.#timedOut(id), this.#requestTimeoutMs);
    });
  }

  #timedOut(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    const message = `${pending.method}: no response within ${this.#requestTimeoutMs} ms`;
    pending.reject(
      isWrite(pending.method)
        ? this.#uncertain(pending, "timeout", message)
        : new ProtocolFailure("timeout", message, { sent: true }),
    );
  }

  #uncertain(pending: Pending, reason: "timeout" | "socket_closed", message: string) {
    return new ProtocolFailure("uncertain", message, {
      sent: true,
      reason,
      ...(pending.txn_id === undefined ? {} : { txn_id: pending.txn_id }),
    });
  }

  /**
   * Settles everything a closed socket leaves behind. `drop` is a close the
   * client did not ask for (or a protocol violation), `abort` is
   * `abortSocket`, `close` is `close()`. A reopen attempt that never got its
   * `welcome` and drops only rejects that attempt.
   */
  #socketClosed(
    socket: WebSocketLike,
    code: number,
    reason: string,
    mode: CloseMode,
    attemptFailure?: ProtocolFailure,
  ): void {
    if (socket !== this.#socket) return;
    const welcomed = this.#welcomed;
    const attempt = this.#attempt;
    const goodbye = this.#goodbye;
    this.#socket = null;
    this.#welcomed = false;
    this.#attempt = null;
    this.#goodbye = null;
    this.#bound.clear();

    const pendings = [...this.#pending.values()];
    this.#pending.clear();
    const lost = `the connection closed (${code}${reason ? ` ${reason}` : ""})`;
    for (const pending of pendings) {
      this.#timers.clearTimeout(pending.timer);
      pending.reject(
        isWrite(pending.method)
          ? this.#uncertain(pending, "socket_closed", `${pending.method}: ${lost}`)
          : new ProtocolFailure("disconnected", `${pending.method}: ${lost}`, { sent: true }),
      );
    }

    let state = this.#state;
    let error = this.#connectionError;
    if (mode === "close") {
      state = "closed";
      error ??= disconnectedError("the client was closed");
    } else if (welcomed || mode === "abort" || attempt?.kind === "connect") {
      state = "idle";
      error =
        code === CLOSE_CODES.unauthorized
          ? { code: "unauthorized", message: goodbye ?? "unauthorized" }
          : disconnectedError(lost);
    }
    if (attempt) attempt.reject(attemptFailure ?? this.#closeFailure(code, reason, goodbye));
    this.#set(state, error);
    if (welcomed || mode !== "drop") {
      this.#emit("socket_closed", { code, reason, byClose: mode === "close" });
    }
  }

  #closeFailure(code: number, reason: string, goodbye: string | null): ProtocolFailure {
    const why = goodbye ?? reason;
    const suffix = why ? `: ${why}` : "";
    if (code === CLOSE_CODES.unauthorized) {
      return new ProtocolFailure("unauthorized", `the authority refused the token${suffix}`);
    }
    if (code === CLOSE_CODES.protocol) {
      return new ProtocolFailure("protocol_version", `the authority refused the protocol${suffix}`);
    }
    return new ProtocolFailure("disconnected", `the connection closed (${code})${suffix}`);
  }
}
