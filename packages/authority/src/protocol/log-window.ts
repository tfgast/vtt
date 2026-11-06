/**
 * Log window subscriptions (DESIGN.md §4.4, §4.8, §5.2; PROTOCOL.md §7.6,
 * §8; D10, D15): the `log` scope provider of the subscription hub.
 *
 * A `log` subscription's window is the newest `max_log_window` retained
 * groups. `subscribe` sends their group views, with effects, newest first,
 * omitting the groups that are null for a character. After each commit the
 * provider recomputes the window and re-views:
 *
 * - every group that entered the window (the new group);
 * - the group an undo group undoes (now `undone: true`), if in the window;
 * - for a character, after a visibility-relevant commit
 *   (`isVisibilityRelevant`), every group in the window: character group
 *   views are filtered by current visibility (D15), so a reveal, hide or
 *   remove changes older groups' effects, names and labels, and a ref to a
 *   board is `redacted` while the board is gone and restored on undo.
 *
 * GM group views are lossless and depend on nothing but `undone`, so no
 * other GM group changes. A re-viewed group whose canonical JSON differs
 * from the one last sent is upserted; an index that left the window or
 * whose view became null, and was sent, is removed.
 *
 * Compaction shrinks the window without a commit. After a save-time
 * compaction the hub's `refreshProvided` calls `refresh`, which reports the
 * indices that left the window as `groups_removed` (vtt-qf5.71); otherwise
 * (a compaction nobody announced) the next commit reports them.
 */
import { type GroupView, LIMITS } from "@vtt/protocol";
import type { Table } from "../engine/table";
import type { FrozenGroup } from "../store/history";
import {
  type CommitInfo,
  type ProviderDelta,
  type ScopeProvider,
  type ScopeSubscription,
  SubscriptionHub,
} from "./subscriptions";
import { ViewBuilder } from "./views";

interface LogState {
  /** The window at the last revision sent: absolute indices `[from, to)`. */
  from: number;
  to: number;
  /** Canonical JSON of every group view sent and not since removed, by index. */
  lastGroups: Map<number, string>;
}

/** JSON with object keys sorted, so equal views compare equal as strings. */
function canonical(x: unknown): string {
  return JSON.stringify(x, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** The newest `max_log_window` retained groups, oldest first, and their index range. */
function logWindow(table: Table): { from: number; to: number; groups: readonly FrozenGroup[] } {
  const history = table.store.history;
  const all = history.groups();
  const start = Math.max(0, all.length - LIMITS.max_log_window);
  return { from: history.firstIndex + start, to: history.nextIndex, groups: all.slice(start) };
}

/** The `log` scope provider (PROTOCOL.md §8) for `table`. */
export function logScopeProvider(table: Table): ScopeProvider {
  const states = new Map<ScopeSubscription, LogState>();
  return {
    subscribe(sub: ScopeSubscription): { groups: GroupView[] } {
      const builder = new ViewBuilder(table, sub.viewer);
      const { from, to, groups: window } = logWindow(table);
      const lastGroups = new Map<number, string>();
      const groups: GroupView[] = [];
      for (let k = window.length - 1; k >= 0; k--) {
        const view = builder.groupView(window[k] as FrozenGroup, { effects: true });
        if (view === null) continue;
        groups.push(view);
        lastGroups.set(view.index, canonical(view));
      }
      states.set(sub, { from, to, lastGroups });
      return { groups };
    },

    onCommit(sub: ScopeSubscription, commit: CommitInfo): ProviderDelta | null {
      const state = states.get(sub);
      if (state === undefined) return null;
      const builder = new ViewBuilder(table, sub.viewer);
      const { from, to, groups: window } = logWindow(table);
      const whole = sub.viewer.type === "character" && commit.visibilityRelevant;
      const undone = commit.group.undoes;
      const entered = (i: number) => i < state.from || i >= state.to;

      const removed: number[] = [];
      for (const i of state.lastGroups.keys()) if (i < from || i >= to) removed.push(i);
      for (const i of removed) state.lastGroups.delete(i);

      const upserted: GroupView[] = [];
      for (let k = window.length - 1; k >= 0; k--) {
        const group = window[k] as FrozenGroup;
        const i = group.index;
        if (!whole && !entered(i) && i !== undone) continue;
        const view = builder.groupView(group, { effects: true });
        if (view === null) {
          if (state.lastGroups.delete(i)) removed.push(i);
          continue;
        }
        const json = canonical(view);
        if (state.lastGroups.get(i) === json) continue;
        state.lastGroups.set(i, json);
        upserted.push(view);
      }
      state.from = from;
      state.to = to;
      if (upserted.length === 0 && removed.length === 0) return null;
      removed.sort((a, b) => a - b);
      return { groups_upserted: upserted, groups_removed: removed };
    },

    refresh(sub: ScopeSubscription): ProviderDelta | null {
      const state = states.get(sub);
      if (state === undefined) return null;
      // Compaction only drops the oldest groups and changes no retained view.
      const { from, to } = logWindow(table);
      const removed: number[] = [];
      for (const i of state.lastGroups.keys()) if (i < from || i >= to) removed.push(i);
      for (const i of removed) state.lastGroups.delete(i);
      state.from = from;
      state.to = to;
      if (removed.length === 0) return null;
      removed.sort((a, b) => a - b);
      return { groups_removed: removed };
    },

    drop(sub: ScopeSubscription): void {
      states.delete(sub);
    },
  };
}

/**
 * The server's subscription hub: object and cover scopes (`SubscriptionHub`)
 * plus the `log` scope (`logScopeProvider`).
 */
export function createSubscriptionHub(table: Table): SubscriptionHub {
  const hub = new SubscriptionHub(table);
  hub.registerScope("log", logScopeProvider(table));
  return hub;
}
