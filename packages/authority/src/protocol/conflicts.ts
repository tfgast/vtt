/**
 * Stale-write conflicts (PROTOCOL.md §6; DESIGN.md §7; M3-D7): the history
 * floor, the keys a committed group shares with a checked key set, and the
 * `stale_write` rejection for a `base_revision` older than the current
 * revision. Keys are the undo conflict keys of `store/effects.ts`.
 */
import type { ProtocolRejection } from "@vtt/protocol";
import type { Actor, Effect } from "@vtt/schema";
import { keysConflict, touchedKeys } from "../store/effects";
import type { FrozenGroup, History } from "../store/history";

/** The `stale_write` rejection (PROTOCOL.md §6). */
export type StaleWrite = Extract<ProtocolRejection, { type: "stale_write" }>;

/** One conflicting group of a `stale_write`. */
export type StaleConflict = StaleWrite["conflicts"][number];

/**
 * Carries a `stale_write` out of a transaction function, so the transaction
 * aborts with nothing applied (PROTOCOL.md §6 step 6). Not a `Rejected`: the
 * store rethrows it after aborting, and the command layer turns it back into
 * a rejection.
 */
export class StaleWriteError extends Error {
  readonly rejection: StaleWrite;

  constructor(rejection: StaleWrite) {
    super(`stale_write: base revision ${rejection.base_revision}`);
    this.name = "StaleWriteError";
    this.rejection = rejection;
  }
}

/**
 * The floor (PROTOCOL.md §6): the `base_revision` of the oldest group in the
 * contiguous run of retained groups that ends at `currentRevision`. With no
 * such run (no retained groups, or a newest group at another revision, as
 * after a hand edit) the floor is `currentRevision`.
 */
export function historyFloor(history: History, currentRevision: number): number {
  const groups = history.groups();
  let i = groups.length - 1;
  const newest = groups[i];
  if (newest === undefined || newest.revision !== currentRevision) return currentRevision;
  let oldest = newest;
  while (i > 0) {
    const prev = groups[i - 1];
    if (prev === undefined || prev.revision !== oldest.base_revision) break;
    oldest = prev;
    i--;
  }
  return oldest.base_revision;
}

/** A group's keys: the union of the touched keys of its effects, in effect order. */
export function groupKeys(group: FrozenGroup): string[] {
  return [...new Set((group.effects as readonly Effect[]).flatMap(touchedKeys))];
}

/**
 * The keys of `groupKeys` that conflict (`keysConflict`) with some key of
 * `checked`, in `groupKeys` order: a write to an object removed since reports
 * the removal's `obj:<id>`.
 */
export function intersectingKeys(
  groupKeys: readonly string[],
  checked: readonly string[],
): string[] {
  return groupKeys.filter((g) => checked.some((k) => keysConflict(g, k)));
}

/**
 * The `stale_write` for writing `keys` at `baseRevision`, or null when no
 * retained group with `revision > baseRevision` (undo groups included)
 * shares a key with them. Conflicts are in index order.
 *
 * `revision` is the newest retained group's revision and `floor` is taken
 * at it. Callers check only a `baseRevision` at or above the floor and below
 * the current revision; then the retained groups form a run ending at the
 * current revision, so that is the current revision.
 */
export function staleConflicts(
  history: History,
  baseRevision: number,
  keys: string[],
): StaleWrite | null {
  const later = history.groups().filter((g) => g.revision > baseRevision);
  const newest = later[later.length - 1];
  if (newest === undefined) return null;
  const conflicts: StaleConflict[] = [];
  for (const g of later) {
    const shared = intersectingKeys(groupKeys(g), keys);
    if (shared.length === 0) continue;
    conflicts.push({
      index: g.index,
      revision: g.revision,
      actor: structuredClone(g.actor) as Actor,
      label: g.label,
      keys: shared,
    });
  }
  if (conflicts.length === 0) return null;
  return {
    type: "stale_write",
    base_revision: baseRevision,
    revision: newest.revision,
    floor: historyFloor(history, newest.revision),
    truncated: false,
    conflicts,
  };
}
