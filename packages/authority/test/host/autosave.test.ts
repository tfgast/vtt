import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTOSAVE,
  DocumentStore,
  type FileHandleLike,
  loadTable,
  nodeFs,
  type PersistFs,
  type SaveEvent,
  saveTable,
  TableHost,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scene, setHp, textOf } from "../persist/helpers";

let dir: string;
let path: string;
let host: TableHost;
let ctl: ReturnType<typeof controlledFs>;
let events: SaveEvent[];
let t0: number;

const fault = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

type Fault = "before_replace" | "after_replace";

/**
 * nodeFs that records when each save starts (the temp file's exclusive
 * open, which saveTable makes in the tick it is called), fails saves as
 * planned, and can hold a save's write until a gate opens.
 */
function controlledFs() {
  let current: Fault | undefined;
  const ctl = {
    /** Fake-clock times, relative to t0, at which saves started. */
    starts: [] as number[],
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
          return nodeFs.open(p, flags);
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

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-autosave-")));
  path = join(dir, "table.json");
  expect(await saveTable(path, DocumentStore.fromSnapshot(scene()), ["a.png", "b.png"])).toEqual({
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

test("the defaults are 2 s, 10 s and 1 s, 5 s, 30 s, 60 s", () => {
  expect(DEFAULT_AUTOSAVE).toEqual({
    debounceMs: 2000,
    maxDelayMs: 10000,
    retryMs: [1000, 5000, 30000, 60000],
  });
});

describe("cadence", () => {
  test("three commits 500 ms apart produce one save 2 s after the last", async () => {
    setHp(host.table.store, 6);
    await advanceTo(500);
    setHp(host.table.store, 5);
    await advanceTo(1000);
    setHp(host.table.store, 4);
    await advanceTo(2999);
    expect(ctl.starts).toEqual([]);
    await advanceTo(3000);
    expect(ctl.starts).toEqual([3000]);
    expect(await untilEvents(1)).toEqual([{ status: "saved", revision: 3 }]);
    expect(host.lastSavedRevision).toBe(3);
    await advanceTo(60000);
    expect(ctl.starts).toEqual([3000]);
  });

  test("commits every second produce a save at 10 s", async () => {
    for (let t = 0; t < 10000; t += 1000) {
      await advanceTo(t);
      setHp(host.table.store, t / 1000);
    }
    await advanceTo(9999);
    expect(ctl.starts).toEqual([]);
    await advanceTo(10000);
    expect(ctl.starts).toEqual([10000]);
    expect(await untilEvents(1)).toEqual([{ status: "saved", revision: 10 }]);
  });

  test("save() saves immediately and cancels the pending save", async () => {
    setHp(host.table.store, 6);
    await advanceTo(500);
    const result = await host.save();
    expect(result).toEqual({ status: "saved", revision: 1 });
    expect(ctl.starts).toEqual([500]);
    await advanceTo(30000);
    expect(ctl.starts).toEqual([500]);
    expect(events).toEqual([result]);
  });

  test("no commits, no saves", async () => {
    await advanceTo(120000);
    expect(ctl.starts).toEqual([]);
  });

  test("autosave: false never saves on its own", async () => {
    await host.close();
    host = await TableHost.open(path, { fs: ctl.fs, autosave: false });
    t0 = Date.now();
    setHp(host.table.store, 6);
    await advanceTo(120000);
    expect(ctl.starts).toEqual([]);
  });

  test("custom timings", async () => {
    await host.close();
    host = await TableHost.open(path, {
      fs: ctl.fs,
      autosave: { debounceMs: 100, maxDelayMs: 300, retryMs: [50] },
    });
    events = [];
    host.onSave((e) => events.push(e));
    t0 = Date.now();
    setHp(host.table.store, 6);
    await advanceTo(100);
    expect(ctl.starts).toEqual([100]);
    await untilEvents(1);
  });
});

describe("failures and retries", () => {
  test("a before_replace failure emits failed and the next scheduled save succeeds", async () => {
    ctl.plan = ["before_replace"];
    setHp(host.table.store, 6);
    await advanceTo(2000);
    const [failed] = await untilEvents(1);
    expect(failed).toMatchObject({ status: "failed", revision: 1 });
    expect(failed?.message).toMatch(/ENOSPC/);
    expect(host.lastSavedRevision).toBe(0);
    await advanceTo(3000);
    expect(await untilEvents(2)).toEqual([failed, { status: "saved", revision: 1 }]);
    expect(host.lastSavedRevision).toBe(1);
    expect(ctl.starts).toEqual([2000, 3000]);
  });

  test("a failed autosave with no further commits is retried at 1 s, 5 s and 30 s", async () => {
    ctl.plan = ["before_replace", "before_replace", "before_replace"];
    setHp(host.table.store, 6);
    await advanceTo(2000);
    await untilEvents(1);
    await advanceTo(2999);
    expect(ctl.starts).toEqual([2000]);
    await advanceTo(3000);
    await untilEvents(2);
    await advanceTo(7999);
    expect(ctl.starts).toEqual([2000, 3000]);
    await advanceTo(8000);
    await untilEvents(3);
    await advanceTo(37999);
    expect(ctl.starts).toEqual([2000, 3000, 8000]);
    await advanceTo(38000);
    const all = await untilEvents(4);
    expect(all.map((e) => e.status)).toEqual(["failed", "failed", "failed", "saved"]);
    expect(ctl.starts).toEqual([2000, 3000, 8000, 38000]);
    expect(host.lastSavedRevision).toBe(1);
    expect(await readFile(path, "utf8")).toBe(textOf(host.table.store, ["a.png", "b.png"]));
    await advanceTo(200000);
    expect(ctl.starts).toHaveLength(4);
  });

  test("retries repeat the last interval, and a success resets the backoff", async () => {
    ctl.plan = ["before_replace", "before_replace", "before_replace", "before_replace"];
    setHp(host.table.store, 6);
    await advanceTo(2000);
    await untilEvents(1);
    await advanceTo(3000);
    await untilEvents(2);
    await advanceTo(8000);
    await untilEvents(3);
    await advanceTo(38000);
    await untilEvents(4);
    await advanceTo(98000);
    await untilEvents(5);
    expect(ctl.starts).toEqual([2000, 3000, 8000, 38000, 98000]);
    expect(events[4]).toMatchObject({ status: "saved" });

    ctl.plan = ["before_replace"];
    setHp(host.table.store, 5);
    await advanceTo(100000);
    await untilEvents(6);
    await advanceTo(101000);
    await untilEvents(7);
    expect(ctl.starts.slice(5)).toEqual([100000, 101000]);
    expect(events[6]).toEqual({ status: "saved", revision: 2 });
  });

  test("a commit during the backoff does not cancel the retry", async () => {
    ctl.plan = ["before_replace"];
    setHp(host.table.store, 6);
    await advanceTo(2000);
    await untilEvents(1);
    await advanceTo(2500);
    setHp(host.table.store, 5);
    await advanceTo(3000);
    expect(ctl.starts).toEqual([2000, 3000]);
    expect((await untilEvents(2))[1]).toEqual({ status: "saved", revision: 2 });
    await advanceTo(60000);
    expect(ctl.starts).toEqual([2000, 3000]);
  });

  test("the regular schedule runs first when it is earlier than the retry", async () => {
    ctl.plan = ["before_replace", "before_replace", "before_replace"];
    setHp(host.table.store, 6);
    await advanceTo(2000);
    await untilEvents(1);
    await advanceTo(3000);
    await untilEvents(2);
    // The next retry is 5 s after 3000; a commit at 4000 schedules a save at 6000.
    await advanceTo(4000);
    setHp(host.table.store, 5);
    await advanceTo(6000);
    expect(ctl.starts).toEqual([2000, 3000, 6000]);
    await untilEvents(3);
    // That attempt failed too: the backoff continues at 30 s.
    await advanceTo(35999);
    expect(ctl.starts).toEqual([2000, 3000, 6000]);
    await advanceTo(36000);
    expect((await untilEvents(4))[3]).toEqual({ status: "saved", revision: 2 });
  });

  test("an after_replace failure emits saved_not_durable, keeps lastSavedRevision and retries", async () => {
    ctl.plan = ["after_replace"];
    setHp(host.table.store, 6);
    await advanceTo(2000);
    const [event] = await untilEvents(1);
    expect(event).toMatchObject({ status: "saved_not_durable", revision: 1 });
    expect(event?.message).toMatch(/EIO/);
    expect(host.lastSavedRevision).toBe(0);
    expect(await readFile(path, "utf8")).toBe(textOf(host.table.store, ["a.png", "b.png"]));
    await advanceTo(3000);
    expect((await untilEvents(2))[1]).toEqual({ status: "saved", revision: 1 });
    expect(host.lastSavedRevision).toBe(1);
  });
});

describe("ordering", () => {
  test("a commit during a delayed save keeps the captured revision; a second save persists it", async () => {
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(host.table.store, 6);
    await advanceTo(2000);
    expect(ctl.starts).toEqual([2000]);
    setHp(host.table.store, 5);
    ctl.gate = null;
    gate.resolve();
    expect(await untilEvents(1)).toEqual([{ status: "saved", revision: 1 }]);
    expect(host.lastSavedRevision).toBe(1);
    expect(host.revision).toBe(2);
    await advanceTo(4000);
    expect(ctl.starts).toEqual([2000, 4000]);
    expect((await untilEvents(2))[1]).toEqual({ status: "saved", revision: 2 });
    expect(host.lastSavedRevision).toBe(2);
    const loaded = await loadTable(path);
    expect(loaded.store.toSnapshot()).toEqual(host.table.store.toSnapshot());
  });

  test("at most one save is in flight", async () => {
    const gate = deferred();
    ctl.gate = gate.promise;
    setHp(host.table.store, 6);
    await advanceTo(2000);
    setHp(host.table.store, 5);
    const explicit = host.save();
    await advanceTo(20000);
    expect(ctl.starts).toEqual([2000]);
    ctl.gate = null;
    gate.resolve();
    expect(await explicit).toEqual({ status: "saved", revision: 2 });
    expect(ctl.starts).toEqual([2000, 20000]);
  });
});

describe("assets", () => {
  test("a file opened with two assets keeps both after an autosave and after close()", async () => {
    expect(host.assets).toEqual(["a.png", "b.png"]);
    setHp(host.table.store, 6);
    await advanceTo(2000);
    await untilEvents(1);
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
    setHp(host.table.store, 5);
    vi.useRealTimers();
    expect(await host.close()).toEqual({ saved: true, revision: 2 });
    expect((await loadTable(path)).assets).toEqual(["a.png", "b.png"]);
  });
});
