import {
  addBoard,
  clearOverride,
  DocumentStore,
  deleteCell,
  Rejected,
  renameBoard,
  renameCell,
  reorder,
  rollWrite,
  setCellVisibility,
  setCharacterFlag,
  setFormula,
  setShape,
  setTag,
  setTemplateFlag,
  type Transaction,
  writeValue,
} from "@vtt/authority";
import {
  type Actor,
  bool,
  type Cell,
  EMPTY,
  type Effect,
  list,
  num,
  type Rejection,
  type RollValue,
  ref,
  type Snapshot,
  text,
  type Value,
  type ViewersValue,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, lit, must, named, obj, table } from "./helpers";

const gm: Actor = { type: "gm" };
const edit = { kind: "edit", label: "edit" } as const;
const formula = (source: string): Cell => ({ content: { type: "formula", source } });
const gmOnly: ViewersValue = { type: "viewers", viewers: ["gm"] };
const ownerOnly: ViewersValue = { type: "viewers", viewers: ["owner"] };
const d20 = (n: number): RollValue => ({
  type: "roll",
  expr: "1d20",
  dice: [n],
  dropped: [],
  total: n,
});

/**
 * table() plus: `goblin` has `max_hp` 7, an `hp` formula, an overridden
 * `ac` formula, and a GM-only `ac`; `fog` is an opaque zone on the map.
 */
function scene(): Snapshot {
  const s = table();
  const goblin = must(s.objects.goblin);
  goblin.cells.max_hp = lit(7);
  goblin.cells.hp = formula("max_hp - damage_taken");
  goblin.cells.ac = { content: { type: "formula", source: "10 + dex" }, override: num(15) };
  goblin.cell_visibility.ac = gmOnly;
  s.objects.fog = obj("fog", {
    board: "map",
    is_zone: true,
    shape: { type: "rect", width: 4, height: 4 },
    cells: { position: at(0, 0), opaque: { content: bool(true) } },
  });
  return s;
}

/** Runs `fn` in a transaction and commits it, returning the committed effects. */
function run(store: DocumentStore, fn: (tx: Transaction) => void): readonly Effect[] {
  const result = store.transact(gm, edit, fn);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result.group.effects as readonly Effect[];
}

/**
 * Expects `fn` to throw Rejected with `rejection` inside an open transaction,
 * recording nothing, and the store to keep its document and history.
 */
function expectRefused(
  store: DocumentStore,
  fn: (tx: Transaction) => void,
  rejection: Partial<Rejection>,
): void {
  const before = store.toSnapshot();
  const historyBefore = store.history.nextIndex;
  const fresh = store.begin(gm, edit);
  const noChanges = fresh.changes();
  fresh.abort();
  const tx = store.begin(gm, edit);
  let thrown: unknown;
  try {
    fn(tx);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Rejected);
  expect((thrown as Rejected).rejection).toMatchObject(rejection);
  expect(tx.changes()).toEqual(noChanges);
  expect(tx.doc.toSnapshot()).toEqual(before);
  tx.abort();
  const result = store.transact(gm, edit, fn);
  expect(result.ok).toBe(false);
  expect(store.toSnapshot()).toEqual(before);
  expect(store.history.nextIndex).toBe(historyBefore);
}

const cellOf = (store: DocumentStore, id: string, cell: string) =>
  must(store.getObject(id)).cells[cell];

