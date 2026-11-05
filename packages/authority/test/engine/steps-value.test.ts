/**
 * Value steps (vtt-1xv.8): `set`, `add`, `append`, `roll`, `shuffle` and
 * `each` run through `createExecutor({handlers: coreHandlers})`
 * (FORMULAS.md §8.1–§8.3, §10; M5-D3, M5-D5, M5-D6).
 */
import {
  coreHandlers,
  createExecutor,
  type InvokeOutcome,
  ScriptedDiceSource,
  Table,
  undo,
} from "@vtt/authority";
import {
  type ActionDef,
  dice,
  EMPTY,
  list,
  MAX_EACH_ITEMS,
  num,
  type Result,
  type RollValue,
  ref,
  text,
  type Value,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, f, gm, obj, placed, snapshot } from "./helpers";

const roll = (expr: string, d: number[], total: number): RollValue => ({
  type: "roll",
  expr,
  dice: d,
  dropped: [],
  total,
});

const executor = createExecutor({ handlers: coreHandlers });

/** The Attack card of FORMULAS §10, targeting goblin1, attacker Aldric. */
function attackTable(): Table {
  const actions: ActionDef[] = [
    { name: "Roll", when: "target != empty and roll = empty", steps: ["roll(1d20) -> roll"] },
    {
      name: "Roll damage",
      when: "hit and dmg = empty",
      steps: ["roll(attacker.damage_dice) -> dmg"],
    },
    {
      name: "Apply",
      when: "hit and dmg != empty and not applied",
      steps: ["add(target.damage_taken, dmg)", "set(applied, true)"],
    },
  ];
  return Table.fromSnapshot(
    snapshot([
      placed("aldric", 0, 0, {
        is_character: true,
        cells: { attack_bonus: c(num(5)), damage_dice: c(dice("1d8+3")) },
      }),
      placed("goblin1", 4, 0, { cells: { ac: c(num(13)), damage_taken: c(num(0)) } }),
      placed("attack1", 8, 0, {
        cells: {
          name: c(text("Attack")),
          attacker: c(ref("aldric")),
          target: c(ref("goblin1")),
          roll: c(EMPTY),
          dmg: c(EMPTY),
          applied: c({ type: "boolean", value: false }),
          bonus: f("attacker.attack_bonus"),
          total: f("roll + bonus"),
          hit: f("roll != empty and total >= target.ac"),
        },
        actions,
      }),
    ]),
  );
}

/** A table whose object `o` has the given cells and one action "Go" with `steps`. */
function tableWith(
  steps: string[],
  cells: Record<string, ReturnType<typeof c>> = {},
  extra: ReturnType<typeof obj>[] = [],
  rest: Partial<ReturnType<typeof obj>> = {},
): Table {
  return Table.fromSnapshot(
    snapshot([placed("o", 0, 0, { cells, actions: [{ name: "Go", steps }], ...rest }), ...extra]),
  );
}

function go(table: Table, script: ConstructorParameters<typeof ScriptedDiceSource>[0] = []) {
  const source = new ScriptedDiceSource(script);
  const outcome = executor.invokeAction(table, source, { object: "o", action: "Go", actor: gm });
  return { outcome, source };
}

const value = (table: Table, id: string, cell: string): Result => table.value(id, cell);

function expectStepError(outcome: InvokeOutcome, step: number, code?: string) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.step).toBe(step);
  expect(outcome.rejection).toMatchObject({ type: "step_error", object: "o", action: "Go", step });
  if (outcome.rejection.type !== "step_error") return;
  expect(outcome.rejection.code).toBe(code);
  expect(typeof outcome.rejection.message).toBe("string");
}

/** The 1,000-item each walks every read through the change summary (vtt-qf5.9); CI runners need more than the 5 s default. */
const HEAVY_TIMEOUT = 30_000;

