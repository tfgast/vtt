/**
 * `createObject` with an id base (vtt-3l6.19; DESIGN.md §4.1, §5.3;
 * PROTOCOL.md §5 M4-D12): `<idBase>_<n>` allocated as spawn allocates copies.
 */
import { createObject, DocumentStore } from "@vtt/authority";
import type { Effect } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { must, table } from "./helpers";
import { expectRefused, run } from "./structural-helpers";

const bag = { type: "container", container: "bag" } as const;
const board = { type: "board", board: "map", position: [3, 3] } as const;

describe("createObject with idBase", () => {
  test("allocates <idBase>_<n> from next_seq and advances it", () => {
    const store = DocumentStore.fromSnapshot(table());
    let made = "";
    const group = run(store, (tx) => {
      made = createObject(
        tx,
        { is_zone: true, shape: { type: "rect", width: 2, height: 2 } },
        board,
        undefined,
        "zone",
      );
    });
    expect(made).toBe("zone_5");
    expect(store.nextSeq).toBe(6);
    expect((group.effects as readonly Effect[])[0]).toEqual({
      type: "allocate",
      ids: ["zone_5"],
      seq_before: 5,
      seq_after: 6,
    });
    expect(must(store.getObject("zone_5")).is_zone).toBe(true);
  });

  test("skips a retired <idBase>_<n>", () => {
    const store = DocumentStore.fromSnapshot({ ...table(), retired_ids: ["old", "zone_5"] });
    let made = "";
    const group = run(store, (tx) => {
      made = createObject(tx, {}, bag, undefined, "zone");
    });
    expect(made).toBe("zone_6");
    expect(store.nextSeq).toBe(7);
    expect((group.effects as readonly Effect[])[0]).toMatchObject({
      ids: ["zone_6"],
      seq_before: 5,
      seq_after: 7,
    });
  });

  test("skips a live object or board named <idBase>_<n>", () => {
    const s = table();
    const store = DocumentStore.fromSnapshot({
      ...s,
      boards: [...s.boards, { id: "token_5" }],
    });
    let made = "";
    run(store, (tx) => {
      made = createObject(tx, {}, bag, undefined, "token");
    });
    expect(made).toBe("token_6");
  });

  test("id syntax is what counts: a base that is a reserved word still makes a valid id", () => {
    const store = DocumentStore.fromSnapshot(table());
    let made = "";
    run(store, (tx) => {
      made = createObject(tx, {}, bag, undefined, "gm");
    });
    expect(made).toBe("gm_5");
  });

  test("two creations in one transaction get consecutive ids", () => {
    const store = DocumentStore.fromSnapshot(table());
    const made: string[] = [];
    run(store, (tx) => {
      made.push(createObject(tx, {}, bag, undefined, "card"));
      made.push(createObject(tx, {}, bag, undefined, "card"));
    });
    expect(made).toEqual(["card_5", "card_6"]);
  });

  test("without id or idBase the default base obj is used", () => {
    const store = DocumentStore.fromSnapshot(table());
    let made = "";
    run(store, (tx) => {
      made = createObject(tx, {}, bag);
    });
    expect(made).toBe("obj_5");
    const again = DocumentStore.fromSnapshot(table());
    run(again, (tx) => {
      made = createObject(tx, {}, bag, undefined, undefined);
    });
    expect(made).toBe("obj_5");
  });

  test("an id and an idBase together are invalid", () => {
    const store = DocumentStore.fromSnapshot(table());
    expectRefused(store, (tx) => createObject(tx, {}, bag, "marker", "zone"), {
      type: "invalid",
    });
  });

  test("an idBase without id syntax is invalid", () => {
    const store = DocumentStore.fromSnapshot(table());
    for (const base of ["", "1zone", "_zone", "zone-x", "$zone", "a b", "__proto__"]) {
      expectRefused(store, (tx) => createObject(tx, {}, bag, undefined, base), {
        type: "invalid",
      });
    }
    expectRefused(store, (tx) => createObject(tx, {}, bag, undefined, 7 as unknown as string), {
      type: "invalid",
    });
  });
});
