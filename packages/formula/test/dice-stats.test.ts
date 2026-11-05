import {
  type DiceExpr,
  faces,
  isDiceError,
  maxRoll,
  minRoll,
  parseDice,
  sides,
} from "@vtt/formula";
import { describe, expect, test } from "vitest";

function ok(expr: string): DiceExpr {
  const result = parseDice(expr);
  if (isDiceError(result)) throw new Error(`${expr}: ${result.error}`);
  return result;
}

describe("maxRoll and minRoll", () => {
  test.each([
    ["1d20", 20, 1],
    ["2d6+3", 15, 5],
    ["4d6dl1", 18, 3],
    ["4d6dh1", 18, 3],
    ["2d20kh1", 20, 1],
    ["2d20kl1", 20, 1],
    ["1d20-1d4", 19, -3],
    ["1d6!", 6, 1],
    ["1d20r<2", 20, 1],
    ["4dF", 4, -4],
    ["4dFkh2", 2, -2],
    ["-dF", 1, -1],
    ["-2d6-1", -3, -13],
    ["1d8+1d6+2", 16, 4],
  ])("%s: max %i, min %i", (expr, max, min) => {
    expect(maxRoll(ok(expr))).toBe(max);
    expect(minRoll(ok(expr))).toBe(min);
  });
});

describe("faces", () => {
  test.each([
    ["1d20", 1],
    ["8d6", 8],
    ["4d6dl1", 4],
    ["1d20-1d4+3", 2],
    ["4dF+2d6", 6],
  ])("%s has %i dice", (expr, n) => {
    expect(faces(ok(expr))).toBe(n);
  });
});

describe("sides", () => {
  test("each pool's sides repeated count times, in term order", () => {
    expect(sides(ok("2d6+1d20"))).toEqual([6, 6, 20]);
    expect(sides(ok("1d20+2d6"))).toEqual([20, 6, 6]);
    expect(sides(ok("1d20-1d4+3"))).toEqual([20, 4]);
  });

  test("a Fudge die counts as 3", () => {
    expect(sides(ok("2dF+1d6"))).toEqual([3, 3, 6]);
  });

  test("keep/drop does not change the dice counted", () => {
    expect(sides(ok("4d6dl1"))).toEqual([6, 6, 6, 6]);
  });
});
