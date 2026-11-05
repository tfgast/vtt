/** DocumentHost (vtt-75c.12): the EvalHost over the store and the spatial index. */

import { DocumentHost, DocumentStore, move, SpatialIndex, writeValue } from "@vtt/authority";
import type { EvalHost } from "@vtt/formula";
import {
  type Bounds,
  bool,
  boundsIntersect,
  EMPTY,
  indexBounds,
  list,
  num,
  type ObjectId,
  type Point,
  ref,
  type Shape,
  shape,
  type TableObject,
  text,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, c, commit, f, obj, placed, snapshot, zone } from "./helpers";

function hostOver(objects: TableObject[], boards?: string[]) {
  const store = DocumentStore.fromSnapshot(snapshot(objects, boards));
  const index = new SpatialIndex(store);
  store.onCommitInternal((p) => index.applyCommit(p));
  return { store, index, host: new DocumentHost(store, index) };
}

describe("DocumentHost cells", () => {
  const { host } = hostOver([
    placed("bag", 1, 2, {
      tag: ["loot", "heavy"],
      contents: ["coin"],
      cells: { name: c(text("Bag")), hp: f("1 + 1"), rotation: c(num(90)) },
    }),
    obj("coin", { cells: { value: c(num(1)) } }),
    zone("room", 0, 0, 4),
  ]);

  test("structural cells read with their canonical shapes and defaults", () => {
    expect(host.cell("bag", "id")).toEqual(text("bag"));
    expect(host.cell("bag", "name")).toEqual(text("Bag"));
    expect(host.cell("coin", "name")).toEqual(EMPTY);
    expect(host.cell("bag", "tag")).toEqual(list([text("loot"), text("heavy")]));
    expect(host.cell("coin", "tag")).toEqual(list([]));
    expect(host.cell("bag", "contents")).toEqual(list([ref("coin")]));
    expect(host.cell("coin", "container")).toEqual(ref("bag"));
    expect(host.cell("bag", "container")).toEqual(EMPTY);
    expect(host.cell("bag", "board")).toEqual(ref("table"));
    expect(host.cell("coin", "board")).toEqual(EMPTY);
    expect(host.cell("bag", "position")).toEqual(list([num(1), num(2)]));
    expect(host.cell("coin", "position")).toEqual(EMPTY);
    expect(host.cell("bag", "rotation")).toEqual(num(90));
    expect(host.cell("bag", "is_zone")).toEqual(bool(false));
    expect(host.cell("room", "is_zone")).toEqual(bool(true));
    expect(host.cell("room", "shape")).toEqual(shape({ type: "rect", width: 4, height: 4 }));
    expect(host.cell("bag", "shape")).toEqual(EMPTY);
    expect(host.cell("bag", "visible_to")).toEqual({ type: "viewers", viewers: ["all"] });
    expect(host.cell("bag", "face_up")).toEqual(bool(true));
  });

  test("user cells: stored content, formula source, undefined when absent", () => {
    expect(host.cell("coin", "value")).toEqual(num(1));
    expect(host.cell("bag", "hp")).toEqual({ type: "formula", source: "1 + 1" });
    expect(host.cell("bag", "nope")).toBeUndefined();
    expect(host.cell("ghost", "value")).toBeUndefined();
  });

  test("exists: objects and boards; a missing id does not exist", () => {
    expect(host.exists("bag")).toBe(true);
    expect(host.exists("coin")).toBe(true);
    expect(host.exists("table")).toBe(true);
    expect(host.exists("ghost")).toBe(false);
  });

  test("objectsNamed is an exact match over literal names; allObjects lists every object", () => {
    expect(host.objectsNamed("Bag")).toEqual(["bag"]);
    expect(host.objectsNamed("bag")).toEqual([]);
    expect(host.objectsNamed("")).toEqual([]);
    expect([...host.allObjects()].sort()).toEqual(["bag", "coin", "room"]);
  });
});

test("an override is returned as its literal", () => {
  const { store, host } = hostOver([placed("p", 0, 0, { cells: { hp: f("3") } })]);
  commit(store, (tx) => writeValue(tx, "p", "hp", num(9)));
  expect(host.cell("p", "hp")).toEqual(num(9));
});

