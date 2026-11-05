/**
 * Reconnection, write retry and subscription recovery (PROTOCOL.md §2, §6,
 * §8; decisions M3-D8, M3-D23) on top of `ProtocolClient`, driven only
 * through its recovery seam: `on("socket_closed")`, `reopen`, `setState`,
 * `setConnectionError`, `liveSubscriptions`, `requestDuringRecovery`,
 * `abortSocket`, and a subscription's `rebind`, `markRecovering`, `fail`.
 * Browser-safe: web-platform globals only.
 */
import type { ClientState, ProtocolClient, Subscription, Timers, TransactOptions } from "../client";
import { ProtocolFailure } from "../messages";
import type { SubscribeResult, TransactParams, TransactResult } from "../methods";
import type { WireOp } from "../ops";
import { CLOSE_CODES } from "../version";

// ---------------------------------------------------------------------------
// Types

/** What a discovery reader returns (PROTOCOL.md §2: the session file's fields). */
export type RecoveryCredentials = {
  url: string;
  token: string;
  table_path: string | null;
  table_id: string | null;
};

export type ReconnectBackoff = { initialMs: number; maxMs: number; factor: number };

export type RecoveryOptions = {
  /** Defaults: `{initialMs: 250, maxMs: 5000, factor: 2}`. */
  reconnect?: Partial<ReconnectBackoff>;
  /**
   * Discovery-based credentials, read before every connection attempt; `null`
   * means "no file". Absent: the client's explicit credentials, never refreshed.
   */
  credentials?: () => Promise<RecoveryCredentials | null>;
  /** The globals by default (fake timers patch those). */
  timers?: Timers;
};

/** `details.reason` of the `uncertain` errors `transactWithRetry` produces (§6). */
export type UncertainReason =
  | "timeout"
  | "not_ready"
  | "session_changed"
  | "retry_unknown"
  | "resend_lost"
  | "unauthorized"
  | "wrong_table";

export type TransactWithRetryOptions = TransactOptions & {
  /** How long to wait for the client to be ready again before resending. */
  retry: { timeoutMs: number };
  timers?: Timers;
};

// ---------------------------------------------------------------------------
// Internals

const DEFAULT_BACKOFF: ReconnectBackoff = { initialMs: 250, maxMs: 5000, factor: 2 };

const globalTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

type TablePair = { path: string | null; id: string | null };

const samePair = (a: TablePair, b: TablePair) => a.path === b.path && a.id === b.id;

const describePair = (p: TablePair) => `${p.path ?? "(in memory)"} [${p.id ?? "no id"}]`;

const codeOf = (e: unknown) => (e instanceof ProtocolFailure ? e.error.code : undefined);

class Recovery {
  readonly #client: ProtocolClient;
  readonly #backoff: ReconnectBackoff;
  readonly #credentials: RecoveryOptions["credentials"];
  readonly #timers: Timers;

  #stopped = false;
  /** Bumped by every attempt and every socket close; async continuations of older ones give up. */
  #epoch = 0;
  /** Index into the backoff sequence; reset once the client is ready. */
  #failures = 0;
  #timer: unknown = undefined;
  /** The table of the first successful `welcome` (§2, §8). */
  #identity: TablePair | null = null;
  /** A `wrong_table` welcome already caused one re-read and reconnect (discovery only). */
  #mismatchRetried = false;
  /** Set while this object aborts a socket itself, so its `socket_closed` is not a drop. */
  #selfAbort = false;
  /** The session each subscription was last bound on (for `resync.session_changed`). */
  readonly #boundSession = new WeakMap<Subscription, string | null>();
  readonly #unlisten: (() => void)[] = [];

  constructor(client: ProtocolClient, options: RecoveryOptions) {
    this.#client = client;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.reconnect };
    this.#credentials = options.credentials;
    this.#timers = options.timers ?? globalTimers;
  }

