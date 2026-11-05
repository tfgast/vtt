import {
  DocumentStore,
  replay,
  replayWithInverses,
  rewind,
  storedStateEqual,
} from "@vtt/authority";
import type { Actor, Effect, Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, lit, must, named, obj, table } from "./helpers";

const gm: Actor = { type: "gm" };

/** table() at revision 7. */
const base = (): Snapshot => ({ ...table(), revision: 7 });

/**
 * Six transactions over base(): a spawn, a no-effect group, a move with a
 * removal and retirement, a new board, the removal of the board before it,
 * and a write.
 */
const steps: Effect[][] = [
  [
    { type: "allocate", ids: ["orc"], seq_before: 5, seq_after: 6 },
    {
      type: "create",
      objects: [obj("orc", { board: "map", cells: { name: named("Orc"), position: at(0, 0) } })],
      location: { type: "board", board: "map" },
    },
  ],
  [],
  [
    {
      type: "place",
      object: "goblin",
      before: { type: "board", board: "map" },
      after: { type: "container", container: "bag", index: 2 },
    },
    {
      type: "cell",
      object: "goblin",
      cell: "position",
      before: at(1, 2),
      after: null,
      cause: "edit",
    },
    { type: "cell", object: "goblin", cell: "z", before: lit(0), after: null, cause: "edit" },
    {
      type: "remove",
      objects: [must(table().objects.coin)],
      location: { type: "container", container: "bag", index: 0 },
    },
    { type: "retire", ids: ["coin"] },
  ],
  [{ type: "board", before: null, after: { id: "deck", name: "Deck" } }],
  [
    { type: "board", before: { id: "shelf", name: "Shelf" }, after: null },
    { type: "retire", ids: ["shelf"] },
  ],
  [{ type: "cell", object: "orc", cell: "hp", before: null, after: lit(12), cause: "edit" }],
];

function played(): DocumentStore {
  const store = DocumentStore.fromSnapshot(base());
  for (const effects of steps) {
    const tx = store.begin(gm, { kind: "edit", label: "step" });
    for (const e of effects) tx.record(e);
    tx.commit();
  }
  return store;
}

describe("replay", () => {
  test("reproduces the head from the base, revision included", () => {
    const store = played();
    const groups = store.history.groups();
    expect(store.revision).toBe(13);
    const head = replay(base(), groups);
    expect(head.revision).toBe(13);
    expect(storedStateEqual(head, store.toSnapshot(), { ignoreRevision: false })).toBe(true);
    expect(head).toEqual(store.toSnapshot());
  });

  test("sets the revision for a group with no effects", () => {
    const store = played();
    const [first, empty] = store.history.groups();
    const once = replay(base(), [must(first)]);
    const twice = replay(base(), [must(first), must(empty)]);
    expect(once.revision).toBe(8);
    expect(twice.revision).toBe(9);
    expect(storedStateEqual(once, twice)).toBe(true);
  });

  test("requires the base revision to match the first group", () => {
    const groups = played().history.groups();
    expect(() => replay({ ...base(), revision: 6 }, groups)).toThrow();
    expect(() => replay(base(), groups.slice(1))).toThrow();
  });

  test("with no groups returns the base", () => {
    expect(replay(base(), [])).toEqual(DocumentStore.fromSnapshot(base()).toSnapshot());
  });

  test("leaves its inputs alone", () => {
    const groups = played().history.groups();
    const b = base();
    replay(b, groups);
    expect(b).toEqual(base());
  });
});

describe("rewind", () => {
  test("reproduces the base from the head, revision and identity included", () => {
    const store = played();
    const groups = store.history.groups();
    const { snapshot: head, inverses } = replayWithInverses(base(), groups);
    const back = rewind(head, groups, inverses);
    expect(back.revision).toBe(7);
    expect(back.next_seq).toBe(5);
    expect(back.retired_ids).toEqual(["old"]);
    expect(back.boards.map((b) => b.id)).toEqual(["map", "shelf"]);
    expect(storedStateEqual(back, base(), { ignoreRevision: false })).toBe(true);
  });

  test("works from the inverses the store kept for its commits", () => {
    const store = played();
    const groups = store.history.groups();
    const inverses = groups.map((g) => must(store.inverses(g.index)));
    const back = rewind(store.toSnapshot(), groups, inverses);
    expect(storedStateEqual(back, base(), { ignoreRevision: false })).toBe(true);
  });

  test("rewinds a suffix to an intermediate revision", () => {
    const store = played();
    const groups = store.history.groups();
    const { inverses } = replayWithInverses(base(), groups);
    const mid = rewind(store.toSnapshot(), groups.slice(3), inverses.slice(3));
    expect(mid.revision).toBe(10);
    expect(
      storedStateEqual(mid, replay(base(), groups.slice(0, 3)), { ignoreRevision: false }),
    ).toBe(true);
  });

  test("requires the head revision to match the last group and inverses to match effects", () => {
    const store = played();
    const groups = store.history.groups();
    const { inverses } = replayWithInverses(base(), groups);
    expect(() => rewind({ ...store.toSnapshot(), revision: 12 }, groups, inverses)).toThrow();
    expect(() => rewind(store.toSnapshot(), groups, inverses.slice(1))).toThrow();
  });
});
