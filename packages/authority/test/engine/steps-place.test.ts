/**
 * Placement steps (vtt-1xv.9): `move`, `spawn` and `remove` with the
 * container, `board`, `beside` and `table` destinations, run through
 * `createExecutor({handlers: [...coreHandlers, ...placementHandlers]})`
 * (FORMULAS.md §3.1 landing rule, §8.1–§8.3, §10; DESIGN.md §4.1; M5-D4).
 */
import {
  coreHandlers,
  createExecutor,
  type InvokeOutcome,
  placementHandlers,
  ScriptedDiceSource,
  Table,
  type TableDestination,
} from "@vtt/authority";
import {
  type ActionDef,
  type Cell,
  EMPTY,
  list,
  num,
  ref,
  type TableObject,
  text,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, c, f, gm, obj, placed, snapshot, zone } from "./helpers";

const executor = createExecutor({ handlers: [...coreHandlers, ...placementHandlers] });

const yes = { type: "boolean", value: true } as const;
const no = { type: "boolean", value: false } as const;

function invoke(
  table: Table,
  object: string,
  action: string,
  tableDestination?: TableDestination,
): InvokeOutcome {
  const source = new ScriptedDiceSource([]);
  return executor.invokeAction(table, source, {
    object,
    action,
    actor: gm,
    ...(tableDestination === undefined ? {} : { tableDestination }),
  });
}

/** A table whose object `o` (on board `table` at the origin) has one action "Go" with `steps`. */
function tableWith(
  steps: string[],
  cells: Record<string, Cell> = {},
  extra: TableObject[] = [],
  boards: string[] = ["table"],
): Table {
  return Table.fromSnapshot(
    snapshot([placed("o", 0, 0, { cells, actions: [{ name: "Go", steps }] }), ...extra], boards),
  );
}

const go = (table: Table, tableDestination?: TableDestination) =>
  invoke(table, "o", "Go", tableDestination);

function expectOk(outcome: InvokeOutcome): asserts outcome is InvokeOutcome & { ok: true } {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
}

function expectStepError(outcome: InvokeOutcome, step: number, code?: string) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.step).toBe(step);
  expect(outcome.rejection).toMatchObject({ type: "step_error", object: "o", action: "Go", step });
  if (outcome.rejection.type !== "step_error") return;
  expect(outcome.rejection.code).toBe(code);
  expect(typeof outcome.rejection.message).toBe("string");
}

const position = (table: Table, id: string) => table.value(id, "position");
const contents = (table: Table, id: string) => table.store.contentsOf(id);
const exists = (table: Table, id: string) => table.store.hasObject(id);

// The Fireball card of FORMULAS §10 (DESIGN.md §4.7 `tpl_area_save`).

const fireballActions: ActionDef[] = [
  {
    name: "Lock targets",
    when: "not locked",
    steps: [
      "each(targets, spawn(save_row, this, {target: it, owner: it.owner}))",
      "set(locked, true)",
    ],
  },
  { name: "Discard", steps: ["remove(zone)", "remove(this)"] },
];

function fireballTable(): Table {
  const creature = (id: string, x: number, owner: string | null) =>
    placed(id, x, 0, {
      tag: ["creature"],
      cells: { owner: c(owner === null ? EMPTY : ref(owner)), damage_taken: c(num(0)) },
    });
  return Table.fromSnapshot(
    snapshot([
      placed("aldric", -20, 0, { is_character: true }),
      placed("bryn", -20, 4, { is_character: true }),
      placed("binder", -30, 0, { contents: ["tpl_save_row"] }),
      obj("tpl_save_row", {
        is_template: true,
        tag: ["save_row"],
        shape: { type: "rect", width: 2.5, height: 0.8 },
        cells: {
          name: c(text("Save")),
          owner: c(EMPTY),
          target: c(EMPTY),
          save_roll: c(EMPTY),
          card: f("container"),
        },
      }),
      zone("zone1", 0, 0, 6),
      creature("goblin2", 1, "bryn"),
      creature("goblin1", -1, "aldric"),
      creature("goblin3", 20, null),
      placed("fb1", 10, 10, {
        shape: { type: "rect", width: 2.5, height: 3.5 },
        cells: {
          name: c(text("Area save")),
          zone: c(ref("zone1")),
          save_row: c(ref("tpl_save_row")),
          locked: c(no),
          targets: f('contents(zone).where(tag has "creature")'),
          rows: f('contents.where(tag has "save_row")'),
        },
        actions: fireballActions,
      }),
    ]),
  );
}

