import {
  clearOverride,
  DocumentStore,
  findUndoTarget,
  History,
  undo,
  type UndoSelector,
  undoConflicts,
  writeValue,
} from "@vtt/authority";
import { type Actor, num, type Rejection, type Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, lit, must, named, obj } from "./helpers";
import { formula } from "./structural-helpers";

const gm: Actor = { type: "gm" };
const agent: Actor = { type: "agent", name: "claude" };
const aldricActor: Actor = { type: "character", id: "aldric" };

/** Aldric (hit points as in hit-points.json) and goblin1, on one board. */
function scene(): Snapshot {
  const objects = [
    obj("aldric", {
      board: "table",
      is_character: true,
      tag: ["pc"],
      shape: { type: "circle", radius: 0.5 },
      cells: {
        name: named("Aldric"),
        position: at(3, 4),
        max_hp: lit(27),
        damage_taken: lit(0),
        hp: formula("max_hp - damage_taken"),
      },
    }),
    obj("goblin1", {
      board: "table",
      cells: { name: named("Goblin"), position: at(1, 1), damage_taken: lit(0), ac: lit(12) },
    }),
  ];
  return {
    revision: 0,
    next_seq: 1,
    boards: [{ id: "table", name: "Table" }],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

/** Writes `value` to `object.cell` as `actor` in its own group labelled `label`. */
function write(
  store: DocumentStore,
  actor: Actor,
  object: string,
  cell: string,
  value: number,
  label = `set ${object}.${cell}`,
): number {
  const result = store.transact(actor, { kind: "edit", label }, (tx) =>
    writeValue(tx, object, cell, num(value)),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.rejection));
  return result.group.index;
}

function undone(store: DocumentStore, actor: Actor, selector?: UndoSelector) {
  const result = undo(store, actor, selector);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result;
}

/** Expects `undo` to be refused with `rejection`, changing neither document nor history. */
function expectUndoRefused(
  store: DocumentStore,
  actor: Actor,
  selector: UndoSelector | undefined,
  rejection: Partial<Rejection>,
): Rejection {
  const before = store.toSnapshot();
  const next = store.history.nextIndex;
  const result = undo(store, actor, selector);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection).toMatchObject(rejection);
  expect(store.toSnapshot()).toEqual(before);
  expect(store.history.nextIndex).toBe(next);
  expect(store.openTransaction).toBeNull();
  return result.rejection;
}

const damage = (store: DocumentStore, id = "goblin1") => store.getCell(id, "damage_taken")?.content;

describe("hit-points.json at store level", () => {
  test("set, override, set, clear_override, undo: five groups and the override back", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "aldric", "damage_taken", 5);
    write(store, gm, "aldric", "hp", 30);
    write(store, gm, "aldric", "damage_taken", 10);
    const cleared = store.transact(gm, { kind: "edit", label: "clear hp" }, (tx) =>
      clearOverride(tx, "aldric", "hp"),
    );
    expect(cleared.ok).toBe(true);
    expect(store.getCell("aldric", "hp")).toEqual(formula("max_hp - damage_taken"));

    const result = undone(store, gm);
    expect(store.history.groups()).toHaveLength(5);
    expect(result.group).toMatchObject({ index: 4, kind: "undo", undoes: 3, actor: gm });
    expect(store.getCell("aldric", "hp")).toEqual({
      ...formula("max_hp - damage_taken"),
      override: num(30),
    });
    expect(store.getCell("aldric", "damage_taken")).toEqual(lit(10));
    expect(store.history.isUndone(3)).toBe(true);
    // Nothing is deleted: the clear is still in the log.
    expect(store.history.get(3)?.label).toBe("clear hp");
  });
});

