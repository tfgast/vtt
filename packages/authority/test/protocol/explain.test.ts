/**
 * Explain methods (vtt-5su.16; PROTOCOL.md §9, §7.6; DESIGN.md §5.2, §4.4;
 * FORMULAS.md §7, §9; M3-D16): explain_cell, explain_group, explain_action.
 * Every result is checked against its `@vtt/protocol` result schema.
 */
import {
  explainAction,
  explainCell,
  explainGroup,
  move,
  remove,
  setFormula,
  setTag,
  Table,
  writeValue,
} from "@vtt/authority";
import {
  type DepNode,
  type ExplainActionResult,
  ExplainActionResultSchema,
  type ExplainCellResult,
  ExplainCellResultSchema,
  ExplainGroupResultSchema,
  LIMITS,
  ProtocolFailure,
} from "@vtt/protocol";
import { list, num, ref, text, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, commit, f, gm, placed, snapshot } from "../engine/helpers";
import { loadScenarioFile } from "../runner/load";
import { documentFromSetup } from "../runner/setup";

const ALDRIC = { type: "character", id: "aldric" } as const;
const GM_ONLY: ViewersValue = { type: "viewers", viewers: ["gm"] };

async function fixtureTable(file: string): Promise<Table> {
  const scenario = await loadScenarioFile(file);
  return Table.fromSnapshot(documentFromSetup(scenario.setup));
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

/** The failure as plain data, for deep-equal comparisons. */
function failureData(fn: () => unknown): unknown {
  const e = failure(fn);
  return { name: e.name, message: e.message, error: e.error };
}

const NOT_FOUND = {
  name: "ProtocolFailure",
  message: "not found",
  error: { code: "not_found", message: "not found" },
};

function cell(table: Table, params: Parameters<typeof explainCell>[1]): ExplainCellResult {
  const r = explainCell(table, params);
  expect(ExplainCellResultSchema.parse(r)).toEqual(r);
  return r;
}

function action(table: Table, params: Parameters<typeof explainAction>[1]): ExplainActionResult {
  const r = explainAction(table, params);
  expect(ExplainActionResultSchema.parse(r)).toEqual(r);
  return r;
}

const character = (id: string, x: number) =>
  placed(id, x, -50, { is_character: true, cells: { name: c(text(id)) } });

/** Finds a cell dependency node by object and cell. */
function dep(nodes: readonly DepNode[] | undefined, object: string | null, name: string) {
  return nodes?.find((n) => n.type === "cell" && n.object === object && n.cell === name);
}

/** Counts every node of a dependency tree. */
function countNodes(nodes: readonly DepNode[] | undefined): number {
  let n = 0;
  for (const node of nodes ?? []) {
    n += 1;
    if (node.type === "cell") n += countNodes(node.dependencies);
  }
  return n;
}

describe("explain_cell: dependencies", () => {
  test("hp at depth 1 lists max_hp and damage_taken with values", async () => {
    const t = await fixtureTable("hit-points.json");
    const r = cell(t, { object: "aldric", cell: "hp", depth: 1 });
    expect(r.revision).toBe(0);
    expect(r.object).toBe("aldric");
    expect(r.cell).toBe("hp");
    expect(r.view).toEqual({
      value: num(27),
      kind: "formula",
      source: "max_hp - damage_taken",
      overridden: false,
    });
    expect(r.content).toEqual({
      type: "formula",
      source: "max_hp - damage_taken",
      overridden: false,
      parses: true,
    });
    expect(r.truncated).toBe(false);
    expect(r.error_chain).toBeUndefined();
    expect(dep(r.dependencies, "aldric", "max_hp")).toMatchObject({ value: num(27) });
    expect(dep(r.dependencies, "aldric", "damage_taken")).toMatchObject({ value: num(0) });
    // The default depth is 1.
    expect(cell(t, { object: "aldric", cell: "hp" }).dependencies).toEqual(r.dependencies);
  });

  test("depth 2 over a three-cell chain shows the nested node", () => {
    const t = Table.fromSnapshot(
      snapshot([placed("o", 0, 0, { cells: { a: f("b + 1"), b: f("c * 2"), c: c(num(3)) } })]),
    );
    const one = cell(t, { object: "o", cell: "a", depth: 1 });
    expect(one.view.value).toEqual(num(7));
    expect(one.dependencies).toEqual([{ type: "cell", object: "o", cell: "b", value: num(6) }]);
    const two = cell(t, { object: "o", cell: "a", depth: 2 });
    expect(two.dependencies).toEqual([
      {
        type: "cell",
        object: "o",
        cell: "b",
        value: num(6),
        dependencies: [{ type: "cell", object: "o", cell: "c", value: num(3) }],
      },
    ]);
    expect(two.truncated).toBe(false);
  });

  test("each cell is expanded once", () => {
    const t = Table.fromSnapshot(
      snapshot([
        placed("o", 0, 0, {
          cells: { a: f("b + c"), b: f("d"), c: f("d"), d: f("e"), e: c(num(1)) },
        }),
      ]),
    );
    const r = cell(t, { object: "o", cell: "a", depth: 3 });
    const b = dep(r.dependencies, "o", "b");
    const cNode = dep(r.dependencies, "o", "c");
    const expanded = [b, cNode].map((n) =>
      n?.type === "cell" ? dep(n.dependencies, "o", "d") : undefined,
    );
    // d appears under both b and c, but only the first (breadth first) is expanded.
    const withDeps = expanded.filter((n) => n?.type === "cell" && n.dependencies !== undefined);
    expect(expanded.every((n) => n !== undefined)).toBe(true);
    expect(withDeps).toHaveLength(1);
  });

  test("a cycle back to the root does not expand the root again", () => {
    const t = Table.fromSnapshot(
      snapshot([placed("o", 0, 0, { cells: { a: f("b"), b: f("a") } })]),
    );
    const r = cell(t, { object: "o", cell: "a", depth: 4 });
    expect(countNodes(r.dependencies)).toBeLessThanOrEqual(2);
  });

  test("the dice-tray sum lists an index dependency", async () => {
    const t = await fixtureTable("dice-tray.json");
    const r = cell(t, { object: "tray", cell: "tray_total" });
    expect(r.dependencies).toContainEqual({ type: "index" });
  });

  test("fireball targets: no index node while the zone is inside the card, one on the board", async () => {
    const t = await fixtureTable("fireball.json");
    const inside = cell(t, { object: "fireball", cell: "targets" });
    expect(inside.view.value).toEqual(list([]));
    expect(inside.dependencies.length).toBeGreaterThan(0);
    expect(inside.dependencies.some((n) => n.type === "index")).toBe(false);
    commit(t, (tx) =>
      move(tx, "fireball_zone", { type: "board", board: "map", position: [-100, -100] }),
    );
    const onBoard = cell(t, { object: "fireball", cell: "targets" });
    expect(onBoard.dependencies).toContainEqual({ type: "index" });
  });

  test("at most max_explain_nodes nodes, truncated when cut", () => {
    const n = LIMITS.max_explain_nodes + 50;
    const names = Array.from({ length: n }, (_, i) => `x${i}`);
    const cells = Object.fromEntries(names.map((name) => [name, c(num(1))]));
    const t = Table.fromSnapshot(
      snapshot([
        placed("o", 0, 0, { cells: { ...cells, total: f(`sum([${names.join(", ")}])`) } }),
      ]),
    );
    const r = cell(t, { object: "o", cell: "total" });
    expect(r.truncated).toBe(true);
    expect(countNodes(r.dependencies)).toBe(LIMITS.max_explain_nodes);
  });

  test("a literal and a structural cell have no dependencies", () => {
    const t = Table.fromSnapshot(snapshot([placed("o", 0, 0, { cells: { hp: c(num(4)) } })]));
    const lit = cell(t, { object: "o", cell: "hp" });
    expect(lit.content).toEqual({ type: "literal" });
    expect(lit.dependencies).toEqual([]);
    const structural = cell(t, { object: "o", cell: "board" });
    expect(structural.content).toEqual({ type: "structural" });
    expect(structural.view.kind).toBe("structural");
  });

  test("an unparsable formula reports parses: false and the syntax error", () => {
    const t = Table.fromSnapshot(snapshot([placed("o", 0, 0, { cells: { bad: f("1 +") } })]));
    const r = cell(t, { object: "o", cell: "bad" });
    expect(r.content).toMatchObject({ type: "formula", source: "1 +", parses: false });
    expect(r.content.type === "formula" && typeof r.content.syntax_error).toBe("string");
    expect(r.view.value).toMatchObject({ type: "error", code: "#SYNTAX" });
  });

  test("an overridden formula reports overridden: true", () => {
    const t = Table.fromSnapshot(
      snapshot([
        placed("o", 0, 0, {
          cells: { a: { content: { type: "formula", source: "1 + 1" }, override: num(9) } },
        }),
      ]),
    );
    const r = cell(t, { object: "o", cell: "a" });
    expect(r.content).toEqual({ type: "formula", source: "1 + 1", overridden: true, parses: true });
    expect(r.view.value).toEqual(num(9));
  });
});

describe("explain_cell: character viewer", () => {
  test("Aldric's explain_cell of hit names goblin1.ac hidden, without value", async () => {
    const t = await fixtureTable("goblin-hit.json");
    const r = cell(t, { object: "goblin1", cell: "hit", viewer: ALDRIC });
    expect(r.view.source).toBeUndefined();
    expect(r.content).toEqual({ type: "formula", overridden: false, parses: true });
    expect(dep(r.dependencies, "goblin1", "ac")).toEqual({
      type: "cell",
      object: "goblin1",
      cell: "ac",
      hidden: true,
    });
    // The GM sees the value.
    const g = cell(t, { object: "goblin1", cell: "hit" });
    expect(dep(g.dependencies, "goblin1", "ac")).toEqual({
      type: "cell",
      object: "goblin1",
      cell: "ac",
      value: num(13),
    });
  });

  test("a dependency on an invisible object has object: null and no value", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("secret", 5, 5, { cells: { visible_to: c(GM_ONLY), hp: c(num(8)) } }),
        placed("pub", 6, 6, { cells: { tgt: c(ref("secret")), peek: f("tgt.hp + 1") } }),
      ]),
    );
    const r = cell(t, { object: "pub", cell: "peek", viewer: ALDRIC });
    expect(r.view.value).toEqual(num(9));
    expect(dep(r.dependencies, "pub", "tgt")).toEqual({
      type: "cell",
      object: "pub",
      cell: "tgt",
      value: { type: "redacted" },
    });
    const hidden = r.dependencies.filter(
      (n) => (n.type === "cell" || n.type === "exists") && n.object !== "pub",
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const n of hidden) {
      expect(n).toHaveProperty("object", null);
      expect(n).not.toHaveProperty("value");
      expect(n).not.toHaveProperty("exists");
      expect(n).not.toHaveProperty("hidden");
      expect(n).not.toHaveProperty("dependencies");
    }
    expect(dep(r.dependencies, null, "hp")).toEqual({ type: "cell", object: null, cell: "hp" });
    // The GM sees the object, the value and the ref.
    const g = cell(t, { object: "pub", cell: "peek" });
    expect(dep(g.dependencies, "secret", "hp")).toMatchObject({ value: num(8) });
    expect(dep(g.dependencies, "pub", "tgt")).toMatchObject({ value: ref("secret") });
  });

  test("not_found is identical for a GM-only object, a GM-only cell and a nonexistent object", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("secret", 5, 5, { cells: { visible_to: c(GM_ONLY), hp: c(num(8)) } }),
        placed("pub", 6, 6, {
          cells: { hp: c(num(3)), ac: c(num(12)) },
          cell_visibility: { ac: GM_ONLY },
        }),
      ]),
    );
    const gmOnlyObject = failureData(() =>
      explainCell(t, { object: "secret", cell: "hp", viewer: ALDRIC }),
    );
    const gmOnlyCell = failureData(() =>
      explainCell(t, { object: "pub", cell: "ac", viewer: ALDRIC }),
    );
    const nonexistent = failureData(() =>
      explainCell(t, { object: "nobody", cell: "hp", viewer: ALDRIC }),
    );
    const noCell = failureData(() =>
      explainCell(t, { object: "pub", cell: "nope", viewer: ALDRIC }),
    );
    expect(gmOnlyObject).toEqual(NOT_FOUND);
    expect(gmOnlyCell).toEqual(gmOnlyObject);
    expect(nonexistent).toEqual(gmOnlyObject);
    expect(noCell).toEqual(gmOnlyObject);
    // The GM sees both, and still gets not_found for a missing cell.
    expect(cell(t, { object: "secret", cell: "hp" }).view.value).toEqual(num(8));
    expect(cell(t, { object: "pub", cell: "ac" }).view.value).toEqual(num(12));
    expect(failureData(() => explainCell(t, { object: "pub", cell: "nope" }))).toEqual(NOT_FOUND);
  });
});