describe("Fireball (FORMULAS §10)", () => {
  test("Lock targets spawns one row per target, in targets order, and returns them in created", () => {
    const table = fireballTable();
    const targets = table.value("fb1", "targets");
    expect(targets.type).toBe("list");
    if (targets.type !== "list") return;
    expect(targets.items).toHaveLength(2);

    const outcome = invoke(table, "fb1", "Lock targets");
    expectOk(outcome);
    expect(outcome.created).toHaveLength(2);
    expect(contents(table, "fb1")).toEqual(outcome.created);
    expect(table.value("fb1", "locked")).toEqual(yes);
    const owners: Record<string, string> = { goblin1: "aldric", goblin2: "bryn" };
    outcome.created.forEach((row, i) => {
      const target = targets.items[i];
      expect(target?.type).toBe("ref");
      if (target?.type !== "ref") return;
      expect(row).toMatch(/^tpl_save_row_\d+$/);
      expect(table.value(row, "target")).toEqual(target);
      expect(table.value(row, "owner")).toEqual(ref(owners[target.object] as string));
      expect(table.value(row, "template")).toEqual(ref("tpl_save_row"));
      expect(table.value(row, "card")).toEqual(ref("fb1"));
      expect(table.store.getObject(row)?.is_template).toBe(false);
    });
    expect(table.value("fb1", "rows")).toEqual(list(outcome.created.map((id) => ref(id))));
    // A second Lock targets is refused by its guard.
    expect(invoke(table, "fb1", "Lock targets")).toMatchObject({
      ok: false,
      rejection: { type: "when_false" },
    });
  });

  test("Discard removes the deployed zone and the card with its rows", () => {
    const table = fireballTable();
    const lock = invoke(table, "fb1", "Lock targets");
    expectOk(lock);
    const rows = lock.created;

    const outcome = invoke(table, "fb1", "Discard");
    expectOk(outcome);
    expect(outcome.created).toEqual([]);
    for (const id of ["zone1", "fb1", ...rows]) expect(exists(table, id)).toBe(false);
    for (const id of ["goblin1", "goblin2", "tpl_save_row", "binder"]) {
      expect(exists(table, id)).toBe(true);
    }
  });
});

describe("Draw (FORMULAS §10)", () => {
  function drawTable(): Table {
    return Table.fromSnapshot(
      snapshot([
        placed("aldric", 0, 0, { is_character: true, cells: { hand: c(ref("hand")) } }),
        placed("hand", 0, 5, { contents: ["h0"] }),
        obj("h0"),
        placed("deck", 5, 5, { contents: ["c1", "c2"] }),
        obj("c1"),
        obj("c2"),
        placed("drawer", 10, 5, {
          cells: { deck: c(ref("deck")), owner: c(ref("aldric")) },
          actions: [
            {
              name: "Draw",
              when: "len(deck.contents) > 0",
              steps: ["move(first(deck.contents), owner.hand)"],
            },
          ],
        }),
      ]),
    );
  }

  test("moves the first card of the deck to the end of the owner's hand; an empty deck is when_false", () => {
    const table = drawTable();
    expectOk(invoke(table, "drawer", "Draw"));
    expect(contents(table, "deck")).toEqual(["c2"]);
    expect(contents(table, "hand")).toEqual(["h0", "c1"]);
    expect(table.value("c1", "container")).toEqual(ref("hand"));

    expectOk(invoke(table, "drawer", "Draw"));
    expect(contents(table, "deck")).toEqual([]);
    expect(contents(table, "hand")).toEqual(["h0", "c1", "c2"]);

    expect(invoke(table, "drawer", "Draw")).toEqual({
      ok: false,
      rejection: { type: "when_false", object: "drawer", action: "Draw" },
    });
  });
});

