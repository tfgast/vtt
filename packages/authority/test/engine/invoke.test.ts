/**
 * The action executor (vtt-1xv.8): evaluation order, refusals, the handler
 * contract, transactions and dice (FORMULAS.md §8.1; DESIGN.md §4.5, §7;
 * FIXTURES.md §5, §6; M5-D5, M5-D6).
 */
import {
  coreHandlers,
  createExecutor,
  Rejected,
  ScenarioError,
  ScriptedDiceSource,
  type StepHandler,
  type StepHandlerEntry,
  Table,
  transactWithDice,
  writeValue,
} from "@vtt/authority";
import {
  type ActionDef,
  EMPTY,
  MAX_ACTION_WRITES,
  num,
  type RollValue,
  ref,
  type Snapshot,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, gm, obj, placed, snapshot } from "./helpers";

const roll = (expr: string, d: number[], total: number): RollValue => ({
  type: "roll",
  expr,
  dice: d,
  dropped: [],
  total,
});

const core = createExecutor({ handlers: coreHandlers });

function doc(actions: ActionDef[], cells: Record<string, ReturnType<typeof c>> = {}): Snapshot {
  return snapshot([
    placed("o", 0, 0, { cells: { a: c(num(0)), b: c(num(0)), ...cells }, actions }),
    placed("tpl", 9, 9, { is_template: true, cells: { kind: c(num(1)) } }),
    placed("box", 5, 5),
  ]);
}

const tableOf = (actions: ActionDef[], cells?: Record<string, ReturnType<typeof c>>) =>
  Table.fromSnapshot(doc(actions, cells));

/** Everything a refused invocation must leave alone. */
function observe(table: Table, source: ScriptedDiceSource) {
  return {
    doc: table.store.toSnapshot(),
    revision: table.store.revision,
    log: table.store.history.groups().length,
    dice: source.remaining(),
  };
}

describe("evaluation order", () => {
  test("an unknown object or action is invalid", () => {
    const table = tableOf([{ name: "Go", steps: ["set(a, 1)"] }]);
    const dice = new ScriptedDiceSource([]);
    const missingObject = core.invokeAction(table, dice, {
      object: "ghost",
      action: "Go",
      actor: gm,
    });
    expect(missingObject).toMatchObject({ ok: false, rejection: { type: "invalid" } });
    const missingAction = core.invokeAction(table, dice, { object: "o", action: "go", actor: gm });
    expect(missingAction).toMatchObject({ ok: false, rejection: { type: "invalid" } });
    expect(missingAction.ok === false && missingAction.step).toBeUndefined();
  });

  test("a when of true runs; false or any other value is when_false", () => {
    const table = tableOf([
      { name: "Yes", when: "a = 0", steps: ["set(a, 1)"] },
      { name: "No", when: "a = 0", steps: ["set(b, 1)"] },
      { name: "One", when: "1", steps: ["set(b, 1)"] },
    ]);
    const dice = new ScriptedDiceSource([]);
    expect(core.invokeAction(table, dice, { object: "o", action: "Yes", actor: gm }).ok).toBe(true);
    for (const action of ["No", "One"]) {
      expect(core.invokeAction(table, dice, { object: "o", action, actor: gm })).toEqual({
        ok: false,
        rejection: { type: "when_false", object: "o", action },
      });
    }
  });

  test("a when of #REF is when_error #REF", () => {
    const table = tableOf([{ name: "Go", when: "who.hp > 0", steps: ["set(a, 1)"] }], {
      who: c(ref("ghost")),
    });
    const r = core.invokeAction(table, new ScriptedDiceSource([]), {
      object: "o",
      action: "Go",
      actor: gm,
    });
    expect(r).toMatchObject({
      ok: false,
      rejection: { type: "when_error", object: "o", action: "Go", code: "#REF" },
    });
  });

  test("a when of `1 +` is when_error #SYNTAX", () => {
    const table = tableOf([{ name: "Go", when: "1 +", steps: ["set(a, 1)"] }]);
    const r = core.invokeAction(table, new ScriptedDiceSource([]), {
      object: "o",
      action: "Go",
      actor: gm,
    });
    expect(r).toMatchObject({
      ok: false,
      rejection: { type: "when_error", code: "#SYNTAX" },
    });
  });

  test("an unparsable second step is step_error #SYNTAX at 1 before the first step runs", () => {
    const table = tableOf([{ name: "Go", steps: ["roll(1d20) -> a", "set(1, 2)"] }]);
    // An empty script: had the first step run, it would throw ScenarioError.
    const dice = new ScriptedDiceSource([]);
    const r = core.invokeAction(table, dice, { object: "o", action: "Go", actor: gm });
    expect(r).toMatchObject({
      ok: false,
      step: 1,
      rejection: { type: "step_error", object: "o", action: "Go", step: 1, code: "#SYNTAX" },
    });
    if (!r.ok && r.rejection.type === "step_error") {
      expect(r.rejection.message).toMatch(/cell path/);
    }
  });

  test("the guard reads the committed revision", () => {
    const table = tableOf([{ name: "Go", when: "a = 5", steps: ["set(b, 1)"] }]);
    table.store.transact(gm, { kind: "edit", label: "e" }, (tx) =>
      writeValue(tx, "o", "a", num(5)),
    );
    const r = core.invokeAction(table, new ScriptedDiceSource([]), {
      object: "o",
      action: "Go",
      actor: gm,
    });
    expect(r.ok).toBe(true);
  });
});

