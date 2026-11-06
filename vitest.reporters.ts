import type { Reporter, Vitest } from "vitest/node";

// Vitest only fails on "no test files" when the whole run is empty, and
// passWithNoTests has no per-project form. This reporter fails a one-shot run
// when any selected project has zero test files on disk, independent of path
// filters (`--project` narrows the selected set).
//
// In watch mode it only logs: Vitest does not end a run when a package's last
// test file is deleted, and a sticky process.exitCode would outlive the test's
// restoration, so the exit code is meaningless there. A one-shot run ends once,
// so it never needs to clear exitCode on recovery.
export function requireTestsInEveryProject(): Reporter {
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
          if (!vitest.config.watch) process.exitCode = 1;
        }
      }
    },
  };
}
