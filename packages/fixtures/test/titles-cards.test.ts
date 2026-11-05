import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMULAS_FIXTURES, loadScenario } from "@vtt/fixtures";
import { expect, test } from "vitest";

// vtt-1me.10 owns the card fixtures: An Attack card, Drawing a card, Shuffling.
// Loads every scenario the way the discovery test does and checks that each
// of these sources has its scenario file, under its expected title.

const root = join(import.meta.dirname, "..", "scenarios");

const owned = [
  {
    file: "attack-card.json",
    source: "An Attack card",
    title: "An Attack card rolls, rolls damage, and applies once",
  },
  {
    file: "drawing-a-card.json",
    source: "Drawing a card",
    title: "Drawing two cards from a deck into a hand",
  },
  {
    file: "shuffling.json",
    source: "Shuffling",
    title: "Shuffling a stack with a scripted permutation",
  },
] as const;

const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".json"));
const scenarios = await Promise.all(
  files.map(async (f) => ({ file: f, scenario: await loadScenario(join(root, f)) })),
);

test.each(owned)("$source has its scenario", ({ file, source, title }) => {
  expect(FORMULAS_FIXTURES).toContain(source);
  const found = scenarios.find((s) => s.file === file);
  expect(found, `${file} exists`).toBeDefined();
  expect(found?.scenario.source).toBe(source);
  expect(found?.scenario.title).toBe(title);
  const sources = scenarios.map((s) => s.scenario.source);
  expect(sources).toContain(source);
});