describe("writeValue", () => {
  test("a literal cell becomes the new literal", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = run(store, (tx) => writeValue(tx, "goblin", "max_hp", num(9)));
    expect(effects).toEqual([
      {
        type: "cell",
        object: "goblin",
        cell: "max_hp",
        before: lit(7),
        after: lit(9),
        cause: "edit",
      },
    ]);
    expect(cellOf(store, "goblin", "max_hp")).toEqual(lit(9));
  });

  test("an absent cell is created", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = run(store, (tx) => writeValue(tx, "goblin", "damage_taken", num(3)));
    expect(effects).toEqual([
      {
        type: "cell",
        object: "goblin",
        cell: "damage_taken",
        before: null,
        after: lit(3),
        cause: "edit",
      },
    ]);
    expect(cellOf(store, "goblin", "damage_taken")).toEqual(lit(3));
  });

  test("a formula cell gets an override; clearOverride restores formula tracking", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const hp = formula("max_hp - damage_taken");
    const overridden: Cell = { ...hp, override: num(4) };
    expect(run(store, (tx) => writeValue(tx, "goblin", "hp", num(4)))).toEqual([
      { type: "cell", object: "goblin", cell: "hp", before: hp, after: overridden, cause: "edit" },
    ]);
    expect(cellOf(store, "goblin", "hp")).toEqual(overridden);

    expect(run(store, (tx) => clearOverride(tx, "goblin", "hp"))).toEqual([
      { type: "cell", object: "goblin", cell: "hp", before: overridden, after: hp, cause: "edit" },
    ]);
    expect(cellOf(store, "goblin", "hp")).toEqual(hp);
  });

  test("writing over an override replaces it", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => writeValue(tx, "goblin", "ac", num(17)));
    expect(cellOf(store, "goblin", "ac")).toEqual({
      content: { type: "formula", source: "10 + dex" },
      override: num(17),
    });
  });

  test("a structural cell-backed write is type-checked", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => writeValue(tx, "goblin", "face_up", num(1)), {
      type: "type_error",
      object: "goblin",
      cell: "face_up",
    });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "name", EMPTY), { type: "type_error" });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "position", list([num(1)])), {
      type: "type_error",
    });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "template", text("x")), {
      type: "type_error",
    });
    run(store, (tx) => writeValue(tx, "goblin", "face_up", bool(false)));
    expect(cellOf(store, "goblin", "face_up")).toEqual({ content: bool(false) });
    run(store, (tx) => writeValue(tx, "goblin", "template", ref("bag")));
    expect(cellOf(store, "goblin", "template")).toEqual({ content: ref("bag") });
  });

  test("an override of a structural formula is type-checked", () => {
    const s = scene();
    must(s.objects.goblin).cells.face_up = formula("hp > 0");
    const store = DocumentStore.fromSnapshot(s);
    expectRefused(store, (tx) => writeValue(tx, "goblin", "face_up", text("no")), {
      type: "type_error",
    });
    run(store, (tx) => writeValue(tx, "goblin", "face_up", bool(false)));
    expect(cellOf(store, "goblin", "face_up")?.override).toEqual(bool(false));
  });

  test("position is writable on a board object only", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => writeValue(tx, "goblin", "position", list([num(3), num(4)])));
    expect(cellOf(store, "goblin", "position")).toEqual(at(3, 4));
    expectRefused(store, (tx) => writeValue(tx, "coin", "position", list([num(3), num(4)])), {
      type: "protected_cell",
      object: "coin",
      cell: "position",
    });
    expectRefused(store, (tx) => setFormula(tx, "coin", "position", "goblin.position"), {
      type: "protected_cell",
    });
  });

  test("opaque is writable on zones only", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => writeValue(tx, "fog", "opaque", bool(false)));
    expect(cellOf(store, "fog", "opaque")).toEqual({ content: bool(false) });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "opaque", bool(true)), {
      type: "protected_cell",
      object: "goblin",
      cell: "opaque",
    });
  });

  test("tag takes a list of text and becomes a field effect", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = run(store, (tx) =>
      writeValue(tx, "goblin", "tag", list([text("creature"), text("hostile")])),
    );
    expect(effects).toEqual([
      {
        type: "field",
        object: "goblin",
        field: "tag",
        before: ["creature"],
        after: ["creature", "hostile"],
      },
    ]);
    expect(must(store.getObject("goblin")).tag).toEqual(["creature", "hostile"]);
    expectRefused(store, (tx) => writeValue(tx, "goblin", "tag", list([num(1)])), {
      type: "type_error",
      cell: "tag",
    });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "tag", text("creature")), {
      type: "type_error",
    });
  });

  test("a value that is not storable is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const bad = { type: "error", code: "#REF" } as unknown as Value;
    expectRefused(store, (tx) => writeValue(tx, "goblin", "hp", bad), { type: "invalid" });
  });

  test("an unknown object or a bad cell name is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => writeValue(tx, "nobody", "hp", num(1)), { type: "invalid" });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "", num(1)), { type: "invalid" });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "__proto__", num(1)), {
      type: "invalid",
    });
    expectRefused(store, (tx) => writeValue(tx, "goblin", "is_template", bool(true)), {
      type: "invalid",
    });
  });

  test("a rename of name is captured in the group's names", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const result = store.transact(gm, edit, (tx) =>
      writeValue(tx, "goblin", "name", text("Grub")),
    );
    expect(result.ok && result.group.names).toEqual({ goblin: "Grub" });
  });
});

