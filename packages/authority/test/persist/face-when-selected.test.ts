/**
 * `when_selected` on a contents element (vtt-nb8.26; DESIGN.md §4.6;
 * PROTOCOL.md §5; M6-D12) through a real authority: a `set_face` over the
 * wire reaches the stored face, the GM's and a character's views and the
 * log unchanged, and the file round trip keeps it.
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
import type { FaceLayout } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, connect, serve, until } from "../server/helpers";
import { table } from "../store/helpers";

afterEach(cleanup);

const LISTED: FaceLayout = {
  elements: [
    { type: "value", cell: "name", rect: [-1, -1, 2, 0.4] },
    { type: "contents", rect: [-1.5, 0.9, 3, 1.2], min_size: 24, when_selected: true },
  ],
  collapsed: [{ type: "contents", rect: [0, 0, 1, 0.6], when_selected: false }],
};

function committed(r: TransactResult) {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Extract<TransactResult, { status: "committed" }>;
}

describe("when_selected round trips", () => {
  test("set_face over the wire: stored, in views and the log, and through the file", async () => {
    const base = table();
    const store = DocumentStore.fromSnapshot(base);
    const host = TableHost.inMemory(store);
    const { server } = await serve({ host });
    const gm = await connect(server, { instance: "gm-1" });
    const sub = await gm.subscribe({ scope: { type: "board", board: "map" } });

    committed(
      await gm.transact([{ type: "set_face", object: "bag", face: LISTED }], {
        base_revision: host.revision,
      }),
    );
    expect(store.getObject("bag")?.face).toEqual(LISTED);

    // The live view: every element with its index and shown, the field kept.
    await until(() => sub.mirror.objects.get("bag")?.face !== undefined, 3000, "the face view");
    expect(sub.mirror.objects.get("bag")?.face).toEqual({
      elements: LISTED.elements.map((e, index) => ({ ...e, index, shown: true })),
      collapsed: [
        { type: "contents", rect: [0, 0, 1, 0.6], when_selected: false, index: 0, shown: true },
      ],
    });
    const got = await gm.request("get_objects", { ids: ["bag"] });
    expect(got.objects[0]?.face?.elements[1]).toMatchObject({ when_selected: true });

    // The log's face effect carries it.
    const log = await gm.request("log", { effects: true });
    const effect = log.groups[0]?.effects?.[0] as { after?: FaceLayout } | undefined;
    expect(effect?.after?.elements[1]).toMatchObject({ type: "contents", when_selected: true });

    // The file: saved, parsed back, the same face and bytes; replay agrees.
    const text = canonicalJson(serializeTable(store, []));
    expect(text).toContain('"when_selected": true');
    const { store: loaded, editedExternally } = parseTable(text);
    expect(editedExternally).toBe(false);
    expect(loaded.getObject("bag")?.face).toEqual(LISTED);
    expect(loaded.toSnapshot()).toEqual(store.toSnapshot());
    expect(replay(base, loaded.history.groups())).toEqual(loaded.toSnapshot());
    expect(canonicalJson(serializeTable(loaded, []))).toBe(text);
  });

  test("a string when_selected is refused as a malformed request and nothing changes", async () => {
    const store = DocumentStore.fromSnapshot(table());
    const host = TableHost.inMemory(store);
    const { server } = await serve({ host });
    const gm = await connect(server, { instance: "gm-1" });
    const face = { elements: [{ type: "contents", rect: [0, 0, 1, 1], when_selected: "yes" }] };
    await expect(
      gm.request("transact", {
        base_revision: host.revision,
        ops: [{ type: "set_face", object: "bag", face }],
      } as never),
    ).rejects.toMatchObject({ local: false, error: { code: "bad_request" } });
    expect(store.getObject("bag")?.face).toBeUndefined();
  });
});
