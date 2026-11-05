/**
 * FORMULAS.md §10 "An Attack card", against scenarios/attack-card.json. The
 * card is the scenario's spawn step; Roll and Roll damage write the scripted
 * roll results with `set`; Apply's writes (`add` to the target's
 * damage_taken, `set(applied, true)`) and their undo are written by hand.
 * The three `when` guards are evaluated with `engine.evaluate` at each state.
 */
import { bool, num } from "@vtt/schema";
import { describe, it } from "vitest";
import { acceptance, totalOf } from "../support/acceptance";

const acc = await acceptance("attack-card");

describe(acc.title, () => {
  const t = acc.table();
  const GUARDS = ["attack1[Roll]", "attack1[Roll damage]", "attack1[Apply]"];

  it(`${acc.at(0)}: bonus 5, total 5, hit false with no target; every guard false`, () => {
    t.spawnStep(0);
    t.checkStep(0, ["attack1.bonus", "attack1.total", "attack1.hit", ...GUARDS]);
  });

  it(`${acc.at(1)}: with a target and no roll, hit is false and only Roll is enabled`, () => {
    t.do(1);
    t.checkStep(1, ["attack1.hit", ...GUARDS]);
  });

  it(`${acc.at(2)}: after roll 12, total 17 and hit true against ac 13; only Roll damage`, () => {
    t.set("attack1", "roll", acc.roll(0));
    t.checkStep(2, ["attack1.total", "attack1.hit", ...GUARDS]);
  });

  it(`${acc.at(3)}: with dmg set, only Apply is enabled`, () => {
    t.set("attack1", "dmg", acc.roll(1));
    t.checkStep(3, GUARDS);
  });

  it(`${acc.at(4)}: after Apply, every guard is false`, () => {
    const taken = totalOf(t.value("goblin1", "damage_taken"));
    t.set("goblin1", "damage_taken", num(taken + totalOf(acc.roll(1))));
    t.set("attack1", "applied", bool(true));
    t.checkStep(4, GUARDS);
  });

  it(`${acc.at(5)}: a second Apply is disabled (the state is unchanged by the refusal)`, () => {
    t.checkStep(5, ["attack1[Apply]"]);
  });

  it(`${acc.at(6)}: after undo of Apply, Apply is enabled again`, () => {
    t.set("goblin1", "damage_taken", num(0));
    t.set("attack1", "applied", bool(false));
    t.checkStep(6, GUARDS);
  });
});

acc.coverageTest();
