/**
 * FORMULAS.md §10 "Shuffling", against scenarios/shuffling.json. The fixture
 * has no formula and no `when`; this file asserts that and nothing else.
 */
import { expect, it } from "vitest";
import { acceptance, scenarioSources } from "../support/acceptance";

const acc = await acceptance("shuffling");

it(`${acc.title}: has no formula or when source`, () => {
  expect(scenarioSources(acc.scenario)).toEqual([]);
});
