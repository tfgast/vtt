/**
 * The M6 example template amendments (vtt-nb8.5; DESIGN.md §4.7 as amended
 * by vtt-nb8.2, M6-D3; §8.4 steps 2, 4, 10, 11, 12, 14; FORMULAS.md §2.1;
 * M6 plan Q6, review r1 findings 2, 3, 6).
 *
 * Every flow runs on a Table from `stockedTableSnapshot()` through
 * `createExecutor({handlers: [...coreHandlers, ...placementHandlers]})` with
 * scripted dice. The only other writes are the GM's preparation (spawns and
 * cell edits) as the UI would make them; face visibility is read from the
 * GM's live object view (`faceElementVisible`, vtt-1xv.12).
 */
import {
  coreHandlers,
  createExecutor,
  DocumentStore,
  exampleObjects,
  type FaceElementRef,
  faceElementVisible,
  type InvokeOutcome,
  move,
  parseTable,
  placementHandlers,
  ScriptedDiceSource,
  serializeTable,
  setFormula,
  spawn,
  stockedTableSnapshot,
  Table,
  type Transaction,
  ViewBuilder,
  type Viewer,
  writeValue,
} from "@vtt/authority";
import {
  type Actor,
  EMPTY,
  type FaceElement,
  faceProblem,
  type ObjectId,
  type Result,
  type RollValue,
  ref,
  type Value,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";

const gm: Actor = { type: "gm" };
const GM: Viewer = { type: "gm" };
const executor = createExecutor({ handlers: [...coreHandlers, ...placementHandlers] });

const rolled = (expr: string, dice: number[]): RollValue => ({
  type: "roll",
  expr,
  dice,
  dropped: [],
  total: dice.reduce((a, b) => a + b, 0),
});

const n = (value: number): Value => ({ type: "number", value });
const TRUE = { type: "boolean", value: true };
const FALSE = { type: "boolean", value: false };

/** A Result as a plain number (a number, or a roll's total), for assertions. */
function numberOf(r: Result): number {
  if (r.type === "number") return r.value;
  if (r.type === "roll") return r.total;
  throw new Error(`not a number: ${JSON.stringify(r)}`);
}

/** A stocked table, scripted dice, and the GM's hands. */
function session(script: RollValue[] = []) {
  const table = Table.fromSnapshot(stockedTableSnapshot());
  const dice = new ScriptedDiceSource(script);

  /** One committed GM edit. */
  function prep<T>(label: string, fn: (tx: Transaction) => T): T {
    let out: T | undefined;
    const result = table.store.transact(gm, { kind: "edit", label }, (tx) => {
      out = fn(tx);
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return out as T;
  }
  const press = (object: ObjectId, action: string): InvokeOutcome =>
    executor.invokeAction(table, dice, { object, action, actor: gm });
  const ok = (object: ObjectId, action: string) => {
    const outcome = press(object, action);
    expect(outcome.ok, `${object} ${action}: ${JSON.stringify(outcome)}`).toBe(true);
    return outcome;
  };
  const onBoard = (template: ObjectId, x: number, y: number) =>
    prep(`spawn ${template}`, (tx) =>
      spawn(tx, template, { type: "board", board: "gm_board", position: [x, y] }),
    );
  /** The face element of `object` at `index` in `elements` whose kind and target match. */
  const element = (object: ObjectId, index: number, kind: string, target: string) => {
    const e = table.store.getObject(object)?.face?.elements[index] as FaceElement | undefined;
    expect(e?.type).toBe(kind);
    expect(e?.type === "button" ? e.action : e?.type === "contents" ? "" : e?.cell).toBe(target);
    return { list: "full", index } satisfies FaceElementRef;
  };
  const shown = (object: ObjectId, ref: FaceElementRef) =>
    faceElementVisible(table, GM, object, ref);
  const actionState = (object: ObjectId, action: string) =>
    new ViewBuilder(table, GM)
      .objectView(object, "all")
      ?.action_states?.find((s) => s.name === action);
  return { table, dice, prep, press, ok, onBoard, element, shown, actionState };
}

/** The face element indexes the amended records give (DESIGN.md §4.7). */
const TOKEN_HIT = 3;
const TOKEN_CONTENTS = 4;
const SHEET_NAME = 0;
const SHEET_OWNER = 1;
const ATTACK_APPLY = 7;
const ATTACK_DISCARD = 8;

describe("tpl_token: attack_bonus, dex_save, the HIT badge and a contents list", () => {
  test("a copy reads empty for dex_save and attack_bonus and has a hidden HIT badge", () => {
    const s = session();
    const token = s.onBoard("tpl_token", 10, 0).root;
    expect(s.table.value(token, "dex_save")).toEqual(EMPTY);
    expect(s.table.value(token, "attack_bonus")).toEqual(EMPTY);
    expect(s.table.value(token, "hit")).toEqual(FALSE);
    const face = s.table.store.getObject(token)?.face;
    expect(face?.elements.filter((e) => e.type === "contents")).toHaveLength(1);
    const hit = s.element(token, TOKEN_HIT, "value", "hit");
    expect(s.shown(token, hit)).toBe(false);
    expect(s.shown(token, s.element(token, TOKEN_CONTENTS, "contents", ""))).toBe(true);
  });

  test("the HIT badge formula shows the badge once a d20 on the token rolls 15 against ac 13", () => {
    const s = session([rolled("1d20", [15])]);
    const token = s.onBoard("tpl_token", 10, 0).root;
    s.prep("goblin", (tx) => {
      writeValue(tx, token, "ac", n(13));
      setFormula(tx, token, "hit", 'any(on(this).where(tag has "d20").total >= ac)');
    });
    const hit = s.element(token, TOKEN_HIT, "value", "hit");
    expect(s.shown(token, hit)).toBe(false);

    const d20 = s.onBoard("tpl_d20", 10, 0).root;
    expect(s.shown(token, hit)).toBe(false);
    s.ok(d20, "Roll");
    expect(numberOf(s.table.value(d20, "total"))).toBe(15);
    expect(s.table.value(token, "hit")).toEqual(TRUE);
    expect(s.shown(token, hit)).toBe(true);
    expect(s.dice.remaining()).toBe(0);
  });

  test("a d20 spawned into a token copy is appended to its contents", () => {
    const s = session();
    const token = s.onBoard("tpl_token", 10, 0).root;
    const first = s.prep("die", (tx) =>
      spawn(tx, "tpl_d20", { type: "container", container: token }),
    ).root;
    const second = s.prep("die", (tx) =>
      spawn(tx, "tpl_d20", { type: "container", container: token }),
    ).root;
    expect([...s.table.store.contentsOf(token)]).toEqual([first, second]);
  });
});

describe("tpl_sheet: an owned sheet's header shows its owner", () => {
  test("a character's sheet shows value owner and hides editor name; a loose sheet the reverse", () => {
    const s = session();
    const spawned = s.onBoard("tpl_character", 0, 0);
    const sheet = spawned.copies.get("tpl_character_sheet") as ObjectId;
    expect(s.table.value(sheet, "owner")).toEqual(ref(spawned.root));
    const name = s.element(sheet, SHEET_NAME, "editor", "name");
    const owner = s.element(sheet, SHEET_OWNER, "value", "owner");
    expect(s.shown(sheet, owner)).toBe(true);
    expect(s.shown(sheet, name)).toBe(false);

    const loose = s.onBoard("tpl_sheet", 20, 0).root;
    expect(s.table.value(loose, "owner")).toEqual(EMPTY);
    expect(s.shown(loose, s.element(loose, SHEET_NAME, "editor", "name"))).toBe(true);
    expect(s.shown(loose, s.element(loose, SHEET_OWNER, "value", "owner"))).toBe(false);
  });
});

describe("tpl_attack: Apply stays drawn, disabled with a reason; Discard is always drawn", () => {
  test("the Attack flow from the character's binder against a token copy", () => {
    const s = session([rolled("1d20", [12]), rolled("1d8", [6])]);
    const spawned = s.onBoard("tpl_character", 0, 0);
    const character = spawned.root;
    const sheet = spawned.copies.get("tpl_character_sheet") as ObjectId;
    const binder = spawned.copies.get("tpl_character_binder") as ObjectId;
    const binderAttack = spawned.copies.get("tpl_character_attack") as ObjectId;
    s.prep("sheet", (tx) => writeValue(tx, sheet, "attack_bonus", n(5)));
    const token = s.onBoard("tpl_token", 10, 0).root;
    s.prep("token", (tx) => {
      writeValue(tx, token, "ac", n(13));
      writeValue(tx, token, "max_hp", n(30));
    });

    const attack = s.prep("working copy", (tx) =>
      spawn(tx, binderAttack, { type: "container", container: binder, index: 1 }),
    ).root;
    expect(s.table.value(attack, "attacker")).toEqual(ref(character));
    s.prep("target", (tx) => writeValue(tx, attack, "target", ref(token)));
    const apply = s.element(attack, ATTACK_APPLY, "button", "Apply");
    const discard = s.element(attack, ATTACK_DISCARD, "button", "Discard");
    expect(s.shown(attack, apply)).toBe(false);
    expect(s.shown(attack, discard)).toBe(true);

    s.ok(attack, "Roll");
    expect(numberOf(s.table.value(attack, "total"))).toBe(17);
    expect(s.table.value(attack, "hit")).toEqual(TRUE);
    expect(s.shown(attack, apply)).toBe(false);
    s.ok(attack, "Roll damage");
    expect(s.shown(attack, apply)).toBe(true);
    expect(s.actionState(attack, "Apply")).toEqual({ name: "Apply", enabled: true });
    s.ok(attack, "Apply");
    expect(numberOf(s.table.value(token, "damage_taken"))).toBe(6);
    expect(numberOf(s.table.value(token, "hp"))).toBe(24);

    expect(s.shown(attack, apply)).toBe(true);
    expect(s.actionState(attack, "Apply")).toEqual({
      name: "Apply",
      enabled: false,
      reason: "when_false",
    });
    expect(s.press(attack, "Apply")).toMatchObject({
      ok: false,
      rejection: { type: "when_false", object: attack, action: "Apply" },
    });
    expect(numberOf(s.table.value(token, "damage_taken"))).toBe(6);

    expect(s.shown(attack, discard)).toBe(true);
    s.ok(attack, "Discard");
    expect(s.table.store.hasObject(attack)).toBe(false);
    expect([...s.table.store.contentsOf(binder)]).toEqual([binderAttack]);
    expect(s.dice.remaining()).toBe(0);
  });

  test("tpl_damage has the same Apply and Discard buttons", () => {
    const s = session([rolled("1d6", [4])]);
    const token = s.onBoard("tpl_token", 10, 0).root;
    const card = s.onBoard("tpl_damage", 0, 6).root;
    const apply = s.element(card, 5, "button", "Apply");
    const discard = s.element(card, 6, "button", "Discard");
    s.prep("target", (tx) => writeValue(tx, card, "target", ref(token)));
    expect(s.shown(card, apply)).toBe(false);
    expect(s.shown(card, discard)).toBe(true);
    s.ok(card, "Roll damage");
    s.ok(card, "Apply");
    expect(numberOf(s.table.value(token, "damage_taken"))).toBe(4);
    expect(s.shown(card, apply)).toBe(true);
    expect(s.actionState(card, "Apply")).toMatchObject({ enabled: false, reason: "when_false" });
    s.ok(card, "Discard");
    expect(s.table.store.hasObject(card)).toBe(false);
  });
});

describe("tpl_area_save against token copies whose dex_save is never set", () => {
  test("save_bonus is empty, empty is 0 in arithmetic, and Apply all adds half and full", () => {
    const damage = rolled("8d6", [3, 5, 2, 6, 4, 1, 6, 1]); // 28
    const s = session([damage, rolled("1d20", [15]), rolled("1d20", [12])]);
    const character = s.onBoard("tpl_character", 0, 0);
    const sheet = character.copies.get("tpl_character_sheet") as ObjectId;
    s.prep("sheet", (tx) => writeValue(tx, sheet, "spell_dc", n(14)));
    const tokenA = s.onBoard("tpl_token", 10, 0).root;
    const tokenB = s.onBoard("tpl_token", 11, 0).root;

    const spawnedCard = s.onBoard("tpl_area_save", 0, 6);
    const card = spawnedCard.root;
    const zone = spawnedCard.copies.get("tpl_area_save_zone") as ObjectId;
    s.prep("caster", (tx) => writeValue(tx, card, "caster", ref(character.root)));
    expect(numberOf(s.table.value(card, "dc"))).toBe(14);
    s.prep("zone", (tx) =>
      move(tx, zone, { type: "board", board: "gm_board", position: [10.5, 0] }),
    );
    expect(s.table.value(card, "targets")).toEqual({
      type: "list",
      items: [ref(tokenA), ref(tokenB)],
    });
    const applyAll = s.element(card, 7, "button", "Apply all");
    expect(s.shown(card, applyAll)).toBe(false);

    s.ok(card, "Lock targets");
    const rows = [...s.table.store.contentsOf(card)].filter((id) => id !== zone);
    expect(rows.map((r) => s.table.value(r, "target"))).toEqual([ref(tokenA), ref(tokenB)]);
    const [rowA, rowB] = rows as [ObjectId, ObjectId];
    for (const row of rows) expect(s.table.value(row, "save_bonus")).toEqual(EMPTY);

    s.ok(card, "Roll damage");
    expect(numberOf(s.table.value(card, "damage"))).toBe(28);
    expect(s.shown(card, applyAll)).toBe(true);
    expect(s.actionState(card, "Apply all")).toMatchObject({ enabled: false });
    s.ok(rowA, "Roll save");
    s.ok(rowB, "Roll save");
    const sum = (row: ObjectId) =>
      numberOf(s.table.engine.evaluate("save_roll + save_bonus", { thisId: row }));
    expect(sum(rowA)).toBe(15);
    expect(sum(rowB)).toBe(12);
    expect(s.table.value(rowA, "passed")).toEqual(TRUE);
    expect(s.table.value(rowB, "passed")).toEqual(FALSE);
    expect(numberOf(s.table.value(rowA, "damage_dealt"))).toBe(14);
    expect(numberOf(s.table.value(rowB, "damage_dealt"))).toBe(28);

    s.ok(card, "Apply all");
    expect(numberOf(s.table.value(tokenA, "damage_taken"))).toBe(14);
    expect(numberOf(s.table.value(tokenB, "damage_taken"))).toBe(28);
    expect(s.shown(card, applyAll)).toBe(true);
    expect(s.actionState(card, "Apply all")).toMatchObject({
      enabled: false,
      reason: "when_false",
    });
    expect(s.dice.remaining()).toBe(0);
  });
});

describe("the amended records", () => {
  test("every face passes faceProblem", () => {
    for (const o of Object.values(exampleObjects())) {
      if (o.face !== undefined) expect(faceProblem(o.face), o.id).toBeUndefined();
    }
  });

  test("the stocked snapshot round-trips through serializeTable and parseTable", () => {
    const file = serializeTable(DocumentStore.fromSnapshot(stockedTableSnapshot()), []);
    const parsed = parseTable(JSON.stringify(file));
    expect(parsed.store.toSnapshot()).toEqual(stockedTableSnapshot());
    expect(parsed.warnings).toEqual([]);
  });
});