describe("refused invocations change nothing", () => {
  test("a when_false, and a step_error in the second step after a roll in the first", () => {
    const table = tableOf([
      { name: "Never", when: "false", steps: ["roll(1d20) -> a"] },
      { name: "Half", steps: ["roll(1d20) -> a", 'add(b, "x")'] },
    ]);
    const dice = new ScriptedDiceSource([roll("1d20", [7], 7), roll("1d20", [9], 9)]);
    let commits = 0;
    table.onCommit(() => commits++);
    table.store.onCommit(() => commits++);
    const start = observe(table, dice);

    const never = core.invokeAction(table, dice, { object: "o", action: "Never", actor: gm });
    expect(never).toMatchObject({ ok: false, rejection: { type: "when_false" } });
    expect(observe(table, dice)).toEqual(start);

    const half = core.invokeAction(table, dice, { object: "o", action: "Half", actor: gm });
    expect(half).toMatchObject({
      ok: false,
      step: 1,
      rejection: { type: "step_error", step: 1, code: "#TYPE" },
    });
    expect(observe(table, dice)).toEqual(start);
    expect(table.value("o", "a")).toEqual(num(0));
    expect(commits).toBe(0);
    expect(table.store.openTransaction).toBeNull();
  });

  test("a ScenarioError from the dice script propagates, never a refusal", () => {
    const table = tableOf([{ name: "Go", steps: ["roll(1d20) -> a"] }]);
    const dice = new ScriptedDiceSource([roll("2d6", [1, 1], 2)]);
    expect(() => core.invokeAction(table, dice, { object: "o", action: "Go", actor: gm })).toThrow(
      ScenarioError,
    );
    expect(table.store.openTransaction).toBeNull();
    expect(table.store.revision).toBe(0);
    expect(dice.remaining()).toBe(1);
  });
});

