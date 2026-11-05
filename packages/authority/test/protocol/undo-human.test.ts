/**
 * The undo target `human` over a real server (vtt-nb8.3; PROTOCOL.md §4, §6,
 * §12; DESIGN.md §7 Undo; M6-D2): the latest candidate whose actor is `gm`
 * or any character, so a button the GM pressed in view-as is undone by the
 * UI's Ctrl+Z and the agent's newer work is left alone. `mine`, `latest`,
 * `actor` and `group` are unchanged; `expect_index` works with `human` as
 * with any target.
 */
import { DocumentStore, newTableSnapshot, TableHost } from "@vtt/authority";
import {
  type ProtocolClient,
  type TransactResult,
  UndoParamsSchema,
  type WireOp,
} from "@vtt/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, connect, serve } from "../server/helpers";

afterEach(cleanup);

const num = (value: number) => ({ type: "number" as const, value });

const create = (id: string, cells: Record<string, number> = {}): WireOp => ({
  type: "create_object",
  id,
  to: { type: "board", board: "gm_board", position: [0, 0] },
  init: {
    cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, num(v)])),
  },
});

type Committed = Extract<TransactResult, { status: "committed" }>;

function committed(r: TransactResult | { status: string }): Committed {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Committed;
}

/**
 * A server over a new table, a `ui` client and an `agent` client. The ui
 * client sets up the character `aldric` and `lever`, whose action `Pull`
 * adds 1 to its `pulls` (one `gm` group, index 0).
 */
async function world() {
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
  const { server } = await serve({ host });
  const ui = await connect(server, { client: { name: "GM", kind: "ui" }, instance: "ui-1" });
  const agent = await connect(server, {
    client: { name: "Scribe", kind: "agent" },
    instance: "agent-1",
  });
  committed(
    await ui.transact(
      [
        {
          type: "create_object",
          id: "aldric",
          to: { type: "board", board: "gm_board", position: [0, 0] },
          init: { is_character: true, cells: { hp: num(10) } },
        },
        {
          type: "create_object",
          id: "lever",
          to: { type: "board", board: "gm_board", position: [2, 0] },
          init: {
            cells: { pulls: num(0) },
            actions: [{ name: "Pull", steps: ["add(pulls, 1)"] }],
          },
        },
      ],
      { label: "Setup", base_revision: host.revision },
    ),
  );
  const pullAs = (client: ProtocolClient, character?: string) =>
    client.invoke({
      object: "lever",
      action: "Pull",
      base_revision: host.revision,
      ...(character === undefined ? {} : { actor: { type: "character", id: character } }),
    });
  const pulls = () => host.table.store.getObject("lever")?.cells.pulls?.content;
  const group = (index: number) => host.table.store.history.get(index);
  return { host, ui, agent, pullAs, pulls, group };
}

