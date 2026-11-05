/**
 * The MCP tool `invoke` (vtt-1xv.13; PROTOCOL.md §11; DESIGN.md §5.2; D19)
 * and the `face` of change records' `ObjectFacts`, in process over the
 * shared harness (vtt-5su.11's test/mcp/support.ts): a real authority on
 * port 0 over the Attack card fixture's setup with its scripted dice.
 */
import {
  DocumentStore,
  INVOKE_DESCRIPTION,
  INVOKE_RETRY_MS,
  InvokeInputSchema,
  ScriptedDiceSource,
  subscriptionTools,
  TableHost,
  TOOLS,
} from "@vtt/authority";
import { documentFromSetup } from "@vtt/authority/test-runner";
import type { Snapshot } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { loadScenarioFile } from "../runner/load";
import { cleanupHarnesses, type McpHarness, startHarness, type ToolResult, until } from "./support";

afterEach(async () => {
  await cleanupHarnesses();
});

const ATTACK = await loadScenarioFile("attack-card.json");

/** The request surface of PROTOCOL.md §11, in its table order. */
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
  "invoke",
  "undo",
  "save",
];

/** The Attack card setup (the template in Aldric's binder, the goblin) with `edit` applied. */
function attackTable(edit: (doc: Snapshot) => void = () => undefined): TableHost {
  const doc = documentFromSetup(ATTACK.setup);
  edit(doc);
  const dice = new ScriptedDiceSource(structuredClone(ATTACK.dice) as never);
  return TableHost.inMemory(DocumentStore.fromSnapshot(doc), { dice });
}

const start = (
  edit?: (doc: Snapshot) => void,
  extensions: Parameters<typeof startHarness>[0]["extensions"] = [],
) => startHarness({ host: attackTable(edit), extensions });

// biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
function ok(result: ToolResult): any {
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  expectOneJsonBlock(result);
  return result.structuredContent;
}

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

function inputError(result: ToolResult): void {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content[0]?.text).toMatch(/^Input validation error/);
}

const ref = (object: string) => ({ type: "ref", object });

/**
 * The agent spawns the Attack card onto the table with Aldric as the
 * attacker and the goblin as the target; returns the card's id and the
 * revision after it.
 */
async function dealAttack(h: McpHarness): Promise<{ card: string; revision: number }> {
  const info = ok(await h.call("table_info"));
  const spawned = ok(
    await h.call("transact", {
      base_revision: info.revision,
      ops: [
        {
          type: "spawn",
          template: "attack_card",
          to: { type: "board", board: "table", position: [2, 0] },
          cells: { attacker: ref("aldric"), target: ref("goblin1") },
          as: "$attack",
        },
      ],
      label: "deal attack",
    }),
  );
  return { card: spawned.bindings.$attack, revision: spawned.revision };
}

async function cell(h: McpHarness, object: string, name: string): Promise<unknown> {
  const got = ok(await h.call("get_objects", { ids: [object] }));
  return got.objects[0].cells[name]?.value;
}

