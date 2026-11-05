/**
 * M2 acceptance (DESIGN.md §9, M2): a document round-trips through the file
 * format, and undo of an op group is refused correctly after a conflicting op.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DocumentStore as Store,
  DocumentStore,
  loadTable,
  move,
  remove,
  saveTable,
  setFormula,
  spawn,
  type Transaction,
  undo,
  writeValue,
} from "@vtt/authority";
import { type Actor, type Cell, list, num, type Snapshot, text } from "@vtt/schema";
import { afterEach, beforeEach, expect, test } from "vitest";
import { must, obj } from "./store/helpers";

const gm: Actor = { type: "gm" };
const agent: Actor = { type: "agent", name: "claude" };
const lit = (n: number): Cell => ({ content: num(n) });
const at = (x: number, y: number): Cell => ({ content: list([num(x), num(y)]) });

/** A board with a goblin, and on a shelf a deck holding a card template that holds a zone. */
function table(): Snapshot {
  const objects = [
    obj("goblin", {
      board: "map",
      tag: ["creature"],
      cells: { name: { content: text("Goblin") }, hp: lit(7), position: at(1, 2), z: lit(0) },
    }),
    obj("deck", { board: "shelf", contents: ["card"], cells: { position: at(0, 0) } }),
    obj("card", {
      is_template: true,
      tag: ["card"],
      contents: ["card_zone"],
      cells: { name: { content: text("Fireball") }, radius: lit(4) },
    }),
    obj("card_zone", { is_zone: true, cells: { radius: { content: { type: "formula", source: "4" } } } }),
  ];
  return {
    revision: 0,
    next_seq: 1,
    boards: [
      { id: "map", name: "Map" },
      { id: "shelf", name: "Shelf" },
    ],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

function commit(store: Store, actor: Actor, label: string, fn: (tx: Transaction) => void): void {
  const result = store.transact(actor, { kind: "edit", label }, fn);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vtt-epic-m2-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("M2: a played table round-trips through the file, and undo is refused after a conflicting op", async () => {
  const store = DocumentStore.fromSnapshot(table());
  let spawned = "";
  commit(store, gm, "set goblin hp", (tx) => writeValue(tx, "goblin", "hp", num(5)));
  commit(store, gm, "give goblin an ac formula", (tx) => {
    setFormula(tx, "goblin", "ac", "10 + 2");
  });
  commit(store, gm, "override ac", (tx) => writeValue(tx, "goblin", "ac", num(15)));
  commit(store, gm, "move goblin", (tx) =>
    move(tx, "goblin", { type: "board", board: "map", position: [3, 4] }),
  );
  commit(store, gm, "cast fireball", (tx) => {
    spawned = spawn(tx, "card", { type: "board", board: "map", position: [6, 6] }).root;
  });
  commit(store, gm, "discard fireball", (tx) => remove(tx, spawned));
  const undone = undo(store, gm);
  expect(undone.ok).toBe(true);

  // The spawned card held its zone, and undoing the removal brought both back.
  const card = must(store.getObject(spawned));
  expect(card.board).toBe("map");
  expect(card.contents).toHaveLength(1);
  expect(store.getObject(must(card.contents[0]))?.is_zone).toBe(true);
  expect(store.getObject("goblin")?.cells.ac).toEqual({
    content: { type: "formula", source: "10 + 2" },
    override: num(15),
  });

  const path = join(dir, "table.json");
  expect(await saveTable(path, store, [])).toEqual({ ok: true });
  const loaded = await loadTable(path);
  expect(loaded.warnings).toEqual([]);
  expect(loaded.editedExternally).toBe(false);
  expect(loaded.store.toSnapshot()).toEqual(store.toSnapshot());
  const log = loaded.store.history.toLog();
  expect(log).toEqual(store.history.toLog());
  expect(log.groups.map((g) => g.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(log.first_index).toBe(store.history.firstIndex);
  expect(log.undo_barrier).toBe(store.history.undoBarrier);

  // Saving the loaded table again writes the same bytes.
  const bytes = await readFile(path, "utf8");
  expect(await saveTable(path, loaded.store, loaded.assets)).toEqual({ ok: true });
  expect(await readFile(path, "utf8")).toBe(bytes);

  // On the loaded store: the GM writes a cell, then the agent writes the same cell.
  const next = loaded.store;
  commit(next, gm, "GM wounds goblin", (tx) => writeValue(tx, "goblin", "hp", num(3)));
  commit(next, agent, "Agent wounds goblin", (tx) => writeValue(tx, "goblin", "hp", num(2)));
  const gmIndex = next.history.nextIndex - 2;

  const refused = undo(next, gm, { type: "actor", actor: gm });
  expect(refused).toMatchObject({
    ok: false,
    rejection: { type: "undo_conflict", target: gmIndex, conflicting: [gmIndex + 1] },
  });
  expect(next.getObject("goblin")?.cells.hp).toEqual(lit(2));

  const latest = undo(next, gm, { type: "latest" });
  expect(latest.ok).toBe(true);
  expect(next.getObject("goblin")?.cells.hp).toEqual(lit(3));
});
