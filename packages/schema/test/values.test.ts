import {
  bool,
  type CellContent,
  dice,
  EMPTY,
  ERROR_CODES,
  type ErrorValue,
  err,
  ID_PATTERN,
  isCellContent,
  isError,
  isIdSyntax,
  isValue,
  list,
  num,
  type Result,
  ref,
  shape,
  text,
  type Value,
} from "@vtt/schema";
import { describe, expect, expectTypeOf, test } from "vitest";

const roundTrip = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));

const examples: Record<string, Value> = {
  number: num(27),
  text: text("goblin"),
  emptyText: text(""),
  boolean: bool(true),
  empty: EMPTY,
  list: list([num(1), list([text("die"), dice("d6")]), EMPTY]),
  emptyList: list([]),
  ref: ref("goblin1"),
  dice: dice("2d6+3"),
  roll: { type: "roll", expr: "4d6dl1", dice: [6, 4, 3], dropped: [1], total: 13 },
  fudgeRoll: { type: "roll", expr: "4dF", dice: [-1, 0, 1, 1], dropped: [], total: 1 },
  viewers: { type: "viewers", viewers: ["gm", "all", "owner", ref("aldric")] },
  ink: {
    type: "ink",
    strokes: [
      [
        [0, 0],
        [1, 1],
      ],
      [[2.5, -3]],
    ],
  },
  rect: shape({ type: "rect", width: 2, height: 3 }),
  circle: shape({ type: "circle", radius: 1.5 }),
  polygon: shape({
    type: "polygon",
    points: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  }),
};

describe("round trip", () => {
  for (const [name, value] of Object.entries(examples)) {
    test(name, () => {
      const back = roundTrip(value);
      expect(back).toEqual(value);
      expect(isValue(back)).toBe(true);
      expect(isCellContent(back)).toBe(true);
    });
  }

  test("formula cell content", () => {
    const f: CellContent = { type: "formula", source: "max_hp - damage_taken" };
    const back = roundTrip(f);
    expect(isCellContent(back)).toBe(true);
    expect(isValue(back)).toBe(false);
  });
});

describe("constructors", () => {
  test("build the tagged encoding", () => {
    expect(num(1)).toEqual({ type: "number", value: 1 });
    expect(text("a")).toEqual({ type: "text", value: "a" });
    expect(bool(false)).toEqual({ type: "boolean", value: false });
    expect(EMPTY).toEqual({ type: "empty" });
    expect(list([num(1)])).toEqual({ type: "list", items: [{ type: "number", value: 1 }] });
    expect(ref("a")).toEqual({ type: "ref", object: "a" });
    expect(dice("1d20")).toEqual({ type: "dice", expr: "1d20" });
    expect(shape({ type: "circle", radius: 1 })).toEqual({
      type: "shape",
      shape: { type: "circle", radius: 1 },
    });
  });

  test("err omits absent optional fields", () => {
    expect(err("#REF")).toEqual({ type: "error", code: "#REF" });
    expect(Object.keys(err("#REF"))).toEqual(["type", "code"]);
    expect(err("#TYPE", "bad", { object: "g", cell: "hp" })).toEqual({
      type: "error",
      code: "#TYPE",
      message: "bad",
      origin: { object: "g", cell: "hp" },
    });
  });

  test("isError", () => {
    expect(isError(err("#DIV0"))).toBe(true);
    expect(isError(num(0))).toBe(false);
  });
});

describe("ids", () => {
  test("ID_PATTERN and isIdSyntax", () => {
    expect(ID_PATTERN.source).toBe("^[A-Za-z][A-Za-z0-9_]*$");
    expect(isIdSyntax("goblin_1")).toBe(true);
    expect(isIdSyntax("1abc")).toBe(false);
    expect(isIdSyntax("a-b")).toBe(false);
    expect(isIdSyntax("")).toBe(false);
  });
});

