import {
  applyEffect,
  applyHistoricalInverse,
  changedCells,
  DocState,
  historicalInverse,
  invertForUndo,
  keysIntersect,
  retireEffect,
  touchedKeys,
} from "@vtt/authority";
import { type Effect, EMPTY, list, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { lit, must, named, obj, subtree, table } from "./helpers";

const state = () => DocState.fromSnapshot(table());

/** One example of every effect kind (and both ends of the ones with variants). */
const E = {
  cellWrite: {
    type: "cell",
    object: "goblin",
    cell: "hp",
    before: lit(7),
    after: lit(3),
    cause: "edit",
  },
  cellCreation: {
    type: "cell",
    object: "goblin",
    cell: "ac",
    before: null,
    after: lit(12),
    cause: "edit",
  },
  cellDeletion: {
    type: "cell",
    object: "goblin",
    cell: "hp",
    before: lit(7),
    after: null,
    cause: "edit",
  },
  visibility: {
    type: "cell_visibility",
    object: "goblin",
    cell: "hp",
    before: null,
    after: { type: "viewers", viewers: ["gm"] },
  },
  fieldTag: { type: "field", object: "goblin", field: "tag", before: ["creature"], after: [] },
  fieldShape: {
    type: "field",
    object: "goblin",
    field: "shape",
    before: null,
    after: { type: "circle", radius: 1 },
  },
  fieldIsTemplate: {
    type: "field",
    object: "goblin",
    field: "is_template",
    before: false,
    after: true,
  },
  placeContainerToBoard: {
    type: "place",
    object: "coin",
    before: { type: "container", container: "bag", index: 0 },
    after: { type: "board", board: "shelf" },
  },
  placeBoardToContainer: {
    type: "place",
    object: "goblin",
    before: { type: "board", board: "map" },
    after: { type: "container", container: "bag", index: 1 },
  },
  placeWithinContainer: {
    type: "place",
    object: "coin",
    before: { type: "container", container: "bag", index: 0 },
    after: { type: "container", container: "bag", index: 1 },
  },
  createIntoContainer: {
    type: "create",
    objects: [obj("die_5", { cells: { value: lit(4) } })],
    location: { type: "container", container: "bag", index: 1 },
  },
  createSubtreeOnBoard: {
    type: "create",
    objects: [
      obj("box_6", { board: "shelf", contents: ["die_7"] }),
      obj("die_7", { cells: { value: lit(2) } }),
    ],
    location: { type: "board", board: "shelf" },
  },
  removeFromContainer: {
    type: "remove",
    objects: [obj("coin", { cells: { name: named("Coin"), value: lit(1) } })],
    location: { type: "container", container: "bag", index: 0 },
  },
  removeSubtreeFromBoard: {
    type: "remove",
    objects: subtree("chest", "pouch", "ring"),
    location: { type: "board", board: "map" },
  },
  reorder: { type: "reorder", container: "bag", before: ["coin", "gem"], after: ["gem", "coin"] },
  boardCreation: { type: "board", before: null, after: { id: "attic", name: "Attic" } },
  boardRename: {
    type: "board",
    before: { id: "map", name: "Map" },
    after: { id: "map", name: "World" },
  },
  boardRemoval: { type: "board", before: { id: "map", name: "Map" }, after: null },
  allocate: { type: "allocate", ids: ["die_5", "die_6"], seq_before: 5, seq_after: 7 },
  retire: { type: "retire", ids: ["goblin", "bag"] },
} satisfies Record<string, Effect>;

const EXAMPLES = Object.entries(E) as [string, Effect][];

describe("DocState", () => {
  test("round-trips a snapshot", () => {
    expect(state().toSnapshot()).toEqual(table());
  });

  test("derives containers and reads structural defaults", () => {
    const s = state();
    expect(s.containerOf("ring")).toBe("pouch");
    expect(s.containerOf("pouch")).toBe("chest");
    expect(s.containerOf("goblin")).toBeNull();
    expect(s.contentsOf("bag")).toEqual(["coin", "gem"]);
    expect(s.objectsOnBoard("map").sort()).toEqual(["bag", "chest", "goblin"]);
    expect(s.boardOf("goblin")).toBe("map");
    expect(s.boardOf("coin")).toBeNull();
    expect(s.locationOf("gem")).toEqual({ type: "container", container: "bag", index: 1 });
    expect(s.getCell("goblin", "hp")).toEqual(lit(7));
    expect(s.getCell("goblin", "face_up")).toEqual({ content: { type: "boolean", value: true } });
    expect(s.getCell("ring", "container")).toEqual({ content: ref("pouch") });
    expect(s.getCell("goblin", "container")).toEqual({ content: EMPTY });
    expect(s.getCell("goblin", "tag")).toEqual({ content: list([text("creature")]) });
    expect(s.getCell("bag", "contents")).toEqual({ content: list([ref("coin"), ref("gem")]) });
    expect(s.getCell("goblin", "nope")).toBeUndefined();
    expect(s.getCell("nobody", "hp")).toBeUndefined();
    expect(s.getCellVisibility("goblin", "hp")).toBeUndefined();
    expect(s.getBoard("map")).toEqual({ id: "map", name: "Map" });
    expect(s.nextSeq).toBe(5);
  });

  test("reserves live boards, live objects and retired ids", () => {
    const s = state();
    expect(["map", "goblin", "ring", "old"].every((id) => s.isReserved(id))).toBe(true);
    expect(s.isReserved("goblin_9")).toBe(false);
  });
});

describe("historical inverses", () => {
  test.each(EXAMPLES)("rewinding %s restores the state exactly", (_, effect) => {
    const s = state();
    applyEffect(s, effect);
    expect(s.toSnapshot()).not.toEqual(table());
    applyHistoricalInverse(s, historicalInverse(effect));
    expect(s.toSnapshot()).toEqual(table());
  });

  test("allocate moves next_seq and its rewind restores seq_before", () => {
    const s = state();
    const allocate: Effect = { type: "allocate", ids: ["die_5"], seq_before: 5, seq_after: 6 };
    applyEffect(s, allocate);
    expect(s.nextSeq).toBe(6);
    applyHistoricalInverse(s, historicalInverse(allocate));
    expect(s.nextSeq).toBe(5);
  });

  test("a retire records only the ids it adds, and its rewind removes only those", () => {
    const s = state();
    const retire = must(retireEffect(s, ["old", "goblin", "goblin"]));
    expect(retire).toEqual({ type: "retire", ids: ["goblin"] });
    applyEffect(s, retire);
    expect(s.toSnapshot().retired_ids).toEqual(["old", "goblin"]);
    applyHistoricalInverse(s, historicalInverse(retire));
    expect(s.toSnapshot().retired_ids).toEqual(["old"]);
  });

  test("a retire of an id already retired is refused", () => {
    expect(() => applyEffect(state(), { type: "retire", ids: ["old"] })).toThrow();
  });

  test("board removal rewinds into the board's original place", () => {
    const s = state();
    const removal: Effect = { type: "board", before: { id: "map", name: "Map" }, after: null };
    applyEffect(s, removal);
    applyEffect(s, { type: "board", before: null, after: { id: "attic" } });
    applyHistoricalInverse(s, historicalInverse(removal));
    expect(s.toSnapshot().boards.map((b) => b.id)).toEqual(["map", "shelf", "attic"]);
  });
});

describe("user undo", () => {
  /** Applies `effect`, then its user-undo effects, and returns the state. */
  function undoAfter(effect: Effect) {
    const s = state();
    applyEffect(s, effect);
    const undo = invertForUndo(effect, s);
    for (const e of undo) applyEffect(s, e);
    return { s, undo };
  }

  test.each(
    EXAMPLES.filter(([, e]) =>
      ["cell", "cell_visibility", "field", "place", "reorder"].includes(e.type),
    ),
  )("undoing %s is the exact reversal", (_, effect) => {
    const { s, undo } = undoAfter(effect);
    expect(undo).toHaveLength(1);
    expect(s.toSnapshot()).toEqual(table());
  });

  test("undoing a create removes the objects and retires their ids", () => {
    const create = E.createSubtreeOnBoard;
    const { s, undo } = undoAfter(create);
    expect(undo.map((e) => e.type)).toEqual(["remove", "retire"]);
    expect(undo[1]).toEqual({ type: "retire", ids: ["box_6", "die_7"] });
    expect(s.hasObject("box_6")).toBe(false);
    expect(s.isReserved("box_6") && s.isReserved("die_7")).toBe(true);
    expect(s.toSnapshot()).toEqual({ ...table(), retired_ids: ["old", "box_6", "die_7"] });
  });

  test("undoing a create retires only ids not already retired", () => {
    const s = state();
    applyEffect(s, { type: "retire", ids: ["die_5"] });
    const create = E.createIntoContainer;
    applyEffect(s, create);
    expect(invertForUndo(create, s)).toEqual([
      {
        type: "remove",
        objects: [obj("die_5", { cells: { value: lit(4) } })],
        location: { type: "container", container: "bag", index: 1 },
      },
    ]);
  });

  test("undoing a remove restores the subtree and its ids stay retired", () => {
    const remove = E.removeSubtreeFromBoard;
    const s = state();
    applyEffect(s, remove);
    applyEffect(s, must(retireEffect(s, ["chest", "pouch", "ring"])));
    const undo = invertForUndo(remove, s);
    expect(undo.map((e) => e.type)).toEqual(["create"]);
    for (const e of undo) applyEffect(s, e);
    expect(s.toSnapshot()).toEqual({ ...table(), retired_ids: ["old", "chest", "pouch", "ring"] });
  });

  test("undoing a board creation removes the board and retires its id", () => {
    const { s, undo } = undoAfter(E.boardCreation);
    expect(undo).toEqual([
      { type: "board", before: { id: "attic", name: "Attic" }, after: null },
      { type: "retire", ids: ["attic"] },
    ]);
    expect(s.getBoard("attic")).toBeUndefined();
    expect(s.isReserved("attic")).toBe(true);
  });

  test("undoing a board removal re-creates it; a rename is renamed back", () => {
    const removed = undoAfter(E.boardRemoval);
    expect(removed.undo).toEqual([
      { type: "board", before: null, after: { id: "map", name: "Map" } },
    ]);
    expect(removed.s.toSnapshot()).toEqual(table());
    const renamed = undoAfter(E.boardRename);
    expect(renamed.undo).toEqual([
      { type: "board", before: { id: "map", name: "World" }, after: { id: "map", name: "Map" } },
    ]);
  });

  test("undoing allocate or retire does nothing", () => {
    const s = state();
    expect(invertForUndo(E.allocate, s)).toEqual([]);
    expect(invertForUndo(E.retire, s)).toEqual([]);
  });
});

describe("touchedKeys", () => {
  test("a cell write and a visibility change touch the cell", () => {
    expect(touchedKeys(E.cellWrite)).toEqual(["cell:goblin/hp"]);
    expect(touchedKeys(E.visibility)).toEqual(["cell:goblin/hp"]);
    expect(touchedKeys(E.fieldTag)).toEqual(["cell:goblin/tag"]);
  });

  test("a create into a container touches the new objects and the parent's contents", () => {
    expect(touchedKeys(E.createIntoContainer)).toEqual(["obj:die_5", "cell:bag/contents"]);
    expect(touchedKeys(E.createSubtreeOnBoard)).toEqual(["obj:box_6", "obj:die_7"]);
  });

  test("a remove from a container touches the parent's contents", () => {
    expect(touchedKeys(E.removeFromContainer)).toEqual(["obj:coin", "cell:bag/contents"]);
  });

  test("a place touches board, position, and both ends' contents", () => {
    expect(touchedKeys(E.placeContainerToBoard)).toEqual([
      "cell:coin/board",
      "cell:coin/position",
      "cell:bag/contents",
    ]);
    expect(touchedKeys(E.placeWithinContainer)).toEqual([
      "cell:coin/board",
      "cell:coin/position",
      "cell:bag/contents",
    ]);
  });

  test("reorder, board, allocate and retire", () => {
    expect(touchedKeys(E.reorder)).toEqual(["cell:bag/contents"]);
    expect(touchedKeys(E.boardRename)).toEqual(["board:map"]);
    expect(touchedKeys(E.allocate)).toEqual([]);
    expect(touchedKeys(E.retire)).toEqual([]);
  });

  test("obj:<id> intersects every key naming that object", () => {
    expect(keysIntersect(["obj:coin"], ["cell:coin/value"])).toBe(true);
    expect(keysIntersect(["cell:coin/value"], ["obj:coin"])).toBe(true);
    expect(keysIntersect(["obj:coin"], ["obj:coin"])).toBe(true);
    expect(keysIntersect(["cell:coin/value"], ["cell:coin/name"])).toBe(false);
    expect(keysIntersect(["obj:coin"], ["cell:coin_2/value", "obj:co"])).toBe(false);
    expect(keysIntersect(["board:map"], ["board:map"])).toBe(true);
  });
});

describe("changedCells", () => {
  test("a container-to-board place changes the derived placement cells", () => {
    const keys = changedCells(E.placeContainerToBoard, state());
    expect(keys).toEqual(
      expect.arrayContaining([
        "coin:board",
        "coin:position",
        "coin:rotation",
        "coin:z",
        "coin:container",
        "bag:contents",
      ]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a board-to-container place changes the new container's contents", () => {
    expect(changedCells(E.placeBoardToContainer, state())).toContain("bag:contents");
  });

  test("create and remove change every cell of the subtree and the parent's contents", () => {
    const created = changedCells(E.createIntoContainer, state());
    expect(created).toEqual(
      expect.arrayContaining(["die_5:value", "die_5:name", "die_5:container", "bag:contents"]),
    );
    const removed = changedCells(E.removeSubtreeFromBoard, state());
    expect(removed).toEqual(
      expect.arrayContaining(["chest:position", "chest:contents", "pouch:board", "ring:value"]),
    );
    expect(removed).not.toContain("map:contents");
  });

  test("cell, field, reorder, visibility", () => {
    const s = state();
    expect(changedCells(E.cellWrite, s)).toEqual(["goblin:hp"]);
    expect(changedCells(E.fieldTag, s)).toEqual(["goblin:tag"]);
    expect(changedCells(E.fieldShape, s)).toEqual(["goblin:shape"]);
    expect(changedCells(E.fieldIsTemplate, s)).toEqual([]);
    expect(changedCells(E.reorder, s)).toEqual(["bag:contents"]);
    expect(changedCells(E.visibility, s)).toEqual([]);
    expect(changedCells(E.allocate, s)).toEqual([]);
  });
});
