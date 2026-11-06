/**
 * Cell-level patches in commit events (vtt-qf5.4; PROTOCOL.md §2, §8, §12):
 * negotiated by `hello.capabilities: ["cell_patches"]`, echoed in
 * `welcome.capabilities`. A capable connection gets a changed object that it
 * already holds, whose view changed only in `cells`, as a patch naming just
 * those cells; everything else (and every event of a connection without the
 * capability) is unchanged.
 */
import type { Snapshot } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { at, lit, named, obj, table } from "../store/helpers";
import { cleanup, type Frame, memoryHost, RawClient, serve } from "./helpers";

afterEach(cleanup);

const SHEET_CELLS = 200;

/** table() plus `sheet` on `map`, with 200 literal cells s0…s199 nothing reads. */
function bigTable(): Snapshot {
  const doc = table();
  const cells: Record<string, ReturnType<typeof lit>> = {
    name: named("Sheet"),
    position: at(3, 3),
  };
  for (let i = 0; i < SHEET_CELLS; i++) cells[`s${i}`] = lit(i);
  doc.objects.sheet = obj("sheet", { board: "map", cells });
  return doc;
}

const isCommit = (f: Frame) => f.type === "event" && f.event === "commit";

/** A patch-capable and a legacy raw client, each subscribed to board `map`. */
async function pair() {
  const { server } = await serve({ host: memoryHost(bigTable()) });
  const patched = await RawClient.open(server, {
    client: { name: "p", kind: "test", instance: "p" },
    capabilities: ["cell_patches"],
  });
  const legacy = await RawClient.open(server, {
    client: { name: "l", kind: "test", instance: "l" },
  });
  for (const c of [patched, legacy]) {
    c.request("sub", "subscribe", { scope: { type: "board", board: "map" } });
    await c.response("sub");
  }
  let revision = 3;
  let n = 0;
  /** Commits `ops` through the legacy client; returns both clients' commit frames and sizes. */
  const write = async (ops: unknown[]) => {
    const id = `t${n++}`;
    const pBefore = patched.frames.length;
    const lBefore = legacy.frames.length;
    legacy.request(id, "transact", { base_revision: revision, ops });
    const res = await legacy.response(id);
    expect(res).toMatchObject({ ok: true, result: { status: "committed" } });
    revision = res.result.revision;
    await patched.next((f) => isCommit(f) && f.revision === revision);
    const find = (c: RawClient, from: number) =>
      c.frames.findIndex((f, i) => i >= from && isCommit(f) && f.revision === revision);
    const pi = find(patched, pBefore);
    const li = find(legacy, lBefore);
    return {
      p: patched.frames[pi] as Frame,
      l: legacy.frames[li] as Frame,
      pSize: patched.sizes[pi] as number,
      lSize: legacy.sizes[li] as number,
    };
  };
  return { server, patched, legacy, write };
}

const set = (object: string, cell: string, value: number) => ({
  type: "set_value",
  object,
  cell,
  value: { type: "number", value },
});

describe("negotiation", () => {
  test("welcome echoes the accepted capabilities and drops unknown ones", async () => {
    const { server } = await serve();
    const a = await RawClient.open(server, { capabilities: ["future_thing", "cell_patches"] });
    expect(a.frames.find((f) => f.type === "welcome").capabilities).toEqual(["cell_patches"]);
    const b = await RawClient.open(server, {
      client: { name: "b", kind: "test", instance: "b" },
      capabilities: ["future_thing"],
    });
    expect(b.frames.find((f) => f.type === "welcome").capabilities).toEqual([]);
  });

  test("a hello without capabilities gets a welcome without them", async () => {
    const { server } = await serve();
    const a = await RawClient.open(server);
    expect(a.frames.find((f) => f.type === "welcome")).not.toHaveProperty("capabilities");
  });
});

describe("patch deltas", () => {
  test("a one-cell change on a 200-cell sheet sends only that cell to a capable client", async () => {
    const { write } = await pair();
    const { p, l, pSize, lSize } = await write([set("sheet", "s150", 999)]);
    const [pd] = p.deltas;
    expect(pd.objects).toEqual([]);
    expect(pd.removed).toEqual([]);
    expect(pd.patches).toEqual([
      {
        object: "sheet",
        cells: { s150: { value: { type: "number", value: 999 }, kind: "literal" } },
      },
    ]);
    // The legacy client gets today's whole view, and no patches key.
    const [ld] = l.deltas;
    expect(ld).not.toHaveProperty("patches");
    expect(ld.objects.map((o: Frame) => o.id)).toEqual(["sheet"]);
    const legacyCells = Object.keys(ld.objects[0].cells).length;
    expect(legacyCells).toBeGreaterThan(SHEET_CELLS);
    expect(Object.keys(pd.patches[0].cells)).toHaveLength(1);
    // Bytes: the patch event is a small fraction of the whole-view event.
    expect(pSize * 10).toBeLessThan(lSize);
  });

  test("a deleted cell is patched as null; untouched objects are not sent", async () => {
    const { write } = await pair();
    const { p } = await write([{ type: "delete_cell", object: "sheet", cell: "s7" }]);
    expect(p.deltas[0].objects).toEqual([]);
    expect(p.deltas[0].patches).toEqual([{ object: "sheet", cells: { s7: null } }]);
  });

  test("a non-cell view field change is a whole upsert", async () => {
    const { write } = await pair();
    const { p, l } = await write([{ type: "set_template_flag", object: "sheet", value: true }]);
    expect(p.deltas[0]).not.toHaveProperty("patches");
    expect(p.deltas[0].objects).toEqual(l.deltas[0].objects);
    expect(p.deltas[0].objects[0].is_template).toBe(true);
  });

  test("a created object is a whole upsert; a removed one is in removed", async () => {
    const { write } = await pair();
    const created = await write([
      {
        type: "create_object",
        id_base: "fresh",
        to: { type: "board", board: "map", position: [0, 0] },
        init: { cells: { hp: { type: "number", value: 1 } } },
      },
    ]);
    expect(created.p.deltas[0]).not.toHaveProperty("patches");
    expect(created.p.deltas[0].objects).toEqual(created.l.deltas[0].objects);
    const id = created.p.deltas[0].objects[0].id;
    const removed = await write([{ type: "remove", object: id }]);
    expect(removed.p.deltas[0]).not.toHaveProperty("patches");
    expect(removed.p.deltas[0].objects).toEqual(removed.l.deltas[0].objects);
    expect(removed.p.deltas[0].removed).toEqual([id]);
    expect(removed.l.deltas[0].removed).toEqual([id]);
  });
});
