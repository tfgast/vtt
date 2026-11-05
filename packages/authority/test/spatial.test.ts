import {
  clearOverride,
  createObject,
  DocumentStore,
  move,
  remove,
  SpatialIndex,
  setFormula,
  setShape,
  writeValue,
} from "@vtt/authority";
import { GEOM_EPSILON, indexBounds, list, num, type Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { attach, box, candidates, expectAgrees, reference } from "./spatial-support";
import { at, lit, must, obj } from "./store/helpers";
import { formula, run } from "./store/structural-helpers";

/** The query box of the small board. */
const B = box(0, 0, 20, 20);

const point = (x: number, y: number) => list([num(x), num(y)]);

/**
 * Two boards. On `map`, against B: `touch` (a point whose index bounds end
 * exactly on B's left edge), `outside` (a point two epsilons right of B, one
 * epsilon outside after expansion), `far`, `rotated` (a 2×20 rect left of B
 * that reaches it only turned 90°), `poly` (anchor in B, footprint outside),
 * `fpos` (formula position), `fz` (far, formula z), `inside` (a plain
 * object in B), `bag` (far, holding `coin`). On `other`: `elsewhere`, in B's
 * area.
 */
function small(): Snapshot {
  const objects = [
    obj("touch", { board: "map", cells: { position: at(-GEOM_EPSILON, 10) } }),
    obj("outside", { board: "map", cells: { position: at(20 + 2 * GEOM_EPSILON, 10) } }),
    obj("far", { board: "map", shape: { type: "rect", width: 4, height: 4 }, cells: { position: at(100, 100) } }),
    obj("rotated", {
      board: "map",
      shape: { type: "rect", width: 2, height: 20 },
      cells: { position: at(-8, 10), rotation: lit(90) },
    }),
    obj("poly", {
      board: "map",
      shape: {
        type: "polygon",
        points: [
          [10, 10],
          [12, 10],
          [12, 12],
        ],
      },
      cells: { position: at(15, 15) },
    }),
    obj("fpos", { board: "map", cells: { position: formula("far.position") } }),
    obj("fz", { board: "map", cells: { position: at(500, 500), z: formula("1 + 1") } }),
    obj("inside", { board: "map", shape: { type: "circle", radius: 1 }, cells: { position: at(5, 5) } }),
    obj("bag", { board: "map", contents: ["coin"], cells: { position: at(300, 300) } }),
    obj("coin"),
    obj("elsewhere", { board: "other", cells: { position: at(5, 5) } }),
  ];
  return {
    revision: 0,
    next_seq: 1,
    boards: [
      { id: "map", name: "Map" },
      { id: "other", name: "Other" },
    ],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

function setup(): { store: DocumentStore; index: SpatialIndex } {
  const store = DocumentStore.fromSnapshot(small());
  return { store, index: attach(store) };
}

describe("the candidate set on a small board", () => {
  test("the scenario's edge cases are what they claim", () => {
    expect(indexBounds(null, [-GEOM_EPSILON, 10], 0).maxX).toBe(B.minX);
    expect(indexBounds(null, [20 + 2 * GEOM_EPSILON, 10], 0).minX).toBeGreaterThan(B.maxX);
    const rect = { type: "rect", width: 2, height: 20 } as const;
    expect(indexBounds(rect, [-8, 10], 0).maxX).toBeLessThan(B.minX);
    expect(indexBounds(rect, [-8, 10], 90).maxX).toBeGreaterThan(B.minX);
  });

  test("equals the brute-force reference", () => {
    const { store, index } = setup();
    expect(candidates(index, "map", B)).toEqual(["fpos", "fz", "inside", "poly", "rotated", "touch"]);
    expectAgrees(index, store, "map", B);
  });

  test("never includes an object in a container or on another board", () => {
    const { index } = setup();
    const everywhere = box(-1e6, -1e6, 1e6, 1e6);
    const ids = candidates(index, "map", everywhere);
    expect(ids).not.toContain("coin");
    expect(ids).not.toContain("elsewhere");
    expect(candidates(index, "other", everywhere)).toEqual(["elsewhere"]);
  });

  test("a formula position counts by its override's bounds, and again when it is cleared", () => {
    const { store, index } = setup();
    run(store, (tx) => writeValue(tx, "fpos", "position", point(400, 400)));
    expect(candidates(index, "map", B)).not.toContain("fpos");
    expect(candidates(index, "map", box(399, 399, 401, 401))).toEqual(["fpos", "fz"]);
    expectAgrees(index, store, "map", B);
    run(store, (tx) => writeValue(tx, "fpos", "position", point(3, 3)));
    expect(candidates(index, "map", B)).toContain("fpos");
    run(store, (tx) => writeValue(tx, "fpos", "position", point(400, 400)));
    run(store, (tx) => clearOverride(tx, "fpos", "position"));
    expect(candidates(index, "map", B)).toContain("fpos");
    expectAgrees(index, store, "map", B);
  });

  test("an empty or degenerate query box still returns formula-geometry objects", () => {
    const { store, index } = setup();
    for (const near of [box(1000, 1000, 1000, 1000), box(5, 5, 0, 0), box(Number.NaN, 0, 1, 1)]) {
      expect(candidates(index, "map", near)).toEqual(["fpos", "fz"]);
      expectAgrees(index, store, "map", near);
    }
    expect(candidates(index, "nowhere", B)).toEqual([]);
  });

  test("objectsOnBoard lists every object directly on the board", () => {
    const { index } = setup();
    expect([...index.objectsOnBoard("map")].sort()).toEqual([
      "bag",
      "far",
      "fpos",
      "fz",
      "inside",
      "outside",
      "poly",
      "rotated",
      "touch",
    ]);
    expect(index.objectsOnBoard("other")).toEqual(["elsewhere"]);
    expect(index.objectsOnBoard("nowhere")).toEqual([]);
  });
});

describe("staying current through commits", () => {
  /** Expects agreement on both boards for B and a few other boxes. */
  function check(store: DocumentStore, index: SpatialIndex): void {
    for (const board of ["map", "other"]) {
      for (const near of [B, box(-1e6, -1e6, 1e6, 1e6), box(99, 99, 101, 101), box(4, 4, 6, 6)]) {
        expectAgrees(index, store, board, near);
      }
      expect([...index.objectsOnBoard(board)].sort()).toEqual(store.objectsOnBoard(board).sort());
    }
  }

  test("a move board to board", () => {
    const { store, index } = setup();
    run(store, (tx) => move(tx, "inside", { type: "board", board: "other", position: [5, 5] }));
    expect(candidates(index, "map", B)).not.toContain("inside");
    expect(candidates(index, "other", B)).toContain("inside");
    check(store, index);
  });

  test("a move board to container and container to board", () => {
    const { store, index } = setup();
    run(store, (tx) => move(tx, "inside", { type: "container", container: "bag" }));
    expect(candidates(index, "map", B)).not.toContain("inside");
    expect(index.objectsOnBoard("map")).not.toContain("inside");
    check(store, index);
    run(store, (tx) => move(tx, "coin", { type: "board", board: "map", position: [2, 2] }));
    expect(candidates(index, "map", B)).toContain("coin");
    check(store, index);
  });

  test("a move of a formula-geometry object into a container", () => {
    const { store, index } = setup();
    run(store, (tx) => move(tx, "fz", { type: "container", container: "bag" }));
    expect(candidates(index, "map", B)).not.toContain("fz");
    check(store, index);
  });

  test("position, rotation and shape writes", () => {
    const { store, index } = setup();
    run(store, (tx) => writeValue(tx, "far", "position", point(10, 10)));
    expect(candidates(index, "map", B)).toContain("far");
    check(store, index);
    run(store, (tx) => writeValue(tx, "rotated", "rotation", num(0)));
    expect(candidates(index, "map", B)).not.toContain("rotated");
    check(store, index);
    run(store, (tx) => setShape(tx, "outside", { type: "circle", radius: 1 }));
    expect(candidates(index, "map", B)).toContain("outside");
    check(store, index);
    run(store, (tx) => setShape(tx, "outside", null));
    expect(candidates(index, "map", B)).not.toContain("outside");
    check(store, index);
  });

  test("a create and a remove", () => {
    const { store, index } = setup();
    let id = "";
    run(store, (tx) => {
      id = createObject(tx, {}, { type: "board", board: "map", position: [7, 7] });
    });
    expect(candidates(index, "map", B)).toContain(id);
    check(store, index);
    run(store, (tx) => remove(tx, "bag"));
    run(store, (tx) => remove(tx, "inside"));
    run(store, (tx) => remove(tx, "fz"));
    expect(candidates(index, "map", B)).not.toContain("inside");
    expect(candidates(index, "map", B)).not.toContain("fz");
    check(store, index);
  });

  test("a position switched between literal and formula", () => {
    const { store, index } = setup();
    run(store, (tx) => setFormula(tx, "far", "position", "inside.position"));
    expect(candidates(index, "map", B)).toContain("far");
    check(store, index);
    run(store, (tx) => writeValue(tx, "fpos", "position", point(1, 1)));
    run(store, (tx) => clearOverride(tx, "fpos", "position"));
    run(store, (tx) => setFormula(tx, "rotated", "rotation", "45"));
    expect(candidates(index, "map", box(999, 999, 1000, 1000))).toContain("rotated");
    check(store, index);
  });

  test("a formula z switched to a literal", () => {
    const { store, index } = setup();
    run(store, (tx) => writeValue(tx, "fz", "z", num(3)));
    expect(candidates(index, "map", B)).not.toContain("fz");
    check(store, index);
    run(store, (tx) => clearOverride(tx, "fz", "z"));
    expect(candidates(index, "map", B)).toContain("fz");
    check(store, index);
  });

  test("a fresh index agrees with one kept current", () => {
    const { store, index } = setup();
    run(store, (tx) => move(tx, "inside", { type: "board", board: "other", position: [9, 9] }));
    run(store, (tx) => writeValue(tx, "fpos", "position", point(2, 2)));
    const fresh = new SpatialIndex(store);
    for (const near of [B, box(-1e6, -1e6, 1e6, 1e6)]) {
      for (const board of ["map", "other"]) {
        expect(candidates(fresh, board, near)).toEqual(candidates(index, board, near));
        expect(candidates(fresh, board, near)).toEqual(reference(store, board, near));
      }
    }
    expect(must(store.getObject("inside")).board).toBe("other");
  });
});
