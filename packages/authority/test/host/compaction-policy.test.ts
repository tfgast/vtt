/**
 * The save-time compaction policy (vtt-qf5.6; DESIGN.md §7 Persistence,
 * M6-D33): `compaction: {keepLast}` on TableHost compacts the log through
 * `compactLog` at every save, before the file is written.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changesSince,
  DocumentStore,
  loadTable,
  type SaveEvent,
  TableHost,
  undo,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gm, scene, setHp, textOf } from "../persist/helpers";

let dir: string;
let path: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-compaction-")));
  path = join(dir, "table.json");
  await writeFile(path, textOf(DocumentStore.fromSnapshot(scene())));
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(opts: Parameters<typeof TableHost.open>[1] = {}): Promise<TableHost> {
  const host = await TableHost.open(path, { autosave: false, ...opts });
  hosts.push(host);
  return host;
}

const fileLog = async () => (await loadTable(path)).store.history.toLog();

describe("TableHost compaction policy", () => {
  test("keepLast 3: a save keeps the last 3 groups with their indices; undo below is nothing_to_undo; changes_since is truncated", async () => {
    const host = await open({ compaction: { keepLast: 3 } });
    for (let i = 0; i < 8; i++) setHp(host.table.store, 20 + i);
    expect(host.table.store.history.groups()).toHaveLength(8);

    expect((await host.save()).status).toBe("saved");

    const log = await fileLog();
    expect(log.first_index).toBe(5);
    expect(log.groups.map((g) => g.index)).toEqual([5, 6, 7]);
    expect(log.undo_barrier).toBe(5);
    // The in-memory history is the file's.
    expect(host.table.store.history.toLog()).toEqual(log);

    expect(undo(host.table.store, gm, { type: "group", index: 3 })).toMatchObject({
      ok: false,
      rejection: { type: "nothing_to_undo" },
    });

    const result = changesSince(host.table, { revision: 1 });
    expect(result).toMatchObject({ revision: 8, floor: 5, truncated: true });
    expect(result.groups.map((g) => g.revision)).toEqual([6, 7, 8]);
    expect(changesSince(host.table, { revision: 5 }).truncated).toBe(false);

    // Undo inside the kept range still works, and indices continue.
    expect(undo(host.table.store, gm, { type: "group", index: 7 }).ok).toBe(true);
    expect(host.table.store.history.nextIndex).toBe(9);
  });

  test("an oversized existing log is compacted by save() and by close() with no new commit", async () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (let i = 0; i < 6; i++) setHp(store, i);
    await writeFile(path, textOf(store));

    const host = await open({ compaction: { keepLast: 2 } });
    expect((await host.save()).status).toBe("saved");
    expect(await fileLog()).toMatchObject({ first_index: 4, undo_barrier: 4 });
    expect((await fileLog()).groups.map((g) => g.index)).toEqual([4, 5]);
    // Nothing left to drop: a second save writes nothing new and stays saved.
    expect((await host.save()).status).toBe("saved");
    await host.close();
    hosts.splice(0);

    const viaClose = await open({ compaction: { keepLast: 1 } });
    expect(await viaClose.close()).toEqual({ saved: true, revision: 6 });
    hosts.splice(0);
    expect((await fileLog()).groups.map((g) => g.index)).toEqual([5]);
  });

  test("a reopened compacted file keeps the floor and the barrier", async () => {
    const host = await open({ compaction: { keepLast: 2 } });
    for (let i = 0; i < 5; i++) setHp(host.table.store, i);
    await host.close();
    hosts.splice(0);
    const reopened = await open();
    expect(reopened.table.store.history.toLog()).toMatchObject({
      first_index: 3,
      undo_barrier: 3,
    });
    expect(reopened.table.store.history.groups().map((g) => g.index)).toEqual([3, 4]);
    expect(changesSince(reopened.table, { revision: 0 }).truncated).toBe(true);
  });

  test("the close save compacts too", async () => {
    const host = await open({ compaction: { keepLast: 1 } });
    for (let i = 0; i < 4; i++) setHp(host.table.store, i);
    expect((await host.close()).saved).toBe(true);
    hosts.splice(0);
    expect((await fileLog()).groups.map((g) => g.index)).toEqual([3]);
  });

  test("autosave compacts", async () => {
    const host = await open({
      compaction: { keepLast: 2 },
      autosave: { debounceMs: 0, maxDelayMs: 0, retryMs: [] },
    });
    const saved = new Promise<SaveEvent>((resolve) => host.onSave(resolve));
    for (let i = 0; i < 5; i++) setHp(host.table.store, i);
    expect((await saved).status).toBe("saved");
    expect((await fileLog()).groups.map((g) => g.index)).toEqual([3, 4]);
  });

  test("never raises a higher barrier back down", async () => {
    const host = await open({ compaction: { keepLast: 3 } });
    for (let i = 0; i < 6; i++) setHp(host.table.store, i);
    host.table.store.history.raiseBarrier(5);
    await host.save();
    expect(await fileLog()).toMatchObject({ first_index: 3, undo_barrier: 5 });
  });

  test("keepLast 0 empties the log at the next index", async () => {
    const host = await open({ compaction: { keepLast: 0 } });
    for (let i = 0; i < 3; i++) setHp(host.table.store, i);
    await host.save();
    expect(await fileLog()).toEqual({ first_index: 3, groups: [], undo_barrier: 3 });
    expect(changesSince(host.table, { revision: 2 })).toMatchObject({ floor: 3, truncated: true });
  });

  test.each([
    ["the default", {}],
    ['"never"', { compaction: "never" as const }],
  ])("%s never compacts", async (_name, opts) => {
    const host = await open(opts);
    for (let i = 0; i < 8; i++) setHp(host.table.store, i);
    await host.save();
    const log = await fileLog();
    expect(log.first_index).toBe(0);
    expect(log.groups).toHaveLength(8);
    expect(host.compaction).toBe("never");
  });

  test.each([-1, 1.5, Number.NaN])(
    "keepLast %s is refused at open and leaves no lock",
    async (n) => {
      await expect(open({ compaction: { keepLast: n } })).rejects.toThrow(/keepLast/);
      expect(await readFile(`${path}.lock`).catch(() => null)).toBeNull();
    },
  );

  test("the policy is readable on the host", async () => {
    const host = await open({ compaction: { keepLast: 4 } });
    expect(host.compaction).toEqual({ keepLast: 4 });
  });
});
