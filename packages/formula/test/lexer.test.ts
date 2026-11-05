import { type Token, tokenize } from "@vtt/formula";
import { describe, expect, test } from "vitest";

function kinds(source: string): string[] {
  const result = tokenize(source);
  if (!result.ok) throw new Error(`${result.message} at ${result.offset}`);
  return result.tokens.map((t: Token) => `${t.kind}:${t.value}`);
}

function lexError(source: string): { message: string; offset: number } {
  const result = tokenize(source);
  if (result.ok) throw new Error(`expected a lex error for ${source}`);
  return result;
}

describe("whitespace and punctuation", () => {
  test("whitespace separates tokens and is otherwise ignored", () => {
    expect(kinds(" a\t+\n b ")).toEqual(["ident:a", "punct:+", "ident:b", "eof:"]);
  });

  test("every punctuation token", () => {
    expect(kinds("+ - * / % & = != < <= > >= ( ) [ ] { } , . : ->")).toEqual([
      ...["+", "-", "*", "/", "%", "&", "=", "!=", "<", "<=", ">", ">="].map((p) => `punct:${p}`),
      ...["(", ")", "[", "]", "{", "}", ",", ".", ":", "->"].map((p) => `punct:${p}`),
      "eof:",
    ]);
  });

  test("operators need no surrounding whitespace", () => {
    expect(kinds("a<=b")).toEqual(["ident:a", "punct:<=", "ident:b", "eof:"]);
    expect(kinds("a->b")).toEqual(["ident:a", "punct:->", "ident:b", "eof:"]);
  });

  test("a lone ! or an unknown character is an error", () => {
    expect(lexError("a ! b").offset).toBe(2);
    expect(lexError("a # b").offset).toBe(2);
  });

  test("tokens carry start and end offsets", () => {
    const result = tokenize("ab  >= 12");
    expect(result.ok && result.tokens.map((t) => [t.start, t.end])).toEqual([
      [0, 2],
      [4, 6],
      [7, 9],
      [9, 9],
    ]);
  });
});

describe("numbers", () => {
  test("digits and digits.digits", () => {
    expect(kinds("12 3.5 007")).toEqual(["number:12", "number:3.5", "number:007", "eof:"]);
  });

  test("a number followed by an identifier character is an error", () => {
    expect(lexError("2x")).toMatchObject({ offset: 1 });
    expect(lexError("1e5").offset).toBe(1);
    expect(lexError("1.5x").offset).toBe(3);
    expect(lexError("3_").offset).toBe(1);
  });

  test("a literal that converts to a non-finite number is an error naming it", () => {
    const big = "9".repeat(400);
    expect(lexError(`1 + ${big}`)).toMatchObject({ offset: 4 });
    expect(lexError(big).message).toContain(big);
    expect(kinds(`${"9".repeat(300)}`)).toHaveLength(2);
  });

  test("no trailing dot; no leading dot", () => {
    expect(lexError("1.").offset).toBe(1);
    expect(lexError("1.x").offset).toBe(1);
    expect(kinds(".5")).toEqual(["punct:.", "number:5", "eof:"]);
  });
});

describe("text", () => {
  test('double-quoted with \\" and \\\\ escapes', () => {
    expect(kinds('"goblin" "a\\"b" "c\\\\d"')).toEqual([
      "text:goblin",
      'text:a"b',
      "text:c\\d",
      "eof:",
    ]);
  });

  test("literal newlines are allowed", () => {
    expect(kinds('"a\nb"')).toEqual(["text:a\nb", "eof:"]);
  });

  test("any other backslash sequence is an error at the backslash", () => {
    expect(lexError('"a\\q"')).toMatchObject({ offset: 2 });
    expect(lexError('"a\\n"').offset).toBe(2);
  });

  test("unterminated text is an error at the opening quote", () => {
    expect(lexError('"abc')).toMatchObject({ offset: 0 });
    expect(lexError('"abc\\"').offset).toBe(0);
  });
});

describe("identifiers, keywords, backtick names", () => {
  test("identifiers are case-sensitive", () => {
    expect(kinds("max_hp _x A1 True")).toEqual([
      "ident:max_hp",
      "ident:_x",
      "ident:A1",
      "ident:True",
      "eof:",
    ]);
  });

  test("keywords", () => {
    expect(kinds("true false empty this it all gm and or not has")).toEqual([
      ...["true", "false", "empty", "this", "it", "all", "gm", "and", "or", "not", "has"].map(
        (k) => `keyword:${k}`,
      ),
      "eof:",
    ]);
  });

  test("desc and owner are ordinary identifiers", () => {
    expect(kinds("desc owner")).toEqual(["ident:desc", "ident:owner", "eof:"]);
  });

  test("backtick names are always names", () => {
    expect(kinds("`Max HP` `not` `d6`")).toEqual(["name:Max HP", "name:not", "name:d6", "eof:"]);
  });

  test("an empty or unterminated backtick name is an error", () => {
    expect(lexError("``").offset).toBe(0);
    expect(lexError("a `b").offset).toBe(2);
  });
});

describe("dice literals", () => {
  test.each([
    "2d6",
    "d20",
    "dF",
    "2dF",
    "1d20kh1",
    "4d6dl1",
    "1d6!",
    "2d20kl1",
    "1d20r<2",
    "1d20r>19",
    "1d6r=1",
    "4d6dh1",
    "3d6!kh2r<2",
  ])("%s is one dice token", (raw) => {
    expect(kinds(raw)).toEqual([`dice:${raw}`, "eof:"]);
  });

  test("`d6` is a name", () => {
    expect(kinds("`d6`")).toEqual(["name:d6", "eof:"]);
  });

  test("d6x is an identifier", () => {
    expect(kinds("d6x")).toEqual(["ident:d6x", "eof:"]);
  });

  test("d alone and words starting with d are identifiers", () => {
    expect(kinds("d dmg dF_ desc")).toEqual([
      "ident:d",
      "ident:dmg",
      "ident:dF_",
      "ident:desc",
      "eof:",
    ]);
  });

  test("1d6!=3 is dice, !=, number", () => {
    expect(kinds("1d6!=3")).toEqual(["dice:1d6", "punct:!=", "number:3", "eof:"]);
  });

  test("2d6+3 is dice, +, number", () => {
    expect(kinds("2d6+3")).toEqual(["dice:2d6", "punct:+", "number:3", "eof:"]);
  });

  test("2d6kh falls back to a number followed by an identifier character", () => {
    expect(lexError("2d6kh").offset).toBe(1);
  });
});

describe("tokenize", () => {
  test("reports the first error with its offset", () => {
    expect(lexError('a + "x')).toMatchObject({ offset: 4 });
  });
});
