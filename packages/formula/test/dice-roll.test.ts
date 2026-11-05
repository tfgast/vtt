import { type RandomSource, rollDice } from "@vtt/formula";
import type { RollValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";

/** A RandomSource that returns the given results in order and checks each is in range. */
function scripted(...results: number[]): RandomSource & { remaining(): number } {
  let i = 0;
  return {
    int(min, max) {
      if (i >= results.length) throw new Error("scripted source exhausted");
      const r = results[i++] as number;
      if (r < min || r > max) throw new Error(`scripted ${r} outside ${min}..${max}`);
      return r;
    },
    remaining: () => results.length - i,
  };
}

function roll(expr: string, ...results: number[]): RollValue {
  const rng = scripted(...results);
  const value = rollDice(expr, rng);
  expect(rng.remaining(), `${expr}: unconsumed script results`).toBe(0);
  return value;
}

function rv(expr: string, dice: number[], dropped: number[], total: number): RollValue {
  return { type: "roll", expr, dice, dropped, total };
}

describe("rollDice", () => {
  test("4d6dl1 is the FIXTURES §2 example", () => {
    expect(roll("4d6dl1", 6, 4, 3, 1)).toEqual(rv("4d6dl1", [6, 4, 3], [1], 13));
  });

  test("dh, kh, kl on 6,4,3,1", () => {
    expect(roll("4d6dh1", 6, 4, 3, 1)).toEqual(rv("4d6dh1", [4, 3, 1], [6], 8));
    expect(roll("4d6kh3", 6, 4, 3, 1)).toEqual(rv("4d6kh3", [6, 4, 3], [1], 13));
    expect(roll("4d6kl1", 6, 4, 3, 1)).toEqual(rv("4d6kl1", [1], [6, 4, 3], 1));
  });

  test("ties break by roll index ascending", () => {
    // Kept and dropped are in roll order; the tied die that is kept or
    // dropped is the earlier one, which shows in the position of the other.
    expect(roll("2d20kh1", 7, 7)).toEqual(rv("2d20kh1", [7], [7], 7));
    expect(roll("2d20kl1", 7, 7)).toEqual(rv("2d20kl1", [7], [7], 7));
    expect(roll("3d6dh1", 5, 5, 2)).toEqual(rv("3d6dh1", [5, 2], [5], 7));
    expect(roll("3d6dl1", 2, 5, 2)).toEqual(rv("3d6dl1", [5, 2], [2], 7));
    // Distinguishable positions: the first of the tied dice is the one ranked first.
    expect(roll("3d6kh2", 5, 2, 5)).toEqual(rv("3d6kh2", [5, 5], [2], 10));
    expect(roll("3d6kh1+0", 4, 6, 6).dice).toEqual([6]);
    expect(roll("4d6dh1", 6, 2, 6, 1)).toEqual(rv("4d6dh1", [2, 6, 1], [6], 9));
    expect(roll("4d6dl1", 1, 2, 1, 6)).toEqual(rv("4d6dl1", [2, 1, 6], [1], 9));
    expect(roll("3d6kl1", 3, 1, 1)).toEqual(rv("3d6kl1", [1], [3, 1], 1));
  });

  test("explosion extras are ranked with keep/drop in every mode", () => {
    expect(roll("2d6!kh1", 6, 3, 2)).toEqual(rv("2d6!kh1", [6], [3, 2], 6));
    expect(roll("2d6!kl1", 6, 3, 2)).toEqual(rv("2d6!kl1", [2], [6, 3], 2));
    expect(roll("2d6!dh1", 6, 3, 2)).toEqual(rv("2d6!dh1", [3, 2], [6], 5));
    expect(roll("2d6!dl1", 6, 1, 4)).toEqual(rv("2d6!dl1", [6, 4], [1], 10));
  });

  test("extras are appended right after the die that exploded", () => {
    expect(roll("2d6!", 6, 6, 1, 3)).toEqual(rv("2d6!", [6, 6, 1, 3], [], 16));
    expect(roll("2d6!", 2, 6, 5)).toEqual(rv("2d6!", [2, 6, 5], [], 13));
  });

  test("1d6! rolling 6,6,2", () => {
    expect(roll("1d6!", 6, 6, 2)).toEqual(rv("1d6!", [6, 6, 2], [], 14));
  });

  test("explosion stops after 100 extras per original die", () => {
    const always6: RandomSource = { int: (_min, max) => max };
    const one = rollDice("1d6!", always6);
    expect(one.dice).toHaveLength(101);
    expect(one.total).toBe(606);
    expect(rollDice("2d6!", always6).dice).toHaveLength(202);
  });

  test("reroll once; the original goes to dropped", () => {
    expect(roll("1d20r<2", 1, 1)).toEqual(rv("1d20r<2", [1], [1], 1));
    expect(roll("1d20r<2", 1, 17)).toEqual(rv("1d20r<2", [17], [1], 17));
    expect(roll("1d20r<2", 2)).toEqual(rv("1d20r<2", [2], [], 2));
    expect(roll("2d6r=3", 3, 4, 2)).toEqual(rv("2d6r=3", [4, 2], [3], 6));
    expect(roll("1d6r>5", 6, 2)).toEqual(rv("1d6r>5", [2], [6], 2));
  });

  test("a rerolled die that shows the maximum explodes; extras are not rerolled", () => {
    expect(roll("1d6r<2!", 1, 6, 1)).toEqual(rv("1d6r<2!", [6, 1], [1], 7));
  });

  test("rerolled originals and keep/drop drops merge in roll order", () => {
    // Die 1: 1 rerolled to 5. Die 2: 2. Die 3: 6. dl1 drops the 2.
    expect(roll("3d6r<2dl1", 1, 5, 2, 6)).toEqual(rv("3d6r<2dl1", [5, 6], [1, 2], 11));
    expect(roll("2d6r<2kh1", 4, 1, 3)).toEqual(rv("2d6r<2kh1", [4], [1, 3], 4));
  });

  test("negative terms subtract, the constant adds", () => {
    expect(roll("1d20-1d4", 15, 3)).toEqual(rv("1d20-1d4", [15, 3], [], 12));
    expect(roll("1d8+3", 5)).toEqual(rv("1d8+3", [5], [], 8));
    expect(roll("-1d4-2", 4)).toEqual(rv("-1d4-2", [4], [], -6));
  });

  test("Fudge dice roll -1..1", () => {
    expect(roll("4dF", -1, 0, 1, 1)).toEqual(rv("4dF", [-1, 0, 1, 1], [], 1));
  });

  test("expr is normalized", () => {
    expect(roll("2 + d6kh1! + 1", 6, 2).expr).toBe("1d6!kh1+3");
  });

  test("rejects an expression that does not parse", () => {
    expect(() => rollDice("1d1", scripted())).toThrow(RangeError);
  });
});
