/**
 * FORMULAS.md §10 "Re-hiding a room when the party leaves", against
 * scenarios/re-hiding-room.json: the room's `visible_to` formula
 * (`contents(this).where(tag has "pc")` composed with `len` and `if`) as the
 * PC moves in and out. Effective visibility is M5's; this is the cell.
 */
import { describe, it } from "vitest";
import { acceptance } from "../support/acceptance";

const acc = await acceptance("re-hiding-room");

describe(acc.title, () => {
  const t = acc.table();

  it(`${acc.at("setup")}: visible_to is gm with no PC inside`, () => {
    t.checkStep("setup", ["room.visible_to"]);
  });

  it(`${acc.at(0)}: visible_to is all with the PC inside`, () => {
    t.do(0);
    t.checkStep(0, ["room.visible_to"]);
  });

  it(`${acc.at(1)}: visible_to is gm again after he leaves`, () => {
    t.do(1);
    t.checkStep(1, ["room.visible_to"]);
  });

  it(`${acc.at(2)}: visible_to is all when he re-enters`, () => {
    t.do(2);
    t.checkStep(2, ["room.visible_to"]);
  });

  it(`${acc.at(5)}: after the override (steps 3–4) is cleared, the formula re-hides the room`, () => {
    t.do(3);
    t.do(4);
    t.do(5);
    t.checkStep(5, ["room.visible_to"]);
  });
});

acc.coverageTest();
