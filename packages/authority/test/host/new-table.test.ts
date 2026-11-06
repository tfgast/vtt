import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GM_BOARD_ID, loadTable, newTableSnapshot, TableHost } from "@vtt/authority";
import { validateSnapshot } from "@vtt/schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let dir: string;
let path: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-new-table-")));
  path = join(dir, "table.json");
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe("newTableSnapshot", () => {
  test("one board gm_board named GM, no objects, revision 0", () => {
    expect(GM_BOARD_ID).toBe("gm_board");
    const snapshot = newTableSnapshot();
    expect(snapshot).toEqual({
      revision: 0,
      next_seq: 1,
      boards: [{ id: "gm_board", name: "GM" }],
      objects: {},
      retired_ids: [],
    });
    expect(validateSnapshot(snapshot)).toEqual([]);
  });

  test("each call returns a fresh value", () => {
    const a = newTableSnapshot();
    a.boards.push({ id: "other" });
    expect(newTableSnapshot().boards).toEqual([{ id: "gm_board", name: "GM" }]);
  });
});

describe("TableHost.open on a missing file", () => {
  test("createIfMissing writes a loadable file with the GM board", async () => {
    const host = await TableHost.open(path, { createIfMissing: true, autosave: false });
    hosts.push(host);
    expect(host.path).toBe(path);
    expect(host.revision).toBe(0);
    expect(host.lastSavedRevision).toBe(0);
    expect(host.assets).toEqual([]);
    expect(host.warnings).toEqual([]);
    expect(host.table.store.toSnapshot()).toEqual(newTableSnapshot());

    const loaded = await loadTable(path);
    expect(loaded.store.toSnapshot()).toEqual(newTableSnapshot());
    expect(loaded.store.history.toLog()).toEqual({ first_index: 0, groups: [], undo_barrier: 0 });
    expect(loaded.assets).toEqual([]);
    expect(loaded.editedExternally).toBe(false);
  });

  test("without createIfMissing it rejects naming the path and leaves no files", async () => {
    await expect(TableHost.open(path, { autosave: false })).rejects.toThrow(path);
    expect(await readdir(dir)).not.toContain("table.json");
    expect(await readdir(dir)).not.toContain("table.json.lock");
  });

  test("createIfMissing through a dangling symlink creates the target and keeps the link", async () => {
    const alias = join(dir, "alias.json");
    await symlink("table.json", alias);
    const host = await TableHost.open(alias, { createIfMissing: true, autosave: false });
    hosts.push(host);
    expect(host.path).toBe(path);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readlink(alias)).toBe("table.json");
    expect(await realpath(alias)).toBe(path);
    expect((await loadTable(alias)).store.toSnapshot()).toEqual(newTableSnapshot());
    expect(await readdir(dir)).toContain("table.json.lock");
    expect(await readdir(dir)).not.toContain("alias.json.lock");
  });

  test("createIfMissing follows a directory link in the target before its `..`", async () => {
    const real = join(dir, "real");
    await mkdir(join(real, "sub"), { recursive: true });
    await symlink(join("real", "sub"), join(dir, "dirlink"));
    const alias = join(dir, "alias.json");
    await symlink("dirlink/../target.json", alias);
    const host = await TableHost.open(alias, { createIfMissing: true, autosave: false });
    hosts.push(host);
    expect(host.path).toBe(join(real, "target.json"));
    expect(await realpath(alias)).toBe(join(real, "target.json"));
    expect(await readdir(dir)).not.toContain("target.json");
    expect((await loadTable(alias)).store.toSnapshot()).toEqual(newTableSnapshot());
  });

  test("createIfMissing through a dangling symlink into a missing directory refuses", async () => {
    const alias = join(dir, "alias.json");
    await symlink(join(dir, "nope", "table.json"), alias);
    await expect(TableHost.open(alias, { createIfMissing: true, autosave: false })).rejects.toThrow(
      `table directory ${join(dir, "nope")} (target of symlink ${alias})`,
    );
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(["alias.json"]);
  });
});
