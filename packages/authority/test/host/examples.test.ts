/**
 * The example templates (vtt-1xv.22; DESIGN.md §4.7 Example templates, §5.3,
 * §7 New tables and ownership, §8.1; M5-D19): `exampleObjects()` and
 * `stockedTableSnapshot()` copy §4.7's records verbatim.
 *
 * The expected records below are transcribed from DESIGN.md §4.7 in the
 * document's own notation (cells `name: literal` / `name = formula`,
 * actions `Name [when]: step ; step`, face elements `kind cell|action [x, y,
 * w, h]` with `L`, `H`, `C`, `m=N`, `sw="…"`, `full`/`collapsed`), and
 * parsed by the small reader in this file, so a reviewer can compare them
 * with the document line by line.
 */
import {
  DocumentStore,
  exampleObjects,
  GM_BINDER_ID,
  GM_BOARD_ID,
  newTableSnapshot,
  parseTable,
  serializeTable,
  stockedTableSnapshot,
} from "@vtt/authority";
import { parse, parseAction, parseStep } from "@vtt/formula";
import {
  type ActionDef,
  type Cell,
  type CellContent,
  dice,
  EMPTY,
  type FaceElement,
  type FaceLayout,
  faceProblem,
  list,
  num,
  type Rect,
  ref,
  type Shape,
  SnapshotSchema,
  TableFileSchema,
  TableObjectSchema,
  text,
  validateSnapshot,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";

// ------------------------------------------------------------- the reader

const formula = (source: string): CellContent => ({ type: "formula", source });

/** One literal in §4.7's notation. */
function literal(src: string): CellContent {
  const s = src.trim();
  if (s === "empty") return EMPTY;
  if (s === "true" || s === "false") return { type: "boolean", value: s === "true" };
  if (s.startsWith('"') && s.endsWith('"')) return text(s.slice(1, -1));
  if (s.startsWith("@")) return ref(s.slice(1));
  if (s === "[gm]") return { type: "viewers", viewers: ["gm"] };
  if (/^-?\d+(\.\d+)?$/.test(s)) return num(Number(s));
  if (/^\d*d\d+$/.test(s)) return dice(s);
  throw new Error(`not a literal: ${s}`);
}

/** Cells, `;`-separated: `name: literal` or `name = formula`. */
function cells(src: string): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const part of src.split(";").map((p) => p.trim())) {
    if (part === "") continue;
    const m = /^(\w+)(:| =) (.*)$/s.exec(part);
    if (m === null) throw new Error(`not a cell: ${part}`);
    const [, name, sep, rest] = m as unknown as [string, string, string, string];
    out[name] = { content: sep === ":" ? literal(rest) : formula(rest.trim()) };
  }
  return out;
}

/** One action per line: `Name [when]: step ; step` (the `[when]` optional). */
function actions(src: string): ActionDef[] {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((line) => {
      const m = /^([^[:]+?)(?: \[(.+)\])?: (.*)$/.exec(line);
      if (m === null) throw new Error(`not an action: ${line}`);
      const [, name, when, steps] = m as unknown as [string, string, string | undefined, string];
      const def: ActionDef = { name, steps: steps.split(" ; ").map((s) => s.trim()) };
      if (when !== undefined) def.when = when;
      return def;
    });
}

/** One face element per line: `kind cell|"action" [x, y, w, h] options…`. */
function elements(src: string): FaceElement[] {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((line) => {
      const m = /^(value|editor|button|contents)(?: (\w+|"[^"]+"))? \[([^\]]+)\](.*)$/.exec(line);
      if (m === null) throw new Error(`not a face element: ${line}`);
      const [, kind, target, rectSrc, optSrc] = m as unknown as [
        string,
        string,
        string | undefined,
        string,
        string,
      ];
      const rect = rectSrc.split(",").map((n) => Number(n.trim())) as Rect;
      const opts = optSrc.trim();
      const sw = /sw="([^"]+)"/.exec(opts)?.[1];
      const flags = opts
        .replace(/sw="[^"]+"/, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const min = flags.find((f) => f.startsWith("m="));
      const size = flags.includes("L") ? "large" : flags.includes("H") ? "huge" : undefined;
      const caption = flags.includes("C");
      const common: { show_when?: string; min_size?: number } = {};
      if (sw !== undefined) common.show_when = sw;
      if (min !== undefined) common.min_size = Number(min.slice(2));
      if (kind === "button") {
        const action = (target as string).replace(/^"|"$/g, "");
        return { type: "button", action, rect, ...common };
      }
      if (kind === "contents") {
        const entries = flags.includes("full") ? "full" : "collapsed";
        return { type: "contents", rect, entries, ...common };
      }
      const style: { size?: "large" | "huge"; caption?: boolean } = {};
      if (size !== undefined) style.size = size;
      if (caption) style.caption = true;
      return {
        type: kind as "value" | "editor",
        cell: target as string,
        rect,
        ...common,
        ...(Object.keys(style).length > 0 ? { style } : {}),
      };
    });
}

