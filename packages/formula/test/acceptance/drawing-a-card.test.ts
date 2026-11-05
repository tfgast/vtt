/**
 * FORMULAS.md §10 "Drawing a card", against scenarios/drawing-a-card.json.
 * Each Draw is reached by moving the card the step's `first(deck.contents)`
 * argument names into the hand the `owner.hand` argument names; both
 * arguments are sliced from the action's step source in the scenario.
 */
import { type Result, ref } from "@vtt/schema";
import { describe, expect, it } from "vitest";
import { acceptance } from "../support/acceptance";

const acc = await acceptance("drawing-a-card");
const [cardSource, handSource] = acc.stepArgs("draw_button", "Draw", 0);

const objectOf = (r: Result): string => {
  if (r.type !== "ref") throw new Error(`expected a reference, got ${JSON.stringify(r)}`);
  return r.object;
};

describe(acc.title, () => {
  const t = acc.table();

  /** Draw: move(first(deck.contents), owner.hand), with the arguments evaluated. */
  const draw = () => {
    const card = objectOf(t.evaluate(cardSource, "draw_button"));
    const hand = objectOf(t.evaluate(handSource, "draw_button"));
    t.move(card, { container: hand });
  };

  it(`${acc.at("setup")}: len(deck.contents) > 0 is true; first(deck.contents) is the top card`, () => {
    t.checkStep("setup", ["draw_button[Draw]"]);
    expect(t.evaluate(cardSource, "draw_button")).toEqual(ref("card_ace"));
  });

  it(`${acc.at(0)}: after one Draw the guard is still true; the next card is on top`, () => {
    draw();
    t.checkStep(0, ["draw_button[Draw]"]);
    expect(t.evaluate(cardSource, "draw_button")).toEqual(ref("card_king"));
  });

  it(`${acc.at(1)}: after the deck empties the guard is false`, () => {
    draw();
    t.checkStep(1, ["draw_button[Draw]"]);
  });
});

acc.coverageTest();
