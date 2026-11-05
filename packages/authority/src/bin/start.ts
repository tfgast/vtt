#!/usr/bin/env -S node --import tsx
/**
 * `pnpm start <file> [--no-build] [vtt-serve flags…]` (DESIGN.md §7
 * Platform; PROTOCOL.md §2; M6-D5): builds the UI when its build is missing
 * or older than its sources (`pnpm --filter @vtt/ui build`; `--no-build` or a
 * forwarded `--ui-dir` skips that), then runs `vtt-serve <file> … --open`
 * with inherited stdio and exits with its exit code. The table file is
 * resolved against the working directory (the repo root under `pnpm start`)
 * and its parent directory is created; a missing file is created by
 * vtt-serve. Ctrl+C reaches vtt-serve through the terminal's process group;
 * a SIGTERM to the launcher is forwarded. The logic is `runStart` in
 * `server/launcher.ts`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runStart, type StartChild } from "../index";

/** The repository root, from this module's location. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SERVE_BIN = fileURLToPath(new URL("./serve.ts", import.meta.url));
/**
 * tsx's loader, resolved from this package: Node resolves a bare `--import`
 * specifier against the child's working directory, which need not hold
 * `node_modules`.
 */
const TSX = import.meta.resolve("tsx");

const log = (message: string): void => {
  process.stderr.write(`pnpm start: ${message}\n`);
};

function build(): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn("pnpm", ["--filter", "@vtt/ui", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      log(`could not run pnpm: ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function serve(args: string[]): StartChild {
  const child = spawn(process.execPath, ["--import", TSX, SERVE_BIN, ...args], {
    stdio: "inherit",
  });
  const exited = new Promise<number>((resolve) => {
    child.on("error", (err) => {
      log(`could not run vtt-serve: ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
  return {
    exited,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

runStart({
  argv: process.argv.slice(2),
  repoRoot: REPO_ROOT,
  cwd: process.cwd(),
  build,
  serve,
  log,
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(`unexpected failure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
