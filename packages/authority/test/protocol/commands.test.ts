/**
 * Command execution (vtt-5su.5): `transact` and `undo` over a Table, with
 * bindings, stale-write refusals and deduplication (PROTOCOL.md §3–§6).
 */
import {
  type CommandContext,
  compactLog,
  declaredKeys,
  executeTransact,
  executeUndo,
  ScriptedDiceSource,
  Table,
  TxnCache,
  writeValue,
} from "@vtt/authority";
import {
  ProtocolFailure,
  type TransactParams,
  type TransactResult,
  type WireOp,
} from "@vtt/protocol";
import { type Actor, list, num, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, c, commit, f, obj, placed, snapshot } from "../engine/helpers";

const GM: Actor = { type: "gm" };
const AGENT: Actor = { type: "agent", name: "claude" };

/**
 * Revision 5. Board `table` (and empty board `shelf`): `goblin1` (hp 7,
 * ac 12, bonus formula overridden), `aldric` (a character), `bag` holding
 * `coin` then `gem`, empty `chest`, and template `tmpl` holding `tmpl_part`.
 */
function fixture(): Table {
  const s = snapshot(
    [
      placed("goblin1", 0, 0, {
        cells: {
          name: c(text("Goblin")),
          hp: c(num(7)),
          ac: c(num(12)),
          notes: c(text("grumpy")),
          bonus: { content: { type: "formula", source: "1" }, override: num(3) },
        },
      }),
      placed("aldric", 1, 0, { is_character: true, cells: { name: c(text("Aldric")) } }),
      placed("bag", 2, 0, { contents: ["coin", "gem"] }),
      obj("coin", { cells: { value: c(num(1)) } }),
      obj("gem", { cells: { value: c(num(50)) } }),
      placed("chest", 3, 0),
      placed("tmpl", 9, 9, {
        is_template: true,
        contents: ["tmpl_part"],
        cells: { hp: f("5"), part: c(ref("tmpl_part")) },
      }),
      obj("tmpl_part", { cells: { owner_of: c(ref("tmpl")) } }),
    ],
    ["table", "shelf"],
  );
  return Table.fromSnapshot({ ...s, revision: 5, next_seq: 1 });
}

function context(table: Table, over: Partial<CommandContext> = {}): CommandContext {
  return {
    table,
    actor: GM,
    kind: "ui",
    client: "ui-1",
    dice: new ScriptedDiceSource([]),
    txns: new TxnCache(),
    ...over,
  };
}

function agentContext(table: Table, over: Partial<CommandContext> = {}): CommandContext {
  return context(table, { actor: AGENT, kind: "agent", client: "agent-1", ...over });
}

const params = (
  base: number,
  ops: WireOp[],
  rest: Partial<TransactParams> = {},
): TransactParams => ({
  base_revision: base,
  ops,
  ...rest,
});

type Committed = Extract<TransactResult, { status: "committed" }>;
type Refused = Extract<TransactResult, { status: "rejected" }>;

function committed(r: TransactResult): Committed {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Committed;
}

function refused(r: TransactResult): Refused {
  expect(r.status, JSON.stringify(r)).toBe("rejected");
  return r as Refused;
}

/** Runs `ops` at the current revision as the GM and expects a commit. */
function run(table: Table, ops: WireOp[]): Committed {
  return committed(executeTransact(context(table), params(table.store.revision, ops)));
}

function failure(fn: () => unknown): ProtocolFailure {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolFailure);
    return err as ProtocolFailure;
  }
  throw new Error("expected a ProtocolFailure");
}

const setHp = (object: string, value: number): WireOp => ({
  type: "set_value",
  object,
  cell: "hp",
  value: num(value),
});

const groups = (t: Table) => t.store.history.groups().length;

