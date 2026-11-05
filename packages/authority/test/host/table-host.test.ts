import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocumentStore,
  loadTable,
  nodeFs,
  type PersistFs,
  RandomDiceSource,
  type SaveEvent,
  saveTable,
  serializeTable,
  TableHost,
  TableIdentityError,
  TableLoadError,
  TableLockedError,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { playedStore, scene, setHp, textOf } from "../persist/helpers";

let dir: string;
let path: string;
let lockPath: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-host-")));
  path = join(dir, "table.json");
  lockPath = `${path}.lock`;
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(p: string, opts: Parameters<typeof TableHost.open>[1] = {}) {
  const host = await TableHost.open(p, { autosave: false, ...opts });
  hosts.push(host);
  return host;
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

const fault = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

/** The pid of a node child that has already exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  if (pid === undefined) throw new Error("no pid");
  return pid;
}

/** A PersistFs whose next save fails before the replacement, and whose writes can be held. */
function controlledFs() {
  const ctl = {
    starts: 0,
    failNext: 0,
    gate: null as Promise<void> | null,
    fs: {
      ...nodeFs,
      async open(p, flags) {
        if (flags === "wx") {
          ctl.starts++;
          if (ctl.failNext > 0) {
            ctl.failNext--;
            throw fault("ENOSPC");
          }
          if (ctl.gate) await ctl.gate;
        }
        return nodeFs.open(p, flags);
      },
    } satisfies PersistFs,
  };
  return ctl;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending I/O callbacks run. */
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

async function writeScene(assets: string[] = []): Promise<void> {
  expect(await saveTable(path, DocumentStore.fromSnapshot(scene()), assets)).toEqual({ ok: true });
}

describe("TableHost.open", () => {
  test("loads an existing file", async () => {
    const store = playedStore();
    expect(await saveTable(path, store, [])).toEqual({ ok: true });
    const host = await open(path);
    expect(host.path).toBe(path);
    expect(host.revision).toBe(store.revision);
    expect(host.lastSavedRevision).toBe(store.revision);
    expect(host.table.store.toSnapshot()).toEqual(store.toSnapshot());
    expect(host.dice).toBeInstanceOf(RandomDiceSource);
    expect(await exists(lockPath)).toBe(true);
  });

  test("uses the given dice source", async () => {
    await writeScene();
    const dice = new RandomDiceSource(7);
    const host = await open(path, { dice });
    expect(host.dice).toBe(dice);
  });

  test("a second open while the first holds the lock throws TableLockedError", async () => {
    await writeScene();
    await open(path);
    const err = await TableHost.open(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TableLockedError);
    expect((err as TableLockedError).stale).toBe(false);
    expect((err as TableLockedError).info?.pid).toBe(process.pid);
  });

  test("an open through a symlink to a locked table throws TableLockedError", async () => {
    await writeScene();
    const host = await open(path);
    const alias = join(dir, "alias.json");
    await symlink(path, alias);
    await expect(TableHost.open(alias)).rejects.toBeInstanceOf(TableLockedError);
    expect(host.path).toBe(path);
  });

  test("the path is the canonical path when opened through a symlink", async () => {
    await writeScene();
    const alias = join(dir, "alias.json");
    await symlink(path, alias);
    const host = await open(alias);
    expect(host.path).toBe(path);
    expect(await exists(lockPath)).toBe(true);
  });

  test("a stale lock is refused with stale: true and left in place", async () => {
    await writeScene();
    const content = JSON.stringify({
      pid: await exitedPid(),
      nonce: "dead",
      host: hostname(),
      started: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(lockPath, content);
    const err = await TableHost.open(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TableLockedError);
    expect((err as TableLockedError).stale).toBe(true);
    expect(await readFile(lockPath, "utf8")).toBe(content);
  });

  test("a malformed .table-id rejects with TableIdentityError and releases the lock", async () => {
    await writeScene();
    await writeFile(`${path}.table-id`, "not a uuid\n");
    await expect(TableHost.open(path)).rejects.toBeInstanceOf(TableIdentityError);
    expect(await exists(lockPath)).toBe(false);
    expect(await readFile(`${path}.table-id`, "utf8")).toBe("not a uuid\n");
  });

  test("a corrupt file rejects and leaves no lock file", async () => {
    await writeFile(path, "{ not json");
    await expect(TableHost.open(path)).rejects.toBeInstanceOf(TableLoadError);
    expect(await exists(lockPath)).toBe(false);
  });

  test("an invalid file rejects and leaves no lock file", async () => {
    await writeFile(path, JSON.stringify({ format: "a-table-of-dumb-objects", schema_version: 1 }));
    await expect(TableHost.open(path)).rejects.toBeInstanceOf(TableLoadError);
    expect(await exists(lockPath)).toBe(false);
  });

  test("an injected initial-save failure rejects and leaves no lock file or table file", async () => {
    const ctl = controlledFs();
    ctl.failNext = 1;
    await expect(TableHost.open(path, { createIfMissing: true, fs: ctl.fs })).rejects.toThrow(
      /ENOSPC/,
    );
    expect(ctl.starts).toBe(1);
    expect(await exists(lockPath)).toBe(false);
    expect(await exists(path)).toBe(false);
  });

  test("tableId is the .table-id content and the same after a reopen", async () => {
    await writeScene();
    const first = await open(path);
    expect(first.tableId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(`${path}.table-id`, "utf8")).toBe(`${first.tableId}\n`);
    await first.close();
    const second = await open(path);
    expect(second.tableId).toBe(first.tableId);
  });

  test("a hand-edited file opens with an editedExternally warning", async () => {
    await writeScene();
    const text = await readFile(path, "utf8");
    expect(text).toContain('"Goblin"');
    await writeFile(path, text.replace('"Goblin"', '"Hobgoblin"'));
    const host = await open(path);
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toMatch(/edited by hand/);
  });

  test("a missing asset is a warning and the asset list is kept", async () => {
    await writeFile(join(dir, "a.png"), "a");
    await writeScene(["a.png", "b.png"]);
    const host = await open(path);
    expect(host.assets).toEqual(["a.png", "b.png"]);
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toMatch(/b\.png/);
  });
});

describe("TableHost.save", () => {
  test("saves the current revision and emits saved", async () => {
    await writeScene();
    const host = await open(path);
    const events: SaveEvent[] = [];
    host.onSave((e) => events.push(e));
    setHp(host.table.store, 3);
    const result = await host.save();
    expect(result).toEqual({ status: "saved", revision: 1 });
    expect(events).toEqual([result]);
    expect(host.lastSavedRevision).toBe(1);
    expect(await readFile(path, "utf8")).toBe(textOf(host.table.store));
  });

  test("a commit in the same tick right after a save starts is not in that save's file", async () => {
    await writeScene();
    const host = await open(path);
    const store = host.table.store;
    setHp(store, 3);
    const expected = textOf(store);
    const pending = host.save();
    setHp(store, 2);
    expect(await pending).toEqual({ status: "saved", revision: 1 });
    expect(await readFile(path, "utf8")).toBe(expected);
    expect(host.lastSavedRevision).toBe(1);
    expect(host.revision).toBe(2);
  });

  test("two overlapping save() calls run one after the other; the file ends with the newer snapshot", async () => {
    await writeScene();
    const ctl = controlledFs();
    const host = await open(path, { fs: ctl.fs });
    const store = host.table.store;
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(store, 3);
    const first = host.save();
    setHp(store, 2);
    const second = host.save();
    await ticks();
    expect(ctl.starts).toBe(1);
    ctl.gate = null;
    gate.resolve();
    expect(await first).toEqual({ status: "saved", revision: 1 });
    expect(await second).toEqual({ status: "saved", revision: 2 });
    expect(ctl.starts).toBe(2);
    expect(await readFile(path, "utf8")).toBe(textOf(store));
    expect(host.lastSavedRevision).toBe(2);
  });

  test("requests for a revision captured by a queued save are coalesced", async () => {
    await writeScene();
    const ctl = controlledFs();
    const host = await open(path, { fs: ctl.fs });
    const store = host.table.store;
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(store, 3);
    const first = host.save();
    setHp(store, 2);
    const second = host.save();
    const third = host.save();
    ctl.gate = null;
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(await third).toEqual({ status: "saved", revision: 2 });
    expect(ctl.starts).toBe(2);
  });

  test("a save with nothing unsaved does not write", async () => {
    await writeScene();
    const ctl = controlledFs();
    const host = await open(path, { fs: ctl.fs });
    expect(await host.save()).toEqual({ status: "saved", revision: 0 });
    expect(ctl.starts).toBe(0);
  });

  test("a failed save reports failed and keeps the revision unsaved", async () => {
    await writeScene();
    const ctl = controlledFs();
    const host = await open(path, { fs: ctl.fs });
    setHp(host.table.store, 3);
    ctl.failNext = 1;
    const result = await host.save();
    expect(result.status).toBe("failed");
    expect(result.revision).toBe(1);
    expect(result.message).toMatch(/ENOSPC/);
    expect(host.lastSavedRevision).toBe(0);
  });

  test("a throwing listener does not break saving", async () => {
    await writeScene();
    const host = await open(path);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    host.onSave(() => {
      throw new Error("listener bug");
    });
    const events: SaveEvent[] = [];
    const off = host.onSave((e) => events.push(e));
    setHp(host.table.store, 3);
    expect(await host.save()).toMatchObject({ status: "saved" });
    off();
    setHp(host.table.store, 2);
    expect(await host.save()).toMatchObject({ status: "saved", revision: 2 });
    expect(events).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

describe("TableHost.close", () => {
  test("with nothing unsaved resolves {saved: true, revision} and removes the lock file", async () => {
    await writeScene();
    const host = await open(path);
    expect(await host.close()).toEqual({ saved: true, revision: 0 });
    expect(await exists(lockPath)).toBe(false);
  });

  test("saves unsaved work", async () => {
    await writeScene();
    const host = await open(path);
    setHp(host.table.store, 3);
    expect(await host.close()).toEqual({ saved: true, revision: 1 });
    expect(await readFile(path, "utf8")).toBe(textOf(host.table.store));
  });

  test("is idempotent", async () => {
    await writeScene();
    const host = await open(path);
    setHp(host.table.store, 3);
    const first = await host.close();
    expect(await host.close()).toBe(first);
  });

  test("during a delayed save awaits it, saves unsaved work, then removes the lock file", async () => {
    await writeScene();
    const ctl = controlledFs();
    const host = await open(path, { fs: ctl.fs });
    const store = host.table.store;
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(store, 3);
    const saving = host.save();
    setHp(store, 2);
    const closing = host.close();
    await ticks();
    expect(await exists(lockPath)).toBe(true);
    expect(ctl.starts).toBe(1);
    ctl.gate = null;
    gate.resolve();
    expect(await saving).toEqual({ status: "saved", revision: 1 });
    expect(await closing).toEqual({ saved: true, revision: 2 });
    expect(ctl.starts).toBe(2);
    expect(await exists(lockPath)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(textOf(store));
  });

  test("whose final save fails resolves {saved: false, revision, error} and removes the lock file", async () => {
    await writeScene();
    const ctl = controlledFs();
    const host = await open(path, { fs: ctl.fs });
    setHp(host.table.store, 3);
    ctl.failNext = 1;
    const result = await host.close();
    expect(result.saved).toBe(false);
    expect(result.revision).toBe(1);
    expect(result.error).toMatch(/ENOSPC/);
    expect(await exists(lockPath)).toBe(false);
  });

  test("save() after close does not write", async () => {
    await writeScene();
    const ctl = controlledFs();
    const host = await open(path, { fs: ctl.fs });
    await host.close();
    setHp(host.table.store, 3);
    expect(await host.save()).toMatchObject({ status: "failed", revision: 1 });
    expect(ctl.starts).toBe(0);
  });

  test("reopening shows the same snapshot and log (indices, barrier)", async () => {
    const store = playedStore();
    store.history.raiseBarrier(2);
    expect(await saveTable(path, store, [])).toEqual({ ok: true });
    const host = await open(path);
    setHp(host.table.store, 1);
    const snapshot = host.table.store.toSnapshot();
    const log = serializeTable(host.table.store, []).log;
    expect(log.undo_barrier).toBe(2);
    expect(await host.close()).toMatchObject({ saved: true });
    const reopened = await open(path);
    expect(reopened.table.store.toSnapshot()).toEqual(snapshot);
    expect(serializeTable(reopened.table.store, []).log).toEqual(log);
    expect(reopened.table.store.history.firstIndex).toBe(0);
  });

  test("a file opened with two assets keeps both after close()", async () => {
    await writeScene(["a.png", "maps/b.png"]);
    const host = await open(path);
    setHp(host.table.store, 3);
    expect(await host.close()).toMatchObject({ saved: true });
    expect((await loadTable(path)).assets).toEqual(["a.png", "maps/b.png"]);
  });
});

describe("TableHost.inMemory", () => {
  test("has no file, no lock and no autosave", async () => {
    const store = DocumentStore.fromSnapshot(scene());
    const host = TableHost.inMemory(store);
    expect(host.path).toBeNull();
    expect(host.tableId).toBeNull();
    expect(host.lastSavedRevision).toBeNull();
    expect(host.assets).toEqual([]);
    expect(host.warnings).toEqual([]);
    expect(host.table.store).toBe(store);
    setHp(store, 3);
    expect(host.revision).toBe(1);
    expect(await host.save()).toEqual({ status: "failed", revision: 1, message: "no file" });
    expect(await host.close()).toEqual({ saved: false, revision: 1, error: "no file" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("uses the given dice source", () => {
    const dice = new RandomDiceSource(1);
    expect(TableHost.inMemory(DocumentStore.fromSnapshot(scene()), { dice }).dice).toBe(dice);
  });
});