describe("protected cells", () => {
  const engineOnly = ["id", "board", "is_zone", "contents", "container"];
  const values: Record<string, Value> = {
    id: text("x"),
    board: ref("shelf"),
    is_zone: bool(true),
    contents: list([]),
    container: EMPTY,
    shape: { type: "shape", shape: { type: "circle", radius: 1 } },
  };

  for (const cell of engineOnly) {
    test(`every cell primitive refuses ${cell}`, () => {
      const store = DocumentStore.fromSnapshot(scene());
      const refusal = { type: "protected_cell", object: "bag", cell } as const;
      const value = must(values[cell]);
      expectRefused(store, (tx) => writeValue(tx, "bag", cell, value), refusal);
      expectRefused(store, (tx) => rollWrite(tx, "bag", cell, d20(3)), refusal);
      expectRefused(store, (tx) => setFormula(tx, "bag", cell, "1"), refusal);
      expectRefused(store, (tx) => clearOverride(tx, "bag", cell), refusal);
      expectRefused(store, (tx) => deleteCell(tx, "bag", cell), refusal);
      expectRefused(store, (tx) => renameCell(tx, "bag", cell, "other"), refusal);
      expectRefused(store, (tx) => renameCell(tx, "goblin", "hp", cell), {
        ...refusal,
        object: "goblin",
      });
    });
  }

  test("shape is refused through writeValue, setFormula and rollWrite", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const refusal = { type: "protected_cell", object: "fog", cell: "shape" } as const;
    expectRefused(store, (tx) => writeValue(tx, "fog", "shape", must(values.shape)), refusal);
    expectRefused(store, (tx) => setFormula(tx, "fog", "shape", "circle(2)"), refusal);
    expectRefused(store, (tx) => rollWrite(tx, "fog", "shape", d20(3)), refusal);
  });

  test("a protected write inside a transaction leaves earlier effects alone", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const tx = store.begin(gm, edit);
    writeValue(tx, "goblin", "max_hp", num(8));
    expect(() => writeValue(tx, "goblin", "id", text("x"))).toThrow(Rejected);
    const { group } = tx.commit();
    expect(group.effects).toHaveLength(1);
    expect(cellOf(store, "goblin", "max_hp")).toEqual(lit(8));
  });

  test("name, tag and template accept literals only", () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (const cell of ["name", "tag", "template"]) {
      expectRefused(store, (tx) => setFormula(tx, "goblin", cell, "owner.name"), {
        type: "type_error",
        object: "goblin",
        cell,
      });
    }
  });

  test("deleting a structural cell is protected_cell", () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (const cell of ["name", "position", "z", "tag", "shape", "id"]) {
      expectRefused(store, (tx) => deleteCell(tx, "goblin", cell), {
        type: "protected_cell",
        object: "goblin",
        cell,
      });
    }
  });
});

describe("setFormula", () => {
  test("replaces a literal with a formula", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = run(store, (tx) => setFormula(tx, "goblin", "max_hp", "2d8"));
    expect(effects).toEqual([
      {
        type: "cell",
        object: "goblin",
        cell: "max_hp",
        before: lit(7),
        after: formula("2d8"),
        cause: "edit",
      },
    ]);
  });

  test("drops any override", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => setFormula(tx, "goblin", "ac", "12 + dex"));
    expect(cellOf(store, "goblin", "ac")).toEqual(formula("12 + dex"));
  });

  test("creates an absent cell; allowed on formula-capable structural cells", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      setFormula(tx, "goblin", "bloodied", "hp < max_hp / 2");
      setFormula(tx, "goblin", "visible_to", "owner");
      setFormula(tx, "goblin", "position", "bag.position");
    });
    expect(cellOf(store, "goblin", "bloodied")).toEqual(formula("hp < max_hp / 2"));
    expect(cellOf(store, "goblin", "visible_to")).toEqual(formula("owner"));
    expect(cellOf(store, "goblin", "position")).toEqual(formula("bag.position"));
  });

  test("blank source is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => setFormula(tx, "goblin", "hp", "  "), { type: "invalid" });
  });
});