describe("each op kind commits with its M2 effect", () => {
  test("set_value", () => {
    const t = fixture();
    const r = run(t, [setHp("goblin1", 4)]);
    expect(r).toEqual({
      status: "committed",
      revision: 6,
      index: 0,
      created: [],
      copies: [],
      bindings: {},
    });
    expect(t.store.getCell("goblin1", "hp")).toEqual(c(num(4)));
    expect(t.store.history.get(0)?.label).toBe("set_value goblin1.hp");
  });

  test("set_formula", () => {
    const t = fixture();
    run(t, [{ type: "set_formula", object: "goblin1", cell: "hp", source: "2 + 3" }]);
    expect(t.store.getCell("goblin1", "hp")).toEqual(f("2 + 3"));
  });

  test("clear_override", () => {
    const t = fixture();
    run(t, [{ type: "clear_override", object: "goblin1", cell: "bonus" }]);
    expect(t.store.getCell("goblin1", "bonus")).toEqual(f("1"));
  });

  test("delete_cell", () => {
    const t = fixture();
    run(t, [{ type: "delete_cell", object: "goblin1", cell: "notes" }]);
    expect(t.store.getCell("goblin1", "notes")).toBeUndefined();
  });

  test("rename_cell", () => {
    const t = fixture();
    run(t, [{ type: "rename_cell", object: "goblin1", from: "notes", to: "mood" }]);
    expect(t.store.getCell("goblin1", "notes")).toBeUndefined();
    expect(t.store.getCell("goblin1", "mood")).toEqual(c(text("grumpy")));
  });

  test("set_cell_visibility", () => {
    const t = fixture();
    run(t, [
      {
        type: "set_cell_visibility",
        object: "goblin1",
        cell: "hp",
        viewers: { type: "viewers", viewers: ["gm", { type: "ref", object: "aldric" }] },
      },
    ]);
    expect(t.store.getCellVisibility("goblin1", "hp")).toEqual({
      type: "viewers",
      viewers: ["gm", ref("aldric")],
    });
  });

  test("set_tag", () => {
    const t = fixture();
    run(t, [{ type: "set_tag", object: "goblin1", tags: ["creature", "evil"] }]);
    expect(t.store.getObject("goblin1")?.tag).toEqual(["creature", "evil"]);
  });

  test("set_shape", () => {
    const t = fixture();
    run(t, [{ type: "set_shape", object: "goblin1", shape: { type: "circle", radius: 2 } }]);
    expect(t.store.getObject("goblin1")?.shape).toEqual({ type: "circle", radius: 2 });
  });

  test("set_template_flag", () => {
    const t = fixture();
    run(t, [{ type: "set_template_flag", object: "goblin1", value: true }]);
    expect(t.store.getObject("goblin1")?.is_template).toBe(true);
  });

  test("set_character_flag", () => {
    const t = fixture();
    run(t, [{ type: "set_character_flag", object: "aldric", value: false }]);
    expect(t.store.getObject("aldric")?.is_character).toBe(false);
  });

  test("set_actions", () => {
    const t = fixture();
    const actions = [{ name: "attack", steps: ["roll(this.dmg)"] }];
    run(t, [{ type: "set_actions", object: "goblin1", actions }]);
    expect(t.store.getObject("goblin1")?.actions).toEqual(actions);
  });

  test("reorder", () => {
    const t = fixture();
    run(t, [{ type: "reorder", container: "bag", permutation: [1, 0] }]);
    expect(t.store.contentsOf("bag")).toEqual(["gem", "coin"]);
  });

  test("add_board", () => {
    const t = fixture();
    run(t, [{ type: "add_board", id: "cave", name: "Cave" }]);
    expect(t.store.getBoard("cave")).toEqual({ id: "cave", name: "Cave" });
  });

  test("rename_board", () => {
    const t = fixture();
    run(t, [{ type: "rename_board", id: "table", name: "Main" }]);
    expect(t.store.getBoard("table")).toEqual({ id: "table", name: "Main" });
  });

  test("remove_board", () => {
    const t = fixture();
    run(t, [{ type: "remove_board", id: "shelf" }]);
    expect(t.store.getBoard("shelf")).toBeUndefined();
  });

  test("create_object", () => {
    const t = fixture();
    const r = run(t, [
      {
        type: "create_object",
        id: "lamp",
        to: { type: "board", board: "table", position: [3, 4] },
        init: { tag: ["light"], cells: { name: text("Lamp") } },
      },
    ]);
    expect(r.created).toEqual([{ op_index: 0, id: "lamp" }]);
    const lamp = t.store.getObject("lamp");
    expect(lamp?.board).toBe("table");
    expect(lamp?.tag).toEqual(["light"]);
    expect(lamp?.cells.name).toEqual(c(text("Lamp")));
    expect(lamp?.cells.position).toEqual(at(3, 4));
  });

  test("create_object without an id allocates one", () => {
    const t = fixture();
    const r = run(t, [
      { type: "create_object", to: { type: "container", container: "chest" }, as: "$box" },
    ]);
    expect(r.created).toEqual([{ op_index: 0, id: "obj_1" }]);
    expect(r.bindings).toEqual({ $box: "obj_1" });
    expect(t.store.contentsOf("chest")).toEqual(["obj_1"]);
  });

  test("spawn", () => {
    const t = fixture();
    const r = run(t, [
      {
        type: "spawn",
        template: "tmpl",
        to: { type: "board", board: "table", position: [1, 1] },
        cells: { hp: num(9) },
      },
    ]);
    expect(r.copies).toEqual([
      { op_index: 0, root: "tmpl_1", copies: { tmpl: "tmpl_1", tmpl_part: "tmpl_part_2" } },
    ]);
    expect(t.store.getObject("tmpl_1")?.board).toBe("table");
    expect(t.store.getCell("tmpl_1", "hp")).toEqual(c(num(9)));
    expect(t.store.contentsOf("tmpl_1")).toEqual(["tmpl_part_2"]);
  });

  test("move", () => {
    const t = fixture();
    run(t, [{ type: "move", object: "coin", to: { type: "container", container: "chest" } }]);
    expect(t.store.contentsOf("bag")).toEqual(["gem"]);
    expect(t.store.contentsOf("chest")).toEqual(["coin"]);
  });

  test("remove", () => {
    const t = fixture();
    run(t, [{ type: "remove", object: "gem" }]);
    expect(t.store.hasObject("gem")).toBe(false);
    expect(t.store.contentsOf("bag")).toEqual(["coin"]);
  });

  test("a batch gets the label '<n> edits' and one group", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 1), setHp("aldric", 2)]);
    expect(groups(t)).toBe(1);
    expect(t.store.history.get(0)?.label).toBe("2 edits");
  });

  test("an explicit label is used", () => {
    const t = fixture();
    executeTransact(context(t), params(5, [setHp("goblin1", 1)], { label: "ouch" }));
    expect(t.store.history.get(0)?.label).toBe("ouch");
  });
});

