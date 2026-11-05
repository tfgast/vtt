import {
  addBoard,
  canonicalJson,
  changedCells,
  DocState,
  DocumentStore,
  keysIntersect,
  parseTable,
  Rejected,
  remove,
  removeBoard,
  replay,
  serializeTable,
  setActions,
  type Transaction,
  touchedKeys,
  undo,
} from "@vtt/authority";
import {
  type ActionDef,
  type Actor,
  type Effect,
  type Rejection,
  toFixtureReason,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { must, table } from "./helpers";

const gm: Actor = { type: "gm" };
const edit = { kind: "edit", label: "edit" } as const;

const roll: ActionDef = { name: "Roll", steps: ["roll(value, 1d6)"] };
const heal: ActionDef = { name: "Heal", when: "hp < max_hp", steps: ["set(hp, max_hp)"] };
const attack: ActionDef = { name: "Attack", steps: [] };

/** Runs `fn` in a committed GM edit group; returns the group. */
function run(store: DocumentStore, fn: (tx: Transaction) => void) {
  const result = store.transact(gm, edit, fn);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result;
}

/**
 * Expects `fn` to be refused as `invalid` both inside an open transaction
 * (recording nothing) and through `transact` (changing neither document nor
 * history). Returns the rejection.
 */
function expectInvalid(store: DocumentStore, fn: (tx: Transaction) => void): Rejection {
  const before = store.toSnapshot();
  const next = store.history.nextIndex;
  const tx = store.begin(gm, edit);
  let thrown: unknown;
  try {
    fn(tx);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Rejected);
  expect(tx.changes().actionsChanged).toEqual([]);
  expect(tx.doc.toSnapshot()).toEqual(before);
  tx.abort();
  const result = store.transact(gm, edit, fn);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.type).toBe("invalid");
  expect(store.toSnapshot()).toEqual(before);
  expect(store.history.nextIndex).toBe(next);
  return result.rejection;
}

const actionsOf = (store: DocumentStore, id: string) => must(store.getObject(id)).actions;

