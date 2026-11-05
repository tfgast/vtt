import { DocumentStore, type Destination, spawn, touchedKeys } from "@vtt/authority";
import {
  type Cell,
  type Effect,
  EMPTY,
  list,
  num,
  ref,
  type Snapshot,
  text,
  type ViewersValue,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, lit, must, named, obj } from "./helpers";
import { expectRefused, formula, run } from "./structural-helpers";

const refCell = (id: string): Cell => ({ content: ref(id) });
const viewers = (...v: ViewersValue["viewers"]): ViewersValue => ({ type: "viewers", viewers: v });

/**
 * Shaped like fireball.json: `aldric_binder` on the shelf holds the `fireball`
 * card template, which owns `fireball_zone`, then `save_row_t`, which is
 * outside the card's subtree, then a `die` template. `aldric` is a character
 * on the map. next_seq is 5.
 */
function scene(): Snapshot {
  const objects = [
    obj("aldric", {
      board: "map",
      is_character: true,
      cells: {
        name: named("Aldric"),
        owner: refCell("aldric"),
        attack_bonus: lit(5),
        position: at(2, 10),
        z: lit(0),
      },
    }),
    obj("aldric_binder", {
      board: "shelf",
      contents: ["fireball", "save_row_t", "die"],
      cells: { name: named("Aldric's binder"), position: at(0, 0), owner: refCell("aldric") },
    }),
    obj("fireball", {
      is_template: true,
      tag: ["card", "fireball"],
      contents: ["fireball_zone"],
      cells: {
        name: named("Fireball"),
        caster: { content: EMPTY },
        zone: refCell("fireball_zone"),
        save_row: refCell("save_row_t"),
        dc: formula("caster.spell_dc"),
        aim: { content: { type: "formula", source: "zone" }, override: ref("fireball_zone") },
        pair: { content: list([ref("fireball_zone"), list([ref("aldric")])]) },
        seen_by: { content: viewers(ref("fireball_zone"), "gm") },
      },
      cell_visibility: {
        dc: viewers(ref("fireball_zone")),
        damage: viewers(ref("aldric"), "owner"),
      },
      actions: [{ name: "Lock targets", when: "not locked", steps: ["set(locked, true)"] }],
    }),
    obj("fireball_zone", {
      is_zone: true,
      tag: ["fireball_zone"],
      shape: { type: "circle", radius: 4 },
      cells: { name: named("Fireball area") },
    }),
    obj("save_row_t", {
      is_template: true,
      tag: ["save_row"],
      cells: { name: named("Save row"), target: { content: EMPTY } },
    }),
    obj("die", {
      is_template: true,
      cells: {
        name: named("d20"),
        value: { content: EMPTY },
        modifier: lit(0),
        total: formula("value + modifier"),
      },
    }),
  ];
  return {
    revision: 1,
    next_seq: 5,
    boards: [
      { id: "map", name: "Map" },
      { id: "shelf", name: "Binder shelf" },
    ],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

const binder: Destination = { type: "container", container: "aldric_binder" };
const onMap = (x: number, y: number): Destination => ({
  type: "board",
  board: "map",
  position: [x, y],
});

describe("spawn of a card template owning a zone", () => {
  test("copies the subtree, remaps internal references and keeps external ones", () => {
    const store = DocumentStore.fromSnapshot(scene());
    let result: ReturnType<typeof spawn> | undefined;
    run(store, (tx) => {
      result = spawn(tx, "fireball", binder);
    });
    const { root, copies } = must(result);
    expect(root).toBe("fireball_5");
    expect([...copies]).toEqual([
      ["fireball", "fireball_5"],
      ["fireball_zone", "fireball_zone_6"],
    ]);
    const card = must(store.getObject("fireball_5"));
    const zone = must(store.getObject("fireball_zone_6"));
    expect(card.contents).toEqual(["fireball_zone_6"]);
    expect(store.containerOf("fireball_zone_6")).toBe("fireball_5");
    expect(card.cells.zone).toEqual(refCell("fireball_zone_6"));
    expect(card.cells.save_row).toEqual(refCell("save_row_t"));
    expect(card.cells.aim).toEqual({
      content: { type: "formula", source: "zone" },
      override: ref("fireball_zone_6"),
    });
    expect(card.cells.pair).toEqual({
      content: list([ref("fireball_zone_6"), list([ref("aldric")])]),
    });
    expect(card.cells.seen_by).toEqual({ content: viewers(ref("fireball_zone_6"), "gm") });
    // Formula source is verbatim.
    expect(card.cells.dc).toEqual(formula("caster.spell_dc"));
    expect(card.cell_visibility).toEqual({
      dc: viewers(ref("fireball_zone_6")),
      damage: viewers(ref("aldric"), "owner"),
    });
    expect(card.cells.template).toEqual(refCell("fireball"));
    expect(zone.cells.template).toEqual(refCell("fireball_zone"));
    expect(card.is_template).toBe(false);
    expect(zone.is_template).toBe(false);
    expect(zone.is_zone).toBe(true);
    expect(zone.shape).toEqual({ type: "circle", radius: 4 });
    expect(zone.tag).toEqual(["fireball_zone"]);
    expect(card.tag).toEqual(["card", "fireball"]);
    expect(card.actions).toEqual(must(store.getObject("fireball")).actions);
    // The originals are untouched.
    expect(must(store.getObject("fireball")).cells.zone).toEqual(refCell("fireball_zone"));
    expect(store.contentsOf("aldric_binder")).toEqual([
      "fireball",
      "save_row_t",
      "die",
      "fireball_5",
    ]);
  });

  test("records one allocate with both ids and the next_seq change, and one create", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const group = run(store, (tx) => {
      spawn(tx, "fireball", binder);
    });
    const effects = group.effects as readonly Effect[];
    const allocates = effects.filter((e) => e.type === "allocate");
    expect(allocates).toEqual([
      { type: "allocate", ids: ["fireball_5", "fireball_zone_6"], seq_before: 5, seq_after: 7 },
    ]);
    const creates = effects.filter((e) => e.type === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      location: { type: "container", container: "aldric_binder", index: 3 },
    });
    expect((creates[0] as { objects: { id: string }[] }).objects.map((o) => o.id)).toEqual([
      "fireball_5",
      "fireball_zone_6",
    ]);
    expect(store.nextSeq).toBe(7);
    expect(effects.flatMap(touchedKeys)).toContain("cell:aldric_binder/contents");
  });

  test("ids skip a retired id and a live board's id", () => {
    const s = scene();
    s.retired_ids = ["fireball_5"];
    s.boards.push({ id: "fireball_zone_7" });
    const store = DocumentStore.fromSnapshot(s);
    const group = run(store, (tx) => {
      spawn(tx, "fireball", binder);
    });
    expect((group.effects as readonly Effect[]).find((e) => e.type === "allocate")).toEqual({
      type: "allocate",
      ids: ["fireball_6", "fireball_zone_8"],
      seq_before: 5,
      seq_after: 9,
    });
    expect(store.hasObject("fireball_6")).toBe(true);
    expect(store.hasObject("fireball_zone_8")).toBe(true);
  });

  test("a descendant template stays a template", () => {
    const s = scene();
    must(s.objects.fireball_zone).is_template = true;
    const store = DocumentStore.fromSnapshot(s);
    run(store, (tx) => {
      spawn(tx, "fireball", binder);
    });
    expect(must(store.getObject("fireball_5")).is_template).toBe(false);
    expect(must(store.getObject("fireball_zone_6")).is_template).toBe(true);
  });

  test("is_character is copied", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      spawn(tx, "aldric", binder);
    });
    expect(must(store.getObject("aldric_5")).is_character).toBe(true);
  });

  test("two spawns into one container in one transaction append in call order", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      spawn(tx, "save_row_t", { type: "container", container: "fireball" });
      spawn(tx, "save_row_t", { type: "container", container: "fireball" });
    });
    expect(store.contentsOf("fireball")).toEqual(["fireball_zone", "save_row_t_5", "save_row_t_6"]);
  });

  test("a container destination with an index inserts there", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      spawn(tx, "save_row_t", { type: "container", container: "aldric_binder", index: 1 });
    });
    expect(store.contentsOf("aldric_binder")).toEqual([
      "fireball",
      "save_row_t_5",
      "save_row_t",
      "die",
    ]);
  });
});

