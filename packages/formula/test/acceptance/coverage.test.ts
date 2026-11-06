/// <reference types="node" />
/**
 * The meta-test of the §10 acceptance suite. Every scenario has its own
 * acceptance file (one per fixture), and every formula and `when` source of
 * every scenario must be evaluated by a test in it.
 *
 * Vitest isolates test files, so evaluation is tracked per file: each
 * acceptance file ends with `acc.coverageTest()`, a test that fails listing
 * every source of its scenario the file never evaluated. This file collects
 * the sources from the scenario files and checks that the per-file gate is in
 * place wherever a scenario has sources.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scenarioSources } from "../support/acceptance";
import { loadScenarios, SCENARIOS_DIR } from "../support/scenarios";

const scenarioFiles = (await readdir(SCENARIOS_DIR))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .sort();
const testFiles = (await readdir(import.meta.dirname))
  .filter((f) => f.endsWith(".test.ts") && f !== "coverage.test.ts")
  .map((f) => f.slice(0, -".test.ts".length))
  .sort();
const scenarios = await loadScenarios();

describe("§10 acceptance coverage", () => {
  it("has exactly one acceptance file per scenario file", () => {
    expect(testFiles).toEqual(scenarioFiles);
  });

  it("collects formula and when sources from the scenario files", () => {
    const total = scenarios.reduce((n, s) => n + scenarioSources(s).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it.each(scenarioFiles)(
    "%s: the acceptance file gates on every source being evaluated",
    async (name) => {
      const scenario = scenarios[scenarioFiles.indexOf(name)];
      if (scenario === undefined) throw new Error(`no scenario ${name}`);
      const text = await readFile(join(import.meta.dirname, `${name}.test.ts`), "utf8");
      expect(text).toContain(`acceptance("${name}")`);
      if (scenarioSources(scenario).length > 0) expect(text).toContain("acc.coverageTest();");
    },
  );
});