describe("setActions", () => {
  test("records one field effect with the exact before and after", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => setActions(tx, "goblin", [roll]));
    const result = run(store, (tx) => setActions(tx, "goblin", [heal, attack]));
    expect(result.group.effects).toEqual([
      { type: "field", object: "goblin", field: "actions", before: [roll], after: [heal, attack] },
    ]);
    expect(actionsOf(store, "goblin")).toEqual([heal, attack]);
  });

  test("stores `when` and step text verbatim, unparsed", () => {
    const store = DocumentStore.fromSnapshot(table());
    const odd: ActionDef = { name: "Odd", when: "this is ((( not a formula", steps: ["???", "x"] };
    run(store, (tx) => setActions(tx, "goblin", [odd]));
    expect(actionsOf(store, "goblin")).toEqual([odd]);
  });

  test("an empty list clears the actions", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => setActions(tx, "goblin", [roll]));
    run(store, (tx) => setActions(tx, "goblin", []));
    expect(actionsOf(store, "goblin")).toEqual([]);
  });

  test("does not alias the caller's list", () => {
    const store = DocumentStore.fromSnapshot(table());
    const list: ActionDef[] = [{ name: "Roll", steps: ["a"] }];
    run(store, (tx) => setActions(tx, "goblin", list));
    must(list[0]).steps.push("b");
    list.push(attack);
    expect(actionsOf(store, "goblin")).toEqual([{ name: "Roll", steps: ["a"] }]);
  });

  test("undo restores the previous list", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => setActions(tx, "goblin", [roll]));
    run(store, (tx) => setActions(tx, "goblin", [heal]));
    expect(undo(store, gm).ok).toBe(true);
    expect(actionsOf(store, "goblin")).toEqual([roll]);
    expect(undo(store, gm).ok).toBe(true);
    expect(actionsOf(store, "goblin")).toEqual([]);
  });

  test("a later setActions on the same object makes undo of the earlier one conflict", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = run(store, (tx) => setActions(tx, "goblin", [roll])).group.index;
    const second = run(store, (tx) => setActions(tx, "goblin", [heal])).group.index;
    const result = undo(store, gm, { type: "group", index: first });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection).toMatchObject({ type: "undo_conflict", conflicting: [second] });
    expect(actionsOf(store, "goblin")).toEqual([heal]);
  });

  test("a later setActions on another object does not conflict", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = run(store, (tx) => setActions(tx, "goblin", [roll])).group.index;
    run(store, (tx) => setActions(tx, "bag", [heal]));
    expect(undo(store, gm, { type: "group", index: first }).ok).toBe(true);
    expect(actionsOf(store, "goblin")).toEqual([]);
    expect(actionsOf(store, "bag")).toEqual([heal]);
  });

  test("a later removal of the object conflicts", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = run(store, (tx) => setActions(tx, "goblin", [roll])).group.index;
    const removal = run(store, (tx) => remove(tx, "goblin")).group.index;
    const result = undo(store, gm, { type: "group", index: first });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection).toMatchObject({ type: "undo_conflict", conflicting: [removal] });
  });

  test("actionsChanged lists the object once for two calls in one transaction", () => {
    const store = DocumentStore.fromSnapshot(table());
    const result = run(store, (tx) => {
      setActions(tx, "goblin", [roll]);
      setActions(tx, "bag", [roll]);
      setActions(tx, "goblin", [heal]);
    });
    expect(result.summary.actionsChanged).toEqual(["goblin", "bag"]);
    expect(result.summary.changedCells).toEqual([]);
  });

  describe("refusals", () => {
    const cases: [string, unknown][] = [
      ["an empty name", [{ name: "", steps: [] }]],
      ["a name longer than 100 characters", [{ name: "x".repeat(101), steps: [] }]],
      [
        "two actions sharing a name",
        [
          { name: "Roll", steps: [] },
          { name: "Roll", steps: ["x"] },
        ],
      ],
      ["steps that are not an array", [{ name: "Roll", steps: "roll(value, 1d6)" }]],
      ["steps that are not all strings", [{ name: "Roll", steps: ["a", 3] }]],
      ["missing steps", [{ name: "Roll" }]],
      ["a non-string name", [{ name: 7, steps: [] }]],
      ["a non-string when", [{ name: "Roll", when: true, steps: [] }]],
      ["a blank when", [{ name: "Roll", when: "  ", steps: [] }]],
      ["a blank step", [{ name: "Roll", steps: ["a", ""] }]],
      ["an unknown key", [{ name: "Roll", steps: [], face: "x" }]],
      ["an action that is not an object", [null]],
      ["a list that is not an array", { name: "Roll", steps: [] }],
    ];

    test.each(cases)("%s is invalid and changes nothing", (_, actions) => {
      const store = DocumentStore.fromSnapshot(table());
      run(store, (tx) => setActions(tx, "goblin", [roll]));
      const rejection = expectInvalid(store, (tx) =>
        setActions(tx, "goblin", actions as ActionDef[]),
      );
      expect(toFixtureReason(rejection)).toBeNull();
      expect(actionsOf(store, "goblin")).toEqual([roll]);
    });

    test("an unknown object is invalid", () => {
      const store = DocumentStore.fromSnapshot(table());
      expectInvalid(store, (tx) => setActions(tx, "nobody", [roll]));
    });

    test("a name of exactly 100 characters, and names differing only in case, are accepted", () => {
      const store = DocumentStore.fromSnapshot(table());
      const actions: ActionDef[] = [
        { name: "x".repeat(100), steps: [] },
        { name: "roll", steps: [] },
        { name: "Roll", steps: [] },
      ];
      run(store, (tx) => setActions(tx, "goblin", actions));
      expect(actionsOf(store, "goblin")).toEqual(actions);
    });
  });
});

describe("the actions field effect", () => {
  const effect: Effect = {
    type: "field",
    object: "goblin",
    field: "actions",
    before: [],
    after: [roll],
  };

  test("touches actions:<obj>", () => {
    expect(touchedKeys(effect)).toEqual(["actions:goblin"]);
  });

  test("actions:<obj> intersects itself and obj:<obj>, nothing else", () => {
    expect(keysIntersect(["actions:goblin"], ["actions:goblin"])).toBe(true);
    expect(keysIntersect(["actions:goblin"], ["obj:goblin"])).toBe(true);
    expect(keysIntersect(["obj:goblin"], ["actions:goblin"])).toBe(true);
    expect(keysIntersect(["actions:goblin"], ["actions:bag"])).toBe(false);
    expect(keysIntersect(["actions:goblin"], ["obj:goblin_2", "obj:gob"])).toBe(false);
    expect(keysIntersect(["actions:goblin"], ["cell:goblin/actions"])).toBe(false);
    expect(keysIntersect(["actions:goblin"], ["cell:goblin/name", "board:goblin"])).toBe(false);
  });

  test("changes no readable cell", () => {
    expect(changedCells(effect, DocState.fromSnapshot(table()))).toEqual([]);
  });
});

