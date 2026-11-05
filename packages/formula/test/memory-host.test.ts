import type { Change } from "@vtt/formula";
import { type Bounds, bool, EMPTY, list, num, type ObjectId, ref, shape, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { literalCandidates, MemoryHost } from "./support/memory-host";
import { loadScenarios } from "./support/scenarios";

const scenarios = await loadScenarios();
const scenario = (title: string) => {
  const s = scenarios.find((x) => x.source === title);
  if (s === undefined) throw new Error(`no scenario for ${title}`);
  return s;
};

const formula = (source: string) => ({ type: "formula" as const, source });
const cellChange = (object: ObjectId, cell: string): Change => ({ type: "cell", object, cell });
const created = (object: ObjectId): Change => ({ type: "object_created", object });
const deleted = (object: ObjectId): Change => ({ type: "object_deleted", object });

const key = (c: Change) => `${c.type} ${c.object} ${c.type === "cell" ? c.cell : ""}`;
/** Changes in a canonical order, so tests compare sets. */
const sorted = (changes: Change[]) => [...changes].sort((a, b) => key(a).localeCompare(key(b)));

describe("MemoryHost.fromSetup", () => {
  test.each(scenarios.map((s) => [s.source, s] as const))("builds %s", (_title, s) => {
    const host = MemoryHost.fromSetup(s.setup);
    for (const o of s.setup.objects) expect(host.exists(o.id)).toBe(true);
    for (const b of s.setup.boards) expect(host.exists(b.id)).toBe(true);
  });

  test("hit points: a formula cell is its formula content, a literal is its value", () => {
    const host = MemoryHost.fromSetup(scenario("Hit points").setup);
    expect(host.cell("aldric", "hp")).toEqual(formula("max_hp - damage_taken"));
    expect(host.cell("aldric", "max_hp")).toEqual(num(27));
    expect(host.cell("aldric", "id")).toEqual(text("aldric"));
    expect(host.cell("aldric", "board")).toEqual(ref("table"));
    expect(host.cell("aldric", "position")).toEqual(list([num(3), num(4)]));
    expect(host.cell("aldric", "no_such_cell")).toBeUndefined();
  });

  test("dice tray: empty contents, is_zone, the rect shape value", () => {
    const host = MemoryHost.fromSetup(scenario("A dice tray that totals itself").setup);
    expect(host.cell("cup", "contents")).toEqual(list([]));
    expect(host.cell("tray", "is_zone")).toEqual(bool(true));
    expect(host.cell("cup", "is_zone")).toEqual(bool(false));
    expect(host.cell("tray", "shape")).toEqual(shape({ type: "rect", width: 4, height: 4 }));
  });

  test("fireball: container is derived, board is empty inside a container", () => {
    const host = MemoryHost.fromSetup(scenario("A Fireball card with a circle zone").setup);
    expect(host.cell("fireball_zone", "container")).toEqual(ref("fireball"));
    expect(host.cell("fireball_zone", "board")).toEqual(EMPTY);
    expect(host.cell("fireball_zone", "position")).toEqual(EMPTY);
    expect(host.cell("fireball", "container")).toEqual(ref("aldric_binder"));
    expect(host.cell("aldric_binder", "container")).toEqual(EMPTY);
    expect(host.cell("aldric_binder", "contents")).toEqual(
      list([ref("fireball"), ref("save_row_t")]),
    );
    expect(host.isCharacter("aldric")).toBe(true);
    expect(host.isCharacter("fireball")).toBe(false);
  });

  test("unset structural cells read as their defaults", () => {
    const host = MemoryHost.fromSetup({
      boards: [{ id: "table" }],
      characters: [],
      objects: [{ id: "a", placement: { board: "table", position: [0, 0] } }],
    });
    expect(host.cell("a", "face_up")).toEqual(bool(true));
    expect(host.cell("a", "visible_to")).toEqual({ type: "viewers", viewers: ["all"] });
    expect(host.cell("a", "z")).toEqual(EMPTY);
    expect(host.cell("a", "rotation")).toEqual(EMPTY);
    expect(host.cell("a", "name")).toEqual(EMPTY);
    expect(host.cell("a", "tag")).toEqual(list([]));
    expect(host.cell("a", "owner")).toEqual(EMPTY);
    expect(host.cell("a", "template")).toEqual(EMPTY);
    expect(host.cell("a", "opaque")).toEqual(bool(false));
    expect(host.cell("a", "shape")).toEqual(EMPTY);
    expect(host.cell("a", "container")).toEqual(EMPTY);
  });

  test("boards exist and have no cells; unknown ids do not exist", () => {
    const host = MemoryHost.fromSetup(scenario("Hit points").setup);
    expect(host.exists("table")).toBe(true);
    expect(host.cell("table", "id")).toBeUndefined();
    expect(host.cell("table", "name")).toBeUndefined();
    expect(host.exists("nobody")).toBe(false);
    expect(host.cell("nobody", "id")).toBeUndefined();
    expect(host.allObjects()).toEqual(["aldric"]);
  });

  test("objectsNamed matches literal names exactly", () => {
    const host = MemoryHost.fromSetup(scenario("Hit points").setup);
    expect(host.objectsNamed("Aldric")).toEqual(["aldric"]);
    expect(host.objectsNamed("aldric")).toEqual([]);
  });

  test("a formula name or tag in setup throws", () => {
    const base = { boards: [{ id: "table" }], characters: [] };
    expect(() =>
      MemoryHost.fromSetup({
        ...base,
        objects: [
          {
            id: "a",
            placement: { board: "table", position: [0, 0] },
            cells: { name: formula('"x"') },
          },
        ],
      }),
    ).toThrow(/name/);
    expect(() =>
      MemoryHost.fromSetup({
        ...base,
        objects: [
          {
            id: "a",
            placement: { board: "table", position: [0, 0] },
            cells: { tag: { type: "list", items: [] } },
          },
        ],
      }),
    ).toThrow(/tag/);
  });
});

/** Board `b` and box [0,10]²; see each object's comment. */
function candidateHost(): MemoryHost {
  const on = (position: [number, number]) => ({ board: "b", position });
  return MemoryHost.fromSetup({
    boards: [{ id: "b" }, { id: "b2" }],
    characters: [],
    objects: [
      // Footprint well inside the box.
      { id: "inside", shape: { type: "rect", width: 2, height: 2 }, placement: on([5, 5]) },
      // Footprint touches the box edge at x = 10: inclusive.
      { id: "touching", shape: { type: "circle", radius: 1 }, placement: on([11, 5]) },
      // Shapeless, anchor in the box.
      { id: "point", placement: on([1, 1]) },
      // Far away.
      { id: "far", shape: { type: "circle", radius: 1 }, placement: on([50, 50]) },
      // Anchor in the box, footprint offset far to the right.
      {
        id: "offset",
        shape: {
          type: "polygon",
          points: [
            [20, 0],
            [22, 0],
            [21, 2],
          ],
        },
        placement: on([5, 5]),
      },
      // Formula position: a candidate wherever it would land.
      { id: "follower", placement: { board: "b", position: formula("[100, 100]") } },
      // Formula position with an override: judged by the override.
      { id: "pinned_far", placement: { board: "b", position: formula("[5, 5]") } },
      { id: "pinned_near", placement: { board: "b", position: formula("[100, 100]") } },
      // Formula rotation or z, literal position far away.
      { id: "spinning", placement: on([80, 80]), cells: { rotation: formula("90") } },
      { id: "stacking", placement: on([80, 80]), cells: { z: formula("1") } },
      // A container far away, holding something with no position.
      { id: "bag", placement: on([60, 60]), contents: ["coin"] },
      { id: "coin", shape: { type: "circle", radius: 1 } },
      // On another board, inside the box's coordinates.
      { id: "elsewhere", placement: { board: "b2", position: [5, 5] } },
    ],
  });
}

const box: Bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe("objectsOnBoard", () => {
  test("is the literal-geometry candidate set", () => {
    const host = candidateHost();
    host.override("pinned_far", "position", list([num(50), num(50)]));
    host.override("pinned_near", "position", list([num(5), num(5)]));
    expect(host.objectsOnBoard("b", box).sort()).toEqual(
      [
        "follower",
        "inside",
        "offset",
        "pinned_near",
        "point",
        "spinning",
        "stacking",
        "touching",
      ].sort(),
    );
  });

  test("an overridden geometry formula counts as literal", () => {
    const host = candidateHost();
    host.override("spinning", "rotation", num(90));
    host.override("stacking", "z", num(1));
    const ids = host.objectsOnBoard("b", box);
    expect(ids).not.toContain("spinning");
    expect(ids).not.toContain("stacking");
  });

  test("respects literal rotation", () => {
    const host = MemoryHost.fromSetup({
      boards: [{ id: "b" }],
      characters: [],
      objects: [
        {
          id: "bar",
          shape: { type: "rect", width: 40, height: 2 },
          placement: { board: "b", position: [5, 30] },
        },
      ],
    });
    expect(host.objectsOnBoard("b", box)).toEqual([]);
    host.set("bar", "rotation", num(90));
    expect(host.objectsOnBoard("b", box)).toEqual(["bar"]);
  });

  test("is empty for another board or a board with nothing near", () => {
    const host = candidateHost();
    expect(host.objectsOnBoard("b2", { minX: 100, minY: 100, maxX: 110, maxY: 110 })).toEqual([]);
    expect(host.objectsOnBoard("b2", box)).toEqual(["elsewhere"]);
  });

  test("literalCandidates agrees with objectsOnBoard", () => {
    const host = candidateHost();
    host.override("pinned_near", "position", list([num(5), num(5)]));
    for (const near of [box, { minX: 40, minY: 40, maxX: 70, maxY: 70 }]) {
      expect(literalCandidates(host, "b", near).sort()).toEqual(
        host.objectsOnBoard("b", near).sort(),
      );
    }
  });
});

/**
 * table: hero [0,0] z 3 rotation 45; token [4,4] z 7; drift (z formula, so
 * not literal); follower (formula position); chest [10,10] holding bag,
 * which holds coin and gem. shelf: empty.
 */
function mutationHost(): MemoryHost {
  return MemoryHost.fromSetup({
    boards: [{ id: "table" }, { id: "shelf" }],
    characters: [],
    objects: [
      {
        id: "hero",
        placement: { board: "table", position: [0, 0] },
        cells: {
          name: text("Hero"),
          max_hp: num(10),
          damage: num(0),
          hp: formula("max_hp - damage"),
          z: num(3),
          rotation: num(45),
        },
      },
      { id: "token", placement: { board: "table", position: [4, 4] }, cells: { z: num(7) } },
      { id: "drift", placement: { board: "table", position: [6, 6] }, cells: { z: formula("99") } },
      { id: "follower", placement: { board: "table", position: formula("hero.position") } },
      { id: "chest", placement: { board: "table", position: [10, 10] }, contents: ["bag"] },
      { id: "bag", contents: ["coin", "gem"] },
      { id: "coin", cells: { value: num(1) } },
      { id: "gem" },
    ],
  });
}

describe("cell mutators", () => {
  test("set changes a literal and creates an absent cell", () => {
    const host = mutationHost();
    expect(host.set("hero", "max_hp", num(12))).toEqual([cellChange("hero", "max_hp")]);
    expect(host.cell("hero", "max_hp")).toEqual(num(12));
    expect(host.set("hero", "notes", text("brave"))).toEqual([cellChange("hero", "notes")]);
    expect(host.cell("hero", "notes")).toEqual(text("brave"));
    expect(host.set("hero", "face_up", bool(false))).toEqual([cellChange("hero", "face_up")]);
    expect(host.set("hero", "tag", list([text("pc")]))).toEqual([cellChange("hero", "tag")]);
    expect(host.cell("hero", "tag")).toEqual(list([text("pc")]));
  });

  test("set refuses a formula cell, a protected cell, and a mistyped structural literal", () => {
    const host = mutationHost();
    expect(() => host.set("hero", "hp", num(1))).toThrow();
    expect(() => host.set("hero", "board", ref("shelf"))).toThrow();
    expect(() => host.set("hero", "contents", list([]))).toThrow();
    expect(() => host.set("hero", "face_up", num(1))).toThrow();
    expect(() => host.set("nobody", "x", num(1))).toThrow();
  });

  test("override and clearOverride", () => {
    const host = mutationHost();
    expect(host.isOverridden("hero", "hp")).toBe(false);
    expect(host.override("hero", "hp", num(5))).toEqual([cellChange("hero", "hp")]);
    expect(host.cell("hero", "hp")).toEqual(num(5));
    expect(host.isOverridden("hero", "hp")).toBe(true);
    expect(host.clearOverride("hero", "hp")).toEqual([cellChange("hero", "hp")]);
    expect(host.cell("hero", "hp")).toEqual(formula("max_hp - damage"));
    expect(host.isOverridden("hero", "hp")).toBe(false);
  });

  test("override needs a formula; clearOverride needs an override", () => {
    const host = mutationHost();
    expect(() => host.override("hero", "max_hp", num(1))).toThrow();
    expect(() => host.override("hero", "absent", num(1))).toThrow();
    expect(() => host.clearOverride("hero", "hp")).toThrow();
  });

  test("replaceContent: literal to formula, formula to literal, override dropped", () => {
    const host = mutationHost();
    expect(host.replaceContent("hero", "max_hp", formula("8 + 2"))).toEqual([
      cellChange("hero", "max_hp"),
    ]);
    expect(host.cell("hero", "max_hp")).toEqual(formula("8 + 2"));

    host.override("hero", "hp", num(5));
    expect(host.replaceContent("hero", "hp", num(4))).toEqual([cellChange("hero", "hp")]);
    expect(host.cell("hero", "hp")).toEqual(num(4));
    expect(host.isOverridden("hero", "hp")).toBe(false);

    host.override("hero", "max_hp", num(1));
    expect(host.replaceContent("hero", "max_hp", formula("20"))).toEqual([
      cellChange("hero", "max_hp"),
    ]);
    expect(host.isOverridden("hero", "max_hp")).toBe(false);
    expect(host.cell("hero", "max_hp")).toEqual(formula("20"));

    expect(host.replaceContent("hero", "fresh", formula("1"))).toEqual([
      cellChange("hero", "fresh"),
    ]);
  });

  test("replaceContent refuses a formula on name or tag", () => {
    const host = mutationHost();
    expect(() => host.replaceContent("hero", "name", formula('"x"'))).toThrow(/name/);
    expect(() => host.replaceContent("hero", "tag", formula("[]"))).toThrow(/tag/);
    expect(host.replaceContent("hero", "name", text("Heroine"))).toEqual([
      cellChange("hero", "name"),
    ]);
    expect(host.objectsNamed("Heroine")).toEqual(["hero"]);
  });
});

describe("move", () => {
  test("into a container deletes position, rotation, z and updates contents", () => {
    const host = mutationHost();
    const changes = host.move("hero", { container: "chest", index: 0 });
    expect(sorted(changes)).toEqual(
      sorted([
        cellChange("hero", "board"),
        cellChange("hero", "container"),
        cellChange("hero", "position"),
        cellChange("hero", "rotation"),
        cellChange("hero", "z"),
        cellChange("chest", "contents"),
      ]),
    );
    expect(host.cell("chest", "contents")).toEqual(list([ref("hero"), ref("bag")]));
    expect(host.cell("hero", "container")).toEqual(ref("chest"));
    expect(host.cell("hero", "board")).toEqual(EMPTY);
    expect(host.cell("hero", "position")).toEqual(EMPTY);
    expect(host.cell("hero", "rotation")).toEqual(EMPTY);
    expect(host.cell("hero", "z")).toEqual(EMPTY);
    expect(host.objectsOnBoard("table", box)).not.toContain("hero");
  });

  test("between containers updates both contents; index defaults to append", () => {
    const host = mutationHost();
    const changes = host.move("coin", { container: "chest" });
    expect(sorted(changes)).toEqual(
      sorted([
        cellChange("coin", "container"),
        cellChange("bag", "contents"),
        cellChange("chest", "contents"),
      ]),
    );
    expect(host.cell("chest", "contents")).toEqual(list([ref("bag"), ref("coin")]));
    expect(host.cell("bag", "contents")).toEqual(list([ref("gem")]));
  });

  test("within a container reorders it", () => {
    const host = mutationHost();
    expect(host.move("gem", { type: "container", container: "bag", index: 0 })).toEqual([
      cellChange("bag", "contents"),
    ]);
    expect(host.cell("bag", "contents")).toEqual(list([ref("gem"), ref("coin")]));
  });

  test("within a container, the current length appends", () => {
    const host = mutationHost();
    expect(host.move("coin", { container: "bag", index: 2 })).toEqual([
      cellChange("bag", "contents"),
    ]);
    expect(host.cell("bag", "contents")).toEqual(list([ref("gem"), ref("coin")]));
    expect(host.move("coin", { container: "bag", index: 2 })).toEqual([]);
    expect(() => host.move("coin", { container: "bag", index: 3 })).toThrow();
  });

  test("lands one above the highest literal z even when all are negative", () => {
    const host = MemoryHost.fromSetup({
      boards: [{ id: "b" }],
      characters: [],
      objects: [
        { id: "low", placement: { board: "b", position: [0, 0] }, cells: { z: num(-5) } },
        { id: "lower", placement: { board: "b", position: [1, 0] }, cells: { z: num(-3) } },
        { id: "skipped", placement: { board: "b", position: [2, 0] }, cells: { z: formula("9") } },
        { id: "bag", placement: { board: "b", position: [3, 0] }, contents: ["coin"] },
        { id: "coin" },
      ],
    });
    host.set("bag", "z", num(-10));
    host.move("coin", { board: "b", position: [4, 4] });
    expect(host.cell("coin", "z")).toEqual(num(-2));
  });

  test("onto a board with only formula z elsewhere lands at 1", () => {
    const host = MemoryHost.fromSetup({
      boards: [{ id: "b" }, { id: "b2" }],
      characters: [],
      objects: [
        { id: "drift", placement: { board: "b", position: [0, 0] }, cells: { z: formula("9") } },
        { id: "coin", placement: { board: "b2", position: [0, 0] } },
      ],
    });
    host.move("coin", { board: "b", position: [1, 1] });
    expect(host.cell("coin", "z")).toEqual(num(1));
  });

  test("onto a board lands one above the highest literal z", () => {
    const host = mutationHost();
    const changes = host.move("coin", { type: "board", board: "table", position: [3, 3] });
    expect(sorted(changes)).toEqual(
      sorted([
        cellChange("coin", "board"),
        cellChange("coin", "container"),
        cellChange("coin", "position"),
        cellChange("coin", "z"),
        cellChange("bag", "contents"),
      ]),
    );
    // hero 3, token 7, chest and follower absent (0), drift a formula (skipped).
    expect(host.cell("coin", "z")).toEqual(num(8));
    expect(host.cell("coin", "board")).toEqual(ref("table"));
    expect(host.cell("coin", "container")).toEqual(EMPTY);
    expect(host.cell("coin", "position")).toEqual(list([num(3), num(3)]));
    expect(host.cell("coin", "rotation")).toEqual(EMPTY);
    expect(host.cell("bag", "contents")).toEqual(list([ref("gem")]));
  });

  test("an overridden formula z counts as literal when landing", () => {
    const host = mutationHost();
    host.override("drift", "z", num(20));
    host.move("coin", { board: "table", position: [3, 3] });
    expect(host.cell("coin", "z")).toEqual(num(21));
  });

  test("onto an empty board lands at z 1", () => {
    const host = mutationHost();
    host.move("coin", { board: "shelf", position: [0, 0] });
    expect(host.cell("coin", "z")).toEqual(num(1));
  });

  test("within a board puts the object on top and keeps rotation", () => {
    const host = mutationHost();
    expect(sorted(host.move("hero", { board: "table", position: [1, 2] }))).toEqual(
      sorted([cellChange("hero", "position"), cellChange("hero", "z")]),
    );
    expect(host.cell("hero", "z")).toEqual(num(8));
    expect(host.cell("hero", "rotation")).toEqual(num(45));
  });

  test("board to board keeps rotation", () => {
    const host = mutationHost();
    expect(sorted(host.move("hero", { board: "shelf", position: [1, 2] }))).toEqual(
      sorted([
        cellChange("hero", "board"),
        cellChange("hero", "position"),
        cellChange("hero", "z"),
      ]),
    );
    expect(host.cell("hero", "board")).toEqual(ref("shelf"));
    expect(host.cell("hero", "rotation")).toEqual(num(45));
    expect(host.cell("hero", "z")).toEqual(num(1));
  });

  test("a formula position gets an override; a formula z is left alone", () => {
    const host = mutationHost();
    expect(sorted(host.move("follower", { board: "table", position: [2, 2] }))).toEqual(
      sorted([cellChange("follower", "position"), cellChange("follower", "z")]),
    );
    expect(host.isOverridden("follower", "position")).toBe(true);
    expect(host.cell("follower", "position")).toEqual(list([num(2), num(2)]));

    expect(host.move("drift", { board: "table", position: [7, 7] })).toEqual([
      cellChange("drift", "position"),
    ]);
    expect(host.cell("drift", "z")).toEqual(formula("99"));
    expect(host.isOverridden("drift", "z")).toBe(false);
  });

  test("never changes owner", () => {
    const host = mutationHost();
    host.set("coin", "owner", ref("hero"));
    host.move("coin", { board: "table", position: [0, 0] });
    host.move("coin", { container: "chest" });
    expect(host.cell("coin", "owner")).toEqual(ref("hero"));
  });

  test("refuses a containment cycle and unknown destinations", () => {
    const host = mutationHost();
    expect(() => host.move("chest", { container: "coin" })).toThrow();
    expect(() => host.move("chest", { container: "chest" })).toThrow();
    expect(() => host.move("coin", { board: "nowhere", position: [0, 0] })).toThrow();
    expect(() => host.move("coin", { container: "bag", index: 5 })).toThrow();
  });
});

describe("createObject and deleteObject", () => {
  test("createObject on a board", () => {
    const host = mutationHost();
    expect(
      host.createObject("pawn", {
        cells: { hp: num(3) },
        tag: ["piece"],
        shape: { type: "circle", radius: 1 },
        placement: { board: "table", position: [2, 3] },
      }),
    ).toEqual([created("pawn")]);
    expect(host.exists("pawn")).toBe(true);
    expect(host.cell("pawn", "board")).toEqual(ref("table"));
    expect(host.cell("pawn", "position")).toEqual(list([num(2), num(3)]));
    expect(host.cell("pawn", "tag")).toEqual(list([text("piece")]));
    expect(host.cell("pawn", "shape")).toEqual(shape({ type: "circle", radius: 1 }));
    expect(host.cell("pawn", "is_zone")).toEqual(bool(false));
    expect(host.cell("pawn", "hp")).toEqual(num(3));
    expect(host.allObjects()).toContain("pawn");
    expect(host.objectsOnBoard("table", box)).toContain("pawn");
  });

  test("createObject in a container", () => {
    const host = mutationHost();
    expect(
      sorted(
        host.createObject("ring", { is_zone: true, placement: { container: "bag", index: 1 } }),
      ),
    ).toEqual(sorted([created("ring"), cellChange("bag", "contents")]));
    expect(host.cell("bag", "contents")).toEqual(list([ref("coin"), ref("ring"), ref("gem")]));
    expect(host.cell("ring", "container")).toEqual(ref("bag"));
    expect(host.cell("ring", "is_zone")).toEqual(bool(true));
    expect(host.cell("ring", "position")).toEqual(EMPTY);
  });

  test("createObject refuses an existing id and a formula name", () => {
    const host = mutationHost();
    expect(() => host.createObject("hero", { placement: { container: "bag" } })).toThrow();
    expect(() => host.createObject("table", { placement: { container: "bag" } })).toThrow();
    expect(() =>
      host.createObject("x", { cells: { name: formula('"x"') }, placement: { container: "bag" } }),
    ).toThrow(/name/);
  });

  test("deleteObject is recursive over contents", () => {
    const host = mutationHost();
    expect(sorted(host.deleteObject("bag"))).toEqual(
      sorted([deleted("bag"), deleted("coin"), deleted("gem"), cellChange("chest", "contents")]),
    );
    for (const id of ["bag", "coin", "gem"]) {
      expect(host.exists(id)).toBe(false);
      expect(host.cell(id, "id")).toBeUndefined();
    }
    expect(host.cell("chest", "contents")).toEqual(list([]));
    expect(host.allObjects()).not.toContain("coin");
  });

  test("deleteObject of an object on a board reports no parent", () => {
    const host = mutationHost();
    expect(host.deleteObject("token")).toEqual([deleted("token")]);
    expect(host.objectsOnBoard("table", box)).not.toContain("token");
    expect(() => host.deleteObject("token")).toThrow();
  });
});