const rect = (w: number, h: number): Shape => ({ type: "rect", width: w, height: h });
const circle = (r: number): Shape => ({ type: "circle", radius: r });

interface Expected {
  shape: Shape;
  tag?: string[];
  is_template?: boolean;
  is_zone?: boolean;
  is_character?: boolean;
  contents?: string[];
  cells: string;
  actions?: string;
  face?: string;
  default_action?: string;
  /** A face given as JSON (the Attack card face of §4.6). */
  faceJson?: FaceLayout;
}

// ---------------------------------------------- DESIGN.md §4.7, transcribed

/**
 * The Attack card face (DESIGN.md §4.6, Face layouts), verbatim, with
 * §4.7's exception for `tpl_attack` (M6-D3): Apply `[-1.2, 1.1, 1.15, 0.45]`
 * `sw="dmg != empty"`, then `button Discard [0.05, 1.1, 1.15, 0.45]`.
 */
const ATTACK_FACE: FaceLayout = {
  elements: [
    { type: "value", cell: "name", rect: [-1.2, -1.7, 2.4, 0.4], style: { size: "large" } },
    { type: "editor", cell: "target", rect: [-1.2, -1.2, 2.4, 0.4], style: { caption: true } },
    { type: "value", cell: "total", rect: [-1.2, -0.7, 1.1, 0.5], style: { caption: true } },
    { type: "value", cell: "hit", rect: [0.1, -0.7, 1.1, 0.5], style: { caption: true } },
    { type: "value", cell: "dmg", rect: [-1.2, -0.1, 2.4, 0.4], style: { caption: true } },
    { type: "button", action: "Roll", rect: [-1.2, 0.5, 1.1, 0.45], show_when: "roll = empty" },
    {
      type: "button",
      action: "Roll damage",
      rect: [0.1, 0.5, 1.1, 0.45],
      show_when: "hit and dmg = empty",
    },
    { type: "button", action: "Apply", rect: [-1.2, 1.1, 1.15, 0.45], show_when: "dmg != empty" },
    { type: "button", action: "Discard", rect: [0.05, 1.1, 1.15, 0.45] },
  ],
  default_action: "Roll",
};

const GM_BINDER_FACE = `
  value name [-3.3, -4.8, 6.6, 0.6] L
  contents [-3.3, -4.0, 6.6, 8.8] collapsed`;

/** An owned binder's header shows its owner, as the sheet's does (M6-D16). */
const BINDER_FACE = `
  value name [-3.3, -4.8, 6.6, 0.6] L sw="owner = empty"
  value owner [-3.3, -4.8, 6.6, 0.6] L sw="owner != empty"
  contents [-3.3, -4.0, 6.6, 8.8] collapsed`;

const SHEET_CELLS = (owner: string) => `name: "Sheet"; owner: ${owner}; ac: empty;
  max_hp: empty; hp = max_hp - owner.damage_taken; attack_bonus: empty;
  damage_dice: 1d8; dex_save: empty; spell_dc: empty; notes: ""; ink: empty`;

