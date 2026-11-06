/**
 * Save-time compaction reaches log subscribers (vtt-qf5.71; DESIGN.md §7
 * Persistence, M6-D33, M6-D42; PROTOCOL.md §8): a save that drops groups
 * carries the new `first_index` and every connection's refreshed `log`
 * windows as deltas, with no commit.
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentStore, TableHost } from "@vtt/authority";
import { type CommitEvent, type SaveEvent, SaveEventSchema } from "@vtt/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scene, setHp, textOf } from "../persist/helpers";
import { cleanup, connect, type Frame, RawClient, serve, until } from "./helpers";

let dir: string;
let path: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-compaction-notify-")));
  path = join(dir, "table.json");
  // Six retained groups, indices 0..5.
  const store = DocumentStore.fromSnapshot(scene());
  for (let i = 0; i < 6; i++) setHp(store, i);
  await writeFile(path, textOf(store));
});

afterEach(async () => {
  await cleanup();
  for (const host of hosts.splice(0)) await host.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(opts: Parameters<typeof TableHost.open>[1] = {}): Promise<TableHost> {
  const host = await TableHost.open(path, { autosave: false, ...opts });
  hosts.push(host);
  return host;
}

const hpOp = (value: number) => ({
  type: "set_value" as const,
  object: "goblin",
  cell: "hp",
  value: { type: "number" as const, value },
});

describe("save-time compaction and log subscriptions", () => {
  test("an autosave with keepLast shrinks an open log window with no further commit", async () => {
    const host = await open({
      compaction: { keepLast: 3 },
      autosave: { debounceMs: 20, maxDelayMs: 200, retryMs: [] },
    });
    const { server } = await serve({ host });
    const client = await connect(server);
    const commits: CommitEvent[] = [];
    const saves: SaveEvent[] = [];
    client.on("commit", (e) => commits.push(e));
    client.on("save", (e) => saves.push(e));
    const gm = await client.subscribe({ scope: { type: "log" } });
    const objects = await client.subscribe({ scope: { type: "all" } });
    expect([...gm.mirror.groups.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);

    // One commit schedules the autosave; nothing is committed after it.
    const result = await client.transact([hpOp(42)], { label: "hp 42" });
    expect(result.status).toBe("committed");
    expect(gm.mirror.groups.size).toBe(7);

    await until(() => saves.length > 0, 3000, "the autosave");
    expect(commits).toHaveLength(1);
    const save = saves[0] as SaveEvent;
    expect(save).toMatchObject({ status: "saved", revision: 7, first_index: 4 });
    expect(save.deltas).toEqual([
      { subscription: gm.id, objects: [], removed: [], groups_removed: [0, 1, 2, 3] },
    ]);
    // The mirror shrank to the retained groups, at the unchanged revision.
    expect([...gm.mirror.groups.keys()].sort((a, b) => a - b)).toEqual([4, 5, 6]);
    expect(gm.mirror.revision).toBe(7);
    expect(objects.mirror.revision).toBe(7);
    // It equals a fresh subscribe.
    const fresh = await client.subscribe({ scope: { type: "log" } });
    expect(fresh.mirror.groupsNewestFirst()).toEqual(gm.mirror.groupsNewestFirst());
    expect(host.table.store.history.firstIndex).toBe(4);
  });

  test("each connection gets its own changed windows; a save that drops nothing carries neither field", async () => {
    const host = await open({ compaction: { keepLast: 2 } });
    const { server } = await serve({ host });
    const a = await RawClient.open(server, { client: { name: "a", kind: "test", instance: "a" } });
    const b = await RawClient.open(server, { client: { name: "b", kind: "test", instance: "b" } });
    a.request("s1", "subscribe", { scope: { type: "log" } });
    a.request("s2", "subscribe", {
      scope: { type: "log" },
      viewer: { type: "character", id: "goblin" },
    });
    const sub1 = (await a.response("s1")).result.subscription;
    // The goblin's viewer sees none of the hidden hp writes: an empty window.
    expect((await a.response("s2")).result.groups).toEqual([]);

    b.request("save", "save");
    await b.response("save");
    const isSave = (f: Frame) => f.type === "event" && f.event === "save";
    const forA = await a.next(isSave);
    const forB = await b.next(isSave);
    SaveEventSchema.parse(forA);
    expect(forA.first_index).toBe(4);
    // Only the subscription whose window changed has an entry.
    expect(forA.deltas.map((d: Frame) => d.subscription)).toEqual([sub1]);
    expect(forA.deltas[0].groups_removed).toEqual([0, 1, 2, 3]);
    expect(forB).toEqual({
      type: "event",
      event: "save",
      status: "saved",
      revision: 6,
      first_index: 4,
      deltas: [],
    });

    // Nothing more to drop: a plain save event.
    b.request("again", "save");
    await b.response("again");
    await until(() => a.frames.filter(isSave).length === 2, 3000, "the second save event");
    expect(a.frames.filter(isSave)[1]).toEqual({
      type: "event",
      event: "save",
      status: "saved",
      revision: 6,
    });
  });
});
