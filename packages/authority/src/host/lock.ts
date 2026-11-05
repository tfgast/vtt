/**
 * The table lock file (PROTOCOL.md §2, Lock file; DESIGN.md §7, Persistence;
 * decisions D25, D33). One authority owns a table file: it holds
 * `<canonical>.lock`, created exclusively. No code path here takes a lock
 * over; removing a lock is a human decision (`removeTableLock`, used only
 * by `vtt-serve --force-unlock`).
 *
 * This module imports only Node built-ins and types, so a child process can
 * load it directly with Node's type stripping.
 */
/// <reference types="node" />
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { hostname } from "node:os";
import type { FileHandleLike, PersistFs } from "../persist/io";

/** The filesystem calls the lock and identity files make; injectable for fault tests. */
export interface TableFs extends Pick<PersistFs, "readFile" | "rename" | "unlink"> {
  /** Exclusive create of the lock or temp identity file. */
  open(path: string, flags: "wx"): Promise<FileHandleLike>;
  realpathSync(path: string): string;
}

/** The real filesystem. */
export const nodeTableFs: TableFs = {
  open: (path, flags) => fsp.open(path, flags),
  readFile: (path, encoding) => fsp.readFile(path, encoding),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  realpathSync: (path) => realpathSync(path),
};

/** The content of a lock file. */
export type LockInfo = { pid: number; nonce: string; host: string; started: string };

/** A held table lock. */
export interface TableLock {
  /** `<canonical>.lock`. */
  readonly path: string;
  readonly nonce: string;
  /** Unlinks the lock file only if it still holds this lock's nonce; idempotent. */
  release(): Promise<void>;
}

/**
 * The table is locked. `info` is the lock file's content, null when it is
 * unreadable or malformed. `stale` is true only when `info` is valid, its
 * host is this host, and its pid is not alive. A stale lock is still
 * refused (D33).
 */
export class TableLockedError extends Error {
  readonly info: LockInfo | null;
  readonly stale: boolean;

  constructor(lockPath: string, info: LockInfo | null, stale: boolean) {
    const holder = info
      ? `pid ${info.pid} on ${info.host}, started ${info.started}`
      : "unreadable or malformed lock file";
    super(`table is locked: ${lockPath} (${holder}${stale ? "; the process is not running" : ""})`);
    this.name = "TableLockedError";
    this.info = info;
    this.stale = stale;
  }
}

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

/** The lock path for a canonical table path. */
const lockPathOf = (canonicalPath: string): string => `${canonicalPath}.lock`;

/** Parses lock file content; null when it is not a valid `LockInfo`. */
function parseLockInfo(text: string): LockInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { pid, nonce, host, started } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  if (typeof nonce !== "string" || nonce === "") return null;
  if (typeof host !== "string" || typeof started !== "string") return null;
  return { pid: pid as number, nonce, host, started };
}

type LockRead =
  | { kind: "missing" }
  | { kind: "unreadable"; error: unknown }
  | { kind: "read"; text: string };

async function readLock(fs: TableFs, lockPath: string): Promise<LockRead> {
  try {
    return { kind: "read", text: await fs.readFile(lockPath, "utf8") };
  } catch (err) {
    return codeOf(err) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", error: err };
  }
}

async function unlinkIfPresent(fs: TableFs, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }
}

/** Whether a local pid is alive: `process.kill(pid, 0)` without ESRCH. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return codeOf(err) !== "ESRCH";
  }
}

/**
 * Acquires `<canonicalPath>.lock` (PROTOCOL.md §2): exclusive create, write
 * `{pid, nonce, host, started}`, fsync, close. Any failure after the create
 * unlinks the file this call created (unless it by then holds another
 * nonce) and rethrows the original error. An existing lock throws
 * `TableLockedError`; it is never taken over.
 *
 * `canonicalPath` must come from `canonicalTablePath`.
 */
export async function acquireTableLock(
  canonicalPath: string,
  opts: { fs?: TableFs; hostname?: string; isAlive?: (pid: number) => boolean } = {},
): Promise<TableLock> {
  const fs = opts.fs ?? nodeTableFs;
  const host = opts.hostname ?? hostname();
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const lockPath = lockPathOf(canonicalPath);
  const nonce = randomBytes(16).toString("hex");
  const info: LockInfo = { pid: process.pid, nonce, host, started: new Date().toISOString() };

  let handle: FileHandleLike;
  try {
    handle = await fs.open(lockPath, "wx");
  } catch (err) {
    if (codeOf(err) !== "EEXIST") throw err;
    const read = await readLock(fs, lockPath);
    const held = read.kind === "read" ? parseLockInfo(read.text) : null;
    const stale = held !== null && held.host === host && !isAlive(held.pid);
    throw new TableLockedError(lockPath, held, stale);
  }

  let failed = false;
  let failure: unknown;
  try {
    await handle.writeFile(JSON.stringify(info), "utf8");
    await handle.sync();
  } catch (err) {
    failed = true;
    failure = err;
  }
  try {
    await handle.close();
  } catch (err) {
    if (!failed) {
      failed = true;
      failure = err;
    }
  }
  if (failed) {
    // The exclusive create proved the file is this call's: unlink it unless
    // it now holds another lock's nonce (it was removed and re-acquired).
    const read = await readLock(fs, lockPath);
    const now = read.kind === "read" ? parseLockInfo(read.text) : null;
    if (read.kind !== "missing" && (now === null || now.nonce === nonce)) {
      await unlinkIfPresent(fs, lockPath).catch(() => undefined);
    }
    throw failure;
  }

  let released: Promise<void> | undefined;
  const release = async (): Promise<void> => {
    const read = await readLock(fs, lockPath);
    if (read.kind === "missing") return;
    // A lock that cannot be read is not unlinked; the error is reported.
    if (read.kind === "unreadable") throw read.error;
    if (parseLockInfo(read.text)?.nonce !== nonce) return;
    await unlinkIfPresent(fs, lockPath);
  };
  return {
    path: lockPath,
    nonce,
    release: () => {
      // Concurrent and repeated calls share one attempt; a failed attempt may be retried.
      released ??= release().catch((err: unknown) => {
        released = undefined;
        throw err;
      });
      return released;
    },
  };
}

/**
 * Reads and unlinks `<canonicalPath>.lock` unconditionally, returning what
 * it removed: its info, or null when there was no lock or its content was
 * unreadable or malformed. For `vtt-serve --force-unlock` only; never
 * called by `TableHost`.
 */
export async function removeTableLock(
  canonicalPath: string,
  fs: TableFs = nodeTableFs,
): Promise<LockInfo | null> {
  const lockPath = lockPathOf(canonicalPath);
  const read = await readLock(fs, lockPath);
  if (read.kind === "missing") return null;
  await unlinkIfPresent(fs, lockPath);
  return read.kind === "read" ? parseLockInfo(read.text) : null;
}
