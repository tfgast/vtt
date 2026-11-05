/**
 * In-process tests of the MCP subscription tools (vtt-5su.15; PROTOCOL.md §8,
 * §11): `subscribe`, `poll_changes`, `unsubscribe` and the resource
 * `vtt://subscriptions/<handle>`, over the shared harness (a real authority
 * on port 0, a recovering `ProtocolClient` behind a `SocketControl`, the
 * in-memory MCP transport) with `subscriptionTools()` as the extension.
 */
import { subscriptionTools } from "@vtt/authority";
import { METHOD_NAMES, type ProtocolClient } from "@vtt/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupHarnesses, type McpHarness, startHarness, type ToolResult, until } from "./support";

afterEach(async () => {
  await cleanupHarnesses();
});

const REQUEST_TOOLS = [
  "table_info",
  "list_objects",
  "get_objects",
  "evaluate",
  "zones",
  "at_position",
  "changes_since",
  "log",
  "explain_cell",
  "explain_group",
  "explain_action",
  "transact",
  "undo",
  "save",
];

const start = (options: Parameters<typeof startHarness>[0] = {}) =>
  startHarness({ ...options, extensions: [subscriptionTools()] });

const setHp = (hp: number, object = "goblin") => ({
  type: "set_value" as const,
  object,
  cell: "hp",
  value: { type: "number" as const, value: hp },
});

// biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
function ok(result: ToolResult): any {
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(result.structuredContent);
  return result.structuredContent;
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
function failed(result: ToolResult): any {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  return result.structuredContent;
}

async function subscribe(h: McpHarness, scope: Record<string, unknown>): Promise<string> {
  const result = ok(await h.call("subscribe", { scope }));
  return result.subscription as string;
}

// biome-ignore lint/suspicious/noExplicitAny: resource content is read loosely
async function readSub(h: McpHarness, handle: string): Promise<any> {
  return JSON.parse(await h.read(`vtt://subscriptions/${handle}`));
}

/** Waits until the MCP side's client processed the commit at `revision`. */
async function seen(h: McpHarness, revision: number): Promise<void> {
  await until(() => h.client.revision >= revision, 3000, `revision ${revision}`);
}

async function write(gm: ProtocolClient, ops: unknown[]): Promise<number> {
  const result = await gm.transact(ops as never);
  expect(result.status, JSON.stringify(result)).toBe("committed");
  return (result as { revision: number }).revision;
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe("tool list", () => {
  test("the 14 request tools plus subscribe, poll_changes and unsubscribe; every method but invoke and document has a tool", async () => {
    const h = await start();
    const names = (await h.mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...REQUEST_TOOLS, "subscribe", "poll_changes", "unsubscribe"]);
    const excluded = new Set(["invoke", "document"]);
    for (const method of METHOD_NAMES) {
      expect(names.includes(method), method).toBe(!excluded.has(method));
    }
  });

  test("subscribe's input schema is strict and narrowed to board, objects and all with a GM viewer", async () => {
    const h = await start();
    const before = h.sockets.requestCount("subscribe");
    for (const args of [
      { scope: { type: "log" } },
      { scope: { type: "all" }, viewer: { type: "character", id: "goblin" } },
      { scope: { type: "all" }, extra: true },
    ]) {
      const result = await h.call("subscribe", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(h.sockets.requestCount("subscribe")).toBe(before);
    const result = ok(
      await h.call("subscribe", { scope: { type: "all" }, viewer: { type: "gm" } }),
    );
    expect(result).toEqual({ subscription: "m1", revision: 3, objects: 7 });
  });
});

describe("subscribe, poll_changes, unsubscribe", () => {
  test("subscribe returns a handle, the revision and the object count", async () => {
    const h = await start();
    expect(ok(await h.call("subscribe", { scope: { type: "board", board: "map" } }))).toEqual({
      subscription: "m1",
      revision: 3,
      objects: 7,
    });
    expect(
      ok(await h.call("subscribe", { scope: { type: "objects", ids: ["coin", "gem"] } })),
    ).toEqual({ subscription: "m2", revision: 3, objects: 2 });
    expect(failed(await h.call("subscribe", { scope: { type: "board", board: "nope" } }))).toEqual(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  test("a GM write releases a pending poll with the cell change, before, after and actor gm", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "board", board: "map" });
    const gm = await h.gm();
    const started = Date.now();
    const pending = h.call("poll_changes", { subscription: handle, wait_ms: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    const revision = await write(gm, [setHp(9)]);
    const result = ok(await pending);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({ subscription: handle, revision, overflowed: false });
    expect(result.changes).toHaveLength(1);
    const [record] = result.changes;
    expect(record).toMatchObject({
      type: "commit",
      revision,
      group: { actor: { type: "gm" } },
      created: [],
      removed: [],
      objects: [],
    });
    expect(record.cells).toEqual([
      {
        object: "goblin",
        cell: "hp",
        before: expect.objectContaining({ value: { type: "number", value: 7 } }),
        after: expect.objectContaining({ value: { type: "number", value: 9 } }),
      },
    ]);
    expect(ok(await h.call("poll_changes", { subscription: handle }))).toEqual({
      subscription: handle,
      revision,
      changes: [],
      overflowed: false,
    });
  });

  test("a poll without wait_ms returns at once; wait_ms is 0..30000", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "all" });
    const started = Date.now();
    expect(ok(await h.call("poll_changes", { subscription: handle })).changes).toEqual([]);
    expect(
      ok(await h.call("poll_changes", { subscription: handle, wait_ms: 100 })).changes,
    ).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    for (const wait_ms of [-1, 30001, 1.5]) {
      expect((await h.call("poll_changes", { subscription: handle, wait_ms })).isError).toBe(true);
    }
  });

  test("set_actions and set_character_flag produce objects entries with before/after facts", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "board", board: "map" });
    const gm = await h.gm();
    const heal = [{ name: "Heal", steps: ["7 -> hp"] }];
    await write(gm, [{ type: "set_actions", object: "goblin", actions: heal }]);
    const r2 = await write(gm, [{ type: "set_character_flag", object: "goblin", value: true }]);
    await seen(h, r2);
    const { changes } = ok(await h.call("poll_changes", { subscription: handle }));
    expect(changes).toHaveLength(2);
    expect(changes[0].objects).toEqual([
      {
        object: "goblin",
        before: { is_template: false, is_character: false, actions: [] },
        after: { is_template: false, is_character: false, actions: heal },
      },
    ]);
    expect(changes[1].objects).toEqual([
      {
        object: "goblin",
        before: { is_template: false, is_character: false, actions: heal },
        after: { is_template: false, is_character: true, actions: heal },
      },
    ]);
  });

  test("create_object and remove produce created and removed", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "board", board: "map" });
    const gm = await h.gm();
    await write(gm, [
      {
        type: "create_object",
        id: "orc",
        to: { type: "board", board: "map", position: [0, 0] },
        init: { cells: { hp: { type: "number", value: 3 } } },
      },
    ]);
    const r2 = await write(gm, [{ type: "remove", object: "coin" }]);
    await seen(h, r2);
    const { changes } = ok(await h.call("poll_changes", { subscription: handle }));
    expect(changes.map((c: { created: string[] }) => c.created)).toEqual([["orc"], []]);
    expect(changes[0].removed).toEqual([]);
    expect(changes[1].removed).toContain("coin");
    expect(changes[0].objects).toContainEqual(expect.objectContaining({ object: "orc" }));
  });

  test("1,001 commits set overflowed; the resource then shows the current mirror", async () => {
    const h = await start();
    const ids = ["goblin", "bag", "coin"];
    const handle = await subscribe(h, { type: "objects", ids });
    // Eight connections in turn: each stays under the per-connection request rate (§10).
    const gms = await Promise.all(Array.from({ length: 8 }, () => h.gm()));
    const gm = gms[0] as ProtocolClient;
    let revision = 3;
    for (let i = 0; i < 1001; i++) {
      const writer = gms[i % gms.length] as ProtocolClient;
      const result = await writer.transact([setHp(i)], { base_revision: revision });
      expect(result.status).toBe("committed");
      revision = (result as { revision: number }).revision;
    }
    await seen(h, revision);
    const resource = await readSub(h, handle);
    expect(resource).toMatchObject({
      subscription: handle,
      revision,
      overflowed: true,
      failed: null,
    });
    expect(resource.changes).toHaveLength(1000);
    const fresh = await gm.request("get_objects", { ids });
    expect([...resource.objects].sort(byId)).toEqual([...fresh.objects].sort(byId));
    const poll = ok(await h.call("poll_changes", { subscription: handle }));
    expect(poll.overflowed).toBe(true);
    expect(poll.changes).toHaveLength(1000);
    expect(poll.changes[0].revision).toBe(revision - 999);
    const again = ok(await h.call("poll_changes", { subscription: handle }));
    expect(again).toEqual({ subscription: handle, revision, changes: [], overflowed: false });
    expect((await readSub(h, handle)).overflowed).toBe(false);
  }, 60_000);

  test("each record sends notifications/resources/updated for the handle's resource", async () => {
    const h = await start();
    const uris: string[] = [];
    h.mcp.setNotificationHandler("notifications/resources/updated", (n) => {
      uris.push(n.params.uri);
    });
    const handle = await subscribe(h, { type: "board", board: "map" });
    const gm = await h.gm();
    await write(gm, [setHp(1)]);
    await write(gm, [setHp(2)]);
    await until(() => uris.length >= 2, 3000, "two notifications");
    expect(uris).toEqual([`vtt://subscriptions/${handle}`, `vtt://subscriptions/${handle}`]);
  });

  test("the resource reads without clearing; unknown handles are not_found", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "objects", ids: ["goblin"] });
    const gm = await h.gm();
    const revision = await write(gm, [setHp(5)]);
    await seen(h, revision);
    const first = await readSub(h, handle);
    expect(first).toMatchObject({
      subscription: handle,
      revision,
      overflowed: false,
      failed: null,
    });
    expect(first.changes).toHaveLength(1);
    expect(first.objects.map((o: { id: string }) => o.id)).toEqual(["goblin"]);
    expect((await readSub(h, handle)).changes).toHaveLength(1);
    expect(ok(await h.call("poll_changes", { subscription: handle })).changes).toHaveLength(1);
    expect((await readSub(h, handle)).changes).toEqual([]);

    expect(failed(await h.call("poll_changes", { subscription: "m99" }))).toEqual({
      code: "not_found",
      message: expect.any(String),
    });
    expect(failed(await h.call("unsubscribe", { subscription: "m99" }))).toEqual({
      code: "not_found",
      message: expect.any(String),
    });
    await expect(h.read("vtt://subscriptions/m99")).rejects.toThrow();
  });

  test("unsubscribe closes the subscription and drops the handle", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "all" });
    const id = h.client.liveSubscriptions()[0]?.id;
    ok(await h.call("unsubscribe", { subscription: handle }));
    expect(h.sockets.requestsFor("unsubscribe").map((r) => r.params.subscription)).toEqual([id]);
    expect(h.client.liveSubscriptions()).toEqual([]);
    expect(failed(await h.call("poll_changes", { subscription: handle })).code).toBe("not_found");
    expect(ok(await h.call("subscribe", { scope: { type: "all" } })).subscription).toBe("m2");
  });

  test("a commit outside the scope advances the revision of poll results and the resource", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "objects", ids: ["coin"] });
    const gm = await h.gm();
    const revision = await write(gm, [setHp(4)]);
    await seen(h, revision);
    expect(h.client.revision).toBe(revision);
    expect((await readSub(h, handle)).revision).toBe(revision);
    expect(ok(await h.call("poll_changes", { subscription: handle }))).toEqual({
      subscription: handle,
      revision,
      changes: [],
      overflowed: false,
    });
  });
});

