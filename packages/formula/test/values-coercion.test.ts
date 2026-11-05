import { compare, equals, toNumber, toText, truthy } from "@vtt/formula";
import {
  bool,
  dice,
  EMPTY,
  err,
  list,
  num,
  type Result,
  ref,
  shape,
  text,
  type Value,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { INK, roll, viewers } from "./values-helpers";

const rect = shape({ type: "rect", width: 2, height: 3 });

describe("truthy", () => {
  test.each<[string, Value, boolean]>([
    ["false", bool(false), false],
    ["empty", EMPTY, false],
    ["0", num(0), false],
    ["-0", num(-0), false],
    ['""', text(""), false],
    ["[]", list([]), false],
    ["true", bool(true), true],
    ["1", num(1), true],
    ["-1", num(-1), true],
    ['"0"', text("0"), true],
    ['" "', text(" "), true],
    ["[0]", list([num(0)]), true],
    ["[[]]", list([list([])]), true],
    ["a ref", ref("goblin"), true],
    ["a roll of total 0", roll(0, "1dF"), true],
    ["a roll", roll(14), true],
    ["dice", dice("1d6"), true],
    ["viewers", viewers("gm"), true],
    ["ink", INK, true],
    ["a shape", rect, true],
  ])("%s", (_name, v, expected) => {
    expect(truthy(v)).toBe(expected);
  });
});

describe("toNumber", () => {
  test.each<[string, Result, Result]>([
    ["number", num(3.5), num(3.5)],
    ["empty as 0", EMPTY, num(0)],
    ["roll as its total", roll(14), num(14)],
    ["text is #TYPE (no implicit coercion)", text("3"), err("#TYPE")],
    ["boolean is #TYPE", bool(true), err("#TYPE")],
    ["list is #TYPE", list([num(1)]), err("#TYPE")],
    ["ref is #TYPE", ref("goblin"), err("#TYPE")],
    ["dice is #TYPE", dice("1d6"), err("#TYPE")],
    ["viewers is #TYPE", viewers("all"), err("#TYPE")],
    ["ink is #TYPE", INK, err("#TYPE")],
    ["shape is #TYPE", rect, err("#TYPE")],
    ["error passes through", err("#REF"), err("#REF")],
  ])("%s", (_name, v, expected) => {
    expect(toNumber(v)).toMatchObject(expected);
  });
});

describe("toText", () => {
  test.each<[string, Result, Result]>([
    ["text as is", text("goblin"), text("goblin")],
    ["empty as empty text", EMPTY, text("")],
    ["integer", num(12), text("12")],
    ["fraction", num(3.5), text("3.5")],
    ["negative", num(-2), text("-2")],
    ["-0 as 0", num(-0), text("0")],
    ["large number uses JS String", num(1e21), text("1e+21")],
    ["small number uses JS String", num(1e-7), text("1e-7")],
    ["true", bool(true), text("true")],
    ["false", bool(false), text("false")],
    ["dice as normalized notation", dice("d20 + 2 + 1"), text("1d20+3")],
    ["dice modifiers reordered", dice("1d6kh1!"), text("1d6!kh1")],
    ["roll as its total", roll(14), text("14")],
    ["roll of total -0", roll(-0, "1dF"), text("0")],
    ["ref is #TYPE", ref("goblin"), err("#TYPE")],
    ["viewers is #TYPE", viewers("all"), err("#TYPE")],
    ["ink is #TYPE", INK, err("#TYPE")],
    ["shape is #TYPE", rect, err("#TYPE")],
    ["list is #TYPE", list([num(1)]), err("#TYPE")],
    ["error passes through", err("#DIV0"), err("#DIV0")],
  ])("%s", (_name, v, expected) => {
    expect(toText(v)).toMatchObject(expected);
  });
});

const T = bool(true);
const F = bool(false);

describe("equals", () => {
  test.each<[string, Result, Result, Result]>([
    // §2.1
    ["empty = empty", EMPTY, EMPTY, T],
    ["empty = 0 is false", EMPTY, num(0), F],
    ['empty = "" is false', EMPTY, text(""), F],
    ["empty = false is false", EMPTY, bool(false), F],
    ["empty = [] is false", EMPTY, list([]), F],
    // numbers
    ["numbers by value", num(2), num(2), T],
    ["different numbers", num(2), num(3), F],
    ["0 = -0", num(0), num(-0), T],
    // text
    ["text exact", text("a"), text("a"), T],
    ["text case-sensitive", text("a"), text("A"), F],
    ["text vs number of same spelling", text("3"), num(3), F],
    // booleans
    ["true = true", T, T, T],
    ["true = false", T, F, F],
    ["true = 1 (different kinds)", T, num(1), F],
    // refs
    ["refs by id", ref("goblin"), ref("goblin"), T],
    ["different refs", ref("goblin"), ref("orc"), F],
    ["ref vs text of its id", ref("goblin"), text("goblin"), F],
    // dice
    ["1d6 = d6", dice("1d6"), dice("d6"), T],
    ["dice by normalized expr", dice("2+1d6+1"), dice("1d6+3"), T],
    ["dice term order matters", dice("1d6+1d20"), dice("1d20+1d6"), F],
    ["1d20kh1 != 1d20", dice("1d20kh1"), dice("1d20"), F],
    ["dice vs number", dice("1d6"), num(1), F],
    // rolls
    ["roll vs number by total", roll(14), num(14), T],
    ["number vs roll by total", num(14), roll(14), T],
    ["roll vs different number", roll(14), num(15), F],
    ["roll vs roll by total", roll(7, "1d8"), roll(7, "2d6"), T],
    ["roll vs roll different totals", roll(7), roll(8), F],
    ["roll vs empty", roll(0), EMPTY, F],
    ["roll vs its dice", roll(3, "1d6"), dice("1d6"), F],
    // viewers
    ["viewers as sets: order ignored", viewers("gm", ref("a")), viewers(ref("a"), "gm"), T],
    [
      "viewers as sets: duplicates ignored",
      viewers("gm", "gm", ref("a")),
      viewers(ref("a"), "gm"),
      T,
    ],
    ["viewers refs by id", viewers(ref("a"), ref("b")), viewers(ref("b"), ref("a")), T],
    ["viewers differ", viewers("gm"), viewers("all"), F],
    ["viewers subset is unequal", viewers("gm"), viewers("gm", ref("a")), F],
    ["viewers vs ref", viewers(ref("a")), ref("a"), F],
    // ink
    ["ink = ink is #TYPE", INK, INK, err("#TYPE")],
    ["ink = empty is false", INK, EMPTY, F],
    ["empty = ink is false", EMPTY, INK, F],
    ["ink = number is #TYPE", INK, num(1), err("#TYPE")],
    ["number = ink is #TYPE", num(1), INK, err("#TYPE")],
    // shapes
    ["equal shapes", rect, shape({ type: "rect", width: 2, height: 3 }), T],
    ["different shapes", rect, shape({ type: "rect", width: 3, height: 2 }), F],
    ["different shape kinds", rect, shape({ type: "circle", radius: 2 }), F],
    [
      "equal polygons",
      shape({
        type: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      }),
      shape({
        type: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      }),
      T,
    ],
    [
      "polygons with different points",
      shape({
        type: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      }),
      shape({
        type: "polygon",
        points: [
          [0, 0],
          [0, 1],
          [1, 0],
        ],
      }),
      F,
    ],
    ["shape vs number", rect, num(2), F],
    // lists: ordered recursive whole-list equality
    ["[1,2] = [1,2]", list([num(1), num(2)]), list([num(1), num(2)]), T],
    ["[1,2] = [2,1]", list([num(1), num(2)]), list([num(2), num(1)]), F],
    ["[1,2] = [1]", list([num(1), num(2)]), list([num(1)]), F],
    ["[] = []", list([]), list([]), T],
    ["nested equal", list([list([num(1)]), text("a")]), list([list([num(1)]), text("a")]), T],
    ["nested unequal", list([list([num(1)])]), list([list([num(2)])]), F],
    ["items compared without broadcasting", list([list([num(1)])]), list([num(1)]), F],
    ["roll item vs number item", list([roll(3)]), list([num(3)]), T],
    ["ink inside lists is #TYPE", list([INK]), list([INK]), err("#TYPE")],
    // errors
    ["error left", err("#REF"), num(1), err("#REF")],
    ["error right", num(1), err("#DIV0"), err("#DIV0")],
    ["two errors, first wins", err("#NAME"), err("#DIV0"), err("#NAME")],
  ])("%s", (_name, a, b, expected) => {
    expect(equals(a, b)).toMatchObject(expected);
  });
});

describe("compare", () => {
  test.each<[string, Result, Result, Result]>([
    ["numbers less", num(1), num(2), num(-1)],
    ["numbers equal", num(2), num(2), num(0)],
    ["numbers greater", num(3), num(2), num(1)],
    ["0 vs -0", num(0), num(-0), num(0)],
    ["roll vs number by total", roll(15), num(13), num(1)],
    ["number vs roll by total", num(13), roll(15), num(-1)],
    ["roll vs roll", roll(4), roll(4), num(0)],
    ["empty acts as 0 vs number", EMPTY, num(1), num(-1)],
    ["empty acts as 0 vs negative", EMPTY, num(-1), num(1)],
    ["empty acts as 0 vs roll", roll(0), EMPTY, num(0)],
    ['empty acts as "" vs text', EMPTY, text("a"), num(-1)],
    ['empty equals ""', text(""), EMPTY, num(0)],
    ["empty vs empty equal", EMPTY, EMPTY, num(0)],
    ["text code point order", text("a"), text("b"), num(-1)],
    ['"Z" < "a"', text("Z"), text("a"), num(-1)],
    ["prefix sorts first", text("ab"), text("abc"), num(-1)],
    ["astral above U+FFFF", text("\u{1F600}"), text("￿"), num(1)],
    ["U+FFFF below astral", text("￿"), text("\u{10000}"), num(-1)],
    ["booleans are #TYPE", bool(false), bool(true), err("#TYPE")],
    ["number vs text is #TYPE", num(1), text("1"), err("#TYPE")],
    ["refs are #TYPE", ref("a"), ref("b"), err("#TYPE")],
    ["dice are #TYPE", dice("1d6"), dice("1d8"), err("#TYPE")],
    ["shapes are #TYPE", rect, rect, err("#TYPE")],
    ["viewers are #TYPE", viewers("gm"), viewers("gm"), err("#TYPE")],
    ["ink is #TYPE", INK, EMPTY, err("#TYPE")],
    ["lists are #TYPE", list([num(1)]), list([num(1)]), err("#TYPE")],
    ["boolean vs empty is #TYPE", bool(true), EMPTY, err("#TYPE")],
    ["error left", err("#REF"), num(1), err("#REF")],
    ["two errors, first wins", err("#NAME"), err("#DIV0"), err("#NAME")],
  ])("%s", (_name, a, b, expected) => {
    expect(compare(a, b)).toMatchObject(expected);
  });
});
