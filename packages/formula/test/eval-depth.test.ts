import { MAX_AST_DEPTH, parse } from "@vtt/formula";
import { list, num, ref } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";

const repeat = (s: string, n: number) => s.repeat(n);

describe("evaluation at the parser's maximum depth", () => {
  test("the parser accepts depth 256 and rejects 257 (sanity)", () => {
    expect(MAX_AST_DEPTH).toBe(256);
    expect(parse(`1${repeat("+1", MAX_AST_DEPTH)}`).ok).toBe(true);
    expect(parse(`1${repeat("+1", MAX_AST_DEPTH + 1)}`).ok).toBe(false);
  });

  test("a 1+1+… chain gives a value", () => {
    expect(run(`1${repeat("+1", MAX_AST_DEPTH)}`)).toEqual(num(MAX_AST_DEPTH + 1));
  });

  test("an a.b.c… chain gives a value", () => {
    const cells = { self: { n: ref("self") } };
    expect(parse(`n${repeat(".n", MAX_AST_DEPTH)}`).ok).toBe(true);
    expect(run(`n${repeat(".n", MAX_AST_DEPTH)}`, cells)).toEqual(ref("self"));
  });

  test("an a.b.c… chain ending in a missing cell gives a language error", () => {
    const cells = { self: { n: ref("self") } };
    const source = `n${repeat(".n", MAX_AST_DEPTH - 1)}.missing`;
    expect(run(source, cells)).toMatchObject({ type: "error", code: "#NAME" });
  });

  test("nested if calls give a value", () => {
    const source = `${repeat("if(true, ", MAX_AST_DEPTH)}1${repeat(", 0)", MAX_AST_DEPTH)}`;
    expect(parse(source).ok).toBe(true);
    expect(run(source)).toEqual(num(1));
  });

  test("nested lists, parentheses, and prefix operators give values", () => {
    const lists = `${repeat("[", MAX_AST_DEPTH)}1${repeat("]", MAX_AST_DEPTH)}`;
    let expected = list([num(1)]);
    for (let i = 1; i < MAX_AST_DEPTH; i++) expected = list([expected]);
    expect(run(lists)).toEqual(expected);
    expect(run(`${repeat("(", MAX_AST_DEPTH)}1${repeat(")", MAX_AST_DEPTH)}`)).toEqual(num(1));
    expect(run(`${repeat("-", MAX_AST_DEPTH)}1`)).toEqual(num(1));
    expect(run(`${repeat("not ", MAX_AST_DEPTH)}1`)).toMatchObject({ value: true });
  });

  test("a right-nested chain with errors gives a language error", () => {
    const source = `${repeat("1 + (", MAX_AST_DEPTH / 2)}missing${repeat(")", MAX_AST_DEPTH / 2)}`;
    expect(parse(source).ok).toBe(true);
    expect(run(source)).toMatchObject({ type: "error", code: "#NAME" });
  });
});
