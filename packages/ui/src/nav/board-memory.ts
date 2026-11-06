/**
 * The last active board per table (vtt-qf5.57; DESIGN.md §4.3 Boards,
 * M6-D24). The active board is remembered in `localStorage` under
 * `vtt.board:<table>`, the table being `table.id ?? table.path` from the
 * `welcome` (the camera store's key, vtt-3l6.21); a table with neither (in
 * memory) is not remembered. Once the session first knows the table and its
 * boards, a remembered board still in the board list is shown with
 * `setView`; otherwise the session's default (the first board) stays. From
 * then on every ready active board is stored. Every storage access is
 * guarded, so a refusing or missing `localStorage` only loses the memory.
 * Camera memory is the camera store's.
 */
import type { BoardId } from "@vtt/schema";
import type { TableSession } from "../session/table-session";

/** The part of `Storage` the board memory uses. */
export interface BoardMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BoardMemoryOptions {
  session: Pick<TableSession, "getSnapshot" | "subscribe" | "setView">;
  /** Default: the global `localStorage`, when there is one. */
  storage?: BoardMemoryStorage | null;
}

const PREFIX = "vtt.board";

function defaultStorage(): BoardMemoryStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The storage key of the last active board of `table`; null for a table with neither id nor path. */
export function boardMemoryKey(
  table: { readonly id: string | null; readonly path: string | null } | null,
): string | null {
  const key = table?.id ?? table?.path ?? null;
  return key === null ? null : `${PREFIX}:${key}`;
}

/**
 * Follows `session`: restores the remembered board once, then remembers
 * every active board (see the module comment). Returns the disconnector.
 */
export function rememberActiveBoard(options: BoardMemoryOptions): () => void {
  const { session } = options;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (storage === null) return () => undefined;

  /** The key whose remembered board has been restored (or found absent). */
  let restored: string | null = null;
  /** A restoring `setView` is in flight: the shown board is not the user's choice yet. */
  let restoring = false;
  let written: string | null = null;
  let connected = true;

  const read = (key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };

  const follow = () => {
    const snapshot = session.getSnapshot();
    const key = boardMemoryKey(snapshot.table);
    if (key === null) return;
    if (restored !== key) {
      restored = key;
      written = read(key);
      const board = written;
      if (
        board !== null &&
        board !== snapshot.activeBoard &&
        snapshot.boards.some((b) => b.id === board)
      ) {
        restoring = true;
        void session.setView(board as BoardId, snapshot.viewer).then(() => {
          restoring = false;
          if (connected) follow();
        });
        return;
      }
    }
    if (restoring || !snapshot.ready || snapshot.activeBoard === null) return;
    if (snapshot.activeBoard === written) return;
    written = snapshot.activeBoard;
    try {
      storage.setItem(key, written);
    } catch {
      // Persistence is best effort.
    }
  };

  const off = session.subscribe(() => {
    if (connected) follow();
  });
  follow();
  return () => {
    connected = false;
    off();
  };
}
