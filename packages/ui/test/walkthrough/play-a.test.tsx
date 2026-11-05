/**
 * The walkthrough's first play half (vtt-nb8.10; DESIGN.md §8.4 steps 7–11
 * as amended by vtt-nb8.2; M6-D1, M6-D3; M6 plan Q3, Q13): `runPrep` then
 * `runPlayA` on a fresh stocked table, every outcome asserted through the
 * GM assertion client and, where the step says drawn, the recording
 * renderer.
 */
import type { ObjectView, Viewer } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import type { CharacterName, DriverContext } from "./contract";
import { startWalkthrough } from "./infra";
import {
  ALDRIC_BACK,
  ALDRIC_BINDER_AT,
  ALDRIC_IN_ROOM2,
  PLAY_A_DICE,
  ROOM1_SPOTS,
  runPlayA,
  STRIP_SLOTS,
  TRAY_DROPS,
  TRAY_FORMULA,
} from "./play-a";
import { CHARACTERS, PREP_DICE, runPrep } from "./prep";
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

const value = (v: ObjectView, cell: string) => v.cells[cell]?.value;
const num = (n: number) => ({ type: "number", value: n });
const ref = (id: string) => ({ type: "ref", object: id });
const bool = (b: boolean) => ({ type: "boolean", value: b });
/** A scripted roll's value: `expr` rolled to the one die `n`. */
const rolled = (expr: string, n: number) => ({
  type: "roll",
  expr,
  dice: [n],
  dropped: [],
  total: n,
});
const refs = (v: ObjectView, cell: string): ObjectId[] => {
  const l = value(v, cell) as { type?: string; items?: { object?: string }[] } | undefined;
  return l?.type === "list" ? (l.items ?? []).flatMap((i) => (i.object ? [i.object] : [])) : [];
};
const NAMES: readonly CharacterName[] = ["Aldric", "Brenna", "Corin", "Dara"];
const inRect = (p: number[], [x, y, w, h]: [number, number, number, number]) =>
  (p[0] as number) > x &&
  (p[0] as number) < x + w &&
  (p[1] as number) > y &&
  (p[1] as number) < y + h;
const position = (v: ObjectView): number[] =>
  ((value(v, "position") as { items: { value: number }[] }).items ?? []).map((i) => i.value);

