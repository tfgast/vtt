import { EMPTY, err, list, num, type Result, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { type FakeCells, FakeEnv } from "./support/fake-env";
import { LoggingEnv, placed, zone } from "./support/geometry-cells";

const refs = (...ids: string[]) => list(ids.map(ref));

/** Evaluates `source` with `thisId` as `this` over `cells` and candidate stubs. */
function query(
  source: string,
  thisId: string,
  cells: FakeCells,
  onBoard: Record<string, string[]> = {},
): Result {
  return run(source, new FakeEnv(cells, { objectsOnBoard: onBoard }), { scope: { thisId } });
}

const RECT4 = { type: "rect", width: 4, height: 4 } as const;
const UNIT = { type: "rect", width: 1, height: 1 } as const;

/** The dice-tray.json tray (rect 4x4 at [10, 0], so x 8..12, y -2..2) and some dice. */
function trayCells(): FakeCells {
  return {
    table: {},
    tray: zone("table", [10, 0], RECT4),
    d1: placed("table", [9, 0], { shape: UNIT, z: 0 }),
    d2: placed("table", [11, 1], { shape: UNIT, z: 0 }),
    token: placed("table", [10, -1], { shape: { type: "circle", radius: 0.5 }, z: 1 }),
    far: placed("table", [0, 0], { shape: UNIT, z: 0 }),
  };
}

describe("contents(zone)", () => {
  test("the dice tray holds the dice whose anchors are inside, by z then id", () => {
    const r = query("contents(this)", "tray", trayCells(), {
      table: ["d2", "token", "d1", "far", "tray"],
    });
    expect(r).toEqual(refs("d1", "d2", "token"));
  });

  test("an empty z sorts as 0 and roll results sort by total", () => {
    const cells = trayCells();
    delete cells.d1?.z;
    (cells.d2 as Record<string, Result>).z = {
      type: "roll",
      expr: "1d6",
      dice: [2],
      dropped: [],
      total: 2,
    };
    const r = query("contents(this)", "tray", cells, { table: ["d2", "token", "d1"] });
    expect(r).toEqual(refs("d1", "token", "d2"));
  });

  test("a z that is not a number, empty, or roll is #TYPE", () => {
    const cells = trayCells();
    (cells.d1 as Record<string, Result>).z = text("high");
    expect(query("contents(this)", "tray", cells, { table: ["d1"] })).toMatchObject({
      code: "#TYPE",
    });
  });

  test("a candidate exactly on the boundary is inside", () => {
    const cells: FakeCells = {
      table: {},
      tray: zone("table", [10, 0], RECT4),
      corner: placed("table", [12, 2]),
      edge: placed("table", [8, 0]),
      just_out: placed("table", [12.000001, 0]),
    };
    const r = query("contents(this)", "tray", cells, { table: ["just_out", "edge", "corner"] });
    expect(r).toEqual(refs("corner", "edge"));
  });

  test("a rotated zone includes a point only inside after rotation", () => {
    // 4 wide, 2 high, turned 90°: x -1..1, y -2..2.
    const cells: FakeCells = {
      table: {},
      wall: zone("table", [0, 0], { type: "rect", width: 4, height: 2 }, { rotation: 90 }),
      inside_after: placed("table", [0, 1.5]),
      inside_before: placed("table", [1.5, 0]),
    };
    const r = query("contents(this)", "wall", cells, {
      table: ["inside_before", "inside_after"],
    });
    expect(r).toEqual(refs("inside_after"));
  });

  test("the fireball circle holds the goblins inside radius 4", () => {
    const circle = { type: "circle", radius: 4 } as const;
    const goblin = { shape: { type: "circle", radius: 0.5 } as const };
    const cells: FakeCells = {
      map: {},
      fireball_zone: zone("map", [10, 10], circle),
      goblin1: placed("map", [9, 10], goblin),
      goblin2: placed("map", [12, 10], goblin),
      rock_outside: placed("map", [16, 10], goblin),
    };
    const r = query("contents(this)", "fireball_zone", cells, {
      map: ["goblin2", "goblin1", "rock_outside"],
    });
    expect(r).toEqual(refs("goblin1", "goblin2"));
  });

  test("an object that is not a zone is #TYPE", () => {
    const cells = trayCells();
    expect(query("contents(this)", "d1", cells, { table: ["d2"] })).toMatchObject({
      code: "#TYPE",
    });
    // is_zone false explicitly, too.
    (cells.d1 as Record<string, Result>).is_zone = { type: "boolean", value: false };
    expect(query("contents(this)", "d1", cells)).toMatchObject({ code: "#TYPE" });
  });

  test("empty, a non-reference, and a list are #TYPE", () => {
    const cells = trayCells();
    expect(query("contents(empty)", "tray", cells)).toMatchObject({ code: "#TYPE" });
    expect(query('contents("tray")', "tray", cells)).toMatchObject({ code: "#TYPE" });
    expect(query("contents(3)", "tray", cells)).toMatchObject({ code: "#TYPE" });
    expect(query("contents([this])", "tray", cells, { table: ["d1"] })).toMatchObject({
      code: "#TYPE",
    });
  });

  test("a reference to a deleted zone is #REF", () => {
    // FakeEnv's read already turns the dangling reference into #REF.
    expect(run("contents(gone)", { self: { gone: ref("vanished") } })).toMatchObject({
      code: "#REF",
    });
  });

  test("the function itself checks existence when reads do not validate references", () => {
    class RawEnv extends FakeEnv {
      override read(id: string, cell: string): Result | undefined {
        return id === "self" && cell === "target" ? ref("vanished") : super.read(id, cell);
      }
    }
    const env = new RawEnv({ self: {} });
    for (const fn of ["contents", "zones_containing", "on"]) {
      expect(run(`${fn}(target)`, env)).toMatchObject({ code: "#REF" });
    }
    expect(run("distance(target, this)", env)).toMatchObject({ code: "#REF" });
    expect(run("distance(this, target)", env)).toMatchObject({ code: "#REF" });
  });

  test("a zone inside a container gives []", () => {
    const cells = trayCells();
    cells.tray = {
      is_zone: { type: "boolean", value: true },
      shape: { type: "shape", shape: RECT4 },
    };
    expect(query("contents(this)", "tray", cells, { table: ["d1"] })).toEqual(list([]));
  });

  test("a zone without a shape or with an invalid position gives []", () => {
    const cells = trayCells();
    delete cells.tray?.shape;
    expect(query("contents(this)", "tray", cells, { table: ["d1"] })).toEqual(list([]));
    const bad = trayCells();
    (bad.tray as Record<string, Result>).position = list([num(10)]);
    expect(query("contents(this)", "tray", bad, { table: ["d1"] })).toEqual(list([]));
  });

  test("a zone whose position reads as an error returns that error", () => {
    const cells = trayCells();
    (cells.tray as Record<string, Result>).position = err("#DIV0", "boom");
    expect(query("contents(this)", "tray", cells, { table: ["d1"] })).toMatchObject({
      code: "#DIV0",
    });
    (cells.tray as Record<string, Result>).position = err("#CYCLE");
    expect(query("contents(this)", "tray", cells, { table: ["d1"] })).toMatchObject({
      code: "#CYCLE",
    });
  });

  test("an error in a zone's geometry wins even when the zone is not a zone", () => {
    const cells = trayCells();
    (cells.d1 as Record<string, Result>).z = err("#DIV0");
    expect(query("contents(this)", "d1", cells)).toMatchObject({ code: "#DIV0" });
  });

  test("asks for candidates near the zone's rotated bounds on its own board", () => {
    const env = new LoggingEnv(
      {
        table: {},
        wall: zone("table", [0, 0], { type: "rect", width: 4, height: 2 }, { rotation: 90 }),
      },
      {},
    );
    run("contents(this)", env, { scope: { thisId: "wall" } });
    expect(env.nearCalls).toEqual([
      { board: "table", near: { minX: -1, minY: -2, maxX: 1, maxY: 2 } },
    ]);
  });

  test("reads the zone's geometry first, then candidates in id order", () => {
    const cells = trayCells();
    const env = new LoggingEnv(cells, { objectsOnBoard: { table: ["far", "d2", "d1"] } });
    run("contents(this)", env, { scope: { thisId: "tray" } });
    const owners = env.reads.map((r) => r.split(".")[0]);
    const firstOf = (id: string) => owners.indexOf(id);
    expect(firstOf("tray")).toBe(0);
    expect(firstOf("tray")).toBeLessThan(firstOf("d1"));
    expect(firstOf("d1")).toBeLessThan(firstOf("d2"));
    expect(firstOf("d2")).toBeLessThan(firstOf("far"));
    // Every geometry cell is read through env.read.
    for (const cell of ["board", "position", "rotation", "z", "shape", "is_zone"]) {
      expect(env.reads).toContain(`tray.${cell}`);
      expect(env.reads).toContain(`d1.${cell}`);
    }
  });
});

describe("candidate evaluation", () => {
  test("a candidate whose position reads as #DIV0 or #CYCLE makes the query that error", () => {
    const cells = trayCells();
    (cells.far as Record<string, Result>).position = err("#DIV0");
    expect(query("contents(this)", "tray", cells, { table: ["d1", "far", "d2"] })).toMatchObject({
      code: "#DIV0",
    });
    (cells.far as Record<string, Result>).position = err("#CYCLE");
    expect(query("contents(this)", "tray", cells, { table: ["d1", "far", "d2"] })).toMatchObject({
      code: "#CYCLE",
    });
  });

  test("an error in any geometry read of a candidate is the result", () => {
    for (const cell of ["board", "rotation", "z", "shape", "is_zone"]) {
      const cells = trayCells();
      (cells.d2 as Record<string, Result>)[cell] = err("#DIV0", cell);
      expect(query("contents(this)", "tray", cells, { table: ["d1", "d2"] })).toMatchObject({
        code: "#DIV0",
        message: cell,
      });
    }
  });

  test("a candidate whose position is a valid non-position value is excluded", () => {
    const cells = trayCells();
    (cells.d1 as Record<string, Result>).position = text("[9, 0]");
    (cells.d2 as Record<string, Result>).position = list([num(11)]);
    (cells.token as Record<string, Result>).position = list([num(10), text("-1")]);
    (cells.far as Record<string, Result>).position = EMPTY;
    const r = query("contents(this)", "tray", cells, { table: ["d1", "d2", "token", "far"] });
    expect(r).toEqual(list([]));
  });

  test("permuted host answers with two failing candidates return the lower id's error", () => {
    const cells = trayCells();
    (cells.d2 as Record<string, Result>).position = err("#DIV0", "d2");
    (cells.far as Record<string, Result>).position = err("#CYCLE", "far");
    const ids = ["d1", "d2", "token", "far"];
    const perms: string[][] = [];
    const permute = (rest: string[], acc: string[]) => {
      if (rest.length === 0) perms.push(acc);
      rest.forEach((x, i) => {
        permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]);
      });
    };
    permute(ids, []);
    expect(perms).toHaveLength(24);
    for (const p of perms) {
      expect(query("contents(this)", "tray", cells, { table: p })).toMatchObject({
        code: "#DIV0",
        message: "d2",
      });
    }
  });

  test("a host returning extra non-matching candidates changes no result", () => {
    const base = trayCells();
    const extra: FakeCells = {
      ...base,
      other_board: {},
      elsewhere: placed("other_board", [10, 0]),
      far2: placed("table", [100, 100]),
      boxed: { name: text("in a cup") },
    };
    const minimal = query("contents(this)", "tray", base, { table: ["d1", "d2", "token"] });
    const padded = query("contents(this)", "tray", extra, {
      table: ["far2", "boxed", "d1", "elsewhere", "d2", "far", "token", "tray", "d1"],
    });
    expect(padded).toEqual(minimal);
    expect(padded).toEqual(refs("d1", "d2", "token"));
  });
});

