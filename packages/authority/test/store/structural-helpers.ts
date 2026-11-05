/** Shared by the structural primitive tests (structural-*.test.ts). */
import {
  applyEffect,
  DocState,
  type DocumentStore,
  type FrozenGroup,
  invertForUndo,
  Rejected,
  type Transaction,
} from "@vtt/authority";
import type { Actor, Cell, Effect, Rejection, Snapshot } from "@vtt/schema";
import { expect } from "vitest";

export const gm: Actor = { type: "gm" };
export const edit = { kind: "edit", label: "edit" } as const;
export const formula = (source: string): Cell => ({ content: { type: "formula", source } });

/** Runs `fn` in a transaction and commits it, returning the committed group. */
export function run(store: DocumentStore, fn: (tx: Transaction) => void): FrozenGroup {
  const result = store.transact(gm, edit, fn);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result.group;
}

/**
 * Expects `fn` to throw Rejected with `rejection` inside an open transaction,
 * recording nothing, and the store to keep its document and history.
 */
export function expectRefused(
  store: DocumentStore,
  fn: (tx: Transaction) => void,
  rejection: Partial<Rejection>,
): void {
  const before = store.toSnapshot();
  const historyBefore = store.history.nextIndex;
  const fresh = store.begin(gm, edit);
  const noChanges = fresh.changes();
  fresh.abort();
  const tx = store.begin(gm, edit);
  let thrown: unknown;
  try {
    fn(tx);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Rejected);
  expect((thrown as Rejected).rejection).toMatchObject(rejection);
  expect(tx.changes()).toEqual(noChanges);
  expect(tx.doc.toSnapshot()).toEqual(before);
  tx.abort();
  const result = store.transact(gm, edit, fn);
  expect(result.ok).toBe(false);
  expect(store.toSnapshot()).toEqual(before);
  expect(store.history.nextIndex).toBe(historyBefore);
}

/** `snapshot` with the user undo of `group`'s effects (DESIGN.md §7) applied, last effect first. */
export function applyUndo(snapshot: Snapshot, group: FrozenGroup): Snapshot {
  const s = DocState.fromSnapshot(snapshot);
  for (const e of [...(group.effects as readonly Effect[])].reverse()) {
    for (const u of invertForUndo(e, s)) applyEffect(s, u);
  }
  return s.toSnapshot();
}
