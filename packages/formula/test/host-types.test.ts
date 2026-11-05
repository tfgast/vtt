import {
  type CellKey,
  type Change,
  cellKey,
  type Dependency,
  type EvalEnv,
  type EvalHost,
} from "@vtt/formula";
import {
  type Bounds,
  type CellContent,
  EMPTY,
  err,
  isIdSyntax,
  num,
  type ObjectId,
  type Result,
  text,
} from "@vtt/schema";
import { describe, expect, expectTypeOf, test } from "vitest";
import { FakeEnv } from "./support/fake-env";

const near: Bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe("EvalHost", () => {
  test("has the raw-document view methods", () => {
    expectTypeOf<EvalHost["exists"]>().toEqualTypeOf<(id: ObjectId) => boolean>();
    expectTypeOf<EvalHost["cell"]>().toEqualTypeOf<
      (id: ObjectId, name: string) => CellContent | undefined
    >();
    expectTypeOf<EvalHost["objectsNamed"]>().toEqualTypeOf<(name: string) => ObjectId[]>();
    expectTypeOf<EvalHost["allObjects"]>().toEqualTypeOf<() => ObjectId[]>();
    expectTypeOf<EvalHost["objectsOnBoard"]>().toEqualTypeOf<
      (board: ObjectId, near: Bounds) => ObjectId[]
    >();
    expectTypeOf<keyof EvalHost>().toEqualTypeOf<
      "exists" | "cell" | "objectsNamed" | "allObjects" | "objectsOnBoard"
    >();
  });
});

describe("EvalEnv", () => {
  test("reads results, not content", () => {
    expectTypeOf<EvalEnv["read"]>().toEqualTypeOf<
      (id: ObjectId, cell: string) => Result | undefined
    >();
    expectTypeOf<EvalEnv["exists"]>().toEqualTypeOf<(id: ObjectId) => boolean>();
    expectTypeOf<EvalEnv["objectsNamed"]>().toEqualTypeOf<(name: string) => ObjectId[]>();
    expectTypeOf<EvalEnv["allObjects"]>().toEqualTypeOf<() => ObjectId[]>();
    expectTypeOf<EvalEnv["objectsOnBoard"]>().toEqualTypeOf<
      (board: ObjectId, near: Bounds) => ObjectId[]
    >();
    expectTypeOf<keyof EvalEnv>().toEqualTypeOf<
      "read" | "exists" | "objectsNamed" | "allObjects" | "objectsOnBoard"
    >();
  });

  test("FakeEnv implements EvalEnv", () => {
    expectTypeOf<FakeEnv>().toExtend<EvalEnv>();
  });
});

describe("Change", () => {
  test("is a cell change, a creation, or a deletion", () => {
    expectTypeOf<Change>().toEqualTypeOf<
      | { type: "cell"; object: ObjectId; cell: string }
      | { type: "object_created"; object: ObjectId }
      | { type: "object_deleted"; object: ObjectId }
    >();
  });
});

describe("Dependency", () => {
  test("is a cell, an existence check, or the index", () => {
    expectTypeOf<Dependency>().toEqualTypeOf<
      | { type: "cell"; object: ObjectId; cell: string }
      | { type: "exists"; object: ObjectId }
      | {
          type: "index";
        }
    >();
  });
});

describe("CellKey", () => {
  test("cellKey builds a key", () => {
    expectTypeOf(cellKey).toEqualTypeOf<(object: ObjectId, cell: string) => CellKey>();
    expectTypeOf<CellKey>().toExtend<string>();
  });

  test("the separator is unambiguous for any cell name", () => {
    // Ids never contain the separator, so the first one splits the key.
    for (const [object, cell] of [
      ["a", "b:c"],
      ["ab", "c"],
      ["a_b", "Max HP"],
      ["x1", ""],
    ] as const) {
      expect(isIdSyntax(object)).toBe(true);
      const key = cellKey(object, cell);
      const at = key.indexOf(":");
      expect([key.slice(0, at), key.slice(at + 1)]).toEqual([object, cell]);
    }
    expect(cellKey("a", "b:c")).not.toBe(cellKey("ab", "c"));
    expect(cellKey("goblin1", "hp")).toBe(cellKey("goblin1", "hp"));
    expect(cellKey("goblin1", "hp")).not.toBe(cellKey("goblin1", "max_hp"));
    expect(cellKey("x", "Max HP")).not.toBe(cellKey("x", "Max_HP"));
  });
});

describe("FakeEnv", () => {
  const dangling = err("#REF", "dangling");
  const env = new FakeEnv(
    {
      goblin1: { name: text("Goblin"), hp: num(7), broken: dangling },
      die1: { name: text("d20"), value: EMPTY },
      die2: { name: text("d20") },
    },
    {
      objectsOnBoard: { table: ["die1", "goblin1"] },
      objectsNamed: { Goblin: ["goblin1"] },
      allObjects: ["goblin1", "die1", "die2", "template1"],
    },
  );

  test("returns mapped values as given", () => {
    expect(env.read("goblin1", "hp")).toEqual(num(7));
    expect(env.read("die1", "value")).toBe(EMPTY);
    expect(env.read("goblin1", "broken")).toBe(dangling);
  });

  test("returns undefined for missing cells and objects", () => {
    expect(env.read("goblin1", "ac")).toBeUndefined();
    expect(env.read("nobody", "hp")).toBeUndefined();
    expect(env.read("goblin1", "toString")).toBeUndefined();
  });

  test("exists reports the objects in the map", () => {
    expect(env.exists("goblin1")).toBe(true);
    expect(env.exists("nobody")).toBe(false);
    expect(env.exists("constructor")).toBe(false);
  });

  test("returns stubbed query answers", () => {
    expect(env.objectsOnBoard("table", near)).toEqual(["die1", "goblin1"]);
    expect(env.objectsOnBoard("gm_board", near)).toEqual([]);
    expect(env.objectsNamed("Goblin")).toEqual(["goblin1"]);
    expect(env.objectsNamed("Orc")).toEqual([]);
    expect(env.allObjects()).toEqual(["goblin1", "die1", "die2", "template1"]);
  });

  test("callers cannot mutate the stubs through a result", () => {
    env.allObjects().push("intruder");
    env.objectsOnBoard("table", near).pop();
    expect(env.allObjects()).toHaveLength(4);
    expect(env.objectsOnBoard("table", near)).toHaveLength(2);
  });

  test("without stubs, queries fall back to the map", () => {
    const bare = new FakeEnv({
      a: { name: text("Alpha") },
      b: { name: text("Alpha") },
      c: { name: num(1) },
    });
    expect(bare.allObjects()).toEqual(["a", "b", "c"]);
    expect(bare.objectsNamed("Alpha")).toEqual(["a", "b"]);
    expect(bare.objectsNamed("1")).toEqual([]);
    expect(bare.objectsOnBoard("table", near)).toEqual([]);
  });
});
