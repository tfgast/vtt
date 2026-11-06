import { anchorOf, compareIds, geometryNumber } from "@vtt/formula";
import { EMPTY, list, num, type Result, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";

const roll = (total: number): Result => ({
  type: "roll",
  expr: "1d20",
  dice: [total],
  dropped: [],
  total,
});

describe("geometryNumber", () => {
  test("reads a number, empty as 0 and a roll as its total", () => {
    expect(geometryNumber(num(2.5))).toBe(2.5);
    expect(geometryNumber(EMPTY)).toBe(0);
    expect(geometryNumber(roll(7))).toBe(7);
  });

  test("is undefined for any other kind", () => {
    expect(geometryNumber(text("3"))).toBeUndefined();
    expect(geometryNumber(list([num(1)]))).toBeUndefined();
  });

  test("passes a non-finite number through", () => {
    expect(geometryNumber(num(Number.POSITIVE_INFINITY))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("anchorOf", () => {
  test("reads a list of two finite numbers", () => {
    expect(anchorOf(list([num(1), num(-2)]))).toEqual([1, -2]);
  });

  test("is undefined otherwise", () => {
    expect(anchorOf(EMPTY)).toBeUndefined();
    expect(anchorOf(list([num(1)]))).toBeUndefined();
    expect(anchorOf(list([num(1), num(2), num(3)]))).toBeUndefined();
    expect(anchorOf(list([num(1), text("2")]))).toBeUndefined();
    expect(anchorOf(list([num(Number.NaN), num(2)]))).toBeUndefined();
    expect(anchorOf(list([num(1), num(Number.POSITIVE_INFINITY)]))).toBeUndefined();
  });
});

describe("compareIds", () => {
  test("orders by code point, a prefix first", () => {
    expect(compareIds("a", "a")).toBe(0);
    expect(compareIds("a", "b")).toBe(-1);
    expect(compareIds("b", "a")).toBe(1);
    expect(compareIds("a", "ab")).toBe(-1);
    expect(compareIds("ab", "a")).toBe(1);
    expect(compareIds("Z", "a")).toBe(-1);
  });

  test("compares astral characters by code point, not UTF-16 unit", () => {
    // U+FF5E sorts before U+1F600 by code point, after it by UTF-16 unit.
    expect(compareIds("～", "\u{1F600}")).toBe(-1);
    expect(["\u{1F600}", "～"].sort(compareIds)).toEqual(["～", "\u{1F600}"]);
  });
});
