import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTable, nodeFs, type PersistFs, TableHost } from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, type Frame, RawClient, serve, setHp, until } from "./helpers";

let dir: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-server-")));
});

afterEach(async () => {
  await cleanup();
  for (const h of hosts.splice(0)) await h.close();
  await rm(dir, { recursive: true, force: true });
});

const isCommit = (f: Frame) => f.type === "event" && f.event === "commit";

function setCell(base_revision: number, cell: string, value: number) {
  return {
    base_revision,
    ops: [{ type: "set_value", object: "goblin", cell, value: { type: "number", value } }],
  };
}

/** A file-backed host whose saves can be held at the temp-file open. */
async function gatedHost() {
  const gate: { held: Promise<void> | null; release: () => void } = {
    held: null,
    release: () => undefined,
  };
  const fs: PersistFs = {
    ...nodeFs,
    async open(p, flags) {
      if (flags === "wx" && gate.held) await gate.held;
      return nodeFs.open(p, flags);
    },
  };
  const path = join(dir, "table.json");
  const host = await TableHost.open(path, { createIfMissing: true, autosave: false, fs });
  hosts.push(host);
  const hold = () => {
    gate.held = new Promise<void>((resolve) => {
      gate.release = () => {
        gate.held = null;
        resolve();
      };
    });
  };
  return { host, path, hold, release: () => gate.release() };
}

describe("commit events", () => {
  test("a subscriber receives the delta; the committer gets its event before its response", async () => {
    const { server } = await serve();
    const a = await RawClient.open(server, {
      client: { name: "a", kind: "ui", instance: "a" },
    });
    const b = await RawClient.open(server, {
      client: { name: "b", kind: "test", instance: "b" },
    });
    a.request("sub", "subscribe", { scope: { type: "board", board: "map" } });
    const sub = (await a.response("sub")).result.subscription;
    b.request("t", "transact", setHp(3, 1));
    expect(await b.response("t")).toMatchObject({ ok: true, result: { status: "committed" } });
    const eventB = b.indexOf(isCommit);
    expect(eventB).toBeGreaterThan(-1);
    expect(eventB).toBeLessThan(b.indexOf((f) => f.id === "t"));
    expect(b.frames[eventB]).toMatchObject({ revision: 4, deltas: [] });
    const eventA = await a.next(isCommit);
    expect(eventA).toMatchObject({
      revision: 4,
      group: { index: 0, revision: 4, actor: { type: "gm" }, kind: "edit" },
      deltas: [{ subscription: sub, removed: [] }],
    });
    expect(eventA.deltas[0].objects.map((o: Frame) => o.id)).toEqual(["goblin"]);
    expect(eventA.deltas[0].objects[0].cells.hp.value).toEqual({ type: "number", value: 1 });
  });

  test("interleaved transacts from two clients commit in one order both see", async () => {
    const { server } = await serve();
    const a = await RawClient.open(server, { client: { name: "a", kind: "test", instance: "a" } });
    const b = await RawClient.open(server, { client: { name: "b", kind: "test", instance: "b" } });
    for (let i = 0; i < 5; i++) {
      a.request(`a${i}`, "transact", setCell(3, `a${i}`, i));
      b.request(`b${i}`, "transact", setCell(3, `b${i}`, i));
    }
    await until(
      () => a.frames.filter(isCommit).length === 10 && b.frames.filter(isCommit).length === 10,
    );
    const seenA = a.frames.filter(isCommit).map((f) => [f.revision, f.group.index]);
    const seenB = b.frames.filter(isCommit).map((f) => [f.revision, f.group.index]);
    expect(seenA).toEqual(seenB);
    expect(seenA.map(([r]) => r)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    for (const [client, prefix] of [
      [a, "a"],
      [b, "b"],
    ] as const) {
      for (let i = 0; i < 5; i++) {
        const res = await client.response(`${prefix}${i}`);
        expect(res.result.status).toBe("committed");
        const event = client.indexOf((f) => isCommit(f) && f.revision === res.result.revision);
        expect(event).toBeLessThan(client.indexOf((f) => f.id === `${prefix}${i}`));
      }
    }
  });
});

describe("save ordering", () => {
  test("save writes the file and broadcasts a save event before its response", async () => {
    const { host, path } = await gatedHost();
    const { server } = await serve({ host });
    const a = await RawClient.open(server, { client: { name: "a", kind: "test", instance: "a" } });
    const b = await RawClient.open(server, { client: { name: "b", kind: "test", instance: "b" } });
    a.request("t", "transact", {
      base_revision: 0,
      ops: [{ type: "add_board", id: "map", name: "Map" }],
    });
    await a.response("t");
    a.request("s", "save");
    expect(await a.response("s")).toMatchObject({
      ok: true,
      result: { status: "saved", revision: 1 },
    });
    const isSave = (f: Frame) => f.type === "event" && f.event === "save";
    expect(a.indexOf(isSave)).toBeLessThan(a.indexOf((f) => f.id === "s"));
    expect(await b.next(isSave)).toEqual({
      type: "event",
      event: "save",
      status: "saved",
      revision: 1,
    });
    const loaded = await loadTable(path);
    expect(loaded.store.revision).toBe(1);
    expect(loaded.store.getBoard("map")).toBeDefined();
  });

  test("A's transact waits for A's save; B commits meanwhile", async () => {
    const { host, hold, release } = await gatedHost();
    const { server } = await serve({ host });
    const a = await RawClient.open(server, { client: { name: "a", kind: "test", instance: "a" } });
    const b = await RawClient.open(server, { client: { name: "b", kind: "test", instance: "b" } });
    a.request("t0", "transact", { base_revision: 0, ops: [{ type: "add_board", id: "first" }] });
    await a.response("t0");
    hold();
    a.request("s", "save");
    a.request("ta", "transact", {
      base_revision: 1,
      ops: [{ type: "add_board", id: "a_board" }],
    });
    // Let A's frames arrive before B's.
    await new Promise((r) => setTimeout(r, 30));
    b.request("tb", "transact", {
      base_revision: 1,
      ops: [{ type: "add_board", id: "b_board" }],
    });
    expect(await b.response("tb")).toMatchObject({
      ok: true,
      result: { status: "committed", revision: 2 },
    });
    expect(a.indexOf((f) => f.id === "s")).toBe(-1);
    expect(a.indexOf((f) => f.id === "ta")).toBe(-1);
    // A still receives B's commit event while its save is pending.
    expect(await a.next(isCommitAt(2))).toBeDefined();
    release();
    const ta = await a.response("ta");
    expect(ta).toMatchObject({ ok: true, result: { status: "committed", revision: 3 } });
    const s = a.indexOf((f) => f.id === "s");
    expect(s).toBeGreaterThan(-1);
    expect(a.frames[s]).toMatchObject({ ok: true, result: { status: "saved", revision: 1 } });
    expect(s).toBeLessThan(a.indexOf((f) => f.id === "ta"));
  });
});

const isCommitAt = (revision: number) => (f: Frame) => isCommit(f) && f.revision === revision;