const SHEET_FACE = `
  editor name [-2.8, -3.8, 5.6, 0.6] L sw="owner = empty"
  value owner [-2.8, -3.8, 5.6, 0.6] L sw="owner != empty"
  editor ac [-2.8, -3.0, 2.7, 0.5] C m=12
  editor max_hp [0.1, -3.0, 2.7, 0.5] C m=12
  value hp [-2.8, -2.4, 2.7, 0.5] C m=12
  editor attack_bonus [0.1, -2.4, 2.7, 0.5] C m=12
  editor damage_dice [-2.8, -1.8, 2.7, 0.5] C m=12
  editor dex_save [0.1, -1.8, 2.7, 0.5] C m=12
  editor spell_dc [-2.8, -1.2, 2.7, 0.5] C m=12
  editor notes [-2.8, -0.6, 5.6, 2.4]
  value ink [-2.8, 1.9, 5.6, 1.9]`;

const BINDER_CELLS = (owner: string) => `name: "Binder"; owner: ${owner}; visible_to = owner`;

const ATTACK_CELLS = (owner: string, attacker: string) => `name: "Attack"; owner: ${owner};
  attacker: ${attacker}; target: empty; roll: empty; dmg: empty; applied: false;
  bonus = attacker.attack_bonus; total = roll + bonus; hit = roll != empty and total >= target.ac`;

const ATTACK_ACTIONS = `
  Roll [target != empty and roll = empty]: roll(1d20) -> roll
  Roll damage [hit and dmg = empty]: roll(attacker.damage_dice) -> dmg
  Apply [hit and dmg != empty and not applied]: add(target.damage_taken, dmg) ; set(applied, true)
  Discard: remove(this)`;

