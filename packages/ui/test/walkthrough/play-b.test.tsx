/**
 * The walkthrough's second play half (vtt-nb8.11; DESIGN.md §8.4 steps
 * 12–15 as amended by vtt-nb8.2; §7 save, reopen and undo across a
 * restart; M6-D1, M6-D2, M6-D3; M6 plan Q3, Q13): `runPrep`, `runPlayA`
 * then `runPlayB` on a fresh stocked table, every outcome asserted through
 * the GM assertion client and, where the step says drawn, the recording
 * renderer.
 */
import type { ObjectView, Viewer } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import type { DriverContext } from "./contract";
import { startWalkthrough } from "./infra";
import { PLAY_A_DICE, runPlayA } from "./play-a";
import {
  BRENNA_IN_ROOM3,
  FIREBALL_AT,
  NOTE_AT,
  NOTE_TEXT,
  PLAY_B_DICE,
  predictUndo,
  runPlayB,
  TRAP_DIE_AT,
  ZONE_DROP,
  ZONE_GRAB,
  ZONE_NUDGE,
} from "./play-b";
import { PREP_DICE, runPrep } from "./prep";
import { WALKTHROUGH_STEPS } from "./steps";

let ctx: DriverContext | null = null;

afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

const GM: Viewer = { type: "gm" };

async function view(c: DriverContext, id: ObjectId, viewer: Viewer = GM): Promise<ObjectView> {
  const { objects, missing } = await c.gm.request("get_objects", { ids: [id], viewer });
  expect(missing).toEqual([]);
  const [v] = objects;
  if (v === undefined) throw new Error(`no view of ${id}`);
  return v;
}

async function gone(c: DriverContext, id: ObjectId): Promise<boolean> {
  const { objects, missing } = await c.gm.request("get_objects", { ids: [id], viewer: GM });
  return objects.length === 0 && missing.includes(id);
}

const value = (v: ObjectView, cell: string) => v.cells[cell]?.value;
const num = (n: number) => ({ type: "number", value: n });
const text = (s: string) => ({ type: "text", value: s });
const ref = (id: string) => ({ type: "ref", object: id });
const bool = (b: boolean) => ({ type: "boolean", value: b });
const rolled = (expr: string, dice: number[]) => ({
  type: "roll",
  expr,
  dice,
  dropped: [],
  total: dice.reduce((a, b) => a + b, 0),
});
const refs = (v: ObjectView, cell: string): ObjectId[] => {
  const l = value(v, cell) as { type?: string; items?: { object?: string }[] } | undefined;
  return l?.type === "list" ? (l.items ?? []).flatMap((i) => (i.object ? [i.object] : [])) : [];
};
const position = (v: ObjectView): number[] =>
  ((value(v, "position") as { items: { value: number }[] }).items ?? []).map((i) => i.value);
const inRect = (p: number[], [x, y, w, h]: [number, number, number, number]) =>
  (p[0] as number) > x &&
  (p[0] as number) < x + w &&
  (p[1] as number) > y &&
  (p[1] as number) < y + h;

