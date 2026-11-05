import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMULAS_FIXTURES, loadScenario } from "@vtt/fixtures";
import { expect, test } from "vitest";

// The six §10 fixtures transcribed by vtt-1me.9 (cells, dice, spatial), each
// in its own file. scenarios.test.ts validates every file; this one checks
// that ours are present with the expected title and `source`.

const root = join(import.meta.dirname, "..", "scenarios");

const OWNED: { file: string; title: string; source: (typeof FORMULAS_FIXTURES)[number] }[] = [
  {
    file: "hit-points.json",
    title: "Hit points follow damage until overridden",
    source: "Hit points",
  },
  {
    file: "die-with-modifier.json",
    title: "A d20 template rolled loose, as a character's attack die, and as a goblin's die",
    source: "A die with a modifier",
  },
  {
    file: "goblin-hit.json",
    title: "A goblin shows HIT to the player when a die on it beats its hidden AC",
    source: "A goblin that shows HIT when a die on it beats its AC",
  },
  {
    file: "dice-tray.json",
    title: "Dice trays total themselves, as a zone and as a cup",
    source: "A dice tray that totals itself",
  },
  {
    file: "difficult-terrain.json",
    title: "A token's speed halves inside difficult terrain",
    source: "Difficult terrain",
  },
  {
    file: "re-hiding-room.json",
    title: "An opaque room reveals itself while a PC is inside and re-hides when he leaves",
    source: "Re-hiding a room when the party leaves (phase 1 vision, optional)",
  },
];

test.each(OWNED)("$file is titled $title", async ({ file, title, source }) => {
  const scenario = await loadScenario(join(root, file));
  expect(scenario.title).toBe(title);
  expect(scenario.source).toBe(source);
  expect(scenario.steps.length).toBeGreaterThan(0);
});

test("all six titles and sources are among the loaded scenarios", async () => {
  const files = (await readdir(root)).filter((f) => f.endsWith(".json"));
  const scenarios = await Promise.all(files.map((f) => loadScenario(join(root, f))));
  const titles = new Set(scenarios.map((s) => s.title));
  const sources = new Set(scenarios.map((s) => s.source));
  for (const { title, source } of OWNED) {
    expect(titles).toContain(title);
    expect(FORMULAS_FIXTURES).toContain(source);
    expect(sources).toContain(source);
  }
});