describe("explain_cell: error_chain", () => {
  test("a #REF chain ends at the cell that read the deleted object", () => {
    const t = Table.fromSnapshot(
      snapshot([
        placed("doomed", 0, 0, { cells: { hp: c(num(5)) } }),
        placed("o", 1, 1, {
          cells: { d: c(ref("doomed")), reader: f("d.hp"), a: f("reader + 1"), b: f("a * 2") },
        }),
      ]),
    );
    commit(t, (tx) => remove(tx, "doomed"));
    const r = cell(t, { object: "o", cell: "b" });
    expect(r.view.value).toMatchObject({ type: "error", code: "#REF" });
    expect(r.error_chain?.[0]).toEqual({ object: "o", cell: "b", code: "#REF" });
    expect(r.error_chain).toEqual([
      { object: "o", cell: "b", code: "#REF" },
      { object: "o", cell: "reader", code: "#REF" },
    ]);
  });

  test("a #CYCLE chain terminates", () => {
    const t = Table.fromSnapshot(
      snapshot([placed("o", 0, 0, { cells: { a: f("b"), b: f("c"), c: f("a"), d: f("a + 1") } })]),
    );
    const r = cell(t, { object: "o", cell: "d" });
    expect(r.view.value).toMatchObject({ type: "error", code: "#CYCLE" });
    expect(r.error_chain).toBeDefined();
    expect(r.error_chain?.length).toBeGreaterThan(0);
    expect(r.error_chain?.length).toBeLessThanOrEqual(32);
    for (const e of r.error_chain ?? []) expect(e.code).toBe("#CYCLE");
  });

  test("entries on invisible objects or unreadable cells are nulled for a character", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("secret", 5, 5, { cells: { visible_to: c(GM_ONLY), bad: f("1 / 0") } }),
        placed("pub", 6, 6, {
          cells: {
            tgt: c(ref("secret")),
            top: f("tgt.bad + 1"),
            hid: f("1 / 0"),
            via: f("hid"),
          },
          cell_visibility: { hid: GM_ONLY },
        }),
      ]),
    );
    expect(cell(t, { object: "pub", cell: "top" }).error_chain).toEqual([
      { object: "pub", cell: "top", code: "#DIV0" },
      { object: "secret", cell: "bad", code: "#DIV0" },
    ]);
    const r = cell(t, { object: "pub", cell: "top", viewer: ALDRIC });
    expect(r.view.value).toEqual({ type: "error", code: "#DIV0" });
    expect(r.error_chain).toEqual([
      { object: "pub", cell: "top", code: "#DIV0" },
      { object: null, cell: null, code: "#DIV0" },
    ]);
    const via = cell(t, { object: "pub", cell: "via", viewer: ALDRIC });
    expect(via.error_chain).toEqual([
      { object: "pub", cell: "via", code: "#DIV0" },
      { object: "pub", cell: null, code: "#DIV0" },
    ]);
  });
});

