import { type Shape, ShapeSchema } from "@vtt/schema";
import { describe, expect, test } from "vitest";

describe("ShapeSchema", () => {
  const good: Shape[] = [
    { type: "rect", width: 2, height: 1 },
    { type: "circle", radius: 4 },
    {
      type: "polygon",
      points: [
        [0, 0],
        [2, 0],
        [1, 2],
      ],
    },
  ];

  test("accepts each kind", () => {
    for (const s of good) expect(ShapeSchema.parse(s)).toEqual(s);
  });

  test("rejects unknown keys, unknown kinds and non-finite numbers", () => {
    expect(ShapeSchema.safeParse({ type: "circle", radius: 1, x: 0 }).success).toBe(false);
    expect(ShapeSchema.safeParse({ type: "ellipse", radius: 1 }).success).toBe(false);
    expect(ShapeSchema.safeParse({ type: "circle", radius: Number.NaN }).success).toBe(false);
    expect(ShapeSchema.safeParse({ type: "rect", width: Infinity, height: 1 }).success).toBe(false);
    expect(ShapeSchema.safeParse({ type: "polygon", points: [[0, 0, 0]] }).success).toBe(false);
  });

  test("leaves positivity and simplicity to the document invariants", () => {
    expect(ShapeSchema.safeParse({ type: "circle", radius: 0 }).success).toBe(true);
    expect(ShapeSchema.safeParse({ type: "polygon", points: [] }).success).toBe(true);
  });
});
