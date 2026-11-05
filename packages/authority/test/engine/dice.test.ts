/**
 * Dice sources (vtt-75c.15): seeded and scripted randomness, consumed
 * transactionally (FORMULAS.md §2.2, §8.3; FIXTURES.md §5; DESIGN.md §7).
 */
import {
  type DiceSource,
  RandomDiceSource,
  Rejected,
  rollInto,
  ScenarioError,
  ScriptedDiceSource,
  shuffleWith,
  Table,
  transactWithDice,
  writeValue,
} from "@vtt/authority";
import { list, num, type RollValue, ref } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, edit, gm, obj, placed, snapshot } from "./helpers";

const roll = (expr: string, dice: number[], total: number, dropped: number[] = []): RollValue => ({
  type: "roll",
  expr,
  dice,
  dropped,
  total,
});

function fixture(): Table {
  return Table.fromSnapshot(
    snapshot([
      placed("goblin", 0, 0, { cells: { save: c(num(0)) } }),
      placed("five", 10, 0, { contents: ["f0", "f1", "f2", "f3", "f4"] }),
      ...["f0", "f1", "f2", "f3", "f4"].map((id) => obj(id)),
      placed("three", 20, 0, { contents: ["t0", "t1", "t2"] }),
      ...["t0", "t1", "t2"].map((id) => obj(id)),
    ]),
  );
}

const contents = (table: Table, id: string) => table.store.contentsOf(id);

describe("ScriptedDiceSource", () => {
  test("matches 1d8+3 against a request equal by normalization", () => {
    const entry = roll("1d8+3", [5], 8);
    const source = new ScriptedDiceSource([entry]);
    expect(source.roll("3+d8")).toEqual(entry);
    expect(source.remaining()).toBe(0);
  });

  test("throws a ScenarioError on an expression mismatch", () => {
    const source = new ScriptedDiceSource([roll("1d8+3", [5], 8)]);
    expect(() => source.roll("1d8+4")).toThrow(ScenarioError);
    expect(() => source.roll("3+1d8+0")).not.toThrow();
  });

  test("throws a ScenarioError on exhaustion", () => {
    const source = new ScriptedDiceSource([]);
    expect(() => source.roll("1d20")).toThrow(ScenarioError);
    expect(() => source.permutation(3)).toThrow(ScenarioError);
  });

  test("throws a ScenarioError on a kind mismatch", () => {
    expect(() => new ScriptedDiceSource([roll("1d6", [2], 2)]).permutation(2)).toThrow(
      ScenarioError,
    );
    expect(() =>
      new ScriptedDiceSource([{ type: "permutation", order: [1, 0] }]).roll("1d6"),
    ).toThrow(ScenarioError);
  });

  test("a permutation entry must be a permutation of the requested length", () => {
    const wrongLength = new ScriptedDiceSource([{ type: "permutation", order: [1, 0] }]);
    expect(() => wrongLength.permutation(3)).toThrow(ScenarioError);
    const notAPermutation = new ScriptedDiceSource([{ type: "permutation", order: [0, 0, 1] }]);
    expect(() => notAPermutation.permutation(3)).toThrow(ScenarioError);
    const good = new ScriptedDiceSource([{ type: "permutation", order: [2, 0, 1] }]);
    expect(good.permutation(3)).toEqual([2, 0, 1]);
  });

  test("an entry whose expr does not parse is a ScenarioError", () => {
    const source = new ScriptedDiceSource([roll("1d", [1], 1)]);
    expect(() => source.roll("1d6")).toThrow(ScenarioError);
  });

  test("mark and reset move the position; remaining counts what is left", () => {
    const source = new ScriptedDiceSource([
      roll("1d4", [1], 1),
      roll("1d6", [2], 2),
      { type: "permutation", order: [0] },
    ]);
    expect(source.remaining()).toBe(3);
    source.roll("1d4");
    const m = source.mark();
    source.roll("1d6");
    source.permutation(1);
    expect(source.remaining()).toBe(0);
    source.reset(m);
    expect(source.remaining()).toBe(2);
    expect(source.roll("1d6")).toEqual(roll("1d6", [2], 2));
  });

  test("handed-out entries are copies", () => {
    const entry = roll("1d4", [1], 1);
    const source = new ScriptedDiceSource([entry]);
    const out = source.roll("1d4");
    out.dice.push(9);
    source.reset(0);
    expect(source.roll("1d4")).toEqual(roll("1d4", [1], 1));
  });
});

