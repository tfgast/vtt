/** The document snapshot (DESIGN.md §4.1, §7). */
import { z } from "zod";
import { strictRecord } from "./cell";
import type { BoardId, ObjectId } from "./ids";
import { type TableObject, TableObjectSchema } from "./object";

/** A board, as the fixtures BoardSchema. */
export interface Board {
  id: BoardId;
  name?: string;
}

export interface Snapshot {
  revision: number;
  /** The id counter; only increases (DESIGN.md §4.1). */
  next_seq: number;
  boards: Board[];
  objects: Record<ObjectId, TableObject>;
  /** Board and object ids removed at some point; only grows. A live id may be here. */
  retired_ids: ObjectId[];
}

export const BoardSchema: z.ZodType<Board> = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
});

/** Structural shape only; document invariants are `validateSnapshot`'s. */
export const SnapshotSchema: z.ZodType<Snapshot> = z.strictObject({
  revision: z.int().nonnegative(),
  next_seq: z.number(),
  boards: z.array(BoardSchema),
  objects: strictRecord(TableObjectSchema),
  retired_ids: z.array(z.string()),
});

/**
 * Whether `id` is taken for the document's lifetime: a live board, a live
 * object, or retired. Allocation hands out only ids that are not reserved.
 */
export function isReserved(snapshot: Snapshot, id: string): boolean {
  return (
    Object.hasOwn(snapshot.objects, id) ||
    snapshot.boards.some((b) => b.id === id) ||
    snapshot.retired_ids.includes(id)
  );
}
