/** Objects (DESIGN.md §4.1, §4.3, §4.4; FORMULAS.md §3.1). */
import { z } from "zod";
import { type Cell, CellSchema, strictRecord } from "./cell";
import { isValue } from "./guard";
import type { BoardId, ObjectId } from "./ids";
import { type Shape, ShapeSchema } from "./shape";
import type { ViewersValue } from "./values";

/** A named list of steps (FORMULAS.md §8), all kept as source text. */
export interface ActionDef {
  name: string;
  when?: string;
  steps: string[];
}

/**
 * An object. Field-backed structural cells (`id`, `tag`, `contents`, `board`,
 * `shape`, `is_zone`) are fields here, never entries of `cells`; `container`
 * is derived and never stored. Every other structural cell (`name`,
 * `visible_to`, `owner`, `template`, `face_up`, `opaque`, `position`,
 * `rotation`, `z`) is an ordinary entry of `cells`, absent until written.
 */
export interface TableObject {
  id: ObjectId;
  is_template: boolean;
  is_zone: boolean;
  is_character: boolean;
  /** A literal list of text. */
  tag: string[];
  /** Relative to the anchor `position`. */
  shape: Shape | null;
  /** Non-null exactly when the object is on a board. */
  board: BoardId | null;
  /** Owning and ordered. */
  contents: ObjectId[];
  cells: Record<string, Cell>;
  /**
   * Per-cell visibility, independent of content (DESIGN.md §4.4). A key may
   * name any user or structural cell, stored or not; a cell with no entry
   * defaults to its object's visibility.
   */
  cell_visibility: Record<string, ViewersValue>;
  actions: ActionDef[];
}

/** Source text: non-blank, kept verbatim. */
const SourceSchema = z.string().refine((s) => s.trim().length > 0, "source must not be blank");

export const ActionDefSchema: z.ZodType<ActionDef> = z.strictObject({
  name: z.string().min(1),
  when: SourceSchema.optional(),
  steps: z.array(SourceSchema),
});

/** A viewers value; delegates to `isValue`. */
export const ViewersValueSchema = z.custom<ViewersValue>(
  (x) => isValue(x) && x.type === "viewers",
  { message: "not a viewers value" },
);

/**
 * Structural shape only: strict keys, valid cells, no `__proto__` keys.
 * Document invariants are `validateSnapshot`'s.
 */
export const TableObjectSchema: z.ZodType<TableObject> = z.strictObject({
  id: z.string(),
  is_template: z.boolean(),
  is_zone: z.boolean(),
  is_character: z.boolean(),
  tag: z.array(z.string()),
  shape: ShapeSchema.nullable(),
  board: z.string().nullable(),
  contents: z.array(z.string()),
  cells: strictRecord(CellSchema),
  cell_visibility: strictRecord(ViewersValueSchema),
  actions: z.array(ActionDefSchema),
});
