import { dice, EMPTY, list, num, type Result, type RollValue, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";

const roll = (expr: string, total: number): RollValue => ({
  type: "roll",
  expr,
  dice: [total],
  dropped: [],
  total,
});

const cells = {
  self: {
    r: roll("4d8+2", 28),
    r6: roll("4d6dl1", 13),
    d: dice("4d6dl1"),
    big: num(1e308),
    tiny: num(1.234e-310),
    negtiny: num(-1.234e-310),
    sub: num(5e-324),
    other: ref("other"),
  },
  other: {},
};

const ev = (source: string): Result => run(source, cells);

describe("numbers", () => {
  test.each<[string, Result]>([
    ["round(2.5)", num(3)],
    ["round(-2.5)", num(-3)],
    ["round(2.4)", num(2)],
    ["round(-0.4)", num(0)],
    ["round(1234, -2)", num(1200)],
    ["round(1250, -2)", num(1300)],
    ["round(-1250, -2)", num(-1300)],
    ["round(3.14159, 2)", num(3.14)],
    ["round(2.675, 1)", num(2.7)],
    ["round(5, 0)", num(5)],
    ["round(empty)", num(0)],
    ["round(r)", num(28)],
    ["round(0.5, 400)", num(0.5)],
    ["round(12345, -400)", num(0)],
    ["round(big, 2)", num(1e308)],
    ["round(tiny, 310)", num(1e-310)],
    ["round(negtiny, 310)", num(-1e-310)],
    ["round(tiny, 312)", num(1.23e-310)],
    ["round(tiny, 400)", num(1.234e-310)],
    ["round(sub, 1000000000)", num(5e-324)],
    ["round(tiny, 2)", num(0)],
    ["round(0, 1000000000)", num(0)],
    ["floor(r / 2)", num(14)],
    ["floor(2.7)", num(2)],
    ["floor(-2.5)", num(-3)],
    ["ceil(2.1)", num(3)],
    ["ceil(-0.5)", num(0)],
    ["ceil(empty)", num(0)],
    ["abs(-3)", num(3)],
    ["abs(r)", num(28)],
    ["clamp(5, 1, 3)", num(3)],
    ["clamp(-5, 1, 3)", num(1)],
    ["clamp(2, 1, 3)", num(2)],
    ["clamp(r, 0, 20)", num(20)],
    ["clamp(2, 2, 2)", num(2)],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test.each([
    "round(2.5, 0.5)",
    'round("2")',
    'round(2, "1")',
    "round(true)",
    "floor(d)",
    'ceil("1")',
    "abs(other)",
    "clamp(2, 3, 1)",
    'clamp("a", 1, 2)',
  ])("%s is #TYPE", (source) => {
    expect(ev(source)).toMatchObject({ code: "#TYPE" });
  });

  test("arity", () => {
    expect(ev("round()")).toMatchObject({ code: "#TYPE" });
    expect(ev("round(1, 2, 3)")).toMatchObject({ code: "#TYPE" });
    expect(ev("clamp(1, 2)")).toMatchObject({ code: "#TYPE" });
    expect(ev("floor(1, 2)")).toMatchObject({ code: "#TYPE" });
  });

  test("floor(r / 2) of a roll totalling 28 is the number 14", () => {
    expect(ev("floor(r / 2)")).toEqual(num(14));
  });

  test("numeric functions broadcast", () => {
    expect(ev("floor([1.5, 2.5, empty])")).toEqual(list([num(1), num(2), num(0)]));
    expect(ev("round([1.25, 2.35], 1)")).toEqual(list([num(1.3), num(2.4)]));
    expect(ev("round(1234.5678, [0, 2, -2])")).toEqual(list([num(1235), num(1234.57), num(1200)]));
    expect(ev("clamp([0, 5, 10], 1, [2, 6, 8])")).toEqual(list([num(1), num(5), num(8)]));
    expect(ev("clamp([0, 5], 1, [2, 6, 8])")).toMatchObject({ code: "#TYPE" });
    expect(ev('abs([-1, "a"])')).toMatchObject({ code: "#TYPE" });
  });
});

describe("number()", () => {
  test.each<[string, Result]>([
    ['number("3") + 1', num(4)],
    ['number("  -12.5 ")', num(-12.5)],
    ['number("007")', num(7)],
    ['number("-0")', num(0)],
    ["number(4)", num(4)],
    ["number(r)", num(28)],
    ["number(empty)", EMPTY],
    ['number(["1", "2"])', list([num(1), num(2)])],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test.each([
    'number("3x")',
    'number("")',
    'number("1.")',
    'number(".5")',
    'number("+1")',
    'number("1e3")',
    'number("1 2")',
    'number("Infinity")',
    "number(true)",
    "number(d)",
    "number(other)",
  ])("%s is #TYPE", (source) => {
    expect(ev(source)).toMatchObject({ code: "#TYPE" });
  });

  test("a digit string too long for a finite double is #TYPE", () => {
    expect(ev(`number("${"9".repeat(400)}")`)).toMatchObject({ code: "#TYPE" });
  });
});

describe("text functions", () => {
  test.each<[string, Result]>([
    ["text(3)", text("3")],
    ["text(-0)", text("0")],
    ["text(true)", text("true")],
    ["text(empty)", text("")],
    ["text(r)", text("28")],
    ["text(d)", text("4d6dl1")],
    ['text("a")', text("a")],
    ["text([1, 2])", list([text("1"), text("2")])],
    ['upper("Goblin")', text("GOBLIN")],
    ['lower("Goblin")', text("goblin")],
    ["upper(empty)", text("")],
    ["lower(empty)", text("")],
    ['upper(["a", "b"])', list([text("A"), text("B")])],
    ['join(["a", empty, "b"], ",")', text("a,b")],
    ['join([1, true, r, "x"], " ")', text("1 true 28 x")],
    ['join([], ",")', text("")],
    ['join(empty, ",")', text("")],
    ['join("solo", ",")', text("solo")],
    ['join(["a", "b"], "")', text("ab")],
    ['join(["a", "b"], empty)', text("ab")],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test.each([
    "text(other)",
    "upper(1)",
    "lower(true)",
    "upper(r)",
    'join([other], ",")',
    'join([[1, 2]], ",")',
    'join(["a"], 1)',
    'join(["a"])',
  ])("%s is #TYPE", (source) => {
    expect(ev(source)).toMatchObject({ code: "#TYPE" });
  });
});

describe("dice functions", () => {
  test.each<[string, Result]>([
    ["max_roll(4d6dl1)", num(18)],
    ["min_roll(4d6dl1)", num(3)],
    ["faces(4d6dl1)", num(4)],
    ["sides(4d6dl1)", list([num(6), num(6), num(6), num(6)])],
    ["sides(2d6 + 1d8)", list([num(6), num(6), num(8)])],
    ["max_roll(2d6 + 3)", num(15)],
    ["min_roll(1d20 - 1d4)", num(-3)],
    ["sides(1dF)", list([num(3)])],
    ["max_roll(d)", num(18)],
    ["max_roll(r)", num(34)],
    ["min_roll(r)", num(6)],
    ["faces(r)", num(4)],
    ["sides(r6)", list([num(6), num(6), num(6), num(6)])],
    ["max_roll([1d6, 2d6])", list([num(6), num(12)])],
    ["sides([1d4, 1d6])", list([list([num(4)]), list([num(6)])])],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test.each(["max_roll(6)", 'min_roll("1d6")', "faces(empty)", "sides(true)", "faces(other)"])(
    "%s is #TYPE",
    (source) => {
      expect(ev(source)).toMatchObject({ code: "#TYPE" });
    },
  );
});

describe("scalar functions do not swallow errors", () => {
  test("an error argument is the result", () => {
    expect(ev("floor(1 / 0)")).toMatchObject({ code: "#DIV0" });
    expect(ev("upper(nope)")).toMatchObject({ code: "#NAME" });
  });
});