describe("spawn onto a board", () => {
  test("lands the root at the position, on top", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      spawn(tx, "fireball_zone", onMap(10, 10));
    });
    const zone = must(store.getObject("fireball_zone_5"));
    expect(zone.board).toBe("map");
    expect(zone.cells.position).toEqual(at(10, 10));
    expect(zone.cells.z).toEqual(lit(1));
    expect(store.containerOf("fireball_zone_5")).toBeNull();
  });

  test("spawning a board object into a container drops its placement cells", () => {
    const s = scene();
    must(s.objects.aldric).cells.rotation = lit(45);
    const store = DocumentStore.fromSnapshot(s);
    run(store, (tx) => {
      spawn(tx, "aldric", binder);
    });
    const copy = must(store.getObject("aldric_5"));
    expect(copy.board).toBeNull();
    expect(copy.cells.position).toBeUndefined();
    expect(copy.cells.rotation).toBeUndefined();
    expect(copy.cells.z).toBeUndefined();
  });

  test("board to board keeps the template's rotation", () => {
    const s = scene();
    must(s.objects.aldric).cells.rotation = lit(45);
    const store = DocumentStore.fromSnapshot(s);
    run(store, (tx) => {
      spawn(tx, "aldric", { type: "board", board: "shelf", position: [1, 1] });
    });
    const copy = must(store.getObject("aldric_5"));
    expect(copy.cells.rotation).toEqual(lit(45));
    expect(copy.cells.position).toEqual(at(1, 1));
    expect(copy.cells.z).toEqual(lit(1));
  });
});

