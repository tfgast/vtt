// @vitest-environment node
/**
 * Session and mirror lifecycle against a real in-process authority
 * (vtt-3l6.4). Node environment: jsdom's WebSocket (undici dispatching
 * Node events through jsdom's Event global) cannot open a connection under
 * Vitest, so these tests use Node's global WebSocket.
 */
import {
  DocumentStore,
  newTableSnapshot,
  type RunningServer,
  startServer,
  TableHost,
} from "@vtt/authority";
import { ProtocolClient, type WireOp } from "@vtt/protocol";
import { createTableSession, type SessionSnapshot, type TableSession } from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";

/** jsdom's default origin, which the UI's jsdom tests connect from. */
const JSDOM_ORIGIN = "http://localhost:3000";

const servers: RunningServer[] = [];
const sessions: TableSession[] = [];
const clients: ProtocolClient[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function until(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function serve(
  host: TableHost,
  options: { port?: number; token?: string } = {},
): Promise<RunningServer> {
  const server = await startServer({
    host,
    port: options.port ?? 0,
    allowOrigins: [JSDOM_ORIGIN],
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  servers.push(server);
  return server;
}

async function authority(): Promise<{ host: TableHost; server: RunningServer }> {
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
  return { host, server: await serve(host) };
}

function open(server: RunningServer): TableSession {
  const session = createTableSession({ url: server.url, token: server.token });
  sessions.push(session);
  return session;
}

async function other(server: RunningServer): Promise<ProtocolClient> {
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

const createToken = (id: string, board = "gm_board"): WireOp => ({
  type: "create_object",
  id,
  to: { type: "board", board, position: [1, 2] },
  init: { cells: { name: { type: "text", value: `Token ${id}` } } },
});

/** Stops a server and starts another on its port over the same host (a new session). */
async function restart(server: RunningServer, host: TableHost, token: string) {
  const port = server.port;
  await server.close("restart");
  servers.splice(servers.indexOf(server), 1);
  return serve(host, { port, token });
}

describe("connecting", () => {
  test("the snapshot has the GM board, revision 0 and activeBoard gm_board", async () => {
    const { server } = await authority();
    const session = open(server);
    expect(session.getSnapshot().connection?.code).toBe("disconnected");
    expect(session.getSnapshot().ready).toBe(false);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    const snap = session.getSnapshot();
    expect(snap.connection).toBeNull();
    expect(snap.revision).toBe(0);
    expect(snap.boards).toEqual([{ id: "gm_board", name: "GM" }]);
    expect(snap.activeBoard).toBe("gm_board");
    expect(snap.viewer).toEqual({ type: "gm" });
    expect(snap.table).toEqual({ name: expect.any(String), path: null, id: null });
    expect(session.client.actor).toEqual({ type: "gm" });
    const board = session.boardView();
    expect(board?.revision).toBe(0);
    expect(board?.objects.size).toBe(0);
    expect(board?.covers.size).toBe(0);
    expect(session.viewerKey()).toBe("gm");
  });

  test("subscribes the GM directory and the board view per Q2", async () => {
    const { server } = await authority();
    const session = open(server);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    const params = session.client.liveSubscriptions().map((s) => s.params);
    expect(params).toHaveLength(2);
    expect(params).toContainEqual({
      scope: { type: "all" },
      viewer: { type: "gm" },
      cells: "structural",
    });
    expect(params).toContainEqual({
      scope: { type: "board", board: "gm_board" },
      viewer: { type: "gm" },
      cells: "all",
    });
  });

  test("getSnapshot is stable until something changes, and listeners hear changes", async () => {
    const { server } = await authority();
    const session = open(server);
    let calls = 0;
    const off = session.subscribe(() => calls++);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    const a = session.getSnapshot();
    expect(session.getSnapshot()).toBe(a);
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    const gm = await other(server);
    await gm.transact([createToken("t1")]);
    await until(() => session.getSnapshot().revision === 1, "revision 1");
    expect(calls).toBeGreaterThan(before);
    expect(session.getSnapshot()).not.toBe(a);
    off();
    const after = calls;
    await gm.transact([createToken("t2")]);
    await until(() => session.getSnapshot().revision === 2, "revision 2");
    expect(calls).toBe(after);
  });
});

describe("mirrors", () => {
  test("the directory lists an object created by a second client", async () => {
    const { server } = await authority();
    const session = open(server);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    const gm = await other(server);
    await gm.transact([{ type: "add_board", id: "vault" }, createToken("relic", "vault")]);
    await until(() => session.directory().has("relic"), "the directory to list relic");
    const view = session.directory().get("relic");
    expect(view?.cells.name?.value).toEqual({ type: "text", value: "Token relic" });
    // Not on the active board: absent from the board view, present in the directory.
    expect(session.boardView()?.objects.has("relic")).toBe(false);
    expect(session.objectView("relic")).toBeNull();
    expect(session.refLabel({ type: "gm" }, "relic")).toBe("Token relic");
  });

  test("whenRevision resolves after the commit event", async () => {
    const { server } = await authority();
    const session = open(server);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    await session.whenRevision(0);
    let seen: { revision: number; hasToken: boolean } | null = null;
    const waiting = session.whenRevision(1).then(() => {
      seen = {
        revision: session.getSnapshot().revision,
        hasToken: session.boardView()?.objects.has("t1") ?? false,
      };
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toBeNull();
    const gm = await other(server);
    await gm.transact([createToken("t1")]);
    await waiting;
    expect(seen).toEqual({ revision: 1, hasToken: true });
    expect(session.boardView()?.revision).toBe(1);
    expect(session.objectView("t1")?.id).toBe("t1");
  });

  test("whenRevision rejects when the session closes first", async () => {
    const { server } = await authority();
    const session = open(server);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    const waiting = session.whenRevision(5);
    session.close();
    await expect(waiting).rejects.toThrow();
  });
});

describe("restarts (review r1 finding 13)", () => {
  test("a same-token socket drop recovers and clears the connection error", async () => {
    const { host, server } = await authority();
    const session = open(server);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    const codes: (string | null)[] = [];
    session.subscribe(() => {
      const c = session.getSnapshot().connection;
      codes.push(c === null ? null : `${c.code}${c.recovering ? "+recovering" : ""}`);
    });
    const restarted = await restart(server, host, server.token);
    await until(() => codes.includes("disconnected"), "the drop to be reported");
    expect(session.getSnapshot().ready).toBe(false);
    await until(
      () => session.getSnapshot().connection === null && session.getSnapshot().ready,
      "recovery",
    );
    expect(codes.at(-1)).toBeNull();
    // Views are live again on the new connection.
    const gm = await other(restarted);
    await gm.transact([createToken("after")]);
    await until(() => session.objectView("after") !== null, "the new object in the board view");
    expect(session.getSnapshot().activeBoard).toBe("gm_board");
  });

  test("a restart with a new token ends in a terminal unauthorized", async () => {
    const { host, server } = await authority();
    const session = open(server);
    await until(() => session.getSnapshot().ready, "the session to be ready");
    await restart(server, host, "a-new-token");
    await until(
      () => session.getSnapshot().connection?.code === "unauthorized",
      "unauthorized",
      8000,
    );
    const snap: SessionSnapshot = session.getSnapshot();
    expect(snap.ready).toBe(false);
    expect(session.client.state).toBe("closed");
    // Terminal: it stays unauthorized.
    await new Promise((r) => setTimeout(r, 300));
    expect(session.getSnapshot().connection?.code).toBe("unauthorized");
  });
});
