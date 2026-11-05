/** The saved file (DESIGN.md §7, The file; Persistence; Revisions and assets). */
import { z } from "zod";
import { type Snapshot, SnapshotSchema } from "./document";
import { type OpGroup, OpGroupSchema } from "./ops";

export const FILE_FORMAT = "a-table-of-dumb-objects";

/** The schema version this code writes. Older files migrate one version at a time. */
export const SCHEMA_VERSION = 1;

/** The retained groups, with absolute indices `first_index` …. */
export interface TableLog {
  first_index: number;
  groups: OpGroup[];
  /** An absolute index; groups below it are record only. */
  undo_barrier: number;
}

export interface TableFile {
  format: typeof FILE_FORMAT;
  schema_version: number;
  snapshot: Snapshot;
  /** `sha256:<hex>` of the canonical snapshot JSON; detects hand edits. */
  snapshot_hash: string;
  log: TableLog;
  /** Paths relative to the file's directory. */
  assets: string[];
}

const Count = z.int().nonnegative();

/** Absolute POSIX, Windows drive and UNC paths. */
const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:)/;

const AssetPathSchema = z
  .string()
  .min(1)
  .refine((p) => !ABSOLUTE_PATH.test(p), "asset paths are relative to the file's directory");

export const TableLogSchema: z.ZodType<TableLog> = z.strictObject({
  first_index: Count,
  groups: z.array(OpGroupSchema),
  undo_barrier: Count,
});

/**
 * Structural shape only. Any positive `schema_version` parses, so a loader
 * can migrate older files; the history invariants and the hash are checked on
 * load.
 */
export const TableFileSchema: z.ZodType<TableFile> = z.strictObject({
  format: z.literal(FILE_FORMAT),
  schema_version: z.int().positive(),
  snapshot: SnapshotSchema,
  snapshot_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  log: TableLogSchema,
  assets: z.array(AssetPathSchema),
});