const EXPECTED: Record<string, Expected> = {
  gm_binder: {
    shape: rect(7, 10),
    tag: ["binder"],
    is_template: false,
    contents: [
      "tpl_character",
      "tpl_attack",
      "tpl_damage",
      "tpl_area_save",
      "tpl_save_row",
      "tpl_token",
      "tpl_zone",
      "tpl_card",
      "tpl_note",
      "tpl_sheet",
      "tpl_hand",
      "tpl_binder",
      "tpl_stack",
      "tpl_d20",
    ],
    cells: `name: "GM binder"; visible_to: [gm]`,
    face: GM_BINDER_FACE,
  },
  tpl_d20: {
    shape: circle(0.5),
    tag: ["die", "d20"],
    cells: `name: "d20"; sides: 20; modifier: empty; value: empty; total = value + modifier`,
    actions: `Roll: roll(1d20) -> value`,
    face: `
      value total [-0.4, -0.35, 0.8, 0.5] H
      button Roll [-0.4, 0.18, 0.8, 0.25] m=10`,
    default_action: "Roll",
  },
  tpl_token: {
    shape: circle(0.5),
    tag: ["creature"],
    cells: `name: "Token"; image: ""; ac: empty; max_hp: empty; damage_taken: 0;
      attack_bonus: empty; dex_save: empty; hit: false; hp = max_hp - damage_taken`,
    face: `
      value image [-0.5, -0.5, 1, 1]
      value name [-0.8, 0.55, 1.6, 0.3] m=8
      value hp [0.2, -0.6, 0.5, 0.3] m=8
      value hit [-0.7, -0.6, 0.5, 0.3] sw="hit"
      contents [-0.8, 0.9, 1.6, 0.8] m=24 collapsed`,
  },
  tpl_zone: { shape: rect(4, 4), is_zone: true, cells: `name: "Zone"` },
  tpl_card: {
    shape: rect(2.5, 3.5),
    cells: `name: "Card"; title: ""; body: ""`,
    face: `
      editor title [-1.15, -1.65, 2.3, 0.5] L
      editor body [-1.15, -1.05, 2.3, 2.7]`,
  },
  tpl_note: {
    shape: rect(2, 2),
    cells: `name: "Note"; color: "#fff3a0"; text: ""; ink: empty`,
    face: `
      value ink [-1, -1, 2, 2]
      editor text [-0.9, -0.9, 1.8, 0.6]`,
  },
  tpl_sheet: { shape: rect(6, 8), cells: SHEET_CELLS("empty"), face: SHEET_FACE },
  tpl_stack: {
    shape: rect(2.5, 3.5),
    cells: `name: "Stack"; count = len(contents)`,
    actions: `Shuffle: shuffle(this)`,
    face: `
      value name [-1.15, -1.65, 2.3, 0.5] L
      value count [-1.15, -1.0, 2.3, 0.8] H C
      button Shuffle [-1.15, 1.1, 2.3, 0.5]`,
  },
  tpl_hand: {
    shape: rect(6, 2),
    tag: ["hand"],
    cells: `name: "Hand"; owner: empty; visible_to = owner`,
    face: `
      value name [-2.9, -0.95, 5.8, 0.35]
      contents [-2.9, -0.55, 5.8, 1.5] collapsed`,
  },
  tpl_binder: {
    shape: rect(7, 10),
    tag: ["binder"],
    cells: BINDER_CELLS("empty"),
    face: BINDER_FACE,
  },
  tpl_character: {
    shape: circle(0.5),
    is_character: true,
    tag: ["pc", "creature"],
    contents: ["tpl_character_sheet", "tpl_character_binder"],
    cells: `name: "Character"; image: ""; sheet: @tpl_character_sheet; damage_taken: 0;
      ac = sheet.ac; hp = sheet.hp; attack_bonus = sheet.attack_bonus;
      damage_dice = sheet.damage_dice; dex_save = sheet.dex_save; spell_dc = sheet.spell_dc`,
    face: `
      value image [-0.5, -0.5, 1, 1]
      value name [-0.8, 0.55, 1.6, 0.3] m=8
      value hp [0.2, -0.6, 0.5, 0.3] m=8
      contents [-1.5, 0.9, 3, 1.2] m=24 collapsed`,
  },
  tpl_character_sheet: {
    shape: rect(6, 8),
    is_template: false,
    cells: SHEET_CELLS("@tpl_character"),
    face: SHEET_FACE,
  },
  tpl_character_binder: {
    shape: rect(7, 10),
    tag: ["binder"],
    is_template: false,
    contents: ["tpl_character_attack"],
    cells: BINDER_CELLS("@tpl_character"),
    face: BINDER_FACE,
  },
  tpl_character_attack: {
    shape: rect(2.5, 3.5),
    cells: ATTACK_CELLS("@tpl_character", "@tpl_character"),
    actions: ATTACK_ACTIONS,
    faceJson: ATTACK_FACE,
  },
  tpl_attack: {
    shape: rect(2.5, 3.5),
    cells: ATTACK_CELLS("empty", "empty"),
    actions: ATTACK_ACTIONS,
    faceJson: ATTACK_FACE,
  },
  tpl_damage: {
    shape: rect(2.5, 3.5),
    cells: `name: "Damage"; target: empty; dmg_dice: 1d6; dmg: empty; applied: false`,
    actions: `
      Roll damage [target != empty and dmg = empty]: roll(dmg_dice) -> dmg
      Apply [dmg != empty and not applied]: add(target.damage_taken, dmg) ; set(applied, true)
      Discard: remove(this)`,
    face: `
      value name [-1.2, -1.7, 2.4, 0.4] L
      editor target [-1.2, -1.2, 2.4, 0.4] C
      editor dmg_dice [-1.2, -0.7, 2.4, 0.4] C
      value dmg [-1.2, -0.2, 2.4, 0.5] C
      button "Roll damage" [-1.2, 0.5, 2.4, 0.45] sw="dmg = empty"
      button Apply [-1.2, 1.1, 1.15, 0.45] sw="dmg != empty"
      button Discard [0.05, 1.1, 1.15, 0.45]`,
  },
  tpl_area_save: {
    shape: rect(2.5, 3.5),
    contents: ["tpl_area_save_zone"],
    cells: `name: "Area save"; caster: empty; zone: @tpl_area_save_zone;
      save_row: @tpl_save_row; dc = caster.spell_dc; damage_dice: 8d6; damage: empty;
      locked: false; applied: false; targets = contents(zone).where(tag has "creature");
      rows = contents.where(tag has "save_row")`,
    actions: `
      Lock targets [not locked]: each(targets, spawn(save_row, this, {target: it, owner: it.owner})) ; set(locked, true)
      Roll damage [locked and damage = empty]: roll(damage_dice) -> damage
      Apply all [locked and damage != empty and all(rows.save_roll != empty) and not applied]: each(rows, add(it.target.damage_taken, it.damage_dealt)) ; set(applied, true)
      Discard: remove(zone) ; remove(this)`,
    face: `
      value name [-1.2, -1.7, 2.4, 0.4] L
      editor caster [-1.2, -1.25, 1.15, 0.35] C
      value dc [0.05, -1.25, 1.15, 0.35] C
      value damage [-1.2, -0.85, 2.4, 0.3] C
      value targets [-1.2, -0.5, 2.4, 0.3] C
      contents [-1.2, -0.15, 2.4, 1.1] collapsed
      button "Lock targets" [-1.2, 1.0, 1.15, 0.35] sw="not locked"
      button "Roll damage" [0.05, 1.0, 1.15, 0.35] sw="locked and damage = empty"
      button "Apply all" [-1.2, 1.4, 1.15, 0.3] sw="damage != empty"
      button Discard [0.05, 1.4, 1.15, 0.3]`,
  },
  tpl_area_save_zone: {
    shape: circle(2),
    is_zone: true,
    is_template: false,
    cells: `name: "Area"`,
  },
  tpl_save_row: {
    shape: rect(2.5, 0.8),
    tag: ["save_row"],
    cells: `name: "Save"; owner: empty; target: empty; save_roll: empty; card = container;
      save_bonus = target.dex_save; passed = save_roll + save_bonus >= card.dc;
      damage_dealt = if(passed, floor(card.damage / 2), card.damage)`,
    actions: `Roll save [save_roll = empty and card.caster != empty]: roll(1d20) -> save_roll`,
    face: `
      value target [-1.2, -0.35, 1.0, 0.3]
      value save_roll [-0.15, -0.35, 0.6, 0.3]
      value passed [0.5, -0.35, 0.7, 0.3]
      button "Roll save" [-1.2, 0.05, 2.4, 0.3] sw="save_roll = empty"`,
  },
};

