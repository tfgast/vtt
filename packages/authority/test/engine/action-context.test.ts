/**
 * ActionContext (vtt-75c.15): the EvalEnv an action's steps read through
 * (FORMULAS.md §8.1, "Reads inside an action"; §6 candidate sets).
 */
import {
  ActionContext,
  createObject,
  move,
  remove,
  setFormula,
  spawn,
  Table,
  writeValue,
} from "@vtt/authority";
import { evaluate, parse } from "@vtt/formula";
import { type Bounds, EMPTY, list, num, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, edit, f, gm, obj, placed, snapshot, zone } from "./helpers";

const errCode = (r: { type: string; code?: string } | undefined) =>
  r?.type === "error" ? r.code : undefined;

const everywhere: Bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };

/**
 * goblin on the table with hp = max_hp - damage_taken; a template inside a
 * box with a literal, an overridden formula and a plain formula; a bag
 * holding three cards; an empty deck; a note referring to the goblin; a
 * zone at (20, 20) and a token with formula geometry.
 */
function fixture(): Table {
  return Table.fromSnapshot(
    snapshot([
      placed("goblin", 0, 0, {
        cells: {
          name: c(text("Goblin")),
          max_hp: c(num(7)),
          damage_taken: c(num(0)),
          hp: f("max_hp - damage_taken"),
        },
      }),
      placed("box", 50, 50, { contents: ["token_t"] }),
      obj("token_t", {
        is_template: true,
        cells: {
          bonus: c(num(3)),
          max_hp: c(num(6)),
          hp: { content: { type: "formula", source: "max_hp - 1" }, override: num(5) },
          calc: f("1 + 1"),
        },
      }),
      placed("bag", 30, 0, { contents: ["card_a", "card_b", "card_c"] }),
      obj("card_a"),
      obj("card_b"),
      obj("card_c"),
      placed("deck", 40, 0),
      placed("note", 60, 0, { cells: { who: c(ref("goblin")) } }),
      zone("tray", 20, 20, 4),
      placed("drifter", 500, 500, { cells: { position: f("[x, 0]"), x: c(num(900)) } }),
    ]),
  );
}

function begin(table: Table) {
  const tx = table.store.begin(gm, edit);
  return { tx, ctx: new ActionContext(table, tx) };
}

describe("reads inside an action", () => {
  test("a written cell reads as written", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    expect(ctx.read("goblin", "damage_taken")).toEqual(num(0));
    writeValue(tx, "goblin", "damage_taken", num(3));
    expect(ctx.read("goblin", "damage_taken")).toEqual(num(3));
  });

  test("an unwritten formula cell reads its start-of-action value after a write to its input", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    writeValue(tx, "goblin", "damage_taken", num(3));
    expect(ctx.read("goblin", "hp")).toEqual(num(7));
    tx.commit();
    expect(table.value("goblin", "hp")).toEqual(num(4));
  });

  test("a same-value write still reads from the working copy", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    writeValue(tx, "goblin", "damage_taken", num(0));
    expect(tx.changes().writtenCells).toHaveLength(1);
    expect(ctx.read("goblin", "damage_taken")).toEqual(num(0));
  });

  test("a formula cell an earlier step overrode reads as the override", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    writeValue(tx, "goblin", "hp", num(99));
    expect(ctx.read("goblin", "hp")).toEqual(num(99));
  });

  test("a cell replaced by a formula in the action reads empty", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    setFormula(tx, "goblin", "max_hp", "3 + 4");
    expect(ctx.read("goblin", "max_hp")).toEqual(EMPTY);
  });

  test("an absent cell is undefined, before and after a write elsewhere", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    expect(ctx.read("goblin", "nope")).toBeUndefined();
    writeValue(tx, "goblin", "damage_taken", num(1));
    expect(ctx.read("goblin", "nope")).toBeUndefined();
    writeValue(tx, "goblin", "fresh", num(2));
    expect(ctx.read("goblin", "fresh")).toEqual(num(2));
  });

  test("unwritten cells read as table.value at the start of the action", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    writeValue(tx, "goblin", "damage_taken", num(2));
    for (const [o, cell] of [
      ["goblin", "max_hp"],
      ["goblin", "hp"],
      ["goblin", "position"],
      ["drifter", "position"],
      ["bag", "contents"],
      ["card_a", "container"],
      ["goblin", "visible_to"],
    ] as const) {
      expect(ctx.read(o, cell), `${o}.${cell}`).toEqual(table.value(o, cell));
    }
  });
});

