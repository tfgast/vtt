// @vitest-environment node
/**
 * The board list and board removal (DESIGN.md §4.3; PROTOCOL.md §8; review
 * r1 finding 11) against a real in-process authority. Node environment for
 * Node's WebSocket (see lifecycle.test.ts).
 */
import {
  DocumentStore,
  newTableSnapshot,
  type RunningServer,
  startServer,
  TableHost,
} from "@vtt/authority";
import {
  ProtocolClient,
  type WebSocketConstructor,
  type WebSocketLike,
  type WireOp,
} from "@vtt/protocol";
import { type ConnectionNotice, createTableSession, type TableSession } from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";

const servers: RunningServer[] = [];
const sessions: TableSession[] = [];
const clients: ProtocolClient[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function until(pred: () => boolean, what: string, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// biome-ignore lint/suspicious/noExplicitAny: socket events are passed through loosely
type Listener = (event: any) => void;

/**
 * A `WebSocket` constructor over Node's that can hold reconnection (new
 * sockets fail at once) and turn the response to the next board-scope
 * `subscribe` into an error response.
 */
class Sockets {
  held = false;
  failNextBoardSubscribe: string | null = null;
  readonly WebSocket: WebSocketConstructor;

  constructor() {
    const control = this;
    this.WebSocket = function TestWebSocket(url: string): WebSocketLike {
      return control.held ? refused() : wrap(new WebSocket(url), control);
    } as unknown as WebSocketConstructor;
  }
}

function emitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    add(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    emit(type: string, event: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function refused(): WebSocketLike {
  const events = emitter();
  setTimeout(() => {
    events.emit("error", {});
    events.emit("close", { code: 1006, reason: "held by the test" });
  }, 0);
  return {
    addEventListener: events.add,
    send() {
      throw new Error("not open");
    },
    close() {},
  };
}

function wrap(real: WebSocket, control: Sockets): WebSocketLike {
  const events = emitter();
  const boardSubscribes = new Set<string>();
  real.addEventListener("open", (e) => events.emit("open", e));
  real.addEventListener("error", (e) => events.emit("error", e));
  real.addEventListener("close", (e: CloseEvent) =>
    events.emit("close", { code: e.code, reason: e.reason }),
  );
  real.addEventListener("message", (e: MessageEvent) => {
    const frame = JSON.parse(String(e.data));
    if (frame.type === "response" && boardSubscribes.has(frame.id) && frame.ok) {
      boardSubscribes.delete(frame.id);
      events.emit("message", {
        data: JSON.stringify({
          type: "response",
          id: frame.id,
          ok: false,
          error: { code: "busy", message: "rewritten by the test" },
        }),
      });
      return;
    }
    events.emit("message", { data: e.data });
  });
  return {
    addEventListener: events.add,
    send(data: string) {
      const frame = JSON.parse(data);
      if (
        frame.method === "subscribe" &&
        frame.params.scope.type === "board" &&
        frame.params.scope.board === control.failNextBoardSubscribe
      ) {
        control.failNextBoardSubscribe = null;
        boardSubscribes.add(frame.id);
      }
      real.send(data);
    },
    close(code?: number, reason?: string) {
      real.close(code, reason);
    },
  };
}

async function setup(ops: WireOp[] = []) {
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
  let server = await startServer({ host, port: 0 });
  servers.push(server);
  const gm = await connectOther(server);
  if (ops.length > 0) await gm.transact(ops);
  const sockets = new Sockets();
  const session = createTableSession({
    url: server.url,
    token: server.token,
    WebSocket: sockets.WebSocket,
  });
  sessions.push(session);
  const notices: ConnectionNotice[] = [];
  session.onConnectionNotice((n) => notices.push(n));
  await until(() => session.getSnapshot().ready, "the session to be ready");
  return {
    host,
    gm,
    session,
    sockets,
    notices,
    get server() {
      return server;
    },
    /** Restarts the authority on the same port and host with the same token. */
    async restart() {
      const port = server.port;
      await server.close("restart");
      servers.splice(servers.indexOf(server), 1);
      server = await startServer({ host, port, token: server.token });
      servers.push(server);
      return server;
    },
  };
}

async function connectOther(server: RunningServer): Promise<ProtocolClient> {
  const client = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: "other", kind: "test" },
    onWarning: () => undefined,
  });
  clients.push(client);
  await client.connect();
  return client;
}

const boardIds = (s: TableSession) => s.getSnapshot().boards.map((b) => b.id);

describe("board list", () => {
  test("follows commit events that carry boards", async () => {
    const t = await setup();
    await t.gm.transact([{ type: "add_board", id: "crypt", name: "Crypt" }]);
    await until(() => boardIds(t.session).includes("crypt"), "the new board");
    await t.gm.transact([{ type: "rename_board", id: "crypt", name: "Old Crypt" }]);
    await until(
      () => t.session.getSnapshot().boards.some((b) => b.name === "Old Crypt"),
      "the rename",
    );
    expect(t.session.getSnapshot().activeBoard).toBe("gm_board");
  });

  test("setView switches the active board", async () => {
    const t = await setup([
      { type: "add_board", id: "crypt", name: "Crypt" },
      {
        type: "create_object",
        id: "bones",
        to: { type: "board", board: "crypt", position: [0, 0] },
      },
    ]);
    await t.session.setView("crypt", { type: "gm" });
    expect(t.session.getSnapshot().activeBoard).toBe("crypt");
    expect(t.session.boardView()?.objects.has("bones")).toBe(true);
    const boards = t.session.client
      .liveSubscriptions()
      .filter((s) => s.params.scope.type === "board");
    expect(boards.map((s) => s.params.scope)).toEqual([{ type: "board", board: "crypt" }]);
  });
});

describe("board removal (review r1 finding 11)", () => {
  test("another client removes the active board while connected: the remaining board becomes active", async () => {
    const t = await setup([{ type: "add_board", id: "vault", name: "Vault" }]);
    await t.session.setView("vault", { type: "gm" });
    expect(t.session.getSnapshot().activeBoard).toBe("vault");
    await t.gm.transact([{ type: "remove_board", id: "vault" }]);
    await until(
      () => t.session.getSnapshot().activeBoard === "gm_board" && t.session.getSnapshot().ready,
      "the switch to gm_board",
    );
    expect(boardIds(t.session)).toEqual(["gm_board"]);
    expect(t.notices).toEqual([]);
  });

  test("the same removal while disconnected: switched after resync", async () => {
    const t = await setup([{ type: "add_board", id: "vault", name: "Vault" }]);
    await t.session.setView("vault", { type: "gm" });
    t.sockets.held = true;
    const restarted = await t.restart();
    await until(() => t.session.getSnapshot().connection !== null, "the drop");
    const gm = await connectOther(restarted);
    await gm.transact([{ type: "remove_board", id: "vault" }]);
    t.sockets.held = false;
    await until(
      () => t.session.getSnapshot().activeBoard === "gm_board" && t.session.getSnapshot().ready,
      "the switch after resync",
    );
    expect(t.session.getSnapshot().connection).toBeNull();
    expect(boardIds(t.session)).toEqual(["gm_board"]);
    expect(t.session.boardView()).not.toBeNull();
    // A removal is not reported as a failed subscription.
    expect(t.notices).toEqual([]);
  });

  test("removing the last board leaves activeBoard null; a new board becomes active", async () => {
    const t = await setup();
    await t.gm.transact([{ type: "remove_board", id: "gm_board" }]);
    await until(() => t.session.getSnapshot().activeBoard === null, "activeBoard null");
    expect(t.session.getSnapshot().boards).toEqual([]);
    expect(t.session.boardView()).toBeNull();
    await until(() => t.session.getSnapshot().ready, "ready with zero boards");
    expect(
      t.session.client.liveSubscriptions().filter((s) => s.params.scope.type === "board"),
    ).toHaveLength(0);
    // setView with no board keeps the zero-board state.
    await t.session.setView(null, { type: "gm" });
    expect(t.session.getSnapshot().activeBoard).toBeNull();

    await t.gm.transact([{ type: "add_board", id: "fresh", name: "Fresh" }]);
    await until(() => t.session.getSnapshot().activeBoard === "fresh", "the new board");
  });

  test("a board subscription failed through recovery is a connection notice, not a removal", async () => {
    const t = await setup([{ type: "add_board", id: "vault", name: "Vault" }]);
    await t.session.setView("vault", { type: "gm" });
    t.sockets.failNextBoardSubscribe = "vault";
    await t.restart();
    await until(() => t.notices.length > 0, "a connection notice");
    expect(t.notices[0]).toMatchObject({
      subscription: "board",
      board: "vault",
      error: { code: "busy" },
    });
    expect(typeof t.notices[0]?.message).toBe("string");
    // Not a removal: the board stays active and its view is subscribed again.
    await until(() => t.session.getSnapshot().ready, "ready again");
    expect(t.session.getSnapshot().activeBoard).toBe("vault");
    expect(boardIds(t.session)).toEqual(["gm_board", "vault"]);
    const live = t.session.client.liveSubscriptions().filter((s) => s.state === "live");
    expect(live.map((s) => s.params.scope)).toContainEqual({ type: "board", board: "vault" });
  });
});