describe("container destinations", () => {
  test("empty is #REF and a list is #TYPE", () => {
    const extra = [placed("bag", 5, 0), placed("t", 2, 0)];
    expectStepError(go(tableWith(["move(t, empty)"], { t: c(ref("t")) }, extra)), 0, "#REF");
    expectStepError(
      go(tableWith(["move(t, [bag])"], { t: c(ref("t")), bag: c(ref("bag")) }, extra)),
      0,
      "#TYPE",
    );
  });

  test("a move into a container drops position, rotation and z", () => {
    const table = tableWith(["move(t, bag)"], { t: c(ref("t")), bag: c(ref("bag")) }, [
      placed("bag", 5, 0),
      placed("t", 2, 0, { cells: { rotation: c(num(90)), z: c(num(3)) } }),
    ]);
    expectOk(go(table));
    expect(contents(table, "bag")).toEqual(["t"]);
    expect(Object.keys(table.store.getObject("t")?.cells ?? {})).toEqual([]);
    expect(table.value("t", "position")).toEqual(EMPTY);
  });

  test("a move into its own descendant is containment_cycle with the step index", () => {
    const table = tableWith(
      ["set(x, 1)", "move(bag, pouch)"],
      { bag: c(ref("bag")), pouch: c(ref("pouch")) },
      [placed("bag", 5, 0, { contents: ["pouch"] }), obj("pouch")],
    );
    const outcome = go(table);
    expect(outcome).toMatchObject({
      ok: false,
      step: 1,
      rejection: { type: "containment_cycle", object: "bag", container: "pouch" },
    });
    expect(table.store.getCell("o", "x")).toBeUndefined();
    expect(contents(table, "bag")).toEqual(["pouch"]);
  });
});

describe("board(b, p)", () => {
  const extra = () => [
    placed("token", 2, 0),
    obj("a", { board: "gm_map", cells: { position: at(0, 0), z: c(num(5)) } }),
    obj("b", { board: "gm_map", cells: { position: at(1, 0), z: c(num(2)) } }),
  ];

  test("board(gm_board, [3, 4]) places on top of that board (landing rule z)", () => {
    const table = tableWith(
      ["move(token, board(gm_board, [3, 4]))"],
      { token: c(ref("token")), gm_board: c(ref("gm_map")) },
      extra(),
      ["table", "gm_map"],
    );
    expectOk(go(table));
    expect(table.store.boardOf("token")).toBe("gm_map");
    expect(position(table, "token")).toEqual(list([num(3), num(4)]));
    expect(table.value("token", "z")).toEqual(num(6));
    expect(table.value("token", "board")).toEqual(ref("gm_map"));
  });

  test("a board read from another object's board cell works; a spawn lands on top too", () => {
    const table = tableWith(
      ['spawn(token, board(obj("a").board, [1, 1]))'],
      { token: c(ref("token")) },
      extra(),
      ["table", "gm_map"],
    );
    const outcome = go(table);
    expectOk(outcome);
    const [copy] = outcome.created;
    expect(copy).toMatch(/^token_\d+$/);
    expect(table.store.boardOf(copy as string)).toBe("gm_map");
    expect(position(table, copy as string)).toEqual(list([num(1), num(1)]));
    expect(table.value(copy as string, "z")).toEqual(num(6));
  });

  test("an object reference, empty or a missing board is #REF", () => {
    const cells = { token: c(ref("token")), goblin1: c(ref("goblin1")) };
    const more = [...extra(), placed("goblin1", 4, 0)];
    for (const dest of ["board(goblin1, [0, 0])", "board(empty, [0, 0])", "board(3, [0, 0])"]) {
      expectStepError(
        go(tableWith([`move(token, ${dest})`], cells, more, ["table", "gm_map"])),
        0,
        "#REF",
      );
    }
  });

  test("a position that is not two finite numbers is #TYPE", () => {
    const cells = { token: c(ref("token")), gm_board: c(ref("gm_map")) };
    for (const p of ["[1]", '[1, "a"]', "[1, 2, 3]", "5", "empty"]) {
      expectStepError(
        go(tableWith([`move(token, board(gm_board, ${p}))`], cells, extra(), ["table", "gm_map"])),
        0,
        "#TYPE",
      );
    }
  });

  test("an error in either argument refuses with its code", () => {
    const cells = { token: c(ref("token")), gm_board: c(ref("gm_map")) };
    expectStepError(
      go(tableWith(["move(token, board(1 / 0, [0, 0]))"], cells, extra(), ["table", "gm_map"])),
      0,
      "#DIV0",
    );
    expectStepError(
      go(
        tableWith(["move(token, board(gm_board, [1 / 0, 0]))"], cells, extra(), [
          "table",
          "gm_map",
        ]),
      ),
      0,
      "#DIV0",
    );
  });
});