describe("clearOverride", () => {
  test("without an override is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => clearOverride(tx, "goblin", "hp"), { type: "invalid" });
    expectRefused(store, (tx) => clearOverride(tx, "goblin", "max_hp"), { type: "invalid" });
    expectRefused(store, (tx) => clearOverride(tx, "goblin", "missing"), { type: "invalid" });
  });

  test("removes the override and keeps the formula", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => clearOverride(tx, "goblin", "ac"));
    expect(cellOf(store, "goblin", "ac")).toEqual(formula("10 + dex"));
  });
});

describe("rollWrite", () => {
  test("writes the roll with cause roll", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = run(store, (tx) => rollWrite(tx, "goblin", "save", d20(14)));
    expect(effects).toEqual([
      {
        type: "cell",
        object: "goblin",
        cell: "save",
        before: null,
        after: { content: d20(14) },
        cause: "roll",
      },
    ]);
  });

  test("overrides a formula cell", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => rollWrite(tx, "goblin", "hp", d20(2)));
    expect(cellOf(store, "goblin", "hp")?.override).toEqual(d20(2));
  });

  test("a roll on a structural cell of another type is type_error", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => rollWrite(tx, "goblin", "face_up", d20(2)), {
      type: "type_error",
    });
  });
});

describe("deleteCell", () => {
  test("deletes a stored user cell", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const overridden = must(cellOf(store, "goblin", "ac"));
    expect(run(store, (tx) => deleteCell(tx, "goblin", "ac"))).toEqual([
      { type: "cell", object: "goblin", cell: "ac", before: overridden, after: null, cause: "edit" },
    ]);
    expect(cellOf(store, "goblin", "ac")).toBeUndefined();
    // Visibility is metadata of the object, independent of content.
    expect(store.getCellVisibility("goblin", "ac")).toEqual(gmOnly);
  });

  test("an absent cell is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => deleteCell(tx, "goblin", "missing"), { type: "invalid" });
  });
});

describe("renameCell", () => {
  test("deletes and creates in one group, moving the visibility entry", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const ac = must(cellOf(store, "goblin", "ac"));
    const effects = run(store, (tx) => renameCell(tx, "goblin", "ac", "armor"));
    expect(effects).toEqual([
      { type: "cell", object: "goblin", cell: "ac", before: ac, after: null, cause: "edit" },
      { type: "cell", object: "goblin", cell: "armor", before: null, after: ac, cause: "edit" },
      {
        type: "cell_visibility",
        object: "goblin",
        cell: "armor",
        before: null,
        after: gmOnly,
      },
      { type: "cell_visibility", object: "goblin", cell: "ac", before: gmOnly, after: null },
    ]);
    expect(cellOf(store, "goblin", "ac")).toBeUndefined();
    expect(cellOf(store, "goblin", "armor")).toEqual(ac);
    expect(store.getCellVisibility("goblin", "ac")).toBeUndefined();
    expect(store.getCellVisibility("goblin", "armor")).toEqual(gmOnly);
  });

  test("formulas naming the old name are not rewritten", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => renameCell(tx, "goblin", "max_hp", "hp_max"));
    expect(cellOf(store, "goblin", "hp")).toEqual(formula("max_hp - damage_taken"));
  });

  test("an absent target's own visibility entry is replaced by the source's", () => {
    const s = scene();
    must(s.objects.goblin).cell_visibility.armor = ownerOnly;
    const store = DocumentStore.fromSnapshot(s);
    const effects = run(store, (tx) => renameCell(tx, "goblin", "ac", "armor"));
    expect(effects.filter((e) => e.type === "cell_visibility")).toEqual([
      {
        type: "cell_visibility",
        object: "goblin",
        cell: "armor",
        before: ownerOnly,
        after: gmOnly,
      },
      { type: "cell_visibility", object: "goblin", cell: "ac", before: gmOnly, after: null },
    ]);
    expect(store.getCellVisibility("goblin", "armor")).toEqual(gmOnly);
  });

  test("an absent target's entry is removed when the source has none", () => {
    const s = scene();
    must(s.objects.goblin).cell_visibility.hp_max = ownerOnly;
    const store = DocumentStore.fromSnapshot(s);
    const effects = run(store, (tx) => renameCell(tx, "goblin", "max_hp", "hp_max"));
    expect(effects.filter((e) => e.type === "cell_visibility")).toEqual([
      {
        type: "cell_visibility",
        object: "goblin",
        cell: "hp_max",
        before: ownerOnly,
        after: null,
      },
    ]);
    expect(store.getCellVisibility("goblin", "hp_max")).toBeUndefined();
    expect(cellOf(store, "goblin", "hp_max")).toEqual(lit(7));
  });

  test("to container, to shape, and from name are protected_cell", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => renameCell(tx, "goblin", "hp", "container"), {
      type: "protected_cell",
      cell: "container",
    });
    expectRefused(store, (tx) => renameCell(tx, "goblin", "hp", "shape"), {
      type: "protected_cell",
      cell: "shape",
    });
    expectRefused(store, (tx) => renameCell(tx, "goblin", "name", "title"), {
      type: "protected_cell",
      cell: "name",
    });
  });

  test("onto an existing cell, or from an absent one, is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => renameCell(tx, "goblin", "hp", "max_hp"), { type: "invalid" });
    expectRefused(store, (tx) => renameCell(tx, "goblin", "missing", "other"), {
      type: "invalid",
    });
    expectRefused(store, (tx) => renameCell(tx, "goblin", "hp", "hp"), { type: "invalid" });
  });
});

