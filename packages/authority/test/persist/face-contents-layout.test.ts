/**
 * `layout` on a contents element (vtt-qf5.28; DESIGN.md §4.6; PROTOCOL.md
 * §5; M6-D30) through a real authority: a `set_face` over the wire reaches
 * the stored face, the live view and the log unchanged, the file round
 * trip keeps it in canonical key order, and an unknown layout is refused.
 */
import {
  canonicalJson,
  DocumentStore,
  parseTable,
  serializeTable,
  TableHost,
} from "@vtt/authority";
import type { TransactResult } from "@vtt/protocol";
import type { FaceLayout } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, connect, serve, until } from "../server/helpers";
import { table } from "../store/helpers";

afterEach(cleanup);

const FANNED: FaceLayout = {
  elements: [
    { layout: "fan", when_selected: true, rect: [-3, 0, 6, 2], type: "contents" },
    { type: "value", cell: "name", rect: [-1, -1, 2, 0.4] },
  ],
  collapsed: [{ type: "contents", rect: [0, 0, 6, 0.6], layout: "grid" }],
};

function committed(r: TransactResult) {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Extract<TransactResult, { status: "committed" }>;
}

describe("contents layout round trips", () => {
  test("set_face over the wire: stored, in views and the log, and through the file", async () => {
    const store = DocumentStore.fromSnapshot(table());
    const host = TableHost.inMemory(store);
    const { server } = await serve({ host });
    const gm = await connect(server, { instance: "gm-1" });
    const sub = await gm.subscribe({ scope: { type: "board", board: "map" } });

    committed(
      await gm.transact([{ type: "set_face", object: "bag", face: FANNED }], {
        base_revision: host.revision,
      }),
    );
    expect(store.getObject("bag")?.face).toEqual(FANNED);
    await until(() => sub.mirror.objects.get("bag")?.face !== undefined, 3000, "the face view");
    expect(sub.mirror.objects.get("bag")?.face?.elements[0]).toMatchObject({ layout: "fan" });
    expect(sub.mirror.objects.get("bag")?.face?.collapsed?.[0]).toMatchObject({ layout: "grid" });

    const log = await gm.request("log", { effects: true });
    const effect = log.groups[0]?.effects?.[0] as { after?: FaceLayout } | undefined;
    expect(effect?.after?.elements[0]).toMatchObject({ type: "contents", layout: "fan" });

    const text = canonicalJson(serializeTable(store, []));
    const { store: loaded, editedExternally } = parseTable(text);
    expect(editedExternally).toBe(false);
    expect(loaded.getObject("bag")?.face).toEqual(FANNED);
    const saved = JSON.parse(text).snapshot.objects.bag.face.elements[0];
    expect(Object.keys(saved)).toEqual(["type", "rect", "when_selected", "layout"]);
  });

  test("an unknown layout is refused as a malformed request and nothing changes", async () => {
    const store = DocumentStore.fromSnapshot(table());
    const host = TableHost.inMemory(store);
    const { server } = await serve({ host });
    const gm = await connect(server, { instance: "gm-1" });
    const face = { elements: [{ type: "contents", rect: [0, 0, 1, 1], layout: "stack" }] };
    await expect(
      gm.request("transact", {
        base_revision: host.revision,
        ops: [{ type: "set_face", object: "bag", face }],
      } as never),
    ).rejects.toMatchObject({ local: false, error: { code: "bad_request" } });
    expect(store.getObject("bag")?.face).toBeUndefined();
  });
});
