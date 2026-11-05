/**
 * `set_value` with `replace: true` through `transact` (vtt-3l6.19;
 * PROTOCOL.md §5 M4-D17): one cell effect from a formula to a literal,
 * undoable; without `replace` a formula cell is overridden as before.
 */
import {
  type CommandContext,
  declaredKeys,
  executeTransact,
  executeUndo,
  ScriptedDiceSource,
  Table,
  TxnCache,
} from "@vtt/authority";
import {
  type TransactParams,
  TransactParamsSchema,
  type TransactResult,
  type WireOp,
} from "@vtt/protocol";
import { type Actor, bool, type Effect, num, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, f, placed, snapshot, zone } from "../engine/helpers";

const GM: Actor = { type: "gm" };
const gmOnly: ViewersValue = { type: "viewers", viewers: ["gm"] };

/** `goblin` (hp: formula `10` overridden by 4) and fog zone `fog` (visible_to: formula `owner`). */
function fixture(): Table {
  const s = snapshot([
    placed("goblin", 0, 0, {
      cells: { hp: { content: { type: "formula", source: "10" }, override: num(4) } },
    }),
    zone("fog", 20, 20, 4, { cells: { opaque: c(bool(true)), visible_to: f("owner") } }),
  ]);
  return Table.fromSnapshot({ ...s, revision: 1, next_seq: 1 });
}

function context(table: Table): CommandContext {
  return {
    table,
    actor: GM,
    kind: "ui",
    client: "ui-1",
    dice: new ScriptedDiceSource([]),
    txns: new TxnCache(),
  };
}

function transact(table: Table, ops: unknown[]): TransactResult {
  const raw = { base_revision: table.store.revision, ops };
  const params: TransactParams = TransactParamsSchema.parse(raw);
  expect(params).toEqual(raw);
  return executeTransact(context(table), params);
}

function undoLatest(table: Table): TransactResult {
  return executeUndo(context(table), { target: { type: "latest" } });
}

function cellEffects(table: Table): Effect[] {
  const latest = table.store.history.get(table.store.history.nextIndex - 1);
  return (latest?.effects ?? []).filter((e) => e.type === "cell") as Effect[];
}

describe("set_value with replace: true", () => {
  test("an overridden user formula becomes a literal; undo restores formula and override", () => {
    const table = fixture();
    const before = table.store.getCell("goblin", "hp");
    const r = transact(table, [
      { type: "set_value", object: "goblin", cell: "hp", value: num(9), replace: true },
    ]);
    expect(r.status).toBe("committed");
    expect(table.store.getCell("goblin", "hp")).toEqual({ content: num(9) });
    expect(table.value("goblin", "hp")).toEqual(num(9));
    expect(cellEffects(table)).toHaveLength(1);
    expect(undoLatest(table).status).toBe("committed");
    expect(table.store.getCell("goblin", "hp")).toEqual(before);
  });

  test("a zone's visible_to formula becomes a literal; undo restores it", () => {
    const table = fixture();
    const r = transact(table, [
      { type: "set_value", object: "fog", cell: "visible_to", value: gmOnly, replace: true },
    ]);
    expect(r.status).toBe("committed");
    expect(table.store.getCell("fog", "visible_to")).toEqual({ content: gmOnly });
    expect(cellEffects(table)).toHaveLength(1);
    expect(undoLatest(table).status).toBe("committed");
    expect(table.store.getCell("fog", "visible_to")).toEqual({
      content: { type: "formula", source: "owner" },
    });
  });

  test("a later edit of the same cell makes the undo undo_conflict", () => {
    const table = fixture();
    const first = transact(table, [
      { type: "set_value", object: "goblin", cell: "hp", value: num(9), replace: true },
    ]);
    if (first.status !== "committed") throw new Error("expected a commit");
    transact(table, [{ type: "set_value", object: "goblin", cell: "hp", value: num(1) }]);
    const r = executeUndo(context(table), { target: { type: "group", index: first.index } });
    expect(r).toMatchObject({ status: "rejected", rejection: { type: "undo_conflict" } });
  });

  test("on contents it is protected_cell", () => {
    const table = fixture();
    const r = transact(table, [
      {
        type: "set_value",
        object: "goblin",
        cell: "contents",
        value: { type: "list", items: [] },
        replace: true,
      },
    ]);
    expect(r).toMatchObject({
      status: "rejected",
      rejection: { type: "protected_cell", object: "goblin", cell: "contents" },
      op_index: 0,
    });
  });

  test("without replace a formula cell is still overridden", () => {
    const table = fixture();
    transact(table, [{ type: "set_value", object: "goblin", cell: "hp", value: num(2) }]);
    expect(table.store.getCell("goblin", "hp")).toEqual({
      content: { type: "formula", source: "10" },
      override: num(2),
    });
  });

  test("declared keys are unchanged", () => {
    const op: WireOp = {
      type: "set_value",
      object: "goblin",
      cell: "hp",
      value: num(9),
      replace: true,
    };
    expect(declaredKeys(op)).toEqual(["cell:goblin/hp"]);
  });
});