describe("declaredKeys", () => {
  const board = { type: "board" as const, board: "table", position: [0, 0] as [number, number] };
  const into = (container: string) => ({ type: "container" as const, container });
  const cases: [WireOp, string[]][] = [
    [{ type: "set_value", object: "a", cell: "hp", value: num(1) }, ["cell:a/hp"]],
    [{ type: "set_formula", object: "a", cell: "hp", source: "1" }, ["cell:a/hp"]],
    [{ type: "clear_override", object: "a", cell: "hp" }, ["cell:a/hp"]],
    [{ type: "delete_cell", object: "a", cell: "hp" }, ["cell:a/hp"]],
    [{ type: "rename_cell", object: "a", from: "x", to: "y" }, ["cell:a/x", "cell:a/y"]],
    [{ type: "set_cell_visibility", object: "a", cell: "hp", viewers: null }, ["cell:a/hp"]],
    [{ type: "set_tag", object: "a", tags: [] }, ["cell:a/tag"]],
    [{ type: "set_shape", object: "a", shape: null }, ["cell:a/shape"]],
    [{ type: "set_template_flag", object: "a", value: true }, ["cell:a/is_template"]],
    [{ type: "set_character_flag", object: "a", value: true }, ["cell:a/is_character"]],
    [{ type: "set_actions", object: "a", actions: [] }, ["actions:a"]],
    [{ type: "reorder", container: "a", permutation: [] }, ["cell:a/contents"]],
    [{ type: "add_board", id: "m" }, ["board:m"]],
    [{ type: "rename_board", id: "m", name: "M" }, ["board:m"]],
    [{ type: "remove_board", id: "m" }, ["board:m"]],
    [{ type: "create_object", id: "a", to: board }, ["obj:a", "board:table"]],
    [{ type: "create_object", to: into("box") }, ["cell:box/contents"]],
    [{ type: "create_object", as: "$a", to: into("$box") }, []],
    [{ type: "spawn", template: "t", to: board }, ["obj:t", "board:table"]],
    [{ type: "spawn", template: "t", to: into("$box") }, ["obj:t"]],
    [
      { type: "move", object: "a", to: into("box") },
      ["cell:a/board", "cell:a/position", "cell:box/contents"],
    ],
    [{ type: "move", object: "$a", to: board }, ["board:table"]],
    [{ type: "remove", object: "a" }, ["obj:a"]],
    [{ type: "set_value", object: "$a", cell: "hp", value: num(1) }, []],
  ];
  test.each(cases)("%j", (op, keys) => {
    expect(declaredKeys(op)).toEqual(keys);
  });
});