describe(`play A: ${WALKTHROUGH_STEPS.slice(6, 11)
  .map((s) => s.id)
  .join(", ")} (vtt-nb8.10)`, () => {
  test("runPrep then runPlayA perform §8.4 steps 7–11 through the UI within 120 s", async () => {
    const started = Date.now();
    const c = await startWalkthrough({ dice: [...PREP_DICE, ...PLAY_A_DICE] });
    ctx = c;
    const prep = await runPrep(c);
    const prepped = Date.now();
    const play = await runPlayA(c, prep);
    const took = Date.now() - started;
    console.info(
      `runPrep took ${((prepped - started) / 1000).toFixed(1)} s, runPlayA ${((Date.now() - prepped) / 1000).toFixed(1)} s`,
    );
    const o = play.observed;
    const m = prep.mapOrigin;
    const at = (p: [number, number]) => [m[0] + p[0], m[1] + p[1]];
    const pc = prep.characters;
    const aldric: Viewer = { type: "character", id: pc.Aldric.token };

    // Step 7: six covers as Aldric; room 1 revealed by hand leaves five.
    expect(o.coversAtStart).toBe(6);
    expect(o.coversAfterRoom1).toBe(5);
    expect(o.room1CoveredAfter).toBe(false);
    const room1 = await view(c, prep.rooms[1].id);
    expect(value(room1, "visible_to")).toEqual({ type: "viewers", viewers: ["all"] });
    expect(room1.cells.visible_to?.kind).not.toBe("formula");

    // Step 8: the party moved to Crypt and into room 1; room 3 revealed; room 2 reveals and re-hides.
    const zones = await c.gm.request("zones", { board: prep.crypt });
    const inZone = (id: ObjectId) => zones.zones.find((z) => z.id === id)?.contents ?? [];
    for (const name of NAMES) {
      const before = CHARACTERS.find((ch) => ch.name === name)?.at;
      // "Move selection to board…" keeps positions (the GM board's points, on Crypt).
      expect(o.movedToCrypt[name]).toEqual({ board: prep.crypt, position: before });
      expect(o.inRoom1[name]).toEqual(at(ROOM1_SPOTS[name]));
      expect(inRect(o.inRoom1[name], prep.rooms[1].rect)).toBe(true);
    }
    expect(o.aldricInRoom2).toEqual(at(ALDRIC_IN_ROOM2));
    expect(inRect(o.aldricInRoom2, prep.rooms[2].rect)).toBe(true);
    expect(o.aldricBack).toEqual(at(ALDRIC_BACK));
    expect(inRect(o.aldricBack, prep.rooms[1].rect)).toBe(true);
    const room3 = await view(c, prep.rooms[3].id);
    expect(value(room3, "visible_to")).toEqual({ type: "viewers", viewers: ["all"] });
    expect(o.room2CoveredWithAldricIn).toBe(false);
    expect(o.coversAldricInRoom2).toBe(3);
    expect(o.room2CoveredAfterLeaving).toBe(true);
    expect(o.coversAldricBack).toBe(4);
    const room2 = await view(c, prep.rooms[2].id);
    expect(value(room2, "visible_to")).toEqual({ type: "viewers", viewers: ["gm"] });
    expect(inZone(prep.rooms[2].id)).toEqual([]);

    // Step 9: the tray sums the four raw dice; the strip lines the tokens up by initiative.
    const tray = await view(c, play.tray);
    expect(zones.zones.map((z) => z.id)).toContain(play.tray);
    expect(value(tray, "name")).toEqual({ type: "text", value: "Tray" });
    expect(tray.cells.text).toMatchObject({ kind: "formula", source: TRAY_FORMULA.slice(1) });
    expect(value(tray, "text")).toEqual(num(46));
    expect(o.trayText).toEqual(num(46));
    expect(play.trayDice).toHaveLength(4);
    expect([...inZone(play.tray)].sort()).toEqual([...play.trayDice].sort());
    for (const [i, die] of play.trayDice.entries()) {
      const d = await view(c, die);
      expect(value(d, "template")).toEqual(ref("tpl_d20"));
      expect(value(d, "value")).toEqual(rolled("1d20", [14, 9, 17, 6][i] as number));
      const [x, y] = position(d);
      expect(x).toBeCloseTo(at(TRAY_DROPS[i] as [number, number])[0] as number, 6);
      expect(y).toBeCloseTo(at(TRAY_DROPS[i] as [number, number])[1] as number, 6);
    }
    expect(play.initiative.map((e) => e.name)).toEqual(["Corin", "Aldric", "Brenna", "Dara"]);
    const rollOf: Record<CharacterName, number> = { Aldric: 14, Brenna: 9, Corin: 17, Dara: 6 };
    for (const e of play.initiative) {
      const name = e.name as CharacterName;
      expect(e.roll).toBe(rollOf[name]);
      const sheet = await view(c, pc[name].sheet);
      const dex = (value(sheet, "dex_save") as { value: number }).value;
      expect(e.total).toBe(e.roll + dex);
    }
    expect(play.initiative.map((e) => e.total)).toEqual([21, 15, 9, 8]);
    const strip = await view(c, play.strip);
    expect(zones.zones.map((z) => z.id)).toContain(play.strip);
    expect(value(strip, "name")).toEqual({ type: "text", value: "Initiative" });
    // Zones are read now, after step 11: the goblin's die lies on Aldric in the strip.
    expect([...inZone(play.strip)].sort()).toEqual(
      [pc.Aldric.token, pc.Brenna.token, pc.Corin.token, pc.Dara.token, play.goblinDie].sort(),
    );
    for (const [i, e] of play.initiative.entries()) {
      const token = await view(c, pc[e.name as CharacterName].token);
      expect(value(token, "board")).toEqual(ref(prep.crypt));
      expect(position(token)).toEqual(at(STRIP_SLOTS[i] as [number, number]));
    }

    // Step 10: Aldric's binder on Crypt; the working copy; Roll, Roll damage, Apply.
    expect(play.aldricBinder).toBe(pc.Aldric.binder);
    const binder = await view(c, play.aldricBinder);
    expect(value(binder, "board")).toEqual(ref(prep.crypt));
    expect(value(binder, "container")).toEqual({ type: "empty" });
    expect(position(binder)).toEqual(at(ALDRIC_BINDER_AT));
    expect(value(binder, "owner")).toEqual(ref(pc.Aldric.token));
    expect(refs(await view(c, pc.Aldric.token), "contents")).toEqual([pc.Aldric.sheet]);
    const binderContents = refs(binder, "contents");
    expect(binderContents.indexOf(play.attackCopy)).toBe(
      binderContents.indexOf(pc.Aldric.attackTemplate) + 1,
    );
    expect(o.copyRightAfterTemplate).toBe(true);
    expect(o.copyExpanded).toBe(true);
    expect(o.copySelected).toBe(true);

    const g1 = c.byName("G1");
    expect(g1).toBe(prep.goblins[0]);
    expect(o.g1After).toEqual(o.g1Before);
    const copy = await view(c, play.attackCopy);
    expect(copy.is_template).toBe(false);
    expect(value(copy, "template")).toEqual(ref(pc.Aldric.attackTemplate));
    expect(value(copy, "target")).toEqual(ref(g1));
    expect(value(copy, "roll")).toEqual(rolled("1d20", 15));
    expect(value(copy, "total")).toEqual(num(20));
    expect(value(copy, "hit")).toEqual(bool(true));
    expect(value(copy, "dmg")).toEqual(rolled("1d8", 6));
    expect(value(copy, "applied")).toEqual(bool(true));
    expect(o.hitShown).toBe(true);
    // AC does not show: G1's `ac` is absent from Aldric's view, the app's and the authority's.
    expect(o.g1AcInAldricView).toBe(false);
    expect((await view(c, g1, aldric)).cells.ac).toBeUndefined();
    const g1View = await view(c, g1);
    expect(value(g1View, "damage_taken")).toEqual(num(6));
    expect(value(g1View, "hp")).toEqual(num(1));
    expect(o.g1HpShown).toBe(true);
    expect(o.g1HpText).toContain("1");
    // The log: the newest group is Aldric's Apply, naming G1 in a sentence.
    expect(o.applyGroup.label).toBe("Apply");
    expect(o.applyGroup.actor).toBe("Aldric");
    expect(o.applyGroup.sentences.some((s) => s.includes("G1"))).toBe(true);
    const log = await c.gm.request("log", { limit: 5 });
    const newestApply = log.groups.find((gr) => gr.label === "Apply");
    expect(newestApply?.actor).toEqual({ type: "character", id: pc.Aldric.token });
    // Apply stays drawn, disabled, says why; pressing it sends nothing.
    expect(o.applyShownAfter).toBe(true);
    expect(o.applyEnabledAfter).toBe(false);
    expect(o.applyNotice).toMatch(/^Apply: its condition is false/);
    expect(o.revisionAfterDisabledApply).toBe(o.revisionBeforeDisabledApply);
    const applyState = copy.action_states?.find((s) => s.name === "Apply");
    expect(applyState).toMatchObject({ enabled: false });

    // Step 11: G2's die out of G2's list, onto Aldric, rolled: 13 + 4 = 17 ≥ 16.
    const g2 = await view(c, prep.goblins[1] as ObjectId);
    expect(play.goblinDie).toBe(prep.goblinDice[1]);
    expect(refs(g2, "contents")).toEqual([]);
    const die = await view(c, play.goblinDie);
    expect(value(die, "board")).toEqual(ref(prep.crypt));
    expect(value(die, "owner")).toEqual(ref(prep.goblins[1] as ObjectId));
    expect(value(die, "value")).toEqual(rolled("1d20", 13));
    expect(value(die, "total")).toEqual(num(17));
    const aldricToken = await view(c, pc.Aldric.token);
    expect(position(die)).toEqual(position(aldricToken));
    expect(value(aldricToken, "hit")).toEqual(bool(true));
    expect(o.aldricHitShown).toBe(true);

    // hp for play B: the characters at full, G1 at 1, the other goblins at 7.
    expect(play.hp).toEqual({
      Aldric: 24,
      Brenna: 30,
      Corin: 18,
      Dara: 16,
      G1: 1,
      G2: 7,
      G3: 7,
      G4: 7,
      G5: 7,
      G6: 7,
      G7: 7,
      G8: 7,
    });

    // Zero leftover dice: the script's last entry (the goblin's 13) was rolled, so every
    // entry was used in order; and the d20s on the table are the template, the goblin
    // template's die, the eight goblins' dice and the four tray dice.
    const { snapshot } = await c.gm.request("document", {});
    const d20s = Object.values(snapshot.objects).filter((ob) =>
      (ob as { tag?: string[] }).tag?.includes("d20"),
    ) as { id: string }[];
    const goblinTemplate = await view(c, prep.goblinTemplate);
    expect(d20s.map((d) => d.id).sort()).toEqual(
      ["tpl_d20", ...refs(goblinTemplate, "contents"), ...prep.goblinDice, ...play.trayDice].sort(),
    );

    // The end state play B continues from: GM view on Crypt.
    expect(c.session.viewerKey()).toBe("gm");
    expect(c.session.getSnapshot().activeBoard).toBe(prep.crypt);

    expect(took).toBeLessThan(120_000);
  }, 180_000);
});
