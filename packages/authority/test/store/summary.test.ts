import { applyEffect, DocState, SummaryBuilder } from "@vtt/authority";
import type { Effect } from "@vtt/schema";
import { expect, test } from "vitest";
import { lit, obj, subtree, table } from "./helpers";

test("a summary over a transaction-like sequence", () => {
  const s = DocState.fromSnapshot(table());
  const effects: Effect[] = [
    // spawn a die into the bag
    { type: "allocate", ids: ["die_5"], seq_before: 5, seq_after: 6 },
    {
      type: "create",
      objects: [obj("die_5", { cells: { value: lit(4) } })],
      location: { type: "container", container: "bag", index: 2 },
    },
    // write the goblin's hp to the value it already has, twice
    { type: "cell", object: "goblin", cell: "hp", before: lit(7), after: lit(7), cause: "edit" },
    { type: "cell", object: "goblin", cell: "hp", before: lit(7), after: lit(7), cause: "edit" },
    {
      type: "cell_visibility",
      object: "goblin",
      cell: "hp",
      before: null,
      after: { type: "viewers", viewers: ["gm"] },
    },
    // move the die out onto the shelf
    {
      type: "place",
      object: "die_5",
      before: { type: "container", container: "bag", index: 2 },
      after: { type: "board", board: "shelf" },
    },
    // remove the chest and everything in it
    {
      type: "remove",
      objects: subtree("chest", "pouch", "ring"),
      location: { type: "board", board: "map" },
    },
    { type: "retire", ids: ["chest", "pouch", "ring"] },
    { type: "board", before: null, after: { id: "attic" } },
    { type: "board", before: { id: "shelf", name: "Shelf" }, after: null },
  ];
  const builder = new SummaryBuilder();
  for (const e of effects) {
    builder.add(e, s);
    applyEffect(s, e);
  }
  const summary = builder.build();

  expect(summary.created).toEqual(["die_5"]);
  expect(summary.removed).toEqual(["chest", "pouch", "ring"]);
  expect(summary.boardsCreated).toEqual(["attic"]);
  expect(summary.boardsRemoved).toEqual(["shelf"]);
  expect(summary.writtenCells).toEqual([
    { object: "goblin", cell: "hp", before: lit(7), after: lit(7) },
    { object: "goblin", cell: "hp", before: lit(7), after: lit(7) },
  ]);
  expect(summary.visibility).toEqual([{ object: "goblin", cell: "hp" }]);
  expect(summary.moved).toHaveLength(1);
  const [moved] = summary.moved;
  expect(moved).toMatchObject({
    object: "die_5",
    from: { type: "container", container: "bag", index: 2 },
    to: { type: "board", board: "shelf" },
  });
  expect(moved?.derived).toEqual(
    expect.arrayContaining(["die_5:board", "die_5:position", "die_5:container", "bag:contents"]),
  );
  expect(summary.changedCells).toEqual(
    expect.arrayContaining([
      "die_5:value",
      "goblin:hp",
      "bag:contents",
      "die_5:board",
      "ring:value",
    ]),
  );
  expect(new Set(summary.changedCells).size).toBe(summary.changedCells.length);
});

test("an empty builder builds an empty summary", () => {
  expect(new SummaryBuilder().build()).toEqual({
    created: [],
    removed: [],
    boardsCreated: [],
    boardsRemoved: [],
    writtenCells: [],
    visibility: [],
    moved: [],
    changedCells: [],
    actionsChanged: [],
    faceChanged: [],
  });
});
