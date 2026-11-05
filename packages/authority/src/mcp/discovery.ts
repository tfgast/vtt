/**
 * Discovery-based credentials for `vtt-mcp` (PROTOCOL.md §2, Discovery;
 * M3-D5): a reader over the session file, handed to `enableRecovery` as its
 * `credentials` option, which calls it before every connection attempt.
 * The reader does not retry: a missing file (also during another process's
 * brief removal of it) is `null`, and recovery keeps retrying.
 */
import type { RecoveryCredentials } from "@vtt/protocol";
import { readSessionFile } from "../server/session-file";

/** The session file's `{url, token, table_path, table_id}`. */
export type DiscoveredCredentials = RecoveryCredentials & { table_path: string; table_id: string };

/**
 * Returns a reader of the session file at `path` (default: the
 * `sessionFilePath()` of the environment at each call). Each call re-reads
 * the file and resolves with its credentials, or null when the file is
 * missing, unreadable or invalid.
 */
export function sessionCredentials(path?: string): () => Promise<DiscoveredCredentials | null> {
  return async () => {
    const info = path === undefined ? readSessionFile() : readSessionFile(path);
    if (info === null) return null;
    return {
      url: info.url,
      token: info.token,
      table_path: info.table_path,
      table_id: info.table_id,
    };
  };
}