describe("objects created in the action", () => {
  test("a spawned object's formula cell reads empty; copied literal and override read as copied", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    const { root } = spawn(tx, "token_t", { type: "board", board: "table", position: [2, 2] });
    expect(ctx.exists(root)).toBe(true);
    expect(ctx.read(root, "calc")).toEqual(EMPTY);
    expect(ctx.read(root, "bonus")).toEqual(num(3));
    expect(ctx.read(root, "hp")).toEqual(num(5));
    expect(ctx.read(root, "template")).toEqual(ref("token_t"));
    expect(ctx.read(root, "board")).toEqual(ref("table"));
    expect(ctx.read(root, "position")).toEqual(list([num(2), num(2)]));
    expect(ctx.read(root, "contents")).toEqual(list([]));
    expect(ctx.read(root, "nope")).toBeUndefined();
  });

  test("a spawned object's initial formula cell reads empty, an initial literal as written", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    const { root } = spawn(
      tx,
      "token_t",
      { type: "container", container: "deck" },
      { bonus: { type: "formula", source: "2 * 2" }, label: text("x") },
    );
    expect(ctx.read(root, "bonus")).toEqual(EMPTY);
    expect(ctx.read(root, "label")).toEqual(text("x"));
    expect(ctx.read("deck", "contents")).toEqual(list([ref(root)]));
    expect(ctx.read(root, "container")).toEqual(ref("deck"));
  });

  test("a created object reads from the working copy", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    const id = createObject(
      tx,
      { cells: { n: c(num(1)), g: f("n + 1") } },
      { type: "board", board: "table", position: [1, 1] },
    );
    expect(ctx.exists(id)).toBe(true);
    expect(ctx.read(id, "n")).toEqual(num(1));
    expect(ctx.read(id, "g")).toEqual(EMPTY);
    expect(ctx.allObjects()).toContain(id);
  });
});

describe("moves inside the action", () => {
  test("after a move onto the board, the moved object and its old container read as moved", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    move(tx, "card_a", { type: "board", board: "table", position: [5, 5] });
    expect(ctx.read("card_a", "position")).toEqual(list([num(5), num(5)]));
    expect(ctx.read("card_a", "board")).toEqual(ref("table"));
    expect(ctx.read("card_a", "container")).toEqual(EMPTY);
    expect(ctx.read("bag", "contents")).toEqual(list([ref("card_b"), ref("card_c")]));
  });

  test("after a move between containers, both containers' contents read as moved", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    move(tx, "card_b", { type: "container", container: "deck" });
    expect(ctx.read("card_b", "container")).toEqual(ref("deck"));
    expect(ctx.read("card_b", "board")).toEqual(EMPTY);
    expect(ctx.read("card_b", "position")).toEqual(EMPTY);
    expect(ctx.read("bag", "contents")).toEqual(list([ref("card_a"), ref("card_c")]));
    expect(ctx.read("deck", "contents")).toEqual(list([ref("card_b")]));
  });

  test("a board object moved off the board reads its new board position", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    move(tx, "goblin", { type: "container", container: "deck" });
    expect(ctx.read("goblin", "board")).toEqual(EMPTY);
    expect(ctx.read("goblin", "position")).toEqual(EMPTY);
    expect(ctx.read("goblin", "container")).toEqual(ref("deck"));
    expect(ctx.objectsOnBoard("table", everywhere)).not.toContain("goblin");
  });
});