describe("bindings", () => {
  test("a card, a zone in its contents and a ref to the zone commit as one group", () => {
    const t = fixture();
    const r = run(t, [
      {
        type: "create_object",
        id: "fb_aldric",
        as: "$card",
        to: { type: "board", board: "table", position: [5, 5] },
      },
      {
        type: "create_object",
        as: "$zone",
        to: { type: "container", container: "$card" },
        init: { is_zone: true, shape: { type: "rect", width: 2, height: 2 } },
      },
      {
        type: "set_value",
        object: "fb_aldric",
        cell: "zone",
        value: { type: "ref", object: "$zone" },
      },
    ]);
    expect(groups(t)).toBe(1);
    expect(r.created).toEqual([
      { op_index: 0, id: "fb_aldric" },
      { op_index: 1, id: "obj_1" },
    ]);
    expect(r.bindings).toEqual({ $card: "fb_aldric", $zone: "obj_1" });
    expect(t.store.contentsOf("fb_aldric")).toEqual(["obj_1"]);
    expect(t.store.getCell("fb_aldric", "zone")).toEqual(c(ref("obj_1")));
  });

  test("bindings resolve inside lists and viewers entries", () => {
    const t = fixture();
    run(t, [
      { type: "create_object", as: "$a", to: { type: "container", container: "chest" } },
      {
        type: "set_value",
        object: "goblin1",
        cell: "friends",
        value: { type: "list", items: [{ type: "list", items: [{ type: "ref", object: "$a" }] }] },
      },
      {
        type: "set_cell_visibility",
        object: "$a",
        cell: "hp",
        viewers: { type: "viewers", viewers: ["gm", { type: "ref", object: "$a" }] },
      },
    ]);
    expect(t.store.getCell("goblin1", "friends")).toEqual(c(list([list([ref("obj_1")])])));
    expect(t.store.getCellVisibility("obj_1", "hp")).toEqual({
      type: "viewers",
      viewers: ["gm", ref("obj_1")],
    });
  });

  test("spawn with owned returns bindings for the root and the owned copies", () => {
    const t = fixture();
    const r = run(t, [
      {
        type: "spawn",
        template: "tmpl",
        to: { type: "container", container: "chest" },
        as: "$root",
        owned: { tmpl_part: "$part" },
      },
      { type: "set_value", object: "$part", cell: "hp", value: { type: "ref", object: "$root" } },
    ]);
    expect(r.bindings).toEqual({ $root: "tmpl_1", $part: "tmpl_part_2" });
    expect(t.store.getCell("tmpl_part_2", "hp")).toEqual(c(ref("tmpl_1")));
  });

  test("an owned id outside the template's subtree is rejected at the spawn", () => {
    const t = fixture();
    const r = refused(
      executeTransact(
        context(t),
        params(5, [
          setHp("goblin1", 1),
          {
            type: "spawn",
            template: "tmpl",
            to: { type: "container", container: "chest" },
            owned: { coin: "$c" },
          },
        ]),
      ),
    );
    expect(r.rejection.type).toBe("invalid");
    expect(r.op_index).toBe(1);
    expect(groups(t)).toBe(0);
  });

  test("a use before introduction is bad_request with no group", () => {
    const t = fixture();
    const e = failure(() =>
      executeTransact(
        context(t),
        params(5, [
          { type: "set_value", object: "goblin1", cell: "x", value: { type: "ref", object: "$z" } },
          { type: "create_object", as: "$z", to: { type: "container", container: "chest" } },
        ]),
      ),
    );
    expect(e.error.code).toBe("bad_request");
    expect(groups(t)).toBe(0);
  });

  test("a use in the introducing op itself is bad_request", () => {
    const t = fixture();
    const e = failure(() =>
      executeTransact(
        context(t),
        params(5, [
          { type: "create_object", as: "$z", to: { type: "container", container: "$z" } },
        ]),
      ),
    );
    expect(e.error.code).toBe("bad_request");
  });

  test("a duplicate binding is bad_request with no group", () => {
    const t = fixture();
    const box = { type: "container" as const, container: "chest" };
    const e = failure(() =>
      executeTransact(
        context(t),
        params(5, [
          { type: "create_object", as: "$z", to: box },
          { type: "spawn", template: "tmpl", to: box, owned: { tmpl_part: "$z" } },
        ]),
      ),
    );
    expect(e.error.code).toBe("bad_request");
    expect(groups(t)).toBe(0);
  });
});

