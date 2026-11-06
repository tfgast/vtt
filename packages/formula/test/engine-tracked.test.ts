/**
 * Tracked expressions (vtt-qf5.25; FORMULAS.md §7 Propagation): a keyed
 * formula that is not a cell, evaluated with recorded dependencies, cached by
 * key, and reported by `invalidateAll` when anything it read may have changed.
 */
import { createEngine } from "@vtt/formula";
import { bool, num } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { doc } from "./support/engine-doc";

const ON_O = { thisId: "o" };

describe("engine.evaluateTracked", () => {
  test("evaluates like evaluate and caches the result by key until invalidated", () => {
    const host = doc({ o: { cells: { a: 1, x: "=a + 1" } } });
    const engine = createEngine(host);
    expect(engine.evaluateTracked("k", "x > 1", ON_O)).toEqual(bool(true));
    const attempts = engine.stats().attempts;
    expect(engine.evaluateTracked("k", "x > 1", ON_O)).toEqual(bool(true));
    expect(engine.stats().attempts).toBe(attempts);
    expect(engine.evaluate("x > 1", ON_O)).toEqual(bool(true));
  });

  test("invalidateAll reports the keys whose reads changed, directly or through cells", () => {
    const host = doc({ o: { cells: { a: 1, b: 5, x: "=a + 1" } } });
    const engine = createEngine(host);
    engine.evaluateTracked("reads-x", "x > 1", ON_O);
    engine.evaluateTracked("reads-b", "b = 5", ON_O);
    // b is read only by a tracked expression: no cell is dirtied, the key is reported.
    expect(engine.invalidateAll(host.set("o", "b", num(6)))).toEqual({
      cells: [],
      tracked: ["reads-b"],
    });
    expect(engine.evaluateTracked("reads-b", "b = 5", ON_O)).toEqual(bool(false));
    // a reaches the key through the formula cell x.
    expect(engine.invalidateAll(host.set("o", "a", num(0)))).toEqual({
      cells: ["o:x"],
      tracked: ["reads-x"],
    });
    expect(engine.evaluateTracked("reads-x", "x > 1", ON_O)).toEqual(bool(false));
  });

  test("a key already dirty is not reported again until it is re-evaluated", () => {
    const host = doc({ o: { cells: { b: 1 } } });
    const engine = createEngine(host);
    engine.evaluateTracked("k", "b", ON_O);
    expect(engine.invalidateAll(host.set("o", "b", num(2))).tracked).toEqual(["k"]);
    expect(engine.invalidateAll(host.set("o", "b", num(3))).tracked).toEqual([]);
    expect(engine.evaluateTracked("k", "b", ON_O)).toEqual(num(3));
    expect(engine.invalidateAll(host.set("o", "b", num(4))).tracked).toEqual(["k"]);
  });

  test("invalidate still returns only the cells", () => {
    const host = doc({ o: { cells: { a: 1, x: "=a + 1" } } });
    const engine = createEngine(host);
    engine.value("o", "x");
    engine.evaluateTracked("k", "a", ON_O);
    expect(engine.invalidate(host.set("o", "a", num(2)))).toEqual(["o:x"]);
    // The key was still marked dirty.
    expect(engine.evaluateTracked("k", "a", ON_O)).toEqual(num(2));
  });

  test("a new source or object for the key replaces its result and dependencies", () => {
    const host = doc({ o: { cells: { a: 1, b: 1 } }, p: { cells: { a: 7 } } });
    const engine = createEngine(host);
    expect(engine.evaluateTracked("k", "a", ON_O)).toEqual(num(1));
    expect(engine.evaluateTracked("k", "b + 1", ON_O)).toEqual(num(2));
    expect(engine.invalidateAll(host.set("o", "a", num(3))).tracked).toEqual([]);
    expect(engine.invalidateAll(host.set("o", "b", num(3))).tracked).toEqual(["k"]);
    expect(engine.evaluateTracked("k", "a", { thisId: "p" })).toEqual(num(7));
    expect(engine.invalidateAll(host.set("o", "b", num(4))).tracked).toEqual([]);
    expect(engine.invalidateAll(host.set("p", "a", num(8))).tracked).toEqual(["k"]);
  });

  test("dropTracked forgets the key: it is never reported again", () => {
    const host = doc({ o: { cells: { b: 1 } } });
    const engine = createEngine(host);
    engine.evaluateTracked("k", "b", ON_O);
    engine.dropTracked("k");
    engine.dropTracked("never-registered");
    expect(engine.invalidateAll(host.set("o", "b", num(2))).tracked).toEqual([]);
  });

  test("queries, existence, creation and deletion reach tracked keys", () => {
    const host = doc({ o: { cells: { b: 1 } }, p: { cells: { v: 2 } } });
    const engine = createEngine(host);
    engine.evaluateTracked("count", "count(objects(true))", ON_O);
    engine.evaluateTracked("p", 'obj("p").v', ON_O);
    engine.evaluateTracked("on-q", "true", { thisId: "q" });
    const created = engine.invalidateAll(
      host.createObject("q", { placement: { board: "table", position: [1, 1] } }),
    );
    expect([...created.tracked].sort()).toEqual(["count", "on-q"]);
    expect(engine.evaluateTracked("count", "count(objects(true))", ON_O)).toEqual(num(3));
    const deleted = engine.invalidateAll(host.deleteObject("p"));
    expect([...deleted.tracked].sort()).toEqual(["count", "p"]);
  });

  test("tracked keys are not cells: dependenciesOf and value do not see them", () => {
    const host = doc({ o: { cells: { b: 1 } } });
    const engine = createEngine(host);
    engine.evaluateTracked("o:b", "b + 1", ON_O);
    expect(engine.value("o", "b")).toEqual(num(1));
    expect(engine.dependenciesOf("o", "b")).toBeUndefined();
  });

  test("deleting thisId reports the key, even for an expression that reads nothing", () => {
    const host = doc({ o: { cells: { b: 1 } } });
    const engine = createEngine(host);
    expect(engine.evaluateTracked("t", "true", ON_O)).toEqual(bool(true));
    expect(engine.evaluateTracked("syntax", "1 +", ON_O)).toMatchObject({ code: "#SYNTAX" });
    const deleted = engine.invalidateAll(host.deleteObject("o"));
    expect([...deleted.tracked].sort()).toEqual(["syntax", "t"]);
    expect(engine.evaluateTracked("t", "true", ON_O)).toMatchObject({ code: "#REF" });
    expect(engine.evaluate("true", ON_O)).toMatchObject({ code: "#REF" });
  });

  test("recreating a deleted thisId reports the key again", () => {
    const host = doc({ o: { cells: { b: 1 } } });
    const engine = createEngine(host);
    engine.evaluateTracked("t", "true", ON_O);
    engine.invalidateAll(host.deleteObject("o"));
    expect(engine.evaluateTracked("t", "true", ON_O)).toMatchObject({ code: "#REF" });
    const created = engine.invalidateAll(
      host.createObject("o", { placement: { board: "table", position: [0, 0] } }),
    );
    expect(created.tracked).toEqual(["t"]);
    expect(engine.evaluateTracked("t", "true", ON_O)).toEqual(bool(true));
  });
});
