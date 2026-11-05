/**
 * Notices (vtt-3l6.21; review r3 finding 14): the sole owner of stickiness
 * and expiry. One policy: `info` and `success` notices expire after
 * `NOTICE_EXPIRY_MS`; `warning`, `error` and every `stale` or `uncertain`
 * notice stay until dismissed. Presenting them and calling `dismiss` is the
 * app shell's (vtt-3l6.17).
 */
import type { Timers } from "@vtt/protocol";
import type { NoticeLevel } from "../interaction/contracts";

/** A stale write, or a write whose outcome is unknown (DESIGN.md §7 Undo). */
export type NoticeKind = "stale" | "uncertain";

export interface Notice {
  readonly id: string;
  readonly level: NoticeLevel;
  readonly kind?: NoticeKind;
  readonly text: string;
}

export interface NoticeInput {
  level: NoticeLevel;
  kind?: NoticeKind;
  text: string;
}

export interface NoticeStore {
  /** Adds a notice and returns its id. */
  push(notice: NoticeInput): string;
  /** Removes a notice; unknown ids are ignored. */
  dismiss(id: string): void;
  /** The current notices, oldest first; the same array until something changes. */
  list(): readonly Notice[];
  /** Adds a listener called after every change; returns its remover. */
  subscribe(listener: () => void): () => void;
}

export interface NoticeStoreOptions {
  /** The globals by default, looked up at each call (so fake timers apply). */
  timers?: Timers;
}

/** How long an `info` or `success` notice stays. */
export const NOTICE_EXPIRY_MS = 6000;

/** Whether a notice stays until dismissed. */
export function isStickyNotice(notice: { level: NoticeLevel; kind?: NoticeKind }): boolean {
  return notice.kind !== undefined || notice.level === "warning" || notice.level === "error";
}

const globalTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

export function createNoticeStore(options: NoticeStoreOptions = {}): NoticeStore {
  const timers = options.timers ?? globalTimers;
  const listeners = new Set<() => void>();
  const expiry = new Map<string, unknown>();
  let notices: readonly Notice[] = [];
  let next = 1;

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing listener must not break the store.
      }
    }
  };

  const remove = (id: string) => {
    if (!notices.some((n) => n.id === id)) return;
    const timer = expiry.get(id);
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      expiry.delete(id);
    }
    notices = notices.filter((n) => n.id !== id);
    notify();
  };

  return {
    push(input) {
      const id = `n${next++}`;
      const notice: Notice = {
        id,
        level: input.level,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        text: input.text,
      };
      notices = [...notices, notice];
      if (!isStickyNotice(notice)) {
        expiry.set(
          id,
          timers.setTimeout(() => {
            expiry.delete(id);
            remove(id);
          }, NOTICE_EXPIRY_MS),
        );
      }
      notify();
      return id;
    },
    dismiss: remove,
    list: () => notices,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
