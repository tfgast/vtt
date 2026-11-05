import { createEngine } from "@vtt/formula";
import { bool, num } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { doc, formula } from "./support/engine-doc";

const cycle = (object: string, cell: string) => ({
  type: "error",
  code: "#CYCLE",
  origin: { object, cell },
});

describe("cycles", () => {
  test("self-reference", () => {
    const host = doc({ a: { cells: { x: "=x + 1", y: "=x" } } });
    const engine = createEngine(host);
    expect(engine.value("a", "y")).toMatchObject(cycle("a", "x"));
    expect(engine.value("a", "x")).toMatchObject(cycle("a", "x"));
    engine.invalidate(host.replaceContent("a", "x", formula("41 + 1")));
    expect(engine.value("a", "y")).toEqual(num(42));
  });

  test.each([
    ["a", ["a", "b", "c"]],
    ["b", ["b", "a", "c"]],
    ["c", ["c", "a", "b"]],
  ])("two-cell cycle, %s read first", (_first, order) => {
    const host = doc({ o: { cells: { a: "=b + 1", b: "=a + 1", c: "=a" } } });
    const engine = createEngine(host);
    const results = Object.fromEntries(order.map((cell) => [cell, engine.value("o", cell)]));
    expect(results.a).toMatchObject(cycle("o", "a"));
    expect(results.b).toMatchObject(cycle("o", "b"));
    expect(results.c).toMatchObject(cycle("o", "a"));
    // Break the cycle: every member and dependent recomputes.
    const dirty = engine.invalidate(host.replaceContent("o", "b", num(5)));
    expect([...dirty].sort()).toEqual(["o:a", "o:b", "o:c"]);
    expect(engine.value("o", "c")).toEqual(num(6));
    expect(engine.value("o", "a")).toEqual(num(6));
    expect(engine.value("o", "b")).toEqual(num(5));
  });

  test("an iserror guard inside the cycle does not escape it", () => {
    const host = doc({
      o: { cells: { a: "=if(iserror(b), 0, b)", b: "=a + 1", c: "=iserror(a)" } },
    });
    const engine = createEngine(host);
    expect(engine.value("o", "a")).toMatchObject(cycle("o", "a"));
    expect(engine.value("o", "b")).toMatchObject(cycle("o", "b"));
    // Outside the cycle the guard works as usual.
    expect(engine.value("o", "c")).toEqual(bool(true));
    engine.invalidate(host.replaceContent("o", "b", num(1)));
    expect(engine.value("o", "a")).toEqual(num(1));
    expect(engine.value("o", "c")).toEqual(bool(false));
  });

  test("a conditional cycle appears and disappears with a flag", () => {
    const host = doc({
      o: { cells: { flag: bool(false), a: "=if(flag, b, 1)", b: "=a + 1", c: "=b * 10" } },
    });
    const engine = createEngine(host);
    expect(engine.value("o", "c")).toEqual(num(20));
    engine.invalidate(host.set("o", "flag", bool(true)));
    expect(engine.value("o", "c")).toMatchObject({ type: "error", code: "#CYCLE" });
    expect(engine.value("o", "a")).toMatchObject(cycle("o", "a"));
    expect(engine.value("o", "b")).toMatchObject(cycle("o", "b"));
    engine.invalidate(host.set("o", "flag", bool(false)));
    expect(engine.value("o", "c")).toEqual(num(20));
    expect(engine.value("o", "a")).toEqual(num(1));
  });

  test("a three-cell cycle across objects, broken with replaceContent", () => {
    const host = doc({
      p: { cells: { x: "=q.y" } },
      q: { cells: { y: "=r.z", p: { type: "ref", object: "p" } } },
      r: { cells: { z: "=p.x" } },
    });
    host.replaceContent("p", "q", { type: "ref", object: "q" });
    host.replaceContent("q", "r", { type: "ref", object: "r" });
    host.replaceContent("r", "p", { type: "ref", object: "p" });
    const engine = createEngine(host);
    expect(engine.value("q", "y")).toMatchObject(cycle("q", "y"));
    expect(engine.value("p", "x")).toMatchObject(cycle("p", "x"));
    expect(engine.value("r", "z")).toMatchObject(cycle("r", "z"));
    engine.invalidate(host.replaceContent("r", "z", num(3)));
    expect(engine.value("p", "x")).toEqual(num(3));
    expect(engine.value("q", "y")).toEqual(num(3));
  });

  test("every cell of a strongly connected component is a member, whatever the entry", () => {
    // r → a → r closes first; b → a is a cross edge into the component, and
    // r → b → a → r makes b a member too.
    for (const first of ["r", "a", "b"]) {
      const host = doc({ o: { cells: { r: "=a + b", a: "=r", b: "=a" } } });
      const engine = createEngine(host);
      engine.value("o", first);
      for (const cell of ["r", "a", "b"]) {
        expect(engine.value("o", cell), `${first} first, ${cell}`).toMatchObject(cycle("o", cell));
      }
    }
  });
});