/** The expected record of `id`, built from EXPECTED. */
function expectedRecord(id: string) {
  const e = EXPECTED[id] as Expected;
  const record: Record<string, unknown> = {
    id,
    is_template: e.is_template ?? true,
    is_zone: e.is_zone ?? false,
    is_character: e.is_character ?? false,
    tag: e.tag ?? [],
    shape: e.shape,
    board: id === GM_BINDER_ID ? GM_BOARD_ID : null,
    contents: e.contents ?? [],
    cells: {
      ...cells(e.cells),
      ...(id === GM_BINDER_ID ? { position: { content: list([num(0), num(0)]) } } : {}),
    },
    cell_visibility: {},
    actions: e.actions === undefined ? [] : actions(e.actions),
  };
  if (e.faceJson !== undefined) record.face = e.faceJson;
  else if (e.face !== undefined) {
    record.face = {
      elements: elements(e.face),
      ...(e.default_action === undefined ? {} : { default_action: e.default_action }),
    };
  }
  return record;
}

// -------------------------------------------------------------------- tests

const objects = () => Object.values(exampleObjects());

describe("the example records (DESIGN.md §4.7, verbatim)", () => {
  test("exactly gm_binder and its subtree, in preorder", () => {
    expect(Object.keys(exampleObjects())).toEqual([
      "gm_binder",
      "tpl_character",
      "tpl_character_sheet",
      "tpl_character_binder",
      "tpl_character_attack",
      "tpl_attack",
      "tpl_damage",
      "tpl_area_save",
      "tpl_area_save_zone",
      "tpl_save_row",
      "tpl_token",
      "tpl_zone",
      "tpl_card",
      "tpl_note",
      "tpl_sheet",
      "tpl_hand",
      "tpl_binder",
      "tpl_stack",
      "tpl_d20",
    ]);
    expect(GM_BINDER_ID).toBe("gm_binder");
  });

  test.each(Object.keys(EXPECTED))("%s matches its §4.7 record", (id) => {
    expect(exampleObjects()[id]).toEqual(expectedRecord(id));
    // Key order of cells is the document's order (later beads add after named cells).
    expect(Object.keys(exampleObjects()[id]?.cells ?? {})).toEqual(
      Object.keys(expectedRecord(id).cells as object),
    );
  });

  test("ids are keys, human-meaningful, and never end in _<digits> (§5.3)", () => {
    for (const [key, o] of Object.entries(exampleObjects())) {
      expect(o.id).toBe(key);
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(key).not.toMatch(/_\d+$/);
    }
  });

  test("each call returns a fresh value", () => {
    const a = exampleObjects();
    (a.tpl_d20 as { tag: string[] }).tag.push("changed");
    expect(exampleObjects().tpl_d20?.tag).toEqual(["die", "d20"]);
    const s = stockedTableSnapshot();
    s.boards.push({ id: "other" });
    expect(stockedTableSnapshot().boards).toEqual([{ id: "gm_board", name: "GM" }]);
  });
});

