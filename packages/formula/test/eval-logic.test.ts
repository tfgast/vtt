import { coreRegistry } from "@vtt/formula";
import { bool, EMPTY, err, list, num, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { roll } from "./values-helpers";

const boom = err("#DIV0", "boom");

describe("and / or / not", () => {
  test("nickname or name is a default", () => {
    const name = text("Aldric");
    expect(run("nickname or name", { self: { nickname: EMPTY, name } })).toBe(name);
    const nickname = text("Al");
    expect(run("nickname or name", { self: { nickname, name } })).toBe(nickname);
  });

  test("and returns an operand unchanged", () => {
    expect(run("0 and 5")).toEqual(num(0));
    expect(run("1 and 5")).toEqual(num(5));
    const r = roll(0);
    expect(run("true and r", { self: { r } })).toBe(r);
    expect(run("[] and 1")).toEqual(list([]));
  });

  test("or returns an operand unchanged", () => {
    expect(run("0 or 5")).toEqual(num(5));
    expect(run("3 or 5")).toEqual(num(3));
    expect(run('"" or empty')).toEqual(EMPTY);
  });

  test("and short-circuits: a falsy left side never evaluates the right", () => {
    expect(run("false and missing")).toEqual(bool(false));
    expect(run("empty and 1 / 0")).toEqual(EMPTY);
  });

  test("or short-circuits: a truthy left side never evaluates the right", () => {
    expect(run("true or missing")).toEqual(bool(true));
    expect(run("[0] or 1 / 0")).toEqual(list([num(0)]));
  });

  test("an error on either side of and", () => {
    expect(run("bad and true", { self: { bad: boom } })).toBe(boom);
    expect(run("bad and false", { self: { bad: boom } })).toBe(boom);
    expect(run("true and bad", { self: { bad: boom } })).toBe(boom);
    expect(run("false and bad", { self: { bad: boom } })).toEqual(bool(false));
  });

  test("an error on either side of or", () => {
    expect(run("bad or true", { self: { bad: boom } })).toBe(boom);
    expect(run("false or bad", { self: { bad: boom } })).toBe(boom);
    expect(run("true or bad", { self: { bad: boom } })).toEqual(bool(true));
  });

  test("not returns a boolean of the whole value", () => {
    expect(run("not 0")).toEqual(bool(true));
    expect(run("not [0]")).toEqual(bool(false));
    expect(run("not []")).toEqual(bool(true));
    expect(run("not empty")).toEqual(bool(true));
    expect(run('not "x"')).toEqual(bool(false));
  });

  test("not of an error is the error", () => {
    expect(run("not bad", { self: { bad: boom } })).toBe(boom);
  });

  test("and, or, not never broadcast", () => {
    expect(run("[false, false] and 1")).toEqual(num(1));
    expect(run("[false] or 1")).toEqual(list([bool(false)]));
  });
});

describe("if", () => {
  test("if(bonus = empty, 0, bonus)", () => {
    expect(run("if(bonus = empty, 0, bonus)", { self: { bonus: EMPTY } })).toEqual(num(0));
    expect(run("if(bonus = empty, 0, bonus)", { self: { bonus: num(0) } })).toEqual(num(0));
    expect(run("if(bonus = empty, 0, bonus)", { self: { bonus: num(3) } })).toEqual(num(3));
  });

  test("if(true, r, 0) returns the roll unchanged", () => {
    const r = roll(17, "1d20+2");
    const result = run("if(true, r, 0)", { self: { r } });
    expect(result).toEqual(r);
    expect(result).toBe(r);
  });

  test("only the chosen branch is evaluated", () => {
    expect(run("if(true, 1, missing)")).toEqual(num(1));
    expect(run("if(false, 1 / 0, 2)")).toEqual(num(2));
  });

  test("a condition error is the result", () => {
    expect(run("if(bad, 1, 2)", { self: { bad: boom } })).toBe(boom);
    expect(run("if(missing, 1, 2)")).toMatchObject({ code: "#NAME" });
  });

  test("the condition uses truthiness and never broadcasts", () => {
    expect(run("if([false], 1, 2)")).toEqual(num(1));
    expect(run("if([], 1, 2)")).toEqual(num(2));
    expect(run("if(empty, 1, 2)")).toEqual(num(2));
  });

  test("the chosen branch may be an error", () => {
    expect(run("if(true, 1 / 0, 2)")).toMatchObject({ code: "#DIV0" });
  });

  test("if takes exactly three arguments", () => {
    expect(run("if(true, 1)")).toMatchObject({ code: "#TYPE" });
    expect(run("if(true, 1, 2, 3)")).toMatchObject({ code: "#TYPE" });
  });

  test("if is in the core registry", () => {
    expect(run("if(true, 1, 2)", {}, { registry: coreRegistry() })).toEqual(num(1));
  });
});

describe("iserror", () => {
  test("true iff the argument is an error", () => {
    expect(run("iserror(1 / 0)")).toEqual(bool(true));
    expect(run("iserror(missing)")).toEqual(bool(true));
    expect(run("iserror(1)")).toEqual(bool(false));
    expect(run("iserror(empty)")).toEqual(bool(false));
    expect(run("iserror([1, 2])")).toEqual(bool(false));
  });

  test("if(iserror(x), 0, x)", () => {
    expect(run("if(iserror(x), 0, x)", { self: { x: boom } })).toEqual(num(0));
    expect(run("if(iserror(x), 0, x)", { self: { x: num(5) } })).toEqual(num(5));
  });

  test("iserror takes exactly one argument", () => {
    expect(run("iserror(1, 2)")).toMatchObject({ code: "#TYPE" });
    expect(run("iserror()")).toMatchObject({ code: "#TYPE" });
  });

  test("iserror is in the core registry", () => {
    expect(run("iserror(1 / 0)", {}, { registry: coreRegistry() })).toEqual(bool(true));
  });
});