describe("rollInto and shuffleWith", () => {
  test("rollInto writes the scripted roll with cause roll", () => {
    const table = fixture();
    const source = new ScriptedDiceSource([roll("1d20", [14], 14)]);
    const result = table.store.transact(gm, edit, (tx) => {
      expect(rollInto(tx, source, "goblin", "save", "1d20")).toEqual(roll("1d20", [14], 14));
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.effects).toContainEqual(
      expect.objectContaining({ type: "cell", object: "goblin", cell: "save", cause: "roll" }),
    );
    expect(table.value("goblin", "save")).toEqual(roll("1d20", [14], 14));
    expect(source.remaining()).toBe(0);
  });

  test("shuffleWith applies new[i] = old[order[i]]", () => {
    const table = fixture();
    const source = new ScriptedDiceSource([{ type: "permutation", order: [2, 0, 1] }]);
    table.store.transact(gm, edit, (tx) => {
      expect(shuffleWith(tx, source, "three")).toEqual([2, 0, 1]);
    });
    expect(contents(table, "three")).toEqual(["t2", "t0", "t1"]);
    expect(table.value("three", "contents")).toEqual(list([ref("t2"), ref("t0"), ref("t1")]));
  });
});

describe("transactWithDice with a scripted source", () => {
  test("an aborted (refused) transaction consumes no script entries", () => {
    const table = fixture();
    const source = new ScriptedDiceSource([
      roll("1d20", [3], 3),
      { type: "permutation", order: [2, 1, 0] },
    ]);
    const result = transactWithDice(table, gm, edit, source, (tx) => {
      rollInto(tx, source, "goblin", "save", "1d20");
      writeValue(tx, "goblin", "id", num(1));
    });
    expect(result.ok).toBe(false);
    expect(source.remaining()).toBe(2);
    expect(table.value("goblin", "save")).toEqual(num(0));
  });

  test("a ScenarioError inside propagates unchanged and the source is reset", () => {
    const table = fixture();
    const source = new ScriptedDiceSource([roll("1d20", [3], 3)]);
    let thrown: unknown;
    let caught: unknown;
    try {
      transactWithDice(table, gm, edit, source, (tx) => {
        rollInto(tx, source, "goblin", "save", "1d20");
        try {
          rollInto(tx, source, "goblin", "save", "1d20");
        } catch (e) {
          thrown = e;
          throw e;
        }
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScenarioError);
    expect(caught).toBe(thrown);
    expect(source.remaining()).toBe(1);
    expect(table.store.openTransaction).toBeNull();
    expect(table.store.revision).toBe(0);
  });

  test("any other error before the commit point propagates unchanged and resets", () => {
    const table = fixture();
    const source = new ScriptedDiceSource([roll("1d20", [3], 3)]);
    const boom = new Error("boom");
    expect(() =>
      transactWithDice(table, gm, edit, source, (tx) => {
        rollInto(tx, source, "goblin", "save", "1d20");
        throw boom;
      }),
    ).toThrow(boom);
    expect(source.remaining()).toBe(1);
  });

  test("a committed transaction whose public listener throws keeps its consumed entries", () => {
    const table = fixture();
    const source = new ScriptedDiceSource([roll("1d20", [3], 3), roll("1d6", [1], 1)]);
    table.store.onCommit(() => {
      throw new Error("listener");
    });
    const result = transactWithDice(table, gm, edit, source, (tx) => {
      rollInto(tx, source, "goblin", "save", "1d20");
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.listenerErrors).toHaveLength(1);
    expect(source.remaining()).toBe(1);
    expect(table.value("goblin", "save")).toEqual(roll("1d20", [3], 3));
  });

  test("a Rejected thrown directly returns the rejection", () => {
    const table = fixture();
    const source = new ScriptedDiceSource([roll("1d20", [3], 3)]);
    const result = transactWithDice(table, gm, edit, source, (tx) => {
      rollInto(tx, source, "goblin", "save", "1d20");
      throw new Rejected({ type: "invalid", message: "no" });
    });
    expect(result).toEqual({ ok: false, rejection: { type: "invalid", message: "no" } });
    expect(source.remaining()).toBe(1);
  });
});

describe("RandomDiceSource", () => {
  /** The latter three draws, in a committed transaction. */
  function latter(table: Table, source: DiceSource) {
    const out: unknown[] = [];
    const result = transactWithDice(table, gm, edit, source, (tx) => {
      out.push(rollInto(tx, source, "goblin", "save", "3d6"));
      out.push(rollInto(tx, source, "goblin", "save", "1d100"));
      out.push(shuffleWith(tx, source, "three"));
    });
    expect(result.ok).toBe(true);
    out.push(contents(table, "three"));
    return out;
  }

  function control(seed: number) {
    return latter(fixture(), new RandomDiceSource(seed));
  }

  test("an aborted transaction consumes no randomness", () => {
    for (const seed of [1, 42, 0xdeadbeef]) {
      const table = fixture();
      const source = new RandomDiceSource(seed);
      expect(() =>
        transactWithDice(table, gm, edit, source, (tx) => {
          rollInto(tx, source, "goblin", "save", "1d20");
          shuffleWith(tx, source, "five");
          throw new Error("abort");
        }),
      ).toThrow("abort");
      expect(latter(table, source)).toEqual(control(seed));
    }
  });

  test("a refused transaction consumes no randomness", () => {
    for (const seed of [7, 99]) {
      const table = fixture();
      const source = new RandomDiceSource(seed);
      const refused = transactWithDice(table, gm, edit, source, (tx) => {
        rollInto(tx, source, "goblin", "save", "1d20");
        shuffleWith(tx, source, "five");
        writeValue(tx, "goblin", "id", num(1));
      });
      expect(refused.ok).toBe(false);
      expect(latter(table, source)).toEqual(control(seed));
    }
  });

  test("seeded runs are deterministic; different seeds differ", () => {
    const draw = (seed: number) => {
      const s = new RandomDiceSource(seed);
      return [s.roll("10d20"), s.permutation(10), s.roll("4dF"), s.roll("2d1000000")];
    };
    expect(draw(5)).toEqual(draw(5));
    expect(draw(5)).not.toEqual(draw(6));
  });

  test("mark and reset restore the state whatever ranges are requested next", () => {
    const s = new RandomDiceSource(123);
    const m = s.mark();
    s.roll("50d7");
    s.permutation(9);
    s.reset(m);
    const after = [s.roll("1d100"), s.permutation(4)];
    const fresh = new RandomDiceSource(123);
    expect(after).toEqual([fresh.roll("1d100"), fresh.permutation(4)]);
  });

  test("rolls are in range and permutations are permutations", () => {
    const s = new RandomDiceSource(2024);
    for (let i = 0; i < 200; i++) {
      const r = s.roll("3d6");
      expect(r.dice).toHaveLength(3);
      for (const d of r.dice) expect(d >= 1 && d <= 6).toBe(true);
      const f = s.roll("1dF");
      expect([-1, 0, 1]).toContain(f.total);
      const p = s.permutation(i % 7);
      expect([...p].sort((a, b) => a - b)).toEqual([...Array(i % 7).keys()]);
    }
  });

  test("every face of a d6 appears with roughly equal frequency", () => {
    const s = new RandomDiceSource(31337);
    const counts = [0, 0, 0, 0, 0, 0];
    const n = 60_000;
    for (let i = 0; i < n; i++) {
      const v = s.roll("1d6").total;
      counts[v - 1] = (counts[v - 1] ?? 0) + 1;
    }
    for (const k of counts) expect(Math.abs(k - n / 6)).toBeLessThan(n / 6 / 10);
  });

  test("a roll's expr is the normalized expression", () => {
    expect(new RandomDiceSource(1).roll("d20+2").expr).toBe("1d20+2");
  });
});
