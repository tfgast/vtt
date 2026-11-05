import { type Destination, DocumentStore, move, storedStateEqual } from "@vtt/authority";
import { type Cell, type Effect, list, num, ref, type Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, lit, must, table } from "./helpers";
import { applyUndo, expectRefused, formula, run } from "./structural-helpers";

const owned = (id: string): Cell => ({ content: ref(id) });

/**
 * table() plus owners on `goblin` (itself) and `coin` (the goblin), and a
 * `rotation` of 90 on the goblin.
 */
function scene(): Snapshot {
  const s = table();
  const goblin = must(s.objects.goblin);
  goblin.cells.owner = owned("goblin");
  goblin.cells.rotation = lit(90);
  must(s.objects.coin).cells.owner = owned("goblin");
  return s;
}

const board = (b: string, x: number, y: number): Destination => ({
  type: "board",
  board: b,
  position: [x, y],
});
const into = (container: string, index?: number): Destination =>
  index === undefined ? { type: "container", container } : { type: "container", container, index };

/** Moves `obj` in `store`, checking that every owner cell is unchanged. */
function moved(store: DocumentStore, obj: string, dest: Destination): readonly Effect[] {
  const owners = () => store.objectIds().map((id) => [id, store.getCell(id, "owner")]);
  const before = owners();
  const group = run(store, (tx) => move(tx, obj, dest));
  expect(owners()).toEqual(before);
  return group.effects as readonly Effect[];
}

const cells = (store: DocumentStore, id: string) => must(store.getObject(id)).cells;

describe("move to a board", () => {
  test("board to board: place, position, z on top, rotation kept", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = moved(store, "goblin", board("shelf", 3, 4));
    expect(effects[0]).toEqual({
      type: "place",
      object: "goblin",
      before: { type: "board", board: "map" },
      after: { type: "board", board: "shelf" },
    });
    expect(store.boardOf("goblin")).toBe("shelf");
    expect(cells(store, "goblin").position).toEqual(at(3, 4));
    expect(cells(store, "goblin").z).toEqual(lit(1));
    expect(cells(store, "goblin").rotation).toEqual(lit(90));
    expect(store.containerOf("goblin")).toBeNull();
  });

  test("container to board: containment ends, z lands on top of the board", () => {
    const store = DocumentStore.fromSnapshot(scene());
    moved(store, "coin", board("map", 2, 2));
    expect(store.containerOf("coin")).toBeNull();
    expect(store.getCell("coin", "container")?.content).toEqual({ type: "empty" });
    expect(store.contentsOf("bag")).toEqual(["gem"]);
    expect(store.boardOf("coin")).toBe("map");
    expect(cells(store, "coin").position).toEqual(at(2, 2));
    // goblin's z is 0; bag and chest have none (0).
    expect(cells(store, "coin").z).toEqual(lit(1));
    expect(cells(store, "coin").rotation).toBeUndefined();
  });

  test("landing z is one above the board's top literal z; formula z cells are ignored", () => {
    const s = scene();
    must(s.objects.bag).cells.z = lit(4);
    must(s.objects.chest).cells.z = formula("100");
    const store = DocumentStore.fromSnapshot(s);
    moved(store, "coin", board("map", 0, 0));
    expect(cells(store, "coin").z).toEqual(lit(5));
  });

  test("an overridden formula z counts as its override (FORMULAS.md §3.1)", () => {
    const s = scene();
    must(s.objects.bag).cells.z = { content: { type: "formula", source: "100" }, override: num(7) };
    const store = DocumentStore.fromSnapshot(s);
    moved(store, "coin", board("map", 0, 0));
    expect(cells(store, "coin").z).toEqual(lit(8));
  });

  test("the moving object's own z is not counted", () => {
    const s = scene();
    must(s.objects.goblin).cells.z = lit(10);
    const store = DocumentStore.fromSnapshot(s);
    moved(store, "goblin", board("map", 0, 0));
    expect(cells(store, "goblin").z).toEqual(lit(1));
  });

  test("a formula z on the moving object is left alone", () => {
    const s = scene();
    must(s.objects.goblin).cells.z = formula("3");
    must(s.objects.bag).cells.z = lit(4);
    const store = DocumentStore.fromSnapshot(s);
    const effects = moved(store, "goblin", board("map", 6, 6));
    expect(cells(store, "goblin").z).toEqual(formula("3"));
    expect(effects.some((e) => e.type === "cell" && e.cell === "z")).toBe(false);
  });

  test("a move within a board over a formula position creates an override", () => {
    const s = scene();
    must(s.objects.goblin).cells.position = formula("bag.position");
    const store = DocumentStore.fromSnapshot(s);
    moved(store, "goblin", board("map", 7, 7));
    expect(cells(store, "goblin").position).toEqual({
      content: { type: "formula", source: "bag.position" },
      override: list([num(7), num(7)]),
    });
    expect(store.boardOf("goblin")).toBe("map");
  });

  test("an unknown board or a bad position is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => move(tx, "goblin", board("nowhere", 0, 0)), { type: "invalid" });
    for (const position of [[1], [1, Number.NaN], [1, "2"], "1,2"]) {
      expectRefused(
        store,
        (tx) => move(tx, "goblin", { type: "board", board: "map", position } as never),
        { type: "invalid" },
      );
    }
  });
});