describe("the Attack card (FORMULAS §10)", () => {
  test("Roll, Roll damage and Apply against scripted dice give the §10 cells, one action group each", () => {
    const table = attackTable();
    const source = new ScriptedDiceSource([roll("1d20", [14], 14), roll("1d8+3", [5], 8)]);
    const invoke = (action: string) =>
      executor.invokeAction(table, source, { object: "attack1", action, actor: gm });

    const r1 = invoke("Roll");
    expect(r1.ok).toBe(true);
    expect(value(table, "attack1", "roll")).toEqual(roll("1d20", [14], 14));
    expect(value(table, "attack1", "total")).toEqual(num(19));
    expect(value(table, "attack1", "hit")).toEqual({ type: "boolean", value: true });

    const r2 = invoke("Roll damage");
    expect(r2.ok).toBe(true);
    expect(value(table, "attack1", "dmg")).toEqual(roll("1d8+3", [5], 8));

    const r3 = invoke("Apply");
    expect(r3.ok).toBe(true);
    expect(value(table, "goblin1", "damage_taken")).toEqual(num(8));
    expect(value(table, "attack1", "applied")).toEqual({ type: "boolean", value: true });
    expect(source.remaining()).toBe(0);

    const groups = table.store.history.groups();
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => [g.kind, g.label, g.origin])).toEqual([
      ["action", "Roll", { object: "attack1", action: "Roll" }],
      ["action", "Roll damage", { object: "attack1", action: "Roll damage" }],
      ["action", "Apply", { object: "attack1", action: "Apply" }],
    ]);
    if (r1.ok && r3.ok) {
      expect(r1.group).toBe(groups[0]);
      expect(r3.group.effects.filter((e) => e.type === "cell")).toHaveLength(2);
      expect(r3.created).toEqual([]);
    }
    // The roll is written with cause `roll`; add writes a number with cause `edit`.
    expect(groups[0]?.effects).toEqual([
      expect.objectContaining({ type: "cell", cell: "roll", cause: "roll" }),
    ]);
    expect(groups[2]?.effects[0]).toMatchObject({
      type: "cell",
      object: "goblin1",
      cell: "damage_taken",
      after: { content: num(8) },
      cause: "edit",
    });
  });

  test("a second Apply is when_false: nothing applied, no dice consumed", () => {
    const table = attackTable();
    const source = new ScriptedDiceSource([
      roll("1d20", [14], 14),
      roll("1d8+3", [5], 8),
      roll("1d20", [1], 1),
    ]);
    const invoke = (action: string) =>
      executor.invokeAction(table, source, { object: "attack1", action, actor: gm });
    for (const a of ["Roll", "Roll damage", "Apply"]) expect(invoke(a).ok).toBe(true);
    const revision = table.store.revision;
    const again = invoke("Apply");
    expect(again).toEqual({
      ok: false,
      rejection: { type: "when_false", object: "attack1", action: "Apply" },
    });
    expect(value(table, "goblin1", "damage_taken")).toEqual(num(8));
    expect(table.store.revision).toBe(revision);
    expect(source.remaining()).toBe(1);
  });

  test("the label defaults to the action name and can be given", () => {
    const table = attackTable();
    const source = new ScriptedDiceSource([roll("1d20", [14], 14)]);
    const r = executor.invokeAction(table, source, {
      object: "attack1",
      action: "Roll",
      actor: { type: "character", id: "aldric" },
      label: "Aldric attacks",
    });
    expect(r.ok).toBe(true);
    const g = table.store.history.groups()[0];
    expect(g?.label).toBe("Aldric attacks");
    expect(g?.actor).toEqual({ type: "character", id: "aldric" });
  });
});

