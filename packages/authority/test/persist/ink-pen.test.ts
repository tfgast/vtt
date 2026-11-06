/**
 * Pen strokes (vtt-qf5.27; DESIGN.md §4.6 Ink and text; M6-D28) through a
 * real authority: a `set_value` of ink with coloured, wide strokes reaches
 * the store, a live view and the log unchanged, and the file round trip
 * keeps them; an old bare-point stroke loads unchanged beside them.
 */
import {
  canonicalJson,
  DocumentStore,
  parseTable,
  replay,
  serializeTable,
  TableHost,
} from "@vtt/authority";
import type { TransactResult } from "@vtt/protocol";
import type { InkValue } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, connect, serve, until } from "../server/helpers";
import { table } from "../store/helpers";

afterEach(cleanup);

const INK: InkValue = {
  type: "ink",
  strokes: [
    [
      [0, 0],
      [0.5, 0.5],
    ],
    {
      points: [
        [1, 0],
        [1, 1],
      ],
      color: "#d32f2f",
      width: 0.16,
    },
    { points: [[2, 2]], width: 0.02 },
  ],
};

function committed(r: TransactResult) {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Extract<TransactResult, { status: "committed" }>;
}

describe("pen strokes round trip", () => {
  test("set_value over the wire: stored, in the view and the log, and through the file", async () => {
    const base = table();
    const store = DocumentStore.fromSnapshot(base);
    const host = TableHost.inMemory(store);
    const { server } = await serve({ host });
    const gm = await connect(server, { instance: "gm-1" });
    const sub = await gm.subscribe({ scope: { type: "board", board: "map" } });

    committed(
      await gm.transact([{ type: "set_value", object: "bag", cell: "ink", value: INK }], {
        base_revision: host.revision,
      }),
    );
    expect(store.getObject("bag")?.cells.ink?.content).toEqual(INK);

    await until(
      () => sub.mirror.objects.get("bag")?.cells.ink?.value.type === "ink",
      3000,
      "the ink view",
    );
    expect(sub.mirror.objects.get("bag")?.cells.ink?.value).toEqual(INK);
    const got = await gm.request("get_objects", { ids: ["bag"] });
    expect(got.objects[0]?.cells.ink?.value).toEqual(INK);

    const log = await gm.request("log", { effects: true });
    const effect = log.groups[0]?.effects?.[0] as { after?: { value?: unknown } } | undefined;
    expect(effect?.after?.value).toEqual(INK);

    const text = canonicalJson(serializeTable(store, []));
    expect(text).toContain('"color": "#d32f2f"');
    const { store: loaded, editedExternally } = parseTable(text);
    expect(editedExternally).toBe(false);
    expect(loaded.getObject("bag")?.cells.ink?.content).toEqual(INK);
    expect(loaded.toSnapshot()).toEqual(store.toSnapshot());
    expect(replay(base, loaded.history.groups())).toEqual(loaded.toSnapshot());
    expect(canonicalJson(serializeTable(loaded, []))).toBe(text);
  });

  test("a colour outside #rrggbb is refused as a malformed request and nothing changes", async () => {
    const store = DocumentStore.fromSnapshot(table());
    const host = TableHost.inMemory(store);
    const { server } = await serve({ host });
    const gm = await connect(server, { instance: "gm-1" });
    const value = { type: "ink", strokes: [{ points: [[0, 0]], color: "red" }] };
    await expect(
      gm.request("transact", {
        base_revision: host.revision,
        ops: [{ type: "set_value", object: "bag", cell: "ink", value }],
      } as never),
    ).rejects.toMatchObject({ local: false, error: { code: "bad_request" } });
    expect(store.getObject("bag")?.cells.ink).toBeUndefined();
  });

  test("a hand-edited file with a too-wide stroke fails to load", () => {
    const store = DocumentStore.fromSnapshot(table());
    const text = canonicalJson(serializeTable(store, []));
    const json = JSON.parse(text);
    json.snapshot.objects.bag.cells.ink = {
      content: { type: "ink", strokes: [{ points: [[0, 0]], width: 5 }] },
    };
    expect(() => parseTable(JSON.stringify(json))).toThrow();
  });
});
