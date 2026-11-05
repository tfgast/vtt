/**
 * `create_object.id_base` through `transact` (vtt-3l6.19; PROTOCOL.md §5
 * M4-D12): parsed by the protocol schema, executed, `as` bound to the
 * allocated id.
 */
import {
  type CommandContext,
  declaredKeys,
  executeTransact,
  ScriptedDiceSource,
  Table,
  TxnCache,
} from "@vtt/authority";
import { type TransactParams, TransactParamsSchema, type TransactResult } from "@vtt/protocol";
import type { Actor } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { placed, snapshot } from "../engine/helpers";

const GM: Actor = { type: "gm" };

function fixture(retired: string[] = []): Table {
  const s = snapshot([placed("bag", 0, 0)], ["table"]);
  return Table.fromSnapshot({ ...s, revision: 2, next_seq: 3, retired_ids: retired });
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

/** Parses `raw` with the wire schema (it must round-trip unchanged) and executes it. */
function transact(table: Table, raw: unknown): TransactResult {
  const params: TransactParams = TransactParamsSchema.parse(raw);
  expect(params).toEqual(raw);
  return executeTransact(context(table), params);
}

const board = { type: "board", board: "table", position: [4, 5] } as const;
const zoneInit = { is_zone: true, shape: { type: "rect", width: 2, height: 2 } } as const;

describe("create_object with id_base", () => {
  test("allocates <id_base>_<n>", () => {
    const table = fixture();
    const r = transact(table, {
      base_revision: 2,
      ops: [{ type: "create_object", id_base: "zone", to: board, init: zoneInit }],
    });
    expect(r).toMatchObject({ status: "committed", created: [{ op_index: 0, id: "zone_3" }] });
    expect(table.store.getObject("zone_3")?.is_zone).toBe(true);
    expect(table.store.nextSeq).toBe(4);
  });

  test("skips a retired <id_base>_<n>", () => {
    const table = fixture(["zone_3"]);
    const r = transact(table, {
      base_revision: 2,
      ops: [{ type: "create_object", id_base: "zone", to: board }],
    });
    expect(r).toMatchObject({ status: "committed", created: [{ op_index: 0, id: "zone_4" }] });
  });

  test("a bound as resolves to the allocated id", () => {
    const table = fixture();
    const r = transact(table, {
      base_revision: 2,
      ops: [
        { type: "create_object", id_base: "zone", as: "$z", to: board, init: zoneInit },
        {
          type: "set_value",
          object: "$z",
          cell: "name",
          value: { type: "text", value: "Fog" },
        },
        {
          type: "set_value",
          object: "bag",
          cell: "target",
          value: { type: "ref", object: "$z" },
        },
      ],
    });
    expect(r).toMatchObject({
      status: "committed",
      created: [{ op_index: 0, id: "zone_3" }],
      bindings: { $z: "zone_3" },
    });
    expect(table.store.getCell("zone_3", "name")?.content).toEqual({ type: "text", value: "Fog" });
    expect(table.store.getCell("bag", "target")?.content).toEqual({
      type: "ref",
      object: "zone_3",
    });
  });

  test("id and id_base together are rejected invalid", () => {
    const table = fixture();
    const r = transact(table, {
      base_revision: 2,
      ops: [{ type: "create_object", id: "fog", id_base: "zone", to: board }],
    });
    expect(r).toMatchObject({ status: "rejected", rejection: { type: "invalid" }, op_index: 0 });
    expect(table.store.revision).toBe(2);
  });

  test("an id_base without id syntax is rejected invalid", () => {
    for (const id_base of ["", "1zone", "zone-x", "$zone"]) {
      const table = fixture();
      const r = transact(table, {
        base_revision: 2,
        ops: [{ type: "create_object", id_base, to: board }],
      });
      expect(r, id_base).toMatchObject({
        status: "rejected",
        rejection: { type: "invalid" },
        op_index: 0,
      });
    }
  });

  test("without id_base an allocated id is still obj_<n>", () => {
    const table = fixture();
    const r = transact(table, { base_revision: 2, ops: [{ type: "create_object", to: board }] });
    expect(r).toMatchObject({ status: "committed", created: [{ op_index: 0, id: "obj_3" }] });
  });

  test("declared keys are unchanged: only the destination key", () => {
    expect(declaredKeys({ type: "create_object", id_base: "zone", to: board })).toEqual([
      "board:table",
    ]);
  });
});
