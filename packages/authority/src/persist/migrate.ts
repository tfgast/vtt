/**
 * Schema migration (DESIGN.md §7, Persistence; The file): a file with an
 * older `schema_version` migrates one version at a time.
 */
import { SCHEMA_VERSION } from "@vtt/schema";

/** A parsed file's JSON object. */
export type FileJson = Record<string, unknown>;

/**
 * Takes a file at version v to version v + 1. It receives its own copy and
 * may return it changed. `migrate` sets `schema_version` on the result.
 *
 * A migration that changes the snapshot must also re-stamp `snapshot_hash`
 * (when the incoming hash matched the incoming snapshot), or the migrated
 * file reads as hand-edited.
 */
export type Migration = (json: FileJson) => FileJson;

/** `MIGRATIONS[v]` takes version v to v + 1. Empty at version 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({});

/** A file whose version cannot be migrated to the current one. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * The version a registry migrates to: one past its highest step, and never
 * below SCHEMA_VERSION. For MIGRATIONS this is SCHEMA_VERSION.
 */
export function targetVersion(migrations: Readonly<Record<number, Migration>>): number {
  const steps = Object.keys(migrations).map(Number);
  return Math.max(SCHEMA_VERSION, ...steps.map((v) => v + 1));
}

const isRecord = (x: unknown): x is FileJson =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Applies `migrations[v]` (v → v + 1) in sequence from the file's
 * `schema_version` up to `targetVersion(migrations)`, on a copy of `json`.
 * Throws MigrationError for a missing or non-positive-integer
 * `schema_version`, a version newer than the target, or a missing step.
 */
export function migrate(
  json: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
): unknown {
  if (!isRecord(json)) throw new MigrationError("the file is not a JSON object");
  const from = json.schema_version;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) {
    throw new MigrationError(
      `schema_version must be a positive integer, got ${JSON.stringify(from) ?? "nothing"}`,
    );
  }
  const target = targetVersion(migrations);
  if (from > target) {
    throw new MigrationError(
      `schema_version ${from} is newer than this program supports (${target})`,
    );
  }
  let out: FileJson = structuredClone(json);
  for (let v = from; v < target; v++) {
    const step = Object.hasOwn(migrations, v) ? migrations[v] : undefined;
    if (step === undefined) throw new MigrationError(`no migration from version ${v}`);
    const next = step(out);
    if (!isRecord(next)) throw new MigrationError(`migration ${v} did not return an object`);
    out = { ...next, schema_version: v + 1 };
  }
  return out;
}