describe("beside(r)", () => {
  const unit = { type: "rect", width: 1, height: 1 } as const;

  test("beside a token of width 1, a die of width 0.5 lands at x + 1.0, on top", () => {
    const table = tableWith(
      ["move(die, beside(token))"],
      { die: c(ref("die")), token: c(ref("token")) },
      [
        placed("token", 2, 3, { shape: unit, cells: { z: c(num(4)) } }),
        placed("bag", 9, 9, { contents: ["die"] }),
        obj("die", { shape: { type: "circle", radius: 0.25 } }),
      ],
    );
    expectOk(go(table));
    expect(table.store.boardOf("die")).toBe("table");
    expect(position(table, "die")).toEqual(list([num(3), num(3)]));
    expect(table.value("die", "z")).toEqual(num(5));
    expect(contents(table, "bag")).toEqual([]);
  });

  test("a spawn beside a token uses the template's width; shapeless counts as 0", () => {
    const table = tableWith(
      ["spawn(die, beside(token))", "spawn(dot, beside(token))"],
      { die: c(ref("die")), dot: c(ref("dot")), token: c(ref("token")) },
      [
        placed("token", 2, 3, { shape: unit }),
        placed("binder", 9, 9, { contents: ["die", "dot"] }),
        obj("die", { is_template: true, shape: { type: "rect", width: 0.5, height: 2 } }),
        obj("dot", { is_template: true }),
      ],
    );
    const outcome = go(table);
    expectOk(outcome);
    const [die, dot] = outcome.created as [string, string];
    expect(position(table, die)).toEqual(list([num(3), num(3)]));
    expect(position(table, dot)).toEqual(list([num(2.75), num(3)]));
  });

  test("beside a contained object uses its outermost on-board container", () => {
    const table = tableWith(
      ["move(die, beside(card))"],
      { die: c(ref("die")), card: c(ref("card")) },
      [
        placed("chest", 10, -2, {
          shape: { type: "rect", width: 3, height: 1 },
          contents: ["pouch"],
        }),
        obj("pouch", { shape: unit, contents: ["card"] }),
        obj("card", { shape: { type: "rect", width: 7, height: 1 } }),
        placed("die", 0, 5, { shape: { type: "circle", radius: 0.25 } }),
      ],
    );
    expectOk(go(table));
    // 10 + 3/2 + 0.5/2 + 0.25
    expect(position(table, "die")).toEqual(list([num(12), num(-2)]));
  });

  test("the width is that of the literal footprint bounds, rotation included", () => {
    const table = tableWith(
      ["move(die, beside(token))"],
      { die: c(ref("die")), token: c(ref("token")) },
      [
        placed("token", 0, 0, {
          shape: { type: "rect", width: 4, height: 1 },
          cells: { rotation: c(num(90)) },
        }),
        placed("die", 0, 5, { shape: { type: "circle", radius: 0.25 } }),
      ],
    );
    expectOk(go(table));
    const p = position(table, "die");
    expect(p.type).toBe("list");
    if (p.type !== "list") return;
    const [x, y] = p.items;
    expect(x?.type === "number" && x.value).toBeCloseTo(1);
    expect(y).toEqual(num(0));
  });

  test("beside an object moved earlier in the action uses where it now is", () => {
    const table = tableWith(
      ["move(token, board(this.board, [5, 5]))", "move(die, beside(token))"],
      { die: c(ref("die")), token: c(ref("token")) },
      [
        placed("token", 0, 0, { shape: unit }),
        placed("die", 0, 9, { shape: { type: "circle", radius: 0.25 } }),
      ],
    );
    expectOk(go(table));
    expect(position(table, "die")).toEqual(list([num(6), num(5)]));
  });

  test("beside(empty) is #REF and an error refuses with its code", () => {
    const extra = [placed("die", 0, 9)];
    expectStepError(
      go(tableWith(["move(die, beside(empty))"], { die: c(ref("die")) }, extra)),
      0,
      "#REF",
    );
    expectStepError(
      go(tableWith(["move(die, beside(1 / 0))"], { die: c(ref("die")) }, extra)),
      0,
      "#DIV0",
    );
  });
});

