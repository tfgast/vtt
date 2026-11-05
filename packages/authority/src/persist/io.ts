/**
 * Saving to and loading from a path (DESIGN.md §7, Persistence; Saving;
 * Revisions and assets). Serialization and parsing stay pure in
 * serialize.ts and parse.ts; this module adds the filesystem.
 */
/// <reference types="node" />
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TableFile } from "@vtt/schema";
import type { DocumentStore } from "../store/document-store";
import { canonicalJson } from "./canonical";
import { migrate } from "./migrate";
import { type LoadWarning, type ParsedTable, parseTable } from "./parse";
import { serializeTable } from "./serialize";

/** An open file, as much of it as saving needs. */
export interface FileHandleLike {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The filesystem calls saving and loading make; injectable for fault tests. */
export interface PersistFs {
  /** `"wx"` creates the temp file; `"r"` opens the directory to fsync it. */
  open(path: string, flags: "wx" | "r"): Promise<FileHandleLike>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  /** Resolves when `path` exists; rejects otherwise. */
  stat(path: string): Promise<unknown>;
}

/** The real filesystem. */
export const nodeFs: PersistFs = {
  open: (path, flags) => fsp.open(path, flags),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  readFile: (path, encoding) => fsp.readFile(path, encoding),
  stat: (path) => fsp.stat(path),
};

/**
 * How a save ended. `before_replace`: the old file (or its absence) is
 * untouched and no temp file is left. `after_replace`: the new file is in
 * place and intact, but the directory fsync failed, so durability is not
 * confirmed.
 */
export type SaveResult =
  | { ok: true }
  | { ok: false; stage: "before_replace" | "after_replace"; error: unknown };

/** Directory fsync errors from platforms that refuse it; not failures. */
const DIR_SYNC_REFUSED: ReadonlySet<string> = new Set(["EISDIR", "EPERM"]);

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

/**
 * Saves `store` and `assets` to `path` atomically (DESIGN.md §7, Saving):
 * writes `<path>.tmp-<pid>-<random>` beside it, fsyncs it, renames it over
 * `path`, then fsyncs the directory (EISDIR and EPERM there are ignored).
 *
 * The store and assets are serialized synchronously, before anything is
 * awaited, so the file holds the state at the moment of the call; changes
 * made after the call returns its promise never reach it. An invalid asset
 * path rejects (InvalidAssetPathError) before anything is written.
 */
export async function saveTable(
  path: string,
  store: DocumentStore,
  assets: readonly string[],
  fs: PersistFs = nodeFs,
): Promise<SaveResult> {
  const text = canonicalJson(serializeTable(store, assets));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;

  let created = false;
  try {
    const handle = await fs.open(temp, "wx");
    created = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, path);
  } catch (error) {
    if (created) await fs.unlink(temp).catch(() => undefined);
    return { ok: false, stage: "before_replace", error };
  }

  try {
    const handle = await fs.open(dirname(path), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = codeOf(error);
    if (typeof code === "string" && DIR_SYNC_REFUSED.has(code)) return { ok: true };
    return { ok: false, stage: "after_replace", error };
  }
  return { ok: true };
}

/** Something loading from a path noticed that does not stop it. */
export type LoadTableWarning =
  | LoadWarning
  /** An asset named by the file is not there, relative to the file's directory. */
  | { type: "missing_asset"; path: string; message: string };

export interface LoadedTable extends Omit<ParsedTable, "warnings"> {
  /** The file's asset paths, relative to its directory, as written. */
  assets: string[];
  warnings: LoadTableWarning[];
}

/**
 * Loads the table at `path`: reads it, `parseTable`s it (a TableLoadError
 * or the read error rejects), then checks that each asset, resolved against
 * the file's directory, exists. A missing asset is a warning; the table
 * loads anyway.
 */
export async function loadTable(path: string, fs: PersistFs = nodeFs): Promise<LoadedTable> {
  const text = await fs.readFile(path, "utf8");
  const parsed = parseTable(text);
  // parseTable has already validated this same pipeline; only the asset list is read.
  const assets = [...(migrate(JSON.parse(text)) as unknown as TableFile).assets];
  const warnings: LoadTableWarning[] = [...parsed.warnings];
  const base = dirname(path);
  for (const asset of assets) {
    try {
      await fs.stat(resolve(base, asset));
    } catch (err) {
      const code = codeOf(err);
      warnings.push({
        type: "missing_asset",
        path: asset,
        message: `asset ${JSON.stringify(asset)} is missing${typeof code === "string" ? ` (${code})` : ""}`,
      });
    }
  }
  return { store: parsed.store, editedExternally: parsed.editedExternally, assets, warnings };
}