describe("the tool list (PROTOCOL.md §11)", () => {
  test("the request-surface server lists 15 tools including invoke, in table order", async () => {
    const h = await start();
    const names = (await h.mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(REQUEST_TOOLS);
    expect(names).toHaveLength(15);
    expect(TOOLS.map((t) => t.name)).toEqual(REQUEST_TOOLS);
  });

  test("invoke's input schema is strict, without actor, retry and txn_id", async () => {
    const h = await start();
    const tool = (await h.mcp.listTools()).tools.find((t) => t.name === "invoke");
    expect(tool).toBeDefined();
    const { $schema: _, ...expected } = z.toJSONSchema(InvokeInputSchema, { io: "input" });
    const { $schema: __, ...actual } = (tool?.inputSchema ?? {}) as Record<string, unknown>;
    expect(actual).toEqual(expected);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect([...((tool?.inputSchema.required as string[]) ?? [])].sort()).toEqual([
      "action",
      "base_revision",
      "object",
    ]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "action",
      "base_revision",
      "label",
      "object",
      "table",
    ]);
    expect(tool?.description).toBe(INVOKE_DESCRIPTION);
  });

  test("the description names set_actions, the table destination and the revision", () => {
    expect(INVOKE_DESCRIPTION).toMatch(/transact/);
    expect(INVOKE_DESCRIPTION).toMatch(/set_actions/);
    expect(INVOKE_DESCRIPTION).toMatch(/`table`/);
    expect(INVOKE_DESCRIPTION).toMatch(/board/);
    expect(INVOKE_DESCRIPTION).toMatch(/point/);
    expect(INVOKE_DESCRIPTION).toMatch(/base_revision/);
    expect(INVOKE_DESCRIPTION).toMatch(/uncertain/);
    expect(INVOKE_RETRY_MS).toBe(10_000);
  });

  test("actor, retry, txn_id, an unknown key or a missing base_revision send nothing", async () => {
    const h = await start();
    const args = { object: "aldric", action: "Roll", base_revision: 0 };
    const before = h.sockets.requestCount();
    inputError(await h.call("invoke", { ...args, actor: { type: "character", id: "aldric" } }));
    inputError(await h.call("invoke", { ...args, retry: true }));
    inputError(await h.call("invoke", { ...args, txn_id: "mine" }));
    inputError(await h.call("invoke", { ...args, extra: 1 }));
    inputError(await h.call("invoke", { object: "aldric", action: "Roll" }));
    inputError(await h.call("invoke", { ...args, table: { board: "table" } }));
    expect(h.sockets.requestCount()).toBe(before);
    expect(h.sockets.requestCount("invoke")).toBe(0);
  });
});