describe("set", () => {
  test("writes a literal, and an override on a formula cell", () => {
    const table = tableWith(["set(a, 3)", "set(d, 10)"], { a: c(num(1)), d: f("a * 2") });
    const { outcome } = go(table);
    expect(outcome.ok).toBe(true);
    expect(value(table, "o", "a")).toEqual(num(3));
    expect(value(table, "o", "d")).toEqual(num(10));
    expect(table.isOverridden("o", "d")).toBe(true);
  });

  test("creates an absent cell", () => {
    const table = tableWith(["set(fresh, [1, 2])"]);
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "fresh")).toEqual(list([num(1), num(2)]));
  });

  test("reads its own writes; other cells read as of the action's start", () => {
    const table = tableWith(["set(a, 1)", "set(b, a + 1)", "set(base, 10)", "set(seen, d)"], {
      a: c(num(0)),
      b: c(num(0)),
      base: c(num(1)),
      d: f("base * 2"),
    });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "b")).toEqual(num(2));
    // `d` is a formula cell not written by the action: it reads as of the start.
    expect(value(table, "o", "seen")).toEqual(num(2));
    expect(value(table, "o", "d")).toEqual(num(20));
  });

  test("tag takes a list of text, name takes text", () => {
    const table = tableWith(['set(tag, ["a", "b"])', 'set(name, "Bob")']);
    expect(go(table).outcome.ok).toBe(true);
    expect(table.store.getObject("o")?.tag).toEqual(["a", "b"]);
    expect(value(table, "o", "name")).toEqual(text("Bob"));
  });

  test("name refuses a number as a type_error with the step index", () => {
    const table = tableWith(["set(a, 1)", "set(name, 3)"], { a: c(num(0)) });
    const { outcome } = go(table);
    expect(outcome).toMatchObject({
      ok: false,
      step: 1,
      rejection: { type: "type_error", object: "o", cell: "name" },
    });
    expect(value(table, "o", "a")).toEqual(num(0));
  });

  test.each(["id", "contents", "container", "board", "is_zone", "template", "shape"])(
    "set(%s, …) is protected_cell with step 0",
    (cell) => {
      const table = tableWith([`set(${cell}, empty)`]);
      const { outcome } = go(table);
      expect(outcome).toEqual({
        ok: false,
        step: 0,
        rejection: { type: "protected_cell", object: "o", cell },
      });
    },
  );

  test("set(contents, []) is protected_cell with step 0", () => {
    const table = tableWith(["set(contents, [])"]);
    expect(go(table).outcome).toEqual({
      ok: false,
      step: 0,
      rejection: { type: "protected_cell", object: "o", cell: "contents" },
    });
  });

  test("an expression error is step_error with its code", () => {
    expectStepError(go(tableWith(["set(a, 1 / 0)"])).outcome, 0, "#DIV0");
    expectStepError(go(tableWith(["set(a, nope)"])).outcome, 0, "#NAME");
  });

  test("a record value is #TYPE", () => {
    expectStepError(go(tableWith(["set(a, {x: 1})"])).outcome, 0, "#TYPE");
  });

  test("a set on a field flag is step_error without code", () => {
    expectStepError(go(tableWith(["set(is_template, true)"])).outcome, 0, undefined);
  });
});

describe("paths", () => {
  const other = placed("p", 1, 1, { cells: { hp: c(num(5)) } });

  test("a dot path writes the referenced object's cell", () => {
    const table = tableWith(["set(who.hp, 1)"], { who: c(ref("p")) }, [other]);
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "p", "hp")).toEqual(num(1));
  });

  test("an object part of empty is #REF", () => {
    expectStepError(go(tableWith(["set(who.hp, 1)"], { who: c(EMPTY) })).outcome, 0, "#REF");
  });

  test("an object part that is a list or another kind is #TYPE", () => {
    const table = tableWith(["set(who.hp, 1)"], { who: c(list([ref("p")])) }, [other]);
    expectStepError(go(table).outcome, 0, "#TYPE");
    expectStepError(go(tableWith(["set(who.hp, 1)"], { who: c(num(3)) })).outcome, 0, "#TYPE");
  });

  test("an object part that is an error refuses with its code", () => {
    expectStepError(go(tableWith(["set((1 / 0).hp, 1)"])).outcome, 0, "#DIV0");
  });

  test("an object part naming a missing object is #REF", () => {
    expectStepError(go(tableWith(['set(obj("ghost").hp, 1)'])).outcome, 0, "#REF");
  });
});