describe("explain_cell: last_write", () => {
  test("last_write names the group that last wrote the cell", async () => {
    const t = await fixtureTable("hit-points.json");
    expect(cell(t, { object: "aldric", cell: "damage_taken" }).last_write).toBeUndefined();
    t.store.transact(gm, { kind: "edit", label: "first" }, (tx) =>
      writeValue(tx, "aldric", "damage_taken", num(5)),
    );
    t.store.transact(gm, { kind: "edit", label: "other" }, (tx) =>
      writeValue(tx, "aldric", "max_hp", num(30)),
    );
    const r = cell(t, { object: "aldric", cell: "damage_taken" });
    expect(r.last_write).toEqual({
      index: 0,
      revision: 1,
      actor: { type: "gm" },
      kind: "edit",
      label: "first",
      cause: "edit",
    });
    expect(cell(t, { object: "aldric", cell: "max_hp" }).last_write?.label).toBe("other");
    // A formula cell written by setFormula is a cell effect too.
    t.store.transact(gm, { kind: "edit", label: "rewrite" }, (tx) =>
      setFormula(tx, "aldric", "hp", "max_hp"),
    );
    expect(cell(t, { object: "aldric", cell: "hp" }).last_write?.label).toBe("rewrite");
  });

  test("a group writing a public and a GM-only cell has label null for Aldric only", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("pub", 6, 6, {
          cells: { hp: c(num(3)), ac: c(num(12)) },
          cell_visibility: { ac: GM_ONLY },
        }),
      ]),
    );
    t.store.transact(gm, { kind: "edit", label: "both" }, (tx) => {
      writeValue(tx, "pub", "hp", num(4));
      writeValue(tx, "pub", "ac", num(14));
    });
    const aldric = cell(t, { object: "pub", cell: "hp", viewer: ALDRIC });
    expect(aldric.last_write).toEqual({
      index: 0,
      revision: 1,
      actor: { type: "gm" },
      kind: "edit",
      label: null,
      cause: "edit",
    });
    expect(cell(t, { object: "pub", cell: "hp" }).last_write?.label).toBe("both");
  });
});