describe("rejects", () => {
  const cases: Record<string, unknown> = {
    "NaN number": { type: "number", value: Number.NaN },
    "Infinity number": { type: "number", value: Number.POSITIVE_INFINITY },
    "-Infinity number": { type: "number", value: Number.NEGATIVE_INFINITY },
    "NaN roll total": { type: "roll", expr: "1d6", dice: [3], dropped: [], total: Number.NaN },
    "Infinity roll total": {
      type: "roll",
      expr: "1d6",
      dice: [3],
      dropped: [],
      total: Number.POSITIVE_INFINITY,
    },
    "NaN die result": { type: "roll", expr: "1d6", dice: [Number.NaN], dropped: [], total: 3 },
    "Infinity dropped die": {
      type: "roll",
      expr: "2d6dl1",
      dice: [3],
      dropped: [Number.POSITIVE_INFINITY],
      total: 3,
    },
    "non-integer die": { type: "roll", expr: "1d6", dice: [2.5], dropped: [], total: 2.5 },
    "NaN ink point": { type: "ink", strokes: [[[0, Number.NaN]]] },
    "Infinity ink point": { type: "ink", strokes: [[[Number.POSITIVE_INFINITY, 0]]] },
    "ink point of three": { type: "ink", strokes: [[[0, 0, 0]]] },
    "NaN rect width": shape({ type: "rect", width: Number.NaN, height: 1 }),
    "Infinity circle radius": shape({ type: "circle", radius: Number.POSITIVE_INFINITY }),
    "Infinity polygon point": shape({
      type: "polygon",
      points: [
        [0, 0],
        [Number.POSITIVE_INFINITY, 0],
        [0, 1],
      ],
    }),
    "ref 1abc": { type: "ref", object: "1abc" },
    "ref a-b": { type: "ref", object: "a-b" },
    "ref empty id": { type: "ref", object: "" },
    "blank dice expr": { type: "dice", expr: "  " },
    "blank roll expr": { type: "roll", expr: "", dice: [1], dropped: [], total: 1 },
    "viewers with no entries": { type: "viewers", viewers: [] },
    "viewers with unknown entry": { type: "viewers", viewers: ["gm", "everyone"] },
    "ink with no strokes": { type: "ink", strokes: [] },
    "ink with an empty stroke": { type: "ink", strokes: [[[0, 0]], []] },
    "error value": err("#REF"),
    "list containing an error": { type: "list", items: [num(1), err("#DIV0")] },
    "unknown type": { type: "record", value: 1 },
    "unknown shape type": { type: "shape", shape: { type: "square", side: 1 } },
    "extra key": { type: "number", value: 1, unit: "ft" },
    "extra key on nested ref": { type: "viewers", viewers: [{ type: "ref", object: "a", x: 1 }] },
    "extra key on shape": { type: "shape", shape: { type: "circle", radius: 1, x: 0 } },
    "extra key on empty": { type: "empty", value: null },
    "non-object": 3,
    null: null,
    array: [],
  };
  for (const [name, x] of Object.entries(cases)) {
    test(name, () => {
      expect(isValue(x)).toBe(false);
      expect(isCellContent(x)).toBe(false);
    });
  }

  test("formula with blank source", () => {
    expect(isCellContent({ type: "formula", source: " \n\t" })).toBe(false);
    expect(isCellContent({ type: "formula", source: "" })).toBe(false);
  });

  test("formula with an extra key", () => {
    expect(isCellContent({ type: "formula", source: "a", note: "x" })).toBe(false);
  });
});

describe("types", () => {
  test("Result = Value | ErrorValue", () => {
    expectTypeOf<Result>().toEqualTypeOf<Value | ErrorValue>();
  });

  test("ERROR_CODES has exactly the seven codes", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      ["#CYCLE", "#NAME", "#TYPE", "#REF", "#DIV0", "#LIMIT", "#SYNTAX"].sort(),
    );
    expect(ERROR_CODES).toHaveLength(7);
  });
});

/** An array of `before`, then one hole, then `after`. */
function withHole(before: unknown[], after: unknown[] = []): unknown[] {
  const a = [...before];
  a.length = before.length + 1;
  a.push(...after);
  return a;
}

describe("rejects sparse arrays", () => {
  const p = (x: number, y: number) => [x, y];
  const cases: Record<string, unknown> = {
    "list items": { type: "list", items: withHole([num(1)], [num(2)]) },
    "list items, only a hole": { type: "list", items: withHole([]) },
    "roll dice": { type: "roll", expr: "2d6", dice: withHole([3]), dropped: [], total: 3 },
    "roll dropped": { type: "roll", expr: "2d6dl1", dice: [3], dropped: withHole([]), total: 3 },
    "viewers entries": { type: "viewers", viewers: withHole([]) },
    "viewers entries after gm": { type: "viewers", viewers: withHole(["gm"]) },
    "ink strokes": { type: "ink", strokes: withHole([[p(0, 0)]]) },
    "ink stroke points": { type: "ink", strokes: [withHole([p(0, 0)], [p(1, 1)])] },
    "ink point coordinate": { type: "ink", strokes: [[withHole([0])]] },
    "polygon points": {
      type: "shape",
      shape: { type: "polygon", points: withHole([p(0, 0), p(1, 0)], [p(0, 1)]) },
    },
  };
  for (const [name, x] of Object.entries(cases)) {
    test(name, () => {
      expect(isValue(x)).toBe(false);
      expect(isCellContent(x)).toBe(false);
    });
  }
});

describe("rejects hidden extra keys", () => {
  test("a non-enumerable property", () => {
    const x = num(1);
    Object.defineProperty(x, "hidden", { value: true, enumerable: false });
    expect(Object.keys(x)).toEqual(["type", "value"]);
    expect(isValue(x)).toBe(false);
    expect(isCellContent(x)).toBe(false);
  });

  test("a symbol property", () => {
    const x = { ...ref("goblin1"), [Symbol("extra")]: 1 };
    expect(isValue(x)).toBe(false);
    expect(isCellContent(x)).toBe(false);
  });

  test("on a formula", () => {
    const f = { type: "formula", source: "a", [Symbol("extra")]: 1 };
    expect(isCellContent(f)).toBe(false);
  });
});
