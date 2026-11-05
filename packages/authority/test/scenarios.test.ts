/**
 * Every production scenario through the M2 runner, in both modes, against
 * the expected coverage of vtt-75c.13. M5 updates this table when it adds
 * `invoke` steps and `action` expectations.
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
const partial = (run: number, total: number, skipped: Record<string, number> = {}): Expected => ({
  complete: false,
  stepsRun: run,
  stepsTotal: total,
  skipped,
});

const EXPECTED: Record<string, Expected> = {
  "hit-points.json": complete(5),
  "difficult-terrain.json": complete(4),
  "re-hiding-room.json": complete(6),
  "goblin-hit.json": partial(4, 6),
  "attack-card.json": partial(2, 7, { action: 6 }),
  "fireball.json": partial(2, 12, { action: 2 }),
  "die-with-modifier.json": partial(1, 7),
  "dice-tray.json": partial(0, 10),
  "drawing-a-card.json": partial(0, 4, { action: 1 }),
  "shuffling.json": partial(0, 2, { action: 1 }),
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
