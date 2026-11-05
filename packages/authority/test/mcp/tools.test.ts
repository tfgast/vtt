/// <reference types="node" />
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { TableHost, TOOLS, withConnection } from "@vtt/authority";
import { METHOD_NAMES, ProtocolClient, WIRE_OP_TYPES } from "@vtt/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { cleanupHarnesses, type McpHarness, startHarness, type ToolResult, until } from "./support";

afterEach(async () => {
  await cleanupHarnesses();
});

/** The tool list of PROTOCOL.md §11 handled here: names and required arguments. */
const TOOL_TABLE: Record<string, string[]> = {
  table_info: [],
  list_objects: [],
  get_objects: ["ids"],
  evaluate: ["source"],
  zones: ["board"],
  at_position: ["board", "position"],
  changes_since: ["revision"],
  log: [],
  explain_cell: ["object", "cell"],
  explain_group: ["index"],
  explain_action: ["object", "action"],
  transact: ["base_revision", "ops"],
  undo: ["target"],
  save: [],
};

/** One valid op of every WireOp kind (PROTOCOL.md §5). */
const OP_EXAMPLES: Record<string, Record<string, unknown>> = {
  set_value: { object: "goblin", cell: "hp", value: { type: "number", value: 1 } },
  set_formula: { object: "goblin", cell: "hp2", source: "hp + 1" },
  clear_override: { object: "goblin", cell: "hp" },
  delete_cell: { object: "goblin", cell: "hp" },
  rename_cell: { object: "goblin", from: "hp", to: "health" },
  set_cell_visibility: { object: "goblin", cell: "hp", viewers: null },
  set_tag: { object: "goblin", tags: ["creature"] },
  set_shape: { object: "goblin", shape: { type: "circle", radius: 1 } },
  set_template_flag: { object: "goblin", value: true },
  set_character_flag: { object: "goblin", value: true },
  set_actions: { object: "goblin", actions: [{ name: "Heal", steps: ["7 -> hp"] }] },
  reorder: { container: "bag", permutation: [1, 0] },
  add_board: { id: "cellar", name: "Cellar" },
  rename_board: { id: "map", name: "Big map" },
  remove_board: { id: "shelf" },
  create_object: {
    id: "orc",
    as: "$orc",
    to: { type: "board", board: "map", position: [0, 0] },
    init: { tag: ["creature"], cells: { hp: { type: "formula", source: "3 + 4" } } },
  },
  spawn: { template: "goblin", to: { type: "container", container: "bag" } },
  move: { object: "goblin", to: { type: "board", board: "map", position: [3, 3] } },
  remove: { object: "coin" },
};

/** Valid arguments for every tool, in TOOLS order. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  table_info: {},
  list_objects: {},
  get_objects: { ids: ["goblin"] },
  evaluate: { source: "1" },
  zones: { board: "map" },
  at_position: { board: "map", position: [0, 0] },
  changes_since: { revision: 0 },
  log: {},
  explain_cell: { object: "goblin", cell: "hp" },
  explain_group: { index: 0 },
  explain_action: { object: "goblin", action: "Heal" },
  transact: { base_revision: 3, ops: [{ type: "remove", object: "coin" }] },
  undo: { target: { type: "latest" } },
  save: {},
};

const setHp = (hp: number) => ({
  type: "set_value",
  object: "goblin",
  cell: "hp",
  value: { type: "number", value: hp },
});

/** The structured content of a successful result, checking the result shape (§11). */
// biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
function ok(result: ToolResult): any {
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  expectOneJsonBlock(result);
  return result.structuredContent;
}

/** The structured content of an `isError` result carrying a structured error or rejection. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
function failed(result: ToolResult): any {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  expectOneJsonBlock(result);
  return result.structuredContent;
}

function expectOneJsonBlock(result: ToolResult): void {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(result.structuredContent);
}

/** An SDK input-validation error: `isError` with the SDK's message, no structured content. */
function inputError(result: ToolResult): void {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content[0]?.text).toMatch(/^Input validation error/);
}