describe("runAction in a caller's transaction", () => {
  const actions: ActionDef[] = [{ name: "Go", steps: ["roll(1d20) -> a", "set(b, a + 1)"] }];

  test("an aborted transaction leaves the store unchanged", () => {
    const table = tableOf(actions);
    const dice = new ScriptedDiceSource([roll("1d20", [7], 7)]);
    const before = table.store.toSnapshot();
    const tx = table.store.begin(gm, { kind: "action", label: "Go" });
    const r = core.runAction(tx, { table, dice }, { object: "o", action: "Go" });
    expect(r).toEqual({ ok: true, created: [] });
    expect(tx.state).toBe("open");
    expect(tx.effects()).toHaveLength(2);
    tx.abort();
    expect(table.store.toSnapshot()).toEqual(before);
    expect(table.store.history.groups()).toHaveLength(0);
  });

  test("a committed transaction produces the same group as invokeAction", () => {
    const meta = { kind: "action", label: "Go", origin: { object: "o", action: "Go" } } as const;
    const t1 = tableOf(actions);
    const d1 = new ScriptedDiceSource([roll("1d20", [7], 7)]);
    const tx = t1.store.begin(gm, meta);
    expect(core.runAction(tx, { table: t1, dice: d1 }, { object: "o", action: "Go" }).ok).toBe(
      true,
    );
    const committed = tx.commit().group;

    const t2 = tableOf(actions);
    const d2 = new ScriptedDiceSource([roll("1d20", [7], 7)]);
    const invoked = core.invokeAction(t2, d2, { object: "o", action: "Go", actor: gm });
    expect(invoked.ok).toBe(true);
    if (invoked.ok) expect(invoked.group).toEqual(committed);
    expect(t2.value("o", "b")).toEqual(num(8));
  });

  test("a refusal is returned, not thrown, and the transaction stays open", () => {
    const table = tableOf([{ name: "Go", steps: ['add(a, "x")'] }]);
    const tx = table.store.begin(gm, { kind: "action", label: "Go" });
    const r = core.runAction(
      tx,
      { table, dice: new ScriptedDiceSource([]) },
      { object: "o", action: "Go" },
    );
    expect(r).toMatchObject({ ok: false, step: 0, rejection: { type: "step_error" } });
    expect(tx.state).toBe("open");
    tx.abort();
  });
});

