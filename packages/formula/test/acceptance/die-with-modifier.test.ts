/**
 * FORMULAS.md §10 "A die with a modifier", against
 * scenarios/die-with-modifier.json. Spawns are built with the scenario's own
 * spawn steps (template copy plus the step's cells); each Roll is the
 * scripted roll result written with `set`.
 */
import { describe, it } from "vitest";
import { acceptance } from "../support/acceptance";

const acc = await acceptance("die-with-modifier");

describe(acc.title, () => {
  const t = acc.table();

  it(`${acc.at(0)}: the GM's loose die has total 0 before the roll`, () => {
    t.spawnStep(0);
    t.checkStep(0, ["gm_die.total"]);
  });

  it(`${acc.at(1)}: the loose die's total is 14 after value = roll 14`, () => {
    t.set("gm_die", "value", acc.roll(0));
    t.checkStep(1, ["gm_die.total"]);
  });

  it(`${acc.at(2)}: Aldric's die has modifier = owner.attack_bonus 5 and total 5`, () => {
    t.spawnStep(2);
    t.checkStep(2, ["aldric_die.modifier", "aldric_die.total"]);
  });

  it(`${acc.at(3)}: Aldric's die totals 16 after roll 11`, () => {
    t.set("aldric_die", "value", acc.roll(1));
    t.checkStep(3, ["aldric_die.total", "gm_die.total"]);
  });

  it(`${acc.at(4)}: attack_bonus 6 moves total to 17 without a reroll`, () => {
    t.do(4);
    t.checkStep(4, ["aldric_die.modifier", "aldric_die.total"]);
  });

  it(`${acc.at(5)}: the goblin's die has modifier 4 and total 4`, () => {
    t.spawnStep(5);
    t.checkStep(5, ["goblin_die.modifier", "goblin_die.total"]);
  });

  it(`${acc.at(6)}: the goblin's die totals 13 after roll 9`, () => {
    t.set("goblin_die", "value", acc.roll(2));
    t.checkStep(6, ["goblin_die.total", "aldric_die.total"]);
  });
});

acc.coverageTest();