describe("the records parse and validate", () => {
  test("every formula cell parses", () => {
    let count = 0;
    for (const o of objects()) {
      for (const [name, cell] of Object.entries(o.cells)) {
        if (cell.content.type !== "formula") continue;
        count++;
        const result = parse(cell.content.source);
        expect(result.ok, `${o.id}.${name}: ${JSON.stringify(result)}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(20);
  });

  test("every when and every step parses with the action step parser", () => {
    let count = 0;
    for (const o of objects()) {
      for (const def of o.actions) {
        const parsed = parseAction(def);
        if (def.when !== undefined) {
          expect(parsed.when?.ok, `${o.id} ${def.name} when`).toBe(true);
        }
        parsed.steps.forEach((s, i) => {
          count++;
          expect(s.ok, `${o.id} ${def.name} step ${i}: ${JSON.stringify(s)}`).toBe(true);
          expect(parseStep(def.steps[i] as string).ok).toBe(true);
        });
      }
    }
    expect(count).toBe(24);
  });

  test("every face passes faceProblem, and every show_when parses", () => {
    for (const o of objects()) {
      if (o.face === undefined) continue;
      expect(faceProblem(o.face), o.id).toBeUndefined();
      for (const e of [...o.face.elements, ...(o.face.collapsed ?? [])]) {
        if (e.show_when !== undefined) expect(parse(e.show_when).ok, e.show_when).toBe(true);
        if (e.type === "button") {
          expect(o.actions.map((a) => a.name)).toContain(e.action);
        }
      }
      if (o.face.default_action !== undefined) {
        expect(o.actions.map((a) => a.name)).toContain(o.face.default_action);
      }
    }
  });

  test("the Area save face has no overlapping element rects (M6-D16)", () => {
    const els = exampleObjects().tpl_area_save?.face?.elements ?? [];
    expect(els.map((e) => (e.type === "value" ? e.cell : e.type))).toContain("targets");
    const overlap = (a: Rect, b: Rect) =>
      a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    els.forEach((a, i) => {
      els.slice(i + 1).forEach((b, j) => {
        expect(overlap(a.rect, b.rect), `elements ${i} and ${i + 1 + j}`).toBe(false);
      });
    });
  });

  test("every object passes the object schema", () => {
    for (const o of objects()) expect(TableObjectSchema.safeParse(o).success, o.id).toBe(true);
  });
});

describe("stockedTableSnapshot", () => {
  test("is newTableSnapshot plus gm_binder and its subtree; next_seq stays 1", () => {
    const stocked = stockedTableSnapshot();
    expect(stocked).toEqual({ ...newTableSnapshot(), objects: exampleObjects() });
    expect(stocked.revision).toBe(0);
    expect(stocked.next_seq).toBe(1);
    expect(stocked.retired_ids).toEqual([]);
    expect(stocked.boards).toEqual([{ id: "gm_board", name: "GM" }]);
  });

  test("passes the snapshot schema and the document invariants", () => {
    const stocked = stockedTableSnapshot();
    expect(SnapshotSchema.safeParse(stocked).success).toBe(true);
    expect(validateSnapshot(stocked)).toEqual([]);
  });

  test("passes the file schema and round-trips through serializeTable and parseTable", () => {
    const store = DocumentStore.fromSnapshot(stockedTableSnapshot());
    const file = serializeTable(store, []);
    expect(TableFileSchema.safeParse(file).success).toBe(true);
    const parsed = parseTable(JSON.stringify(file));
    expect(parsed.store.toSnapshot()).toEqual(stockedTableSnapshot());
    expect(parsed.warnings).toEqual([]);
  });
});
