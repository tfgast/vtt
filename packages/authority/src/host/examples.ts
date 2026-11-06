/**
 * The example templates (DESIGN.md §4.7 Example templates, §8.1; §7 New
 * tables and ownership; M5-D19): the GM binder that `vtt-serve` stocks into
 * a new table, holding a die, a token, a zone, a card, a sticky note, a
 * sheet, a stack, a hand, a binder, a character, an initiative marker, and
 * the Attack, Damage and Area Save cards with the save row. These are examples, not game content.
 *
 * Every record is copied verbatim from §4.7 (with M6-D3's amendments): ids,
 * shapes, tags, flags, cells in the document's order with their initial
 * values, actions, face elements with their rects and options, and the
 * `gm_binder` contents order. Nothing is chosen here. Ids are human-meaningful and never end in
 * `_<digits>` (§5.3), so spawned copies (`<id>_<n>`) never collide.
 */
import {
  type ActionDef,
  type BoardId,
  type Cell,
  type CellContent,
  dice,
  EMPTY,
  type FaceElement,
  type FaceLayout,
  list,
  num,
  type ObjectId,
  type Rect,
  ref,
  type Shape,
  type Snapshot,
  type TableObject,
  text,
} from "@vtt/schema";
import { GM_BOARD_ID, newTableSnapshot } from "./new-table";

/** The id of the GM binder on `gm_board` (DESIGN.md §4.7). */
export const GM_BINDER_ID: ObjectId = "gm_binder";

// ------------------------------------------------------------ the notation

const lit = (content: CellContent): Cell => ({ content });
const fx = (source: string): Cell => ({ content: { type: "formula", source } });
const FALSE: Cell = lit({ type: "boolean", value: false });
const NONE: Cell = lit(EMPTY);
const at = (id: ObjectId): Cell => lit(ref(id));

const rectShape = (w: number, h: number): Shape => ({ type: "rect", width: w, height: h });
const circleShape = (r: number): Shape => ({ type: "circle", radius: r });

/** Face element options: `L`, `H`, `C`, `m=N`, `sw="…"`. */
interface Opts {
  L?: true;
  H?: true;
  C?: true;
  m?: number;
  sw?: string;
}

function common(o: Opts): { show_when?: string; min_size?: number } {
  const out: { show_when?: string; min_size?: number } = {};
  if (o.sw !== undefined) out.show_when = o.sw;
  if (o.m !== undefined) out.min_size = o.m;
  return out;
}

function cellElement(type: "value" | "editor", cell: string, rect: Rect, o: Opts): FaceElement {
  const style: { size?: "large" | "huge"; caption?: true } = {};
  if (o.L) style.size = "large";
  if (o.H) style.size = "huge";
  if (o.C) style.caption = true;
  return {
    type,
    cell,
    rect,
    ...common(o),
    ...(Object.keys(style).length > 0 ? { style } : {}),
  };
}

const value = (cell: string, rect: Rect, o: Opts = {}) => cellElement("value", cell, rect, o);
const editor = (cell: string, rect: Rect, o: Opts = {}) => cellElement("editor", cell, rect, o);
const button = (action: string, rect: Rect, o: Opts = {}): FaceElement => ({
  type: "button",
  action,
  rect,
  ...common(o),
});
/**
 * A contents element; every one in §4.7 has its entries collapsed.
 * `whenSelected` sets `when_selected` (M6-D12: the list shows only while
 * its object is selected).
 */
const contentsList = (rect: Rect, o: Opts & { whenSelected?: true } = {}): FaceElement => ({
  type: "contents",
  rect,
  entries: "collapsed",
  ...common(o),
  ...(o.whenSelected ? { when_selected: true } : {}),
});

const action = (name: string, when: string | null, ...steps: string[]): ActionDef =>
  when === null ? { name, steps } : { name, when, steps };

interface Record_ {
  id: ObjectId;
  shape: Shape;
  /** Default true (§4.7: every record not marked otherwise is a template). */
  is_template?: boolean;
  is_zone?: boolean;
  is_character?: boolean;
  tag?: string[];
  contents?: ObjectId[];
  cells: Record<string, Cell>;
  actions?: ActionDef[];
  face?: FaceLayout;
  board?: BoardId;
}

