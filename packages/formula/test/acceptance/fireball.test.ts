/**
 * FORMULAS.md §10 "A Fireball card with a circle zone", against
 * scenarios/fireball.json. The card and its zone are the scenario's spawn
 * step (zone reference remapped); Lock targets' rows are spawned from the
 * row template with the targets the scenario's bind steps name; rolls are
 * the scripted results written with `set`; Apply all's writes are by hand.
 */
import { bool, EMPTY, list, num, ref } from "@vtt/schema";
import { describe, expect, it } from "vitest";
import { acceptance, totalOf } from "../support/acceptance";

const acc = await acceptance("fireball");

describe(acc.title, () => {
  const t = acc.table();

  it(`${acc.at(0)}: dc = caster.spell_dc; Lock targets enabled, Roll damage not`, () => {
    t.spawnStep(0);
    t.checkStep(0, ["fb1.dc", "fb1[Lock targets]", "fb1[Roll damage]"]);
  });

  it(`${acc.at(1)}: with the zone moved to [10,10] on the map, targets = [goblin1, goblin2]`, () => {
    t.do(1);
    t.checkStep(1, ["fb1.targets"]);
    expect(t.value("fb1", "rows")).toEqual(list([]));
  });

  it(`${acc.at(2)}: after Lock targets, Roll damage is the only card action enabled`, () => {
    // Lock targets: one row per target, named as the bind steps name them.
    for (const i of [3, 4]) {
      const bind = acc.step(i).do;
      if (bind.type !== "bind" || bind.where === undefined || bind.in === undefined) {
        throw new Error(`${acc.at(i)} is not a bind with where and in`);
      }
      const target = bind.where.value;
      if (target.type !== "ref") throw new Error(`${acc.at(i)}: where is not a ref`);
      t.spawn("save_row_t", bind.as, { container: bind.in }, {
        target: ref(target.object),
        owner: t.value(target.object, "owner") as ReturnType<typeof ref>,
      });
    }
    t.set("fb1", "locked", bool(true));
    t.checkStep(2, ["fb1[Lock targets]", "fb1[Roll damage]", "fb1[Apply all]"]);
  });

  it(`${acc.at(4)}: rows from the card's contents; each row's card, save_bonus, passed, damage_dealt`, () => {
    expect(t.value("fb1", "rows")).toEqual(list([ref("row_g1"), ref("row_g2")]));
    t.checkStep(4, [
      "row_g1.card",
      "row_g1.save_bonus",
      "row_g1.passed",
      "row_g1.damage_dealt",
      "row_g2.card",
      "row_g2.save_bonus",
      "row_g1[Roll save]",
    ]);
    expect(t.value("row_g2", "damage_dealt")).toEqual(EMPTY);
  });

  it(`${acc.at(5)}: moving the zone afterwards changes targets, not the rows`, () => {
    t.do(5);
    t.checkStep(5, ["fb1.targets", "fb1[Lock targets]"]);
    expect(t.value("fb1", "rows")).toEqual(list([ref("row_g1"), ref("row_g2")]));
  });

  it(`${acc.at(6)}: after Roll damage, an unsaved row's damage_dealt is the roll itself`, () => {
    t.set("fb1", "damage", acc.roll(0));
    t.checkStep(6, [
      "fb1[Roll damage]",
      "fb1[Apply all]",
      "row_g1.damage_dealt",
      "row_g2.damage_dealt",
    ]);
  });

  it(`${acc.at(7)}: a passed save halves the damage to a number; Apply all waits for every save`, () => {
    t.set("row_g1", "save_roll", acc.roll(1));
    t.checkStep(7, ["row_g1.passed", "row_g1.damage_dealt", "row_g1[Roll save]", "fb1[Apply all]"]);
  });

  it(`${acc.at(8)}: a failed save deals the roll result itself; Apply all enabled with both saves`, () => {
    t.set("row_g2", "save_roll", acc.roll(2));
    t.checkStep(8, ["row_g2.passed", "row_g2.damage_dealt", "fb1[Apply all]"]);
  });

  it(`${acc.at(9)}: Apply all adds each row's damage_dealt; then Apply all is disabled`, () => {
    for (const row of ["row_g1", "row_g2"]) {
      const target = t.value(row, "target");
      if (target.type !== "ref") throw new Error(`${row}.target is not a ref`);
      const taken = totalOf(t.value(target.object, "damage_taken"));
      t.set(target.object, "damage_taken", num(taken + totalOf(t.value(row, "damage_dealt"))));
    }
    t.set("fb1", "applied", bool(true));
    for (const target of ["goblin1", "goblin2"]) {
      expect(t.value(target, "damage_taken")).toEqual(acc.expectedCell(9, target, "damage_taken"));
    }
    t.checkStep(9, ["fb1[Apply all]"]);
  });

  it(`${acc.at(10)}: drift: dex_save -5 flips the pass to a fail`, () => {
    t.do(10);
    t.checkStep(10, ["row_g1.save_bonus", "row_g1.passed", "row_g1.damage_dealt"]);
  });
});

acc.coverageTest();