describe("table", () => {
  const extra = () => [
    placed("token", 2, 0),
    obj("a", { board: "gm_map", cells: { position: at(0, 0) } }),
  ];

  test("resolves to the invoker's board and viewport centre", () => {
    const table = tableWith(["move(token, table)"], { token: c(ref("token")) }, extra(), [
      "table",
      "gm_map",
    ]);
    expectOk(go(table, { board: "gm_map", position: [7, -2] }));
    expect(table.store.boardOf("token")).toBe("gm_map");
    expect(position(table, "token")).toEqual(list([num(7), num(-2)]));
    expect(table.value("token", "z")).toEqual(num(1));
  });

  test("without a tableDestination it is step_error without code", () => {
    const table = tableWith(
      ["set(x, 1)", "spawn(token, table)"],
      { token: c(ref("token")) },
      extra(),
      ["table", "gm_map"],
    );
    const outcome = go(table);
    expectStepError(outcome, 1, undefined);
    if (outcome.ok || outcome.rejection.type !== "step_error") return;
    expect(outcome.rejection.message).toBe(
      "the table destination needs the invoker's board and viewport centre",
    );
    expect(table.store.getCell("o", "x")).toBeUndefined();
  });

  test("a this.table cell is a container destination", () => {
    const table = tableWith(
      ["move(token, this.table)"],
      { token: c(ref("token")), table: c(ref("bag")) },
      [...extra(), placed("bag", 5, 5)],
      ["table", "gm_map"],
    );
    expectOk(go(table));
    expect(contents(table, "bag")).toEqual(["token"]);
  });
});

