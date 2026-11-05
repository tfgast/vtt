import { createObject, DocumentStore, remove, storedStateEqual, touchedKeys } from "@vtt/authority";
import { type Effect, ref, type Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, lit, must, named, obj, table } from "./helpers";
import { applyUndo, expectRefused, formula, run } from "./structural-helpers";

describe("createObject", () => {
  test("an explicit id on a board: create, allocate without next_seq change, landing", () => {
    const store = DocumentStore.fromSnapshot(table());
    let made = "";
    const group = run(store, (tx) => {
      made = createObject(
        tx,
        { tag: ["marker"], cells: { name: named("Marker") } },
        { type: "board", board: "map", position: [4, 4] },
        "marker",
      );
    });
    expect(made).toBe("marker");
    const effects = group.effects as readonly Effect[];
    expect(effects[0]).toEqual({ type: "allocate", ids: ["marker"], seq_before: 5, seq_after: 5 });
    expect(effects[1]).toMatchObject({ type: "create", location: { type: "board", board: "map" } });
    const o = must(store.getObject("marker"));
    expect(o.tag).toEqual(["marker"]);
    expect(o.cells.position).toEqual(at(4, 4));
    expect(o.cells.z).toEqual(lit(1));
    expect(o.board).toBe("map");
  });

  test("an allocated id in a container, appended", () => {
    const store = DocumentStore.fromSnapshot(table());
    let made = "";
    const group = run(store, (tx) => {
      made = createObject(tx, {}, { type: "container", container: "bag" });
    });
    expect(made).toBe("obj_5");
    expect(store.contentsOf("bag")).toEqual(["coin", "gem", "obj_5"]);
    expect(store.nextSeq).toBe(6);
    expect((group.effects as readonly Effect[]).flatMap(touchedKeys)).toContain(
      "cell:bag/contents",
    );
  });

  test("a formula position gets an override on landing", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => {
      createObject(
        tx,
        { cells: { position: formula("goblin.position") } },
        { type: "board", board: "map", position: [1, 1] },
        "follower",
      );
    });
    expect(must(store.getObject("follower")).cells.position).toMatchObject({
      content: { type: "formula", source: "goblin.position" },
    });
    expect(must(store.getObject("follower")).cells.position?.override).toBeDefined();
  });

  test("a retired, live object, live board, or malformed id is invalid", () => {
    const store = DocumentStore.fromSnapshot(table());
    const dest = { type: "container", container: "bag" } as const;
    for (const id of ["old", "goblin", "shelf", "gm", "1x", ""]) {
      expectRefused(store, (tx) => createObject(tx, {}, dest, id), { type: "invalid" });
    }
  });

  test("ill-formed initial fields are refused", () => {
    const store = DocumentStore.fromSnapshot(table());
    const dest = { type: "container", container: "bag" } as const;
    expectRefused(
      store,
      (tx) => createObject(tx, { cells: { board: { content: ref("map") } } }, dest),
      {
        type: "invalid",
      },
    );
    expectRefused(store, (tx) => createObject(tx, { cells: { position: at(1, 1) } }, dest), {
      type: "invalid",
    });
    expectRefused(store, (tx) => createObject(tx, { tag: "x" } as never, dest), {
      type: "invalid",
    });
    expectRefused(store, (tx) => createObject(tx, { contents: ["coin"] } as never, dest), {
      type: "invalid",
    });
  });
});

/**
 * table() plus `card` on the shelf holding `row1` and `row2`, and `note` on
 * the map with a `about` cell referring to the card.
 */
function cardScene(): Snapshot {
  const s = table();
  s.objects.card = obj("card", {
    board: "shelf",
    contents: ["row1", "row2"],
    cells: { name: named("Card"), position: at(0, 0) },
    cell_visibility: { secret: { type: "viewers", viewers: ["gm"] } },
  });
  s.objects.row1 = obj("row1", { cells: { name: named("Row 1"), hp: formula("1 + 1") } });
  s.objects.row2 = obj("row2", { cells: { name: named("Row 2") } });
  s.objects.note = obj("note", {
    board: "map",
    cells: { position: at(3, 3), about: { content: ref("card") } },
  });
  return s;
}

describe("remove", () => {
  test("recursive remove of a card holding two rows", () => {
    const store = DocumentStore.fromSnapshot(cardScene());
    const before = store.toSnapshot();
    const group = run(store, (tx) => remove(tx, "card"));
    for (const id of ["card", "row1", "row2"]) expect(store.hasObject(id)).toBe(false);
    const effects = group.effects as readonly Effect[];
    expect(effects).toHaveLength(2);
    expect(effects[0]).toEqual({
      type: "remove",
      objects: ["card", "row1", "row2"].map((id) => before.objects[id]),
      location: { type: "board", board: "shelf" },
    });
    expect(effects[1]).toEqual({ type: "retire", ids: ["card", "row1", "row2"] });
    expect(must(store.getObject("note")).cells.about).toEqual({ content: ref("card") });
    expect(group.names).toEqual({ card: "Card", row1: "Row 1", row2: "Row 2" });

    const undone = applyUndo(store.toSnapshot(), group);
    expect(storedStateEqual(undone, before, { ignoreIdentity: true })).toBe(true);
    expect(undone.retired_ids).toEqual(expect.arrayContaining(["card", "row1", "row2"]));
  });

  test("removing from a container touches its contents", () => {
    const store = DocumentStore.fromSnapshot(table());
    const group = run(store, (tx) => remove(tx, "coin"));
    expect(store.contentsOf("bag")).toEqual(["gem"]);
    const effects = group.effects as readonly Effect[];
    expect(effects[0]).toMatchObject({
      type: "remove",
      location: { type: "container", container: "bag", index: 0 },
    });
    expect(effects.flatMap(touchedKeys)).toContain("cell:bag/contents");
  });

  test("ids already retired are not retired again", () => {
    const s = table();
    s.retired_ids.push("coin");
    const store = DocumentStore.fromSnapshot(s);
    const group = run(store, (tx) => remove(tx, "coin"));
    expect((group.effects as readonly Effect[]).filter((e) => e.type === "retire")).toEqual([]);
  });

  test("an unknown object is invalid", () => {
    const store = DocumentStore.fromSnapshot(table());
    expectRefused(store, (tx) => remove(tx, "nobody"), { type: "invalid" });
    expectRefused(store, (tx) => remove(tx, "map"), { type: "invalid" });
  });
});
