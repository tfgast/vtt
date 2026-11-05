/**
 * FORMULAS.md §10 "A goblin that shows HIT when a die on it beats its AC",
 * against scenarios/goblin-hit.json. Placements are reached with
 * MemoryHost.move, so `on(this)` runs on real footprints and `z`.
 */
import { bool, list, num, ref, type Value } from "@vtt/schema";
import { describe, expect, it } from "vitest";
import { acceptance } from "../support/acceptance";

const acc = await acceptance("goblin-hit");

/** A 1d20 roll of 12: below the goblin's ac 13. Not in the scenario's script. */
const ROLL_12: Value = { type: "roll", expr: "1d20", dice: [12], dropped: [], total: 12 };

describe(acc.title, () => {
  const t = acc.table();

  it(`${acc.at("setup")}: hit is false with nothing on the goblin`, () => {
    t.checkStep("setup", ["goblin1.hit"]);
  });

  it(`${acc.at(1)}: hit is false with the die beside the goblin (footprints apart)`, () => {
    t.do(0);
    t.do(1);
    t.checkStep(1, ["goblin1.hit"]);
  });

  it(`${acc.at(3)}: hit is false with the unrolled die on top (total 0)`, () => {
    t.do(2);
    t.do(3);
    t.checkStep(3, ["die1.total", "goblin1.hit"]);
  });

  it(`${acc.at(4)}: hit is true with die1 (value = roll 15) on top with higher z`, () => {
    t.set("die1", "value", acc.roll(0));
    t.checkStep(4, ["die1.total", "goblin1.hit"]);
  });

  it(`${acc.at(5)}: hit is false once the goblin moves out from under the die`, () => {
    t.do(5);
    t.checkStep(5, ["goblin1.hit"]);
  });
});

describe(`${acc.title}: variants of ${acc.at(4)}`, () => {
  it("hit is false with a die on top whose total is 12", () => {
    const t = acc.table();
    for (const i of [0, 1, 2, 3]) t.do(i);
    t.set("die1", "value", ROLL_12);
    expect(t.value("die1", "total")).toEqual(num(12));
    expect(t.value("goblin1", "hit")).toEqual(bool(false));
  });

  it("hit is false with only a non-d20 object on top", () => {
    const t = acc.table();
    for (const i of [0, 1, 2, 3]) t.do(i);
    t.set("die1", "value", acc.roll(0));
    // die1 goes back into the bag; a token with a high total takes its place.
    t.move("die1", { container: "dice_bag" });
    t.create("coin", {
      tag: ["token"],
      shape: { type: "rect", width: 1, height: 1 },
      placement: { board: "table", position: [5.25, 5] },
      cells: { total: num(20), z: num(1) },
    });
    expect(t.evaluate("on(this)", "goblin1")).toEqual(list([ref("coin")]));
    expect(t.value("goblin1", "hit")).toEqual(bool(false));
  });
});

acc.coverageTest();
