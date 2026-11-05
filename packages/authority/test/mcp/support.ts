/**
 * Shared in-process harness for the MCP tests (vtt-5su.11; imported unchanged
 * by vtt-5su.15): a real authority (`startServer` on port 0 over a
 * `TableHost`), a `ProtocolClient` with explicit credentials and
 * `enableRecovery`, a `SocketControl` injected as the client's `WebSocket`,
 * and an MCP client connected to `createMcpServer` through the SDK's
 * in-memory transport pair. No stdio.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import {
  createMcpServer,
  type McpExtension,
  type RunningServer,
  startServer,
  type TableHost,
} from "@vtt/authority";
import {
  enableRecovery,
  ProtocolClient,
  type WebSocketConstructor,
  type WebSocketLike,
} from "@vtt/protocol";
import type { Snapshot } from "@vtt/schema";
import { memoryHost, until } from "../server/helpers";

export { until };

// biome-ignore lint/suspicious/noExplicitAny: socket events and frames are handled loosely
type Listener = (event: any) => void;

/** A request frame as the client wrote it to the wire (what the authority receives). */
export type SentRequest = { id: string; method: string; params: Record<string, unknown> };

/**
 * A `WebSocket` constructor to inject into `ProtocolClient` (its `WebSocket`
 * option) that wraps Node's global WebSocket and lets a test drop the
 * current socket, drop it when the next commit event frame arrives, refuse
 * new sockets (holding reconnection) and count the request frames sent.
 */
export class SocketControl {
  /** Every request frame written to a socket, in order. */
  readonly requests: SentRequest[] = [];
  /** Sockets constructed (refused ones included). */
  opened = 0;
  #held = false;
  #dropOnCommit = false;
  readonly #live = new Set<ControlledSocket>();
  readonly WebSocket: WebSocketConstructor;

