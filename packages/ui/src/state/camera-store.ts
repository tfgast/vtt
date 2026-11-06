/**
 * Per-board camera memory (vtt-3l6.21; review r3 finding 11). Cameras are
 * kept for the page and in `localStorage`, keyed by the table
 * (`table.id ?? table.path`) and the board; every storage access is guarded,
 * so a refusing or missing `localStorage` only loses persistence. On an
 * active-board change the camera of the board being left is saved and the
 * new board's is restored; a board with nothing stored is marked `needsFit`,
 * which vtt-3l6.10's first-visit fit consumes and clears.
 */
import type { BoardId } from "@vtt/schema";
import { type Camera, clampZoom } from "../scene/camera";
import type { TableSession } from "../session/table-session";
import type { UiStore } from "./ui-state";

/** The part of `Storage` the camera store uses. */
export interface CameraStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CameraStoreOptions {
  ui: UiStore;
  session: Pick<TableSession, "getSnapshot" | "subscribe">;
  /** Default: the global `localStorage`, when there is one. */
  storage?: CameraStorage | null;
}

export interface CameraStore {
  /** Remembers the current camera for `board`. */
  save(board: BoardId): void;
  /** Sets the camera remembered for `board`; false when there is none. */
  restore(board: BoardId): boolean;
  /** The camera remembered for `board`, or null, without setting it (vtt-qf5.35). */
  peek(board: BoardId): Camera | null;
  /** Whether `board` was shown with no remembered camera and has not been fitted yet. */
  needsFit(board: BoardId): boolean;
  /** Clears the `needsFit` mark (after the first-visit fit). */
  clearNeedsFit(board: BoardId): void;
  /** Adds a listener called when a `needsFit` mark changes; returns its remover. */
  subscribe(listener: () => void): () => void;
  /** Follows the session's active board (see the module comment); returns the disconnector. */
  connect(): () => void;
}

const PREFIX = "vtt.camera";

function defaultStorage(): CameraStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseCamera(text: string | null): Camera | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { x, y, zoom } = value as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || typeof zoom !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) {
      return null;
    }
    return { x, y, zoom: clampZoom(zoom) };
  } catch {
    return null;
  }
}

export function createCameraStore(options: CameraStoreOptions): CameraStore {
  const { ui, session } = options;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const page = new Map<string, Camera>();
  const fits = new Set<string>();
  const listeners = new Set<() => void>();

  /** The table part of the key; null for a table with neither id nor path (page memory only). */
  const tableKey = (): string | null => {
    const table = session.getSnapshot().table;
    return table?.id ?? table?.path ?? null;
  };
  const pageKey = (board: BoardId) => JSON.stringify([tableKey(), board]);
  const storageKey = (board: BoardId): string | null => {
    const table = tableKey();
    return table === null ? null : `${PREFIX}:${table}:${board}`;
  };

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing listener must not break the store.
      }
    }
  };
  const mark = (board: BoardId, on: boolean) => {
    const key = pageKey(board);
    if (fits.has(key) === on) return;
    if (on) fits.add(key);
    else fits.delete(key);
    notify();
  };

  const store: CameraStore = {
    save(board) {
      const camera = { ...ui.getState().camera };
      page.set(pageKey(board), camera);
      const key = storageKey(board);
      if (key === null || storage === null) return;
      try {
        storage.setItem(key, JSON.stringify(camera));
      } catch {
        // Persistence is best effort.
      }
    },
    peek(board) {
      const camera = page.get(pageKey(board)) ?? null;
      if (camera !== null) return { ...camera };
      const key = storageKey(board);
      if (key === null || storage === null) return null;
      try {
        return parseCamera(storage.getItem(key));
      } catch {
        return null;
      }
    },
    restore(board) {
      const camera = store.peek(board);
      if (camera === null) return false;
      ui.setCamera(camera);
      mark(board, false);
      return true;
    },
    needsFit: (board) => fits.has(pageKey(board)),
    clearNeedsFit: (board) => mark(board, false),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect() {
      let current: BoardId | null = null;
      const follow = () => {
        const next = session.getSnapshot().activeBoard;
        if (next === current) return;
        if (current !== null) store.save(current);
        current = next;
        if (next !== null && !store.restore(next)) mark(next, true);
      };
      follow();
      return session.subscribe(follow);
    },
  };
  return store;
}