describe("move to a container", () => {
  test("board to container at index 0, in the middle, and appended", () => {
    for (const [index, contents] of [
      [0, ["goblin", "coin", "gem"]],
      [1, ["coin", "goblin", "gem"]],
      [2, ["coin", "gem", "goblin"]],
      [undefined, ["coin", "gem", "goblin"]],
    ] as const) {
      const store = DocumentStore.fromSnapshot(scene());
      const effects = moved(store, "goblin", into("bag", index));
      expect(store.contentsOf("bag")).toEqual(contents);
      expect(store.containerOf("goblin")).toBe("bag");
      expect(store.boardOf("goblin")).toBeNull();
      expect(effects).toContainEqual({
        type: "place",
        object: "goblin",
        before: { type: "board", board: "map" },
        after: { type: "container", container: "bag", index: contents.indexOf("goblin") },
      });
    }
  });

  test("entering a container clears position, rotation and z; undo restores a formula position", () => {
    const s = scene();
    must(s.objects.goblin).cells.position = formula("bag.position");
    const store = DocumentStore.fromSnapshot(s);
    const before = store.toSnapshot();
    const group = run(store, (tx) => move(tx, "goblin", into("bag")));
    const c = cells(store, "goblin");
    expect(c.position).toBeUndefined();
    expect(c.rotation).toBeUndefined();
    expect(c.z).toBeUndefined();
    const undone = applyUndo(store.toSnapshot(), group);
    expect(must(undone.objects.goblin).cells.position).toEqual(formula("bag.position"));
    expect(storedStateEqual(undone, before)).toBe(true);
  });

  test("within a container: removes, then inserts at the index after the move", () => {
    let store = DocumentStore.fromSnapshot(scene());
    moved(store, "coin", into("bag", 1));
    expect(store.contentsOf("bag")).toEqual(["gem", "coin"]);
    store = DocumentStore.fromSnapshot(scene());
    moved(store, "gem", into("bag", 0));
    expect(store.contentsOf("bag")).toEqual(["gem", "coin"]);
    store = DocumentStore.fromSnapshot(scene());
    const effects = moved(store, "gem", into("bag"));
    expect(store.contentsOf("bag")).toEqual(["coin", "gem"]);
    expect(effects).toEqual([
      {
        type: "place",
        object: "gem",
        before: { type: "container", container: "bag", index: 1 },
        after: { type: "container", container: "bag", index: 1 },
      },
    ]);
  });

  test("container to another container", () => {
    const store = DocumentStore.fromSnapshot(scene());
    moved(store, "ring", into("bag", 1));
    expect(store.contentsOf("pouch")).toEqual([]);
    expect(store.contentsOf("bag")).toEqual(["coin", "ring", "gem"]);
    expect(store.containerOf("ring")).toBe("bag");
  });

  test("an index past the length after removal, or not an integer, is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => move(tx, "coin", into("bag", 2)), { type: "invalid" });
    expectRefused(store, (tx) => move(tx, "goblin", into("bag", 3)), { type: "invalid" });
    for (const index of [-1, 0.5, Number.NaN]) {
      expectRefused(store, (tx) => move(tx, "goblin", into("bag", index)), { type: "invalid" });
    }
  });

  test("moving into itself or into a grandchild is a containment cycle and changes nothing", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => move(tx, "chest", into("chest")), {
      type: "containment_cycle",
      object: "chest",
      container: "chest",
    });
    expectRefused(store, (tx) => move(tx, "chest", into("ring", 0)), {
      type: "containment_cycle",
      object: "chest",
      container: "ring",
    });
  });

  test("an unknown object, container or destination type is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => move(tx, "nobody", into("bag")), { type: "invalid" });
    expectRefused(store, (tx) => move(tx, "goblin", into("nobody")), { type: "invalid" });
    expectRefused(store, (tx) => move(tx, "goblin", into("map")), { type: "invalid" });
    expectRefused(store, (tx) => move(tx, "goblin", { type: "table" } as never), {
      type: "invalid",
    });
  });
});