describe("selecting the target", () => {
  test("latest skips undo groups and undone groups", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    write(store, gm, "goblin1", "ac", 14);
    expect(findUndoTarget(store.history).index).toBe(1);
    undone(store, gm);
    expect(findUndoTarget(store.history, { type: "latest" }).index).toBe(0);
  });

  test("undo twice of two writes to the same cell restores the original", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const original = store.toSnapshot();
    write(store, gm, "goblin1", "damage_taken", 3);
    write(store, gm, "goblin1", "damage_taken", 8);
    undone(store, gm);
    expect(damage(store)).toEqual(num(3));
    undone(store, gm);
    expect(damage(store)).toEqual(num(0));
    expect(store.history.groups().map((g) => g.kind)).toEqual(["edit", "edit", "undo", "undo"]);
    expect(store.history.groups().map((g) => g.undoes)).toEqual([undefined, undefined, 1, 0]);
    const { revision: _r, ...now } = store.toSnapshot();
    const { revision: _o, ...then } = original;
    expect(now).toEqual(then);
  });

  test("actor picks that actor's latest group", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    write(store, agent, "goblin1", "ac", 14);
    write(store, aldricActor, "aldric", "damage_taken", 2);
    expect(findUndoTarget(store.history, { type: "actor", actor: gm }).index).toBe(0);
    expect(findUndoTarget(store.history, { type: "actor", actor: agent }).index).toBe(1);
    expect(findUndoTarget(store.history, { type: "actor", actor: aldricActor }).index).toBe(2);
    expect(() =>
      findUndoTarget(store.history, { type: "actor", actor: { type: "agent", name: "other" } }),
    ).toThrow(/nothing_to_undo/);
    expect(() =>
      findUndoTarget(store.history, { type: "actor", actor: { type: "character", id: "goblin1" } }),
    ).toThrow(/nothing_to_undo/);
  });

  test("an undo by one actor of another's group counts as the undoer's undo group", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    const result = undone(store, agent, { type: "actor", actor: gm });
    expect(result.group).toMatchObject({ actor: agent, undoes: 0 });
    expectUndoRefused(store, gm, { type: "actor", actor: gm }, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "actor", actor: agent }, { type: "nothing_to_undo" });
  });

  test("group picks an absolute index", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    write(store, gm, "goblin1", "ac", 14);
    undone(store, gm, { type: "group", index: 0 });
    expect(damage(store)).toEqual(num(0));
    expect(store.getCell("goblin1", "ac")).toEqual(lit(14));
  });

  test("nothing_to_undo on an empty log", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectUndoRefused(store, gm, undefined, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "actor", actor: gm }, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "group", index: 0 }, { type: "nothing_to_undo" });
  });

  test("nothing_to_undo after everything is undone", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    write(store, agent, "goblin1", "ac", 14);
    undone(store, gm);
    undone(store, gm);
    expectUndoRefused(store, gm, { type: "latest" }, { type: "nothing_to_undo" });
  });

  test("nothing_to_undo for an explicit index that is an undo, undone, or out of range", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    undone(store, gm);
    expectUndoRefused(store, gm, { type: "group", index: 0 }, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "group", index: 1 }, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "group", index: 2 }, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "group", index: -1 }, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "group", index: 0.5 }, { type: "nothing_to_undo" });
  });

  test("groups below the barrier are not candidates", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    write(store, gm, "goblin1", "ac", 14);
    store.history.raiseBarrier(1);
    expectUndoRefused(store, gm, { type: "group", index: 0 }, { type: "nothing_to_undo" });
    expect(findUndoTarget(store.history).index).toBe(1);
    undone(store, gm);
    expectUndoRefused(store, gm, { type: "latest" }, { type: "nothing_to_undo" });
    expectUndoRefused(store, gm, { type: "actor", actor: gm }, { type: "nothing_to_undo" });
  });

  test("groups no longer retained are not candidates", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 3);
    write(store, gm, "goblin1", "ac", 14);
    store.history.compact(1);
    expect(store.history.undoBarrier).toBe(1);
    expectUndoRefused(store, gm, { type: "group", index: 0 }, { type: "nothing_to_undo" });
    expect(findUndoTarget(store.history).index).toBe(1);
  });

  test("a restored history with a barrier keeps earlier groups as record", () => {
    const source = DocumentStore.fromSnapshot(scene());
    write(source, gm, "goblin1", "damage_taken", 3);
    write(source, gm, "goblin1", "ac", 14);
    const history = new History();
    history.restore(source.history.toLog(), source.revision, { editedExternally: true });
    const store = DocumentStore.fromSnapshot(source.toSnapshot(), history);
    expectUndoRefused(store, gm, undefined, { type: "nothing_to_undo" });
    write(store, gm, "goblin1", "ac", 15);
    expect(findUndoTarget(store.history).index).toBe(2);
  });
});

