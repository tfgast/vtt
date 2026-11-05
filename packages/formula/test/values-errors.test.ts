import { collectList, firstError, withOrigin } from "@vtt/formula";
import { EMPTY, err, list, num, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";

const origin = { object: "goblin", cell: "hp" };

describe("firstError", () => {
  test.each([
    ["no results", [], undefined],
    ["no errors", [num(1), text("a"), EMPTY], undefined],
    ["one error", [num(1), err("#TYPE")], err("#TYPE")],
    ["first of two in argument order", [err("#DIV0"), num(1), err("#TYPE")], err("#DIV0")],
    ["first of two, second position", [num(1), err("#REF"), err("#NAME")], err("#REF")],
  ])("%s", (_name, results, expected) => {
    expect(firstError(...results)).toEqual(expected);
  });

  test("returns the same error object, origin kept", () => {
    const e = err("#TYPE", "bad", origin);
    expect(firstError(num(1), e)).toBe(e);
  });
});

describe("withOrigin", () => {
  test("sets the origin on a new error", () => {
    const e = err("#TYPE", "bad");
    expect(withOrigin(e, origin)).toEqual(err("#TYPE", "bad", origin));
  });

  test("keeps an existing origin", () => {
    const first = { object: "a", cell: "x" };
    const e = err("#DIV0", undefined, first);
    expect(withOrigin(e, origin)).toBe(e);
    expect(withOrigin(e, origin).origin).toEqual(first);
  });

  test("does not mutate its argument", () => {
    const e = err("#TYPE");
    withOrigin(e, origin);
    expect(e.origin).toBeUndefined();
  });
});

describe("collectList", () => {
  test.each([
    ["no items", [], list([])],
    ["plain items", [num(1), text("a")], list([num(1), text("a")])],
    ["nested list", [list([num(1)]), EMPTY], list([list([num(1)]), EMPTY])],
    ["an error item", [num(1), err("#TYPE"), num(2)], err("#TYPE")],
    ["two error items, first wins", [err("#REF"), err("#TYPE")], err("#REF")],
  ])("%s", (_name, items, expected) => {
    expect(collectList(items)).toEqual(expected);
  });
});
