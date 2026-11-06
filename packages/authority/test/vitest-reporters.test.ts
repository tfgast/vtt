import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Vitest } from "vitest/node";
// The root config's reporter lives outside every package; authority hosts
// root tooling tests (root-scripts.test.ts covers the root package.json).
import { requireTestsInEveryProject } from "../../../vitest.reporters";

type FakeProject = { name: string; files: string[] };

/** Drives the reporter through one run end against fake projects. */
async function runEnd(watch: boolean, projects: FakeProject[]): Promise<string[]> {
  const errors: string[] = [];
  const fake = {
    config: { watch },
    logger: { error: (message: string) => errors.push(message) },
    projects: projects.map((p) => ({
      name: p.name,
      globTestFiles: async () => ({ testFiles: p.files }),
    })),
  };
  const reporter = requireTestsInEveryProject();
  reporter.onInit?.(fake as unknown as Vitest);
  await reporter.onTestRunEnd?.([], [], "passed");
  return errors;
}

describe("requireTestsInEveryProject", () => {
  let saved: typeof process.exitCode;
  beforeEach(() => {
    saved = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = saved;
  });

  test("a one-shot run with an empty project logs it and fails", async () => {
    const errors = await runEnd(false, [
      { name: "@vtt/a", files: ["a.test.ts"] },
      { name: "@vtt/b", files: [] },
    ]);
    expect(errors).toEqual(["Project @vtt/b has no test files."]);
    expect(process.exitCode).toBe(1);
  });

  test("a one-shot run where every project has tests passes silently", async () => {
    const errors = await runEnd(false, [{ name: "@vtt/a", files: ["a.test.ts"] }]);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("watch mode logs an empty project but leaves the exit code alone", async () => {
    const errors = await runEnd(true, [{ name: "@vtt/b", files: [] }]);
    expect(errors).toEqual(["Project @vtt/b has no test files."]);
    expect(process.exitCode).toBeUndefined();
  });
});
