/**
 * Stale-write conflicts (vtt-5su.5): the history floor, the keys a group
 * shares with a checked set, and the conflicts of a stale base revision
 * (PROTOCOL.md §6; DESIGN.md §7).
 */
import {
  compactLog,
  History,
  historyFloor,
  intersectingKeys,
  StaleWriteError,
  staleConflicts,
  Table,
  writeValue,
} from "@vtt/authority";
import { num } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, commit, placed, snapshot } from "../engine/helpers";

function fixture(revision = 5): Table {
  const s = snapshot([
    placed("goblin1", 0, 0, { cells: { hp: c(num(7)), ac: c(num(12)) } }),
    placed("orc", 5, 0, { cells: { hp: c(num(15)) } }),
  ]);
  return Table.fromSnapshot({ ...s, revision });
}

describe("historyFloor", () => {
  test("with no retained groups the floor is the current revision", () => {
    expect(historyFloor(new History(), 7)).toBe(7);
  });

  test("the base revision of the oldest group in the run ending at the current revision", () => {
    const t = fixture();
    for (let i = 0; i < 3; i++) commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(i)));
    expect(t.store.revision).toBe(8);
    expect(historyFloor(t.store.history, 8)).toBe(5);
  });

  test("compaction raises the floor to the oldest retained group's base", () => {
    const t = fixture();
    for (let i = 0; i < 3; i++) commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(i)));
    compactLog(t.store, 1);
    expect(historyFloor(t.store.history, 8)).toBe(7);
  });

  test("when the newest group is not at the current revision the floor is the current one", () => {
    const t = fixture();
    commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(1)));
    expect(historyFloor(t.store.history, 9)).toBe(9);
  });

  test("a break in revision chaining ends the run", () => {
    const h = new History();
    const g = (base: number) => ({
      base_revision: base,
      revision: base + 1,
      actor: { type: "gm" as const },
      kind: "edit" as const,
      label: "x",
      names: {},
      effects: [],
    });
    h.append(g(1));
    h.append(g(4));
    h.append(g(5));
    expect(historyFloor(h, 6)).toBe(4);
  });
});

describe("intersectingKeys", () => {
  test("returns the group's keys, not the checked ones", () => {
    expect(intersectingKeys(["obj:x"], ["cell:x/hp"])).toEqual(["obj:x"]);
  });

  test("keeps the group's order and drops non-conflicting keys", () => {
    expect(
      intersectingKeys(
        ["cell:a/hp", "cell:b/hp", "board:m", "cell:a/ac"],
        ["cell:a/ac", "cell:a/hp", "board:m"],
      ),
    ).toEqual(["cell:a/hp", "board:m", "cell:a/ac"]);
  });

  test("disjoint sets share nothing", () => {
    expect(intersectingKeys(["cell:a/hp"], ["cell:a/ac", "obj:b"])).toEqual([]);
  });
});

describe("staleConflicts", () => {
  test("names each conflicting group after the base with its shared keys", () => {
    const t = fixture();
    commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(1)));
    commit(t, (tx) => writeValue(tx, "orc", "hp", num(2)));
    commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(3)));
    const stale = staleConflicts(t.store.history, 5, ["cell:goblin1/hp"]);
    expect(stale).toEqual({
      type: "stale_write",
      base_revision: 5,
      revision: 8,
      floor: 5,
      truncated: false,
      conflicts: [
        { index: 0, revision: 6, actor: { type: "gm" }, label: "edit", keys: ["cell:goblin1/hp"] },
        { index: 2, revision: 8, actor: { type: "gm" }, label: "edit", keys: ["cell:goblin1/hp"] },
      ],
    });
  });

  test("groups at or before the base are not checked", () => {
    const t = fixture();
    commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(1)));
    commit(t, (tx) => writeValue(tx, "orc", "hp", num(2)));
    expect(staleConflicts(t.store.history, 6, ["cell:goblin1/hp"])).toBeNull();
  });

  test("disjoint keys are not stale", () => {
    const t = fixture();
    commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(1)));
    expect(staleConflicts(t.store.history, 5, ["cell:goblin1/ac"])).toBeNull();
  });

  test("StaleWriteError carries its rejection", () => {
    const t = fixture();
    commit(t, (tx) => writeValue(tx, "goblin1", "hp", num(1)));
    const stale = staleConflicts(t.store.history, 5, ["obj:goblin1"]);
    expect(stale).not.toBeNull();
    if (stale === null) return;
    const err = new StaleWriteError(stale);
    expect(err).toBeInstanceOf(Error);
    expect(err.rejection).toBe(stale);
  });
});

describe("Transaction.effects", () => {
  test("returns copies: mutating one changes neither the transaction nor the history", () => {
    const t = fixture();
    commit(t, (tx) => {
      writeValue(tx, "goblin1", "hp", num(1));
      const [e] = tx.effects();
      if (e?.type === "cell") e.after = c(num(99));
      expect(tx.effects()).toEqual([expect.objectContaining({ type: "cell", after: c(num(1)) })]);
    });
    expect(t.store.history.get(0)?.effects).toEqual([
      expect.objectContaining({ type: "cell", object: "goblin1", cell: "hp", after: c(num(1)) }),
    ]);
    expect(t.store.getCell("goblin1", "hp")).toEqual(c(num(1)));
  });
});