test("objectsNamed follows a name rewrite", () => {
  const { store, host } = hostOver([placed("g", 0, 0, { cells: { name: c(text("Goblin")) } })]);
  commit(store, (tx) => writeValue(tx, "g", "name", text("Orc")));
  expect(host.objectsNamed("Goblin")).toEqual([]);
  expect(host.objectsNamed("Orc")).toEqual(["g"]);
});

/**
 * vtt-o9i.15's `literalCandidates` (packages/formula/test/support/memory-host.ts),
 * restated over any EvalHost: that module cannot be imported here, since it
 * pulls in @vtt/fixtures' Node-only sources. Objects on `board` whose literal
 * indexBounds meet `near`, plus those with a formula-valued geometry cell;
 * `host.cell` returns an override as its literal.
 */
function literalCandidates(host: EvalHost, board: ObjectId, near: Bounds): ObjectId[] {
  const out: ObjectId[] = [];
  for (const id of host.allObjects()) {
    const b = host.cell(id, "board");
    if (b?.type !== "ref" || b.object !== board) continue;
    const geometry = (["position", "rotation", "z", "shape"] as const).map((n) => host.cell(id, n));
    if (geometry.some((g) => g?.type === "formula")) {
      out.push(id);
      continue;
    }
    const [position, rotation, , shapeCell] = geometry;
    if (
      position?.type !== "list" ||
      position.items.length !== 2 ||
      !position.items.every((i) => i.type === "number" && Number.isFinite(i.value))
    ) {
      continue;
    }
    const anchor = position.items.map((i) => (i as { value: number }).value) as Point;
    const deg = rotation?.type === "number" && Number.isFinite(rotation.value) ? rotation.value : 0;
    const s = shapeCell?.type === "shape" ? shapeCell.shape : null;
    if (boundsIntersect(indexBounds(s, anchor, deg), near)) out.push(id);
  }
  return out;
}

/** A deterministic PRNG (mulberry32). */
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

describe("objectsOnBoard is the literal-geometry candidate set", () => {
  test("matches literalCandidates for a random board with formula-positioned objects", () => {
    const random = rng(75012);
    const between = (lo: number, hi: number) => lo + random() * (hi - lo);
    const shapes: (Shape | null)[] = [
      null,
      { type: "circle", radius: 1.5 },
      { type: "rect", width: 3, height: 1 },
      {
        type: "polygon",
        points: [
          [0, 0],
          [4, 0],
          [0, 3],
        ],
      },
    ];
    const objects: TableObject[] = [];
    const ids: ObjectId[] = [];
    for (let i = 0; i < 80; i++) {
      const id = `o${i}`;
      ids.push(id);
      const roll = random();
      const s = shapes[Math.floor(random() * shapes.length)] ?? null;
      const cells: TableObject["cells"] = {};
      if (roll < 0.15) cells.position = f(`[${i % 7}, 2]`);
      else cells.position = at(between(-40, 40), between(-40, 40));
      if (random() < 0.3) cells.rotation = c(num(Math.floor(between(0, 360))));
      if (random() < 0.1) cells.z = f("1 + 1");
      objects.push(obj(id, { board: random() < 0.85 ? "table" : "side", shape: s, cells }));
    }
    // Some held in a container: never candidates.
    objects.push(placed("crate", 0, 0, { contents: ["inner"] }), obj("inner"));
    const { store, host } = hostOver(objects, ["table", "side"]);
    const sorted = (xs: ObjectId[]) => [...xs].sort();
    const check = () => {
      for (let q = 0; q < 60; q++) {
        const x = between(-50, 50);
        const y = between(-50, 50);
        const near: Bounds = {
          minX: x,
          minY: y,
          maxX: x + between(0, 30),
          maxY: y + between(0, 30),
        };
        for (const board of ["table", "side", "nowhere"]) {
          expect(sorted(host.objectsOnBoard(board, near))).toEqual(
            sorted(literalCandidates(host, board, near)),
          );
        }
      }
    };
    check();
    // After moves and overrides committed through the store, still the same set.
    commit(store, (tx) => {
      for (const id of ids.slice(0, 20)) {
        move(tx, id, {
          type: "board",
          board: "table",
          position: [between(-40, 40), between(-40, 40)],
        });
      }
      move(tx, "o30", { type: "container", container: "crate" });
    });
    check();
  });
});