describe("invoke", () => {
  test("the agent invokes the Attack card's Roll and gets the committed revision", async () => {
    const h = await start();
    const { card, revision } = await dealAttack(h);
    const rolled = ok(
      await h.call("invoke", { object: card, action: "Roll", base_revision: revision }),
    );
    expect(rolled).toEqual({
      status: "committed",
      revision: revision + 1,
      index: 1,
      created: [],
    });
    expect(ok(await h.call("table_info")).revision).toBe(revision + 1);
    expect(await cell(h, card, "roll")).toEqual({
      type: "roll",
      expr: "1d20",
      dice: [12],
      dropped: [],
      total: 12,
    });
    expect(await cell(h, card, "hit")).toEqual({ type: "boolean", value: true });

    const sent = h.sockets.requestsFor("invoke");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toEqual({
      object: card,
      action: "Roll",
      base_revision: revision,
      txn_id: expect.any(String),
    });

    const log = ok(await h.call("log", {}));
    expect(log.groups[0]).toMatchObject({
      index: 1,
      kind: "action",
      label: "Roll",
      actor: { type: "agent", name: "mcp-test" },
    });
  });

  test("a label names the group; every call generates a fresh txn_id", async () => {
    const h = await start();
    const { card, revision } = await dealAttack(h);
    ok(
      await h.call("invoke", {
        object: card,
        action: "Roll",
        base_revision: revision,
        label: "to hit",
      }),
    );
    const damage = ok(
      await h.call("invoke", { object: card, action: "Roll damage", base_revision: revision + 1 }),
    );
    expect(damage).toMatchObject({ status: "committed", revision: revision + 2 });
    const log = ok(await h.call("log", {}));
    expect(log.groups.map((g: { label: string }) => g.label)).toEqual([
      "Roll damage",
      "to hit",
      "deal attack",
    ]);
    const ids = h.sockets.requestsFor("invoke").map((r) => r.params.txn_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test("a when_false refusal is isError with the rejection and changes nothing", async () => {
    const h = await start();
    const { card, revision } = await dealAttack(h);
    ok(await h.call("invoke", { object: card, action: "Roll", base_revision: revision }));
    const again = failed(
      await h.call("invoke", { object: card, action: "Roll", base_revision: revision + 1 }),
    );
    expect(again).toEqual({
      status: "rejected",
      rejection: { type: "when_false", object: card, action: "Roll" },
    });
    expect(ok(await h.call("table_info")).revision).toBe(revision + 1);
  });

  test("a step error is isError with the rejection and the refusing step", async () => {
    const h = await start((doc) => {
      const aldric = doc.objects.aldric;
      if (aldric === undefined) throw new Error("fixture");
      aldric.actions = [
        { name: "Divide", steps: ["set(damage_taken, 1)", "set(damage_taken, 1 / 0)"] },
      ];
    });
    const refused = failed(
      await h.call("invoke", { object: "aldric", action: "Divide", base_revision: 0 }),
    );
    expect(refused).toMatchObject({
      status: "rejected",
      rejection: { type: "step_error", object: "aldric", action: "Divide", step: 1, code: "#DIV0" },
      step: 1,
    });
    expect(await cell(h, "aldric", "damage_taken")).toBeUndefined();
  });

  test("table is what the table destination resolves to", async () => {
    const h = await start((doc) => {
      const aldric = doc.objects.aldric;
      if (aldric === undefined) throw new Error("fixture");
      aldric.actions = [{ name: "Deal", steps: ['spawn(obj("attack_card"), table)'] }];
    });
    const none = failed(
      await h.call("invoke", { object: "aldric", action: "Deal", base_revision: 0 }),
    );
    expect(none).toMatchObject({ rejection: { type: "step_error", step: 0 }, step: 0 });
    const dealt = ok(
      await h.call("invoke", {
        object: "aldric",
        action: "Deal",
        base_revision: 0,
        table: { board: "table", position: [7, -3] },
      }),
    );
    expect(dealt.created).toHaveLength(1);
    const copy = ok(await h.call("get_objects", { ids: dealt.created }));
    expect(copy.objects[0].cells.board.value).toEqual(ref("table"));
    expect(copy.objects[0].cells.position.value).toEqual({
      type: "list",
      items: [
        { type: "number", value: 7 },
        { type: "number", value: -3 },
      ],
    });
  });

  test("a stale write is isError with stale_write", async () => {
    const h = await start();
    const { card, revision } = await dealAttack(h);
    const gm = await h.gm();
    await gm.transact(
      [{ type: "set_value", object: card, cell: "roll", value: { type: "number", value: 3 } }],
      { base_revision: revision, label: "gm roll" },
    );
    const stale = failed(
      await h.call("invoke", { object: card, action: "Roll", base_revision: revision }),
    );
    expect(stale.status).toBe("rejected");
    expect(stale.rejection).toMatchObject({ type: "stale_write", base_revision: revision });
  });

  test("an unknown object is isError with the protocol error", async () => {
    const h = await start();
    const missing = failed(
      await h.call("invoke", { object: "nobody", action: "Roll", base_revision: 0 }),
    );
    expect(missing).toEqual({ code: expect.any(String), message: expect.any(String) });
  });
});

describe("retry and uncertainty (PROTOCOL.md §6)", () => {
  test("a socket dropped after the commit is retried once with the same txn_id", async () => {
    const h = await start();
    const { card, revision } = await dealAttack(h);
    h.sockets.dropOnCommit();
    const result = ok(
      await h.call("invoke", { object: card, action: "Roll", base_revision: revision }),
    );
    expect(result).toMatchObject({ status: "committed", revision: revision + 1, index: 1 });
    const sent = h.sockets.requestsFor("invoke");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.params.retry).toBeUndefined();
    expect(sent[1]?.params).toEqual({ ...sent[0]?.params, retry: true });
    const log = ok(await h.call("log", {}));
    expect(log.groups.map((g: { label: string }) => g.label)).toEqual(["Roll", "deal attack"]);
  });

  test("an authority restart before the resend is isError uncertain", async () => {
    const h = await start();
    const { card, revision } = await dealAttack(h);
    h.sockets.dropOnCommit();
    h.sockets.hold();
    const pending = h.call("invoke", { object: card, action: "Roll", base_revision: revision });
    await until(() => h.client.connectionError()?.code === "disconnected", 3000, "disconnected");
    await h.restart();
    h.sockets.release();
    const result = failed(await pending);
    expect(result).toMatchObject({ code: "uncertain", message: expect.any(String) });
    expect(h.sockets.requestsFor("invoke")).toHaveLength(1);
  });
});

describe("connection gate (PROTOCOL.md §11)", () => {
  test("before the first welcome invoke answers disconnected and sends nothing", async () => {
    const h = await startHarness({ host: attackTable(), connect: false });
    expect(
      failed(await h.call("invoke", { object: "aldric", action: "Roll", base_revision: 0 })),
    ).toEqual({ code: "disconnected", message: expect.any(String) });
    expect(h.sockets.opened).toBe(0);
    expect(h.sockets.requestCount()).toBe(0);
  });
});

describe("change records carry face (PROTOCOL.md §11 ObjectFacts)", () => {
  const FACE = {
    elements: [
      { type: "value", cell: "ac", rect: [0, 0, 1, 1], show_when: "damage_taken > 0" },
      { type: "value", cell: "name", rect: [0, 1, 1, 1] },
    ],
  };
  const layout = (face: typeof FACE) => ({
    elements: face.elements.map((e, index) => ({ ...e, index })),
  });

  test("a set_face by the GM produces a commit record whose objects entry shows face before and after", async () => {
    const h = await start(undefined, [subscriptionTools()]);
    const sub = ok(await h.call("subscribe", { scope: { type: "all" } })).subscription;
    const gm = await h.gm();
    const added = await gm.transact([{ type: "set_face", object: "goblin1", face: FACE }] as never);
    expect(added.status).toBe("committed");
    const changed = await gm.transact([
      {
        type: "set_face",
        object: "goblin1",
        face: { elements: [FACE.elements[1]], default_action: "Poke" },
      },
    ] as never);
    expect(changed.status).toBe("committed");
    const removed = await gm.transact([
      { type: "set_face", object: "goblin1", face: null },
    ] as never);
    expect(removed.status).toBe("committed");
    await until(() => h.client.revision >= 3, 3000, "revision 3");

    const polled = ok(await h.call("poll_changes", { subscription: sub, wait_ms: 1000 }));
    const commits = polled.changes.filter((c: { type: string }) => c.type === "commit");
    expect(commits).toHaveLength(3);
    const facts = { is_template: false, is_character: false, actions: [] };
    expect(commits[0].objects).toEqual([
      { object: "goblin1", before: facts, after: { ...facts, face: layout(FACE) } },
    ]);
    // The live `shown` is not part of the facts: the stored layout with each `index`.
    expect(commits[0].objects[0].after.face.elements[0]).not.toHaveProperty("shown");
    expect(commits[1].objects).toEqual([
      {
        object: "goblin1",
        before: { ...facts, face: layout(FACE) },
        after: {
          ...facts,
          face: { elements: [{ ...FACE.elements[1], index: 0 }], default_action: "Poke" },
        },
      },
    ]);
    expect(commits[2].objects).toEqual([
      {
        object: "goblin1",
        before: {
          ...facts,
          face: { elements: [{ ...FACE.elements[1], index: 0 }], default_action: "Poke" },
        },
        after: facts,
      },
    ]);
  });

  test("a show_when flip changes no face fact", async () => {
    const h = await start(undefined, [subscriptionTools()]);
    const gm = await h.gm();
    await gm.transact([{ type: "set_face", object: "goblin1", face: FACE }] as never);
    await until(() => h.client.revision >= 1, 3000, "revision 1");
    const sub = ok(await h.call("subscribe", { scope: { type: "all" } })).subscription;
    await gm.transact([
      {
        type: "set_value",
        object: "goblin1",
        cell: "damage_taken",
        value: { type: "number", value: 4 },
      },
    ] as never);
    await until(() => h.client.revision >= 2, 3000, "revision 2");
    const polled = ok(await h.call("poll_changes", { subscription: sub, wait_ms: 1000 }));
    const [commit] = polled.changes;
    expect(commit.type).toBe("commit");
    expect(commit.objects).toEqual([]);
    expect(commit.cells.map((c: { cell: string }) => c.cell)).toEqual(["damage_taken"]);
  });
});