describe("undo target human", () => {
  test("reverses the ui client's character invoke, which mine would not select", async () => {
    const w = await world();
    const pull = committed(await w.pullAs(w.ui, "aldric"));
    expect(w.group(pull.index)?.actor).toEqual({ type: "character", id: "aldric" });
    expect(w.pulls()).toEqual(num(1));

    // mine names the older gm Setup group, not the character's invoke.
    const mine = await w.ui.request("undo", {
      target: { type: "mine" },
      expect_index: pull.index,
    });
    expect(mine).toEqual({
      status: "rejected",
      rejection: { type: "undo_target_changed", expected: pull.index, actual: 0 },
    });

    const r = committed(
      await w.ui.request("undo", { target: { type: "human" }, expect_index: pull.index }),
    );
    expect(w.group(r.index)).toMatchObject({
      kind: "undo",
      undoes: pull.index,
      actor: { type: "gm" },
    });
    expect(w.pulls()).toEqual(num(0));
  });

  test("with a newer agent group, human selects the latest gm or character group and leaves the agent's", async () => {
    const w = await world();
    const pull = committed(await w.pullAs(w.ui, "aldric"));
    const scribe = committed(
      await w.agent.transact([create("note", { n: 3 })], {
        label: "Scribe creates note",
        base_revision: w.host.revision,
      }),
    );
    expect(w.group(scribe.index)?.actor).toEqual({ type: "agent", name: "Scribe" });

    const r = committed(
      await w.ui.request("undo", { target: { type: "human" }, expect_index: pull.index }),
    );
    expect(w.group(r.index)?.undoes).toBe(pull.index);
    expect(w.pulls()).toEqual(num(0));
    expect(w.host.table.store.getObject("note")?.cells.n?.content).toEqual(num(3));
    expect(w.host.table.store.history.isUndone(scribe.index)).toBe(false);
  });

  test("a gm transact newer than a character invoke is selected first", async () => {
    const w = await world();
    const pull = committed(await w.pullAs(w.ui, "aldric"));
    const edit = committed(
      await w.ui.transact([create("token", { hp: 5 })], {
        label: "GM creates token",
        base_revision: w.host.revision,
      }),
    );
    const first = committed(await w.ui.request("undo", { target: { type: "human" } }));
    expect(w.group(first.index)?.undoes).toBe(edit.index);
    expect(w.host.table.store.getObject("token")).toBeUndefined();
    expect(w.pulls()).toEqual(num(1));

    // Undo groups are not candidates: the next human undo reaches the invoke.
    const second = committed(await w.ui.request("undo", { target: { type: "human" } }));
    expect(w.group(second.index)?.undoes).toBe(pull.index);
    expect(w.pulls()).toEqual(num(0));
  });

  test("expect_index with human is refused undo_target_changed when a newer gm group exists", async () => {
    const w = await world();
    const pull = committed(await w.pullAs(w.ui, "aldric"));
    const edit = committed(
      await w.ui.transact([create("token", { hp: 5 })], {
        label: "GM creates token",
        base_revision: w.host.revision,
      }),
    );
    const revision = w.host.revision;
    const r = await w.ui.request("undo", { target: { type: "human" }, expect_index: pull.index });
    expect(r).toEqual({
      status: "rejected",
      rejection: { type: "undo_target_changed", expected: pull.index, actual: edit.index },
    });
    expect(w.host.revision).toBe(revision);
    expect(w.pulls()).toEqual(num(1));
  });

  test("human means the same from an agent connection: it never selects agent groups", async () => {
    const w = await world();
    const pull = committed(await w.pullAs(w.ui, "aldric"));
    committed(
      await w.agent.transact([create("note", { n: 3 })], {
        label: "Scribe creates note",
        base_revision: w.host.revision,
      }),
    );
    const r = committed(await w.agent.request("undo", { target: { type: "human" } }));
    expect(w.group(r.index)).toMatchObject({
      undoes: pull.index,
      actor: { type: "agent", name: "Scribe" },
    });
  });

  test("with only agent groups since the barrier, human is nothing_to_undo", async () => {
    const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
    const { server } = await serve({ host });
    const ui = await connect(server, { client: { name: "GM", kind: "ui" } });
    const agent = await connect(server, { client: { name: "Scribe", kind: "agent" } });
    committed(await agent.transact([create("note")], { base_revision: 0 }));
    expect(await ui.request("undo", { target: { type: "human" } })).toEqual({
      status: "rejected",
      rejection: { type: "nothing_to_undo" },
    });
    expect(await ui.request("undo", { target: { type: "human" }, expect_index: 0 })).toEqual({
      status: "rejected",
      rejection: { type: "undo_target_changed", expected: 0, actual: null },
    });
  });
});

describe("the undo params schema", () => {
  test("round-trips target human, with expect_index and label", () => {
    for (const params of [
      { target: { type: "human" } },
      { target: { type: "human" }, expect_index: 4, label: "Undo pull" },
    ]) {
      expect(UndoParamsSchema.parse(params)).toEqual(params);
      expect(UndoParamsSchema.parse(JSON.parse(JSON.stringify(params)))).toEqual(params);
    }
  });

  test("human is strict: extra keys are refused", () => {
    expect(UndoParamsSchema.safeParse({ target: { type: "human", id: "aldric" } }).success).toBe(
      false,
    );
  });

  test("the existing targets still parse", () => {
    for (const target of [
      { type: "latest" },
      { type: "mine" },
      { type: "actor", actor: { type: "gm" } },
      { type: "group", index: 2 },
    ]) {
      expect(UndoParamsSchema.parse({ target })).toEqual({ target });
    }
  });
});
