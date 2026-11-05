import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMULAS_FIXTURES, loadScenario } from "@vtt/fixtures";
import { expect, test } from "vitest";

// Owned by vtt-1me.11: asserts the Fireball scenario's title. Scenarios are
// loaded the way the discovery test finds them, so a renamed or moved file
// still counts as long as it lives under scenarios/.

const root = join(import.meta.dirname, "..", "scenarios");
const files = (await readdir(root, { recursive: true }))
  .filter((f) => f.endsWith(".json"))
  .map((f) => join(root, f));
const scenarios = await Promise.all(files.map((f) => loadScenario(f)));

const FIREBALL = "A Fireball card with a circle zone";

test("the Fireball source is a §10 fixture heading", () => {
  expect(FORMULAS_FIXTURES).toContain(FIREBALL);
});

test("the Fireball fixture has its scenario", () => {
  const titles = scenarios.filter((s) => s.source === FIREBALL).map((s) => s.title);
  expect(titles).toEqual([
    "Fireball spawns its zone, locks the creatures inside, applies saves, and discards everything",
  ]);
});
