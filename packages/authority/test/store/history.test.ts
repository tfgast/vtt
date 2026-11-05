import { History, HistoryError, type HistoryViolation, validateHistory } from "@vtt/authority";
import type { OpGroup, TableLog } from "@vtt/schema";
import { describe, expect, test } from "vitest";

/** A group at `index` whose revisions follow the index (base = index, revision = index + 1). */
function group(index: number, rest: Partial<OpGroup> = {}): OpGroup {
  return {
    index,
    base_revision: index,
    revision: index + 1,
    actor: { type: "gm" },
    kind: "edit",
    label: `edit ${index}`,
    names: {},
    effects: [],
    ...rest,
  };
}

const unindexed = ({ index: _, ...g }: OpGroup) => g;

/** A history of groups 0 … n-1, appended in order. */
function history(n: number): History {
  const h = new History();
  for (let i = 0; i < n; i++) h.append(unindexed(group(i)));
  return h;
}

const log = (groups: OpGroup[], rest: Partial<TableLog> = {}): TableLog => ({
  first_index: groups[0]?.index ?? 0,
  groups,
  undo_barrier: 0,
  ...rest,
});

const types = (vs: HistoryViolation[]) => vs.map((v) => v.type);

describe("History", () => {
  test("append assigns absolute indices", () => {
    const h = history(3);
    expect(h.firstIndex).toBe(0);
    expect(h.nextIndex).toBe(3);
    expect(h.groups().map((g) => g.index)).toEqual([0, 1, 2]);
    expect(h.get(1)?.label).toBe("edit 1");
    expect(h.get(3)).toBeUndefined();
  });

  test("tracks undone groups", () => {
    const h = history(2);
    h.append(unindexed(group(2, { kind: "undo", undoes: 0 })));
    expect(h.isUndone(0)).toBe(true);
    expect(h.isUndone(1)).toBe(false);
    expect(h.isUndone(2)).toBe(false);
    expect(() => h.append(unindexed(group(3, { kind: "undo", undoes: 0 })))).toThrow();
    expect(() => h.append(unindexed(group(3, { kind: "undo", undoes: 2 })))).toThrow();
  });

  test("compact(2) keeps the last two groups with their indices", () => {
    const h = history(10);
    h.compact(2);
    expect(h.groups().map((g) => g.index)).toEqual([8, 9]);
    expect(h.firstIndex).toBe(8);
    expect(h.nextIndex).toBe(10);
    expect(h.undoBarrier).toBeGreaterThanOrEqual(8);
    expect(h.get(7)).toBeUndefined();
    expect(h.get(8)?.index).toBe(8);
  });

  test("compact(0) leaves an empty log at the next index", () => {
    const h = history(10);
    h.compact(0);
    expect(h.groups()).toEqual([]);
    expect(h.firstIndex).toBe(10);
    expect(h.nextIndex).toBe(10);
    expect(h.undoBarrier).toBe(10);
    h.append(unindexed(group(10)));
    expect(h.get(10)?.index).toBe(10);
  });

  test("compaction never lowers a higher barrier", () => {
    const h = history(10);
    h.raiseBarrier(9);
    h.compact(5);
    expect(h.undoBarrier).toBe(9);
  });

  test("raiseBarrier never lowers it and never passes the next index", () => {
    const h = history(4);
    h.raiseBarrier(3);
    h.raiseBarrier(1);
    expect(h.undoBarrier).toBe(3);
    expect(() => h.raiseBarrier(5)).toThrow();
  });

  test("restore reproduces indices and barrier of a valid log", () => {
    const h = history(1);
    const groups = [
      group(4),
      group(5, { kind: "undo", undoes: 3 }),
      group(6, { kind: "undo", undoes: 4 }),
    ];
    h.restore(log(groups, { undo_barrier: 5 }), 7, { editedExternally: false });
    expect(h.firstIndex).toBe(4);
    expect(h.nextIndex).toBe(7);
    expect(h.undoBarrier).toBe(5);
    expect(h.groups()).toEqual(groups);
    expect(h.isUndone(4)).toBe(true);
    expect(h.toLog()).toEqual(log(groups, { undo_barrier: 5 }));
  });

  test("restore of a hand-edited file raises the barrier to the next index", () => {
    const h = new History();
    h.restore(log([group(0), group(1)]), 99, { editedExternally: true });
    expect(h.undoBarrier).toBe(2);
    const empty = new History();
    empty.restore(log([], { first_index: 4, undo_barrier: 4 }), 99, { editedExternally: true });
    expect(empty.undoBarrier).toBe(4);
  });

  test("restore refuses an invalid log and keeps the history", () => {
    const h = history(2);
    const bad = log([group(0), group(2, { base_revision: 1, revision: 2 })]);
    const refuse = () => h.restore(bad, 2, { editedExternally: false });
    expect(refuse).toThrow(HistoryError);
    const error = (() => {
      try {
        refuse();
      } catch (e) {
        return e;
      }
    })();
    expect(error instanceof HistoryError && types(error.violations)).toEqual(["index"]);
    expect(h.groups().map((g) => g.index)).toEqual([0, 1]);
  });
});