describe("existence", () => {
  test("write, then remove, then read of the same object is #REF", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    writeValue(tx, "goblin", "damage_taken", num(3));
    remove(tx, "goblin");
    expect(ctx.exists("goblin")).toBe(false);
    expect(errCode(ctx.read("goblin", "damage_taken"))).toBe("#REF");
    expect(errCode(ctx.read("goblin", "hp"))).toBe("#REF");
    expect(errCode(ctx.read("goblin", "nope"))).toBe("#REF");
  });

  test("a reference to an object removed in the action reads #REF", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    expect(ctx.read("note", "who")).toEqual(ref("goblin"));
    remove(tx, "goblin");
    expect(errCode(ctx.read("note", "who"))).toBe("#REF");
  });

  test("removing a container removes its contents for the action", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    remove(tx, "bag");
    for (const id of ["bag", "card_a", "card_b", "card_c"]) expect(ctx.exists(id)).toBe(false);
    expect(ctx.allObjects()).not.toContain("card_b");
  });

  test("an object neither present at the start nor created does not exist", () => {
    const table = fixture();
    const { ctx } = begin(table);
    expect(ctx.exists("ghost")).toBe(false);
    expect(errCode(ctx.read("ghost", "hp"))).toBe("#REF");
  });

  test("boards exist; created and removed objects follow the action", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    expect(ctx.exists("table")).toBe(true);
    const { root } = spawn(tx, "token_t", { type: "board", board: "table", position: [2, 2] });
    expect(ctx.exists(root)).toBe(true);
    remove(tx, root);
    expect(ctx.exists(root)).toBe(false);
    expect(errCode(ctx.read(root, "bonus"))).toBe("#REF");
  });
});

describe("queries over the working copy", () => {
  test("objectsOnBoard includes a spawned object and excludes a removed one", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    const near: Bounds = { minX: -3, minY: -3, maxX: 3, maxY: 3 };
    expect(ctx.objectsOnBoard("table", near).sort()).toEqual(["drifter", "goblin"]);
    const { root } = spawn(tx, "token_t", { type: "board", board: "table", position: [2, 2] });
    remove(tx, "goblin");
    expect(ctx.objectsOnBoard("table", near).sort()).toEqual(["drifter", root].sort());
  });

  test("objectsOnBoard equals the committed index's candidate set when nothing changed", () => {
    const table = fixture();
    const { ctx } = begin(table);
    for (const near of [
      everywhere,
      { minX: 18, minY: 18, maxX: 19, maxY: 19 },
      { minX: 100, minY: 100, maxX: 200, maxY: 200 },
    ]) {
      expect(ctx.objectsOnBoard("table", near).sort()).toEqual(
        table.index.candidates("table", near).sort(),
      );
    }
    expect(ctx.objectsOnBoard("nowhere", everywhere)).toEqual([]);
  });

  test("formula geometry is always a candidate; a moved object is found where it now is", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    const far: Bounds = { minX: 300, minY: 300, maxX: 301, maxY: 301 };
    expect(ctx.objectsOnBoard("table", far)).toEqual(["drifter"]);
    move(tx, "card_c", { type: "board", board: "table", position: [300, 300] });
    expect(ctx.objectsOnBoard("table", far).sort()).toEqual(["card_c", "drifter"]);
  });

  test("objectsNamed and allObjects read the working copy", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    expect(ctx.objectsNamed("Goblin")).toEqual(["goblin"]);
    writeValue(tx, "goblin", "name", text("Bob"));
    writeValue(tx, "note", "name", text("Goblin"));
    expect(ctx.objectsNamed("Goblin")).toEqual(["note"]);
    expect(ctx.objectsNamed("Bob")).toEqual(["goblin"]);
    remove(tx, "note");
    expect(ctx.objectsNamed("Goblin")).toEqual([]);
    expect(ctx.allObjects()).not.toContain("note");
  });

  test("the evaluator reads geometry through the context: zones_containing follows a move", () => {
    const table = fixture();
    const { tx, ctx } = begin(table);
    const zones = () => {
      const parsed = parse("zones_containing(this)");
      if (!parsed.ok) throw new Error(parsed.message);
      return evaluate(parsed.ast, { thisId: "card_a" }, ctx);
    };
    expect(zones()).toEqual(list([]));
    move(tx, "card_a", { type: "board", board: "table", position: [20, 20] });
    expect(zones()).toEqual(list([ref("tray")]));
  });
});
