import { EMPTY, err, list, num, type Result, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { type FakeCells, FakeEnv } from "./support/fake-env";
import { LoggingEnv, placed } from "./support/geometry-cells";

const refs = (...ids: string[]) => list(ids.map(ref));

describe("distance(a, b)", () => {
  function cells(): FakeCells {
    return {
      table: {},
      shelf: {},
      self: { a: ref("p"), b: ref("q"), c: ref("boxed"), d: ref("bad"), e: ref("over") },
      p: placed("table", [0, 0]),
      q: placed("table", [3, 4], { shape: { type: "rect", width: 2, height: 2 }, rotation: 30 }),
      boxed: { name: text("in a cup") },
      bad: placed("table", [1, 1], { cells: { position: list([num(1)]) } }),
      over: placed("shelf", [3, 4]),
    };
  }

  test("is Euclidean between anchors", () => {
    expect(run("distance(a, b)", cells())).toEqual(num(5));
    expect(run("distance(b, a)", cells())).toEqual(num(5));
    expect(run("distance(a, a)", cells())).toEqual(num(0));
  });

  test("is empty for a contained object or an invalid position", () => {
    expect(run("distance(a, c)", cells())).toEqual(EMPTY);
    expect(run("distance(c, a)", cells())).toEqual(EMPTY);
    expect(run("distance(a, d)", cells())).toEqual(EMPTY);
    expect(run("distance(d, a)", cells())).toEqual(EMPTY);
    // Empty even when the other object is on a different board.
    expect(run("distance(c, e)", cells())).toEqual(EMPTY);
  });

  test("a non-finite distance is #TYPE", () => {
    const env = new FakeEnv({
      table: {},
      self: { a: ref("west"), b: ref("east") },
      west: placed("table", [-1e308, 0]),
      east: placed("table", [1e308, 0]),
    });
    expect(run("distance(a, b)", env)).toMatchObject({ code: "#TYPE" });
  });

  test("is #TYPE across boards", () => {
    expect(run("distance(a, e)", cells())).toMatchObject({ code: "#TYPE" });
  });

  test("an error reading either position is the result", () => {
    const c = cells();
    (c.q as Record<string, Result>).position = err("#CYCLE");
    expect(run("distance(a, b)", c)).toMatchObject({ code: "#CYCLE" });
    expect(run("distance(c, b)", c)).toMatchObject({ code: "#CYCLE" });
    const d = cells();
    (d.p as Record<string, Result>).position = err("#DIV0");
    (d.q as Record<string, Result>).position = err("#CYCLE");
    expect(run("distance(a, b)", d)).toMatchObject({ code: "#DIV0" });
  });

  test("arguments must be references", () => {
    expect(run("distance(a, empty)", cells())).toMatchObject({ code: "#TYPE" });
    expect(run('distance("p", b)', cells())).toMatchObject({ code: "#TYPE" });
    expect(run("distance([a], b)", cells())).toMatchObject({ code: "#TYPE" });
    expect(run("distance(a)", cells())).toMatchObject({ code: "#TYPE" });
    expect(run("distance(a, missing_zz)", cells())).toMatchObject({ code: "#NAME" });
  });
});

describe("objects(expr)", () => {
  function cells(): FakeCells {
    return {
      table: {},
      self: { hp: num(1) },
      goblin: placed("table", [0, 0], { z: 2, cells: { hp: num(7) } }),
      broken: placed("table", [0, 0], { cells: { position: text("nowhere"), hp: num(4) } }),
      potion: { hp: num(0), name: text("in a bag") },
      tmpl: { hp: num(9) },
      orc: placed("table", [5, 5], { z: 1, cells: { hp: num(12) } }),
    };
  }
  const order = ["orc", "self", "table", "tmpl", "potion", "goblin", "broken"];
  /** Every object that has an `hp` cell. */
  const withHp = order.filter((id) => id !== "table");

  test("objects(true) is every object, invalid positions and contained objects included", () => {
    const env = new FakeEnv(cells(), { allObjects: order });
    // z: empty (0) for broken, potion, self, table, tmpl; orc 1; goblin 2.
    expect(run("objects(true)", env)).toEqual(
      refs("broken", "potion", "self", "table", "tmpl", "orc", "goblin"),
    );
  });

  test("bare names are the candidate's cells and `it` is the candidate", () => {
    const env = new FakeEnv(cells(), { allObjects: withHp });
    expect(run("objects(hp > 3)", env)).toEqual(refs("broken", "tmpl", "orc", "goblin"));
    expect(run("objects(hp)", env)).toEqual(refs("broken", "self", "tmpl", "orc", "goblin"));
    expect(run("objects(it != this and hp > this.hp)", env)).toEqual(
      refs("broken", "tmpl", "orc", "goblin"),
    );
  });

  test("the first error in id order is the result, whatever the host order", () => {
    // table has no hp: #NAME; but `broken` comes first and divides by zero.
    const c = cells();
    (c.broken as Record<string, Result>).hp = err("#DIV0", "broken");
    const ids = [...order];
    for (let i = 0; i < ids.length; i++) {
      ids.push(ids.shift() as string);
      const env = new FakeEnv(c, { allObjects: [...ids] });
      expect(run("objects(hp > 3)", env)).toMatchObject({ code: "#DIV0", message: "broken" });
    }
    const d = cells();
    expect(run("objects(hp > 3)", new FakeEnv(d, { allObjects: order }))).toMatchObject({
      code: "#NAME",
    });
  });

  test("evaluates the predicate per candidate in id order", () => {
    const env = new LoggingEnv(cells(), { allObjects: withHp });
    run("objects(it = this or hp > 100)", env);
    const hpReads = env.reads.filter((r) => r.endsWith(".hp")).map((r) => r.split(".")[0]);
    expect(hpReads).toEqual(["broken", "goblin", "orc", "potion", "tmpl"]);
  });

  test("a z that cannot order is #TYPE; a z read error is the result", () => {
    const c = cells();
    (c.orc as Record<string, Result>).z = text("top");
    expect(run("objects(true)", new FakeEnv(c, { allObjects: order }))).toMatchObject({
      code: "#TYPE",
    });
    // Not kept, so its z does not matter.
    expect(run("objects(hp < 5)", new FakeEnv(c, { allObjects: withHp }))).not.toMatchObject({
      type: "error",
    });
    (c.orc as Record<string, Result>).z = err("#CYCLE");
    expect(run("objects(true)", new FakeEnv(c, { allObjects: order }))).toMatchObject({
      code: "#CYCLE",
    });
  });

  test("an argument count other than one is #TYPE; a list result is kept as truthy", () => {
    expect(run("objects()", cells())).toMatchObject({ code: "#TYPE" });
    expect(run("objects(true, true)", cells())).toMatchObject({ code: "#TYPE" });
    const env = new FakeEnv({ self: {}, a: {} }, { allObjects: ["a", "self"] });
    expect(run("objects([1])", env)).toEqual(refs("a", "self"));
    expect(run("objects([])", env)).toEqual(list([]));
  });
});

describe("obj(x)", () => {
  function cells(): FakeCells {
    return {
      self: {},
      aldric: { name: text("Aldric") },
      g1: { name: text("Goblin") },
      g2: { name: text("Goblin") },
      x: { name: text("y") },
      y: { name: text("Why") },
    };
  }

  test("finds an object by literal name", () => {
    expect(run('obj("Aldric")', cells())).toEqual(ref("aldric"));
  });

  test("an exact id wins", () => {
    expect(run('obj("aldric")', cells())).toEqual(ref("aldric"));
    expect(run('obj("y")', cells())).toEqual(ref("y"));
  });

  test("zero or several name matches are #REF", () => {
    expect(run('obj("Nobody")', cells())).toMatchObject({ code: "#REF" });
    expect(run('obj("Goblin")', cells())).toMatchObject({ code: "#REF" });
    expect(run('obj("ALDRIC")', cells())).toMatchObject({ code: "#REF" });
  });

  test("a non-text argument is #TYPE, and it does not broadcast", () => {
    expect(run("obj(1)", cells())).toMatchObject({ code: "#TYPE" });
    expect(run("obj(empty)", cells())).toMatchObject({ code: "#TYPE" });
    expect(run("obj(this)", cells())).toMatchObject({ code: "#TYPE" });
    expect(run('obj(["aldric"])', cells())).toMatchObject({ code: "#TYPE" });
    expect(run("obj(1 / 0)", cells())).toMatchObject({ code: "#DIV0" });
  });

  test("reads the found object's name cell, so the dependency is recorded", () => {
    const env = new LoggingEnv(cells());
    expect(run('obj("Aldric")', env)).toEqual(ref("aldric"));
    expect(env.reads).toContain("aldric.name");
  });

  test("uses the host's name lookup", () => {
    const env = new FakeEnv(cells(), { objectsNamed: { Boss: ["g2"] } });
    expect(run('obj("Boss")', env)).toEqual(ref("g2"));
  });
});
