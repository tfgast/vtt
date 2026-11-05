import {
  type Cell,
  CellContentSchema,
  CellSchema,
  EMPTY,
  num,
  strictRecord,
  text,
  ValueSchema,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { z } from "zod";

describe("ValueSchema and CellContentSchema", () => {
  test("delegate to the guards", () => {
    expect(ValueSchema.safeParse(num(3)).success).toBe(true);
    expect(ValueSchema.safeParse({ type: "formula", source: "x" }).success).toBe(false);
    expect(ValueSchema.safeParse({ type: "error", code: "#REF" }).success).toBe(false);
    expect(ValueSchema.safeParse({ type: "number", value: 1, extra: 1 }).success).toBe(false);
    expect(CellContentSchema.safeParse({ type: "formula", source: "x" }).success).toBe(true);
    expect(CellContentSchema.safeParse({ type: "formula", source: "  " }).success).toBe(false);
  });
});

describe("CellSchema", () => {
  test("accepts content with and without an override", () => {
    const plain: Cell = { content: text("Goblin") };
    const overridden: Cell = { content: { type: "formula", source: "max_hp" }, override: num(4) };
    expect(CellSchema.parse(plain)).toEqual(plain);
    expect(CellSchema.parse(overridden)).toEqual(overridden);
  });

  test("rejects unknown keys and bad parts", () => {
    expect(CellSchema.safeParse({ content: EMPTY, note: "x" }).success).toBe(false);
    expect(CellSchema.safeParse({ content: { type: "nope" } }).success).toBe(false);
    expect(
      CellSchema.safeParse({ content: EMPTY, override: { type: "formula", source: "x" } }).success,
    ).toBe(false);
    expect(CellSchema.safeParse({}).success).toBe(false);
  });
});

describe("strictRecord", () => {
  const R = strictRecord(z.number());

  test("accepts any non-empty key, including prototype names", () => {
    expect(R.parse({ a: 1, constructor: 2, toString: 3, "Max HP": 4 })).toEqual({
      a: 1,
      constructor: 2,
      toString: 3,
      "Max HP": 4,
    });
  });

  test("rejects __proto__ and the empty key", () => {
    expect(R.safeParse(JSON.parse('{"__proto__": 1}')).success).toBe(false);
    expect(R.safeParse({ "": 1 }).success).toBe(false);
  });
});
