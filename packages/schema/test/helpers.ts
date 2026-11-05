/** Hand-built snapshots shared by the document and validation tests. */
import {
  bool,
  type Cell,
  type CellContent,
  EMPTY,
  list,
  num,
  ref,
  type Snapshot,
  type TableObject,
  text,
} from "@vtt/schema";

export const lit = (content: CellContent): Cell => ({ content });
export const formula = (source: string): Cell => ({ content: { type: "formula", source } });
export const at = (x: number, y: number): Cell => lit(list([num(x), num(y)]));

/** An object with every field at its default, contained nowhere and on no board. */
export function obj(id: string, rest: Partial<TableObject> = {}): TableObject {
  return {
    id,
    is_template: false,
    is_zone: false,
    is_character: false,
    tag: [],
    shape: null,
    board: null,
    contents: [],
    cells: {},
    cell_visibility: {},
    actions: [],
    ...rest,
  };
}

export function snapshot(objects: TableObject[], rest: Partial<Snapshot> = {}): Snapshot {
  return {
    revision: 0,
    next_seq: 0,
    boards: [{ id: "map", name: "Map" }],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
    ...rest,
  };
}

function creature(id: string, name: string, x: number, cells: Record<string, number>): TableObject {
  return obj(id, {
    is_character: true,
    tag: id === "aldric" ? ["pc", "creature"] : ["creature", "goblin"],
    shape: { type: "circle", radius: 0.5 },
    board: "map",
    cells: {
      name: lit(text(name)),
      owner: lit(ref(id)),
      z: lit(num(0)),
      position: at(x, 10),
      ...Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, lit(num(v))])),
    },
  });
}

/** The setup of packages/fixtures/scenarios/fireball.json, written by hand. */
export function fireballSnapshot(): Snapshot {
  return snapshot(
    [
      creature("aldric", "Aldric", 2, { dex_save: 1, damage_taken: 0, spell_dc: 14 }),
      creature("goblin1", "Goblin 1", 9, { dex_save: 2, damage_taken: 0 }),
      creature("goblin2", "Goblin 2", 12, { dex_save: 0, damage_taken: 3 }),
      creature("goblin3", "Goblin 3", 16, { dex_save: 1, damage_taken: 0 }),
      obj("aldric_binder", {
        tag: ["binder"],
        board: "shelf",
        contents: ["fireball", "save_row_t"],
        cells: {
          name: lit(text("Aldric's binder")),
          owner: lit(ref("aldric")),
          position: at(0, 0),
        },
      }),
      obj("fireball", {
        is_template: true,
        tag: ["card", "fireball"],
        contents: ["fireball_zone"],
        cells: {
          name: lit(text("Fireball")),
          caster: lit(EMPTY),
          zone: lit(ref("fireball_zone")),
          save_row: lit(ref("save_row_t")),
          dc: formula("caster.spell_dc"),
          damage: lit(EMPTY),
          locked: lit(bool(false)),
          applied: lit(bool(false)),
          targets: formula('contents(zone).where(tag has "creature")'),
          rows: formula('contents.where(tag has "save_row")'),
        },
        actions: [
          {
            name: "Lock targets",
            when: "not locked",
            steps: [
              "each(targets, spawn(save_row, this, {target: it, owner: it.owner}))",
              "set(locked, true)",
            ],
          },
          {
            name: "Roll damage",
            when: "locked and damage = empty",
            steps: ["roll(8d6) -> damage"],
          },
          {
            name: "Apply all",
            when: "locked and damage != empty and all(rows.save_roll != empty) and not applied",
            steps: [
              "each(rows, add(it.target.damage_taken, it.damage_dealt))",
              "set(applied, true)",
            ],
          },
          { name: "Discard", steps: ["remove(zone)", "remove(this)"] },
        ],
      }),
      obj("fireball_zone", {
        is_zone: true,
        tag: ["fireball_zone"],
        shape: { type: "circle", radius: 4 },
        cells: { name: lit(text("Fireball area")) },
      }),
      obj("save_row_t", {
        is_template: true,
        tag: ["save_row"],
        cells: {
          name: lit(text("Save row")),
          target: lit(EMPTY),
          save_roll: lit(EMPTY),
          card: formula("container"),
          save_bonus: formula("target.dex_save"),
          passed: formula("save_roll + save_bonus >= card.dc"),
          damage_dealt: formula("if(passed, floor(card.damage / 2), card.damage)"),
        },
        actions: [
          { name: "Roll save", when: "save_roll = empty", steps: ["roll(1d20) -> save_roll"] },
        ],
      }),
    ],
    {
      boards: [
        { id: "map", name: "Map" },
        { id: "shelf", name: "Binder shelf" },
      ],
    },
  );
}

/** The object `id` of `s`; throws when it is missing. */
export function get(s: Snapshot, id: string): TableObject {
  const o = s.objects[id];
  if (o === undefined) throw new Error(`no object ${id}`);
  return o;
}