describe("validateHistory", () => {
  const ok = { editedExternally: false };

  test("accepts a valid log, including an empty one", () => {
    expect(validateHistory(log([group(0), group(1)], { undo_barrier: 2 }), 2, ok)).toEqual([]);
    expect(validateHistory(log([], { first_index: 3, undo_barrier: 3 }), 17, ok)).toEqual([]);
  });

  test("a gap in indices", () => {
    expect(
      types(validateHistory(log([group(0), group(2, { base_revision: 1, revision: 2 })]), 2, ok)),
    ).toEqual(["index"]);
  });

  test("a broken revision chain", () => {
    const step = log([group(0), group(1, { revision: 3 })]);
    expect(types(validateHistory(step, 3, ok))).toEqual(["revision_step"]);
    const chain = log([group(0), group(1, { base_revision: 2, revision: 3 })]);
    expect(types(validateHistory(chain, 3, ok))).toEqual(["revision_chain"]);
  });

  test("undoes on a non-undo group, and an undo group without undoes", () => {
    expect(types(validateHistory(log([group(0), group(1, { undoes: 0 })]), 2, ok))).toEqual([
      "undo_kind",
    ]);
    expect(types(validateHistory(log([group(0), group(1, { kind: "undo" })]), 2, ok))).toEqual([
      "undo_kind",
    ]);
  });

  test("an undo of an undo, and of a later index", () => {
    const groups = [
      group(0),
      group(1, { kind: "undo", undoes: 0 }),
      group(2, { kind: "undo", undoes: 1 }),
    ];
    expect(types(validateHistory(log(groups), 3, ok))).toEqual(["undo_target"]);
    const later = [group(0, { kind: "undo", undoes: 1 }), group(1)];
    expect(types(validateHistory(log(later), 2, ok))).toEqual(["undo_target"]);
  });

  test("an undo of an index below first_index is allowed", () => {
    expect(
      validateHistory(log([group(5, { kind: "undo", undoes: 2 })], { undo_barrier: 5 }), 6, ok),
    ).toEqual([]);
  });

  test("a double undo", () => {
    const groups = [
      group(0),
      group(1, { kind: "undo", undoes: 0 }),
      group(2, { kind: "undo", undoes: 0 }),
    ];
    expect(types(validateHistory(log(groups), 3, ok))).toEqual(["double_undo"]);
  });

  test("a barrier out of range", () => {
    expect(types(validateHistory(log([group(2)], { undo_barrier: 1 }), 3, ok))).toEqual([
      "barrier",
    ]);
    expect(types(validateHistory(log([group(2)], { undo_barrier: 4 }), 3, ok))).toEqual([
      "barrier",
    ]);
    expect(validateHistory(log([group(2)], { undo_barrier: 3 }), 3, ok)).toEqual([]);
  });

  test("a final revision differing from the snapshot, unless edited externally", () => {
    expect(types(validateHistory(log([group(0)]), 5, ok))).toEqual(["snapshot_revision"]);
    expect(validateHistory(log([group(0)]), 5, { editedExternally: true })).toEqual([]);
  });

  test("reports every violation at once", () => {
    const groups = [group(0, { undoes: 0 }), group(2, { revision: 9 })];
    expect(types(validateHistory(log(groups, { undo_barrier: 7 }), 5, ok)).sort()).toEqual(
      [
        "barrier",
        "index",
        "revision_chain",
        "revision_step",
        "snapshot_revision",
        "undo_kind",
        "undo_target",
      ].sort(),
    );
  });
});