describe("setCellVisibility", () => {
  test("on contents and tag of an object with no such stored cells", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = run(store, (tx) => {
      setCellVisibility(tx, "coin", "contents", gmOnly);
      setCellVisibility(tx, "coin", "tag", ownerOnly);
    });
    expect(effects).toEqual([
      { type: "cell_visibility", object: "coin", cell: "contents", before: null, after: gmOnly },
      { type: "cell_visibility", object: "coin", cell: "tag", before: null, after: ownerOnly },
    ]);
    expect(store.getCellVisibility("coin", "contents")).toEqual(gmOnly);

    expect(run(store, (tx) => setCellVisibility(tx, "coin", "contents", null))).toEqual([
      { type: "cell_visibility", object: "coin", cell: "contents", before: gmOnly, after: null },
    ]);
    expect(store.getCellVisibility("coin", "contents")).toBeUndefined();
    expect(must(store.getObject("coin")).cell_visibility).toEqual({ tag: ownerOnly });
  });

  test("valid for structural, derived and absent cells", () => {
    const store = DocumentStore.fromSnapshot(scene());
    run(store, (tx) => {
      for (const cell of ["id", "container", "shape", "position", "secret"]) {
        setCellVisibility(tx, "goblin", cell, gmOnly);
      }
    });
    expect(Object.keys(must(store.getObject("goblin")).cell_visibility).sort()).toEqual(
      ["ac", "container", "id", "position", "secret", "shape"].sort(),
    );
  });

  test("replaces an existing entry", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expect(run(store, (tx) => setCellVisibility(tx, "goblin", "ac", ownerOnly))).toEqual([
      { type: "cell_visibility", object: "goblin", cell: "ac", before: gmOnly, after: ownerOnly },
    ]);
  });

  test("clearing an entry that is not there records nothing", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expect(run(store, (tx) => setCellVisibility(tx, "goblin", "hp", null))).toEqual([]);
  });

  test("a value that is not a non-empty literal viewers value is type_error", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const empty = { type: "viewers", viewers: [] } as ViewersValue;
    expectRefused(store, (tx) => setCellVisibility(tx, "goblin", "hp", empty), {
      type: "type_error",
      object: "goblin",
      cell: "hp",
    });
    const notViewers = text("gm") as unknown as ViewersValue;
    expectRefused(store, (tx) => setCellVisibility(tx, "goblin", "hp", notViewers), {
      type: "type_error",
    });
  });

  test("an unknown object or bad cell name is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => setCellVisibility(tx, "nobody", "hp", gmOnly), {
      type: "invalid",
    });
    expectRefused(store, (tx) => setCellVisibility(tx, "goblin", "", gmOnly), {
      type: "invalid",
    });
  });
});

