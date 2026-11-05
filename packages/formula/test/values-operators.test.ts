import { binary, unary, type ValueBinaryOp } from "@vtt/formula";
import { bool, dice, EMPTY, err, list, num, type Result, ref, shape, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { INK, roll, viewers } from "./values-helpers";

const T = bool(true);
const F = bool(false);
const nums = (...ns: number[]) => list(ns.map(num));
const bools = (...bs: boolean[]) => list(bs.map(bool));
const rect = shape({ type: "rect", width: 1, height: 1 });

type Case = [string, Result, ValueBinaryOp, Result, Result];

function run(cases: Case[]) {
  test.each(cases)("%s", (_name, a, op, b, expected) => {
    expect(binary(op, a, b)).toMatchObject(expected);
  });
}

describe("arithmetic", () => {
  run([
    ["1 + 2", num(1), "+", num(2), num(3)],
    ["5 - 7", num(5), "-", num(7), num(-2)],
    ["3 * 4", num(3), "*", num(4), num(12)],
    ["/ is real division", num(7), "/", num(2), num(3.5)],
    ["0.1 + 0.2 is an IEEE double", num(0.1), "+", num(0.2), num(0.1 + 0.2)],
    ["empty + empty = 0", EMPTY, "+", EMPTY, num(0)],
    ["empty acts as 0", num(5), "-", EMPTY, num(5)],
    ["roll 14 + empty = 14", roll(14), "+", EMPTY, num(14)],
    ["roll 11 + 5 = 16", roll(11), "+", num(5), num(16)],
    ["roll of total 28 / 2 = 14", roll(28, "4d10"), "/", num(2), num(14)],
    ["roll + roll", roll(3), "*", roll(4), num(12)],
    ['"3" + 1 is #TYPE', text("3"), "+", num(1), err("#TYPE")],
    ["true + 1 is #TYPE", bool(true), "+", num(1), err("#TYPE")],
    ["ref + 1 is #TYPE", ref("a"), "+", num(1), err("#TYPE")],
    ["a shape + 1 is #TYPE", rect, "+", num(1), err("#TYPE")],
    ["viewers + 1 is #TYPE", viewers("gm"), "+", num(1), err("#TYPE")],
    ["ink + 1 is #TYPE", INK, "+", num(1), err("#TYPE")],
    ["1 / 0 is #DIV0", num(1), "/", num(0), err("#DIV0")],
    ["0 / 0 is #DIV0", num(0), "/", num(0), err("#DIV0")],
    ["1 / empty is #DIV0", num(1), "/", EMPTY, err("#DIV0")],
    ["5 % 0 is #DIV0", num(5), "%", num(0), err("#DIV0")],
    ["5 % -3 = 2", num(5), "%", num(-3), num(2)],
    ["-7 % 3 = -1", num(-7), "%", num(3), num(-1)],
    ["7.5 % 2 = 1.5", num(7.5), "%", num(2), num(1.5)],
    ["overflow to Infinity is #TYPE", num(1e308), "*", num(10), err("#TYPE")],
    ["overflow to -Infinity is #TYPE", num(-1e308), "-", num(1e308), err("#TYPE")],
    ["division overflow is #TYPE", num(1e308), "/", num(1e-10), err("#TYPE")],
  ]);
});

describe("dice arithmetic", () => {
  run([
    ["2d6 + 3", dice("2d6"), "+", num(3), dice("2d6+3")],
    ["3 + 2d6", num(3), "+", dice("2d6"), dice("2d6+3")],
    ["1d8 + 1d6", dice("1d8"), "+", dice("1d6"), dice("1d8+1d6")],
    ["dice - number", dice("1d20+1"), "-", num(3), dice("1d20-2")],
    ["dice - dice", dice("1d20"), "-", dice("1d4+1"), dice("1d20-1d4-1")],
    ["number - dice", num(10), "-", dice("1d6"), dice("-1d6+10")],
    ["result is normalized", dice("d20"), "+", num(0), dice("1d20")],
    ["empty + dice acts as 0", EMPTY, "+", dice("1d6"), dice("1d6")],
    ["dice - empty acts as 0", dice("1d6"), "-", EMPTY, dice("1d6")],
    ["dice + roll acts as its total", dice("1d6"), "+", roll(4), dice("1d6+4")],
    ["roll - dice", roll(4), "-", dice("1d6"), dice("-1d6+4")],
    ["2 * 1d6 is #TYPE", num(2), "*", dice("1d6"), err("#TYPE")],
    ["1d6 * 2 is #TYPE", dice("1d6"), "*", num(2), err("#TYPE")],
    ["1d6 / 2 is #TYPE", dice("1d6"), "/", num(2), err("#TYPE")],
    ["1d6 % 2 is #TYPE", dice("1d6"), "%", num(2), err("#TYPE")],
    ["1d6 * 1d6 is #TYPE", dice("1d6"), "*", dice("1d6"), err("#TYPE")],
    ["1d6 + 0.5 is #TYPE", dice("1d6"), "+", num(0.5), err("#TYPE")],
    ["0.5 - 1d6 is #TYPE", num(0.5), "-", dice("1d6"), err("#TYPE")],
    ["1d6 + unsafe integer is #TYPE", dice("1d6"), "+", num(2 ** 53), err("#TYPE")],
    ['1d6 + "1" is #TYPE', dice("1d6"), "+", text("1"), err("#TYPE")],
    ["1d6 + true is #TYPE", dice("1d6"), "+", bool(true), err("#TYPE")],
  ]);

  test("1d8 + 1d6 + 2", () => {
    const first = binary("+", dice("1d8"), dice("1d6"));
    expect(binary("+", first, num(2))).toEqual(dice("1d8+1d6+2"));
  });
});

describe("unary minus", () => {
  test.each<[string, Result, Result]>([
    ["-3", num(3), num(-3)],
    ["-empty is 0", EMPTY, num(0)],
    ["-roll is minus its total", roll(5), num(-5)],
    ["-dice negates every term", dice("1d6+2"), dice("-1d6-2")],
    ['-"3" is #TYPE', text("3"), err("#TYPE")],
    ["-true is #TYPE", bool(true), err("#TYPE")],
    ["-shape is #TYPE", rect, err("#TYPE")],
    ["-[1, 2] broadcasts", nums(1, 2), nums(-1, -2)],
    ["-[[1], 2] broadcasts recursively", list([nums(1), num(2)]), list([nums(-1), num(-2)])],
    ["-[] is []", list([]), list([])],
    ["-[1, true] is #TYPE", list([num(1), bool(true)]), err("#TYPE")],
    ["-error is the error", err("#REF"), err("#REF")],
  ])("%s", (_name, a, expected) => {
    expect(unary("-", a)).toMatchObject(expected);
  });

  test("-0 compares equal to 0", () => {
    expect(binary("=", unary("-", num(0)), num(0))).toEqual(T);
  });
});

describe("concatenation", () => {
  run([
    ["text & text", text("a"), "&", text("b"), text("ab")],
    ["text & number", text("hp: "), "&", num(12), text("hp: 12")],
    ["number & number", num(1), "&", num(2), text("12")],
    ["text & -0", text("x"), "&", num(-0), text("x0")],
    ["text & roll total", text("rolled "), "&", roll(17), text("rolled 17")],
    ["text & ref is #TYPE", text("x"), "&", ref("a"), err("#TYPE")],
    ["text & shape is #TYPE", text("x"), "&", rect, err("#TYPE")],
    ["text & viewers is #TYPE", text("x"), "&", viewers("gm"), err("#TYPE")],
    ["ink & text is #TYPE", INK, "&", text("x"), err("#TYPE")],
  ]);

  test('"x" & 1 & true & empty & d6 = "x1true1d6"', () => {
    let acc: Result = text("x");
    for (const v of [num(1), bool(true), EMPTY, dice("d6")]) acc = binary("&", acc, v);
    expect(acc).toEqual(text("x1true1d6"));
  });
});

describe("equality operators", () => {
  run([
    ["empty = empty", EMPTY, "=", EMPTY, T],
    ["empty = 0 is false", EMPTY, "=", num(0), F],
    ["empty != 0", EMPTY, "!=", num(0), T],
    ["roll != empty is true", roll(14), "!=", EMPTY, T],
    ["roll = number by total", roll(14), "=", num(14), T],
    ["1d6 = d6", dice("1d6"), "=", dice("d6"), T],
    ["1d6 != d6 is false", dice("1d6"), "!=", dice("d6"), F],
    ["different kinds unequal", text("1"), "=", num(1), F],
    ["different kinds !=", text("1"), "!=", num(1), T],
    ["ink = ink is #TYPE", INK, "=", INK, err("#TYPE")],
    ["ink != ink is #TYPE", INK, "!=", INK, err("#TYPE")],
    ["ink = empty is false", INK, "=", EMPTY, F],
    ["ink != empty is true", INK, "!=", EMPTY, T],
    ["two equal shapes", rect, "=", shape({ type: "rect", width: 1, height: 1 }), T],
    ["viewers set equality", viewers(ref("a"), "gm"), "=", viewers("gm", ref("a"), "gm"), T],
    ["viewers set inequality", viewers(ref("a")), "!=", viewers(ref("b")), T],
    ["[1,2] = [1,2] is true", nums(1, 2), "=", nums(1, 2), T],
    ["[1,2] = [2,1] is false", nums(1, 2), "=", nums(2, 1), F],
    ["[1,2] != [1,2] is false", nums(1, 2), "!=", nums(1, 2), F],
    ["[1,2] = [1] is false, not #TYPE", nums(1, 2), "=", nums(1), F],
    ["[1,2] = 1 broadcasts", nums(1, 2), "=", num(1), bools(true, false)],
    ["1 = [1,2] broadcasts", num(1), "=", nums(1, 2), bools(true, false)],
    ["[1,2] != 1 broadcasts", nums(1, 2), "!=", num(1), bools(false, true)],
    ["[] = 1 is []", list([]), "=", num(1), list([])],
    [
      "nested list = scalar broadcasts recursively",
      list([nums(1, 2), num(1)]),
      "=",
      num(1),
      list([bools(true, false), T]),
    ],
    ["[ink] = empty broadcasts", list([INK]), "=", EMPTY, bools(false)],
    ["[ink] = 1 is #TYPE", list([INK]), "=", num(1), err("#TYPE")],
  ]);
});

describe("ordering operators", () => {
  run([
    ["1 < 2", num(1), "<", num(2), T],
    ["2 <= 2", num(2), "<=", num(2), T],
    ["3 > 2", num(3), ">", num(2), T],
    ["2 >= 3", num(2), ">=", num(3), F],
    ["roll >= number by total", roll(15), ">=", num(13), T],
    ["empty < 1", EMPTY, "<", num(1), T],
    ["empty >= roll 0", EMPTY, ">=", roll(0), T],
    ['empty < "a"', EMPTY, "<", text("a"), T],
    ["empty <= empty", EMPTY, "<=", EMPTY, T],
    ["empty < empty is false", EMPTY, "<", EMPTY, F],
    ['"Z" < "a"', text("Z"), "<", text("a"), T],
    ["astral > U+FFFF", text("\u{1F600}"), ">", text("￿"), T],
    ["booleans are #TYPE", bool(true), ">", bool(false), err("#TYPE")],
    ["number vs text is #TYPE", num(1), "<", text("2"), err("#TYPE")],
    ["refs are #TYPE", ref("a"), "<", ref("b"), err("#TYPE")],
    ["dice are #TYPE", dice("1d6"), "<", dice("1d8"), err("#TYPE")],
    ["shapes are #TYPE", rect, "<=", rect, err("#TYPE")],
    [
      "[roll15, num12] >= 13 = [true, false]",
      list([roll(15), num(12)]),
      ">=",
      num(13),
      bools(true, false),
    ],
    ["13 < [roll15, num12]", num(13), "<", list([roll(15), num(12)]), bools(true, false)],
    ["two lists are #TYPE", nums(1), "<", nums(2), err("#TYPE")],
    ["[] < 1 is []", list([]), "<", num(1), list([])],
    ["nested list broadcasts", list([nums(1, 5)]), "<", num(3), list([bools(true, false)])],
    ["[1, true] < 2 is #TYPE", list([num(1), bool(true)]), "<", num(2), err("#TYPE")],
  ]);

  test.each<[ValueBinaryOp, Result, Result]>([
    ["<", num(1), num(2)],
    [">=", nums(1, 2), num(1)],
    ["=", num(1), num(1)],
    ["!=", num(1), num(2)],
  ])("a comparison flagged chained (%s) is #TYPE", (op, a, b) => {
    expect(binary(op, a, b, { chained: true })).toMatchObject(err("#TYPE"));
  });

  test("chained with an error operand propagates the error", () => {
    expect(binary("<", err("#REF"), num(2), { chained: true })).toEqual(err("#REF"));
  });
});

describe("has", () => {
  const tags = list([text("die"), text("d6")]);
  run([
    ["list of text has an item", tags, "has", text("d6"), T],
    ["list of text lacks an item", tags, "has", text("d20"), F],
    ["has is case-sensitive", tags, "has", text("D6"), F],
    ["empty has anything is false", EMPTY, "has", text("d6"), F],
    ["[] has x is false", list([]), "has", num(1), F],
    ["roll item matches number", list([roll(4)]), "has", num(4), T],
    ["refs by id", list([ref("a"), ref("b")]), "has", ref("b"), T],
    ["right list is whole-value, not broadcast", list([nums(1, 2), num(3)]), "has", nums(1, 2), T],
    ["right list without a match", nums(1, 2), "has", nums(1, 2), F],
    ["nested items are not searched", list([nums(1)]), "has", num(1), F],
    ["text left is #TYPE", text("die"), "has", text("d"), err("#TYPE")],
    ["number left is #TYPE", num(1), "has", num(1), err("#TYPE")],
    ["viewers left is #TYPE", viewers(ref("a")), "has", ref("a"), err("#TYPE")],
  ]);
});

describe("broadcasting", () => {
  run([
    ["[1,2] + [3,4] = [4,6]", nums(1, 2), "+", nums(3, 4), nums(4, 6)],
    ["[1,2] + [1] is #TYPE", nums(1, 2), "+", nums(1), err("#TYPE")],
    ["[1,2] + 1", nums(1, 2), "+", num(1), nums(2, 3)],
    ["10 - [1,2]", num(10), "-", nums(1, 2), nums(9, 8)],
    ["[[1,2],[3]] * 2", list([nums(1, 2), nums(3)]), "*", num(2), list([nums(2, 4), nums(6)])],
    [
      "nested lists of equal shape",
      list([nums(1, 2), num(3)]),
      "+",
      list([nums(10, 20), num(30)]),
      list([nums(11, 22), num(33)]),
    ],
    ["inner lengths differ is #TYPE", list([nums(1, 2)]), "+", list([nums(1)]), err("#TYPE")],
    ["list item vs scalar item recurses", list([nums(1, 2)]), "+", nums(10), list([nums(11, 12)])],
    ["[] + 1 is []", list([]), "+", num(1), list([])],
    ["1 + [] is []", num(1), "+", list([]), list([])],
    ["[] + [] is []", list([]), "+", list([]), list([])],
    ["[] + [1] is #TYPE (lengths differ)", list([]), "+", nums(1), err("#TYPE")],
    ["[1, 0] / 0 is #DIV0", nums(1, 0), "/", num(0), err("#DIV0")],
    ["first error in list order wins", list([text("a"), num(1)]), "/", num(0), err("#TYPE")],
    [
      "[2d6, 1d4] + 1",
      list([dice("2d6"), dice("1d4")]),
      "+",
      num(1),
      list([dice("2d6+1"), dice("1d4+1")]),
    ],
    ['"a" & [1,2]', text("a"), "&", nums(1, 2), list([text("a1"), text("a2")])],
    [
      '["a","b"] & ["c","d"]',
      list([text("a"), text("b")]),
      "&",
      list([text("c"), text("d")]),
      list([text("ac"), text("bd")]),
    ],
    [
      '["a"] & ["c","d"] is #TYPE',
      list([text("a")]),
      "&",
      list([text("c"), text("d")]),
      err("#TYPE"),
    ],
  ]);
});

describe("error propagation", () => {
  const e1 = err("#REF", "gone", { object: "goblin", cell: "target" });
  const e2 = err("#DIV0");
  const ops: ValueBinaryOp[] = [
    "+",
    "-",
    "*",
    "/",
    "%",
    "&",
    "=",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "has",
  ];

  test.each(ops)("%s with an error left returns it unchanged", (op) => {
    expect(binary(op, e1, num(1))).toBe(e1);
  });

  test.each(ops)("%s with an error right returns it unchanged", (op) => {
    expect(binary(op, list([num(1)]), e1)).toBe(e1);
  });

  test.each(ops)("%s with two errors returns the first", (op) => {
    expect(binary(op, e1, e2)).toBe(e1);
    expect(binary(op, e2, e1)).toBe(e2);
  });

  test("unary minus returns the error unchanged", () => {
    expect(unary("-", e1)).toBe(e1);
  });

  test("an error operand beats a type mismatch on the other side", () => {
    expect(binary("+", text("x"), e2)).toBe(e2);
    expect(binary("<", INK, e2)).toBe(e2);
    expect(binary("has", num(1), e2)).toBe(e2);
  });
});
