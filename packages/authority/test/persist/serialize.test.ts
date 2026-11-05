import {
  canonicalJson,
  DocumentStore,
  InvalidAssetPathError,
  parseTable,
  serializeTable,
  sha256Hex,
} from "@vtt/authority";
import { FILE_FORMAT, SCHEMA_VERSION, TableFileSchema } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { gmOnly, playedStore, scene, textOf } from "./helpers";

describe("serializeTable", () => {
  test("holds the snapshot, its hash, the log and the assets", () => {
    const store = playedStore();
    const file = serializeTable(store, ["images/map.png", "tokens/goblin.webp"]);
    expect(file.format).toBe(FILE_FORMAT);
    expect(file.schema_version).toBe(SCHEMA_VERSION);
    expect(file.snapshot).toEqual(store.toSnapshot());
    expect(file.snapshot_hash).toBe(`sha256:${sha256Hex(canonicalJson(file.snapshot))}`);
    expect(file.log).toEqual({
      first_index: store.history.firstIndex,
      groups: store.history.groups(),
      undo_barrier: store.history.undoBarrier,
    });
    expect(file.log.groups.map((g) => g.index)).toEqual([0, 1, 2, 3]);
    expect(file.assets).toEqual(["images/map.png", "tokens/goblin.webp"]);
    expect(TableFileSchema.safeParse(file).success).toBe(true);
  });

  test("returns a plain copy that does not alias the store", () => {
    const store = playedStore();
    const file = serializeTable(store, []);
    const group = file.log.groups[0];
    expect(Object.isFrozen(group)).toBe(false);
    file.snapshot.revision = 99;
    expect(store.revision).toBe(4);
  });

  test.each([
    "/abs/map.png",
    "\\\\server\\share\\map.png",
    "\\map.png",
    "C:\\maps\\map.png",
    "c:/maps/map.png",
    "",
  ])("refuses the asset path %j", (path) => {
    const store = playedStore();
    expect(() => serializeTable(store, ["ok.png", path])).toThrow(InvalidAssetPathError);
  });

  test("does no path conversion", () => {
    const file = serializeTable(playedStore(), ["a/../b.png", "./c d.png"]);
    expect(file.assets).toEqual(["a/../b.png", "./c d.png"]);
  });
});

describe("serialize → parse", () => {
  test("keeps cell_visibility entries on contents and tag unchanged", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const loaded = parseTable(textOf(store)).store;
    expect(loaded.toSnapshot()).toEqual(store.toSnapshot());
    expect(loaded.getCellVisibility("bag", "contents")).toEqual(gmOnly);
    expect(loaded.getCellVisibility("bag", "tag")).toEqual(gmOnly);
    expect(loaded.getObject("bag")?.cell_visibility).toEqual({ contents: gmOnly, tag: gmOnly });
  });

  test("restores the snapshot, revision and log", () => {
    const store = playedStore();
    const { store: loaded, editedExternally, warnings } = parseTable(textOf(store));
    expect(editedExternally).toBe(false);
    expect(warnings).toEqual([]);
    expect(loaded.toSnapshot()).toEqual(store.toSnapshot());
    expect(loaded.revision).toBe(store.revision);
    expect(loaded.history.toLog()).toEqual(store.history.toLog());
  });
});
