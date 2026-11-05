import { DocumentStore, move, writeValue } from "@vtt/authority";
import {
  type Bounds,
  type Cell,
  GEOM_EPSILON,
  indexBounds,
  list,
  num,
  type Shape,
  type Snapshot,
  type TableObject,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { attach, box, candidates, expectAgrees, reference } from "./spatial-support";
import { at, lit, must, obj } from "./store/helpers";
import { formula, run } from "./store/structural-helpers";

/** mulberry32: a small seeded generator, so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE = 500;
const COUNT = 3000;

/**
 * 3000 objects on `map` over a 500×500 area: points, rects, circles and
 * offset polygons, some rotated, a few spanning far more than 64 buckets,
 * five with formula geometry. A few more sit on `other` and in a container.
 */
function generated(seed: number): Snapshot {
  const r = rng(seed);
  const objects: TableObject[] = [];
  for (let i = 0; i < COUNT; i++) {
    const id = `o${i}`;
    const cells: Record<string, Cell> = { position: at(r() * SIZE, r() * SIZE) };
    let shape: Shape | null = null;
    const kind = r();
    if (kind < 0.25) shape = { type: "rect", width: 0.5 + r() * 3, height: 0.5 + r() * 3 };
    else if (kind < 0.5) shape = { type: "circle", radius: 0.25 + r() * 2 };
    else if (kind < 0.7) {
      const ox = (r() - 0.5) * 20;
      const oy = (r() - 0.5) * 20;
      shape = {
        type: "polygon",
        points: [
          [ox, oy],
          [ox + 2, oy],
          [ox + 2, oy + 2],
        ],
      };
    }
    if (i % 997 === 0) shape = { type: "rect", width: 100 + r() * 100, height: 100 + r() * 100 };
    if (r() < 0.3) cells.rotation = lit(r() * 360);
    if (i % 600 === 1) cells.z = formula("1");
    objects.push(obj(id, { board: "map", shape, cells }));
  }
  objects.push(obj("bag", { board: "map", contents: ["held"], cells: { position: at(1, 1) } }));
  objects.push(obj("held"));
  objects.push(obj("away", { board: "other", cells: { position: at(10, 10) } }));
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

/** The index bounds of a generated object, read back from the store. */
function boundsOf(store: DocumentStore, id: string): Bounds {
  const o = must(store.getObject(id));
  const p = must(store.getCell(id, "position")).content as unknown as {
    items: { value: number }[];
  };
  const rot = store.getCell(id, "rotation")?.content;
  const deg = rot?.type === "number" ? rot.value : 0;
  return indexBounds(
    o.shape as Shape | null,
    [must(p.items[0]).value, must(p.items[1]).value],
    deg,
  );
}

/** 200 boxes: random small and medium ones, and ones on an object's epsilon boundary. */
function boxes(store: DocumentStore, seed: number): Bounds[] {
  const r = rng(seed);
  const out: Bounds[] = [];
  for (let i = 0; i < 200; i++) {
    const kind = i % 4;
    if (kind < 2) {
      const w = kind === 0 ? r() * 4 : r() * 80;
      const h = kind === 0 ? r() * 4 : r() * 80;
      const x = r() * (SIZE + 40) - 20;
      const y = r() * (SIZE + 40) - 20;
      out.push(box(x, y, x + w, y + h));
      continue;
    }
    const b = boundsOf(store, `o${Math.floor(r() * COUNT)}`);
    const y = (b.minY + b.maxY) / 2;
    // Exactly touching an edge, or just past it (before or after expansion).
    const nudge = [0, GEOM_EPSILON / 2, GEOM_EPSILON, 2 * GEOM_EPSILON][Math.floor(r() * 4)] ?? 0;
    out.push(
      r() < 0.5
        ? box(b.maxX + nudge, y - 1, b.maxX + nudge + 3, y + 1)
        : box(b.minX - nudge - 3, y - 1, b.minX - nudge, y + 1),
    );
  }
  return out;
}

// Twenty commits on a 3000-object document plus 200 brute-force comparisons
// run in about a second locally and several seconds on the shared CI runner.
const HEAVY_TIMEOUT = 30_000;

describe("a generated board of 3000 objects", () => {
  const store = DocumentStore.fromSnapshot(generated(7));
  const index = attach(store);

  test("a 2×2 box returns fewer than 50 ids", () => {
    for (const [x, y] of [
      [100, 100],
      [250, 250],
      [10, 490],
    ] as const) {
      const ids = index.candidates("map", box(x, y, x + 2, y + 2));
      expect(ids.length).toBeLessThan(50);
      expect([...ids].sort()).toEqual(reference(store, "map", box(x, y, x + 2, y + 2)));
    }
  });

  test("200 random boxes equal the brute-force set", { timeout: HEAVY_TIMEOUT }, () => {
    for (const near of boxes(store, 11)) expectAgrees(index, store, "map", near);
  });

  test("whole-board and huge boxes equal the brute-force set", () => {
    for (const near of [
      box(-1e9, -1e9, 1e9, 1e9),
      box(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 3),
      box(0, 0, SIZE, SIZE),
    ]) {
      expectAgrees(index, store, "map", near);
    }
    expect(candidates(index, "map", box(-1e9, -1e9, 1e9, 1e9))).not.toContain("held");
    expect(candidates(index, "other", box(-1e9, -1e9, 1e9, 1e9))).toEqual(["away"]);
  });

  test("still agrees after a batch of moves and writes", { timeout: HEAVY_TIMEOUT }, () => {
    const r = rng(23);
    for (let i = 0; i < 20; i++) {
      const id = `o${Math.floor(r() * COUNT)}`;
      const x = r() * SIZE;
      const y = r() * SIZE;
      if (store.boardOf(id) === null) continue;
      if (i % 3 === 0)
        run(store, (tx) => move(tx, id, { type: "board", board: "map", position: [x, y] }));
      else if (i % 3 === 1)
        run(store, (tx) => writeValue(tx, id, "position", list([num(x), num(y)])));
      else run(store, (tx) => writeValue(tx, id, "rotation", num(r() * 360)));
    }
    for (const near of boxes(store, 29)) expectAgrees(index, store, "map", near);
  });
});
