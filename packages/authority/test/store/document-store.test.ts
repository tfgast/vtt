import { DocumentStore, History, InvalidSnapshotError } from "@vtt/authority";
import type { Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { lit, must, named, obj, table } from "./helpers";

/** table() with objects and cells inserted in reverse order. */
function scrambled(): Snapshot {
  const s = table();
  const objects = Object.values(s.objects)
    .reverse()
    .map((o) => ({ ...o, cells: Object.fromEntries(Object.entries(o.cells).reverse()) }));
  return { ...s, objects: Object.fromEntries(objects.map((o) => [o.id, o])) };
}

describe("DocumentStore.fromSnapshot / toSnapshot", () => {
  test("round-trips a snapshot", () => {
    const store = DocumentStore.fromSnapshot(table());
    expect(store.toSnapshot()).toEqual(table());
    expect(DocumentStore.fromSnapshot(store.toSnapshot()).toSnapshot()).toEqual(store.toSnapshot());
  });

  test("puts objects by id and cells and cell_visibility by name", () => {
    const s = scrambled();
    const goblin = must(s.objects.goblin);
    const gm = { type: "viewers", viewers: ["gm"] } as const;
    goblin.cell_visibility = {
      zeta: { ...gm, viewers: ["gm"] },
      alpha: { ...gm, viewers: ["gm"] },
    };
    const out = DocumentStore.fromSnapshot(s).toSnapshot();
    expect(Object.keys(out.objects)).toEqual([
      "bag",
      "chest",
      "coin",
      "gem",
      "goblin",
      "pouch",
      "ring",
    ]);
    expect(Object.keys(must(out.objects.goblin).cells)).toEqual(["hp", "name", "position", "z"]);
    expect(Object.keys(must(out.objects.goblin).cell_visibility)).toEqual(["alpha", "zeta"]);
    expect(out.boards.map((b) => b.id)).toEqual(["map", "shelf"]);
  });

  test("copies deeply in both directions", () => {
    const input = table();
    const store = DocumentStore.fromSnapshot(input);
    must(input.objects.goblin).cells.hp = lit(1);
    const out = store.toSnapshot();
    must(out.objects.goblin).cells.hp = lit(2);
    out.retired_ids.push("x");
    expect(store.getCell("goblin", "hp")).toEqual(lit(7));
    expect(store.toSnapshot()).toEqual(table());
  });

  test("refuses an invalid snapshot", () => {
    const s = table();
    s.objects.stray = obj("stray", { board: "nowhere", cells: { name: named("Stray") } });
    expect(() => DocumentStore.fromSnapshot(s)).toThrow(InvalidSnapshotError);
  });

  test("exposes the DocState read API, revision and history", () => {
    const store = DocumentStore.fromSnapshot(table());
    expect(store.revision).toBe(3);
    expect(store.nextSeq).toBe(5);
    expect(store.getCell("goblin", "name")).toEqual(named("Goblin"));
    expect(store.containerOf("coin")).toBe("bag");
    expect(store.locationOf("gem")).toEqual({ type: "container", container: "bag", index: 1 });
    expect(store.subtreeOf("chest")).toEqual(["chest", "pouch", "ring"]);
    expect(store.objectsOnBoard("map").sort()).toEqual(["bag", "chest", "goblin"]);
    expect(store.isRetired("old")).toBe(true);
    expect(store.isReserved("map")).toBe(true);
    expect(store.boards().map((b) => b.id)).toEqual(["map", "shelf"]);
    expect(store.history.nextIndex).toBe(0);
  });

  test("keeps a given history", () => {
    const history = new History();
    history.restore(
      {
        first_index: 4,
        undo_barrier: 4,
        groups: [
          {
            index: 4,
            base_revision: 2,
            revision: 3,
            actor: { type: "gm" },
            kind: "edit",
            label: "x",
            names: {},
            effects: [],
          },
        ],
      },
      3,
      { editedExternally: false },
    );
    const store = DocumentStore.fromSnapshot(table(), history);
    expect(store.history).toBe(history);
    expect(store.history.nextIndex).toBe(5);
  });
});