function object(r: Record_): TableObject {
  const o: TableObject = {
    id: r.id,
    is_template: r.is_template ?? true,
    is_zone: r.is_zone ?? false,
    is_character: r.is_character ?? false,
    tag: r.tag ?? [],
    shape: r.shape,
    board: r.board ?? null,
    contents: r.contents ?? [],
    cells: r.cells,
    cell_visibility: {},
    actions: r.actions ?? [],
  };
  if (r.face !== undefined) o.face = r.face;
  return o;
}

// ----------------------------------------------------- the shared records

/** The GM binder's face: its `name` over its contents. */
const gmBinderFace = (): FaceLayout => ({
  elements: [
    value("name", [-3.3, -4.8, 6.6, 0.6], { L: true }),
    contentsList([-3.3, -4.0, 6.6, 8.8]),
  ],
});

/** A binder's face: an owned binder is headed by its owner, as the sheet is (M6-D16). */
const binderFace = (): FaceLayout => ({
  elements: [
    value("name", [-3.3, -4.8, 6.6, 0.6], { L: true, sw: "owner = empty" }),
    value("owner", [-3.3, -4.8, 6.6, 0.6], { L: true, sw: "owner != empty" }),
    contentsList([-3.3, -4.0, 6.6, 8.8]),
  ],
});

const sheetCells = (owner: Cell): Record<string, Cell> => ({
  name: lit(text("Sheet")),
  owner,
  ac: NONE,
  max_hp: NONE,
  hp: fx("max_hp - owner.damage_taken"),
  attack_bonus: NONE,
  damage_dice: lit(dice("1d8")),
  dex_save: NONE,
  spell_dc: NONE,
  notes: lit(text("")),
  ink: NONE,
});

const sheetFace = (): FaceLayout => {
  const f: Opts = { C: true, m: 12 };
  return {
    elements: [
      editor("name", [-2.8, -3.8, 5.6, 0.6], { L: true, sw: "owner = empty" }),
      value("owner", [-2.8, -3.8, 5.6, 0.6], { L: true, sw: "owner != empty" }),
      editor("ac", [-2.8, -3.0, 2.7, 0.5], f),
      editor("max_hp", [0.1, -3.0, 2.7, 0.5], f),
      value("hp", [-2.8, -2.4, 2.7, 0.5], f),
      editor("attack_bonus", [0.1, -2.4, 2.7, 0.5], f),
      editor("damage_dice", [-2.8, -1.8, 2.7, 0.5], f),
      editor("dex_save", [0.1, -1.8, 2.7, 0.5], f),
      editor("spell_dc", [-2.8, -1.2, 2.7, 0.5], f),
      editor("notes", [-2.8, -0.6, 5.6, 2.4]),
      value("ink", [-2.8, 1.9, 5.6, 1.9]),
    ],
  };
};

const binderCells = (owner: Cell): Record<string, Cell> => ({
  name: lit(text("Binder")),
  owner,
  visible_to: fx("owner"),
});

const attackCells = (owner: Cell, attacker: Cell): Record<string, Cell> => ({
  name: lit(text("Attack")),
  owner,
  attacker,
  target: NONE,
  roll: NONE,
  dmg: NONE,
  applied: FALSE,
  bonus: fx("attacker.attack_bonus"),
  total: fx("roll + bonus"),
  hit: fx("roll != empty and total >= target.ac"),
});

const attackActions = (): ActionDef[] => [
  action("Roll", "target != empty and roll = empty", "roll(1d20) -> roll"),
  action("Roll damage", "hit and dmg = empty", "roll(attacker.damage_dice) -> dmg"),
  action(
    "Apply",
    "hit and dmg != empty and not applied",
    "add(target.damage_taken, dmg)",
    "set(applied, true)",
  ),
  action("Discard", null, "remove(this)"),
];

/**
 * The Attack card face (DESIGN.md §4.6, Face layouts), with §4.7's
 * exception (M6-D3): Apply is drawn once `dmg` exists (its guard disables
 * it after use, with the reason) and a Discard button follows it.
 */
