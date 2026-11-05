import { cellKey, createEngine, type Dependency } from "@vtt/formula";
import { list, num, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { doc, formula } from "./support/engine-doc";
import { MemoryHost } from "./support/memory-host";
import { loadScenarios } from "./support/scenarios";

const scenarios = await loadScenarios();
const setupOf = (title: string) => {
  const s = scenarios.find((x) => x.source === title);
  if (s === undefined) throw new Error(`no scenario for ${title}`);
  return s.setup;
};

const depSort = (deps: readonly Dependency[] | undefined) =>
  [...(deps ?? [])].map((d) => JSON.stringify(d)).sort();

describe("engine.value", () => {
  test("missing object is #REF, missing cell is #NAME, literal is the literal", () => {
    const host = doc({ a: { cells: { n: 3, r: ref("b") } }, b: {} });
    const engine = createEngine(host);
    expect(engine.value("nope", "n")).toMatchObject({ type: "error", code: "#REF" });
    expect(engine.value("a", "missing")).toMatchObject({ type: "error", code: "#NAME" });
    expect(engine.value("a", "n")).toEqual(num(3));
    expect(engine.value("a", "r")).toEqual(ref("b"));
    expect(engine.value("a", "id")).toEqual(text("a"));
  });

  test("a literal holding a dangling reference reads #REF", () => {
    const host = doc({ a: { cells: { r: ref("b"), rs: list([ref("b")]) } }, b: {} });
    const engine = createEngine(host);
    engine.invalidate(host.deleteObject("b"));
    expect(engine.value("a", "r")).toMatchObject({ type: "error", code: "#REF" });
    expect(engine.value("a", "rs")).toMatchObject({ type: "error", code: "#REF" });
  });

  test("hit points: 27 → 22 after damage, unaffected cells not dirtied", () => {
    const host = MemoryHost.fromSetup(setupOf("Hit points"));
    host.replaceContent("aldric", "other", formula("max_hp * 2"));
    host.replaceContent("aldric", "unrelated", formula("1 + 1"));
    const engine = createEngine(host);
    expect(engine.value("aldric", "hp")).toEqual(num(27));
    expect(engine.value("aldric", "other")).toEqual(num(54));
    expect(engine.value("aldric", "unrelated")).toEqual(num(2));
    const dirty = engine.invalidate(host.set("aldric", "damage_taken", num(5)));
    expect(dirty).toEqual([cellKey("aldric", "hp")]);
    const before = engine.stats().evaluations;
    expect(engine.value("aldric", "hp")).toEqual(num(22));
    expect(engine.value("aldric", "other")).toEqual(num(54));
    expect(engine.value("aldric", "unrelated")).toEqual(num(2));
    expect(engine.stats().evaluations - before).toBe(1);
  });

  test("die with a modifier: total follows owner.attack_bonus, 16 → 17", () => {
    const host = doc({
      aldric: { cells: { attack_bonus: 5 } },
      aldric_die: {
        cells: {
          owner: ref("aldric"),
          value: 11,
          modifier: "=owner.attack_bonus",
          total: "=value + modifier",
        },
      },
    });
    const engine = createEngine(host);
    expect(engine.value("aldric_die", "total")).toEqual(num(16));
    const dirty = engine.invalidate(host.set("aldric", "attack_bonus", num(6)));
    expect([...dirty].sort()).toEqual([
      cellKey("aldric_die", "modifier"),
      cellKey("aldric_die", "total"),
    ]);
    expect(engine.value("aldric_die", "total")).toEqual(num(17));
  });

  test("memoized: a second read evaluates nothing", () => {
    const host = doc({ a: { cells: { x: 1, y: "=x + 1", z: "=y * 2" } } });
    const engine = createEngine(host);
    expect(engine.value("a", "z")).toEqual(num(4));
    const s = engine.stats();
    expect(s.evaluations).toBe(2);
    expect(engine.value("a", "z")).toEqual(num(4));
    expect(engine.value("a", "y")).toEqual(num(2));
    expect(engine.stats()).toEqual(s);
  });

  test("if records only the taken branch", () => {
    const host = doc({ a: { cells: { flag: { type: "boolean", value: true }, x: 1, y: 2 } } });
    host.replaceContent("a", "pick", formula("if(flag, x, y)"));
    const engine = createEngine(host);
    expect(engine.value("a", "pick")).toEqual(num(1));
    expect(depSort(engine.dependenciesOf("a", "pick"))).toEqual(
      depSort([
        { type: "cell", object: "a", cell: "flag" },
        { type: "cell", object: "a", cell: "x" },
      ]),
    );
    expect(engine.invalidate(host.set("a", "y", num(20)))).toEqual([]);
    expect(engine.invalidate(host.set("a", "flag", { type: "boolean", value: false }))).toEqual([
      cellKey("a", "pick"),
    ]);
    expect(engine.value("a", "pick")).toEqual(num(20));
    expect(depSort(engine.dependenciesOf("a", "pick"))).toEqual(
      depSort([
        { type: "cell", object: "a", cell: "flag" },
        { type: "cell", object: "a", cell: "y" },
      ]),
    );
  });

  test("dependencies record cell reads (formula, literal, absent) and existence checks", () => {
    const host = doc({
      a: { cells: { r: ref("b"), f: "=missing or r.n or 0" } },
      b: { cells: { n: "=7" } },
    });
    const engine = createEngine(host);
    expect(engine.value("a", "f")).toMatchObject({ type: "error", code: "#NAME" });
    host.replaceContent("a", "f", formula("r.n"));
    engine.invalidate([{ type: "cell", object: "a", cell: "f" }]);
    expect(engine.value("a", "f")).toEqual(num(7));
    expect(depSort(engine.dependenciesOf("a", "f"))).toEqual(
      depSort([
        { type: "cell", object: "a", cell: "r" },
        { type: "exists", object: "b" },
        { type: "cell", object: "b", cell: "n" },
      ]),
    );
    expect(engine.dependenciesOf("a", "r")).toBeUndefined();
  });

  test("a missing cell is #NAME until set creates it", () => {
    const host = doc({ a: { cells: { f: "=bonus + 1" } } });
    const engine = createEngine(host);
    expect(engine.value("a", "f")).toMatchObject({
      type: "error",
      code: "#NAME",
      origin: { object: "a", cell: "f" },
    });
    expect(engine.invalidate(host.set("a", "bonus", num(2)))).toEqual([cellKey("a", "f")]);
    expect(engine.value("a", "f")).toEqual(num(3));
  });

  test("a reference to a not-yet-created object is fixed by createObject", () => {
    const host = doc({ a: { cells: { r: ref("b"), f: "=r.n" } } });
    const engine = createEngine(host);
    expect(engine.value("a", "f")).toMatchObject({ type: "error", code: "#REF" });
    const dirty = engine.invalidate(
      host.createObject("b", {
        cells: { n: num(4) },
        placement: { board: "table", position: [1, 1] },
      }),
    );
    expect(dirty).toContain(cellKey("a", "f"));
    expect(engine.value("a", "f")).toEqual(num(4));
  });

  test("a reference to a deleted object reads #REF after deleteObject", () => {
    const host = doc({
      a: { cells: { r: ref("b"), f: "=r.n", g: "=r" } },
      b: { cells: { n: 4, m: "=n + 1" } },
    });
    const engine = createEngine(host);
    expect(engine.value("a", "f")).toEqual(num(4));
    expect(engine.value("a", "g")).toEqual(ref("b"));
    expect(engine.value("b", "m")).toEqual(num(5));
    const dirty = engine.invalidate(host.deleteObject("b"));
    expect([...dirty].sort()).toEqual([cellKey("a", "f"), cellKey("a", "g")]);
    expect(engine.value("a", "f")).toMatchObject({ type: "error", code: "#REF" });
    expect(engine.value("a", "g")).toMatchObject({ type: "error", code: "#REF" });
    expect(engine.value("b", "m")).toMatchObject({ type: "error", code: "#REF" });
    expect(engine.dependenciesOf("b", "m")).toBeUndefined();
  });

  test("a formula replaced by a literal reads as the literal and its dependents follow", () => {
    const host = doc({ a: { cells: { x: "=1 + 1", y: "=x * 10" } } });
    const engine = createEngine(host);
    expect(engine.value("a", "y")).toEqual(num(20));
    const dirty = engine.invalidate(host.replaceContent("a", "x", num(5)));
    expect([...dirty].sort()).toEqual([cellKey("a", "x"), cellKey("a", "y")]);
    expect(engine.value("a", "x")).toEqual(num(5));
    expect(engine.value("a", "y")).toEqual(num(50));
  });

  test("an override reads as its literal", () => {
    const host = doc({ a: { cells: { x: "=1 + 1", y: "=x * 10" } } });
    const engine = createEngine(host);
    expect(engine.value("a", "y")).toEqual(num(20));
    engine.invalidate(host.override("a", "x", num(3)));
    expect(engine.value("a", "y")).toEqual(num(30));
  });
});

describe("index dependents", () => {
  test("index-cell changes return no extra dirt when nothing recorded an index dependency", () => {
    const host = doc({ a: { cells: { f: "=1" } } });
    const engine = createEngine(host);
    engine.value("a", "f");
    expect(engine.invalidate(host.move("a", { board: "table", position: [2, 2] }))).toEqual([]);
  });
});

describe("#SYNTAX", () => {
  test.each([
    ["unparseable source", "1 +"],
    ["beyond the parser depth limit", `${"(".repeat(300)}1${")".repeat(300)}`],
    ["a 400-digit literal", "1".repeat(400)],
  ])("%s", (_name, source) => {
    const host = doc({ a: { cells: { f: formula(source) as never, g: "=f + 1" } } });
    const engine = createEngine(host);
    const r = engine.value("a", "f");
    expect(r).toMatchObject({ type: "error", code: "#SYNTAX", origin: { object: "a", cell: "f" } });
    expect(typeof (r as { message?: string }).message).toBe("string");
    expect(engine.value("a", "g")).toMatchObject({
      type: "error",
      code: "#SYNTAX",
      origin: { object: "a", cell: "f" },
    });
  });

  test("a source is parsed once per distinct string", () => {
    const objects: Record<string, { cells: Record<string, string> }> = {};
    for (let i = 0; i < 10; i++) objects[`o${i}`] = { cells: { f: "=2 * 3" } };
    const host = doc(objects);
    const engine = createEngine(host);
    for (let i = 0; i < 10; i++) expect(engine.value(`o${i}`, "f")).toEqual(num(6));
    expect(engine.stats().parses).toBe(1);
  });
});
