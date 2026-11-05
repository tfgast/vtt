/**
 * Every production scenario through the scenario runner, in both modes
 * (vtt-75c.13; vtt-1xv.10): since M5 every step type and expectation is
 * supported, so each scenario runs complete, with every step run, no
 * expectation skipped, and its dice script used up (leftover entries fail a
 * complete run).
 */
import { describe, expect, test } from "vitest";
import { loadScenarioFile, scenarioFiles } from "./runner/load";
import { type RunReport, runScenario } from "./runner/run";

type Expected = Omit<RunReport, "title">;

const complete = (n: number): Expected => ({
  complete: true,
  stepsRun: n,
  stepsTotal: n,
  skipped: {},
});

const EXPECTED: Record<string, Expected> = {
  "hit-points.json": complete(5),
  "difficult-terrain.json": complete(4),
  "re-hiding-room.json": complete(6),
  "goblin-hit.json": complete(6),
  "attack-card.json": complete(7),
  "fireball.json": complete(12),
  "die-with-modifier.json": complete(7),
  "dice-tray.json": complete(10),
  "drawing-a-card.json": complete(4),
  "shuffling.json": complete(2),
};

test("the table names every scenario file", async () => {
  expect((await scenarioFiles()).sort()).toEqual(Object.keys(EXPECTED).sort());
});

describe.each([
  ["direct", false],
  ["round-trip", true],
])("%s", (_mode, roundTrip) => {
  test.each(Object.entries(EXPECTED))("%s", async (file, expected) => {
    const scenario = await loadScenarioFile(file);
    const report = runScenario(scenario, { roundTrip });
    expect(report).toEqual({ title: scenario.title, ...expected });
  });
});
