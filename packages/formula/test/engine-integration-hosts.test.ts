import type { Setup } from "@vtt/fixtures";
import { createEngine, type EvalHost } from "@vtt/formula";
import type { Bounds, Result } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { GridHost } from "./support/grid-host";
import { literalCandidates, MemoryHost } from "./support/memory-host";

const f = (source: string) => ({ type: "formula", source }) as const;
const n = (value: number) => ({ type: "number", value }) as const;
const RECT = (width: number, height: number) => ({ type: "rect", width, height }) as const;

/**
 * Three boards: `table` with two zones, literal and formula-positioned
 * tokens, and cross-object reads; `side` with a token whose position formula
 * is an error; `loop` with a cycle through geometry.
 */
function setup(): Setup {
  const zone = (id: string, board: string, at: [number, number], w: number, h: number) => ({
    id,
    is_zone: true,
    shape: RECT(w, h),
    placement: { board, position: at },
    cells: {
      inside: f("contents(this)"),
      n: f("count(inside)"),
      total: f("sum(inside.v)"),
    },
  });
  const token = (id: string, at: [number, number] | ReturnType<typeof f>, v: number) => ({
    id,
    shape: RECT(1, 1),
    placement: { board: "table", position: at },
    cells: {
      v: n(v),
      zones: f("zones_containing(this)"),
      above: f("on(this)"),
      near: f('distance(this, obj("zb"))'),
    },
  });
  return {
    boards: [{ id: "table" }, { id: "side" }, { id: "loop" }],
    characters: [],
    objects: [
      zone("zb", "table", [0, 0], 10, 10),
      zone("zs", "table", [3, 3], 2, 2),
      token("t1", [1, 1], 1),
      token("t2", [3, 3], 2),
      token("t3", [-4, 4], 3),
      token("t4", [3.5, 2.5], 4),
      token("t5", [20, 20], 5),
      token("t6", [-20, 3], 6),
      token("tf", f("[1 + 1, -2]"), 7),
      token("tg", f('[obj("t1").v * 3, obj("t2").v + 1]'), 8),
      {
        id: "counter",
        placement: { board: "table", position: [50, 50] },
        cells: {
          big: f("count(objects(v > 2))"),
          named: f('obj("Goblin")'),
          sum: f('obj("zb").total + obj("zs").total'),
        },
      },
      {
        id: "goblin",
        placement: { board: "table", position: [60, 60] },
        cells: { name: { type: "text", value: "Goblin" }, v: n(0) },
      },
      zone("zside", "side", [0, 0], 4, 4),
      {
        id: "terr",
        placement: { board: "side", position: f("[1 / 0, 0]") },
        cells: { v: n(1) },
      },
      {
        id: "tok_side",
        placement: { board: "side", position: [1, 1] },
        cells: { v: n(2) },
      },
      zone("zl", "loop", [0, 0], 4, 4),
      {
        id: "tl",
        placement: {
          board: "loop",
          position: f('if(count(obj("zl").inside) > 3, [9, 9], [1, 1])'),
        },
        cells: { v: n(1) },
      },
      {
        id: "tl2",
        placement: { board: "loop", position: [1, -1] },
        cells: { v: n(2), zones: f("zones_containing(this)") },
      },
    ],
  };
}

/** Every non-structural cell of every object, by `id.cell`, in sorted order. */
function formulaCells(host: MemoryHost): [string, string][] {
  const out: [string, string][] = [];
  for (const o of setup().objects) {
    for (const [cell, c] of Object.entries(o.cells ?? {})) {
      if ((c as { type: string }).type === "formula") out.push([o.id, cell]);
    }
    if (host.cell(o.id, "position")?.type === "formula") out.push([o.id, "position"]);
  }
  return out.sort((a, b) => (a.join(".") < b.join(".") ? -1 : 1));
}

