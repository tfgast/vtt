import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadScenario } from "@vtt/fixtures";
import { expect, test } from "vitest";

// Discovers every production scenario under packages/fixtures/scenarios and
// validates it. Transcription beads assert their own titles in their own test
// files; this file only validates, so concurrent beads never edit it.

const root = join(import.meta.dirname, "..", "scenarios");

test("the scenarios directory exists", async () => {
  expect((await stat(root)).isDirectory()).toBe(true);
});

const files = (await readdir(root, { recursive: true }))
  .filter((f) => !f.endsWith(".gitkeep"))
  .map((f) => join(root, f));

const entries = await Promise.all(
  files.map(async (f) => ({ f, dir: (await stat(f)).isDirectory() })),
);
const scenarioFiles = entries.filter((e) => !e.dir).map((e) => e.f);

test.each(scenarioFiles.map((f) => [relative(root, f), f]))(
  "%s is a valid scenario",
  async (_, f) => {
    expect(f.endsWith(".json"), "scenario files are .json").toBe(true);
    await loadScenario(f);
  },
);
