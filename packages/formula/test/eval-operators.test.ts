import { bool, dice, EMPTY, list, num, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { roll } from "./values-helpers";

describe("operators dispatch to the value semantics", () => {
  test.each([
    ["1 + 2 * 3", num(7)],
    ["(1 + 2) * 3", num(9)],
    ["-7 % 3", num(-1)],
    ['"a" & 1', text("a1")],
    ["[1, 2] + 1", list([num(2), num(3)])],
    ["[1, 2] = [1, 2]", bool(true)],
    ['["a", "b"] has "b"', bool(true)],
    ["-[1, 2]", list([num(-1), num(-2)])],
    ["-2d6", dice("-2d6")],
    ["1 < 2", bool(true)],
    ["(1 < 2) = true", bool(true)],
  ])("%s", (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  test("value + modifier with both empty is 0", () => {
    expect(run("value + modifier", { self: { value: EMPTY, modifier: EMPTY } })).toEqual(num(0));
  });

  test("a roll result acts as its total in arithmetic", () => {
    expect(run("r + 1", { self: { r: roll(12) } })).toEqual(num(13));
  });

  test("a chained comparison is #TYPE", () => {
    expect(run("1 < 2 < 3")).toMatchObject({ code: "#TYPE" });
    expect(run("1 = 1 = true")).toMatchObject({ code: "#TYPE" });
  });

  test("a chained comparison with an error operand yields that error", () => {
    expect(run("1 < 2 < 1 / 0")).toMatchObject({ code: "#DIV0" });
  });

  test("operands evaluate left to right; the left error wins", () => {
    expect(run("missing + 1 / 0")).toMatchObject({ code: "#NAME" });
    expect(run("1 / 0 + missing")).toMatchObject({ code: "#DIV0" });
  });

  test("unary minus on an error yields it", () => {
    expect(run("-missing")).toMatchObject({ code: "#NAME" });
  });
});
