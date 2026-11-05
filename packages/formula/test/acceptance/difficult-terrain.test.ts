/**
 * FORMULAS.md §10 "Difficult terrain", against
 * scenarios/difficult-terrain.json: `zones_containing(this)` composed with
 * `where`, `len`, and `if`, on real zone geometry.
 */
import { describe, it } from "vitest";
import { acceptance } from "../support/acceptance";

const acc = await acceptance("difficult-terrain");

describe(acc.title, () => {
  const t = acc.table();

  it(`${acc.at("setup")}: speed is 30 outside every zone`, () => {
    t.checkStep("setup", ["aldric.speed"]);
  });

  it(`${acc.at(0)}: speed is 30 inside a zone not tagged difficult`, () => {
    t.do(0);
    t.checkStep(0, ["aldric.speed"]);
  });

  it(`${acc.at(1)}: speed is 15 inside the difficult zone`, () => {
    t.do(1);
    t.checkStep(1, ["aldric.speed"]);
  });

  it(`${acc.at(2)}: speed is 15 inside two overlapping difficult zones (halved once)`, () => {
    t.do(2);
    t.checkStep(2, ["aldric.speed"]);
  });

  it(`${acc.at(3)}: speed is 30 again after leaving`, () => {
    t.do(3);
    t.checkStep(3, ["aldric.speed"]);
  });
});

acc.coverageTest();
