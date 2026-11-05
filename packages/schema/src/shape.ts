import { z } from "zod";

/** A point in board units. */
export type Point = [number, number];

/**
 * A region or outline, relative to its object's anchor. Positivity and
 * polygon simplicity are document invariants, not checked by the value guard.
 */
export type Shape =
  | { type: "rect"; width: number; height: number }
  | { type: "circle"; radius: number }
  | { type: "polygon"; points: Point[] };

/** An axis-aligned box in board units. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const FinitePoint = z.tuple([z.number(), z.number()]);

/**
 * Structural schema for a shape: strict, finite numbers. Like the value guard,
 * it leaves positivity and polygon simplicity to `validateSnapshot`.
 */
export const ShapeSchema: z.ZodType<Shape> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("rect"), width: z.number(), height: z.number() }),
  z.strictObject({ type: z.literal("circle"), radius: z.number() }),
  z.strictObject({ type: z.literal("polygon"), points: z.array(FinitePoint) }),
]);
