/** Stores and files shared by the persistence tests. */
import {
  canonicalJson,
  DocumentStore,
  move,
  serializeTable,
  setCellVisibility,
  snapshotHash,
  writeValue,
} from "@vtt/authority";
import { type Actor, num, type Snapshot, type TableFile, type ViewersValue } from "@vtt/schema";
import { at, lit, named, obj } from "../store/helpers";

export const gm: Actor = { type: "gm" };
export const gmOnly: ViewersValue = { type: "viewers", viewers: ["gm"] };

/**
 * A board with a goblin and a bag holding a coin. The bag hides its
 * `contents` and `tag` from everyone but the GM; the goblin hides `hp`.
 */
export function scene(): Snapshot {
  const objects = [
    obj("goblin", {
      board: "map",
      tag: ["creature"],
      cells: { name: named("Goblin"), hp: lit(7), position: at(1, 2), z: lit(0) },
      cell_visibility: { hp: gmOnly },
    }),
    obj("bag", {
      board: "map",
      tag: ["loot"],
      contents: ["coin"],
      cells: { name: named("Bag"), position: at(5, 5) },
      cell_visibility: { tag: gmOnly, contents: gmOnly },
    }),
    obj("coin", { cells: { name: named("Coin"), value: lit(1), "10": lit(10), "9": lit(9) } }),
  ];
  return {
    revision: 0,
    next_seq: 1,
    boards: [{ id: "map", name: "Map" }],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

/** Commits one GM edit group running `fn`; returns its index. */
export function commit(
  store: DocumentStore,
  label: string,
  fn: Parameters<DocumentStore["transact"]>[2],
): number {
  const result = store.transact(gm, { kind: "edit", label }, fn);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result.group.index;
}

/** Writes goblin.hp = `value` in its own group; returns its index. */
export function setHp(store: DocumentStore, value: number): number {
  return commit(store, `hp ${value}`, (tx) => writeValue(tx, "goblin", "hp", num(value)));
}

/** scene() with a few groups: hp writes, a visibility change, and a move. */
export function playedStore(): DocumentStore {
  const store = DocumentStore.fromSnapshot(scene());
  setHp(store, 5);
  commit(store, "hide coin value", (tx) => setCellVisibility(tx, "coin", "value", gmOnly));
  commit(store, "move goblin", (tx) =>
    move(tx, "goblin", { type: "board", board: "map", position: [3, 3] }),
  );
  setHp(store, 4);
  return store;
}

/** The canonical text of `store` with no assets. */
export const textOf = (store: DocumentStore, assets: string[] = []): string =>
  canonicalJson(serializeTable(store, assets));

/** A file around `snapshot` and `log`, with a correct hash unless `hash` is given. */
export function fileOf(
  snapshot: Snapshot,
  log: TableFile["log"] = { first_index: 0, groups: [], undo_barrier: 0 },
  hash: string = snapshotHash(snapshot),
): string {
  const file: TableFile = {
    format: "a-table-of-dumb-objects",
    schema_version: 1,
    snapshot,
    snapshot_hash: hash,
    log,
    assets: [],
  };
  return canonicalJson(file);
}

/** Re-exported store test helpers. */
export { at, lit, must, named, obj } from "../store/helpers";
