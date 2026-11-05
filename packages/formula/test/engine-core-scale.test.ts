import { createEngine } from "@vtt/formula";
import { list, num, type Result } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { doc, type ObjectSpec } from "./support/engine-doc";

const N = 5_000;

describe("iterative resolution", () => {
  test("a 5,000-cell chain resolves without a stack exception", () => {
    const cells: Record<string, string | number> = { c0: 0 };
    for (let i = 1; i <= N; i++) cells[`c${i}`] = `=c${i - 1} + 1`;
    const engine = createEngine(doc({ o: { cells } }));
    expect(engine.value("o", `c${N}`)).toEqual(num(N));
    const s = engine.stats();
    expect(s.evaluations).toBe(N);
    expect(engine.value("o", "c2500")).toEqual(num(2500));
    expect(engine.stats().evaluations).toBe(N);
  });

  test("a 5,000-cell cycle resolves without a stack exception", () => {
    const cells: Record<string, string> = { c0: `=c${N} + 1` };
    for (let i = 1; i <= N; i++) cells[`c${i}`] = `=c${i - 1} + 1`;
    const engine = createEngine(doc({ o: { cells } }));
    expect(engine.value("o", "c17")).toMatchObject({ type: "error", code: "#CYCLE" });
    expect(engine.value("o", "c4000")).toMatchObject({
      type: "error",
      code: "#CYCLE",
      origin: { object: "o", cell: "c4000" },
    });
  });

  test("wide dependencies, cold cache: each x evaluated exactly once, reads linear", () => {
    const objects: Record<string, ObjectSpec> = {};
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `d${i}`;
      ids.push(id);
      objects[id] = { cells: { x: `=${i} + 1` } };
    }
    objects.tray = { contents: ids, cells: { sum: "=contents.x" } };
    const engine = createEngine(doc(objects));
    const r = engine.value("tray", "sum");
    expect(r).toEqual(list(ids.map((_, i) => num(i + 1))));
    const s = engine.stats();
    expect(s.evaluations).toBe(N + 1);
    expect(s.reads).toBeLessThanOrEqual(4 * N);
    // One probe reaching every x, 5,000 evaluations, one complete retry.
    expect(s).toMatchObject({ attempts: N + 2, reads: 2 * (N + 1) });
  });
});

/** Read `cells` of object `o` in `order` on a fresh engine over a fresh document. */
function readAll(make: () => ReturnType<typeof doc>, order: string[]): Record<string, Result> {
  const engine = createEngine(make());
  return Object.fromEntries(order.map((c) => [c, engine.value("o", c)]));
}

describe("determinism: cold, warm, and reversed reads agree", () => {
  const chainCells: Record<string, string | number> = { c0: 1 };
  for (let i = 1; i <= 50; i++) chainCells[`c${i}`] = `=c${i - 1} * 2 - ${i}`;
  const cases: [string, () => ReturnType<typeof doc>, string[]][] = [
    ["chain", () => doc({ o: { cells: chainCells } }), Object.keys(chainCells)],
    [
      "diamond",
      () =>
        doc({
          o: { cells: { top: 3, l: "=top * 2", r: "=top + 10", bottom: "=l * r", out: "=bottom" } },
        }),
      ["top", "l", "r", "bottom", "out"],
    ],
    [
      "cycle",
      () =>
        doc({
          o: {
            cells: {
              a: "=b + 1",
              b: "=c + a",
              c: "=if(iserror(a), 1, a)",
              d: "=b + c",
              e: "=d",
              f: "=iserror(e)",
            },
          },
        }),
      ["a", "b", "c", "d", "e", "f"],
    ],
  ];

  test.each(cases)("%s", (_name, make, cells) => {
    const expected = Object.fromEntries(cells.map((c) => [c, readAll(make, [c])[c] as Result]));
    const forward = readAll(make, cells);
    const reversed = readAll(make, [...cells].reverse());
    expect(forward).toEqual(expected);
    expect(reversed).toEqual(expected);
    // Warm: read everything, then read each again.
    const engine = createEngine(make());
    for (const c of [...cells].reverse()) engine.value("o", c);
    for (const c of cells) expect(engine.value("o", c)).toEqual(expected[c]);
    // Warm with one cell read first, for each cell.
    for (const firstCell of cells) {
      const e = createEngine(make());
      e.value("o", firstCell);
      for (const c of cells)
        expect(e.value("o", c), `${firstCell} first, ${c}`).toEqual(expected[c]);
    }
  });
});
