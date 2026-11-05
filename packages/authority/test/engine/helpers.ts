/** Shared by the engine adapter tests (packages/authority/test/engine). */
import type { DocumentStore, Table, Transaction, TransactResult } from "@vtt/authority";
import {
  type Actor,
  type Cell,
  type CellContent,
  list,
  num,
  type Snapshot,
  type TableObject,
} from "@vtt/schema";
import { expect } from "vitest";

export const gm: Actor = { type: "gm" };
export const edit = { kind: "edit", label: "edit" } as const;

export const c = (content: CellContent): Cell => ({ content });
export const f = (source: string): Cell => ({ content: { type: "formula", source } });
export const at = (x: number, y: number): Cell => c(list([num(x), num(y)]));

/** A TableObject with every field at its default, then `rest`. */
export function obj(id: string, rest: Partial<TableObject> = {}): TableObject {
  return {
    id,
    is_template: false,
    is_zone: false,
    is_character: false,
    tag: [],
    shape: null,
    board: null,
    contents: [],
    cells: {},
    cell_visibility: {},
    actions: [],
    ...rest,
  };
}

/** An object placed on board `table` at (x, y). */
export function placed(id: string, x: number, y: number, rest: Partial<TableObject> = {}) {
  return obj(id, { board: "table", ...rest, cells: { position: at(x, y), ...rest.cells } });
}

/** A square zone of side `side` anchored at its centre (x, y) on board `table`. */
export function zone(
  id: string,
  x: number,
  y: number,
  side: number,
  rest: Partial<TableObject> = {},
) {
  return placed(id, x, y, {
    is_zone: true,
    shape: { type: "rect", width: side, height: side },
    ...rest,
  });
}

/** A snapshot with board `table` (and any extra boards) holding `objects`. */
export function snapshot(objects: TableObject[], boards: string[] = ["table"]): Snapshot {
  return {
    revision: 0,
    next_seq: 1,
    boards: boards.map((id) => ({ id, name: id })),
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

/** Runs `fn` in one committed transaction on the table's store. */
export function commit(
  table: Table | DocumentStore,
  fn: (tx: Transaction) => void,
): TransactResult {
  const store = "store" in table ? table.store : table;
  const result = store.transact(gm, edit, fn);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}