describe("validation", () => {
  test("base_revision above current is bad_request with no group", () => {
    const t = fixture();
    const e = failure(() => executeTransact(context(t), params(6, [setHp("goblin1", 1)])));
    expect(e.error.code).toBe("bad_request");
    expect(groups(t)).toBe(0);
  });

  test("an agent context passing actor is bad_request", () => {
    const t = fixture();
    const e = failure(() =>
      executeTransact(
        agentContext(t),
        params(5, [setHp("goblin1", 1)], { actor: { type: "character", id: "aldric" } }),
      ),
    );
    expect(e.error.code).toBe("bad_request");
  });

  test("actor naming a non-character is bad_request", () => {
    const t = fixture();
    const e = failure(() =>
      executeTransact(
        context(t),
        params(5, [setHp("goblin1", 1)], { actor: { type: "character", id: "goblin1" } }),
      ),
    );
    expect(e.error.code).toBe("bad_request");
  });

  test("retry without txn_id is bad_request", () => {
    const t = fixture();
    const e = failure(() =>
      executeTransact(context(t), params(5, [setHp("goblin1", 1)], { retry: true })),
    );
    expect(e.error.code).toBe("bad_request");
  });

  test("a label over 200 characters is bad_request", () => {
    const t = fixture();
    const e = failure(() =>
      executeTransact(context(t), params(5, [setHp("goblin1", 1)], { label: "x".repeat(201) })),
    );
    expect(e.error.code).toBe("bad_request");
  });

  test("a UI context acting as Aldric records his actor", () => {
    const t = fixture();
    committed(
      executeTransact(
        context(t),
        params(5, [setHp("goblin1", 1)], { actor: { type: "character", id: "aldric" } }),
      ),
    );
    expect(t.store.history.get(0)?.actor).toEqual({ type: "character", id: "aldric" });
  });

  test("the agent's own actor is recorded", () => {
    const t = fixture();
    committed(executeTransact(agentContext(t), params(5, [setHp("goblin1", 1)])));
    expect(t.store.history.get(0)?.actor).toEqual(AGENT);
  });
});

describe("primitive refusals", () => {
  test("a protected write in the second of three ops is rejected at op 1 with nothing applied", () => {
    const t = fixture();
    const r = refused(
      executeTransact(
        context(t),
        params(5, [
          setHp("goblin1", 1),
          { type: "set_value", object: "goblin1", cell: "id", value: text("x") },
          setHp("aldric", 2),
        ]),
      ),
    );
    expect(r).toEqual({
      status: "rejected",
      rejection: { type: "protected_cell", object: "goblin1", cell: "id" },
      op_index: 1,
    });
    expect(t.store.getCell("goblin1", "hp")).toEqual(c(num(7)));
    expect(t.store.revision).toBe(5);
    expect(groups(t)).toBe(0);
  });

  test("an id that never existed at the current base is invalid with op_index, not not_found", () => {
    const t = fixture();
    const r = refused(executeTransact(context(t), params(5, [setHp("ghost", 1)])));
    expect(r.rejection.type).toBe("invalid");
    expect(r.op_index).toBe(0);
  });
});