describe("explain_group", () => {
  test("a committed setTag group returns its field effect view", () => {
    const t = Table.fromSnapshot(snapshot([placed("o", 0, 0)]));
    t.store.transact(gm, { kind: "edit", label: "tag it" }, (tx) => setTag(tx, "o", ["hot"]));
    const r = explainGroup(t, { index: 0 });
    expect(ExplainGroupResultSchema.parse(r)).toEqual(r);
    expect(r.group).toMatchObject({ index: 0, revision: 1, kind: "edit", label: "tag it" });
    expect(r.group.effects).toEqual([
      { type: "field", object: "o", field: "tag", before: [], after: ["hot"] },
    ]);
    expect(r.action).toBeUndefined();
  });

  test("the GM gets the origin action's current definition; a character does not", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("die", 1, 1, {
          cells: { value: c(num(0)) },
          actions: [{ name: "Roll", when: "value = 0", steps: ["roll(1d6) -> value"] }],
        }),
      ]),
    );
    t.store.transact(
      gm,
      { kind: "action", label: "Roll", origin: { object: "die", action: "Roll" } },
      (tx) => writeValue(tx, "die", "value", num(4)),
    );
    const r = explainGroup(t, { index: 0 });
    expect(ExplainGroupResultSchema.parse(r)).toEqual(r);
    expect(r.action).toEqual({
      object: "die",
      name: "Roll",
      when: "value = 0",
      steps: ["roll(1d6) -> value"],
      current: true,
    });
    const a = explainGroup(t, { index: 0, viewer: ALDRIC });
    expect(ExplainGroupResultSchema.parse(a)).toEqual(a);
    expect(a.action).toBeUndefined();
    expect(a.group.origin).toEqual({ object: "die", action: "Roll" });
    // Once the origin object is gone, there is no current definition.
    commit(t, (tx) => remove(tx, "die"));
    expect(explainGroup(t, { index: 0 }).action).toBeUndefined();
  });

  test("a group null for Aldric and a non-retained index are identical not_found", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("secret", 5, 5, { cells: { visible_to: c(GM_ONLY), hp: c(num(8)) } }),
      ]),
    );
    t.store.transact(gm, { kind: "edit", label: "secret" }, (tx) =>
      writeValue(tx, "secret", "hp", num(9)),
    );
    const nullGroup = failureData(() => explainGroup(t, { index: 0, viewer: ALDRIC }));
    const notRetained = failureData(() => explainGroup(t, { index: 7, viewer: ALDRIC }));
    expect(nullGroup).toEqual(NOT_FOUND);
    expect(notRetained).toEqual(nullGroup);
    expect(explainGroup(t, { index: 0 }).group.label).toBe("secret");
    expect(failureData(() => explainGroup(t, { index: 7 }))).toEqual(NOT_FOUND);
  });
});