describe("removeBoard", () => {
  test("removes an empty board and retires its id", () => {
    const store = DocumentStore.fromSnapshot(table());
    const result = run(store, (tx) => removeBoard(tx, "shelf"));
    expect(result.group.effects).toEqual([
      { type: "board", before: { id: "shelf", name: "Shelf" }, after: null },
      { type: "retire", ids: ["shelf"] },
    ]);
    expect(result.summary.boardsRemoved).toEqual(["shelf"]);
    expect(store.getBoard("shelf")).toBeUndefined();
    expect(store.toSnapshot().retired_ids).toEqual(["old", "shelf"]);
  });

  test("undo re-creates it, the id stays retired, and addBoard with that id is invalid", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => removeBoard(tx, "shelf"));
    expect(undo(store, gm).ok).toBe(true);
    expect(store.getBoard("shelf")).toEqual({ id: "shelf", name: "Shelf" });
    expect(store.toSnapshot().retired_ids).toEqual(["old", "shelf"]);
    run(store, (tx) => removeBoard(tx, "shelf"));
    const rejection = expectInvalid(store, (tx) => addBoard(tx, "shelf", "Shelf"));
    expect(toFixtureReason(rejection)).toBeNull();
  });

  test("a board created and removed in one transaction is removed and retired", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => {
      addBoard(tx, "attic");
      removeBoard(tx, "attic");
    });
    expect(store.getBoard("attic")).toBeUndefined();
    expect(store.toSnapshot().retired_ids).toContain("attic");
  });

  test("a board with an object directly on it is invalid", () => {
    const store = DocumentStore.fromSnapshot(table());
    const rejection = expectInvalid(store, (tx) => removeBoard(tx, "map"));
    expect(toFixtureReason(rejection)).toBeNull();
    expect(store.getBoard("map")).toEqual({ id: "map", name: "Map" });
  });

  test("an unknown board is invalid, and so is an object id", () => {
    const store = DocumentStore.fromSnapshot(table());
    expectInvalid(store, (tx) => removeBoard(tx, "attic"));
    expectInvalid(store, (tx) => removeBoard(tx, "goblin"));
    expectInvalid(store, (tx) => removeBoard(tx, "old"));
  });
});

describe("persistence and replay", () => {
  test("an actions field effect and a board removal survive serialize → parse and replay", () => {
    const base = table();
    const store = DocumentStore.fromSnapshot(base);
    run(store, (tx) => setActions(tx, "goblin", [heal, roll]));
    run(store, (tx) => removeBoard(tx, "shelf"));
    run(store, (tx) => setActions(tx, "goblin", [attack]));

    const { store: loaded, editedExternally } = parseTable(
      canonicalJson(serializeTable(store, [])),
    );
    expect(editedExternally).toBe(false);
    expect(loaded.toSnapshot()).toEqual(store.toSnapshot());
    expect(loaded.history.toLog()).toEqual(store.history.toLog());
    expect(replay(base, loaded.history.groups())).toEqual(loaded.toSnapshot());

    expect(undo(loaded, gm, { type: "group", index: 1 }).ok).toBe(true);
    expect(loaded.getBoard("shelf")).toEqual({ id: "shelf", name: "Shelf" });
    expect(must(loaded.getObject("goblin")).actions).toEqual([attack]);
  });

  test("canonical JSON orders an actions field effect's ActionDefs as the snapshot does", () => {
    const store = DocumentStore.fromSnapshot(table());
    // Keys inserted out of order on purpose.
    const scrambled = { steps: ["set(hp, max_hp)"], when: "hp < max_hp", name: "Heal" };
    run(store, (tx) => setActions(tx, "goblin", [scrambled]));
    run(store, (tx) => setActions(tx, "goblin", [{ steps: ["x"], when: "y", name: "Z" }]));

    const text = canonicalJson(serializeTable(store, []));
    const file = JSON.parse(text);
    const order = ["name", "when", "steps"];
    expect(Object.keys(file.snapshot.objects.goblin.actions[0])).toEqual(order);
    for (const group of file.log.groups) {
      for (const effect of group.effects) {
        expect(Object.keys(effect)).toEqual(["type", "object", "field", "before", "after"]);
        for (const a of [...effect.before, ...effect.after]) expect(Object.keys(a)).toEqual(order);
      }
    }
    expect(file.log.groups[1].effects[0].before).toHaveLength(1);

    const loaded = parseTable(text).store;
    expect(canonicalJson(serializeTable(loaded, []))).toBe(text);
  });
});
