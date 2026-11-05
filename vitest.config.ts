import { defineConfig } from "vitest/config";
import type { Reporter, Vitest } from "vitest/node";

// Vitest only fails on "no test files" when the whole run is empty, and
// passWithNoTests has no per-project form. This reporter fails the run when any
// project has zero test files on disk, independent of CLI filters.
function requireTestsInEveryProject(): Reporter {
  let vitest: Vitest;
  return {
    onInit(ctx) {
      vitest = ctx;
    },
    async onTestRunEnd() {
      for (const project of vitest.projects) {
        const { testFiles } = await project.globTestFiles();
        if (testFiles.length === 0) {
          vitest.logger.error(`Project ${project.name} has no test files.`);
          process.exitCode = 1;
        }
      }
    },
  };
}

export default defineConfig({
  test: {
    projects: ["packages/*"],
    reporters: ["default", requireTestsInEveryProject()],
  },
});
