/**
 * FORMULAS.md §10 "Hit points", against scenarios/hit-points.json. The cases
 * mirror the scenario's expectations (FIXTURES.md §9): 27, 22, and 17 after
 * the override is cleared with `damage_taken` 10.
 */
import { describe, it } from "vitest";
import { acceptance } from "../support/acceptance";

const acc = await acceptance("hit-points");

describe(acc.title, () => {
  const t = acc.table();

  it(`${acc.at("setup")}: hp = max_hp - damage_taken is 27`, () => {
    t.checkStep("setup", ["aldric.hp"]);
  });

  it(`${acc.at(0)}: a set of damage_taken to 5 moves hp to 22`, () => {
    t.do(0);
    t.checkStep(0, ["aldric.hp"]);
  });

  it(`${acc.at(3)}: clearing the override restores tracking: hp is 17 after damage_taken 10`, () => {
    t.do(1);
    t.do(2);
    t.do(3);
    t.checkStep(3, ["aldric.hp"]);
  });
});

acc.coverageTest();
