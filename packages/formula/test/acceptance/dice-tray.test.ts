/**
 * FORMULAS.md §10 "A dice tray that totals itself", against
 * scenarios/dice-tray.json: the zone variant (`contents(this)`, dice moved
 * into the tray's rect) and the cup variant (the `contents` cell). The three
 * Roll steps are the scripted roll results written with `set`.
 */
import { list, ref } from "@vtt/schema";
import { describe, expect, it } from "vitest";
import { acceptance } from "../support/acceptance";

const acc = await acceptance("dice-tray");

describe(acc.title, () => {
  const t = acc.table();

  it(`${acc.at("setup")}: both sums are 0 with nothing in them`, () => {
    t.checkStep("setup", ["tray.tray_total", "cup.tray_total"]);
  });

  it(`${acc.at(2)}: rolled dice outside the tray do not count`, () => {
    t.set("die_a", "value", acc.roll(0));
    t.checkStep(0, ["tray.tray_total"]);
    t.set("die_b", "value", acc.roll(1));
    t.set("die_c", "value", acc.roll(2));
    t.checkStep(2, ["tray.tray_total"]);
  });

  it(`${acc.at(3)}: one die moved into the tray's rect`, () => {
    t.do(3);
    t.checkStep(3, ["tray.tray_total"]);
  });

  it(`${acc.at(4)}: two dice in the tray (one on the boundary)`, () => {
    t.do(4);
    t.checkStep(4, ["tray.tray_total"]);
  });

  it(`${acc.at(5)}: a non-die in the tray is ignored`, () => {
    t.do(5);
    t.checkStep(5, ["tray.tray_total"]);
  });

  it(`${acc.at(6)}: a die moved into the cup counts in the cup, not the tray`, () => {
    t.do(6);
    t.checkStep(6, ["cup.tray_total", "tray.tray_total"]);
  });

  it(`${acc.at(7)}: a die moved from the tray into the cup moves between sums`, () => {
    t.do(7);
    t.checkStep(7, ["cup.tray_total", "tray.tray_total"]);
  });

  it(`${acc.at(8)}: a die leaving the cup for the tray changes both sums`, () => {
    t.do(8);
    t.checkStep(8, ["cup.tray_total", "tray.tray_total"]);
  });

  it(`${acc.at(9)}: a die moved out of the tray's rect leaves its sum`, () => {
    t.do(9);
    t.checkStep(9, ["tray.tray_total", "cup.tray_total"]);
  });
});

describe(`${acc.title}: variant of ${acc.at(6)}`, () => {
  it("a non-die in the cup is ignored, and leaving changes nothing", () => {
    const t = acc.table();
    t.set("die_c", "value", acc.roll(2));
    t.do(6);
    const withDie = acc.expectedCell(6, "cup", "tray_total");
    expect(t.value("cup", "tray_total")).toEqual(withDie);
    // The scenario's gold token (value 50, tag token) goes into the cup.
    t.move("gold", { container: "cup" });
    expect(t.value("cup", "contents")).toEqual(list([ref("die_c"), ref("gold")]));
    expect(t.value("cup", "tray_total")).toEqual(withDie);
    t.move("gold", { board: "table", position: [0, 6] });
    expect(t.value("cup", "contents")).toEqual(list([ref("die_c")]));
    expect(t.value("cup", "tray_total")).toEqual(withDie);
  });
});

acc.coverageTest();
