/**
 * The production scenarios of @vtt/fixtures, found through the package (its
 * entry resolves to src/index.ts, so the scenarios are at ../scenarios).
 * Restated from packages/formula/test/support/scenarios.ts, which authority
 * tests cannot import (vtt-qf5.2).
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "@vtt/fixtures";

/** The scenarios directory of @vtt/fixtures. */
export const SCENARIOS_DIR = fileURLToPath(
  new URL("../scenarios/", import.meta.resolve("@vtt/fixtures")),
);

/** The `*.json` scenario file names, sorted. */
export async function scenarioFiles(): Promise<string[]> {
  return (await readdir(SCENARIOS_DIR)).filter((f) => f.endsWith(".json")).sort();
}

/** Load and validate one scenario file by name. */
export function loadScenarioFile(file: string): Promise<Scenario> {
  return loadScenario(`${SCENARIOS_DIR}${file}`);
}
