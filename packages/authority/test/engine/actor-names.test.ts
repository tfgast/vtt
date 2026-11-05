/**
 * A character actor's name in a group's `names` (vtt-nb8.20; DESIGN.md §4.8,
 * §7, M5-D1; PROTOCOL.md §7.6): a group committed with a character actor
 * names that character, as it was at commit, even when the group touches
 * only other objects.
 */
import { coreHandlers, createExecutor, ScriptedDiceSource, Table } from "@vtt/authority";
import { type Actor, num, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, edit, placed, snapshot } from "./helpers";

const ALDRIC: Actor = { type: "character", id: "aldric" };
const core = createExecutor({ handlers: coreHandlers });

const tableOf = () =>
  Table.fromSnapshot(
    snapshot([
      placed("aldric", 0, 0, { is_character: true, cells: { name: c(text("Aldric")) } }),
      placed("g1", 3, 3, {
        cells: { name: c(text("G1")), hp: c(num(7)) },
        actions: [{ name: "Apply", steps: ["set(hp, hp - 2)"] }],
      }),
    ]),
  );

function renameAldric(table: Table, from: string, to: string) {
  const r = table.store.transact({ type: "gm" }, edit, (tx) => {
    tx.record({
      type: "cell",
      object: "aldric",
      cell: "name",
      before: c(text(from)),
      after: c(text(to)),
      cause: "edit",
    });
  });
  expect(r.ok).toBe(true);
}

describe("a character actor's name is captured at commit", () => {
  test("a transact group that touches only another object names the actor", () => {
    const table = tableOf();
    const r = table.store.transact(ALDRIC, edit, (tx) => {
      tx.record({
        type: "cell",
        object: "g1",
        cell: "hp",
        before: c(num(7)),
        after: c(num(5)),
        cause: "edit",
      });
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.group.names).toEqual({ aldric: "Aldric", g1: "G1" });
    const index = r.group.index;
    renameAldric(table, "Aldric", "Sir Aldric");
    expect(table.store.history.get(index)?.names.aldric).toBe("Aldric");
  });

  test("an invoke group that touches only another object names the actor", () => {
    const table = tableOf();
    const r = core.invokeAction(table, new ScriptedDiceSource([]), {
      object: "g1",
      action: "Apply",
      actor: ALDRIC,
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const group = table.store.history.groups().at(-1);
    expect(group?.actor).toEqual(ALDRIC);
    expect(group?.names).toEqual({ aldric: "Aldric", g1: "G1" });
    const index = group?.index ?? -1;
    renameAldric(table, "Aldric", "Sir Aldric");
    expect(table.store.history.get(index)?.names.aldric).toBe("Aldric");
  });

  test("an actor removed in its own group keeps the name it had before removal", () => {
    const table = tableOf();
    const before = table.store.toSnapshot().objects.aldric;
    if (before === undefined) throw new Error("no aldric");
    const r = table.store.transact(ALDRIC, edit, (tx) => {
      tx.record({
        type: "remove",
        objects: [before],
        location: { type: "board", board: "table" },
      });
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.group.names).toEqual({ aldric: "Aldric" });
  });
});