describe("stale writes", () => {
  /** The GM writes goblin1.hp, taking revision 5 to 6. */
  function afterGmWrite(): Table {
    const t = fixture();
    run(t, [setHp("goblin1", 3)]);
    expect(t.store.revision).toBe(6);
    return t;
  }

  test("a stale write to the same cell names the intervening group and key", () => {
    const t = afterGmWrite();
    const r = refused(executeTransact(agentContext(t), params(5, [setHp("goblin1", 9)])));
    expect(r).toEqual({
      status: "rejected",
      rejection: {
        type: "stale_write",
        base_revision: 5,
        revision: 6,
        floor: 5,
        truncated: false,
        conflicts: [
          {
            index: 0,
            revision: 6,
            actor: GM,
            label: "set_value goblin1.hp",
            keys: ["cell:goblin1/hp"],
          },
        ],
      },
    });
    expect(t.store.getCell("goblin1", "hp")).toEqual(c(num(3)));
    expect(groups(t)).toBe(1);
  });

  test("a stale write to a disjoint cell commits", () => {
    const t = afterGmWrite();
    const r = committed(
      executeTransact(
        agentContext(t),
        params(5, [{ type: "set_value", object: "goblin1", cell: "ac", value: num(14) }]),
      ),
    );
    expect(r.revision).toBe(7);
    expect(t.store.getCell("goblin1", "ac")).toEqual(c(num(14)));
  });

  test("a stale move into a container conflicts with an intervening reorder of it", () => {
    const t = fixture();
    run(t, [{ type: "reorder", container: "bag", permutation: [1, 0] }]);
    const r = refused(
      executeTransact(
        agentContext(t),
        params(5, [
          { type: "move", object: "goblin1", to: { type: "container", container: "bag" } },
        ]),
      ),
    );
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ index: 0, keys: ["cell:bag/contents"] }],
    });
    expect(r.op_index).toBeUndefined();
  });

  test("a stale set_value on an object removed since names the removal's obj key", () => {
    const t = fixture();
    run(t, [{ type: "remove", object: "goblin1" }]);
    const r = refused(executeTransact(agentContext(t), params(5, [setHp("goblin1", 1)])));
    expect(r.op_index).toBeUndefined();
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ index: 0, keys: ["obj:goblin1"] }],
    });
  });

  test("a stale move into a container removed since is stale_write", () => {
    const t = fixture();
    run(t, [{ type: "remove", object: "chest" }]);
    const r = refused(
      executeTransact(
        agentContext(t),
        params(5, [
          { type: "move", object: "goblin1", to: { type: "container", container: "chest" } },
        ]),
      ),
    );
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ index: 0, keys: ["obj:chest"] }],
    });
  });

  test("a stale create_object onto a board removed since is stale_write", () => {
    const t = fixture();
    run(t, [{ type: "remove_board", id: "shelf" }]);
    const r = refused(
      executeTransact(
        agentContext(t),
        params(5, [
          { type: "create_object", to: { type: "board", board: "shelf", position: [0, 0] } },
        ]),
      ),
    );
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ index: 0, keys: ["board:shelf"] }],
    });
  });

  test("disjoint declared keys but conflicting effects are stale_write with nothing applied", () => {
    const t = fixture();
    run(t, [{ type: "reorder", container: "bag", permutation: [1, 0] }]);
    const dice = new ScriptedDiceSource([
      { type: "roll", expr: "1d6", dice: [4], dropped: [], total: 4 },
    ]);
    const op: WireOp = {
      type: "move",
      object: "coin",
      to: { type: "container", container: "chest" },
    };
    expect(declaredKeys(op)).not.toContain("cell:bag/contents");
    const r = refused(executeTransact(agentContext(t, { dice }), params(5, [op])));
    expect(r.op_index).toBeUndefined();
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      truncated: false,
      conflicts: [{ index: 0, keys: ["cell:bag/contents"] }],
    });
    expect(t.store.contentsOf("bag")).toEqual(["gem", "coin"]);
    expect(t.store.contentsOf("chest")).toEqual([]);
    expect(groups(t)).toBe(1);
    expect(dice.remaining()).toBe(1);
    expect(t.store.openTransaction).toBeNull();
  });

  test("a stale write still conflicts with an undo group", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 3)]);
    committed(executeUndo(context(t), { target: { type: "latest" } }));
    const r = refused(executeTransact(agentContext(t), params(6, [setHp("goblin1", 9)])));
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ index: 1, keys: ["cell:goblin1/hp"] }],
    });
  });

  test("a base older than the oldest retained group after compaction is truncated", () => {
    const t = fixture();
    for (let i = 0; i < 3; i++) run(t, [setHp("aldric", i)]);
    compactLog(t.store, 1);
    const r = refused(executeTransact(agentContext(t), params(6, [setHp("goblin1", 1)])));
    expect(r.rejection).toEqual({
      type: "stale_write",
      base_revision: 6,
      revision: 8,
      floor: 7,
      truncated: true,
      conflicts: [],
    });
    committed(executeTransact(agentContext(t), params(7, [setHp("goblin1", 1)])));
  });

  test("with zero retained groups any base below current is truncated", () => {
    const t = fixture();
    const r = refused(executeTransact(agentContext(t), params(4, [setHp("goblin1", 1)])));
    expect(r.rejection).toEqual({
      type: "stale_write",
      base_revision: 4,
      revision: 5,
      floor: 5,
      truncated: true,
      conflicts: [],
    });
  });
});