describe("conflicts", () => {
  test("epic criterion: a later write by the agent to the same cell refuses the GM's undo", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 4, "GM damages goblin");
    write(store, agent, "goblin1", "damage_taken", 9, "Agent damages goblin");
    const rejection = expectUndoRefused(
      store,
      gm,
      { type: "actor", actor: gm },
      { type: "undo_conflict", target: 0, conflicting: [1] },
    );
    if (rejection.type !== "undo_conflict") throw new Error("unreachable");
    expect(rejection.message).toContain("Agent damages goblin");
    expect(rejection.message).toContain("goblin1.damage_taken");
    expect(damage(store)).toEqual(num(9));
  });

  test("epic criterion: a later write by the agent to a different cell does not", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 4, "GM damages goblin");
    write(store, agent, "goblin1", "ac", 15, "Agent sets AC");
    const result = undone(store, gm, { type: "actor", actor: gm });
    expect(result.group).toMatchObject({ undoes: 0, actor: gm, kind: "undo" });
    expect(damage(store)).toEqual(num(0));
    expect(store.getCell("goblin1", "ac")).toEqual(lit(15));
  });

  test("lists every conflicting group in index order", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 4);
    write(store, gm, "aldric", "damage_taken", 1);
    write(store, agent, "goblin1", "damage_taken", 5, "first");
    write(store, agent, "goblin1", "damage_taken", 6, "second");
    const target = must(store.history.get(0));
    expect(undoConflicts(store.history, target).map((g) => g.index)).toEqual([2, 3]);
    const rejection = expectUndoRefused(
      store,
      gm,
      { type: "group", index: 0 },
      { type: "undo_conflict", target: 0, conflicting: [2, 3] },
    );
    expect("message" in rejection && rejection.message).toContain("first");
  });

  test("undo groups and undone groups never conflict", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 4);
    write(store, agent, "goblin1", "damage_taken", 9);
    undone(store, agent, { type: "actor", actor: agent });
    expect(damage(store)).toEqual(num(4));
    // Group 1 is undone and group 2 is an undo: group 0 is undoable.
    undone(store, gm, { type: "actor", actor: gm });
    expect(damage(store)).toEqual(num(0));
  });

  test("a per-cell visibility change touches the cell's key", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 4);
    const r = store.transact(agent, { kind: "edit", label: "hide damage" }, (tx) => {
      tx.record({
        type: "cell_visibility",
        object: "goblin1",
        cell: "damage_taken",
        before: null,
        after: { type: "viewers", viewers: ["gm"] },
      });
    });
    expect(r.ok).toBe(true);
    expectUndoRefused(store, gm, { type: "group", index: 0 }, { type: "undo_conflict" });
  });

  test("an earlier group never conflicts", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 4);
    write(store, gm, "goblin1", "ac", 13);
    expect(undoConflicts(store.history, must(store.history.get(1)))).toEqual([]);
    undone(store, gm, { type: "group", index: 1 });
    expect(store.getCell("goblin1", "ac")).toEqual(lit(12));
  });

  test("an undo group records the inverse, actor, label and names", () => {
    const store = DocumentStore.fromSnapshot(scene());
    write(store, gm, "goblin1", "damage_taken", 4, "GM damages goblin");
    const { group } = undone(store, agent);
    expect(group).toMatchObject({
      kind: "undo",
      undoes: 0,
      actor: agent,
      base_revision: 1,
      revision: 2,
      names: { goblin1: "Goblin" },
      effects: [
        { type: "cell", object: "goblin1", cell: "damage_taken", before: lit(4), after: lit(0) },
      ],
    });
    expect(group.label).toContain("GM damages goblin");
  });
});
