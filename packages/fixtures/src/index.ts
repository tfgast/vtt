import { readFile } from "node:fs/promises";
import { ScenarioSchema } from "./schema";
import type { Scenario } from "./types";

export { NON_CELL_STRUCTURAL, RESERVED_NAMES } from "./check";
export * from "./example-assets";
export * from "./schema";
export type * from "./types";

/** The §10 fixture headings of docs/FORMULAS.md, in document order. */
export const FORMULAS_FIXTURES = [
  "Hit points",
  "A die with a modifier",
  "A goblin that shows HIT when a die on it beats its AC",
  "A dice tray that totals itself",
  "Difficult terrain",
  "An Attack card",
  "A Fireball card with a circle zone",
  "Drawing a card",
  "Shuffling",
  "Re-hiding a room when the party leaves (phase 1 vision, optional)",
] as const;

/** Validate parsed JSON as a scenario. Throws a readable error listing every issue. */
export function parseScenario(data: unknown, label = "scenario"): Scenario {
  const result = ScenarioSchema.safeParse(data);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`${label} is not a valid scenario:\n${lines.join("\n")}`);
}

/** Read a scenario JSON file and validate it. The package's only I/O. */
export async function loadScenario(path: string): Promise<Scenario> {
  const text = await readFile(path, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${(error as Error).message}`);
  }
  return parseScenario(data, path);
}