describe("reconnection (PROTOCOL.md §8, §11)", () => {
  test("after a drop and a reconnect to the same session the handle reports a resync and keeps delivering", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "board", board: "map" });
    const oldId = h.client.liveSubscriptions()[0]?.id;
    h.sockets.drop();
    await until(() => !h.client.ready, 3000, "the drop");
    await h.ready();
    const poll = ok(await h.call("poll_changes", { subscription: handle }));
    expect(poll.changes).toEqual([
      { type: "resync", from_revision: 3, to_revision: 3, session_changed: false },
    ]);
    const newId = h.client.liveSubscriptions()[0]?.id;
    const gm = await h.gm();
    const revision = await write(gm, [setHp(11)]);
    const later = ok(await h.call("poll_changes", { subscription: handle, wait_ms: 2000 }));
    expect(later.changes).toHaveLength(1);
    expect(later.changes[0]).toMatchObject({ type: "commit", revision });
    const resource = await readSub(h, handle);
    expect(resource).toMatchObject({ subscription: handle, revision, failed: null });
    expect(resource.objects).toHaveLength(7);
    ok(await h.call("unsubscribe", { subscription: handle }));
    expect(h.sockets.requestsFor("unsubscribe").map((r) => r.params.subscription)).toEqual([newId]);
    expect(oldId).toBeDefined();
    expect(h.client.liveSubscriptions()).toEqual([]);
  });

  test("a restart after a transact committed and before its response: uncertain, and a resync with session_changed", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "board", board: "map" });
    h.sockets.dropOnCommit();
    h.sockets.hold();
    const call = h.call("transact", { base_revision: 3, ops: [setHp(42)] });
    await until(() => h.client.connectionError() !== null, 3000, "the drop on commit");
    await h.restart();
    h.sockets.release();
    const result = failed(await call);
    expect(result.code).toBe("uncertain");
    expect(h.sockets.requestCount("transact")).toBe(1);
    await h.ready();
    const { changes } = ok(await h.call("poll_changes", { subscription: handle }));
    expect(changes[0]).toMatchObject({ type: "resync", session_changed: true });
    expect(changes).toHaveLength(1);
  }, 30_000);

  test("while reconnection is held poll_changes answers disconnected; the buffered records survive", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "board", board: "map" });
    const gm = await h.gm();
    const revision = await write(gm, [setHp(8)]);
    await seen(h, revision);
    h.sockets.hold();
    h.sockets.drop();
    await until(() => h.client.connectionError()?.code === "disconnected", 3000, "disconnected");
    expect(failed(await h.call("poll_changes", { subscription: handle }))).toEqual({
      code: "disconnected",
      message: expect.any(String),
    });
    expect(failed(await h.call("subscribe", { scope: { type: "all" } })).code).toBe("disconnected");
    h.sockets.release();
    await h.ready();
    const { changes } = ok(await h.call("poll_changes", { subscription: handle }));
    expect(changes.map((c: { type: string }) => c.type)).toEqual(["commit", "resync"]);
    expect(changes[0].revision).toBe(revision);
  });

  test("while recovering, poll_changes and subscribe answer disconnected and a recovering subscription gets no record", async () => {
    const h = await start();
    const handle = await subscribe(h, { type: "board", board: "map" });
    const gm = await h.gm();

    // Genuine recovery: tool calls made the moment the client enters `recovering`.
    const during: Promise<ToolResult>[] = [];
    const off = h.client.on("state", (state) => {
      if (state !== "recovering" || during.length > 0) return;
      during.push(h.call("poll_changes", { subscription: handle }));
      during.push(h.call("subscribe", { scope: { type: "all" } }));
    });
    h.sockets.drop();
    await until(() => during.length === 2, 3000, "recovering");
    off();
    for (const result of await Promise.all(during)) {
      // The recovering connection error's message (vtt-5su.19), not the plain drop's.
      expect(failed(result)).toEqual({
        code: "disconnected",
        message: "reconnected; resubscribing",
      });
    }
    await h.ready();
    expect(ok(await h.call("poll_changes", { subscription: handle })).changes).toEqual([
      expect.objectContaining({ type: "resync" }),
    ]);

    // A subscription held in `recovering` (the recovery seam) over a live socket.
    const sub = h.client.liveSubscriptions()[0];
    if (sub === undefined) throw new Error("no subscription");
    sub.markRecovering();
    h.client.setConnectionError({
      code: "disconnected",
      message: "reconnected; resubscribing",
      recovering: true,
    });
    const revision = await write(gm, [setHp(13)]);
    await seen(h, revision);
    expect(failed(await h.call("poll_changes", { subscription: handle }))).toEqual({
      code: "disconnected",
      message: "reconnected; resubscribing",
    });
    expect(failed(await h.call("subscribe", { scope: { type: "all" } })).code).toBe("disconnected");
    h.client.setConnectionError(null);
    expect(ok(await h.call("poll_changes", { subscription: handle })).changes).toEqual([]);
    expect((await readSub(h, handle)).changes).toEqual([]);
  });

  test("a drop during resubscription leaves no failed record and one resync per handle after recovery", async () => {
    const h = await start();
    const a = await subscribe(h, { type: "board", board: "map" });
    const b = await subscribe(h, { type: "objects", ids: ["coin"] });
    let dropped = false;
    const off = h.client.on("state", (state) => {
      if (state !== "recovering" || dropped) return;
      dropped = true;
      // After the resubscribe requests are written, before any response arrives.
      queueMicrotask(() => {
        h.sockets.hold();
        h.sockets.drop();
      });
    });
    const sentBefore = h.sockets.requestCount("subscribe");
    h.sockets.drop();
    await until(() => dropped && h.client.connectionError() !== null, 3000, "the second drop");
    off();
    await until(
      () => h.sockets.requestCount("subscribe") >= sentBefore + 2,
      3000,
      "resubscribe requests",
    );
    expect(failed(await h.call("poll_changes", { subscription: a })).code).toBe("disconnected");
    h.sockets.release();
    await h.ready();
    for (const handle of [a, b]) {
      const { changes } = ok(await h.call("poll_changes", { subscription: handle }));
      expect(changes, handle).toEqual([
        { type: "resync", from_revision: 3, to_revision: 3, session_changed: false },
      ]);
      expect((await readSub(h, handle)).failed).toBeNull();
    }
  });

  test("a board removed while disconnected makes its handle fail not_found; another board keeps delivering", async () => {
    const h = await start();
    const shelf = await subscribe(h, { type: "board", board: "shelf" });
    const map = await subscribe(h, { type: "board", board: "map" });
    h.sockets.hold();
    h.sockets.drop();
    await until(() => h.client.connectionError() !== null, 3000, "the drop");
    const gm = await h.gm();
    await write(gm, [{ type: "remove_board", id: "shelf" }]);
    h.sockets.release();
    await h.ready();
    const poll = ok(await h.call("poll_changes", { subscription: shelf }));
    expect(poll.changes).toEqual([
      { type: "failed", code: "not_found", message: expect.any(String) },
    ]);
    const resource = await readSub(h, shelf);
    expect(resource.failed).toEqual({ code: "not_found", message: expect.any(String) });
    expect(resource.objects).toEqual([]);
    const started = Date.now();
    expect(
      ok(await h.call("poll_changes", { subscription: shelf, wait_ms: 1000 })).changes,
    ).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);

    const revision = await write(gm, [setHp(21)]);
    await seen(h, revision);
    const changes = ok(await h.call("poll_changes", { subscription: map, wait_ms: 2000 })).changes;
    expect(changes.map((c: { type: string }) => c.type)).toContain("commit");
    expect(changes.at(-1)).toMatchObject({ type: "commit", revision });
    ok(await h.call("unsubscribe", { subscription: shelf }));
  });
});
