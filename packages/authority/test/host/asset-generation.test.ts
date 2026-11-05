/**
 * Asset bookkeeping in the table host's save queue (DESIGN.md §7, Autosave;
 * Revisions and assets: "an imported path is listed in the file's assets
 * from the next save"; PROTOCOL.md §1, POST /assets). Dirty state is the
 * pair (revision, assetsGeneration).
 */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocumentStore,
  type FileHandleLike,
  InvalidAssetPathError,
  loadTable,
  nodeFs,
  type PersistFs,
  type SaveEvent,
  saveTable,
  TableHost,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scene, setHp } from "../persist/helpers";

let dir: string;
let path: string;
let host: TableHost;
let ctl: ReturnType<typeof controlledFs>;
let events: SaveEvent[];
let t0: number;

const fault = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

type Fault = "before_replace" | "after_replace";

/**
 * nodeFs that records when each save starts and the text it wrote, fails
 * saves as planned, and can hold a save's write until a gate opens.
 */
function controlledFs() {
  let current: Fault | undefined;
  const ctl = {
    /** Fake-clock times, relative to t0, at which saves started. */
    starts: [] as number[],
    /** The text each save wrote to its temp file, in order. */
    written: [] as string[],
    /** Faults for the next saves, in order; undefined succeeds. */
    plan: [] as (Fault | undefined)[],
    gate: null as Promise<void> | null,
    fs: {
      ...nodeFs,
      async open(p, flags) {
        if (flags === "wx") {
          ctl.starts.push(Date.now() - t0);
          current = ctl.plan.shift();
          if (current === "before_replace") throw fault("ENOSPC");
          if (ctl.gate) await ctl.gate;
          const handle = await nodeFs.open(p, flags);
          const recording: FileHandleLike = {
            writeFile: (data, enc) => {
              ctl.written.push(String(data));
              return handle.writeFile(data, enc);
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
          return recording;
        }
        const handle = await nodeFs.open(p, flags);
        if (current !== "after_replace") return handle;
        const failing: FileHandleLike = {
          writeFile: (data, enc) => handle.writeFile(data, enc),
          sync: async () => {
            throw fault("EIO");
          },
          close: () => handle.close(),
        };
        return failing;
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

/** Resolves once `n` save events have been emitted in total. */
function untilEvents(n: number): Promise<SaveEvent[]> {
  return new Promise((resolve) => {
    if (events.length >= n) return resolve(events);
    const off = host.onSave(() => {
      if (events.length >= n) {
        off();
        resolve(events);
      }
    });
  });
}

/** Advances the fake clock to `t` ms after t0. */
const advanceTo = (t: number) => vi.advanceTimersByTimeAsync(t - (Date.now() - t0));

const assetsIn = (text: string | undefined): unknown =>
  (JSON.parse(text ?? "null") as { assets?: unknown } | null)?.assets;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-asset-gen-")));
  path = join(dir, "table.json");
  expect(await saveTable(path, DocumentStore.fromSnapshot(scene()), ["a.png"])).toEqual({
    ok: true,
  });
  ctl = controlledFs();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  host = await TableHost.open(path, { fs: ctl.fs });
  events = [];
  host.onSave((e) => events.push(e));
  t0 = Date.now();
});

afterEach(async () => {
  vi.useRealTimers();
  ctl.gate = null;
  ctl.plan = [];
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe("addAsset", () => {
  test("the generation starts at 0 and the list is the file's", () => {
    expect(host.assetsGeneration).toBe(0);
    expect(host.assets).toEqual(["a.png"]);
  });

  test("a new path is appended and bumps the generation; a known path does not", () => {
    host.addAsset("table.assets/map-0123abcd.png");
    expect(host.assetsGeneration).toBe(1);
    expect(host.assets).toEqual(["a.png", "table.assets/map-0123abcd.png"]);
    host.addAsset("table.assets/map-0123abcd.png");
    host.addAsset("a.png");
    expect(host.assetsGeneration).toBe(1);
    expect(host.assets).toEqual(["a.png", "table.assets/map-0123abcd.png"]);
  });

  test("the list returned earlier is not changed by a later addAsset", () => {
    const before = host.assets;
    host.addAsset("b.png");
    expect(before).toEqual(["a.png"]);
    expect(Object.isFrozen(host.assets)).toBe(true);
  });

  test("a known path schedules no save", async () => {
    host.addAsset("a.png");
    await advanceTo(60000);
    expect(ctl.starts).toEqual([]);
  });

  test("an absolute or empty path throws and changes nothing", async () => {
    for (const bad of ["/abs/x.png", "\\x.png", "C:x.png", ""]) {
      expect(() => host.addAsset(bad)).toThrow(InvalidAssetPathError);
    }
    expect(host.assetsGeneration).toBe(0);
    expect(host.assets).toEqual(["a.png"]);
    await advanceTo(60000);
    expect(ctl.starts).toEqual([]);
  });
});

describe("save()", () => {
  test("on an already-saved table, addAsset with no commit then save() writes a file listing it", async () => {
    expect(host.lastSavedRevision).toBe(host.revision);
    host.addAsset("b.png");
    const result = await host.save();
    expect(result).toEqual({ status: "saved", revision: 0 });
    expect(ctl.starts).toEqual([0]);
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
    expect(await host.save()).toEqual({ status: "saved", revision: 0 });
    expect(ctl.starts).toEqual([0]);
  });

  test("an addAsset while a delayed save is in flight gets a second save; the first file does not list it", async () => {
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(host.table.store, 6);
    const first = host.save();
    expect(ctl.starts).toEqual([0]);
    host.addAsset("b.png");
    const second = host.save();
    ctl.gate = null;
    gate.resolve();
    expect(await first).toEqual({ status: "saved", revision: 1 });
    expect(await second).toEqual({ status: "saved", revision: 1 });
    expect(ctl.starts).toEqual([0, 0]);
    expect(assetsIn(ctl.written[0])).toEqual(["a.png"]);
    expect(assetsIn(ctl.written[1])).toEqual(["a.png", "b.png"]);
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
  });

  test("an addAsset during an in-flight autosave leaves the host dirty and is followed by a save", async () => {
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(host.table.store, 6);
    await advanceTo(2000);
    expect(ctl.starts).toEqual([2000]);
    host.addAsset("b.png");
    ctl.gate = null;
    gate.resolve();
    expect(await untilEvents(1)).toEqual([{ status: "saved", revision: 1 }]);
    expect(assetsIn(ctl.written[0])).toEqual(["a.png"]);
    await advanceTo(4000);
    expect(ctl.starts).toEqual([2000, 4000]);
    expect((await untilEvents(2))[1]).toEqual({ status: "saved", revision: 1 });
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
    await advanceTo(60000);
    expect(ctl.starts).toEqual([2000, 4000]);
  });
});

describe("autosave", () => {
  test("addAsset alone triggers the autosave after the debounce", async () => {
    host.addAsset("b.png");
    await advanceTo(1999);
    expect(ctl.starts).toEqual([]);
    await advanceTo(2000);
    expect(ctl.starts).toEqual([2000]);
    expect(await untilEvents(1)).toEqual([{ status: "saved", revision: 0 }]);
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
    await advanceTo(60000);
    expect(ctl.starts).toEqual([2000]);
  });

  test("imports every second save at the max delay", async () => {
    for (let t = 0; t < 10000; t += 1000) {
      await advanceTo(t);
      host.addAsset(`img-${t}.png`);
    }
    await advanceTo(9999);
    expect(ctl.starts).toEqual([]);
    await advanceTo(10000);
    expect(ctl.starts).toEqual([10000]);
    await untilEvents(1);
    expect((await loadTable(path)).assets).toHaveLength(11);
  });

  test("a save that ends saved_not_durable after addAsset leaves the pair unsaved and is retried", async () => {
    ctl.plan = ["after_replace"];
    host.addAsset("b.png");
    await advanceTo(2000);
    const [event] = await untilEvents(1);
    expect(event).toMatchObject({ status: "saved_not_durable", revision: 0 });
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
    // Still dirty: an explicit save() writes again rather than sharing a result.
    await advanceTo(3000);
    expect(ctl.starts).toEqual([2000, 3000]);
    expect((await untilEvents(2))[1]).toEqual({ status: "saved", revision: 0 });
    expect(await host.save()).toEqual({ status: "saved", revision: 0 });
    expect(ctl.starts).toEqual([2000, 3000]);
  });

  test("after saved_not_durable, save() writes again", async () => {
    ctl.plan = ["after_replace"];
    host.addAsset("b.png");
    expect(await host.save()).toMatchObject({ status: "saved_not_durable", revision: 0 });
    expect(await host.save()).toEqual({ status: "saved", revision: 0 });
    expect(ctl.starts).toEqual([0, 0]);
  });

  test("a failed save after addAsset is retried until the asset is saved", async () => {
    ctl.plan = ["before_replace"];
    host.addAsset("b.png");
    await advanceTo(2000);
    expect((await untilEvents(1))[0]).toMatchObject({ status: "failed", revision: 0 });
    expect((await loadTable(path)).assets).toEqual(["a.png"]);
    await advanceTo(3000);
    expect((await untilEvents(2))[1]).toEqual({ status: "saved", revision: 0 });
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
  });
});

describe("close()", () => {
  test("close() right after addAsset saves, and the reopened file lists it", async () => {
    host.addAsset("b.png");
    vi.useRealTimers();
    expect(await host.close()).toEqual({ saved: true, revision: 0 });
    expect(ctl.starts).toHaveLength(1);
    host = await TableHost.open(path, { autosave: false });
    expect(host.assets).toEqual(["a.png", "b.png"]);
    expect(host.assetsGeneration).toBe(0);
  });

  test("close() with nothing new writes nothing", async () => {
    host.addAsset("a.png");
    vi.useRealTimers();
    expect(await host.close()).toEqual({ saved: true, revision: 0 });
    expect(ctl.starts).toEqual([]);
  });

  test("close() waits for an in-flight save and then saves an asset added meanwhile", async () => {
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(host.table.store, 6);
    void host.save();
    host.addAsset("b.png");
    const closing = host.close();
    ctl.gate = null;
    gate.resolve();
    vi.useRealTimers();
    expect(await closing).toEqual({ saved: true, revision: 1 });
    expect(assetsIn(ctl.written[0])).toEqual(["a.png"]);
    expect(assetsIn(ctl.written[1])).toEqual(["a.png", "b.png"]);
    expect(await readFile(path, "utf8")).toBe(ctl.written[1]);
  });

  test("an asset added after the final save of close() is reported unsaved", async () => {
    const gate = deferred();
    ctl.gate = gate.promise;
    host.addAsset("b.png");
    const closing = host.close();
    await vi.advanceTimersByTimeAsync(0);
    host.addAsset("c.png");
    ctl.gate = null;
    gate.resolve();
    vi.useRealTimers();
    const result = await closing;
    expect(result.saved).toBe(false);
    expect(result.error).toMatch(/asset/);
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
  });
});
