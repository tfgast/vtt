import { createEngine } from "@vtt/formula";
import { bool, EMPTY, num, type RollValue, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { doc } from "./support/engine-doc";
import { MemoryHost } from "./support/memory-host";
import { loadScenarios } from "./support/scenarios";

const scenarios = await loadScenarios();
const attackSetup = () => {
  const s = scenarios.find((x) => x.source === "An Attack card");
  if (s === undefined) throw new Error("no attack card scenario");
  return s.setup;
};

const roll = (expr: string, dice: number[], total: number): RollValue => ({
  type: "roll",
  expr,
  dice,
  dropped: [],
  total,
});

describe("engine.evaluate: the attack card's guards", () => {
  const ROLL = "target != empty and roll = empty";
  const ROLL_DAMAGE = "hit and dmg = empty";
  const APPLY = "hit and dmg != empty and not applied";
  const card = { thisId: "attack_card" };

  test("each guard follows the card through roll, damage, and apply", () => {
    const host = MemoryHost.fromSetup(attackSetup());
    const engine = createEngine(host);
    const guards = () => [ROLL, ROLL_DAMAGE, APPLY].map((g) => engine.evaluate(g, card));
    engine.invalidate(host.set("attack_card", "attacker", ref("aldric")));
    expect(guards()).toEqual([bool(false), bool(false), bool(false)]);

    engine.invalidate(host.set("attack_card", "target", ref("goblin1")));
    expect(guards()).toEqual([bool(true), bool(false), bool(false)]);

    engine.invalidate(host.set("attack_card", "roll", roll("1d20", [12], 12)));
    expect(engine.value("attack_card", "total")).toEqual(num(17));
    expect(engine.evaluate(ROLL_DAMAGE, card)).toEqual(bool(true));
    expect(guards()).toEqual([bool(false), bool(true), bool(false)]);

    // dmg is read only by the guards: nothing in the engine depends on it.
    const dirty = engine.invalidate(host.set("attack_card", "dmg", roll("1d8+3", [5], 8)));
    expect(dirty).toEqual([]);
    expect(guards()).toEqual([bool(false), bool(false), bool(true)]);

    engine.invalidate(host.set("attack_card", "applied", bool(true)));
    expect(guards()).toEqual([bool(false), bool(false), bool(false)]);
  });

  test("a miss (roll 2 + 5 < 13) keeps Roll damage off", () => {
    const host = MemoryHost.fromSetup(attackSetup());
    const engine = createEngine(host);
    host.set("attack_card", "attacker", ref("aldric"));
    host.set("attack_card", "target", ref("goblin1"));
    host.set("attack_card", "roll", roll("1d20", [2], 2));
    expect(engine.evaluate(ROLL_DAMAGE, card)).toEqual(bool(false));
  });
});

describe("engine.evaluate", () => {
  test("uses and populates the memo, and keeps no dependency entry", () => {
    const host = doc({ o: { cells: { a: 1, x: "=a + 1", y: "=x * 10" } } });
    const engine = createEngine(host);
    expect(engine.evaluate("y + x", { thisId: "o" })).toEqual(num(22));
    const s = engine.stats();
    expect(s.evaluations).toBe(2);
    // Memoized by the ad hoc evaluation: no further work.
    expect(engine.value("o", "y")).toEqual(num(20));
    expect(engine.stats().evaluations).toBe(2);
    expect(engine.evaluate("y + x", { thisId: "o" })).toEqual(num(22));
    expect(engine.stats().evaluations).toBe(2);
    expect(engine.dependenciesOf("o", "x")).toEqual([{ type: "cell", object: "o", cell: "a" }]);
    // Invalidation sees only the cells.
    expect([...engine.invalidate(host.set("o", "a", num(2)))].sort()).toEqual(["o:x", "o:y"]);
    expect(engine.evaluate("y + x", { thisId: "o" })).toEqual(num(33));
  });

  test("resolves a long uncomputed chain iteratively", () => {
    const N = 5_000;
    const cells: Record<string, string | number> = { c0: 0 };
    for (let i = 1; i <= N; i++) cells[`c${i}`] = `=c${i - 1} + 1`;
    const engine = createEngine(doc({ o: { cells } }));
    expect(engine.evaluate(`c${N} * 2`, { thisId: "o" })).toEqual(num(2 * N));
    expect(engine.stats().evaluations).toBe(N);
  });

  test("resolves many uncomputed dependencies, each once", () => {
    const N = 500;
    const ids = Array.from({ length: N }, (_, i) => `d${i}`);
    const objects = Object.fromEntries(ids.map((id, i) => [id, { cells: { x: `=${i} + 1` } }]));
    const engine = createEngine(doc({ ...objects, tray: { contents: ids } }));
    expect(engine.evaluate("sum(contents.x)", { thisId: "tray" })).toEqual(num((N * (N + 1)) / 2));
    expect(engine.stats().evaluations).toBe(N);
  });

  test("propagates a cycle as a reader outside it would", () => {
    const host = doc({ o: { cells: { a: "=b + 1", b: "=a + 1" } } });
    const engine = createEngine(host);
    expect(engine.evaluate("b * 2", { thisId: "o" })).toMatchObject({
      type: "error",
      code: "#CYCLE",
      origin: { object: "o", cell: "b" },
    });
    expect(engine.evaluate("iserror(a)", { thisId: "o" })).toEqual(bool(true));
    expect(engine.value("o", "a")).toMatchObject({ origin: { object: "o", cell: "a" } });
    engine.invalidate(host.replaceContent("o", "b", num(1)));
    expect(engine.evaluate("a + b", { thisId: "o" })).toEqual(num(3));
  });

  test("a guard that branches on an uncomputed cell reads only the branch taken", () => {
    const host = doc({
      o: { cells: { flag: bool(false), cheap: "=1", loop: "=loop + 1", c: "=flag" } },
    });
    const engine = createEngine(host);
    expect(engine.evaluate("if(c, loop, cheap)", { thisId: "o" })).toEqual(num(1));
  });

  test("errors: #SYNTAX, #NAME, #REF without a cell origin", () => {
    const engine = createEngine(doc({ o: { cells: { a: 1 } } }));
    expect(engine.evaluate("1 +", { thisId: "o" })).toMatchObject({ code: "#SYNTAX" });
    const name = engine.evaluate("nope", { thisId: "o" });
    expect(name).toMatchObject({ code: "#NAME" });
    expect(engine.evaluate("a", { thisId: "o" })).toEqual(num(1));
    expect(engine.evaluate("empty", { thisId: "o" })).toEqual(EMPTY);
    expect(engine.evaluate("a", { thisId: "gone" })).toMatchObject({ code: "#REF" });
  });
});

describe("engine.evaluate without an object", () => {
  const host = () =>
    MemoryHost.fromSetup({
      boards: [{ id: "table" }],
      characters: [],
      objects: [
        {
          id: "goblin1",
          placement: { board: "table", position: [0, 0] },
          cells: { name: text("Goblin"), max_hp: num(27) },
        },
        {
          id: "orc1",
          placement: { board: "table", position: [3, 4] },
          cells: { name: text("Orc"), max_hp: num(40) },
        },
      ],
    });

  test("`this` is #REF: no object in scope", () => {
    const engine = createEngine(host());
    const r = engine.evaluate("this", {});
    expect(r).toEqual({ type: "error", code: "#REF", message: "no object in scope" });
    expect(engine.evaluate("this.max_hp", {})).toMatchObject({ code: "#REF" });
  });

  test("a bare cell name is #NAME", () => {
    const engine = createEngine(host());
    const r = engine.evaluate("max_hp", {});
    expect(r).toMatchObject({ type: "error", code: "#NAME" });
    expect(r).not.toHaveProperty("origin");
  });

  test("literals, obj(), objects(), and spatial functions on explicit refs work", () => {
    const engine = createEngine(host());
    expect(engine.evaluate("1 + 2", {})).toEqual(num(3));
    expect(engine.evaluate('obj("Goblin").max_hp', {})).toEqual(num(27));
    expect(engine.evaluate("sum(objects(true).max_hp)", {})).toEqual(num(67));
    expect(engine.evaluate("objects(max_hp > 30)", {})).toEqual({
      type: "list",
      items: [ref("orc1")],
    });
    expect(engine.evaluate('distance(obj("Goblin"), obj("Orc"))', {})).toEqual(num(5));
  });

  test("works on a document with no boards (and so no objects)", () => {
    const engine = createEngine(MemoryHost.fromSetup({ boards: [], characters: [], objects: [] }));
    expect(engine.evaluate("1 + 2", {})).toEqual(num(3));
    expect(engine.evaluate("len(objects(true))", {})).toEqual(num(0));
    expect(engine.evaluate("this", {})).toMatchObject({ code: "#REF" });
    expect(engine.evaluate("hp", {})).toMatchObject({ code: "#NAME" });
  });

  test("still budgeted and keeps no dependency entry", () => {
    const h = doc({ o: { cells: { name: text("O"), a: 1, x: "=a + 1" } } });
    const engine = createEngine(h);
    expect(engine.evaluate('obj("O").x * 10', {})).toEqual(num(20));
    expect(engine.stats().evaluations).toBe(1);
    expect(engine.dependenciesOf("o", "x")).toEqual([{ type: "cell", object: "o", cell: "a" }]);
    expect(engine.evaluate('obj("O").x * 10', {})).toEqual(num(20));
    expect(engine.stats().evaluations).toBe(1);
  });
});
