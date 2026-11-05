/** Shared harness for the server tests: real servers on port 0, raw sockets, clients. */
import {
  DocumentStore,
  type RunningServer,
  type StartServerOptions,
  startServer,
  TableHost,
} from "@vtt/authority";
import { ProtocolClient, type ProtocolClientOptions } from "@vtt/protocol";
import type { Snapshot } from "@vtt/schema";
import { table } from "../store/helpers";

const servers: RunningServer[] = [];
const clients: ProtocolClient[] = [];
const raws: RawClient[] = [];

/** Closes every server, client and raw socket the test opened. */
export async function cleanup(): Promise<void> {
  for (const c of clients.splice(0)) c.close();
  for (const r of raws.splice(0)) r.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
}

/** An in-memory host over `snapshot` (default: the store helpers' two-board table). */
export function memoryHost(snapshot: Snapshot = table()): TableHost {
  return TableHost.inMemory(DocumentStore.fromSnapshot(snapshot));
}

/** Starts a server on port 0, closed by `cleanup`. */
export async function serve(
  options: Partial<StartServerOptions> = {},
): Promise<{ server: RunningServer; host: TableHost }> {
  const host = options.host ?? memoryHost();
  const server = await startServer({ port: 0, ...options, host });
  servers.push(server);
  return { server, host };
}

/** A connected ProtocolClient, closed by `cleanup`. */
export async function connect(
  server: RunningServer,
  options: Partial<ProtocolClientOptions> = {},
): Promise<ProtocolClient> {
  const client = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: "tester", kind: "test" },
    onWarning: () => undefined,
    ...options,
  });
  clients.push(client);
  await client.connect();
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: test frames are inspected loosely
export type Frame = any;

/** Waits for `pred` to hold, polling, or fails after `ms`. */
export async function until(pred: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A raw WebSocket (Node's global WebSocket) recording every frame and the close. */
export class RawClient {
  readonly socket: WebSocket;
  readonly frames: Frame[] = [];
  /** The byte length of every frame's text, in order. */
  readonly sizes: number[] = [];
  readonly opened: Promise<void>;
  closeInfo: { code: number; reason: string } | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    raws.push(this);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("socket error")));
    });
    this.opened.catch(() => undefined);
    this.socket.addEventListener("message", (e: MessageEvent) => {
      const text = String(e.data);
      this.sizes.push(Buffer.byteLength(text));
      this.frames.push(JSON.parse(text));
    });
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener("close", (e: CloseEvent) => {
        this.closeInfo = { code: e.code, reason: e.reason };
        resolve(this.closeInfo);
      });
    });
  }

  /** Opens a socket to `server` and, unless `hello` is false, completes the handshake. */
  static async open(
    server: RunningServer,
    hello: Record<string, unknown> | false = {},
  ): Promise<RawClient> {
    const raw = new RawClient(server.url);
    await raw.opened;
    if (hello !== false) {
      raw.send(helloFor(server, hello));
      await raw.next((f) => f.type === "welcome");
    }
    return raw;
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  request(id: string, method: string, params: unknown = {}): void {
    this.send({ type: "request", id, method, params });
  }

  /** The first recorded frame matching `pred`, waiting for it. */
  async next(pred: (f: Frame) => boolean, ms = 3000): Promise<Frame> {
    let found: Frame;
    await until(
      () => {
        found = this.frames.find(pred);
        return found !== undefined;
      },
      ms,
      "a frame",
    );
    return found;
  }

  /** The response to request `id`. */
  response(id: string, ms = 3000): Promise<Frame> {
    return this.next((f) => f.type === "response" && f.id === id, ms);
  }

  /** Index of the first frame matching `pred`, or -1. */
  indexOf(pred: (f: Frame) => boolean): number {
    return this.frames.findIndex(pred);
  }

  close(): void {
    if (this.socket.readyState <= 1) this.socket.close();
  }
}

/** A valid `hello` for `server`, with `overrides` merged in. */
export function helloFor(
  server: RunningServer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "hello",
    protocol: 1,
    token: server.token,
    client: { name: "raw", kind: "test", instance: "raw-1" },
    ...overrides,
  };
}

/** A `set_value` transact's params writing goblin.hp. */
export function setHp(base_revision: number, hp: number, extra: Record<string, unknown> = {}) {
  return {
    base_revision,
    ops: [
      { type: "set_value", object: "goblin", cell: "hp", value: { type: "number", value: hp } },
    ],
    ...extra,
  };
}