describe("initial cells", () => {
  test("a formula initial cell replaces a copied literal at the stored level", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      spawn(tx, "die", onMap(3, 3), {
        owner: ref("aldric"),
        modifier: { type: "formula", source: "owner.attack_bonus" },
      });
    });
    const die = must(store.getObject("die_5"));
    expect(die.cells.modifier).toEqual(formula("owner.attack_bonus"));
    expect(die.cells.owner).toEqual(refCell("aldric"));
    expect(die.cells.total).toEqual(formula("value + modifier"));
  });

  test("a literal initial cell replaces a copied formula", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      spawn(tx, "fireball", binder, { dc: num(15), caster: ref("aldric") });
    });
    const card = must(store.getObject("fireball_5"));
    expect(card.cells.dc).toEqual(lit(15));
    expect(card.cells.caster).toEqual(refCell("aldric"));
  });

  test("an initial cell may create a cell and set tag", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      spawn(tx, "save_row_t", binder, { note: text("hi"), tag: list([text("row")]) });
    });
    const row = must(store.getObject("save_row_t_5"));
    expect(row.cells.note).toEqual({ content: text("hi") });
    expect(row.tag).toEqual(["row"]);
  });

  test("protected or ill-typed initial cells are refused, recording nothing", () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (const cell of ["contents", "id", "board", "is_zone", "container", "shape"]) {
      expectRefused(store, (tx) => spawn(tx, "fireball", binder, { [cell]: EMPTY }), {
        type: "protected_cell",
        cell,
      });
      expectRefused(
        store,
        (tx) => spawn(tx, "fireball", binder, { [cell]: { type: "formula", source: "1" } }),
        { type: "protected_cell", cell },
      );
    }
    expectRefused(store, (tx) => spawn(tx, "fireball", binder, { position: list([num(1)]) }), {
      type: "protected_cell",
      cell: "position",
    });
    expectRefused(store, (tx) => spawn(tx, "fireball", binder, { opaque: { type: "boolean", value: true } }), {
      type: "protected_cell",
      cell: "opaque",
    });
    expectRefused(store, (tx) => spawn(tx, "fireball", binder, { name: num(1) }), {
      type: "type_error",
      cell: "name",
    });
    expectRefused(
      store,
      (tx) => spawn(tx, "fireball", binder, { name: { type: "formula", source: "1" } }),
      { type: "type_error", cell: "name" },
    );
    expectRefused(
      store,
      (tx) => spawn(tx, "fireball", binder, { x: { type: "formula", source: " " } }),
      { type: "invalid" },
    );
    expectRefused(store, (tx) => spawn(tx, "fireball", binder, { is_template: EMPTY }), {
      type: "invalid",
    });
    expectRefused(store, (tx) => spawn(tx, "fireball", binder, { x: { type: "bogus" } as never }), {
      type: "invalid",
    });
  });

  test("an unknown template or destination is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => spawn(tx, "nothing", binder), { type: "invalid" });
    expectRefused(store, (tx) => spawn(tx, "fireball", { type: "container", container: "map" }), {
      type: "invalid",
    });
    expectRefused(
      store,
      (tx) => spawn(tx, "fireball", { type: "container", container: "aldric_binder", index: 4 }),
      { type: "invalid" },
    );
    expectRefused(
      store,
      (tx) => spawn(tx, "fireball", { type: "board", board: "nowhere", position: [0, 0] }),
      { type: "invalid" },
    );
  });
});
