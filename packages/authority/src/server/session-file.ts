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
  linkSync,
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
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseSessionInfo(text);
}

/** Parses session file content; null when it is not a valid `SessionInfo`. */
function parseSessionInfo(text: string): SessionInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
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

/** The filesystem calls `removeSessionFile` makes; injectable for race tests. */
export interface SessionFs {
  renameSync(from: string, to: string): void;
  readFileSync(path: string, encoding: "utf8"): string;
  /** Creates `to` as a hard link to `from`; fails with EEXIST when `to` exists. */
  linkSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

/** The real filesystem. */
export const nodeSessionFs: SessionFs = {
  renameSync: (from, to) => renameSync(from, to),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  linkSync: (from, to) => linkSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
};

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

/**
 * Removes the session file only when it names `pid`; returns whether it was
 * removed. A missing, invalid or foreign file is left in place.
 *
 * Without a cross-process lock, and never deleting a newer authority's file:
 * the file is first renamed aside (`<path>.removing-<pid>-<nonce>`, atomic),
 * so this call owns exactly the file that was at `path` (or gets ENOENT and
 * stops). The moved file is then read: if it names `pid` it is unlinked;
 * otherwise it is restored with `link` (which, unlike `rename`, never
 * replaces a file a yet newer authority wrote meanwhile) and the moved name
 * unlinked; when `path` already exists again, the moved copy is older and is
 * simply unlinked. Readers may therefore observe a brief absence of the file
 * while another process's file is being restored, and should retry (a
 * discovery-based client already keeps retrying on a missing file).
 */
export function removeSessionFile(
  pid: number,
  path: string = sessionFilePath(),
  fs: SessionFs = nodeSessionFs,
): boolean {
  const moved = `${path}.removing-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(path, moved);
  } catch {
    // ENOENT: there is no file. Any other failure: leave whatever is there.
    return false;
  }
  let text: string | null;
  try {
    text = fs.readFileSync(moved, "utf8");
  } catch {
    text = null;
  }
  if (text !== null && parseSessionInfo(text)?.pid === pid) {
    try {
      fs.unlinkSync(moved);
    } catch {
      // Best effort: the session file is gone from `path` either way.
    }
    return true;
  }
  // Not ours (or unreadable): put it back unless a newer file now exists.
  try {
    fs.linkSync(moved, path);
  } catch (err) {
    if (codeOf(err) !== "EEXIST") {
      // No hard links here: fall back to a rename back. It would replace a
      // file that appeared since the failed link, the one window this path
      // cannot close; the moved file is kept when the rename fails.
      try {
        fs.renameSync(moved, path);
      } catch {
        // Leave the moved file for a human; nothing at `path` is touched.
      }
      return false;
    }
  }
  try {
    fs.unlinkSync(moved);
  } catch {
    // Best effort.
  }
  return false;
}
