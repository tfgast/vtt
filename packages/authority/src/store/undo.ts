/**
 * User undo (DESIGN.md §7, Undo; §4.1, Identity; FIXTURES.md §8). Undo
 * reverses one retained group and appends its own group, of kind `undo`;
 * nothing is deleted and there is no redo. The target is chosen by a
 * selector, refused as `nothing_to_undo` when there is none, and refused as
 * `undo_conflict` when a later surviving group shares a touched key with it
 * or when its inverse fails the document invariants on commit.
 */
import type { Actor, Effect, Rejection } from "@vtt/schema";
import { DocState } from "./doc";
import type { DocumentStore, TransactResult } from "./document-store";
import { applyEffect, invertForUndo, keysConflict, type TouchedKey, touchedKeys } from "./effects";
import type { FrozenGroup, History } from "./history";
import { Rejected } from "./transaction";

/** Which group an undo reverses (DESIGN.md §7). */
export type UndoSelector =
  /** The most recent candidate: the default, and the fixture `undo` step. */
  | { type: "latest" }
  /** The most recent candidate made by `actor`. */
  | { type: "actor"; actor: Actor }
  /**
   * The most recent candidate whose actor is `gm` or any character: the
   * UI's Ctrl+Z (M6-D2), never an agent's group.
   */
  | { type: "human" }
  /** The group at absolute index `index`, if it is a candidate. */
  | { type: "group"; index: number };

const LATEST: UndoSelector = { type: "latest" };

function sameActor(a: Actor, b: Actor): boolean {
  switch (a.type) {
    case "gm":
      return b.type === "gm";
    case "character":
      return b.type === "character" && a.id === b.id;
    case "agent":
      return b.type === "agent" && a.name === b.name;
  }
}

/** Whether a group by `actor` is what a scanning `selector` looks for. */
function matches(actor: Actor, selector: Exclude<UndoSelector, { type: "group" }>): boolean {
  switch (selector.type) {
    case "latest":
      return true;
    case "actor":
      return sameActor(actor, selector.actor);
    case "human":
      return actor.type === "gm" || actor.type === "character";
  }
}

/**
 * Whether `g` may be undone: retained, at or above the barrier, not an undo
 * group, and not already undone.
 */
function isCandidate(history: History, g: FrozenGroup | undefined): g is FrozenGroup {
  return (
    g !== undefined &&
    g.index >= history.undoBarrier &&
    history.get(g.index) === g &&
    g.kind !== "undo" &&
    !history.isUndone(g.index)
  );
}

/**
 * The group `selector` names (DESIGN.md §7, Undo). Throws
 * Rejected({type: "nothing_to_undo"}) when there is no candidate, or when an
 * explicit index names an undo group, an undone group, a group below the
 * barrier, or one not retained.
 */
export function findUndoTarget(history: History, selector: UndoSelector = LATEST): FrozenGroup {
  if (selector.type === "group") {
    const g = Number.isInteger(selector.index) ? history.get(selector.index) : undefined;
    if (isCandidate(history, g)) return g;
  } else {
    const groups = history.groups();
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (g === undefined || g.index < history.undoBarrier) break;
      if (!isCandidate(history, g)) continue;
      if (matches(g.actor as Actor, selector)) return g;
    }
  }
  throw new Rejected({ type: "nothing_to_undo" });
}

const groupKeys = (g: FrozenGroup): TouchedKey[] => [
  ...new Set((g.effects as readonly Effect[]).flatMap(touchedKeys)),
];

/** The first pair of conflicting keys, `[later's, target's]`, or null. */
function sharedKey(later: readonly string[], target: readonly string[]): [string, string] | null {
  for (const a of later) for (const b of target) if (keysConflict(a, b)) return [a, b];
  return null;
}

/**
 * The later retained groups that conflict with undoing `target` (DESIGN.md
 * §7): neither undo groups nor undone, and sharing a touched key with it.
 * In index order.
 */
