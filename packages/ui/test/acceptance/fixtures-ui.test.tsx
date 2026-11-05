/**
 * M5 epic acceptance (vtt-1xv.24): every FORMULAS.md §10 fixture end to end
 * in the UI, as M5 plan decision Q16 reads the epic's Done-when (FIXTURES.md
 * §1–§9; review r1 finding 13, r2 finding 12, r3 finding 4). Each of the ten
 * scenarios runs through the real `<App>` in jsdom against an in-process
 * authority over its setup with its scripted dice (`ui-fixture-driver.ts`),
 * every step by the path of the bead's fixed matrix below, which the driver
 * never chooses: it records the path it took, and the test asserts the
 * record equals the matrix, every expectation held, the run is complete and
 * no scripted dice are left.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@vtt/fixtures";
import { describe, expect, test } from "vitest";
import { type MatrixRow, runScenarioInUi, type UiPath } from "./ui-fixture-driver";

const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios/", import.meta.resolve("@vtt/fixtures")));

/** One line of the bead's matrix: scenario, steps, actor ("—" for bind), path, board ("—": protocol). */
type Line = [scenario: string, steps: number[], actor: string, path: UiPath, board: string];

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The fixed matrix of vtt-1xv.24, line for line. */
const MATRIX: Line[] = [
  ["attack-card", [0], "aldric", "protocol", "—"],
  ["attack-card", [1], "aldric", "protocol", "—"],
  ["attack-card", [2], "aldric", "click", "table"],
  ["attack-card", [3], "aldric", "click", "table"],
  ["attack-card", [4], "aldric", "click", "table"],
  ["attack-card", [5], "aldric", "suppressed", "table"],
  ["attack-card", [6], "gm", "log", "table"],
  ["dice-tray", [0, 1, 2], "gm", "click", "table"],
  ["dice-tray", [3, 4, 5], "gm", "drag", "table"],
  ["dice-tray", [6, 7], "gm", "protocol", "—"],
  ["dice-tray", [8], "gm", "drag", "table"],
  ["dice-tray", [9], "gm", "drag", "table"],
  ["die-with-modifier", [0, 2, 5], "gm", "protocol", "—"],
  ["die-with-modifier", [1, 6], "gm", "click", "table"],
  ["die-with-modifier", [3], "aldric", "click", "table"],
  ["die-with-modifier", [4], "gm", "edit", "table"],
  ["difficult-terrain", range(0, 3), "gm", "drag", "table"],
  ["drawing-a-card", [0, 1], "aldric", "click", "table"],
  ["drawing-a-card", [2], "aldric", "suppressed", "table"],
  ["drawing-a-card", [3], "aldric", "protocol", "—"],
  ["fireball", [0], "aldric", "protocol", "—"],
  ["fireball", [1], "aldric", "protocol", "—"],
  ["fireball", [2], "aldric", "click", "shelf"],
  ["fireball", [3, 4], "—", "protocol", "—"],
  ["fireball", [5], "gm", "drag", "map"],
  ["fireball", [6], "aldric", "click", "shelf"],
  ["fireball", [7], "goblin1", "click", "shelf"],
  ["fireball", [8], "gm", "click", "shelf"],
  ["fireball", [9], "aldric", "click", "shelf"],
  ["fireball", [10], "gm", "edit", "map"],
  ["fireball", [11], "aldric", "click", "shelf"],
  ["goblin-hit", [0], "gm", "drag", "table"],
  ["goblin-hit", [1, 3], "gm", "edit", "table"],
  ["goblin-hit", [2, 5], "gm", "drag", "table"],
  ["goblin-hit", [4], "aldric", "click", "table"],
  ["hit-points", [0, 2], "gm", "edit", "table"],
  ["hit-points", [1], "gm", "edit", "table"],
  ["hit-points", [3], "gm", "edit (formula bar Clear)", "table"],
  ["hit-points", [4], "gm", "log", "table"],
  ["re-hiding-room", [0, 1, 2, 4], "gm", "drag", "table"],
  ["re-hiding-room", [3], "gm", "edit", "table"],
  ["re-hiding-room", [5], "gm", "edit (formula bar Clear)", "table"],
  ["shuffling", [0], "gm", "click", "table"],
  ["shuffling", [1], "gm", "log", "table"],
];

/** The matrix rows of `scenario`, in step order. */
function rowsOf(scenario: string): MatrixRow[] {
  return MATRIX.filter(([name]) => name === scenario)
    .flatMap(([, steps, actor, path, board]) =>
      steps.map((step) => ({
        step,
        actor: actor === "—" ? null : actor,
        path,
        board: board === "—" ? null : board,
      })),
    )
    .sort((a, b) => a.step - b.step);
}

const SCENARIOS = [...new Set(MATRIX.map(([name]) => name))];

test("the matrix names every scenario file, and only those", async () => {
  const files = (await readdir(SCENARIOS_DIR)).filter((f) => f.endsWith(".json")).sort();
  expect(SCENARIOS.map((s) => `${s}.json`).sort()).toEqual(files);
  expect(SCENARIOS).toHaveLength(10);
});

describe("every §10 fixture end to end in the UI", () => {
  for (const name of SCENARIOS) {
    test(name, async () => {
      const scenario = await loadScenario(`${SCENARIOS_DIR}${name}.json`);
      const matrix = rowsOf(name);
      expect(matrix.map((r) => r.step)).toEqual(scenario.steps.map((_, i) => i));
      const report = await runScenarioInUi(scenario, matrix);
      expect(report.complete).toBe(true);
      expect(report.stepsRun).toBe(scenario.steps.length);
      expect(report.leftoverDice).toBe(0);
      expect(report.expectationsChecked).toBe(
        (scenario.expect ?? []).length +
          scenario.steps.reduce((n, s) => n + (s.expect ?? []).length, 0),
      );
      expect(report.paths).toEqual(matrix);
    }, 60_000);
  }
});
