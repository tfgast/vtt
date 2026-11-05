import {
  addBoard,
  canonicalSnapshot,
  DocumentStore,
  move,
  remove,
  reorder,
  replay,
  rewind,
  spawn,
  type Transaction,
  type UndoSelector,
  undo,
  writeValue,
} from "@vtt/authority";
import { type Actor, num } from "@vtt/schema";
import { expect, test } from "vitest";
import { must, table } from "./helpers";

const gm: Actor = { type: "gm" };
const agent: Actor = { type: "agent" };

function run(store: DocumentStore, actor: Actor, fn: (tx: Transaction) => void): void {
  const result = store.transact(actor, { kind: "edit", label: "edit" }, fn);
  if (!result.ok) throw new Error(JSON.stringify(result.rejection));
}

function undone(store: DocumentStore, actor: Actor, selector?: UndoSelector): void {
  const result = undo(store, actor, selector);
  if (!result.ok) throw new Error(JSON.stringify(result.rejection));
}

test("replay of a mixed log reproduces the head; rewind of the head reproduces the base", () => {
  const base = table();
  const store = DocumentStore.fromSnapshot(base);
  run(store, gm, (tx) => {
    spawn(tx, "chest", { type: "board", board: "map", position: [2, 2] });
  });
  run(store, gm, () => {});
  run(store, agent, (tx) => writeValue(tx, "goblin", "hp", num(3)));
  run(store, gm, (tx) => remove(tx, "pouch"));
  run(store, gm, (tx) => addBoard(tx, "arena", "Arena"));
  run(store, agent, (tx) => move(tx, "goblin", { type: "container", container: "bag", index: 0 }));
  run(store, gm, (tx) => reorder(tx, "bag", [2, 1, 0]));
  undone(store, gm); // the reorder
  undone(store, gm, { type: "group", index: 4 }); // the board
  undone(store, gm, { type: "group", index: 3 }); // the removal
  undone(store, gm, { type: "group", index: 1 }); // the no-effect group
  undone(store, gm, { type: "group", index: 0 }); // the spawn
  run(store, gm, () => {});
  run(store, gm, (tx) => {
    spawn(tx, "coin", { type: "container", container: "chest" });
  });

  const groups = store.history.groups();
  expect(groups.map((g) => g.kind)).toEqual([
    "edit",
    "edit",
    "edit",
    "edit",
    "edit",
    "edit",
    "edit",
    "undo",
    "undo",
    "undo",
    "undo",
    "undo",
    "edit",
    "edit",
  ]);
  const head = store.toSnapshot();
  expect(head.retired_ids).toEqual(
    expect.arrayContaining(["old", "chest_5", "pouch_6", "ring_7", "pouch", "ring", "arena"]),
  );
  expect(store.hasObject("pouch")).toBe(true);
  expect(head.next_seq).toBe(9);
  expect(head.revision).toBe(base.revision + groups.length);

  expect(replay(base, groups)).toEqual(head);
  const inverses = groups.map((g) => must(store.inverses(g.index)));
  expect(rewind(head, groups, inverses)).toEqual(canonicalSnapshot(base));
});