describe("add", () => {
  test("adds numbers", () => {
    const table = tableWith(["add(hp, 3)"], { hp: c(num(4)) });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "hp")).toEqual(num(7));
  });

  test("a non-number increment is step_error #TYPE", () => {
    expectStepError(go(tableWith(['add(hp, "x")'], { hp: c(num(4)) })).outcome, 0, "#TYPE");
  });

  test("a non-number current value is #TYPE", () => {
    expectStepError(go(tableWith(["add(hp, 1)"], { hp: c(text("x")) })).outcome, 0, "#TYPE");
  });

  test("an empty cell plus a roll increment writes the total as a number", () => {
    const table = tableWith(["add(hp, r)"], { hp: c(EMPTY), r: c(roll("1d6", [4], 4)) });
    expect(go(table).outcome.ok).toBe(true);
    expect(table.store.getCell("o", "hp")?.content).toEqual(num(4));
  });

  test("an absent cell counts as empty; an empty increment as 0", () => {
    const table = tableWith(["add(fresh, 2)", "add(fresh, empty)"]);
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "fresh")).toEqual(num(2));
  });

  test("a current roll counts as its total", () => {
    const table = tableWith(["add(r, 1)"], { r: c(roll("1d6", [4], 4)) });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "r")).toEqual(num(5));
  });

  test("reads its own writes", () => {
    const table = tableWith(["add(n, 1)", "add(n, 1)", "add(n, 1)"], { n: c(num(0)) });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "n")).toEqual(num(3));
  });
});

describe("append", () => {
  test("appends one item to a list, and to empty as []", () => {
    const table = tableWith(["append(xs, 3)", "append(ys, [1, 2])"], {
      xs: c(list([num(1), num(2)])),
      ys: c(EMPTY),
    });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "xs")).toEqual(list([num(1), num(2), num(3)]));
    expect(value(table, "o", "ys")).toEqual(list([list([num(1), num(2)])]));
  });

  test("another current value is #TYPE", () => {
    expectStepError(go(tableWith(["append(xs, 3)"], { xs: c(num(1)) })).outcome, 0, "#TYPE");
  });
});

describe("roll", () => {
  test("writes the scripted roll", () => {
    const table = tableWith(["roll(2d6) -> r"]);
    const { outcome, source } = go(table, [roll("2d6", [3, 4], 7)]);
    expect(outcome.ok).toBe(true);
    expect(value(table, "o", "r")).toEqual(roll("2d6", [3, 4], 7));
    expect(source.remaining()).toBe(0);
  });

  test("a value that is not dice is #TYPE and draws nothing", () => {
    const { outcome, source } = go(tableWith(["roll(3) -> r"]), [roll("1d20", [1], 1)]);
    expectStepError(outcome, 0, "#TYPE");
    expect(source.remaining()).toBe(1);
  });

  test("a roll after a failing step consumes no script entry", () => {
    const { outcome, source } = go(tableWith(['add(n, "x")', "roll(1d20) -> r"]), [
      roll("1d20", [1], 1),
    ]);
    expectStepError(outcome, 0, "#TYPE");
    expect(source.remaining()).toBe(1);
  });
});

describe("shuffle", () => {
  test("shuffle(this) reorders by the scripted permutation", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("o", 0, 0, {
          contents: ["a", "b", "c"],
          actions: [{ name: "Go", steps: ["shuffle(this)"] }],
        }),
        obj("a"),
        obj("b"),
        obj("c"),
      ]),
    );
    const { outcome, source } = go(table, [{ type: "permutation", order: [2, 0, 1] }]);
    expect(outcome.ok).toBe(true);
    expect(table.store.contentsOf("o")).toEqual(["c", "a", "b"]);
    expect(source.remaining()).toBe(0);
  });

  test("its argument must be one reference", () => {
    expectStepError(go(tableWith(["shuffle(empty)"])).outcome, 0, "#REF");
    expectStepError(go(tableWith(["shuffle([this])"])).outcome, 0, "#TYPE");
  });
});