describe("field primitives", () => {
  test("setTag", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expect(run(store, (tx) => setTag(tx, "goblin", ["boss"]))).toEqual([
      { type: "field", object: "goblin", field: "tag", before: ["creature"], after: ["boss"] },
    ]);
    expect(must(store.getObject("goblin")).tag).toEqual(["boss"]);
    expectRefused(store, (tx) => setTag(tx, "goblin", [1 as unknown as string]), {
      type: "type_error",
      cell: "tag",
    });
  });

  test("setShape changes the shape with a field effect", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const circle = { type: "circle", radius: 3 } as const;
    expect(run(store, (tx) => setShape(tx, "fog", circle))).toEqual([
      {
        type: "field",
        object: "fog",
        field: "shape",
        before: { type: "rect", width: 4, height: 4 },
        after: circle,
      },
    ]);
    expect(must(store.getObject("fog")).shape).toEqual(circle);
    run(store, (tx) => setShape(tx, "goblin", { type: "rect", width: 1, height: 1 }));
    run(store, (tx) => setShape(tx, "goblin", null));
    expect(must(store.getObject("goblin")).shape).toBeNull();
    expectRefused(store, (tx) => setShape(tx, "fog", { type: "circle", radius: 0 }), {
      type: "type_error",
      cell: "shape",
    });
  });

  test("setTemplateFlag and setCharacterFlag", () => {
    const store = DocumentStore.fromSnapshot(scene());
    const effects = run(store, (tx) => {
      setTemplateFlag(tx, "goblin", true);
      setCharacterFlag(tx, "goblin", true);
    });
    expect(effects).toEqual([
      { type: "field", object: "goblin", field: "is_template", before: false, after: true },
      { type: "field", object: "goblin", field: "is_character", before: false, after: true },
    ]);
    const goblin = must(store.getObject("goblin"));
    expect([goblin.is_template, goblin.is_character]).toEqual([true, true]);
  });

  test("an unknown object is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expectRefused(store, (tx) => setTag(tx, "nobody", []), { type: "invalid" });
    expectRefused(store, (tx) => setShape(tx, "nobody", null), { type: "invalid" });
    expectRefused(store, (tx) => setTemplateFlag(tx, "nobody", true), { type: "invalid" });
    expectRefused(store, (tx) => setCharacterFlag(tx, "nobody", true), { type: "invalid" });
  });
});

describe("reorder", () => {
  test("new[i] = old[permutation[i]]", () => {
    const s = scene();
    s.objects.pearl = obj("pearl");
    must(s.objects.bag).contents.push("pearl");
    const store = DocumentStore.fromSnapshot(s);
    expect(run(store, (tx) => reorder(tx, "bag", [2, 0, 1]))).toEqual([
      {
        type: "reorder",
        container: "bag",
        before: ["coin", "gem", "pearl"],
        after: ["pearl", "coin", "gem"],
      },
    ]);
    expect(store.contentsOf("bag")).toEqual(["pearl", "coin", "gem"]);
  });

  test("anything but a permutation of the length is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (const p of [[0], [0, 1, 2], [0, 0], [1, 2], [0.5, 1], [-1, 0]]) {
      expectRefused(store, (tx) => reorder(tx, "bag", p), { type: "invalid" });
    }
    expectRefused(store, (tx) => reorder(tx, "nobody", []), { type: "invalid" });
  });
});

describe("boards", () => {
  test("addBoard records allocate plus board, leaving next_seq", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expect(run(store, (tx) => addBoard(tx, "cave", "Cave"))).toEqual([
      { type: "allocate", ids: ["cave"], seq_before: 5, seq_after: 5 },
      { type: "board", before: null, after: { id: "cave", name: "Cave" } },
    ]);
    expect(store.getBoard("cave")).toEqual({ id: "cave", name: "Cave" });
    expect(store.nextSeq).toBe(5);
    run(store, (tx) => addBoard(tx, "attic"));
    expect(store.getBoard("attic")).toEqual({ id: "attic" });
  });

  test("an id used by a live object, a live board, or retired is invalid", () => {
    const store = DocumentStore.fromSnapshot(scene());
    for (const id of ["goblin", "map", "old", "gm", "9lives", ""]) {
      expectRefused(store, (tx) => addBoard(tx, id), { type: "invalid" });
    }
  });

  test("renameBoard", () => {
    const store = DocumentStore.fromSnapshot(scene());
    expect(run(store, (tx) => renameBoard(tx, "map", "Dungeon"))).toEqual([
      { type: "board", before: { id: "map", name: "Map" }, after: { id: "map", name: "Dungeon" } },
    ]);
    expect(store.getBoard("map")).toEqual({ id: "map", name: "Dungeon" });
    expectRefused(store, (tx) => renameBoard(tx, "nowhere", "X"), { type: "invalid" });
  });
});