const attackFace = (): FaceLayout => ({
  elements: [
    value("name", [-1.2, -1.7, 2.4, 0.4], { L: true }),
    editor("target", [-1.2, -1.2, 2.4, 0.4], { C: true }),
    value("total", [-1.2, -0.7, 1.1, 0.5], { C: true }),
    value("hit", [0.1, -0.7, 1.1, 0.5], { C: true }),
    value("dmg", [-1.2, -0.1, 2.4, 0.4], { C: true }),
    button("Roll", [-1.2, 0.5, 1.1, 0.45], { sw: "roll = empty" }),
    button("Roll damage", [0.1, 0.5, 1.1, 0.45], { sw: "hit and dmg = empty" }),
    button("Apply", [-1.2, 1.1, 1.15, 0.45], { sw: "dmg != empty" }),
    button("Discard", [0.05, 1.1, 1.15, 0.45]),
  ],
  default_action: "Roll",
});

const CARD = rectShape(2.5, 3.5);

// ---------------------------------------------------------- the records

function records(): TableObject[] {
  const character = at("tpl_character");
  return [
    object({
      id: GM_BINDER_ID,
      shape: rectShape(7, 10),
      is_template: false,
      tag: ["binder"],
      board: GM_BOARD_ID,
      contents: [
        "tpl_character",
        "tpl_attack",
        "tpl_damage",
        "tpl_area_save",
        "tpl_save_row",
        "tpl_token",
        "tpl_marker",
        "tpl_zone",
        "tpl_card",
        "tpl_note",
        "tpl_sheet",
        "tpl_hand",
        "tpl_binder",
        "tpl_stack",
        "tpl_d20",
      ],
      cells: {
        name: lit(text("GM binder")),
        visible_to: lit({ type: "viewers", viewers: ["gm"] }),
        position: lit(list([num(0), num(0)])),
      },
      face: gmBinderFace(),
    }),

    object({
      id: "tpl_character",
      shape: circleShape(0.5),
      is_character: true,
      tag: ["pc", "creature"],
      contents: ["tpl_character_sheet", "tpl_character_binder"],
      cells: {
        name: lit(text("Character")),
        image: lit(text("")),
        sheet: at("tpl_character_sheet"),
        damage_taken: lit(num(0)),
        ac: fx("sheet.ac"),
        hp: fx("sheet.hp"),
        attack_bonus: fx("sheet.attack_bonus"),
        damage_dice: fx("sheet.damage_dice"),
        dex_save: fx("sheet.dex_save"),
        spell_dc: fx("sheet.spell_dc"),
      },
      face: {
        elements: [
          value("image", [-0.5, -0.5, 1, 1]),
          value("name", [-0.8, 0.55, 1.6, 0.3], { m: 8 }),
          value("hp", [0.2, -0.6, 0.5, 0.3], { m: 8 }),
          contentsList([-1.5, 0.9, 3, 1.2], { m: 24, whenSelected: true }),
        ],
      },
    }),
    object({
      id: "tpl_character_sheet",
      shape: rectShape(6, 8),
      is_template: false,
      cells: sheetCells(character),
      face: sheetFace(),
    }),
    object({
      id: "tpl_character_binder",
      shape: rectShape(7, 10),
      is_template: false,
      tag: ["binder"],
      contents: ["tpl_character_attack"],
      cells: binderCells(character),
      face: binderFace(),
    }),
    object({
      id: "tpl_character_attack",
      shape: CARD,
      cells: attackCells(character, character),
      actions: attackActions(),
      face: attackFace(),
    }),

    object({
      id: "tpl_attack",
      shape: CARD,
      cells: attackCells(NONE, NONE),
      actions: attackActions(),
      face: attackFace(),
    }),

    object({
      id: "tpl_damage",
      shape: CARD,
      cells: {
        name: lit(text("Damage")),
        target: NONE,
        dmg_dice: lit(dice("1d6")),
        dmg: NONE,
        applied: FALSE,
      },
      actions: [
        action("Roll damage", "target != empty and dmg = empty", "roll(dmg_dice) -> dmg"),
        action(
          "Apply",
          "dmg != empty and not applied",
          "add(target.damage_taken, dmg)",
          "set(applied, true)",
        ),
        action("Discard", null, "remove(this)"),
      ],
      face: {
        elements: [
          value("name", [-1.2, -1.7, 2.4, 0.4], { L: true }),
          editor("target", [-1.2, -1.2, 2.4, 0.4], { C: true }),
          editor("dmg_dice", [-1.2, -0.7, 2.4, 0.4], { C: true }),
          value("dmg", [-1.2, -0.2, 2.4, 0.5], { C: true }),
          button("Roll damage", [-1.2, 0.5, 2.4, 0.45], { sw: "dmg = empty" }),
          button("Apply", [-1.2, 1.1, 1.15, 0.45], { sw: "dmg != empty" }),
          button("Discard", [0.05, 1.1, 1.15, 0.45]),
        ],
      },
    }),

    object({
      id: "tpl_area_save",
      shape: CARD,
      contents: ["tpl_area_save_zone"],
      cells: {
        name: lit(text("Area save")),
        caster: NONE,
        zone: at("tpl_area_save_zone"),
        save_row: at("tpl_save_row"),
        dc: fx("caster.spell_dc"),
        damage_dice: lit(dice("8d6")),
        damage: NONE,
        locked: FALSE,
        applied: FALSE,
        targets: fx('contents(zone).where(tag has "creature")'),
        rows: fx('contents.where(tag has "save_row")'),
      },
      actions: [
        action(
          "Lock targets",
          "not locked",
          "each(targets, spawn(save_row, this, {target: it, owner: it.owner or it}))",
          "set(locked, true)",
        ),
        action("Roll damage", "locked and damage = empty", "roll(damage_dice) -> damage"),
        action(
          "Apply all",
          "locked and damage != empty and all(rows.save_roll != empty) and not applied",
          "each(rows, add(it.target.damage_taken, it.damage_dealt))",
          "set(applied, true)",
        ),
        action("Discard", null, "remove(zone)", "remove(this)"),
      ],
      face: {
        elements: [
          value("name", [-1.2, -1.7, 2.4, 0.4], { L: true }),
          editor("caster", [-1.2, -1.25, 1.15, 0.35], { C: true }),
          value("dc", [0.05, -1.25, 1.15, 0.35], { C: true }),
          value("damage", [-1.2, -0.85, 2.4, 0.3], { C: true }),
          value("targets", [-1.2, -0.5, 2.4, 0.3], { C: true }),
          contentsList([-1.2, -0.15, 2.4, 1.1]),
          button("Lock targets", [-1.2, 1.0, 1.15, 0.35], { sw: "not locked" }),
          button("Roll damage", [0.05, 1.0, 1.15, 0.35], { sw: "locked and damage = empty" }),
          button("Apply all", [-1.2, 1.4, 1.15, 0.3], { sw: "damage != empty" }),
          button("Discard", [0.05, 1.4, 1.15, 0.3]),
        ],
      },
    }),
    object({
      id: "tpl_area_save_zone",
      shape: circleShape(2),
      is_template: false,
      is_zone: true,
      cells: { name: lit(text("Area")) },
    }),

    object({
      id: "tpl_save_row",
      shape: rectShape(2.5, 0.8),
      tag: ["save_row"],
      cells: {
        name: lit(text("Save")),
        owner: NONE,
        target: NONE,
        save_roll: NONE,
        card: fx("container"),
        save_bonus: fx("target.dex_save"),
        passed: fx("save_roll + save_bonus >= card.dc"),
        damage_dealt: fx("if(passed, floor(card.damage / 2), card.damage)"),
      },
      actions: [
        action(
          "Roll save",
          "save_roll = empty and card.caster != empty",
          "roll(1d20) -> save_roll",
        ),
      ],
      face: {
        elements: [
          value("target", [-1.2, -0.35, 1.0, 0.3]),
          value("save_roll", [-0.15, -0.35, 0.6, 0.3]),
          value("passed", [0.5, -0.35, 0.7, 0.3]),
          button("Roll save", [-1.2, 0.05, 2.4, 0.3], { sw: "save_roll = empty" }),
        ],
      },
    }),

    object({
      id: "tpl_token",
      shape: circleShape(0.5),
      tag: ["creature"],
      cells: {
        name: lit(text("Token")),
        image: lit(text("")),
        ac: NONE,
        max_hp: NONE,
        damage_taken: lit(num(0)),
        attack_bonus: NONE,
        dex_save: NONE,
        hit: FALSE,
        hp: fx("max_hp - damage_taken"),
      },
      face: {
        elements: [
          value("image", [-0.5, -0.5, 1, 1]),
          value("name", [-0.8, 0.55, 1.6, 0.3], { m: 8 }),
          value("hp", [0.2, -0.6, 0.5, 0.3], { m: 8 }),
          value("hit", [-0.7, -0.6, 0.5, 0.3], { sw: "hit" }),
          contentsList([-0.8, 0.9, 1.6, 0.8], { m: 24, whenSelected: true }),
        ],
      },
    }),

    object({
      id: "tpl_marker",
      shape: circleShape(0.35),
      tag: ["marker"],
      cells: {
        name: lit(text("Marker")),
        of: NONE,
        who: fx("of.name"),
        image: fx("of.image"),
      },
      face: {
        elements: [
          value("image", [-0.35, -0.35, 0.7, 0.7]),
          editor("of", [-0.35, -0.15, 0.7, 0.3], { C: true, sw: "of = empty" }),
          value("who", [-0.6, 0.4, 1.2, 0.25], { m: 8 }),
        ],
      },
    }),

    object({
      id: "tpl_zone",
      shape: rectShape(4, 4),
      is_zone: true,
      cells: { name: lit(text("Zone")) },
    }),

    object({
      id: "tpl_card",
      shape: CARD,
      cells: { name: lit(text("Card")), title: lit(text("")), body: lit(text("")) },
      face: {
        elements: [
          editor("title", [-1.15, -1.65, 2.3, 0.5], { L: true }),
          editor("body", [-1.15, -1.05, 2.3, 2.7]),
        ],
      },
    }),

    object({
      id: "tpl_note",
      shape: rectShape(2, 2),
      cells: {
        name: lit(text("Note")),
        color: lit(text("#fff3a0")),
        text: lit(text("")),
        ink: NONE,
      },
      face: {
        elements: [value("ink", [-1, -1, 2, 2]), editor("text", [-0.9, -0.9, 1.8, 0.6])],
      },
    }),

    object({ id: "tpl_sheet", shape: rectShape(6, 8), cells: sheetCells(NONE), face: sheetFace() }),

    object({
      id: "tpl_hand",
      shape: rectShape(6, 2),
      tag: ["hand"],
      cells: { name: lit(text("Hand")), owner: NONE, visible_to: fx("owner") },
      face: {
        elements: [value("name", [-2.9, -0.95, 5.8, 0.35]), contentsList([-2.9, -0.55, 5.8, 1.5])],
      },
    }),

    object({
      id: "tpl_binder",
      shape: rectShape(7, 10),
      tag: ["binder"],
      cells: binderCells(NONE),
      face: binderFace(),
    }),

    object({
      id: "tpl_stack",
      shape: CARD,
      cells: { name: lit(text("Stack")), count: fx("len(contents)") },
      actions: [action("Shuffle", null, "shuffle(this)")],
      face: {
        elements: [
          value("name", [-1.15, -1.65, 2.3, 0.5], { L: true }),
          value("count", [-1.15, -1.0, 2.3, 0.8], { H: true, C: true }),
          button("Shuffle", [-1.15, 1.1, 2.3, 0.5]),
        ],
      },
    }),

    object({
      id: "tpl_d20",
      shape: circleShape(0.5),
      tag: ["die", "d20"],
      cells: {
        name: lit(text("d20")),
        sides: lit(num(20)),
        modifier: NONE,
        value: NONE,
        total: fx("value + modifier"),
      },
      actions: [action("Roll", null, "roll(1d20) -> value")],
      face: {
        elements: [
          value("total", [-0.4, -0.35, 0.8, 0.5], { H: true }),
          button("Roll", [-0.4, 0.18, 0.8, 0.25], { m: 10 }),
        ],
        default_action: "Roll",
      },
    }),
  ];
}

/**
 * The example objects: `gm_binder` (on `gm_board` at `[0, 0]`) and its
 * subtree, keyed by id in preorder. A fresh value on every call.
 */
export function exampleObjects(): Record<ObjectId, TableObject> {
  return structuredClone(Object.fromEntries(records().map((o) => [o.id, o])));
}

/**
 * A new table stocked with the example templates (DESIGN.md §7, New tables
 * and ownership; M5-D19): `newTableSnapshot()` plus `exampleObjects()`;
 * revision 0 and `next_seq` 1 unchanged. What `vtt-serve` creates for a
 * missing file unless `--empty`. A fresh value on every call.
 */
export function stockedTableSnapshot(): Snapshot {
  return { ...newTableSnapshot(), objects: exampleObjects() };
}
