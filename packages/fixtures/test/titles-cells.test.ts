import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMULAS_FIXTURES, loadScenario } from "@vtt/fixtures";
import { expect, test } from "vitest";

// The six §10 fixtures transcribed by vtt-1me.9 (cells, dice, spatial), each
// in its own file. scenarios.test.ts validates every file; this one checks
// that ours are present and carry the right `source`.

const root = join(import.meta.dirname, "..", "scenarios");

const OWNED: Record<string, (typeof FORMULAS_FIXTURES)[number]> = {
  "hit-points.json": "Hit points",
  "die-with-modifier.json": "A die with a modifier",
  "goblin-hit.json": "A goblin that shows HIT when a die on it beats its AC",
  "dice-tray.json": "A dice tray that totals itself",
  "difficult-terrain.json": "Difficult terrain",
  "re-hiding-room.json": "Re-hiding a room when the party leaves (phase 1 vision, optional)",
};

test.each(Object.entries(OWNED))("%s transcribes %s", async (file, source) => {
  const scenario = await loadScenario(join(root, file));
  expect(scenario.source).toBe(source);
  expect(scenario.steps.length).toBeGreaterThan(0);
});

test("all six sources are among the loaded scenarios", async () => {
  const files = (await readdir(root)).filter((f) => f.endsWith(".json"));
  const scenarios = await Promise.all(files.map((f) => loadScenario(join(root, f))));
  const sources = new Set(scenarios.map((s) => s.source));
  for (const source of Object.values(OWNED)) {
    expect(FORMULAS_FIXTURES).toContain(source);
    expect(sources).toContain(source);
  }
});
