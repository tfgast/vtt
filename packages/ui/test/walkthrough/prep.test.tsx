/**
 * The walkthrough's prep (vtt-nb8.9; DESIGN.md §8.4 steps 1–6 as amended
 * by vtt-nb8.2; M6 plan Q1–Q3, Q13): `runPrep` on a fresh stocked table,
 * every Done-when item asserted through the GM assertion client.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CRYPT_MAP, exampleAssetPath } from "@vtt/fixtures";
import type { ObjectView, Viewer } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import type { DriverContext, RoomNumber } from "./contract";
import { createGestures } from "./gestures";
import { startWalkthrough } from "./infra";
import {
  AGENT_NAME,
  CHARACTERS,
  FIREBALL_LABEL,
  HIT_FORMULA,
  PREP_DICE,
  REHIDE_FORMULA,
  ROOM4_LABEL,
  runPrep,
} from "./prep";
import { WALKTHROUGH_STEPS } from "./steps";

let ctx: DriverContext | null = null;

afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

const GM: Viewer = { type: "gm" };

async function views(c: DriverContext, ids: ObjectId[], viewer: Viewer = GM) {
  const { objects, missing } = await c.gm.request("get_objects", { ids, viewer });
  expect(missing).toEqual([]);
  return objects;
}

async function view(c: DriverContext, id: ObjectId, viewer: Viewer = GM): Promise<ObjectView> {
  const [v] = await views(c, [id], viewer);
  if (v === undefined) throw new Error(`no view of ${id}`);
  return v;
}

const value = (v: ObjectView, cell: string) => v.cells[cell]?.value;
const num = (n: number) => ({ type: "number", value: n });
const text = (s: string) => ({ type: "text", value: s });
const ref = (id: string) => ({ type: "ref", object: id });
const refs = (v: ObjectView, cell: string): ObjectId[] => {
  const l = value(v, cell) as { type?: string; items?: { object?: string }[] } | undefined;
  return l?.type === "list" ? (l.items ?? []).flatMap((i) => (i.object ? [i.object] : [])) : [];
};
const tags = (v: ObjectView): string[] => {
  const l = value(v, "tag") as { items?: { value?: unknown }[] } | undefined;
  return (l?.items ?? []).flatMap((i) => (typeof i.value === "string" ? [i.value] : []));
};
const hasHitElement = (v: ObjectView) =>
  v.face?.elements.some((e) => e.type === "value" && "cell" in e && e.cell === "hit") === true;

describe(`prep: ${WALKTHROUGH_STEPS.slice(0, 6)
  .map((s) => s.id)
  .join(", ")} (vtt-nb8.9)`, () => {
  test("runPrep performs §8.4 steps 1–6 through the UI within 90 s", async () => {
    const c = await startWalkthrough({ dice: PREP_DICE });
    ctx = c;

    // Step 1 as stated: the GM board holds exactly the GM binder and its fourteen templates.
    const first = await c.gm.request("list_objects", { filter: { board: "gm_board" } });
    expect(first.objects.map((o) => o.id)).toEqual(["gm_binder"]);
    expect(refs(await view(c, "gm_binder"), "contents")).toEqual([
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
    ]);

    const started = Date.now();
    const prep = await runPrep(c);
    const took = Date.now() - started;
    console.info(`runPrep took ${(took / 1000).toFixed(1)} s`);

    // Step 2: the badge on the template; four characters with sheets, binders and Attack templates.
    const tpl = await view(c, "tpl_character");
    expect(tpl.cells.hit?.kind).toBe("formula");
    expect(hasHitElement(tpl)).toBe(true);
    const hitElement = tpl.face?.elements.find((e) => "cell" in e && e.cell === "hit");
    expect(hitElement).toMatchObject({ rect: [-0.5, -0.95, 1, 0.3], show_when: "hit" });

    for (const want of CHARACTERS) {
      const ids = prep.characters[want.name];
      expect(c.byName(want.name)).toBe(ids.token);
      const token = await view(c, ids.token);
      expect(token.is_character).toBe(true);
      expect(value(token, "hp")).toEqual(num(want.max_hp));
      expect(value(token, "ac")).toEqual(num(want.ac));
      expect(value(token, "hit")).toEqual({ type: "boolean", value: false });
      expect(hasHitElement(token)).toBe(true);
      expect(value(token, "sheet")).toEqual(ref(ids.sheet));

      const sheet = await view(c, ids.sheet);
      expect(value(sheet, "owner")).toEqual(ref(ids.token));
      expect(value(sheet, "attack_bonus")).toEqual(num(want.attack_bonus));
      expect(value(sheet, "dex_save")).toEqual(num(want.dex_save));
      // On the canvas for Aldric: the tokens' 3-unit lists are 2 units apart, so each
      // list's chevron column lies under the list of the token made after it (to its left).
      await expectOwnerHeader(c, ids.token, ids.sheet, want.name === "Aldric");

      const binder = await view(c, ids.binder);
      expect(tags(binder)).toContain("binder");
      expect(refs(binder, "contents")[0]).toBe(ids.attackTemplate);
      const attack = await view(c, ids.attackTemplate);
      expect(attack.is_template).toBe(true);
      expect(value(attack, "name")).toEqual(text("Attack"));
      expect(value(attack, "attacker")).toEqual(ref(ids.token));
    }

    // Step 3: Crypt, the 24 × 16 map, six opaque rooms named Room 1…6 over the map's rooms.
    expect(c.session.getSnapshot().boards.find((b) => b.id === prep.crypt)?.name).toBe("Crypt");
    const map = await view(c, prep.map);
    expect(value(map, "board")).toEqual(ref(prep.crypt));
    expect(value(map, "shape")).toEqual({
      type: "shape",
      shape: { type: "rect", width: 24, height: 16 },
    });
    expect(prep.unitsPerPx).toBe(0.01);
    for (const room of CRYPT_MAP.rooms) {
      const { id, rect } = prep.rooms[room.n];
      const [x, y, w, h] = room.rect_px;
      expect(rect).toEqual([
        prep.mapOrigin[0] + x / 100,
        prep.mapOrigin[1] + y / 100,
        w / 100,
        h / 100,
      ]);
      const zone = await view(c, id);
      expect(value(zone, "name")).toEqual(text(`Room ${room.n}`));
      expect(value(zone, "board")).toEqual(ref(prep.crypt));
      expect(value(zone, "opaque")).toEqual({ type: "boolean", value: true });
      expect(value(zone, "shape")).toEqual({
        type: "shape",
        shape: { type: "rect", width: w / 100, height: h / 100 },
      });
      const pos = value(zone, "position") as { items: { value: number }[] };
      expect(pos.items[0]?.value).toBeCloseTo(rect[0] + rect[2] / 2, 6);
      expect(pos.items[1]?.value).toBeCloseTo(rect[1] + rect[3] / 2, 6);
      const visibleTo = zone.cells.visible_to;
      expect(visibleTo?.value).toEqual({ type: "viewers", viewers: ["gm"] });
      if (room.n === 2 || room.n === 4) {
        expect(visibleTo?.kind).toBe("formula");
        expect(visibleTo).toMatchObject({ source: REHIDE_FORMULA.slice(1) });
      } else {
        expect(visibleTo?.kind).not.toBe("formula");
      }
    }
    // The GM binder moved beside the map.
    const binder = await view(c, prep.gmBinder);
    expect(value(binder, "board")).toEqual(ref(prep.crypt));
    const binderPos = value(binder, "position") as { items: { value: number }[] };
    expect(binderPos.items.map((i) => i.value)).toEqual([
      prep.mapOrigin[0] + 27,
      prep.mapOrigin[1] + 5,
    ]);

    // Step 4: the goblin template, its badge check, G1–G8 in rooms 3 and 5.
    expect(prep.observed.badgeShownWithDie).toBe(true);
    expect(prep.observed.badgeHiddenAfterDelete).toBe(true);
    const goblin = await view(c, prep.goblinTemplate);
    expect(goblin.is_template).toBe(true);
    expect(goblin.is_character).toBe(true);
    expect(value(goblin, "name")).toEqual(text("Goblin"));
    // The imported asset's path: `<table basename>.assets/<slug>-<hash8>.<ext>` (PROTOCOL.md §1).
    const goblinBytes = await readFile(exampleAssetPath("goblin.png"));
    const hash8 = createHash("sha256").update(goblinBytes).digest("hex").slice(0, 8);
    const goblinPath = `${basename(c.file)}.assets/goblin-${hash8}.png`;
    expect(value(goblin, "image")).toEqual(text(goblinPath));
    expect(value(goblin, "ac")).toEqual(num(13));
    expect(goblin.cells.ac?.visibility).toEqual({ type: "viewers", viewers: ["gm"] });
    expect(value(goblin, "max_hp")).toEqual(num(7));
    expect(value(goblin, "attack_bonus")).toEqual(num(4));
    expect(value(goblin, "dex_save")).toEqual(num(2));
    expect(goblin.cells.hit?.kind).toBe("formula");
    const [templateDie] = refs(goblin, "contents");
    if (templateDie === undefined) throw new Error("no die in the goblin template");
    const td = await view(c, templateDie);
    expect(value(td, "template")).toEqual(ref("tpl_d20"));
    expect(value(td, "owner")).toEqual(ref(prep.goblinTemplate));
    expect(td.cells.modifier).toMatchObject({ kind: "formula", source: "owner.attack_bonus" });
    expect(value(td, "modifier")).toEqual(num(4));

    const aldricViewer: Viewer = { type: "character", id: prep.characters.Aldric.token };
    expect(prep.goblins).toHaveLength(8);
    expect(prep.goblinDice).toHaveLength(8);
    for (const [i, id] of prep.goblins.entries()) {
      const name = `G${i + 1}`;
      expect(c.byName(name)).toBe(id);
      const g = await view(c, id);
      expect(g.is_character).toBe(true);
      expect(g.is_template).toBe(false);
      expect(value(g, "template")).toEqual(ref(prep.goblinTemplate));
      expect(value(g, "image")).toEqual(text(goblinPath));
      expect(g.cells.hit?.kind).toBe("formula");
      expect(g.cells.hit).toMatchObject({ source: HIT_FORMULA.slice(1) });
      expect(value(g, "hit")).toEqual({ type: "boolean", value: false });
      expect(g.face?.elements.find((e) => "cell" in e && e.cell === "hit")).toMatchObject({
        shown: false,
      });
      const die = prep.goblinDice[i] as ObjectId;
      expect(refs(g, "contents")).toEqual([die]);
      const d = await view(c, die);
      expect(tags(d)).toContain("d20");
      expect(value(d, "owner")).toEqual(ref(id));
      expect(value(d, "modifier")).toEqual(num(4));
      // GM-only `ac`; Aldric sees no goblin at all yet (the rooms are covered).
      expect(g.cells.ac?.visibility).toEqual({ type: "viewers", viewers: ["gm"] });
      const seen = await c.gm.request("get_objects", { ids: [id], viewer: aldricViewer });
      expect(seen.objects.every((o) => o.cells.ac === undefined)).toBe(true);
    }
    const zones = await c.gm.request("zones", { board: prep.crypt });
    const inRoom = (n: RoomNumber) =>
      zones.zones.find((z) => z.id === prep.rooms[n].id)?.contents ?? [];
    expect([...inRoom(3)].sort()).toEqual(prep.goblins.slice(0, 4).sort());
    expect([...inRoom(5)].sort()).toEqual(prep.goblins.slice(4).sort());

    // Step 5: the agent's two groups, then the GM's correction of the DC.
    const log = await c.gm.request("log", { limit: 100 });
    const agentGroups = log.groups.filter(
      (gr) => gr.actor.type === "agent" && gr.actor.name === AGENT_NAME,
    );
    expect(agentGroups.map((gr) => gr.label).reverse()).toEqual([ROOM4_LABEL, FIREBALL_LABEL]);
    const [fireballGroup, roomGroup] = agentGroups;
    if (fireballGroup === undefined || roomGroup === undefined) throw new Error("no groups");
    expect(fireballGroup.index).toBeGreaterThan(roomGroup.index);
    const room4 = await view(c, prep.rooms[4].id);
    expect(tags(room4)).toEqual(["difficult"]);
    expect(value(room4, "pattern")).toEqual(text("hatch"));
    const effects = async (index: number) =>
      (await c.gm.request("explain_group", { index })).group.effects ?? [];
    const roomEffects = await effects(roomGroup.index);
    expect(roomEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: prep.rooms[4].id, field: "tag" }),
        expect.objectContaining({ object: prep.rooms[4].id, cell: "pattern" }),
      ]),
    );
    expect(JSON.stringify(roomEffects)).not.toContain("spell_dc");
    const fireballEffects = await effects(fireballGroup.index);
    expect(fireballEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "create",
          objects: expect.arrayContaining([expect.objectContaining({ id: prep.fireballTemplate })]),
        }),
        expect.objectContaining({ object: prep.characters.Aldric.sheet, cell: "spell_dc" }),
      ]),
    );
    expect(prep.observed.fireballInspector).toEqual({
      dc: "14",
      caster: `Aldric (${prep.characters.Aldric.token})`,
      damage_dice: "8d6",
    });
    const aldricSheet = await view(c, prep.characters.Aldric.sheet);
    expect(value(aldricSheet, "spell_dc")).toEqual(num(14));
    const fireball = await view(c, prep.fireballTemplate);
    expect(refs(await view(c, prep.characters.Aldric.binder), "contents")).toContain(
      prep.fireballTemplate,
    );
    expect(fireball.is_template).toBe(true);
    expect(value(fireball, "name")).toEqual(text("Fireball"));
    expect(value(fireball, "caster")).toEqual(ref(prep.characters.Aldric.token));
    expect(value(fireball, "damage_dice")).toEqual({ type: "dice", expr: "8d6" });
    expect(fireball.cells.dc).toMatchObject({
      kind: "formula",
      source: "caster.spell_dc",
      value: num(15),
    });
    const later = log.groups.filter(
      (gr) => gr.index > fireballGroup.index && gr.actor.type === "gm",
    );
    const dcGroups = [];
    for (const gr of later) {
      const fx = await effects(gr.index);
      if (
        fx.some(
          (e) =>
            "cell" in e && e.cell === "dc" && "object" in e && e.object === prep.fireballTemplate,
        )
      ) {
        dcGroups.push(gr);
      }
    }
    const dcGroup = dcGroups[0];
    expect(dcGroup).toBeDefined();

    // Step 6: the note on the GM board with three ink strokes; the saved file is readable.
    const note = await view(c, prep.note);
    expect(value(note, "board")).toEqual(ref("gm_board"));
    expect((value(note, "ink") as { type: string; strokes: unknown[] }).strokes).toHaveLength(3);
    expect(prep.observed.saveStatus).toBe("Saved");
    const saved = await c.savedFile();
    expect(() => JSON.parse(saved)).not.toThrow();
    expect(saved).toContain("\n  ");
    expect(saved).toContain("Room 4");
    expect(saved).toContain("Fireball");

    // Zero leftover dice: every d20 is the stocked template or a goblin's own die.
    const { snapshot } = await c.gm.request("document", {});
    const dice = Object.values(snapshot.objects).filter((o) =>
      (o as { tag?: string[] }).tag?.includes("d20"),
    ) as { id: string }[];
    expect(dice.map((d) => d.id).sort()).toEqual(
      ["tpl_d20", templateDie, ...prep.goblinDice].sort(),
    );

    expect(took).toBeLessThan(90_000);
  }, 180_000);
});

/**
 * A sheet's header shows its owner: `value owner` drawn and `editor name`
 * hidden by `show_when`, in the authority's face view and, `onCanvas`, on
 * the canvas (brought into view inside the token's contents list).
 */
async function expectOwnerHeader(
  c: DriverContext,
  token: ObjectId,
  sheet: ObjectId,
  onCanvas: boolean,
) {
  const v = await view(c, sheet);
  expect(value(v, "owner")).toEqual(ref(token));
  const element = (type: string, cell: string) =>
    v.face?.elements.find((e) => e.type === type && "cell" in e && e.cell === cell);
  expect(element("value", "owner")).toMatchObject({ shown: true });
  expect(element("editor", "name")).toMatchObject({ shown: false });
  if (!onCanvas) return;
  const g = createGestures(c);
  await g.bringIntoView({ object: sheet, element: { cell: "owner" } });
  expect(g.elementShown(sheet, { cell: "owner" })).toBe(true);
  expect(g.elementShown(sheet, { cell: "name" })).toBe(false);
}
