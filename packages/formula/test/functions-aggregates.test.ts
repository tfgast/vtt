import { bool, dice, EMPTY, list, num, type Result, type RollValue, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { FakeEnv } from "./support/fake-env";

const roll = (expr: string, total: number): RollValue => ({
  type: "roll",
  expr,
  dice: [total],
  dropped: [],
  total,
});

const r1 = roll("1d20", 7);
const r2 = roll("1d20", 15);
const cells = { self: { r1, r2, blank: EMPTY, d: dice("1d6"), big: num(1e308) } };

const ev = (source: string): Result => run(source, cells);

describe("aggregates: the empty-list column (§6)", () => {
  test.each<[string, Result]>([
    ["sum([])", num(0)],
    ["count([])", num(0)],
    ["len([])", num(0)],
    ["min([])", EMPTY],
    ["max([])", EMPTY],
    ["avg([])", EMPTY],
    ["any([])", bool(false)],
    ["all([])", bool(true)],
    ["first([])", EMPTY],
    ["last([])", EMPTY],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test.each<[string, Result]>([
    ["sum(empty)", num(0)],
    ["count(empty)", num(0)],
    ["len(empty)", num(0)],
    ["min(empty)", EMPTY],
    ["max(empty)", EMPTY],
    ["avg(empty)", EMPTY],
    ["any(empty)", bool(false)],
    ["all(empty)", bool(true)],
    ["first(empty)", EMPTY],
    ["last(empty)", EMPTY],
  ])("empty as [] : %s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test.each<[string, Result]>([
    ["sum([empty, empty])", num(0)],
    ["count([empty, empty])", num(0)],
    ["len([empty, empty])", num(2)],
    ["min([empty])", EMPTY],
    ["max([empty])", EMPTY],
    ["avg([empty])", EMPTY],
    ["any([empty])", bool(false)],
    ["all([empty])", bool(true)],
    ["first([empty, empty])", EMPTY],
    ["last([empty])", EMPTY],
  ])("only empty items: %s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });
});

describe("aggregates: call shape", () => {
  test.each([
    "sum(1, 2)",
    "count(1, 2)",
    "len(1, 2)",
    "min(1, 2)",
    "max(1, 2)",
    "avg(1, 2)",
    "any(1, 2)",
    "all(1, 2)",
    "first(1, 2)",
    "last(1, 2)",
    "sum()",
    "max()",
  ])("%s is an arity error, #TYPE", (source) => {
    expect(ev(source)).toMatchObject({ code: "#TYPE" });
  });

  test.each<[string, Result]>([
    ["sum(5)", num(5)],
    ["count(5)", num(1)],
    ["len(5)", num(1)],
    ["min(5)", num(5)],
    ["max(5)", num(5)],
    ["avg(5)", num(5)],
    ["any(5)", bool(true)],
    ["all(0)", bool(false)],
    ["first(5)", num(5)],
    ["last(5)", num(5)],
    ["count(true)", num(1)],
    ["first(r1)", r1],
  ])("a scalar is a one-item list: %s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test("aggregates never broadcast: a nested list is one item", () => {
    expect(ev("len([[1, 2], 3])")).toEqual(num(2));
    expect(ev("count([[1, 2], 3])")).toEqual(num(2));
    expect(ev("first([[1, 2], 3])")).toEqual(list([num(1), num(2)]));
    expect(ev("sum([[1, 2], 3])")).toMatchObject({ code: "#TYPE" });
  });

  test("an error argument propagates", () => {
    expect(ev("sum(1 / 0)")).toMatchObject({ code: "#DIV0" });
    expect(ev("len(nope)")).toMatchObject({ code: "#NAME" });
  });
});

describe("sum and avg", () => {
  test.each<[string, Result]>([
    ["sum([1, 2, 3])", num(6)],
    ["sum([1, empty, 3])", num(4)],
    ["sum([r1, r2, 1])", num(23)],
    ["sum(r1)", num(7)],
    ["avg([1, 2, 3, 4])", num(2.5)],
    ["avg([1, empty, 3])", num(2)],
    ["avg([r1, r2])", num(11)],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test.each([
    "sum([1, d])",
    "sum(d)",
    'sum([1, "2"])',
    "sum([true])",
    'avg([1, "2"])',
    "avg(d)",
    "avg([false])",
    "sum([this])",
  ])("%s is #TYPE", (source) => {
    expect(ev(source)).toMatchObject({ code: "#TYPE" });
  });

  test("a non-finite sum is #TYPE", () => {
    expect(ev("sum([big, big])")).toMatchObject({ code: "#TYPE" });
  });
});

describe("count and len", () => {
  test.each<[string, Result]>([
    ['count([1, empty, "a", false])', num(3)],
    ['len([1, empty, "a", false])', num(4)],
    ['len("goblin")', num(6)],
    ['len("")', num(0)],
    ['len("a😀b")', num(3)],
    ['count("goblin")', num(1)],
    ['len(["ab", "cd"])', num(2)],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });
});

describe("min and max", () => {
  test.each<[string, Result]>([
    ["max([3, 9, 2])", num(9)],
    ["min([3, 9, 2])", num(2)],
    ["max([3, empty, 2])", num(3)],
    ["min([empty, 3, 2])", num(2)],
    ["max([r1, r2])", r2],
    ["min([r1, r2])", r1],
    ["max([r1, 10])", num(10)],
    ["max([r2, 10])", r2],
    ['max(["b", "a", "c"])', text("c")],
    ['min(["b", "a", "c"])', text("a")],
    ["max([-1, -5])", num(-1)],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  test("ties return the first occurrence", () => {
    const tie = roll("1d20", 15);
    const env = new FakeEnv({ self: { a: r2, b: tie, c: roll("1d20", 7) } });
    expect(run("max([a, b])", env)).toBe(r2);
    expect(run("max([b, a])", env)).toBe(tie);
    expect(run("max([15, a])", env)).toEqual(num(15));
    expect(run("min([c, 7])", env)).toEqual(roll("1d20", 7));
  });

  test.each([
    'max([1, "a"])',
    'min(["a", r1])',
    "max([true, false])",
    "max([d])",
    "min([this])",
    "max([[1], [2]])",
    "max(true)",
  ])("%s is #TYPE", (source) => {
    expect(ev(source)).toMatchObject({ code: "#TYPE" });
  });

  test("the Done-when cases", () => {
    expect(ev("max([r1, r2])")).toEqual(r2);
    expect(ev("max(1, 2)")).toMatchObject({ code: "#TYPE" });
  });
});

describe("any and all", () => {
  test.each<[string, Result]>([
    ["any([0, false, 1])", bool(true)],
    ['any([0, false, ""])', bool(false)],
    ['all([1, true, "a"])', bool(true)],
    ["all([1, 0])", bool(false)],
    ["all([1, empty])", bool(true)],
    ["any([[]])", bool(false)],
    ["any([r1])", bool(true)],
    ["all([this])", bool(true)],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });
});

describe("first and last", () => {
  test.each<[string, Result]>([
    ["first([1, 2, 3])", num(1)],
    ["last([1, 2, 3])", num(3)],
    ["first([empty, 2, 3])", num(2)],
    ["last([1, 2, empty])", num(2)],
    ["first([r1, 2])", r1],
    ["last([false])", bool(false)],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });
});

describe("aggregates over dot-access and comparisons", () => {
  const env = new FakeEnv({
    self: {
      rows: list([
        { type: "ref", object: "a" },
        { type: "ref", object: "b" },
      ]),
    },
    a: { save_roll: roll("1d20", 12) },
    b: { save_roll: EMPTY },
  });
  const both = new FakeEnv({
    self: {
      rows: list([
        { type: "ref", object: "a" },
        { type: "ref", object: "b" },
      ]),
    },
    a: { save_roll: roll("1d20", 12) },
    b: { save_roll: roll("1d20", 3) },
  });

  test("all(rows.save_roll != empty)", () => {
    expect(run("all(rows.save_roll != empty)", env)).toEqual(bool(false));
    expect(run("all(rows.save_roll != empty)", both)).toEqual(bool(true));
  });
});
