/**
 * Replay and rewind (DESIGN.md §7, Replay and rewind). Replay applies each
 * group's recorded effects and sets the revision to the group's `revision`,
 * also for a group with no effects. Rewind applies each effect's exact
 * historical inverse, groups and effects in reverse order, and sets the
 * revision to each group's `base_revision`. Neither re-rolls nor evaluates.
 *
 * `historicalInverse` needs the state just before its effect (a board
 * removal records the board's index), so inverses cannot be derived walking
 * backward from a later state. They are computed while applying forward and
 * kept in memory, never persisted: `replayWithInverses` returns them, and
 * DocumentStore keeps those of the groups it commits (`store.inverses`).
 * `rewind` takes them alongside the groups.
 */
import type { Effect, OpGroup, Snapshot } from "@vtt/schema";
import { DocState } from "./doc";
import { canonicalSnapshot } from "./document-store";
import {
  applyEffect,
  applyHistoricalInverse,
  type HistoricalInverse,
  historicalInverse,
} from "./effects";
import type { DeepReadonly } from "./history";

type Group = DeepReadonly<OpGroup> | OpGroup;

export interface Replayed {
  /** The head, in canonical order. */
  snapshot: Snapshot;
  /** For each group, the historical inverse of each of its effects, in effect order. */
  inverses: HistoricalInverse[][];
}

/** The document after applying `groups` to `base`, with the inverses of every effect. */
export function replayWithInverses(base: Snapshot, groups: readonly Group[]): Replayed {
  const state = DocState.fromSnapshot(base);
  const inverses: HistoricalInverse[][] = [];
  for (const g of groups) {
    if (g.base_revision !== state.revision) {
      throw new Error(
        `replay: group ${g.index} is based on revision ${g.base_revision}, but the document is at ${state.revision}`,
      );
    }
    const own: HistoricalInverse[] = [];
    for (const effect of g.effects) {
      const e = structuredClone(effect) as Effect;
      own.push(historicalInverse(e, state));
      applyEffect(state, e);
    }
    inverses.push(own);
    state.revision = g.revision;
  }
  return { snapshot: canonicalSnapshot(state.toSnapshot()), inverses };
}

/**
 * The document after applying `groups` to `base`, in canonical order.
 * Requires `base.revision` to be the first group's `base_revision`, and each
 * group to follow the one before.
 */
export function replay(base: Snapshot, groups: readonly Group[]): Snapshot {
  return replayWithInverses(base, groups).snapshot;
}

/**
 * The document before `groups`, from `head`, the document after them, in
 * canonical order. `inverses[i]` holds the historical inverses of
 * `groups[i]`'s effects, as `replayWithInverses` or `store.inverses` give
 * them. Requires `head.revision` to be the last group's `revision`.
 */
export function rewind(
  head: Snapshot,
  groups: readonly Group[],
  inverses: readonly (readonly HistoricalInverse[])[],
): Snapshot {
  if (inverses.length !== groups.length) {
    throw new Error(`rewind: ${groups.length} groups but ${inverses.length} inverse lists`);
  }
  const state = DocState.fromSnapshot(head);
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as Group;
    const own = inverses[i] as readonly HistoricalInverse[];
    if (g.revision !== state.revision) {
      throw new Error(
        `rewind: group ${g.index} produced revision ${g.revision}, but the document is at ${state.revision}`,
      );
    }
    if (own.length !== g.effects.length) {
      throw new Error(
        `rewind: group ${g.index} has ${g.effects.length} effects but ${own.length} inverses`,
      );
    }
    for (let j = own.length - 1; j >= 0; j--) {
      applyHistoricalInverse(state, structuredClone(own[j] as HistoricalInverse));
    }
    state.revision = g.base_revision;
  }
  return canonicalSnapshot(state.toSnapshot());
}
