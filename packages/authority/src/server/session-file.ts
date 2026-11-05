/**
 * The discovery file (PROTOCOL.md §2, Discovery; decision D5):
 * `$XDG_CONFIG_HOME/vtt/session.json` (default `~/.config/vtt/session.json`)
 * holding `{url, token, pid, table_path, table_id}`. `vtt-serve` writes it
 * once listening and removes it on shutdown only while it still names its
 * own pid; the last started authority wins. The directory has mode 0700 and
 * the file 0600; the file is replaced atomically (temp file and rename).
 */
/// <reference types="node" />
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** The content of the session file. */
export interface SessionInfo {
  /** `ws://127.0.0.1:<port>/ws`. */
  url: string;
  token: string;
  /** The `vtt-serve` process that wrote the file. */
  pid: number;
  /** The canonical table path (`TableHost.path`). */
  table_path: string;
  /** The content of `<table_path>.table-id` (`TableHost.tableId`). */
  table_id: string;
}

/**
 * `$XDG_CONFIG_HOME/vtt/session.json`, or `~/.config/vtt/session.json` when
 * `XDG_CONFIG_HOME` is unset, empty or relative (the XDG Base Directory
 * specification ignores a relative value).
 */
export function sessionFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, "vtt", "session.json");
}

/**
 * Writes the session file atomically: creates its directory (mode 0700,
 * also applied to an existing `vtt` directory), writes a temp file beside it
 * with mode 0600, fsyncs it and renames it over `path`.
 */
export function writeSessionFile(info: SessionInfo, path: string = sessionFilePath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const content: SessionInfo = {
    url: info.url,
    token: info.token,
    pid: info.pid,
    table_path: info.table_path,
    table_id: info.table_id,
  };
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeSync(fd, `${JSON.stringify(content)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The umask can only narrow 0600, but make the mode exact.
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Already renamed or never written; nothing to clean up.
    }
    throw err;
  }
}

/** Reads the session file; null when it is missing, unreadable or invalid. Unknown keys are ignored. */
export function readSessionFile(path: string = sessionFilePath()): SessionInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { url, token, pid, table_path, table_id } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof token !== "string") return null;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof table_path !== "string" || typeof table_id !== "string") return null;
  return { url, token, pid, table_path, table_id };
}

/**
 * Removes the session file only when it names `pid`; returns whether it was
 * removed. A missing, invalid or foreign file is left alone.
 */
export function removeSessionFile(pid: number, path: string = sessionFilePath()): boolean {
  if (readSessionFile(path)?.pid !== pid) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
