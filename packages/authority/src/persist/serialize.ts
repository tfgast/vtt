/** Serialization (DESIGN.md §7, The file; Revisions and assets). */
import { FILE_FORMAT, SCHEMA_VERSION, type TableFile, type TableLog } from "@vtt/schema";
import type { DocumentStore } from "../store/document-store";
import { snapshotHash } from "./canonical";

/** Absolute POSIX, Windows drive and UNC paths, as the file schema refuses them. */
const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:)/;

/** Asset paths that are not relative to the file's directory. */
export class InvalidAssetPathError extends Error {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(
      `asset paths must be relative to the file's directory: ${paths.map((p) => JSON.stringify(p)).join(", ")}`,
    );
    this.name = "InvalidAssetPathError";
    this.paths = paths;
  }
}

/**
 * The file for `store`: its committed snapshot (canonical order), the
 * snapshot's hash, the retained log from its history, and `assets` as given.
 * Every asset path must already be relative (non-empty, no leading `/` or
 * `\`, no drive letter), or InvalidAssetPathError; no path conversion is
 * done. The result is a plain copy that shares nothing with the store.
 * Write it with `canonicalJson`.
 */
export function serializeTable(store: DocumentStore, assets: readonly string[]): TableFile {
  const bad = assets.filter((p) => typeof p !== "string" || p === "" || ABSOLUTE_PATH.test(p));
  if (bad.length > 0) throw new InvalidAssetPathError(bad);
  const snapshot = store.toSnapshot();
  return {
    format: FILE_FORMAT,
    schema_version: SCHEMA_VERSION,
    snapshot,
    snapshot_hash: snapshotHash(snapshot),
    log: structuredClone(store.history.toLog()) as TableLog,
    assets: [...assets],
  };
}
