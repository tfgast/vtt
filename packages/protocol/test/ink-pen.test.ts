/**
 * Pen strokes on the wire (M6-D28; PROTOCOL.md §5, §7.1): input strokes are
 * strict, wire strokes strip unknown keys; colour and width are validated.
 */
import { InputValueSchema, WireValueSchema } from "@vtt/protocol";
import { describe, expect, test } from "vitest";

const ink = (...strokes: unknown[]) => ({ type: "ink", strokes });
const line = [
  [0, 0],
  [1, 1],
];

describe("input ink", () => {
  test("accepts bare and pen strokes unchanged", () => {
    const value = ink(line, { points: line, color: "#d32f2f", width: 0.08 }, { points: line });
    expect(InputValueSchema.parse(value)).toEqual(value);
  });

  test.each([
    ["a short colour", { points: line, color: "#fff" }],
    ["a named colour", { points: line, color: "red" }],
    ["a zero width", { points: line, width: 0 }],
    ["a width over the maximum", { points: line, width: 1.5 }],
    ["an unknown key", { points: line, pressure: 1 }],
    ["no points", { color: "#202020" }],
  ])("refuses %s", (_name, stroke) => {
    expect(InputValueSchema.safeParse(ink(stroke)).success).toBe(false);
  });
});

describe("wire ink", () => {
  test("keeps colour and width, strips unknown pen keys", () => {
    const parsed = WireValueSchema.parse(
      ink(line, { points: line, color: "#1e63d6", width: 0.16, pressure: 0.3 }),
    );
    expect(parsed).toEqual(ink(line, { points: line, color: "#1e63d6", width: 0.16 }));
  });

  test("refuses an invalid colour", () => {
    expect(WireValueSchema.safeParse(ink({ points: line, color: "blue" })).success).toBe(false);
  });
});
