/// <reference types="node" />
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DiceExpr,
  diceEquals,
  isDiceError,
  normalizeDice,
  parseDice,
  renderDice,
} from "@vtt/formula";
import { describe, expect, test } from "vitest";

function ok(expr: string): DiceExpr {
  const result = parseDice(expr);
  if (isDiceError(result)) throw new Error(`${expr}: ${result.error}`);
  return result;
}

function rejectMessage(expr: string): string {
  const result = parseDice(expr);
  if (!isDiceError(result)) throw new Error(`expected ${expr} to be rejected`);
  return result.error;
}

describe("parseDice structure", () => {
  test("a pool plus a constant", () => {
    expect(ok("2d6+3")).toEqual({
      terms: [{ sign: 1, count: 2, faces: 6, explode: false }],
      constant: 3,
    });
  });

  test("count defaults to 1 and Fudge faces are F", () => {
    expect(ok("d20").terms[0]).toEqual({ sign: 1, count: 1, faces: 20, explode: false });
    expect(ok("dF").terms[0]).toEqual({ sign: 1, count: 1, faces: "F", explode: false });
    expect(ok("4dF").terms[0]).toMatchObject({ count: 4, faces: "F" });
  });

  test("modifiers", () => {
    expect(ok("1d20kh1").terms[0]).toMatchObject({ keep: { mode: "kh", n: 1 } });
    expect(ok("2d20kl1").terms[0]).toMatchObject({ keep: { mode: "kl", n: 1 } });
    expect(ok("4d6dl1").terms[0]).toMatchObject({ keep: { mode: "dl", n: 1 } });
    expect(ok("4d6dh1").terms[0]).toMatchObject({ keep: { mode: "dh", n: 1 } });
    expect(ok("1d6!").terms[0]).toMatchObject({ explode: true });
    expect(ok("1d20r<2").terms[0]).toMatchObject({ reroll: { op: "<", n: 2 } });
    expect(ok("1d20r>19").terms[0]).toMatchObject({ reroll: { op: ">", n: 19 } });
    expect(ok("1d20r=1").terms[0]).toMatchObject({ reroll: { op: "=", n: 1 } });
  });

  test("modifiers in any input order", () => {
    expect(ok("4d6kh3!r<2").terms[0]).toEqual({
      sign: 1,
      count: 4,
      faces: 6,
      explode: true,
      reroll: { op: "<", n: 2 },
      keep: { mode: "kh", n: 3 },
    });
  });

  test("signs, negatives, and summed integers", () => {
    expect(ok("-1d6")).toEqual({
      terms: [{ sign: -1, count: 1, faces: 6, explode: false }],
      constant: 0,
    });
    expect(ok("1d20-1d4")).toMatchObject({ terms: [{ sign: 1 }, { sign: -1, faces: 4 }] });
    expect(ok("2+1d6+1").constant).toBe(3);
    expect(ok("-3+1d6").constant).toBe(-3);
    expect(ok("1d6-5+2").constant).toBe(-3);
  });

  test("whitespace around operators and at the ends", () => {
    expect(ok(" 1d8 + 3 ")).toEqual(ok("1d8+3"));
    expect(ok("1d8\t-\n1d4\r")).toEqual(ok("1d8-1d4"));
  });
});

describe("FORMULAS §2.2 examples parse and normalize", () => {
  test.each([
    ["2d6+3", "2d6+3"],
    ["1d20kh1", "1d20kh1"],
    ["4d6dl1", "4d6dl1"],
    ["1d6!", "1d6!"],
    ["2d20kl1", "2d20kl1"],
    ["dF", "1dF"],
    ["d20", "1d20"],
    ["1d20r<2", "1d20r<2"],
    ["1d8+3", "1d8+3"],
    ["8d6", "8d6"],
  ])("%s → %s", (expr, normalized) => {
    expect(normalizeDice(expr)).toBe(normalized);
  });
});

describe("normalizeDice", () => {
  test.each([
    ["d20", "1d20"],
    ["dF", "1dF"],
    ["1d6kh1!", "1d6!kh1"],
    ["1d6kh1!r<2", "1d6r<2!kh1"],
    ["1d6!r=1", "1d6r=1!"],
    ["1d20kh1", "1d20kh1"],
    ["2+1d6+1", "1d6+3"],
    ["1d6+1-1", "1d6"],
    ["1d6-4+1", "1d6-3"],
    ["1d6+1d20", "1d6+1d20"],
    ["1d20+1d6", "1d20+1d6"],
    ["1d8 + 3", "1d8+3"],
    ["-1d6+2", "-1d6+2"],
    ["-2+d6", "1d6-2"],
    ["3-1d6", "-1d6+3"],
    ["d06", "1d6"],
    ["01d6", "1d6"],
  ])("%s → %s", (expr, normalized) => {
    expect(normalizeDice(expr)).toBe(normalized);
  });

  test("throws on input that does not parse", () => {
    expect(() => normalizeDice("0d6")).toThrow(/count/);
  });
});

