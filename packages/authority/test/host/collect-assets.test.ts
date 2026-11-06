/**
 * Collecting unreferenced assets on command (DESIGN.md §7, Revisions and
 * assets; M6-D32): an asset no stored value in the snapshot or in a retained
 * group's effects mentions is removed from the table's asset list and,
 * with `delete`, from `<table>.assets/`. Never automatic.
 */
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactLog,
  createObject,
  DocumentStore,
  GM_BOARD_ID,
  importAsset,
  loadTable,
  newTableSnapshot,
  nodeFs,
  setActions,
  setFormula,
  TableHost,
  type Transaction,
  writeValue,
} from "@vtt/authority";
import type { Actor } from "@vtt/schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const gm: Actor = { type: "gm" };

/** The PNG signature followed by `fill` (only the magic bytes are checked). */
const png = (fill: string): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(fill)]);

const text = (value: string) => ({ type: "text", value }) as const;

let dir: string;
let path: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-collect-")));
  path = join(dir, "dungeon.json");
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await rm(dir, { recursive: true, force: true });
});

async function open(): Promise<TableHost> {
  const host = await TableHost.open(path, { createIfMissing: true, autosave: false });
  hosts.push(host);
  return host;
}

/** One committed GM edit on `host`'s store. */
function edit(host: TableHost, fn: (tx: Transaction) => void): void {
  const result = host.table.store.transact(gm, { kind: "edit", label: "edit" }, fn);
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

/** A token on the GM board with `cells`. */
function token(host: TableHost, id: string, image: string): void {
  edit(host, (tx) => {
    createObject(
      tx,
      { cells: { image: { content: text(image) } } },
      { type: "board", board: GM_BOARD_ID, position: [0, 0] },
      id,
    );
  });
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Imports two images, `map` and `goblin`, and returns their listed paths. */
async function importTwo(host: TableHost): Promise<{ map: string; goblin: string }> {
  const map = (await importAsset(host, { bytes: png("map"), filename: "map.png" })).path;
  const goblin = (await importAsset(host, { bytes: png("goblin"), filename: "goblin.png" })).path;
  return { map, goblin };
}

describe("collectAssets", () => {
  test("unlists and deletes the unreferenced image; keeps the referenced one, across save and reload", async () => {
    const host = await open();
    const { map, goblin } = await importTwo(host);
    token(host, "goblin_1", goblin);

    const result = await host.collectAssets({ delete: true });
    expect(result).toEqual({ unreferenced: [map], deleted: [map] });
    expect(host.assets).toEqual([goblin]);
    expect((await host.save()).status).toBe("saved");

    const loaded = await loadTable(path);
    expect(loaded.assets).toEqual([goblin]);
    expect(loaded.warnings).toEqual([]);
    expect(await exists(join(dir, goblin))).toBe(true);
    expect(await exists(join(dir, map))).toBe(false);
  });

  test("without delete the file stays in the assets directory, only unlisted", async () => {
    const host = await open();
    const { map, goblin } = await importTwo(host);
    token(host, "goblin_1", goblin);

    expect(await host.collectAssets()).toEqual({ unreferenced: [map], deleted: [] });
    expect((await host.save()).status).toBe("saved");
    expect((await loadTable(path)).assets).toEqual([goblin]);
    expect(await exists(join(dir, map))).toBe(true);
  });

  test("collecting makes the table unsaved; nothing to collect changes nothing", async () => {
    const host = await open();
    const { map, goblin } = await importTwo(host);
    token(host, "goblin_1", goblin);
    token(host, "map_1", map);
    expect((await host.save()).status).toBe("saved");
    const generation = host.assetsGeneration;
    expect(await host.collectAssets({ delete: true })).toEqual({ unreferenced: [], deleted: [] });
    expect(host.assetsGeneration).toBe(generation);
    expect(host.assets).toEqual([map, goblin]);
  });

  test("an asset referenced only by a retained group's effects is kept", async () => {
    const host = await open();
    const { map, goblin } = await importTwo(host);
    token(host, "goblin_1", goblin);
    token(host, "map_1", map);
    edit(host, (tx) => writeValue(tx, "goblin_1", "image", text("")));

    const snapshot = JSON.stringify(host.table.store.toSnapshot());
    expect(snapshot).not.toContain(goblin);
    expect(await host.collectAssets({ delete: true })).toEqual({ unreferenced: [], deleted: [] });
    expect((await host.save()).status).toBe("saved");
    expect((await loadTable(path)).assets).toEqual([map, goblin]);
    expect(await exists(join(dir, goblin))).toBe(true);
  });

  test("after compaction drops that group, the asset becomes collectable", async () => {
    const host = await open();
    const { map, goblin } = await importTwo(host);
    token(host, "goblin_1", goblin);
    token(host, "map_1", map);
    edit(host, (tx) => writeValue(tx, "goblin_1", "image", text("")));
    expect((await host.collectAssets()).unreferenced).toEqual([]);

    compactLog(host.table.store, 0);
    expect(await host.collectAssets({ delete: true })).toEqual({
      unreferenced: [goblin],
      deleted: [goblin],
    });
    expect((await host.save()).status).toBe("saved");
    expect((await loadTable(path)).assets).toEqual([map]);
    expect(await exists(join(dir, goblin))).toBe(false);
    expect(await exists(join(dir, map))).toBe(true);
  });

  test("an undo group's effects count: the undone write still references the asset", async () => {
    const host = await open();
    const { map, goblin } = await importTwo(host);
    token(host, "map_1", map);
    token(host, "goblin_1", "");
    edit(host, (tx) => writeValue(tx, "goblin_1", "image", text(goblin)));
    const written = host.table.store.history.nextIndex - 1;
    // Keep only the write, then undo it: the snapshot no longer names the goblin.
    compactLog(host.table.store, 1);
    const undone = host.table.store.transact(
      gm,
      { kind: "undo", label: "undo", undoes: written },
      (tx) => writeValue(tx, "goblin_1", "image", text("")),
    );
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    compactLog(host.table.store, 1);
    expect(host.table.store.history.groups().map((g) => g.kind)).toEqual(["undo"]);
    expect(await host.collectAssets()).toEqual({ unreferenced: [], deleted: [] });
  });

  test("formula source, overrides, list values and action steps that mention a path count", async () => {
    const host = await open();
    const a = (await importAsset(host, { bytes: png("a"), filename: "a.png" })).path;
    const b = (await importAsset(host, { bytes: png("b"), filename: "b.png" })).path;
    const c = (await importAsset(host, { bytes: png("c"), filename: "c.png" })).path;
    const d = (await importAsset(host, { bytes: png("d"), filename: "d.png" })).path;
    edit(host, (tx) => {
      createObject(
        tx,
        { cells: { pics: { content: { type: "list", items: [text("x"), text(b)] } } } },
        { type: "board", board: GM_BOARD_ID, position: [0, 0] },
        "holder",
      );
      setFormula(tx, "holder", "image", `if(true, ${JSON.stringify(a)}, "")`);
      setActions(tx, "holder", [
        { name: "show", steps: [`set this.image = ${JSON.stringify(c)}`] },
      ]);
    });
    compactLog(host.table.store, 0);
    expect(await host.collectAssets()).toEqual({ unreferenced: [d], deleted: [] });
  });

  test("delete never removes a listed file outside the table's assets directory", async () => {
    const host = await open();
    await writeFile(join(dir, "shared.png"), png("shared"));
    host.addAsset("shared.png");
    const result = await host.collectAssets({ delete: true });
    expect(result).toEqual({ unreferenced: ["shared.png"], deleted: [] });
    expect(host.assets).toEqual([]);
    expect(await exists(join(dir, "shared.png"))).toBe(true);
  });

  test("a listed file already missing is unlisted and not reported deleted", async () => {
    const host = await open();
    const { map } = await importTwo(host);
    await rm(join(dir, map));
    const result = await host.collectAssets({ delete: true });
    expect(result.unreferenced).toContain(map);
    expect(result.deleted).not.toContain(map);
  });

  test("an import during a paused deletion keeps the re-listed file (the asset queue)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused: () => void = () => undefined;
    const pausedAt = new Promise<void>((r) => {
      paused = r;
    });
    let first = true;
    const host = await TableHost.open(path, {
      createIfMissing: true,
      autosave: false,
      fs: {
        ...nodeFs,
        unlink: async (file) => {
          if (first) {
            first = false;
            paused();
            await gate;
          }
          return nodeFs.unlink(file);
        },
      },
    });
    hosts.push(host);
    const { map, goblin } = await importTwo(host);

    const collecting = host.collectAssets({ delete: true });
    await pausedAt; // the first deletion (map) is in flight; goblin is still a candidate
    const reimport = importAsset(host, { bytes: png("goblin"), filename: "goblin.png" });
    release();
    expect(await collecting).toEqual({ unreferenced: [map, goblin], deleted: [map, goblin] });
    expect((await reimport).path).toBe(goblin);

    expect(host.assets).toEqual([goblin]);
    expect(await exists(join(dir, goblin))).toBe(true);
    expect(await exists(join(dir, map))).toBe(false);
  });

  test("an in-memory table collects the list only", async () => {
    const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
    hosts.push(host);
    host.addAsset("t.assets/a-00000000.png");
    expect(await host.collectAssets({ delete: true })).toEqual({
      unreferenced: ["t.assets/a-00000000.png"],
      deleted: [],
    });
    expect(host.assets).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});
