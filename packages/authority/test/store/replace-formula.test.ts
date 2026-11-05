/**
 * `replaceFormula` (vtt-3l6.19; DESIGN.md §4.2; PROTOCOL.md §5 M4-D17): one
 * cell effect from a formula (and any override) to a literal, with
 * `writeValue`'s guards and type checks.
 */
import { DocumentStore, replaceFormula, undo, writeValue } from "@vtt/authority";
import { type Effect, list, num, ref, type Snapshot, text, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { must, obj, table } from "./helpers";
import { expectRefused, formula, gm, run } from "./structural-helpers";

const gmOnly: ViewersValue = { type: "viewers", viewers: ["gm"] };

/**
 * table() plus, on `goblin`, `bonus` (formula `1`, overridden by 3) and
 * `armor` (formula `10`, no override), and a fog zone `fog` on `map` whose
 * `visible_to` is the formula `owner`.
 */
function world(): Snapshot {
  const s = table();
  const goblin = must(s.objects.goblin);
  goblin.cells.hp = { content: { type: "formula", source: "10" }, override: num(4) };
  goblin.cells.armor = formula("10");
  const fog = obj("fog", {
    board: "map",
    is_zone: true,
    shape: { type: "rect", width: 4, height: 4 },
    cells: {
      position: { content: list([num(0), num(0)]) },
      opaque: { content: { type: "boolean", value: true } },
      visible_to: formula("owner"),
    },
  });
  return { ...s, objects: { ...s.objects, fog } };
}

const cellsOf = (effects: readonly Effect[]) => effects.filter((e) => e.type === "cell");

describe("replaceFormula", () => {
  test("an overridden user formula becomes a literal, no override, one cell effect", () => {
    const store = DocumentStore.fromSnapshot(world());
    const before = must(store.getObject("goblin")).cells.hp;
    const group = run(store, (tx) => replaceFormula(tx, "goblin", "hp", num(9)));
    expect(must(store.getObject("goblin")).cells.hp).toEqual({ content: num(9) });
    expect(group.effects).toEqual([
      {
        type: "cell",
        object: "goblin",
        cell: "hp",
        before,
        after: { content: num(9) },
        cause: "edit",
      },
    ]);
  });

  test("a formula without override becomes a literal", () => {
    const store = DocumentStore.fromSnapshot(world());
    const group = run(store, (tx) => replaceFormula(tx, "goblin", "armor", num(12)));
    expect(must(store.getObject("goblin")).cells.armor).toEqual({ content: num(12) });
    expect(cellsOf(group.effects as readonly Effect[])).toHaveLength(1);
  });

  test("a zone's visible_to formula becomes a literal viewers value", () => {
    const store = DocumentStore.fromSnapshot(world());
    const group = run(store, (tx) => replaceFormula(tx, "fog", "visible_to", gmOnly));
    expect(must(store.getObject("fog")).cells.visible_to).toEqual({ content: gmOnly });
    expect(group.effects).toEqual([
      {
        type: "cell",
        object: "fog",
        cell: "visible_to",
        before: formula("owner"),
        after: { content: gmOnly },
        cause: "edit",
      },
    ]);
  });

  test("undo restores the formula and the override", () => {
    const store = DocumentStore.fromSnapshot(world());
    const snapshot = store.toSnapshot();
    run(store, (tx) => replaceFormula(tx, "goblin", "hp", num(9)));
    expect(undo(store, gm).ok).toBe(true);
    expect(must(store.getObject("goblin")).cells.hp).toEqual({
      content: { type: "formula", source: "10" },
      override: num(4),
    });
    expect(store.toSnapshot().objects).toEqual(snapshot.objects);
  });

  test("undo restores a zone's visible_to formula", () => {
    const store = DocumentStore.fromSnapshot(world());
    run(store, (tx) => replaceFormula(tx, "fog", "visible_to", gmOnly));
    expect(undo(store, gm).ok).toBe(true);
    expect(must(store.getObject("fog")).cells.visible_to).toEqual(formula("owner"));
  });

  test("a later edit of the same cell makes that undo undo_conflict", () => {
    for (const [object, cell, value, later] of [
      ["goblin", "hp", num(9), num(2)],
      ["fog", "visible_to", gmOnly, { type: "viewers", viewers: ["all"] } as ViewersValue],
    ] as const) {
      const store = DocumentStore.fromSnapshot(world());
      const first = run(store, (tx) => replaceFormula(tx, object, cell, value)).index;
      const second = run(store, (tx) => writeValue(tx, object, cell, later)).index;
      const result = undo(store, gm, { type: "group", index: first });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.rejection).toMatchObject({ type: "undo_conflict", conflicting: [second] });
    }
  });

  test("on a literal or absent cell it behaves as writeValue", () => {
    for (const [cell, value] of [
      ["name", text("Hobgoblin")],
      ["hp_max", num(12)],
    ] as const) {
      const a = DocumentStore.fromSnapshot(world());
      const b = DocumentStore.fromSnapshot(world());
      const ga = run(a, (tx) => replaceFormula(tx, "goblin", cell, value));
      const gb = run(b, (tx) => writeValue(tx, "goblin", cell, value));
      expect(ga.effects).toEqual(gb.effects);
      expect(a.toSnapshot()).toEqual(b.toSnapshot());
    }
  });

  test("on tag it behaves as writeValue (a field effect)", () => {
    const a = DocumentStore.fromSnapshot(world());
    const b = DocumentStore.fromSnapshot(world());
    const tags = list([text("boss")]);
    const ga = run(a, (tx) => replaceFormula(tx, "goblin", "tag", tags));
    const gb = run(b, (tx) => writeValue(tx, "goblin", "tag", tags));
    expect(ga.effects).toEqual(gb.effects);
    expect(must(a.getObject("goblin")).tag).toEqual(["boss"]);
  });

  test("protected cells are refused protected_cell", () => {
    const store = DocumentStore.fromSnapshot(world());
    for (const cell of ["contents", "id", "container", "board", "is_zone"]) {
      expectRefused(store, (tx) => replaceFormula(tx, "bag", cell, list([])), {
        type: "protected_cell",
        object: "bag",
        cell,
      });
    }
  });

  test("structural type checks are writeValue's", () => {
    const store = DocumentStore.fromSnapshot(world());
    expectRefused(store, (tx) => replaceFormula(tx, "fog", "visible_to", num(1)), {
      type: "type_error",
      object: "fog",
      cell: "visible_to",
    });
    expectRefused(store, (tx) => replaceFormula(tx, "goblin", "position", ref("bag")), {
      type: "type_error",
    });
  });

  test("position and rotation formulas are replaced too", () => {
    const s = world();
    const goblin = must(s.objects.goblin);
    goblin.cells.position = formula("bag.position");
    goblin.cells.rotation = { content: { type: "formula", source: "45" }, override: num(90) };
    const store = DocumentStore.fromSnapshot(s);
    const point = list([num(2), num(3)]);
    const group = run(store, (tx) => {
      replaceFormula(tx, "goblin", "position", point);
      replaceFormula(tx, "goblin", "rotation", num(0));
    });
    expect(must(store.getObject("goblin")).cells.position).toEqual({ content: point });
    expect(must(store.getObject("goblin")).cells.rotation).toEqual({ content: num(0) });
    expect(cellsOf(group.effects as readonly Effect[])).toHaveLength(2);
  });

  test("an unknown object or a bad value is invalid", () => {
    const store = DocumentStore.fromSnapshot(world());
    expectRefused(store, (tx) => replaceFormula(tx, "nobody", "hp", num(1)), {
      type: "invalid",
    });
    expectRefused(store, (tx) => replaceFormula(tx, "goblin", "hp", { type: "nope" } as never), {
      type: "invalid",
    });
  });
});