describe("diceEquals", () => {
  test("compares normalized expressions", () => {
    expect(diceEquals("1d8+3", "1d8 + 3")).toBe(true);
    expect(diceEquals("d20", "1d20")).toBe(true);
    expect(diceEquals("1d6kh1!", "1d6!kh1")).toBe(true);
  });

  test("term order and semantic differences matter", () => {
    expect(diceEquals("1d6+1d20", "1d20+1d6")).toBe(false);
    expect(diceEquals("1d20kh1", "1d20")).toBe(false);
  });
});

describe("renderDice", () => {
  test.each(["1d20", "2d6+3", "1d6r<2!kh1", "-1d6-2", "1d20-1d4+1", "4dFkl2", "3d10r>9dh1"])(
    "is the inverse of parseDice on canonical input: %s",
    (canonical) => {
      expect(renderDice(ok(canonical))).toBe(canonical);
    },
  );
});

describe("validation", () => {
  test.each([
    ["0d6", /count/],
    ["1001d6", /count/],
    ["1d1", /sides/],
    ["1d0", /sides/],
    ["1d1000001", /sides/],
    ["3", /pool/],
    ["1+2", /pool/],
    ["1d6kh1kl1", /keep/],
    ["1d6kh1dl1", /keep/],
    ["1d6!!", /explode/],
    ["1d6r<2r>5", /reroll/],
    ["2d6kh0", /keep/],
    ["2d6kh3", /keep/],
    ["2d6kl3", /keep/],
    ["2d6dh2", /drop/],
    ["2d6dl2", /drop/],
    ["2d6dl0", /drop/],
    ["1d6dh1", /drop/],
    ["dF!", /Fudge/],
    ["4dFr<1", /Fudge/],
    ["1d6r<0", /reroll/],
    ["1d6r>7", /reroll/],
  ])("%s is rejected", (expr, pattern) => {
    expect(rejectMessage(expr)).toMatch(pattern);
  });

  test.each([
    "",
    " ",
    "D6",
    "1D6",
    "df",
    "1d",
    "d",
    "1d6x",
    "1d6 kh1",
    "1d6kh",
    "1d6r2",
    "1d6r<",
    "1d6+",
    "+1d6",
    "- 1d6",
    "1d6++1",
    "1d6*2",
    "1d6 1d6",
    "1.5+1d6",
    "1d6!=3",
    "1d6+999999999999999999999",
  ])("syntax error: %j", (expr) => {
    expect(rejectMessage(expr).length).toBeGreaterThan(0);
  });

  test("boundary values are accepted", () => {
    expect(ok("1000d6").terms[0]?.count).toBe(1000);
    expect(ok("1d2").terms[0]?.faces).toBe(2);
    expect(ok("1d1000000").terms[0]?.faces).toBe(1000000);
    expect(ok("2d6kh2").terms[0]?.keep).toEqual({ mode: "kh", n: 2 });
    expect(ok("2d6dl1").terms[0]?.keep).toEqual({ mode: "dl", n: 1 });
    expect(ok("1d6r=6").terms[0]?.reroll).toEqual({ op: "=", n: 6 });
    expect(ok("1d6r<1").terms[0]?.reroll).toEqual({ op: "<", n: 1 });
  });
});

const scenarioRoot = join(import.meta.dirname, "..", "..", "fixtures", "scenarios");
const scenarioFiles = (await readdir(scenarioRoot)).filter((f) => f.endsWith(".json")).sort();

describe("fixture dice scripts", () => {
  async function scriptExprs(file: string): Promise<string[]> {
    const scenario = JSON.parse(await readFile(join(scenarioRoot, file), "utf8")) as {
      dice?: { type: string; expr?: string }[];
    };
    return (scenario.dice ?? []).flatMap((e) =>
      e.type === "roll" && typeof e.expr === "string" ? [e.expr] : [],
    );
  }

  test("there are dice script expressions to parse", async () => {
    const all = (await Promise.all(scenarioFiles.map(scriptExprs))).flat();
    expect(all).toContain("1d8+3");
    expect(all).toContain("8d6");
  });

  test.each(scenarioFiles)("%s: every dice script expr parses", async (file) => {
    for (const expr of await scriptExprs(file)) {
      const result = parseDice(expr);
      expect(isDiceError(result) ? result.error : "ok", expr).toBe("ok");
    }
  });
});
