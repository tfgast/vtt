/**
 * Face state (DESIGN.md §4.6 Gestures: contents scrolling; §4.7 Binders,
 * sheets and hands on the canvas: entries expanded and collapsed per session;
 * M5 plan review r2 finding 1): which contents entries are expanded and how
 * far each contents element is scrolled. UI-local, per session, never
 * written to the table.
 */
import type { ObjectId } from "@vtt/schema";

/** A contents element's `entries` mode: what an entry shows until it is toggled. */
export type EntriesMode = "collapsed" | "full";

export interface FaceStateStore {
  /** Whether entry `id` is expanded in a contents element whose mode is `entriesMode`. */
  isExpanded(id: ObjectId, entriesMode: EntriesMode): boolean;
  /** Flips the entry from whatever it shows now (its mode's default until set). */
  toggle(id: ObjectId): void;
  expand(id: ObjectId): void;
  collapse(id: ObjectId): void;
  /**
   * The stored offset of contents element `element` of `object` (≥ 0, 0
   * until set). Layout clamps it to the element's `maxOffset`.
   */
  scrollOffset(object: ObjectId, element: number): number;
  /**
   * Adds `dy` to the offset (starting from the stored offset clamped to
   * `max`), clamped to `[0, max]`; returns the new offset.
   */
  scrollBy(object: ObjectId, element: number, dy: number, max?: number): number;
  /** Sets the offset clamped to `[0, max]` (NaN is 0); returns it. */
  setScroll(object: ObjectId, element: number, offset: number, max?: number): number;
  /** Adds a listener called after every change; returns its remover. */
  subscribe(listener: () => void): () => void;
}

/** An entry's override of its mode's default; `toggled` flips the default. */
type Expansion = "expanded" | "collapsed" | "toggled";

function clamp(x: number, max: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(Math.max(0, max), Math.max(0, x));
}

export function createFaceStateStore(): FaceStateStore {
  const expansion = new Map<ObjectId, Expansion>();
  const scroll = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const setExpansion = (id: ObjectId, next: Expansion | undefined) => {
    if (expansion.get(id) === next) return;
    if (next === undefined) expansion.delete(id);
    else expansion.set(id, next);
    notify();
  };
  const key = (object: ObjectId, element: number) => `${element}\u0000${object}`;
  const store = (object: ObjectId, element: number, offset: number): number => {
    const k = key(object, element);
    if ((scroll.get(k) ?? 0) !== offset) {
      if (offset === 0) scroll.delete(k);
      else scroll.set(k, offset);
      notify();
    }
    return offset;
  };

  return {
    isExpanded(id, entriesMode) {
      const state = expansion.get(id);
      if (state === "expanded") return true;
      if (state === "collapsed") return false;
      const byDefault = entriesMode === "full";
      return state === "toggled" ? !byDefault : byDefault;
    },
    toggle(id) {
      const state = expansion.get(id);
      setExpansion(
        id,
        state === "expanded"
          ? "collapsed"
          : state === "collapsed"
            ? "expanded"
            : state === "toggled"
              ? undefined
              : "toggled",
      );
    },
    expand(id) {
      setExpansion(id, "expanded");
    },
    collapse(id) {
      setExpansion(id, "collapsed");
    },
    scrollOffset(object, element) {
      return scroll.get(key(object, element)) ?? 0;
    },
    scrollBy(object, element, dy, max = Number.POSITIVE_INFINITY) {
      const from = clamp(scroll.get(key(object, element)) ?? 0, max);
      return store(object, element, clamp(from + dy, max));
    },
    setScroll(object, element, offset, max = Number.POSITIVE_INFINITY) {
      return store(object, element, clamp(offset, max));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