describe("deduplication", () => {
  test("the same txn_id twice from one client returns the identical result and one group", () => {
    const t = fixture();
    const ctx = context(t);
    const p = params(5, [setHp("goblin1", 1)], { txn_id: "t1" });
    const first = executeTransact(ctx, p);
    const again = executeTransact(ctx, { ...p, retry: true });
    expect(again).toEqual(first);
    expect(executeTransact(ctx, p)).toEqual(first);
    expect(groups(t)).toBe(1);
  });

  test("a stored rejection is returned again", () => {
    const t = fixture();
    const ctx = context(t);
    const p = params(5, [setHp("ghost", 1)], { txn_id: "t1" });
    const first = refused(executeTransact(ctx, p));
    expect(executeTransact(ctx, p)).toEqual(first);
  });

  test("the same txn_id from another client instance executes separately", () => {
    const t = fixture();
    const txns = new TxnCache();
    const a = executeTransact(
      context(t, { txns, client: "a" }),
      params(5, [setHp("goblin1", 1)], { txn_id: "t1" }),
    );
    const b = executeTransact(
      context(t, { txns, client: "b" }),
      params(6, [setHp("goblin1", 1)], { txn_id: "t1" }),
    );
    expect(committed(a).revision).toBe(6);
    expect(committed(b).revision).toBe(7);
    expect(groups(t)).toBe(2);
  });

  test("the same txn_id with different ops is rejected invalid and appends nothing", () => {
    const t = fixture();
    const ctx = context(t);
    executeTransact(ctx, params(5, [setHp("goblin1", 1)], { txn_id: "t1" }));
    const r = executeTransact(ctx, params(5, [setHp("goblin1", 2)], { txn_id: "t1" }));
    expect(r).toEqual({
      status: "rejected",
      rejection: { type: "invalid", message: "txn_id reused with different params" },
    });
    expect(groups(t)).toBe(1);
    expect(t.store.getCell("goblin1", "hp")).toEqual(c(num(1)));
  });

  test("the fingerprint ignores key order", () => {
    const t = fixture();
    const ctx = context(t);
    const first = executeTransact(ctx, {
      base_revision: 5,
      txn_id: "t1",
      ops: [{ type: "set_value", object: "goblin1", cell: "hp", value: num(1) }],
    });
    const again = executeTransact(ctx, {
      txn_id: "t1",
      ops: [
        { value: { value: 1, type: "number" }, cell: "hp", object: "goblin1", type: "set_value" },
      ],
      base_revision: 5,
    } as TransactParams);
    expect(again).toEqual(first);
  });

  test("an identical retry gets the stored result after its actor stops being valid", () => {
    const t = fixture();
    const ctx = context(t);
    const p = params(5, [setHp("goblin1", 1)], {
      txn_id: "t1",
      actor: { type: "character", id: "aldric" },
    });
    const first = committed(executeTransact(ctx, p));
    run(t, [{ type: "remove", object: "aldric" }]);
    expect(executeTransact(ctx, { ...p, retry: true })).toEqual(first);
    const e = failure(() => executeTransact(ctx, { ...p, txn_id: "t2" }));
    expect(e.error.code).toBe("bad_request");
  });

  test("an identical retry after the actor's is_character is cleared also gets the stored result", () => {
    const t = fixture();
    const ctx = context(t);
    const p = params(5, [setHp("goblin1", 1)], {
      txn_id: "t1",
      actor: { type: "character", id: "aldric" },
    });
    const first = executeTransact(ctx, p);
    run(t, [{ type: "set_character_flag", object: "aldric", value: false }]);
    expect(executeTransact(ctx, p)).toEqual(first);
  });

  test("a retry whose key is not retained is retry_unknown and appends nothing", () => {
    const t = fixture();
    const e = failure(() =>
      executeTransact(context(t), params(5, [setHp("goblin1", 1)], { txn_id: "x", retry: true })),
    );
    expect(e.error.code).toBe("retry_unknown");
    expect(groups(t)).toBe(0);
  });

  test("after 1,001 further transactions the first is evicted; another client keeps its entry", () => {
    const t = fixture();
    const txns = new TxnCache();
    const ctx = context(t, { txns, client: "busy" });
    const other = context(t, { txns, client: "other" });
    const keptParams = params(5, [setHp("aldric", 1)], { txn_id: "first" });
    const kept = committed(executeTransact(other, keptParams));
    const first = params(6, [setHp("goblin1", 1)], { txn_id: "first" });
    committed(executeTransact(ctx, first));
    const sent: { p: TransactParams; r: TransactResult }[] = [];
    for (let i = 0; i < 1001; i++) {
      const op: WireOp = { type: "set_value", object: "goblin1", cell: "n", value: num(i) };
      const p = params(t.store.revision, [op], { txn_id: `n${i}` });
      sent.push({ p, r: committed(executeTransact(ctx, p)) });
    }
    const before = groups(t);
    expect(before).toBe(1003);
    const e = failure(() => executeTransact(ctx, { ...first, retry: true }));
    expect(e.error.code).toBe("retry_unknown");
    expect(groups(t)).toBe(before);
    expect(executeTransact(other, { ...keptParams, retry: true })).toEqual(kept);
    // A retained entry is still answered from the store, without executing.
    const last = sent[1000];
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(executeTransact(ctx, { ...last.p, retry: true })).toEqual(last.r);
    expect(groups(t)).toBe(before);
  });
});

