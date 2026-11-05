import { bool, dice, EMPTY, err, list, num, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { roll } from "./values-helpers";

describe("literals", () => {
  test.each([
    ["12", num(12)],
    ["3.5", num(3.5)],
    ['"goblin"', text("goblin")],
    ["true", bool(true)],
    ["false", bool(false)],
    ["empty", EMPTY],
    ["[]", list([])],
    ["[1, 2, 3]", list([num(1), num(2), num(3)])],
    ['[1, ["a"]]', list([num(1), list([text("a")])])],
  ])("%s", (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  test("dice literals evaluate to dice values with normalized expressions", () => {
    expect(run("2d6")).toEqual(dice("2d6"));
    expect(run("d20")).toEqual(dice("1d20"));
    expect(run("1d6kh1!")).toEqual(dice("1d6!kh1"));
    expect(run("dF")).toEqual(dice("1dF"));
  });

  test("dice arithmetic goes through the operators", () => {
    expect(run("2d6+3")).toEqual(dice("2d6+3"));
  });

  test.each(["0d6", "1d6kh2", "1d1"])("a dice literal breaking a limit (%s) is #TYPE", (source) => {
    expect(run(source)).toMatchObject({ type: "error", code: "#TYPE" });
  });

  test("viewer literals", () => {
    expect(run("all")).toEqual({ type: "viewers", viewers: ["all"] });
    expect(run("gm")).toEqual({ type: "viewers", viewers: ["gm"] });
  });

  test("a record is #TYPE in a formula", () => {
    expect(run("{target: this, modifier: 2}")).toMatchObject({ type: "error", code: "#TYPE" });
  });

  test("list items evaluate left to right and the first error wins", () => {
    expect(run("[1, 1 / 0, missing]")).toMatchObject({ code: "#DIV0" });
    expect(run("[1, missing, 1 / 0]")).toMatchObject({ code: "#NAME" });
  });

  test("a list never contains an error, however deep", () => {
    expect(run("[1, [2, 1 / 0]]")).toMatchObject({ code: "#DIV0" });
  });

  test("a list keeps item values unchanged", () => {
    const r = roll(7);
    const result = run("[r, empty]", { self: { r } });
    expect(result).toEqual(list([r, EMPTY]));
  });

  test("errors are results, not exceptions", () => {
    expect(run("1 / 0")).toEqual(err("#DIV0", "/ by zero"));
  });
});
