import { compactLog, DocumentStore, parseTable, undo } from "@vtt/authority";
import { describe, expect, test } from "vitest";
import { gm, scene, setHp, textOf } from "./helpers";

describe("compactLog", () => {
  test("keeps absolute indices and blocks undo below the kept range", () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (let i = 0; i < 10; i++) setHp(store, 20 + i);
    compactLog(store, 3);
    expect(store.history.firstIndex).toBe(7);
    expect(store.history.groups().map((g) => g.index)).toEqual([7, 8, 9]);
    expect(store.history.undoBarrier).toBe(7);
    expect(undo(store, gm, { type: "group", index: 5 })).toMatchObject({
      ok: false,
      rejection: { type: "nothing_to_undo" },
    });
    expect(setHp(store, 1)).toBe(10);
    expect(undo(store, gm, { type: "group", index: 10 }).ok).toBe(true);

    const loaded = parseTable(textOf(store)).store;
    expect(loaded.history.toLog()).toEqual(store.history.toLog());
  });

  test("keepLast 0 empties the log at the next index", () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (let i = 0; i < 4; i++) setHp(store, i);
    compactLog(store, 0);
    expect(store.history.groups()).toEqual([]);
    expect(store.history.firstIndex).toBe(4);
    expect(store.history.nextIndex).toBe(4);
    expect(store.history.undoBarrier).toBe(4);
  });
});