function evaluateAll(host: EvalHost, cells: [string, string][], budget: number) {
  const engine = createEngine(host, { budget });
  const out: Record<string, Result> = {};
  for (const [id, cell] of cells) out[`${id}.${cell}`] = engine.value(id, cell);
  return out;
}

describe("host equivalence", () => {
  test("the grid host computes the literal-geometry candidate set exactly", () => {
    const mem = MemoryHost.fromSetup(setup());
    const grid = new GridHost(mem);
    const boxes: Bounds[] = [];
    for (let x = -25; x <= 25; x += 2.5) {
      for (let y = -25; y <= 25; y += 5) {
        boxes.push({ minX: x, minY: y, maxX: x + 1.5, maxY: y + 7 });
      }
    }
    boxes.push(
      { minX: 1, minY: 1, maxX: 1, maxY: 1 },
      { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    );
    for (const board of ["table", "side", "loop", "none"]) {
      for (const b of boxes) {
        expect(grid.objectsOnBoard(board, b).sort()).toEqual(
          literalCandidates(mem, board, b).sort(),
        );
      }
    }
  });

  test("identical results and #LIMIT outcomes at every budget", () => {
    const mem = MemoryHost.fromSetup(setup());
    const cells = formulaCells(mem);
    let limited = 0;
    let fine = 0;
    for (const budget of [3, 8, 15, 25, 40, 60, 90, 150, 20_000]) {
      const a = evaluateAll(MemoryHost.fromSetup(setup()), cells, budget);
      const b = evaluateAll(new GridHost(MemoryHost.fromSetup(setup())), cells, budget);
      expect(b).toEqual(a);
      for (const r of Object.values(a)) {
        if (r.type === "error" && r.code === "#LIMIT") limited++;
        else fine++;
      }
    }
    expect(limited).toBeGreaterThan(0);
    expect(fine).toBeGreaterThan(0);
  });

  test("full budget: the expected answers, including the error and the cycle", () => {
    const host = MemoryHost.fromSetup(setup());
    const res = evaluateAll(host, formulaCells(host), 20_000);
    expect(res["zside.inside"]).toMatchObject({
      code: "#DIV0",
      origin: { object: "terr", cell: "position" },
    });
    expect(res["zl.inside"]).toMatchObject({ code: "#CYCLE" });
    expect(res["tl.position"]).toMatchObject({ code: "#CYCLE" });
    expect(res["tl2.zones"]).toMatchObject({ code: "#CYCLE" });
    expect(res["zb.inside"]).toMatchObject({ type: "list" });
    expect(res["counter.named"]).toEqual({ type: "ref", object: "goblin" });
  });

  test("identical after mutations on both hosts", () => {
    const a = MemoryHost.fromSetup(setup());
    const b = MemoryHost.fromSetup(setup());
    const grid = new GridHost(b);
    const cells = formulaCells(a);
    const ea = createEngine(a, { budget: 60 });
    const eb = createEngine(grid, { budget: 60 });
    const readAll = () => {
      const ra = cells.map(([id, c]) => ea.value(id, c));
      const rb = [...cells]
        .reverse()
        .map(([id, c]) => eb.value(id, c))
        .reverse();
      expect(rb).toEqual(ra);
    };
    readAll();
    const both = (m: (h: MemoryHost) => ReturnType<MemoryHost["set"]>) => {
      ea.invalidate(m(a));
      eb.invalidate(m(b));
      readAll();
    };
    both((h) => h.move("t5", { board: "table", position: [2, -3] }));
    both((h) => h.replaceContent("tl", "position", { type: "list", items: [n(1), n(1)] }));
    both((h) => h.replaceContent("terr", "position", f("[0, 0]")));
    both((h) =>
      h.createObject("t9", {
        cells: { v: n(9) },
        shape: RECT(1, 1),
        placement: { board: "table", position: [-1, -1] },
      }),
    );
    both((h) => h.deleteObject("t2"));
    expect(grid.rebuilds).toBeGreaterThan(1);
  });
});