  constructor() {
    // A plain function used with `new`: it returns the socket object it builds.
    const open = (url: string): WebSocketLike => {
      this.opened++;
      if (this.#held) return new RefusedSocket();
      const socket = new ControlledSocket(url, this);
      this.#live.add(socket);
      return socket;
    };
    this.WebSocket = function ControlledWebSocket(url: string) {
      return open(url);
    } as unknown as WebSocketConstructor;
  }

  /** The number of request frames sent, for one method or all. */
  requestCount(method?: string): number {
    return method === undefined
      ? this.requests.length
      : this.requests.filter((r) => r.method === method).length;
  }

  /** The request frames sent for `method`. */
  requestsFor(method: string): SentRequest[] {
    return this.requests.filter((r) => r.method === method);
  }

  /** From now on every new socket fails at once (reconnection is held). */
  hold(): void {
    this.#held = true;
  }

  /** New sockets connect again. */
  release(): void {
    this.#held = false;
  }

  /**
   * Arms a one-shot drop: when the next commit event frame arrives on any
   * socket, that socket is closed and neither the frame nor anything after
   * it reaches the client (so a write's response, which follows its commit
   * event, is lost).
   */
  dropOnCommit(): void {
    this.#dropOnCommit = true;
  }

  /** Closes every live socket now, as a network drop would (close code 1006). */
  drop(): void {
    for (const socket of [...this.#live]) socket.drop();
  }

  /** @internal */
  onSend(data: string): void {
    try {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame.type === "request") {
        this.requests.push({
          id: String(frame.id),
          method: String(frame.method),
          params: (frame.params ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // Not JSON: not a request.
    }
  }

  /** @internal Returns true when the frame must not be delivered (the socket was dropped). */
  onFrame(socket: ControlledSocket, data: unknown): boolean {
    if (!this.#dropOnCommit) return false;
    let type: unknown;
    try {
      type = (JSON.parse(String(data)) as { type?: unknown }).type;
    } catch {
      return false;
    }
    if (type !== "commit") return false;
    this.#dropOnCommit = false;
    socket.drop();
    return true;
  }

  /** @internal */
  forget(socket: ControlledSocket): void {
    this.#live.delete(socket);
  }
}

/** A live socket over Node's WebSocket whose events pass through `SocketControl`. */
class ControlledSocket {
  readonly #real: WebSocket;
  readonly #control: SocketControl;
  readonly #listeners = new Map<string, Listener[]>();
  /** Dropped by the test or closed: nothing more reaches the client. */
  #dead = false;

  constructor(url: string, control: SocketControl) {
    this.#control = control;
    this.#real = new WebSocket(url);
    this.#real.addEventListener("open", (e) => {
      if (!this.#dead) this.#emit("open", e);
    });
    this.#real.addEventListener("message", (e: MessageEvent) => {
      if (this.#dead) return;
      if (this.#control.onFrame(this, e.data)) return;
      this.#emit("message", { data: e.data });
    });
    this.#real.addEventListener("error", (e) => {
      if (!this.#dead) this.#emit("error", e);
    });
    this.#real.addEventListener("close", (e: CloseEvent) => {
      if (this.#dead) return;
      this.#dead = true;
      this.#control.forget(this);
      this.#emit("close", { code: e.code, reason: e.reason });
    });
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  send(data: string): void {
    this.#control.onSend(data);
    this.#real.send(data);
  }

  close(code?: number, reason?: string): void {
    try {
      this.#real.close(code, reason);
    } catch {
      this.#real.close();
    }
  }

  /** Closes the real socket and reports an abnormal close to the client at once. */
  drop(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#control.forget(this);
    try {
      this.#real.close(1000, "dropped by the test");
    } catch {
      // Already closing.
    }
    this.#emit("close", { code: 1006, reason: "" });
  }

  #emit(type: string, event: unknown): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(event);
  }
}

/** A socket refused while reconnection is held: it fails on the next macrotask. */
class RefusedSocket {
  readonly #listeners = new Map<string, Listener[]>();

  constructor() {
    setTimeout(() => {
      this.#emit("error", {});
      this.#emit("close", { code: 1006, reason: "refused by the test" });
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  send(): void {
    throw new Error("socket not open");
  }

  close(): void {}

  #emit(type: string, event: unknown): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(event);
  }
}

// ---------------------------------------------------------------------------
// The harness

export type McpHarnessOptions = {
  /** Default: an in-memory host over `snapshot`. */
  host?: TableHost;
  /** Default: the store helpers' two-board table. */
  snapshot?: Snapshot;
  extensions?: McpExtension[];
  /** Default 0 (a free port). */
  port?: number;
  token?: string;
  /** False: no `enableRecovery` and no connection (the client stays before its first welcome). */
  connect?: boolean;
  /** The ProtocolClient's `client.name`; default "mcp-test". */
  clientName?: string;
};

/** The text and structured content of a tool result, typed loosely for assertions. */
export type ToolResult = {
  isError?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
  structuredContent?: any;
  content: { type: string; text?: string }[];
};

export class McpHarness {
  server: RunningServer;
  readonly host: TableHost;
  readonly client: ProtocolClient;
  readonly sockets: SocketControl;
  readonly mcp: Client;
  readonly mcpServer: McpServer;
  readonly #stopRecovery: () => void;
  readonly #others: ProtocolClient[] = [];

  constructor(init: {
    server: RunningServer;
    host: TableHost;
    client: ProtocolClient;
    sockets: SocketControl;
    mcp: Client;
    mcpServer: McpServer;
    stopRecovery: () => void;
  }) {
    this.server = init.server;
    this.host = init.host;
    this.client = init.client;
    this.sockets = init.sockets;
    this.mcp = init.mcp;
    this.mcpServer = init.mcpServer;
    this.#stopRecovery = init.stopRecovery;
  }

  /** Calls a tool through the MCP client. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await this.mcp.callTool({ name, arguments: args })) as ToolResult;
  }

  /** Reads a resource's first text content. */
  async read(uri: string): Promise<string> {
    const result = await this.mcp.readResource({ uri });
    const first = result.contents[0] as { text?: string } | undefined;
    if (first?.text === undefined) throw new Error(`no text content at ${uri}`);
    return first.text;
  }

  /** A second, plain ProtocolClient (no recovery) connected as `kind: "test"`, closed by `close`. */
  async gm(): Promise<ProtocolClient> {
    const other = new ProtocolClient({
      url: this.server.url,
      token: this.server.token,
      client: { name: "gm", kind: "test" },
      onWarning: () => undefined,
    });
    this.#others.push(other);
    await other.connect();
    return other;
  }

  /** Waits until the MCP side's client is ready (connected, not recovering). */
  async ready(ms = 5000): Promise<void> {
    await until(() => this.client.ready, ms, "the client to be ready");
  }

  /**
   * Closes the server and starts a new one on the same port and host
   * (a new session), with `token` (default: the same token).
   */
  async restart(options: { token?: string } = {}): Promise<RunningServer> {
    const port = this.server.port;
    await this.server.close("restart");
    this.server = await startServer({
      host: this.host,
      port,
      token: options.token ?? this.server.token,
    });
    return this.server;
  }

  async close(): Promise<void> {
    this.#stopRecovery();
    await this.mcp.close().catch(() => undefined);
    await this.mcpServer.close().catch(() => undefined);
    this.client.close();
    for (const other of this.#others.splice(0)) other.close();
    await this.server.close();
  }
}

const harnesses: McpHarness[] = [];

/**
 * Starts an authority, a recovering ProtocolClient attached through a
 * `SocketControl`, and an MCP client and server linked in memory. Unless
 * `connect: false`, resolves once the client is ready.
 */
export async function startHarness(options: McpHarnessOptions = {}): Promise<McpHarness> {
  const host = options.host ?? memoryHost(options.snapshot);
  const server = await startServer({
    host,
    port: options.port ?? 0,
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  const sockets = new SocketControl();
  const client = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: options.clientName ?? "mcp-test", kind: "agent" },
    WebSocket: sockets.WebSocket,
    onWarning: () => undefined,
  });
  const mcpServer = createMcpServer({ client, extensions: options.extensions ?? [] });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverSide);
  const mcp = new Client({ name: "mcp-test-agent", version: "1.0.0" });
  await mcp.connect(clientSide);
  const stopRecovery =
    options.connect === false
      ? () => undefined
      : enableRecovery(client, { reconnect: { initialMs: 10, maxMs: 50, factor: 2 } });
  const harness = new McpHarness({
    server,
    host,
    client,
    sockets,
    mcp,
    mcpServer,
    stopRecovery,
  });
  harnesses.push(harness);
  if (options.connect !== false) await harness.ready();
  return harness;
}

/** Closes every harness started since the last call (servers, clients, MCP pair). */
export async function cleanupHarnesses(): Promise<void> {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
}