  start(): void {
    const client = this.#client;
    if (client.state === "closed") {
      this.#stopped = true;
      return;
    }
    this.#unlisten.push(
      client.on("socket_closed", (info) => this.#onSocketClosed(info.code, info.byClose)),
      client.on("state", (state) => {
        if (state === "closed") this.stop();
      }),
    );
    if (client.state === "connecting") {
      // A `connect()` is in flight: wait for its outcome.
      const off = client.on("state", (state) => {
        if (state === "connecting") return;
        off();
        if (this.#stopped) return;
        if (state === "open") this.#captureIdentity();
        else if (client.state === "idle") this.#begin();
      });
      return;
    }
    if (client.state === "open" || client.session !== null) this.#captureIdentity();
    if (client.state !== "open") this.#begin();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#epoch++;
    this.#timers.clearTimeout(this.#timer);
    for (const off of this.#unlisten) off();
  }

  /** Starts connecting from a client that is not open. */
  #begin(): void {
    if (this.#identity === null) {
      // Never connected: the first connection, attempted at once (§2).
      this.#client.setState("connecting");
      void this.#attempt();
    } else {
      this.#client.setState("reconnecting");
      this.#schedule();
    }
  }

  #captureIdentity(): void {
    const table = this.#client.table;
    if (table && this.#identity === null) this.#identity = { path: table.path, id: table.id };
  }

  #stale(epoch: number): boolean {
    return this.#stopped || epoch !== this.#epoch;
  }

