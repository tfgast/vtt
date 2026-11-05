/**
 * The Table notification seam (vtt-5su.9): `table.onCommit` runs after the
 * internal hook has updated the spatial index and invalidated the engine,
 * and carries the keys `engine.invalidate` newly marked dirty.
 */
import { Table, type TableCommit, writeValue } from "@vtt/authority";
import { num, ref } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, commit, f, placed, snapshot } from "../engine/helpers";

function chain(): Table {
  return Table.fromSnapshot(
    snapshot([
      placed("a", 0, 0, { cells: { bref: c(ref("b")), total: f("bref.x * 2") } }),
      placed("b", 1, 0, { cells: { x: c(num(1)) } }),
      placed("z", 2, 0, { cells: { w: c(num(7)) } }),
    ]),
  );
}

describe("Table.onCommit", () => {
  test("listeners read the committed revision's values", () => {
    const table = chain();
    expect(table.value("a", "total")).toEqual(num(2));
    const seen: { revision: number; total: unknown }[] = [];
    table.onCommit(({ group }) => {
      seen.push({ revision: group.revision, total: table.value("a", "total") });
    });
    commit(table, (tx) => writeValue(tx, "b", "x", num(5)));
    expect(seen).toEqual([{ revision: 1, total: num(10) }]);
  });

  test("the payload carries the group, the summary and the newly dirtied keys", () => {
    const table = chain();
    table.value("a", "total");
    const payloads: TableCommit[] = [];
    table.onCommit((p) => payloads.push(p));
    commit(table, (tx) => writeValue(tx, "b", "x", num(3)));
    commit(table, (tx) => writeValue(tx, "z", "w", num(3)));
    expect(payloads.map((p) => p.dirty)).toEqual([["a:total"], []]);
    expect(payloads[0]?.summary.changedCells).toEqual(["b:x"]);
    expect(payloads[1]?.group.revision).toBe(2);
  });

  test("the returned function unregisters the listener", () => {
    const table = chain();
    let calls = 0;
    const off = table.onCommit(() => {
      calls++;
    });
    commit(table, (tx) => writeValue(tx, "b", "x", num(3)));
    off();
    commit(table, (tx) => writeValue(tx, "b", "x", num(4)));
    expect(calls).toBe(1);
  });
});
