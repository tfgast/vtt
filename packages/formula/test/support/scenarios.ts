/// <reference types="node" />
/**
 * Every production scenario in packages/fixtures/scenarios, found through the
 * @vtt/fixtures package (its entry resolves to src/index.ts, so the scenarios
 * are at ../scenarios) and validated with the fixtures loader.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "@vtt/fixtures";

/** The scenarios directory of @vtt/fixtures. */
export const SCENARIOS_DIR = fileURLToPath(
  new URL("../scenarios/", import.meta.resolve("@vtt/fixtures")),
);

/** Load and validate every `*.json` scenario, in file name order. */
export async function loadScenarios(): Promise<Scenario[]> {
  const files = (await readdir(SCENARIOS_DIR)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map((f) => loadScenario(`${SCENARIOS_DIR}${f}`)));
}
