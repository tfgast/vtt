import { createEngine, DEFAULT_BUDGET, type Engine } from "@vtt/formula";
import { bool, list, num, type Result, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { doc, formula, type ObjectSpec } from "./support/engine-doc";
import type { MemoryHost } from "./support/memory-host";

const limit = (object?: string, cell?: string) =>
  object === undefined
    ? { type: "error", code: "#LIMIT" }
    : { type: "error", code: "#LIMIT", origin: { object, cell } };

/** `source` evaluated as the cell `o.f` of a fresh engine with `budget`. */
function costAt(host: MemoryHost, source: string, budget: number): Result {
  host.replaceContent("o", "f", formula(source));
  return createEngine(host, { budget }).value("o", "f");
}

/** Asserts `source` on `o` costs exactly `cost`: fine at `cost`, #LIMIT at `cost - 1`. */
function expectCost(host: MemoryHost, source: string, cost: number) {
  expect(costAt(host, source, cost)).not.toMatchObject({ code: "#LIMIT" });
  expect(costAt(host, source, cost - 1)).toMatchObject(limit("o", "f"));
}

describe("budget", () => {
  test("defaults to 20,000", () => {
    expect(DEFAULT_BUDGET).toBe(20_000);
  });

  test("objects() over 30 objects with budget 50 is #LIMIT; a sibling cell is fine", () => {
    const objects: Record<string, ObjectSpec> = {};
    for (let i = 0; i < 30; i++) objects[`t${String(i).padStart(2, "0")}`] = { cells: { v: i } };
    objects.o = {
      cells: { every: "=count(objects(true))", sib: "=1 + 2", uses: "=every + 1" },
    };
    const host = doc(objects);
    const engine = createEngine(host, { budget: 50 });
    expect(engine.value("o", "every")).toMatchObject(limit("o", "every"));
    expect(engine.value("o", "sib")).toEqual(num(3));
    // Dependents see the propagated error, origin intact.
    expect(engine.value("o", "uses")).toMatchObject(limit("o", "every"));
    // The default budget is plenty.
    expect(createEngine(host).value("o", "every")).toEqual(num(31));
  });

  describe("cost rules", () => {
    const host = () =>
      doc({
        o: { cells: { a: 1, b: 2, c: 3, r: ref("goblin"), rs: list([ref("goblin"), ref("o")]) } },
        goblin: { cells: { name: text("Goblin"), v: "=a0 + 1", a0: 1 } },
        orc: { cells: { name: text("Orc") } },
      });

    test("each cell read costs 1", () => {
      expectCost(host(), "a + b + c", 3);
      // No reads, no charge.
      expect(costAt(host(), "1 + 2", 0)).toEqual(num(3));
    });

    test("a missing cell read costs 1", () => {
      // `#NAME` is not `#LIMIT`.
      expect(costAt(host(), "nothing", 1)).toMatchObject({ code: "#NAME" });
      expect(costAt(host(), "nothing", 0)).toMatchObject(limit("o", "f"));
    });

    test("each existence check costs 1, including those validating a read reference", () => {
      expectCost(host(), "r", 2);
      expectCost(host(), "rs", 3);
      expectCost(host(), 'obj("goblin")', 1);
    });

    test("an already computed formula dependency costs 1 regardless of its cost", () => {
      const h = host();
      // r (1) + validating the ref it holds (1) + the dot's existence check (1)
      // + reading goblin.v (1), whatever goblin.v itself cost.
      expectCost(h, "r.v", 4);
      // goblin.v now spends the whole budget of 4 itself; r.v still fits in 4.
      h.replaceContent("goblin", "v", formula("a0 + a0 + a0 + a0"));
      h.replaceContent("o", "f", formula("r.v"));
      const engine = createEngine(h, { budget: 4 });
      expect(engine.value("goblin", "v")).toEqual(num(4));
      expect(engine.value("o", "f")).toEqual(num(4));
      expect(costAt(h, "r.v", 3)).toMatchObject({ code: "#LIMIT" });
    });

    test("each id objectsNamed or allObjects returns costs 1", () => {
      // exists("Goblin") 1 + one id named Goblin 1 + reading its name 1.
      expectCost(host(), 'obj("Goblin")', 3);
      // allObjects: 3 ids; the predicate `true` reads nothing; each kept object's z: 1.
      expectCost(host(), "count(objects(true))", 6);
      expectCost(host(), "count(objects(false))", 3);
    });

    test("each candidate a spatial query tests costs 1", () => {
      // Every object sits at [0, 0] on table: a, b, c and the zone o are candidates.
      const h = doc({ a: {}, b: {}, c: {}, far: {} });
      h.move("far", { board: "table", position: [50, 50] });
      h.createObject("o", {
        is_zone: true,
        shape: { type: "rect", width: 2, height: 2 },
        placement: { board: "table", position: [0, 0] },
      });
      // exists(o) 1 + 6 zone geometry reads + 4 candidates (a, b, c, o)
      // + 6 geometry reads for each of a, b, c (the zone itself is skipped)
      // + 4 existence checks validating the `board` refs read = 33.
      expectCost(h, "contents(this)", 33);
    });
  });

  test("probe attempts are not charged: identical cold, warm, and in any read order", () => {
    const cellsOf = (): Record<string, string | number> => ({
      base: 1,
      x1: "=base * 2",
      x2: "=x1 + base",
      x3: "=base + 3",
      x4: "=x2 + x3",
      x5: "=base",
      // Five reads of formula cells: costs exactly 5, the budget.
      s5: "=x1 + x2 + x3 + x4 + x5",
      // Six reads: one over.
      s6: "=x1 + x2 + x3 + x4 + x5 + base",
      t: "=s5 + s6",
      u: "=s5 * 2",
    });
    const names = Object.keys(cellsOf());
    const fresh = () => createEngine(doc({ o: { cells: cellsOf() } }), { budget: 5 });
    const readAll = (engine: Engine, order: readonly string[]) =>
      Object.fromEntries(order.map((c) => [c, engine.value("o", c)]));

    const engine = fresh();
    const cold = readAll(engine, names);
    expect(cold.s5).toEqual(num(17));
    expect(cold.s6).toMatchObject(limit("o", "s6"));
    expect(cold.t).toMatchObject(limit("o", "s6"));
    expect(cold.u).toEqual(num(34));
    // Warm: every read again.
    expect(readAll(engine, names)).toEqual(cold);
    // Cold in other orders, and after warming some dependencies first.
    const orders = [[...names].reverse(), ["t", "u", ...names], ["s6", "s5", ...names]];
    for (const order of orders) {
      const e = fresh();
      readAll(e, order);
      expect(readAll(e, names)).toEqual(cold);
    }
    for (const warm of [["x4"], ["x1", "x5"], ["x2", "x3"]]) {
      const e = fresh();
      readAll(e, warm);
      expect(readAll(e, names)).toEqual(cold);
    }
  });

  test("a limit is recomputed when an earlier read changes", () => {
    const host = doc({ o: { cells: { big: bool(true), f: "=if(big, a + a + a, a)", a: 1 } } });
    const engine = createEngine(host, { budget: 3 });
    expect(engine.value("o", "f")).toMatchObject(limit("o", "f"));
    engine.invalidate(host.set("o", "big", bool(false)));
    expect(engine.value("o", "f")).toEqual(num(1));
  });

  test("ad hoc evaluation is budgeted, with no origin", () => {
    const host = doc({ o: { cells: { a: 1, x: "=a + a + a" } } });
    const engine = createEngine(host, { budget: 3 });
    expect(engine.evaluate("a + a + a", { thisId: "o" })).toEqual(num(3));
    const r = engine.evaluate("a + a + a + a", { thisId: "o" });
    expect(r).toEqual({ type: "error", code: "#LIMIT", message: expect.any(String) });
    // Reading the (affordable) formula cell costs 1.
    expect(engine.evaluate("x + x + x", { thisId: "o" })).toEqual(num(9));
  });
});