describe(`play B: ${WALKTHROUGH_STEPS.slice(11, 15)
  .map((s) => s.id)
  .join(", ")} (vtt-nb8.11)`, () => {
  test("runPrep, runPlayA then runPlayB perform §8.4 steps 12–15 within 180 s", async () => {
    const started = Date.now();
    const c = await startWalkthrough({ dice: [...PREP_DICE, ...PLAY_A_DICE, ...PLAY_B_DICE] });
    ctx = c;
    const prep = await runPrep(c);
    const prepped = Date.now();
    const playA = await runPlayA(c, prep);
    const playedA = Date.now();
    const play = await runPlayB(c, prep, playA);
    const took = Date.now() - started;
    const s = (a: number, b: number) => ((b - a) / 1000).toFixed(1);
    console.info(
      `runPrep took ${s(started, prepped)} s, runPlayA ${s(prepped, playedA)} s, runPlayB ${s(playedA, Date.now())} s`,
    );
    const o = play.observed;
    const m = prep.mapOrigin;
    const at = (p: [number, number]) => [m[0] + p[0], m[1] + p[1]];
    const pc = prep.characters;
    const [g1, g2, g3, g4] = ["G1", "G2", "G3", "G4"].map((n) => c.byName(n)) as [
      ObjectId,
      ObjectId,
      ObjectId,
      ObjectId,
    ];
    expect([g1, g2, g3, g4]).toEqual(prep.goblins.slice(0, 4));
    const room3 = prep.rooms[3].rect;

    // Step 12: Brenna steps into room 3.
    expect(o.brennaAt).toEqual(at(BRENNA_IN_ROOM3));
    expect(inRect(o.brennaAt, room3)).toBe(true);

    // The Fireball card: a copy of Aldric's template, with its zone; the dc override copied.
    const template = await view(c, prep.fireballTemplate);
    const [templateZone] = refs(template, "contents");
    const card = await view(c, o.fireballCopy);
    expect(card.is_template).toBe(false);
    expect(value(card, "template")).toEqual(ref(prep.fireballTemplate));
    expect(value(card, "name")).toEqual(text("Fireball"));
    expect(value(card, "board")).toEqual(ref(prep.crypt));
    expect(position(card)).toEqual(at(FIREBALL_AT));
    expect(value(card, "caster")).toEqual(ref(pc.Aldric.token));
    // Copied verbatim from the template (M6-D15), so the GM's presses are Aldric's.
    expect(value(card, "owner")).toEqual(ref(pc.Aldric.token));
    expect(value(card, "damage_dice")).toEqual({ type: "dice", expr: "8d6" });
    expect(card.cells.dc).toMatchObject({
      kind: "formula",
      source: "caster.spell_dc",
      value: num(15),
    });
    expect(card.cells.dc).toEqual(template.cells.dc);
    expect(value(card, "zone")).toEqual(ref(o.fireballZone));
    expect(refs(template, "contents")).toEqual([templateZone]);
    const zone = await view(c, o.fireballZone);
    expect(o.fireballZone).not.toBe(templateZone);
    expect(value(zone, "template")).toEqual(ref(templateZone as ObjectId));
    // The zone was dragged out of the card onto room 3, then nudged.
    expect(o.zoneDroppedAt).toEqual(at(ZONE_DROP));
    for (const [i, v] of o.zoneNudgedAt.entries()) {
      expect(v).toBeCloseTo(at(ZONE_NUDGE)[i] as number, 6);
    }
    expect(value(zone, "board")).toEqual(ref(prep.crypt));
    expect(value(zone, "container")).toEqual({ type: "empty" });
    // The nudge was released over G1's contents list [-0.8, 0.9, 1.6, 0.8], hidden
    // while G1 is unselected (M6-D12), and the zone still landed on the board.
    const [g1x, g1y] = position(await view(c, g1)) as [number, number];
    const [nx, ny] = at(ZONE_NUDGE) as [number, number];
    const release = [nx + ZONE_GRAB[0], ny + ZONE_GRAB[1]];
    expect(inRect(release, [g1x - 0.8, g1y + 0.9, 1.6, 0.8])).toBe(true);
    expect([...o.targetsDropped].sort()).toEqual([g1, g2, pc.Brenna.token].sort());
    expect(o.targetsNudged).toEqual([g1, g2, g3]);
    expect(refs(card, "targets")).toEqual([g1, g2, g3]);

    // Lock targets: three rows, in target order; damage once; each save; Apply all.
    expect(o.rows).toHaveLength(3);
    expect(refs(card, "rows")).toEqual(o.rows);
    expect(refs(card, "contents")).toEqual(o.rows);
    expect(value(card, "locked")).toEqual(bool(true));
    expect(value(card, "damage")).toEqual(rolled("8d6", [6, 5, 4, 3, 2, 1, 6, 1]));
    expect(value(card, "dc")).toEqual(num(15));
    expect(value(card, "applied")).toEqual(bool(true));
    // A failed save deals `card.damage` itself (the 8d6 roll, totalling 28); a passed one
    // floor(28 / 2) = 14. G1's 15 + dex_save 2 = 17 ≥ dc 15 passes; G2's 7, G3's 14 fail.
    const fireballRoll = rolled("8d6", [6, 5, 4, 3, 2, 1, 6, 1]);
    const saves = [
      { target: g1, roll: 15, passed: true, dealt: num(14), taken: 20 },
      { target: g2, roll: 5, passed: false, dealt: fireballRoll, taken: 28 },
      { target: g3, roll: 12, passed: false, dealt: fireballRoll, taken: 28 },
    ];
    for (const [i, want] of saves.entries()) {
      const row = await view(c, o.rows[i] as ObjectId);
      expect(value(row, "target")).toEqual(ref(want.target as ObjectId));
      expect(value(row, "save_roll")).toEqual(rolled("1d20", [want.roll]));
      expect(value(row, "passed")).toEqual(bool(want.passed));
      expect(value(row, "damage_dealt")).toEqual(want.dealt);
      const goblin = await view(c, want.target as ObjectId);
      expect(value(goblin, "damage_taken")).toEqual(num(want.taken));
    }
    expect(value(await view(c, pc.Brenna.token), "damage_taken")).toEqual(num(0));
    // Each Roll save, pressed in GM view, is the goblin's: its row is owned by its target (M6-D20).
    const saveActors = o.logShown
      .filter((gr) => gr.label === "Roll save")
      .sort((a, b) => a.index - b.index)
      .map((gr) => gr.actor);
    expect(saveActors).toEqual(["G1", "G2", "G3"]);
    expect(o.applyAllGroup.label).toBe("Apply all");
    expect(o.applyAllGroup.actor).toBe("Aldric");
    // One damage_taken sentence per goblin, with the exact change; none for Brenna.
    const damageSentences = o.applyAllGroup.sentences.filter((t) => t.includes(".damage_taken "));
    expect(damageSentences).toEqual([
      "Added 14 to G1.damage_taken (now 20)",
      "Added 28 to G2.damage_taken (now 28)",
      "Added 28 to G3.damage_taken (now 28)",
    ]);
    for (const name of ["G1", "G2", "G3"]) {
      expect(o.applyAllGroup.sentences.filter((t) => t.includes(`${name}.damage_taken`))).toEqual(
        damageSentences.filter((t) => t.includes(` ${name}.`)),
      );
    }
    expect(o.applyAllGroup.sentences.some((t) => t.includes("Brenna"))).toBe(false);

    // Step 13: a sticky note with the DC; a loose d20 rolled in the tray.
    const note = await view(c, o.note);
    expect(value(note, "template")).toEqual(ref("tpl_note"));
    expect(value(note, "board")).toEqual(ref(prep.crypt));
    expect(position(note)).toEqual(at(NOTE_AT));
    expect(value(note, "text")).toEqual(text(NOTE_TEXT));
    const trapDie = await view(c, o.trapDie);
    expect(value(trapDie, "template")).toEqual(ref("tpl_d20"));
    expect(value(trapDie, "value")).toEqual(rolled("1d20", [8]));
    const [dx, dy] = position(trapDie);
    expect(dx).toBeCloseTo(at(TRAP_DIE_AT)[0] as number, 6);
    expect(dy).toBeCloseTo(at(TRAP_DIE_AT)[1] as number, 6);
    const zones = await c.gm.request("zones", { board: prep.crypt });
    expect(zones.zones.find((z) => z.id === playA.tray)?.contents).toContain(o.trapDie);
    expect(o.trayText).toEqual(num(54));
    expect(value(await view(c, playA.tray), "text")).toEqual(num(54));

    // Step 14: the spent card discarded; a fresh copy on G4, applied and undone.
    expect(o.discardShown).toBe(true);
    expect(o.discardEnabled).toBe(true);
    expect(o.copyAfterDiscard).toBe(false);
    expect(await gone(c, playA.attackCopy)).toBe(true);
    const binder = await view(c, playA.aldricBinder);
    const binderContents = refs(binder, "contents");
    expect(binderContents).not.toContain(playA.attackCopy);
    expect(binderContents.indexOf(o.freshCopy)).toBe(
      binderContents.indexOf(pc.Aldric.attackTemplate) + 1,
    );
    const fresh = await view(c, o.freshCopy);
    expect(fresh.is_template).toBe(false);
    expect(value(fresh, "template")).toEqual(ref(pc.Aldric.attackTemplate));
    expect(value(fresh, "target")).toEqual(ref(g4));
    expect(value(fresh, "roll")).toEqual(rolled("1d20", [18]));
    expect(value(fresh, "total")).toEqual(num(23));
    expect(value(fresh, "hit")).toEqual(bool(true));
    expect(o.g4DamageAfterApply).toBe(5);
    expect(o.g4DamageAfterUndo).toBe(0);
    expect(o.freshAppliedAfterUndo).toEqual(bool(false));
    // The mistaken delete, undone: G4 back under its id with its die.
    expect(o.g4SelectedBeforeDelete).toBe(true);
    expect(o.g4AfterDelete).toBe(false);
    expect(o.g4DieAfterDelete).toBe(false);
    const g4View = await view(c, g4);
    expect(value(g4View, "name")).toEqual(text("G4"));
    expect(value(g4View, "damage_taken")).toEqual(num(0));
    const g4Die = prep.goblinDice[3] as ObjectId;
    expect(refs(g4View, "contents")).toEqual([g4Die]);
    expect(value(await view(c, g4Die), "owner")).toEqual(ref(g4));
    // The Log tab: the Apply group marked undone, the delete too; scrolled back to the agent.
    const applies = o.logShown.filter((gr) => gr.label === "Apply" && gr.actor === "Aldric");
    expect(applies[0]?.undone).toBe(true);
    expect(applies.slice(1).every((gr) => !gr.undone)).toBe(true);
    expect(o.logShown.find((gr) => gr.label === "Fireball for Aldric")?.actor).toBe(
      "walkthrough-agent",
    );
    expect(o.logShown.find((gr) => gr.label === "Apply all")?.undone).toBe(false);
    const deletes = o.logShown.filter((gr) => gr.label === "Delete G4");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ actor: "GM", undone: true });

    // Step 15: saved; after the restart every object, cell, containment and log group is equal.
    expect(o.saveStatus).toBe("Saved");
    expect(o.savedText).toContain(NOTE_TEXT);
    expect(o.activeBoardAfterRestart).toBe(prep.crypt);
    expect(o.after.boards).toEqual(o.before.boards);
    expect(o.after.objects).toEqual(o.before.objects);
    // Evaluated values too: every object's GM cell views (values, formulas, overrides).
    expect(Object.keys(o.before.views)).toHaveLength(
      Object.keys(o.before.objects as object).length,
    );
    expect(o.after.views).toEqual(o.before.views);
    expect(o.after.groups).toEqual(o.before.groups);
    expect(Object.keys(o.after.objects as object)).toContain(g4);
    expect(Object.keys(o.after.objects as object)).toContain(g4Die);
    // Ctrl+Z after the restart reverses exactly the group the captured log predicts.
    expect(predictUndo(o.before.groups)).toEqual(o.predicted);
    // Here that is the wrong goblin's Roll damage (the Apply and the Delete are undone).
    expect(o.predicted).toMatchObject({
      label: "Roll damage",
      actor: { type: "character", id: pc.Aldric.token },
    });
    expect(value(fresh, "dmg")).toEqual({ type: "empty" });
    const [undo, ...rest] = o.afterUndo;
    expect(undo).toMatchObject({ kind: "undo", undoes: o.predicted.index, undone: false });
    expect(undo?.index).toBe((o.before.groups[0]?.index as number) + 1);
    expect(rest).toEqual(
      o.before.groups.map((gr) => (gr.index === o.predicted.index ? { ...gr, undone: true } : gr)),
    );

    // Zero leftover dice: the script's last entry (the wrong goblin's 1d8 5) was rolled, so
    // every entry was used in order; and the d20s on the table are the expected ones.
    expect(o.freshDmg).toEqual(rolled("1d8", [5]));
    const { snapshot } = await c.gm.request("document", {});
    const d20s = Object.values(snapshot.objects).filter((ob) =>
      (ob as { tag?: string[] }).tag?.includes("d20"),
    ) as { id: string }[];
    const goblinTemplate = await view(c, prep.goblinTemplate);
    expect(d20s.map((d) => d.id).sort()).toEqual(
      [
        "tpl_d20",
        ...refs(goblinTemplate, "contents"),
        ...prep.goblinDice,
        ...playA.trayDice,
        o.trapDie,
      ].sort(),
    );

    expect(took).toBeLessThan(180_000);
  }, 240_000);
});