describe("zones_containing(obj)", () => {
  function cells(tokenAt: [number, number]): FakeCells {
    return {
      table: {},
      tray: zone("table", [10, 0], RECT4, { z: 0 }),
      fog: zone("table", [10, 0], { type: "circle", radius: 1 }, { z: 2 }),
      shapeless_zone: placed("table", [10, 0], { isZone: true }),
      plain: placed("table", [10, 0], { shape: RECT4 }),
      token: placed("table", tokenAt, { z: 5 }),
    };
  }
  const all = { table: ["token", "plain", "fog", "tray", "shapeless_zone"] };

  test("returns the zones whose region holds the anchor while inside, [] after moving out", () => {
    expect(query("zones_containing(this)", "token", cells([11.5, 0]), all)).toEqual(refs("tray"));
    expect(query("zones_containing(this)", "token", cells([10, 0.5]), all)).toEqual(
      refs("tray", "fog"),
    );
    expect(query("zones_containing(this)", "token", cells([20, 0]), all)).toEqual(list([]));
  });

  test("an object is never a zone containing itself", () => {
    expect(query("zones_containing(this)", "tray", cells([0, 0]), all)).toEqual(refs("fog"));
  });

  test("asks for candidates at the degenerate box of the anchor", () => {
    const env = new LoggingEnv(cells([11, 1]), { objectsOnBoard: all });
    run("zones_containing(this)", env, { scope: { thisId: "token" } });
    expect(env.nearCalls).toEqual([
      { board: "table", near: { minX: 11, minY: 1, maxX: 11, maxY: 1 } },
    ]);
  });

  test("not on a board or an invalid position gives []; bad arguments are #TYPE", () => {
    const c = cells([11, 0]);
    c.token = { name: text("boxed") };
    expect(query("zones_containing(this)", "token", c, all)).toEqual(list([]));
    const d = cells([11, 0]);
    (d.token as Record<string, Result>).position = list([num(1), num(Number.NaN)]);
    expect(query("zones_containing(this)", "token", d, all)).toEqual(list([]));
    expect(query("zones_containing(empty)", "token", d, all)).toMatchObject({ code: "#TYPE" });
    expect(query("zones_containing(1)", "token", d, all)).toMatchObject({ code: "#TYPE" });
    expect(query("zones_containing([this])", "token", d, all)).toMatchObject({
      code: "#TYPE",
    });
  });

  test("an error in the object's geometry is the result", () => {
    const c = cells([11, 0]);
    (c.token as Record<string, Result>).position = err("#CYCLE");
    expect(query("zones_containing(this)", "token", c, all)).toMatchObject({ code: "#CYCLE" });
  });
});