async function listed(h: McpHarness) {
  return (await h.mcp.listTools()).tools;
}

describe("tool list", () => {
  test("is the 14-tool table with its required arguments", async () => {
    const h = await startHarness();
    const tools = await listed(h);
    const table = Object.fromEntries(
      tools.map((t) => [t.name, [...((t.inputSchema.required as string[] | undefined) ?? [])]]),
    );
    expect(table).toEqual(TOOL_TABLE);
    expect(TOOLS.map((t) => t.name)).toEqual(Object.keys(TOOL_TABLE));
    expect(Object.isFrozen(TOOLS)).toBe(true);
  });

  test("every listed input schema is strict and is z.toJSONSchema of the TOOLS schema", async () => {
    const h = await startHarness();
    const tools = await listed(h);
    for (const spec of TOOLS) {
      const tool = tools.find((t) => t.name === spec.name);
      expect(tool, spec.name).toBeDefined();
      expect(tool?.inputSchema.additionalProperties, spec.name).toBe(false);
      const { $schema: _, ...expected } = z.toJSONSchema(spec.input, { io: "input" });
      const { $schema: __, ...actual } = tool?.inputSchema ?? {};
      expect(actual, spec.name).toEqual(expected);
      expect(tool?.description, spec.name).toBe(spec.description);
    }
  });

  test("parity: every protocol method but invoke, document, subscribe and unsubscribe has a tool", async () => {
    const h = await startHarness();
    const names = new Set((await listed(h)).map((t) => t.name));
    const excluded = new Set(["invoke", "document", "subscribe", "unsubscribe"]);
    const methods = METHOD_NAMES.filter((m) => !excluded.has(m));
    expect(methods).toHaveLength(13);
    for (const method of methods) expect(names.has(method), method).toBe(true);
    for (const method of excluded) expect(names.has(method), method).toBe(false);
    expect([...names].sort()).toEqual([...methods, "table_info"].sort());
  });

  test("every one of the 19 WireOp kinds validates in the transact input JSON Schema", async () => {
    const h = await startHarness();
    const transact = (await listed(h)).find((t) => t.name === "transact");
    expect(transact).toBeDefined();
    const schema = fromJsonSchema(transact?.inputSchema as Parameters<typeof fromJsonSchema>[0]);
    const validate = (value: unknown) =>
      schema["~standard"].validate(value) as { issues?: unknown };
    expect(Object.keys(OP_EXAMPLES).sort()).toEqual([...WIRE_OP_TYPES].sort());
    for (const [type, fields] of Object.entries(OP_EXAMPLES)) {
      const input = { base_revision: 3, ops: [{ type, ...fields }] };
      expect(validate(input).issues, type).toBeUndefined();
      // An unknown key inside an op is refused (strict all the way down).
      const extra = { base_revision: 3, ops: [{ type, ...fields, extra: 1 }] };
      expect(validate(extra).issues, `${type} + extra`).toBeDefined();
    }
    for (const field of ["actor", "retry", "txn_id"]) {
      const input = { base_revision: 3, ops: [{ type: "remove", object: "coin" }], [field]: "x" };
      expect(validate(input).issues, field).toBeDefined();
    }
  });

  test("the transact description says what an agent must know (§11 tool descriptions)", () => {
    const transact = TOOLS.find((t) => t.name === "transact");
    const text = transact?.description ?? "";
    expect(text).toMatch(/human-meaningful/);
    expect(text).toMatch(/revision/);
    expect(text).toMatch(/table_info/);
    expect(text).toMatch(/one undoable group/);
    expect(text).toMatch(/vtt:\/\/docs\/formulas/);
  });
});