describe("each", () => {
  const rows = ["r1", "r2", "r3"].map((id) => obj(id, { cells: { v: c(num(0)) } }));

  test("runs the inner step once per item of a list, with it bound", () => {
    const table = tableWith(
      ["each(xs, add(total, it))"],
      { xs: c(list([num(1), num(2), num(3)])), total: c(num(0)) },
      [],
    );
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "total")).toEqual(num(6));
  });

  test("it can name the item's cells in a path", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("o", 0, 0, {
          contents: ["r1", "r2", "r3"],
          actions: [{ name: "Go", steps: ["each(contents, set(it.v, 7))"] }],
        }),
        ...rows,
      ]),
    );
    expect(go(table).outcome.ok).toBe(true);
    for (const id of ["r1", "r2", "r3"]) expect(value(table, id, "v")).toEqual(num(7));
  });

  test("over empty runs nothing", () => {
    const table = tableWith(["each(xs, add(n, 1))"], { xs: c(EMPTY), n: c(num(0)) });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "n")).toEqual(num(0));
  });

  test("over a scalar runs once", () => {
    const table = tableWith(["each(5, add(n, it))"], { n: c(num(0)) });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "n")).toEqual(num(5));
  });

  test("the list is evaluated once, before running", () => {
    const table = tableWith(["each(xs, append(xs, it))"], { xs: c(list([num(1), num(2)])) });
    expect(go(table).outcome.ok).toBe(true);
    expect(value(table, "o", "xs")).toEqual(list([num(1), num(2), num(1), num(2)]));
  });

  test("an inner failure reports the each's index", () => {
    const table = tableWith(["set(a, 1)", 'each(xs, add(n, "x"))'], {
      xs: c(list([num(1)])),
      n: c(num(0)),
    });
    expectStepError(go(table).outcome, 1, "#TYPE");
  });

  test("a list expression error refuses with its code", () => {
    expectStepError(go(tableWith(["each(1 / 0, add(n, 1))"])).outcome, 0, "#DIV0");
  });

  test(
    `${MAX_EACH_ITEMS} items run; ${MAX_EACH_ITEMS + 1} are step_error #LIMIT`,
    () => {
      const items = (n: number): Value => list(Array.from({ length: n }, () => num(1)));
      const ok = tableWith(["each(xs, add(n, it))"], {
        xs: c(items(MAX_EACH_ITEMS)),
        n: c(num(0)),
      });
      expect(go(ok).outcome.ok).toBe(true);
      expect(value(ok, "o", "n")).toEqual(num(MAX_EACH_ITEMS));

      const over = tableWith(["each(xs, add(n, it))"], {
        xs: c(items(MAX_EACH_ITEMS + 1)),
        n: c(num(0)),
      });
      expectStepError(go(over).outcome, 0, "#LIMIT");
      expect(value(over, "o", "n")).toEqual(num(0));
    },
    HEAVY_TIMEOUT,
  );
});

describe("undo", () => {
  test("undo of an invocation restores every cell in one group", () => {
    const table = tableWith(["set(a, 9)", "add(b, 1)", "append(xs, 3)"], {
      a: c(num(1)),
      b: c(num(1)),
      xs: c(list([])),
    });
    const before = table.store.toSnapshot();
    expect(go(table).outcome.ok).toBe(true);
    expect(table.store.history.groups()).toHaveLength(1);
    const u = undo(table.store, gm);
    expect(u.ok).toBe(true);
    const after = table.store.toSnapshot();
    expect(after.objects).toEqual(before.objects);
    expect(value(table, "o", "a")).toEqual(num(1));
  });
});