describe("on(obj)", () => {
  // A 4x4 board tile at [0, 0] (x -2..2, y -2..2), z 1.
  function cells(): FakeCells {
    return {
      table: {},
      tile: placed("table", [0, 0], { shape: RECT4, z: 1 }),
      high: placed("table", [1, 1], { shape: UNIT, z: 5 }),
      mid: placed("table", [-1, 0], { shape: { type: "circle", radius: 1 }, z: 3 }),
      level: placed("table", [0, 0], { shape: UNIT, z: 1 }),
      below: placed("table", [0, 0], { shape: UNIT, z: 0 }),
      aura: zone("table", [0, 0], { type: "circle", radius: 1 }, { z: 9 }),
      touching: placed("table", [2.5, 0], { shape: UNIT, z: 4 }),
      coin: placed("table", [1.5, -1.5], { z: 2 }),
      coin_edge: placed("table", [2, 2], { z: 2 }),
      coin_out: placed("table", [2.1, 0], { z: 2 }),
    };
  }
  const all = {
    table: [
      "touching",
      "coin_out",
      "aura",
      "high",
      "level",
      "tile",
      "coin",
      "below",
      "mid",
      "coin_edge",
    ],
  };

  test("overlapping objects with higher z, nearest first", () => {
    expect(query("on(this)", "tile", cells(), all)).toEqual(
      refs("coin", "coin_edge", "mid", "high"),
    );
  });

  test("an empty z on the base object reads as 0", () => {
    const c = cells();
    delete c.tile?.z;
    expect(query("on(this)", "tile", c, all)).toEqual(
      refs("level", "coin", "coin_edge", "mid", "high"),
    );
  });

  test("a shapeless base object is a point footprint", () => {
    const c = cells();
    c.pin = placed("table", [1, 1], { z: 0 });
    // high covers [0.5..1.5]; tile covers the point too; a point never overlaps a point.
    expect(query("on(this)", "pin", c, { table: [...(all.table ?? []), "pin"] })).toEqual(
      refs("tile", "high"),
    );
  });

  test("asks for candidates near the footprint bounds", () => {
    const env = new LoggingEnv(cells(), { objectsOnBoard: all });
    run("on(this)", env, { scope: { thisId: "tile" } });
    expect(env.nearCalls).toEqual([
      { board: "table", near: { minX: -2, minY: -2, maxX: 2, maxY: 2 } },
    ]);
    const pin = new LoggingEnv({ ...cells(), pin: placed("table", [3, 4]) }, {});
    run("on(this)", pin, { scope: { thisId: "pin" } });
    expect(pin.nearCalls).toEqual([
      { board: "table", near: { minX: 3, minY: 4, maxX: 3, maxY: 4 } },
    ]);
  });

  test("not on a board or an invalid position gives []; deleted is #REF", () => {
    const c = cells();
    c.tile = { shape: { type: "shape", shape: RECT4 } };
    expect(query("on(this)", "tile", c, all)).toEqual(list([]));
    const d = cells();
    (d.tile as Record<string, Result>).position = list([num(0), num(Number.POSITIVE_INFINITY)]);
    expect(query("on(this)", "tile", d, all)).toEqual(list([]));
    expect(query("on(gone)", "self", { self: { gone: ref("nope") } })).toMatchObject({
      code: "#REF",
    });
    expect(query("on(empty)", "tile", cells(), all)).toMatchObject({ code: "#TYPE" });
  });
});