  /** Ends recovery with a terminal connection error (§2, §8). */
  #terminal(code: "unauthorized" | "wrong_table", message: string): void {
    this.stop();
    this.#client.setConnectionError({ code, message });
    this.#client.setState("closed");
  }

  #onSocketClosed(code: number, byClose: boolean): void {
    if (this.#stopped || this.#selfAbort) return;
    if (byClose) {
      this.stop();
      return;
    }
    this.#epoch++;
    this.#timers.clearTimeout(this.#timer);
    const client = this.#client;
    const session = client.session;
    for (const sub of client.liveSubscriptions()) {
      if (!this.#boundSession.has(sub)) this.#boundSession.set(sub, session);
      sub.markRecovering();
    }
    if (code === CLOSE_CODES.protocol) {
      // A protocol violation or version mismatch: reconnecting would repeat it.
      this.stop();
      client.setState("closed");
      return;
    }
    if (code === CLOSE_CODES.unauthorized) {
      if (!this.#credentials) {
        this.#terminal("unauthorized", "the authority refused the token (4401)");
        return;
      }
      client.setConnectionError({
        code: "disconnected",
        message: "the authority refused the token; re-reading the session file",
      });
    }
    client.setState("reconnecting");
    this.#schedule();
  }

  #schedule(): void {
    if (this.#stopped) return;
    const { initialMs, maxMs, factor } = this.#backoff;
    const delay = Math.min(initialMs * factor ** this.#failures, maxMs);
    this.#failures++;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      void this.#attempt();
    }, delay);
  }

  async #readCredentials(): Promise<RecoveryCredentials | null> {
    try {
      return (await this.#credentials?.()) ?? null;
    } catch {
      return null;
    }
  }

  async #attempt(): Promise<void> {
    if (this.#stopped) return;
    const epoch = ++this.#epoch;
    const client = this.#client;
    let creds: { url: string; token: string } | undefined;
    if (this.#credentials) {
      const read = await this.#readCredentials();
      if (this.#stale(epoch)) return;
      if (read === null) {
        if (this.#identity === null) {
          // Before the first welcome, wait for the session file (§2).
          this.#schedule();
          return;
        }
      } else if (this.#identity !== null) {
        const pair = { path: read.table_path, id: read.table_id };
        if (!samePair(pair, this.#identity)) {
          this.#terminal(
            "wrong_table",
            `the session file names ${describePair(pair)}, not ${describePair(this.#identity)}`,
          );
          return;
        }
        creds = { url: read.url, token: read.token };
      } else {
        creds = { url: read.url, token: read.token };
      }
    }

    try {
      await client.reopen(creds);
    } catch (e) {
      if (this.#stale(epoch)) return;
      if (client.state === "closed") {
        this.stop();
        return;
      }
      if (codeOf(e) === "protocol_version") {
        // A handshake refused for the protocol version (goodbye, 4400): retrying would repeat it.
        this.stop();
        client.setState("closed");
        return;
      }
      if (codeOf(e) === "unauthorized" && !this.#credentials) {
        this.#terminal("unauthorized", "the authority refused the token (4401)");
        return;
      }
      this.#schedule();
      return;
    }
    if (this.#stale(epoch)) return;
    this.#welcomed(epoch);
  }

  /** A `reopen` succeeded: check the table, then resubscribe (§8). */
  #welcomed(epoch: number): void {
    const client = this.#client;
    const table = client.table;
    const pair: TablePair = { path: table?.path ?? null, id: table?.id ?? null };
    if (this.#identity === null) {
      this.#identity = pair;
    } else if (!samePair(pair, this.#identity)) {
      const message = `the authority serves ${describePair(pair)}, not ${describePair(this.#identity)}`;
      if (this.#credentials && !this.#mismatchRetried) {
        this.#mismatchRetried = true;
        this.#selfAbort = true;
        try {
          client.abortSocket("wrong_table");
        } finally {
          this.#selfAbort = false;
        }
        client.setState("reconnecting");
        void this.#attempt();
        return;
      }
      this.#terminal("wrong_table", message);
      return;
    }
    this.#mismatchRetried = false;
    this.#resubscribe(epoch);
  }

  #resubscribe(epoch: number): void {
    const client = this.#client;
    client.setState("recovering");
    client.setConnectionError({
      code: "disconnected",
      message: "reconnected; resubscribing",
      recovering: true,
    });
    const subs = client.liveSubscriptions();
    let remaining = subs.length;
    let aborted = false;
    const settled = () => {
      remaining--;
      if (remaining === 0 && !this.#stale(epoch)) this.#ready();
    };
    if (remaining === 0) {
      this.#ready();
      return;
    }
    for (const sub of subs) {
      const sentAt = Date.now();
      client.requestDuringRecovery("subscribe", sub.params).then(
        (result) => {
          if (this.#stale(epoch)) sub.markRecovering();
          else this.#rebind(sub, result);
          settled();
        },
        (e: unknown) => {
          const transport = this.#transportFailure(e, epoch, Date.now() - sentAt);
          if (transport === null) {
            // An error response from the server, whatever its code: terminal (§8).
            sub.fail(e instanceof ProtocolFailure ? e : new ProtocolFailure("internal", String(e)));
          } else {
            sub.markRecovering();
            if (transport !== "closed" && !aborted && !this.#stale(epoch)) {
              aborted = true;
              client.abortSocket(
                transport === "timeout" ? "resubscribe_timeout" : "resubscribe_send_failed",
              );
            }
          }
          settled();
        },
      );
    }
  }

  /**
   * Classifies a resubscribe failure: a transport failure the client produced
   * locally, or `null` for an error response from the server. The client
   * rejects pending requests of a closed socket only after emitting nothing
   * else, and emits `socket_closed` synchronously in the same call, so a local
   * socket-loss `disconnected` always finds this round stale. A local send
   * failure (`sent: false`) and a local timeout carry the client's own
   * details and message; a server response with the same code is told apart
   * by those, by the round still being current, and, for a timeout, by the
   * time elapsed since the send reaching (half of) the timeout the message
   * names, which a prompt server answer does not.
   */
  #transportFailure(
    e: unknown,
    epoch: number,
    elapsedMs: number,
  ): "closed" | "timeout" | "send_failed" | null {
    if (!(e instanceof ProtocolFailure)) return null;
    const { code, message, details } = e.error;
    const keys = details !== null && typeof details === "object" ? Object.keys(details) : [];
    const sent =
      keys.length === 1 && keys[0] === "sent" ? (details as { sent: unknown }).sent : undefined;
    if (code === "disconnected") {
      if (this.#stale(epoch) && sent !== undefined) return "closed";
      if (sent === false && message.startsWith("cannot send subscribe")) return "send_failed";
      return null;
    }
    if (code === "timeout") {
      const match = /^subscribe: no response within (\d+) ms$/.exec(message);
      if (sent === true && match && elapsedMs >= Number(match[1]) / 2) return "timeout";
      return null;
    }
    return null;
  }

  #rebind(sub: Subscription, result: SubscribeResult): void {
    const session = this.#client.session;
    const info = {
      from_revision: sub.mirror.revision,
      to_revision: result.revision,
      session_changed: this.#boundSession.get(sub) !== session,
    };
    try {
      sub.rebind(result.subscription, result, info);
      this.#boundSession.set(sub, session);
    } catch (e) {
      sub.fail(e instanceof ProtocolFailure ? e : new ProtocolFailure("internal", String(e)));
    }
  }

  #ready(): void {
    this.#failures = 0;
    this.#client.setConnectionError(null);
    this.#client.setState("open");
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Keeps `client` connected (PROTOCOL.md §2, §8): reconnects with exponential
 * backoff after every drop, checks the table identity on every `welcome`,
 * resubscribes every live subscription, and reports readiness. On a client
 * that never connected it makes the first connection itself. Returns a
 * disposer that stops it (leaving the client as it is).
 */
export function enableRecovery(client: ProtocolClient, options: RecoveryOptions = {}): () => void {
  const recovery = new Recovery(client, options);
  recovery.start();
  return () => recovery.stop();
}

function uncertain(
  txn_id: string,
  reason: UncertainReason,
  message: string,
  extra: Record<string, unknown> = {},
): ProtocolFailure {
  return new ProtocolFailure("uncertain", message, { txn_id, reason, ...extra });
}

type ReadyOutcome = "ready" | "not_ready" | "unauthorized" | "wrong_table";

/** Waits for `client.ready`, the client closing, or `timeoutMs`. */
function whenReady(
  client: ProtocolClient,
  timeoutMs: number,
  timers: Timers,
): Promise<ReadyOutcome> {
  return new Promise((resolve) => {
    let off = () => {};
    let timer: unknown;
    let done = false;
    const finish = (outcome: ReadyOutcome) => {
      if (done) return;
      done = true;
      off();
      timers.clearTimeout(timer);
      resolve(outcome);
    };
    const check = (state: ClientState) => {
      if (client.ready) finish("ready");
      else if (state === "closed") {
        const code = client.connectionError()?.code;
        finish(code === "unauthorized" || code === "wrong_table" ? code : "not_ready");
      }
    };
    off = client.on("state", check);
    timer = timers.setTimeout(() => finish("not_ready"), timeoutMs);
    check(client.state);
  });
}

/**
 * `transact` with the client retry of PROTOCOL.md §6: when the socket closes
 * after the send, it waits up to `retry.timeoutMs` for the client to be ready
 * again and, on the same `session`, resends the identical params once with
 * `retry: true`. Every other unsettled outcome rejects `uncertain` with
 * `details: {txn_id, reason}`; a request never sent rejects `disconnected`.
 */
export async function transactWithRetry(
  client: ProtocolClient,
  ops: WireOp[],
  options: TransactWithRetryOptions,
): Promise<TransactResult> {
  const timers = options.timers ?? globalTimers;
  const txn_id = options.txn_id ?? globalThis.crypto.randomUUID();
  const built: TransactParams = {
    base_revision: options.base_revision ?? client.revision,
    ops,
    txn_id,
  };
  if (options.label !== undefined) built.label = options.label;
  if (options.actor !== undefined) built.actor = options.actor;
  // A snapshot: the caller mutating `ops` or `actor` later must not change the resend (§6).
  const params = structuredClone(built);
  const session = client.session;

  try {
    return await client.request("transact", params);
  } catch (e) {
    if (!(e instanceof ProtocolFailure) || e.error.code !== "uncertain") throw e;
    const reason = (e.error.details as { reason?: unknown } | undefined)?.reason;
    if (reason !== "socket_closed") {
      throw uncertain(txn_id, "timeout", `transact ${txn_id}: no response in time`);
    }
  }

  const outcome = await whenReady(client, options.retry.timeoutMs, timers);
  if (outcome !== "ready") {
    throw uncertain(
      txn_id,
      outcome,
      outcome === "not_ready"
        ? `transact ${txn_id}: the connection was lost and not ready again within ${options.retry.timeoutMs} ms`
        : `transact ${txn_id}: the connection was lost and recovery ended (${outcome})`,
    );
  }
  if (client.session !== session) {
    throw uncertain(
      txn_id,
      "session_changed",
      `transact ${txn_id}: the authority restarted before the resend`,
      { old_session: session, new_session: client.session },
    );
  }

  try {
    return await client.request("transact", { ...params, retry: true });
  } catch (e) {
    const code = codeOf(e);
    if (code === "retry_unknown") {
      throw uncertain(
        txn_id,
        "retry_unknown",
        `transact ${txn_id}: the authority no longer knows it`,
      );
    }
    if (code === "disconnected" && (e as ProtocolFailure).error.details) {
      const sent = ((e as ProtocolFailure).error.details as { sent?: unknown }).sent;
      if (sent === false) {
        throw uncertain(txn_id, "not_ready", `transact ${txn_id}: the resend could not be sent`);
      }
    }
    throw uncertain(txn_id, "resend_lost", `transact ${txn_id}: the resend's response was lost`, {
      ...(code === "uncertain"
        ? {}
        : { error: e instanceof ProtocolFailure ? e.error : String(e) }),
    });
  }
}
