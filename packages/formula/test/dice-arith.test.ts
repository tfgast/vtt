import {
  addDice,
  type DiceExpr,
  isDiceError,
  negateDice,
  parseDice,
  renderDice,
} from "@vtt/formula";
import { describe, expect, test } from "vitest";

function ok(expr: string): DiceExpr {
  const result = parseDice(expr);
  if (isDiceError(result)) throw new Error(`${expr}: ${result.error}`);
  return result;
}

function sum(a: DiceExpr, b: DiceExpr | number): string {
  const result = addDice(a, b);
  if (isDiceError(result)) throw new Error(result.error);
  return renderDice(result);
}

describe("addDice", () => {
  test("dice + dice concatenates terms and sums constants", () => {
    expect(sum(ok("1d8+1"), ok("1d6+2"))).toBe("1d8+1d6+3");
    expect(sum(ok("1d20"), ok("-1d4-1"))).toBe("1d20-1d4-1");
  });

  test("dice + dice + number", () => {
    const first = addDice(ok("1d8"), ok("1d6"));
    if (isDiceError(first)) throw new Error(first.error);
    expect(sum(first, 2)).toBe("1d8+1d6+2");
  });

  test("dice + integer", () => {
    expect(sum(ok("1d8"), 3)).toBe("1d8+3");
    expect(sum(ok("1d8+3"), -3)).toBe("1d8");
    expect(sum(ok("1d8"), -5)).toBe("1d8-5");
  });

  test("number + dice equals dice + number after normalization", () => {
    expect(sum(ok("1d6"), 2)).toBe(renderDice(ok("2+1d6")));
  });

  test("does not mutate its inputs", () => {
    const a = ok("1d8+1");
    const b = ok("1d6");
    sum(a, b);
    expect(renderDice(a)).toBe("1d8+1");
    expect(renderDice(b)).toBe("1d6");
  });

  test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])(
    "non-integer %s is an error",
    (n) => {
      const result = addDice(ok("1d6"), n);
      expect(isDiceError(result)).toBe(true);
    },
  );
});

describe("negateDice", () => {
  test("flips every term's sign and the constant", () => {
    expect(renderDice(negateDice(ok("1d6+2")))).toBe("-1d6-2");
    expect(renderDice(negateDice(ok("-1d6+1d4-3")))).toBe("1d6-1d4+3");
  });

  test("a zero constant stays zero, not negative zero", () => {
    expect(Object.is(negateDice(ok("1d6")).constant, 0)).toBe(true);
  });

  test("keeps modifiers", () => {
    expect(renderDice(negateDice(ok("4d6r<2!dl1")))).toBe("-4d6r<2!dl1");
  });
});
