/**
 * Ink strokes with their own pen (DESIGN.md §4.6 Ink and text; M6-D28): a
 * stroke is a bare point list or `{points, color?, width?}`.
 */
import {
  INK_MAX_WIDTH,
  isInkColor,
  isInkWidth,
  isValue,
  type Stroke,
  strokePoints,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";

const ink = (...strokes: unknown[]) => ({ type: "ink", strokes });
const line = [
  [0, 0],
  [1, 1],
];

describe("pen strokes", () => {
  const valid: Record<string, unknown> = {
    "bare point list (old files)": ink(line),
    "points only": ink({ points: line }),
    "color only": ink({ points: line, color: "#d32f2f" }),
    "upper-case color": ink({ points: line, color: "#D32F2F" }),
    "width only": ink({ points: line, width: 0.08 }),
    "color and width": ink({ points: line, color: "#1e63d6", width: 0.16 }),
    "widest width": ink({ points: line, width: INK_MAX_WIDTH }),
    "mixed forms": ink(line, { points: [[2, 2]], color: "#ffffff" }),
  };
  for (const [name, x] of Object.entries(valid)) {
    test(`accepts ${name}`, () => {
      expect(isValue(x)).toBe(true);
      expect(JSON.parse(JSON.stringify(x))).toEqual(x);
    });
  }

  const invalid: Record<string, unknown> = {
    "no points": ink({ color: "#202020" }),
    "empty points": ink({ points: [] }),
    "bad point": ink({ points: [[0, Number.NaN]] }),
    "short color": ink({ points: line, color: "#fff" }),
    "named color": ink({ points: line, color: "red" }),
    "rgb() color": ink({ points: line, color: "rgb(0,0,0)" }),
    "color with alpha": ink({ points: line, color: "#20202080" }),
    "non-string color": ink({ points: line, color: 0x202020 }),
    "zero width": ink({ points: line, width: 0 }),
    "negative width": ink({ points: line, width: -0.04 }),
    "too wide": ink({ points: line, width: INK_MAX_WIDTH + 0.01 }),
    "infinite width": ink({ points: line, width: Number.POSITIVE_INFINITY }),
    "string width": ink({ points: line, width: "0.04" }),
    "unknown key": ink({ points: line, pressure: 0.5 }),
    "null stroke": ink(null),
  };
  for (const [name, x] of Object.entries(invalid)) {
    test(`refuses ${name}`, () => {
      expect(isValue(x)).toBe(false);
    });
  }

  test("isInkColor and isInkWidth", () => {
    expect(isInkColor("#a0b1c2")).toBe(true);
    expect(isInkColor("a0b1c2")).toBe(false);
    expect(isInkWidth(0.04)).toBe(true);
    expect(isInkWidth(Number.NaN)).toBe(false);
  });

  test("strokePoints reads either form", () => {
    const bare: Stroke = [[0, 0]];
    expect(strokePoints(bare)).toBe(bare);
    const pen: Stroke = { points: [[1, 2]], width: 0.1 };
    expect(strokePoints(pen)).toEqual([[1, 2]]);
  });
});