describe("the handler contract", () => {
  /**
   * A test-local `move` handler driven by its object expression's value:
   * a number n spawns `tpl` into `box` and writes n to `this.a` through
   * resolvePath; a text names a contract feature to exercise.
   */
  const probe: StepHandler = (ctx, step) => {
    if (step.kind !== "move") throw new Error("probe handles move");
    const v = ctx.evaluate(step.object);
    if (v.type === "error") return ctx.refuse({ code: v.code, message: v.message ?? v.code });
    if (v.type === "number") {
      const path = ctx.resolvePath({ object: null, cell: "a" });
      if (!path.ok) return { ok: false, rejection: path.rejection };
      ctx.primitives.writeValue(path.object, path.cell, v);
      const spawned = ctx.primitives.spawn("tpl", { type: "container", container: "box" });
      ctx.created.push(spawned.root);
      return { ok: true };
    }
    if (v.type === "text") {
      switch (v.value) {
        case "protected":
          ctx.primitives.writeValue(ctx.thisId, "contents", EMPTY);
          return { ok: true };
        case "invalid":
          ctx.primitives.writeValue("ghost", "a", num(1));
          return { ok: true };
        case "count":
          ctx.count(MAX_ACTION_WRITES);
          return { ok: true };
        case "write":
          ctx.primitives.writeValue(ctx.thisId, "b", num(2));
          return { ok: true };
        case "refuse":
          return ctx.refuse({ message: "refused by the probe" });
        case "throw":
          throw new Error("probe failure");
      }
    }
    return ctx.refuse({ code: "#TYPE", message: "unexpected" });
  };
  const withProbe = createExecutor({
    handlers: [...coreHandlers, { kind: "move", handle: probe }],
  });

  function run(steps: string[]) {
    const table = tableOf([{ name: "Go", steps }]);
    const dice = new ScriptedDiceSource([]);
    const r = withProbe.invokeAction(table, dice, { object: "o", action: "Go", actor: gm });
    return { table, r };
  }

  test("evaluate, resolvePath, primitives and created", () => {
    const { table, r } = run(["move(1 + 2, this)", "move(4, this)"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toHaveLength(2);
    expect(table.store.contentsOf("box")).toEqual(r.created);
    expect(table.value("o", "a")).toEqual(num(4));
  });

  test("evaluate errors and refuse are step_errors at the current index", () => {
    const e = run(["set(a, 1)", "move(1 / 0, this)"]).r;
    expect(e).toMatchObject({ ok: false, step: 1, rejection: { step: 1, code: "#DIV0" } });
    const refused = run(["set(a, 1)", "set(b, 1)", 'move("refuse", this)']).r;
    expect(refused).toEqual({
      ok: false,
      step: 2,
      rejection: {
        type: "step_error",
        object: "o",
        action: "Go",
        step: 2,
        message: "refused by the probe",
      },
    });
  });

  test("a primitive's Rejected keeps its type with the step index", () => {
    expect(run(["set(a, 1)", 'move("protected", this)']).r).toEqual({
      ok: false,
      step: 1,
      rejection: { type: "protected_cell", object: "o", cell: "contents" },
    });
  });

  test("a primitive's invalid becomes step_error without code, with its message", () => {
    const { r } = run(['move("invalid", this)']);
    expect(r).toMatchObject({ ok: false, step: 0, rejection: { type: "step_error", step: 0 } });
    if (!r.ok && r.rejection.type === "step_error") {
      expect(r.rejection.code).toBeUndefined();
      expect(r.rejection.message).toMatch(/ghost/);
    }
  });

  test(`count up to ${MAX_ACTION_WRITES} calls is allowed; past it is step_error #LIMIT`, () => {
    expect(run(['move("count", this)']).r.ok).toBe(true);
    const { table, r } = run(['move("count", this)', 'move("write", this)']);
    expect(r).toMatchObject({
      ok: false,
      step: 1,
      rejection: { type: "step_error", step: 1, code: "#LIMIT" },
    });
    expect(table.value("o", "b")).toEqual(num(0));
    // A primitive call counts one: a write before the count pushes it over.
    expect(run(["set(a, 1)", 'move("count", this)']).r).toMatchObject({
      ok: false,
      step: 1,
      rejection: { code: "#LIMIT" },
    });
  });

  test("any other exception propagates and nothing commits", () => {
    const table = tableOf([{ name: "Go", steps: ["set(a, 1)", 'move("throw", this)'] }]);
    expect(() =>
      withProbe.invokeAction(table, new ScriptedDiceSource([]), {
        object: "o",
        action: "Go",
        actor: gm,
      }),
    ).toThrow("probe failure");
    expect(table.store.openTransaction).toBeNull();
    expect(table.store.revision).toBe(0);
  });

  test("a duplicate handler kind throws", () => {
    const dup: StepHandlerEntry = { kind: "set", handle: () => ({ ok: true }) };
    expect(() => createExecutor({ handlers: [...coreHandlers, dup] })).toThrow(/set/);
  });

  test("a kind without a handler refuses step_error 'not supported'", () => {
    const table = tableOf([{ name: "Go", steps: ["set(a, 1)", "move(this, box)"] }]);
    const r = core.invokeAction(table, new ScriptedDiceSource([]), {
      object: "o",
      action: "Go",
      actor: gm,
    });
    expect(r).toMatchObject({ ok: false, step: 1, rejection: { type: "step_error", step: 1 } });
    if (!r.ok && r.rejection.type === "step_error") {
      expect(r.rejection.code).toBeUndefined();
      expect(r.rejection.message).toMatch(/not supported/);
    }
  });

  test("runAction composes with transactWithDice as invokeAction does", () => {
    const table = tableOf([{ name: "Go", steps: ["move(5, this)"] }]);
    const dice = new ScriptedDiceSource([]);
    let created: string[] = [];
    const r = transactWithDice(
      table,
      gm,
      { kind: "action", label: "Go", origin: { object: "o", action: "Go" } },
      dice,
      (tx) => {
        const out = withProbe.runAction(tx, { table, dice }, { object: "o", action: "Go" });
        if (!out.ok) throw new Rejected(out.rejection);
        created = out.created;
      },
    );
    expect(r.ok).toBe(true);
    expect(created).toHaveLength(1);
  });
});
