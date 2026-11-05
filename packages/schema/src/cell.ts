import { z } from "zod";
import { isCellContent, isValue } from "./guard";
import type { Value } from "./values";

/** Formula source. Distinct from text, which is always a literal string. */
export interface FormulaContent {
  type: "formula";
  source: string;
}

/** What a cell holds: a literal value or a formula. */
export type CellContent = Value | FormulaContent;

/** A stored cell: its content, and an override only when the content is a formula. */
export interface Cell {
  content: CellContent;
  override?: Value;
}

/** Any storable value; delegates to `isValue`. */
export const ValueSchema = z.custom<Value>((x) => isValue(x), { message: "not a storable value" });

/** A literal value or a formula; delegates to `isCellContent`. */
export const CellContentSchema = z.custom<CellContent>((x) => isCellContent(x), {
  message: "not a cell content",
});

export const CellSchema: z.ZodType<Cell> = z.strictObject({
  content: CellContentSchema,
  override: ValueSchema.optional(),
});

/** A cell name: any non-empty string except `__proto__` (FIXTURES.md §1). */
export const CellNameSchema = z
  .string()
  .min(1)
  .refine((k) => k !== "__proto__", '"__proto__" is not allowed as a key');

/**
 * A record keyed by non-empty names. zod's records silently drop an own
 * `__proto__` key (which JSON.parse creates), so the raw input is checked
 * for one first.
 */
export function strictRecord<T extends z.ZodType>(value: T) {
  return z
    .unknown()
    .superRefine((input, ctx) => {
      if (typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")) {
        ctx.addIssue({
          code: "custom",
          path: ["__proto__"],
          message: '"__proto__" is not allowed as a key',
        });
      }
    })
    .pipe(z.record(CellNameSchema, value));
}
