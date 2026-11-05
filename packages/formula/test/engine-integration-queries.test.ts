import { createEngine, type Dependency } from "@vtt/formula";
import { list, num, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { formula } from "./support/engine-doc";
import { MemoryHost } from "./support/memory-host";

const refs = (...ids: string[]) => list(ids.map(ref));
const RECT4 = { type: "rect", width: 4, height: 4 } as const;

/** A tray zone (rect 4x4 at [0, 0]) with a `inside = contents(this)` cell, one die in, one out. */
function trayDoc(): MemoryHost {
  return MemoryHost.fromSetup({
    boards: [{ id: "table" }],
    characters: [],
    objects: [
      {
        id: "tray",
        is_zone: true,
        shape: RECT4,
        placement: { board: "table", position: [0, 0] },
        cells: {
          inside: { type: "formula", source: "contents(this)" },
          total: { type: "formula", source: "sum(inside.value)" },
        },
      },
      {
        id: "d1",
        placement: { board: "table", position: [1, 1] },
        cells: { value: { type: "number", value: 3 } },
      },
      {
        id: "d2",
        placement: { board: "table", position: [10, 10] },
        cells: { value: { type: "number", value: 4 } },
      },
      {
        id: "goblin",
        placement: { board: "table", position: [20, 20] },
        cells: { name: { type: "text", value: "Goblin" } },
      },
      {
        id: "orc",
        placement: { board: "table", position: [30, 20] },
        cells: { name: { type: "text", value: "Orc" } },
      },
      {
        id: "finder",
        placement: { board: "table", position: [40, 40] },
        cells: { who: { type: "formula", source: 'obj("Goblin")' } },
      },
    ],
  });
}

const hasIndex = (deps: readonly Dependency[] | undefined) =>
  (deps ?? []).some((d) => d.type === "index");

describe("query dependencies", () => {
  test("contents records an index dependency and geometry cell reads", () => {
    const host = trayDoc();
    const engine = createEngine(host);
    expect(engine.value("tray", "inside")).toEqual(refs("d1"));
    const deps = engine.dependenciesOf("tray", "inside");
    expect(hasIndex(deps)).toBe(true);
    expect(deps).toContainEqual({ type: "cell", object: "d1", cell: "position" });
    // d2 is not a candidate (its literal bounds are far away): never read.
    expect(deps).not.toContainEqual({ type: "cell", object: "d2", cell: "position" });
  });

  test("moving an object it never returned into the zone recomputes contents", () => {
    const host = trayDoc();
    const engine = createEngine(host);
    expect(engine.value("tray", "total")).toEqual(num(3));
    const dirty = engine.invalidate(host.move("d2", { board: "table", position: [-1, -1] }));
    expect(dirty).toContain("tray:inside");
    expect(engine.value("tray", "inside")).toEqual(refs("d1", "d2"));
    expect(engine.value("tray", "total")).toEqual(num(7));
  });

  test("createObject placing an object inside the zone recomputes contents", () => {
    const host = trayDoc();
    const engine = createEngine(host);
    expect(engine.value("tray", "inside")).toEqual(refs("d1"));
    engine.invalidate(
      host.createObject("d3", {
        cells: { value: num(5) },
        placement: { board: "table", position: [0, -1] },
      }),
    );
    expect(engine.value("tray", "inside")).toEqual(refs("d1", "d3"));
    expect(engine.value("tray", "total")).toEqual(num(8));
  });

  test("allObjects records an index dependency: objects() sees a new object", () => {
    const host = trayDoc();
    host.replaceContent("finder", "n", formula("count(objects(true))"));
    const engine = createEngine(host);
    expect(engine.value("finder", "n")).toEqual(num(6));
    expect(hasIndex(engine.dependenciesOf("finder", "n"))).toBe(true);
    engine.invalidate(
      host.createObject("d4", { cells: { value: num(1) }, placement: { container: "orc" } }),
    );
    expect(engine.value("finder", "n")).toEqual(num(7));
  });

  test('obj("Goblin") follows a set of a name', () => {
    const host = trayDoc();
    const engine = createEngine(host);
    expect(engine.value("finder", "who")).toEqual(ref("goblin"));
    expect(hasIndex(engine.dependenciesOf("finder", "who"))).toBe(true);
    engine.invalidate(host.set("goblin", "name", text("Bob")));
    expect(engine.value("finder", "who")).toMatchObject({ type: "error", code: "#REF" });
    engine.invalidate(host.set("orc", "name", text("Goblin")));
    expect(engine.value("finder", "who")).toEqual(ref("orc"));
    engine.invalidate(host.set("goblin", "name", text("Goblin")));
    expect(engine.value("finder", "who")).toMatchObject({ type: "error", code: "#REF" });
  });
});

describe("cycles through spatial queries", () => {
  test("a token whose position depends on contents of a zone it is a candidate of", () => {
    const host = trayDoc();
    host.replaceContent(
      "d1",
      "position",
      formula('if(count(obj("tray").inside) > 5, [9, 9], [1, 1])'),
    );
    host.replaceContent("d1", "seen", formula('obj("tray").total'));
    const engine = createEngine(host);
    expect(engine.value("tray", "inside")).toMatchObject({
      type: "error",
      code: "#CYCLE",
      origin: { object: "tray", cell: "inside" },
    });
    expect(engine.value("d1", "position")).toMatchObject({
      code: "#CYCLE",
      origin: { object: "d1", cell: "position" },
    });
    // Outside the cycle: the propagated error, origin intact.
    expect(engine.value("tray", "total")).toMatchObject({
      code: "#CYCLE",
      origin: { object: "tray", cell: "inside" },
    });
    expect(engine.value("d1", "seen")).toMatchObject({ code: "#CYCLE" });

    engine.invalidate(host.replaceContent("d1", "position", list([num(1), num(1)])));
    expect(engine.value("tray", "inside")).toEqual(refs("d1"));
    expect(engine.value("tray", "total")).toEqual(num(3));
    expect(engine.value("d1", "seen")).toEqual(num(3));
  });

  test("the same cycle entered from the token first", () => {
    const host = trayDoc();
    host.replaceContent(
      "d1",
      "position",
      formula('if(count(obj("tray").inside) > 5, [9, 9], [1, 1])'),
    );
    const engine = createEngine(host);
    expect(engine.value("d1", "position")).toMatchObject({
      code: "#CYCLE",
      origin: { object: "d1", cell: "position" },
    });
    expect(engine.value("tray", "inside")).toMatchObject({
      code: "#CYCLE",
      origin: { object: "tray", cell: "inside" },
    });
  });
});
