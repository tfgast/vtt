import {
  addBoard,
  createObject,
  type Destination,
  DocumentStore,
  move,
  remove,
  reorder,
  type SpawnResult,
  spawn,
  storedStateEqual,
  type Transaction,
  type UndoSelector,
  undo,
} from "@vtt/authority";
import type { Actor, Rejection } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { must, table } from "./helpers";

const gm: Actor = { type: "gm" };

/** Commits `fn` as one edit group by the GM and returns its index. */
function run(store: DocumentStore, fn: (tx: Transaction) => void, label = "edit"): number {
  const result = store.transact(gm, { kind: "edit", label }, fn);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result.group.index;
}

function spawned(store: DocumentStore, template: string, dest: Destination): SpawnResult {
  let out: SpawnResult | undefined;
  run(store, (tx) => {
    out = spawn(tx, template, dest);
  });
  return must(out);
}

function undone(store: DocumentStore, selector?: UndoSelector): void {
  const result = undo(store, gm, selector);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
}

function expectUndoRefused(
  store: DocumentStore,
  rejection: Partial<Rejection>,
  selector?: UndoSelector,
): void {
  const before = store.toSnapshot();
  const next = store.history.nextIndex;
  const result = undo(store, gm, selector);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection).toMatchObject(rejection);
  expect(store.toSnapshot()).toEqual(before);
  expect(store.history.nextIndex).toBe(next);
}

/** Expects `fn` in a fresh transaction to be refused as `invalid`. */
function expectInvalid(store: DocumentStore, fn: (tx: Transaction) => void): void {
  const result = store.transact(gm, { kind: "edit", label: "edit" }, fn);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.rejection.type).toBe("invalid");
}

const bag: Destination = { type: "container", container: "bag" };
const onMap: Destination = { type: "board", board: "map", position: [4, 4] };

describe("undo of structural changes", () => {
  test("undo of a spawn removes the copies and retires their ids", () => {
    const store = DocumentStore.fromSnapshot(table());
    const before = store.toSnapshot();
    const { root, copies } = spawned(store, "chest", onMap);
    expect([...copies.values()]).toEqual(["chest_5", "pouch_6", "ring_7"]);
    undone(store);
    for (const id of copies.values()) {
      expect(store.hasObject(id)).toBe(false);
      expect(store.isRetired(id)).toBe(true);
    }
    expect(root).toBe("chest_5");
    expect(store.nextSeq).toBe(8);
    const after = store.toSnapshot();
    expect(storedStateEqual(after, before, { ignoreIdentity: true })).toBe(true);
    expect(storedStateEqual(after, before)).toBe(false);
  });

  test("undo of a spawn into a container removes it from the contents", () => {
    const store = DocumentStore.fromSnapshot(table());
    spawned(store, "goblin", bag);
    expect(store.contentsOf("bag")).toEqual(["coin", "gem", "goblin_5"]);
    undone(store);
    expect(store.contentsOf("bag")).toEqual(["coin", "gem"]);
    expect(store.hasObject("goblin_5")).toBe(false);
  });

  test("undo of a remove restores the subtree under its ids, which stay retired", () => {
    const store = DocumentStore.fromSnapshot(table());
    const before = store.toSnapshot();
    run(store, (tx) => remove(tx, "pouch"));
    expect(store.hasObject("ring")).toBe(false);
    undone(store);
    expect(store.contentsOf("chest")).toEqual(["pouch"]);
    expect(store.contentsOf("pouch")).toEqual(["ring"]);
    expect(store.getObject("ring")).toEqual(before.objects.ring);
    expect(store.isRetired("pouch")).toBe(true);
    expect(store.isRetired("ring")).toBe(true);
    expect(store.nextSeq).toBe(5);
    expect(storedStateEqual(store.toSnapshot(), before, { ignoreIdentity: true })).toBe(true);
  });

  test("undo of a remove from a board restores it there", () => {
    const store = DocumentStore.fromSnapshot(table());
    const before = store.toSnapshot();
    run(store, (tx) => remove(tx, "bag"));
    undone(store);
    expect(store.boardOf("bag")).toBe("map");
    expect(store.contentsOf("bag")).toEqual(["coin", "gem"]);
    expect(storedStateEqual(store.toSnapshot(), before, { ignoreIdentity: true })).toBe(true);
  });

  test("undo of a reorder restores order", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => reorder(tx, "bag", [1, 0]));
    expect(store.contentsOf("bag")).toEqual(["gem", "coin"]);
    undone(store);
    expect(store.contentsOf("bag")).toEqual(["coin", "gem"]);
  });

  test("undo of a move restores location and placement cells", () => {
    const store = DocumentStore.fromSnapshot(table());
    const before = store.toSnapshot();
    run(store, (tx) => move(tx, "goblin", { type: "container", container: "bag", index: 1 }));
    expect(store.contentsOf("bag")).toEqual(["coin", "goblin", "gem"]);
    undone(store);
    expect(store.toSnapshot()).toEqual({ ...before, revision: 5 });
  });
});

