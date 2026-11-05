import { describe, expect, test } from "vitest";
import { SCENARIO_COVERAGE } from "./scenario-coverage";
import { runFormulaScenario } from "./support/runner";
import { loadScenarios } from "./support/scenarios";

const scenarios = await loadScenarios();
const reports = scenarios.map(runFormulaScenario);

describe.each(reports.map((r) => [r.title, r] as const))("%s", (_, report) => {
  test("no failures", () => {
    expect(report.failures).toEqual([]);
  });
});

test("coverage matches the committed table", () => {
  const coverage = Object.fromEntries(reports.map((r) => [r.title, r.checked]));
  expect(coverage).toEqual(SCENARIO_COVERAGE);
});