describe("spawn", () => {
  const extra = () => [
    placed("binder", 9, 9, { contents: ["tpl"] }),
    obj("tpl", {
      is_template: true,
      cells: { hp: c(num(7)), double: f("hp * 2"), note: c(EMPTY) },
    }),
    placed("bag", 5, 5),
  ];

  test("record values set the root's cells; created is in creation order", () => {
    const table = tableWith(
      ['spawn(tpl, bag, {note: "a", hp: 1 + 2})', "spawn(tpl, bag)"],
      { tpl: c(ref("tpl")), bag: c(ref("bag")) },
      extra(),
    );
    const outcome = go(table);
    expectOk(outcome);
    expect(outcome.created).toHaveLength(2);
    expect(contents(table, "bag")).toEqual(outcome.created);
    const [first, second] = outcome.created as [string, string];
    expect(table.value(first, "note")).toEqual(text("a"));
    expect(table.value(first, "hp")).toEqual(num(3));
    expect(table.value(first, "double")).toEqual(num(6));
    expect(table.value(second, "hp")).toEqual(num(7));
    expect(table.value(second, "note")).toEqual(EMPTY);
  });

  test("later steps read a spawned formula cell as empty", () => {
    const table = tableWith(
      [
        "spawn(tpl, bag)",
        "set(seen, last(bag.contents).double)",
        "set(hp_seen, last(bag.contents).hp)",
      ],
      { tpl: c(ref("tpl")), bag: c(ref("bag")) },
      extra(),
    );
    const outcome = go(table);
    expectOk(outcome);
    expect(table.value("o", "seen")).toEqual(EMPTY);
    expect(table.value("o", "hp_seen")).toEqual(num(7));
    expect(table.value(outcome.created[0] as string, "double")).toEqual(num(14));
  });

  test("a record value that is an error refuses with its code; a record value is #TYPE", () => {
    const cells = { tpl: c(ref("tpl")), bag: c(ref("bag")) };
    const t1 = tableWith(["spawn(tpl, bag, {hp: 1 / 0})"], cells, extra());
    expectStepError(go(t1), 0, "#DIV0");
    expect(contents(t1, "bag")).toEqual([]);
    expectStepError(go(tableWith(["spawn(tpl, bag, {hp: {a: 1}})"], cells, extra())), 0, "#TYPE");
  });

  test("a protected initial cell keeps the primitive's refusal type", () => {
    const outcome = go(
      tableWith(
        ["spawn(tpl, bag, {contents: []})"],
        { tpl: c(ref("tpl")), bag: c(ref("bag")) },
        extra(),
      ),
    );
    expect(outcome).toMatchObject({ ok: false, step: 0, rejection: { type: "protected_cell" } });
  });

  test("the template must be one reference to an existing object", () => {
    const cells = { bag: c(ref("bag")) };
    expectStepError(go(tableWith(["spawn(empty, bag)"], cells, extra())), 0, "#REF");
    expectStepError(go(tableWith(["spawn([bag], bag)"], cells, extra())), 0, "#TYPE");
  });
});

describe("remove", () => {
  test("a step after remove(x) reading x.hp is step_error #REF", () => {
    const table = tableWith(["remove(x)", "set(seen, x.hp)"], { x: c(ref("x")) }, [
      placed("x", 3, 3, { cells: { hp: c(num(5)) } }),
    ]);
    expectStepError(go(table), 1, "#REF");
    expect(exists(table, "x")).toBe(true);
  });

  test("removes the object and its contents, recursively; references dangle", () => {
    const table = tableWith(["remove(x)"], { x: c(ref("x")) }, [
      placed("x", 3, 3, { contents: ["y"] }),
      obj("y", { contents: ["z1"] }),
      obj("z1"),
    ]);
    expectOk(go(table));
    for (const id of ["x", "y", "z1"]) expect(exists(table, id)).toBe(false);
    expect(table.value("o", "x")).toMatchObject({ type: "error", code: "#REF" });
  });

  test("remove(empty) is #REF", () => {
    expectStepError(go(tableWith(["remove(empty)"])), 0, "#REF");
  });
});

describe("each", () => {
  test("each(list, move(it, bag)) appends in list order", () => {
    const table = tableWith(
      ["each([t2, t1], move(it, bag))"],
      { t1: c(ref("t1")), t2: c(ref("t2")), bag: c(ref("bag")) },
      [placed("bag", 5, 5), placed("t1", 1, 1), placed("t2", 2, 2)],
    );
    expectOk(go(table));
    expect(contents(table, "bag")).toEqual(["t2", "t1"]);
  });
});