describe("TxnCache", () => {
  test("evicts a client's oldest entry beyond its limit without touching another client", () => {
    const cache = new TxnCache(2);
    const r: TransactResult = {
      status: "rejected",
      rejection: { type: "invalid", message: "x" },
    };
    cache.store("a", "1", "f1", r);
    cache.store("b", "1", "f1", r);
    cache.store("a", "2", "f2", r);
    cache.store("a", "3", "f3", r);
    expect(cache.lookup("a", "1", "f1")).toEqual({ type: "miss" });
    expect(cache.lookup("a", "2", "f2")).toEqual({ type: "hit", result: r });
    expect(cache.lookup("a", "3", "fx")).toEqual({ type: "mismatch" });
    expect(cache.lookup("b", "1", "f1")).toEqual({ type: "hit", result: r });
  });

  test("defaults to max_txn_ids_per_client", () => {
    const cache = new TxnCache();
    const r: TransactResult = { status: "rejected", rejection: { type: "nothing_to_undo" } };
    for (let i = 0; i <= 1000; i++) cache.store("a", `${i}`, "f", r);
    expect(cache.lookup("a", "0", "f")).toEqual({ type: "miss" });
    expect(cache.lookup("a", "1", "f").type).toBe("hit");
  });
});

describe("undo", () => {
  test("undo mine by the agent skips a later GM group", () => {
    const t = fixture();
    const ctx = agentContext(t);
    committed(
      executeTransact(
        ctx,
        params(5, [{ type: "set_value", object: "goblin1", cell: "ac", value: num(1) }]),
      ),
    );
    run(t, [setHp("goblin1", 2)]);
    const r = committed(executeUndo(ctx, { target: { type: "mine" } }));
    expect(r).toEqual({
      status: "committed",
      revision: 8,
      index: 2,
      created: [],
      copies: [],
      bindings: {},
    });
    const g = t.store.history.get(2);
    expect(g?.undoes).toBe(0);
    expect(g?.actor).toEqual(AGENT);
    expect(t.store.getCell("goblin1", "ac")).toEqual(c(num(12)));
    expect(t.store.getCell("goblin1", "hp")).toEqual(c(num(2)));
  });

  test("an expect_index mismatch is undo_target_changed", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 1)]);
    run(t, [setHp("aldric", 1)]);
    const r = refused(executeUndo(context(t), { target: { type: "latest" }, expect_index: 0 }));
    expect(r.rejection).toEqual({ type: "undo_target_changed", expected: 0, actual: 1 });
    expect(groups(t)).toBe(2);
  });

  test("expect_index with nothing to undo is undo_target_changed with actual null", () => {
    const t = fixture();
    const r = refused(executeUndo(context(t), { target: { type: "latest" }, expect_index: 0 }));
    expect(r.rejection).toEqual({ type: "undo_target_changed", expected: 0, actual: null });
  });

  test("a matching expect_index undoes", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 1)]);
    committed(executeUndo(context(t), { target: { type: "group", index: 0 }, expect_index: 0 }));
    expect(t.store.getCell("goblin1", "hp")).toEqual(c(num(7)));
  });

  test("nothing to undo is a rejection", () => {
    const t = fixture();
    expect(executeUndo(context(t), { target: { type: "latest" } })).toEqual({
      status: "rejected",
      rejection: { type: "nothing_to_undo" },
    });
  });

  test("an undo conflict is a rejection", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 1)]);
    run(t, [setHp("goblin1", 2)]);
    const r = refused(executeUndo(context(t), { target: { type: "group", index: 0 } }));
    expect(r.rejection.type).toBe("undo_conflict");
  });

  test("an undo with a label labels its group with it", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 1)]);
    committed(executeUndo(context(t), { target: { type: "latest" }, label: "never mind" }));
    expect(t.store.history.get(1)?.label).toBe("never mind");
  });

  test("an undo without a label gets the default", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 1)]);
    committed(executeUndo(context(t), { target: { type: "latest" } }));
    expect(t.store.history.get(1)?.label).toBe("Undo set_value goblin1.hp");
  });

  test("an undo label over 200 characters is bad_request with no group", () => {
    const t = fixture();
    run(t, [setHp("goblin1", 1)]);
    const e = failure(() =>
      executeUndo(context(t), { target: { type: "latest" }, label: "x".repeat(201) }),
    );
    expect(e.error.code).toBe("bad_request");
    expect(groups(t)).toBe(1);
  });

  test("undo is never stale-checked", () => {
    const t = fixture();
    commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(1)));
    compactLog(t.store, 0);
    run(t, [setHp("goblin1", 2)]);
    committed(executeUndo(context(t), { target: { type: "latest" } }));
  });
});