describe("explain_action", () => {
  test("attack-card Roll: disabled with when_false while target is empty, enabled after", async () => {
    const t = await fixtureTable("attack-card.json");
    const before = action(t, { object: "attack_card", action: "Roll" });
    expect(before).toEqual({
      object: "attack_card",
      action: "Roll",
      enabled: false,
      reason: "when_false",
      guard: {
        source: "target != empty and roll = empty",
        value: { type: "boolean", value: false },
      },
      steps: ["roll(1d20) -> roll"],
    });
    const aldric = action(t, { object: "attack_card", action: "Roll", viewer: ALDRIC });
    expect(aldric).toEqual({
      object: "attack_card",
      action: "Roll",
      enabled: false,
      reason: "when_false",
      guard: { value: { type: "boolean", value: false } },
    });
    commit(t, (tx) => writeValue(tx, "attack_card", "target", ref("goblin1")));
    const after = action(t, { object: "attack_card", action: "Roll" });
    expect(after.enabled).toBe(true);
    expect(after.reason).toBeUndefined();
    expect(after.guard).toEqual({
      source: "target != empty and roll = empty",
      value: { type: "boolean", value: true },
    });
  });

  test("a when that errors is when_error", () => {
    const t = Table.fromSnapshot(
      snapshot([placed("o", 0, 0, { actions: [{ name: "Go", when: "1 / 0", steps: [] }] })]),
    );
    const r = action(t, { object: "o", action: "Go" });
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("when_error");
    expect(r.guard?.value).toMatchObject({ type: "error" });
  });

  test("an action without when: enabled, no reason or guard; steps for the GM only", async () => {
    const t = await fixtureTable("dice-tray.json");
    const g = action(t, { object: "die_a", action: "Roll" });
    expect(g).toEqual({
      object: "die_a",
      action: "Roll",
      enabled: true,
      steps: ["roll(1d6) -> value"],
    });
    const scenario = await loadScenarioFile("hit-points.json");
    const doc = documentFromSetup(scenario.setup);
    const aldricObj = doc.objects.aldric;
    if (aldricObj === undefined) throw new Error("fixture");
    aldricObj.actions = [{ name: "Rest", steps: ["set(damage_taken, 0)"] }];
    const t2 = Table.fromSnapshot(doc);
    expect(action(t2, { object: "aldric", action: "Rest", viewer: ALDRIC })).toEqual({
      object: "aldric",
      action: "Rest",
      enabled: true,
    });
    expect(action(t2, { object: "aldric", action: "Rest" })).toEqual({
      object: "aldric",
      action: "Rest",
      enabled: true,
      steps: ["set(damage_taken, 0)"],
    });
  });

  test("a GM-only object, a nonexistent object and an unknown action are identical not_found", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("secret", 5, 5, {
          cells: { visible_to: c(GM_ONLY) },
          actions: [{ name: "Go", steps: [] }],
        }),
        placed("pub", 6, 6, { actions: [{ name: "Go", steps: [] }] }),
      ]),
    );
    const hidden = failureData(() =>
      explainAction(t, { object: "secret", action: "Go", viewer: ALDRIC }),
    );
    const missing = failureData(() =>
      explainAction(t, { object: "nobody", action: "Go", viewer: ALDRIC }),
    );
    const unknown = failureData(() =>
      explainAction(t, { object: "pub", action: "Stop", viewer: ALDRIC }),
    );
    expect(hidden).toEqual(NOT_FOUND);
    expect(missing).toEqual(hidden);
    expect(unknown).toEqual(hidden);
    expect(action(t, { object: "secret", action: "Go" }).enabled).toBe(true);
    expect(failureData(() => explainAction(t, { object: "pub", action: "Stop" }))).toEqual(
      NOT_FOUND,
    );
  });
});