describe("happy paths and errors, one per tool", () => {
  test("table_info", async () => {
    const h = await startHarness();
    const info = ok(await h.call("table_info"));
    expect(info).toEqual({
      revision: 3,
      boards: h.client.boards,
      table: { name: "untitled", path: null, id: null },
      limits: h.client.limits,
      actor: { type: "agent", name: "mcp-test" },
      session: h.server.session,
    });
    inputError(await h.call("table_info", { extra: 1 }));
  });

  test("list_objects", async () => {
    const h = await startHarness();
    const page = ok(await h.call("list_objects", { limit: 2 }));
    expect(page.objects.map((o: { id: string }) => o.id)).toEqual(["bag", "chest"]);
    expect(page.next_cursor).toEqual(expect.any(String));
    const before = h.sockets.requestCount();
    inputError(await h.call("list_objects", { limit: 201 }));
    expect(h.sockets.requestCount()).toBe(before);
  });

  test("get_objects", async () => {
    const h = await startHarness();
    const got = ok(await h.call("get_objects", { ids: ["goblin", "nobody"] }));
    expect(got.missing).toEqual(["nobody"]);
    expect(got.objects[0].cells.hp.value).toEqual({ type: "number", value: 7 });
    inputError(await h.call("get_objects", { ids: [] }));
  });

  test("evaluate", async () => {
    const h = await startHarness();
    expect(ok(await h.call("evaluate", { source: "1 + 2" })).value).toEqual({
      type: "number",
      value: 3,
    });
    expect(failed(await h.call("evaluate", { source: "1", this: "nobody" }))).toEqual({
      code: "not_found",
      message: expect.any(String),
    });
  });

  test("zones", async () => {
    const h = await startHarness();
    const gm = await h.gm();
    await gm.transact([
      {
        type: "create_object",
        id: "room1",
        to: { type: "board", board: "map", position: [0, 0] },
        init: { is_zone: true, shape: { type: "rect", width: 4, height: 4 } },
      },
    ]);
    const zones = ok(await h.call("zones", { board: "map" })).zones;
    expect(zones.map((z: { id: string }) => z.id)).toEqual(["room1"]);
    expect(failed(await h.call("zones", { board: "nowhere" })).code).toBe("not_found");
  });

  test("at_position", async () => {
    const h = await startHarness();
    expect(ok(await h.call("at_position", { board: "map", position: [1, 2] })).objects).toEqual([
      "goblin",
    ]);
    expect(failed(await h.call("at_position", { board: "nowhere", position: [0, 0] })).code).toBe(
      "not_found",
    );
  });

  test("changes_since", async () => {
    const h = await startHarness();
    const gm = await h.gm();
    await gm.transact([setHp(9)] as never, { base_revision: 3 });
    const changes = ok(await h.call("changes_since", { revision: 3 }));
    expect(changes.groups).toHaveLength(1);
    expect(changes.revision).toBe(4);
    expect(failed(await h.call("changes_since", { revision: 99 })).code).toBe("bad_request");
  });

  test("log", async () => {
    const h = await startHarness();
    const gm = await h.gm();
    await gm.transact([setHp(9)] as never, { base_revision: 3, label: "heal" });
    const log = ok(await h.call("log", {}));
    expect(log.groups.map((g: { label: string }) => g.label)).toEqual(["heal"]);
    inputError(await h.call("log", { limit: 0 }));
  });

  test("explain_cell", async () => {
    const h = await startHarness();
    const explained = ok(await h.call("explain_cell", { object: "goblin", cell: "hp" }));
    expect(explained.view.value).toEqual({ type: "number", value: 7 });
    expect(failed(await h.call("explain_cell", { object: "nobody", cell: "hp" })).code).toBe(
      "not_found",
    );
  });

  test("explain_group", async () => {
    const h = await startHarness();
    expect(failed(await h.call("explain_group", { index: 0 })).code).toBe("not_found");
    const gm = await h.gm();
    await gm.transact([setHp(9)] as never, { base_revision: 3, label: "heal" });
    expect(ok(await h.call("explain_group", { index: 0 })).group.label).toBe("heal");
  });

  test("explain_action", async () => {
    const h = await startHarness();
    ok(
      await h.call("transact", {
        base_revision: 3,
        ops: [
          {
            type: "set_actions",
            object: "goblin",
            actions: [{ name: "Heal", steps: ["7 -> hp"] }],
          },
        ],
      }),
    );
    expect(ok(await h.call("explain_action", { object: "goblin", action: "Heal" }))).toEqual({
      object: "goblin",
      action: "Heal",
      enabled: true,
      steps: ["7 -> hp"],
    });
    expect(failed(await h.call("explain_action", { object: "goblin", action: "nope" })).code).toBe(
      "not_found",
    );
  });

  test("transact: committed, and a rejection with its op_index", async () => {
    const h = await startHarness();
    const committed = ok(
      await h.call("transact", { base_revision: 3, ops: [setHp(9)], label: "hurt" }),
    );
    expect(committed).toMatchObject({ status: "committed", revision: 4, index: 0 });
    const sent = h.sockets.requestsFor("transact");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toMatchObject({ base_revision: 3, label: "hurt" });
    expect(sent[0]?.params.txn_id).toEqual(expect.any(String));
    expect(sent[0]?.params).not.toHaveProperty("retry");
    expect(sent[0]?.params).not.toHaveProperty("actor");

    const rejected = failed(
      await h.call("transact", { base_revision: 4, ops: [{ type: "remove", object: "nobody" }] }),
    );
    expect(rejected).toEqual({
      status: "rejected",
      rejection: { type: "invalid", message: expect.any(String) },
      op_index: 0,
    });
  });

  test("transact: a stale write returns isError with stale_write", async () => {
    const h = await startHarness();
    const gm = await h.gm();
    await gm.transact([setHp(9)] as never, { base_revision: 3, label: "gm heal" });
    const stale = failed(await h.call("transact", { base_revision: 3, ops: [setHp(1)] }));
    expect(stale.status).toBe("rejected");
    expect(stale.rejection).toMatchObject({
      type: "stale_write",
      base_revision: 3,
      revision: 4,
      conflicts: [{ index: 0, label: "gm heal" }],
    });
  });

  test("undo", async () => {
    const h = await startHarness();
    const nothing = failed(await h.call("undo", { target: { type: "latest" } }));
    expect(nothing).toEqual({ status: "rejected", rejection: { type: "nothing_to_undo" } });
    ok(await h.call("transact", { base_revision: 3, ops: [setHp(9)] }));
    const undone = ok(await h.call("undo", { target: { type: "mine" }, expect_index: 0 }));
    expect(undone).toMatchObject({ status: "committed", revision: 5 });
    ok(await h.call("undo", { target: { type: "group", index: 1 }, label: "redo" }));
  });

  test("save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vtt-mcp-"));
    const host = await TableHost.open(join(dir, "t.table.json"), {
      createIfMissing: true,
      autosave: false,
    });
    try {
      const h = await startHarness({ host });
      const saved = ok(await h.call("save"));
      expect(saved).toMatchObject({ status: "saved" });
      inputError(await h.call("save", { force: true }));
      await cleanupHarnesses();
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("input schemas", () => {
  test("transact carrying actor, retry or txn_id, and undo with an actor target, send nothing", async () => {
    const h = await startHarness();
    const before = h.sockets.requestCount();
    const ops = [setHp(9)];
    inputError(
      await h.call("transact", {
        base_revision: 3,
        ops,
        actor: { type: "character", id: "goblin" },
      }),
    );
    inputError(await h.call("transact", { base_revision: 3, ops, retry: true }));
    inputError(await h.call("transact", { base_revision: 3, ops, txn_id: "mine" }));
    inputError(
      await h.call("undo", { target: { type: "actor", actor: { type: "agent", name: "x" } } }),
    );
    inputError(await h.call("transact", { ops }));
    expect(h.sockets.requestCount()).toBe(before);
    expect(h.sockets.requestCount("transact")).toBe(0);
    expect(h.sockets.requestCount("undo")).toBe(0);
  });
});

describe("transact retry (PROTOCOL.md §6)", () => {
  test("a socket dropped after the commit and before the response is retried once with the same txn_id", async () => {
    const h = await startHarness();
    h.sockets.dropOnCommit();
    const result = ok(
      await h.call("transact", { base_revision: 3, ops: [setHp(9)], label: "lost" }),
    );
    expect(result).toMatchObject({ status: "committed", revision: 4, index: 0 });
    const sent = h.sockets.requestsFor("transact");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.params.retry).toBeUndefined();
    expect(sent[1]?.params).toEqual({ ...sent[0]?.params, retry: true });
    const gm = await h.gm();
    const log = await gm.request("log", {});
    expect(log.groups).toHaveLength(1);
    expect(log.groups[0]?.label).toBe("lost");
  });
});

describe("extensions", () => {
  test("an extension is called with the server and the client", async () => {
    const calls: unknown[][] = [];
    const h = await startHarness({
      extensions: [
        (server, client) => {
          calls.push([server, client]);
          server.registerTool("extra", { description: "an extension's tool" }, async () => ({
            content: [{ type: "text", text: "extra" }],
          }));
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(h.mcpServer);
    expect(calls[0]?.[1]).toBe(h.client);
    expect((await listed(h)).map((t) => t.name)).toContain("extra");
  });
});

describe("connection gate (PROTOCOL.md §11)", () => {
  test("disconnected while reconnection is held, then unauthorized after a restart with a new token", async () => {
    const h = await startHarness();
    h.sockets.hold();
    h.sockets.drop();
    await until(() => h.client.connectionError()?.code === "disconnected", 3000, "disconnected");
    const before = h.sockets.requestCount();
    for (const [name, args] of [
      ["table_info", {}],
      ["get_objects", { ids: ["goblin"] }],
    ] as const) {
      expect(failed(await h.call(name, args)), name).toEqual({
        code: "disconnected",
        message: expect.any(String),
      });
    }
    expect(h.sockets.requestCount()).toBe(before);

    await h.restart({ token: "a-different-token" });
    h.sockets.release();
    await until(() => h.client.connectionError()?.code === "unauthorized", 5000, "unauthorized");
    for (const [name, args] of [
      ["table_info", {}],
      ["get_objects", { ids: ["goblin"] }],
    ] as const) {
      expect(failed(await h.call(name, args)), name).toEqual({
        code: "unauthorized",
        message: expect.any(String),
      });
    }
    expect(h.sockets.requestCount()).toBe(before);
  });

  test("before the first welcome every tool answers disconnected and sends nothing", async () => {
    const h = await startHarness({ connect: false });
    expect(Object.keys(VALID_ARGS)).toEqual(TOOLS.map((t) => t.name));
    for (const [name, args] of Object.entries(VALID_ARGS)) {
      expect(failed(await h.call(name, args)), name).toEqual({
        code: "disconnected",
        message: expect.any(String),
      });
    }
    expect(h.sockets.opened).toBe(0);
    expect(h.sockets.requestCount()).toBe(0);
  });

  test("while recovering (connectionError with recovering: true) tools answer disconnected", async () => {
    const h = await startHarness();
    h.client.setConnectionError({
      code: "disconnected",
      message: "resubscribing",
      recovering: true,
    });
    expect(failed(await h.call("get_objects", { ids: ["goblin"] }))).toEqual({
      code: "disconnected",
      message: "resubscribing",
    });
    h.client.setConnectionError(null);
    ok(await h.call("get_objects", { ids: ["goblin"] }));
  });

  test("withConnection passes through when connected and gates otherwise", async () => {
    const h = await startHarness();
    let calls = 0;
    const handler = withConnection(h.client, async (args: { n: number }) => {
      calls++;
      return { content: [{ type: "text" as const, text: String(args.n) }] };
    });
    expect(await handler({ n: 7 })).toEqual({
      content: [{ type: "text", text: "7" }],
    });
    expect(calls).toBe(1);

    const offline = new ProtocolClient({
      url: h.server.url,
      token: h.server.token,
      client: { name: "offline", kind: "test" },
    });
    const gated = withConnection(offline, async () => {
      calls++;
      return { content: [] };
    });
    const result = (await gated()) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "disconnected", message: expect.any(String) });
    expect(calls).toBe(1);
    offline.close();
  });
});