describe("structural conflicts", () => {
  test("undo of a move into a container is refused after a later move out of it", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => move(tx, "goblin", bag), "into bag");
    run(store, (tx) => move(tx, "coin", onMap), "coin out");
    expectUndoRefused(
      store,
      { type: "undo_conflict", target: 0, conflicting: [1] },
      { type: "group", index: 0 },
    );
  });

  test("undo of a spawn into a container is refused after a later reorder of it", () => {
    const store = DocumentStore.fromSnapshot(table());
    spawned(store, "goblin", bag);
    run(store, (tx) => reorder(tx, "bag", [2, 0, 1]), "shuffle bag");
    expectUndoRefused(
      store,
      { type: "undo_conflict", target: 0, conflicting: [1] },
      { type: "group", index: 0 },
    );
  });

  test("undo of a spawn into a container is refused after a later sibling inserted into it", () => {
    const store = DocumentStore.fromSnapshot(table());
    spawned(store, "goblin", bag);
    run(store, (tx) => createObject(tx, {}, { type: "container", container: "bag", index: 0 }));
    expectUndoRefused(
      store,
      { type: "undo_conflict", target: 0, conflicting: [1] },
      { type: "group", index: 0 },
    );
  });

  test("undo of a remove from a container is refused after a later sibling inserted into it", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => remove(tx, "coin"));
    spawned(store, "goblin", bag);
    expectUndoRefused(
      store,
      { type: "undo_conflict", target: 0, conflicting: [1] },
      { type: "group", index: 0 },
    );
  });

  test("a later change elsewhere does not block a structural undo", () => {
    const store = DocumentStore.fromSnapshot(table());
    spawned(store, "goblin", bag);
    run(store, (tx) => reorder(tx, "chest", [0]));
    run(store, (tx) => move(tx, "goblin", { type: "container", container: "chest" }));
    undone(store, { type: "group", index: 0 });
    expect(store.contentsOf("bag")).toEqual(["coin", "gem"]);
  });

  test("a later change to a spawned object blocks undo of the spawn", () => {
    const store = DocumentStore.fromSnapshot(table());
    spawned(store, "chest", onMap);
    run(store, (tx) => reorder(tx, "pouch_6", [0]));
    expectUndoRefused(
      store,
      { type: "undo_conflict", conflicting: [1] },
      { type: "group", index: 0 },
    );
  });
});

describe("identity", () => {
  test("spawn, undo, spawn gives new ids; the first stay retired", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = spawned(store, "goblin", onMap);
    expect(first.root).toBe("goblin_5");
    undone(store);
    expect(store.nextSeq).toBe(6);
    const second = spawned(store, "goblin", onMap);
    expect(second.root).toBe("goblin_6");
    expect(store.isRetired("goblin_5")).toBe(true);
    expect(store.hasObject("goblin_5")).toBe(false);
    expect(store.nextSeq).toBe(7);
  });

  test("creating an object with an explicit id after undoing its creation is invalid", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => createObject(tx, {}, bag, "lantern"));
    undone(store);
    expect(store.isRetired("lantern")).toBe(true);
    expectInvalid(store, (tx) => createObject(tx, {}, bag, "lantern"));
  });

  test("selective undo of an older spawn keeps a later spawn, its ids and next_seq", () => {
    const store = DocumentStore.fromSnapshot(table());
    spawned(store, "goblin", onMap);
    const later = spawned(store, "chest", onMap);
    const laterObjects = [...later.copies.values()].map((id) => store.getObject(id));
    const seq = store.nextSeq;
    undone(store, { type: "group", index: 0 });
    expect(store.hasObject("goblin_5")).toBe(false);
    expect(store.isRetired("goblin_5")).toBe(true);
    expect([...later.copies.values()]).toEqual(["chest_6", "pouch_7", "ring_8"]);
    expect([...later.copies.values()].map((id) => store.getObject(id))).toEqual(laterObjects);
    expect(store.nextSeq).toBe(seq);
  });

  test("a board's id stays retired after undoing its creation", () => {
    const store = DocumentStore.fromSnapshot(table());
    const before = store.toSnapshot();
    run(store, (tx) => addBoard(tx, "goblin_5", "Arena"));
    undone(store);
    expect(store.getBoard("goblin_5")).toBeUndefined();
    expect(store.isRetired("goblin_5")).toBe(true);
    expect(store.nextSeq).toBe(5);
    expect(storedStateEqual(store.toSnapshot(), before, { ignoreIdentity: true })).toBe(true);
    expectInvalid(store, (tx) => addBoard(tx, "goblin_5"));
    expectInvalid(store, (tx) => createObject(tx, {}, bag, "goblin_5"));
    // Spawn never generates it: goblin_5 would be next.
    expect(spawned(store, "goblin", onMap).root).toBe("goblin_6");
  });

  test("undo of a board rename restores the name; a later rename blocks undoing the creation", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => addBoard(tx, "arena", "Arena"));
    const rename = (name: string) =>
      run(store, (tx) => {
        const b = must(tx.doc.getBoard("arena"));
        tx.record({ type: "board", before: { ...b }, after: { ...b, name } });
      });
    rename("Pit");
    expectUndoRefused(
      store,
      { type: "undo_conflict", conflicting: [1] },
      { type: "group", index: 0 },
    );
    undone(store);
    expect(store.getBoard("arena")).toEqual({ id: "arena", name: "Arena" });
    // The rename is undone and its undo never conflicts.
    undone(store);
    expect(store.getBoard("arena")).toBeUndefined();
    expect(store.isRetired("arena")).toBe(true);
  });
});