export function undoConflicts(history: History, target: FrozenGroup): FrozenGroup[] {
  const keys = groupKeys(target);
  return history
    .groups()
    .filter(
      (h) =>
        h.index > target.index &&
        h.kind !== "undo" &&
        !history.isUndone(h.index) &&
        sharedKey(groupKeys(h), keys) !== null,
    );
}

/** A key as the user reads it: `object.cell`, `object`, or `board <id>`. */
function showKey(key: string): string {
  if (key.startsWith("cell:")) return key.slice(5).replace("/", ".");
  if (key.startsWith("obj:")) return key.slice(4);
  if (key.startsWith("board:")) return `board ${key.slice(6)}`;
  return key;
}

function conflictRejection(target: FrozenGroup, conflicting: FrozenGroup[]): Rejection {
  const first = conflicting[0] as FrozenGroup;
  const [a, b] = sharedKey(groupKeys(first), groupKeys(target)) ?? ["", ""];
  // Name the more specific of the two keys: a cell over a whole object.
  const shared = showKey(a.startsWith("obj:") ? b : a);
  return {
    type: "undo_conflict",
    target: target.index,
    conflicting: conflicting.map((g) => g.index),
    message: `cannot undo group ${target.index} "${target.label}": group ${first.index} "${first.label}" later changed ${shared}`,
  };
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Undoes the group `selector` names (default `latest`) as `actor`, in one
 * transaction of kind `undo` that appends one group, labelled `opts.label`
 * when given and `Undo <target label>` otherwise. The inverse is
 * `invertForUndo` of the target's effects in reverse order, each evaluated
 * against the document after the ones before it. User undo never reverses
 * `allocate` or `retire`: undoing a creation retires the created ids,
 * undoing a removal restores the objects with their ids still retired, and
 * `next_seq` never decreases.
 *
 * Refusals: `nothing_to_undo` (see `findUndoTarget`); `undo_conflict` when a
 * later surviving group shares a touched key, or when the inverse does not
 * apply or fails the document invariants on commit. A refused undo changes
 * nothing. Throws, like `begin`, if a transaction is already open.
 */
export function undo(
  store: DocumentStore,
  actor: Actor,
  selector: UndoSelector = LATEST,
  opts: { label?: string } = {},
): TransactResult {
  let target: FrozenGroup;
  try {
    target = findUndoTarget(store.history, selector);
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, rejection: err.rejection };
    throw err;
  }
  const conflicting = undoConflicts(store.history, target);
  if (conflicting.length > 0)
    return { ok: false, rejection: conflictRejection(target, conflicting) };

  const refuse = (why: string): never => {
    throw new Rejected({
      type: "undo_conflict",
      target: target.index,
      conflicting: [],
      message: `cannot undo group ${target.index} "${target.label}": ${why}`,
    });
  };
  const result = store.transact(
    actor,
    { kind: "undo", label: opts.label ?? `Undo ${target.label}`, undoes: target.index },
    (tx) => {
      // A private mirror of the working copy: invertForUndo needs a DocState,
      // and an inverse that does not apply is refused here, before the
      // transaction records it.
      const mirror = DocState.fromSnapshot(tx.doc.toSnapshot());
      const inverse: Effect[] = [];
      try {
        for (const e of [...(target.effects as readonly Effect[])].reverse()) {
          for (const u of invertForUndo(structuredClone(e), mirror)) {
            applyEffect(mirror, u);
            inverse.push(u);
          }
        }
      } catch (err) {
        refuse(describeError(err));
      }
      for (const u of inverse) tx.record(u);
    },
  );
  if (!result.ok && result.rejection.type === "invalid") {
    return {
      ...result,
      rejection: {
        type: "undo_conflict",
        target: target.index,
        conflicting: [],
        message: `cannot undo group ${target.index} "${target.label}": ${result.rejection.message}`,
      },
    };
  }
  return result;
}
