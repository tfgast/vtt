/**
 * The `pnpm start <file>` launcher (DESIGN.md §7 Platform; PROTOCOL.md §2;
 * M6-D5, M6-D23): build the UI only when its build is missing or stale, then
 * run `vtt-serve <file> … --open` (`--open` left off given `--no-open`) and
 * wait for it. `bin/start.ts` wires this to real processes; everything here
 * takes its paths from a `repoRoot` argument and its processes as functions,
 * so it is testable on a temp tree.
 *
 * Build freshness: `packages/ui/dist/.inputs.json` records the sha256 of every
 * build input, taken before the build started, and every file the build wrote.
 * The build is stale when the manifest is missing or unreadable, when the
 * inputs now hash differently (an edit, an added or a deleted file), or when
 * `dist/index.html` or any recorded output is missing.
 */
/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Directories whose every file (recursively) is a build input, repo-relative. */
export const UI_BUILD_INPUT_DIRS: readonly string[] = [
  "packages/ui/src",
  "packages/schema/src",
  "packages/formula/src",
  "packages/protocol/src",
];

/** Single files that are build inputs, repo-relative. */
export const UI_BUILD_INPUT_FILES: readonly string[] = [
  "packages/ui/index.html",
  "packages/ui/vite.config.ts",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "package.json",
  "packages/ui/package.json",
  "packages/schema/package.json",
  "packages/formula/package.json",
  "packages/protocol/package.json",
];

/** The UI build directory, repo-relative. */
export const UI_DIST_DIR = "packages/ui/dist";

/** The manifest's name inside the build directory. */
export const UI_BUILD_MANIFEST = ".inputs.json";

/** The content of `packages/ui/dist/.inputs.json`. */
export interface UiBuildManifest {
  /** Repo-relative POSIX path → hex sha256 of the file's bytes, before the build. */
  inputs: Record<string, string>;
  /** Every file under `dist` after the build (dist-relative POSIX paths), the manifest excluded. */
  outputs: string[];
}

const toPosix = (path: string): string => (sep === "/" ? path : path.split(sep).join("/"));

const isMissing = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Every regular file under `dir` (recursive), as paths relative to `dir`; none when it is missing. */
async function filesUnder(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** The current build inputs under `repoRoot` (a missing input is simply absent). */
export async function buildInputs(repoRoot: string): Promise<Record<string, string>> {
  const paths: string[] = [];
  for (const dir of UI_BUILD_INPUT_DIRS) {
    for (const rel of await filesUnder(join(repoRoot, dir))) paths.push(`${dir}/${toPosix(rel)}`);
  }
  paths.push(...UI_BUILD_INPUT_FILES);
  const inputs: Record<string, string> = {};
  for (const rel of [...new Set(paths)].sort()) {
    try {
      inputs[rel] = await sha256(join(repoRoot, rel));
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return inputs;
}

/**
 * Writes the manifest after a successful build: `inputs` (computed before the
 * build started) and every file now under `dist`.
 */
export async function writeBuildManifest(
  repoRoot: string,
  inputs: Record<string, string>,
): Promise<void> {
  const dist = join(repoRoot, UI_DIST_DIR);
  const outputs = (await filesUnder(dist)).map(toPosix).filter((p) => p !== UI_BUILD_MANIFEST);
  const manifest: UiBuildManifest = { inputs, outputs };
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, UI_BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readManifest(repoRoot: string): Promise<UiBuildManifest | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(repoRoot, UI_DIST_DIR, UI_BUILD_MANIFEST), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { inputs, outputs } = parsed as Partial<UiBuildManifest>;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return null;
  if (!Object.values(inputs).every((v) => typeof v === "string")) return null;
  if (!Array.isArray(outputs) || !outputs.every((o) => typeof o === "string")) return null;
  return { inputs, outputs };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** Whether `pnpm start` must build the UI before serving it. */
export async function uiBuildIsStale(repoRoot: string): Promise<boolean> {
  const manifest = await readManifest(repoRoot);
  if (manifest === null) return true;
  const dist = join(repoRoot, UI_DIST_DIR);
  for (const out of new Set(["index.html", ...manifest.outputs])) {
    if (!(await isFile(join(dist, ...out.split("/"))))) return true;
  }
  return !sameRecord(manifest.inputs, await buildInputs(repoRoot));
}

// --------------------------------------------------------------- arguments

export const START_USAGE = "usage: pnpm start <file> [--no-build] [--no-open] [vtt-serve flags…]";

export class StartUsageError extends Error {
  constructor(message = START_USAGE) {
    super(message);
    this.name = "StartUsageError";
  }
}

export interface StartArgs {
  /** The table file as given (relative to the working directory); it need not exist. */
  file: string;
  /** The flags forwarded to `vtt-serve`. */
  forward: string[];
  /** False with `--no-build` or a forwarded `--ui-dir` (a custom UI is served as given). */
  build: boolean;
  /** False with `--no-open`: vtt-serve runs without `--open`, so no browser tab opens (M6-D23). */
  open: boolean;
}

/** Parses `pnpm start`'s arguments; throws `StartUsageError` with `START_USAGE`. */
export function parseStartArgs(argv: readonly string[]): StartArgs {
  const noBuild = argv.includes("--no-build");
  const noOpen = argv.includes("--no-open");
  const rest = argv.filter((a) => a !== "--no-build" && a !== "--no-open");
  const [file, ...forward] = rest;
  if (file === undefined || file.startsWith("-")) throw new StartUsageError();
  const customUi = forward.some((a) => a === "--ui-dir" || a.startsWith("--ui-dir="));
  return { file, forward, build: !noBuild && !customUi, open: !noOpen };
}

// ------------------------------------------------------------------ runStart

/** A running `vtt-serve` child as the launcher sees it. */
export interface StartChild {
  /** Resolves with the child's exit code once it has exited. */
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

/** Where the launcher's own signals come from (default: `process`). */
export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface RunStartOptions {
  argv: readonly string[];
  repoRoot: string;
  /** The working directory the table file is resolved against (vtt-serve's). */
  cwd: string;
  /** Runs the UI build; resolves with its exit code. */
  build: () => Promise<number>;
  /** Starts `vtt-serve` with these arguments. */
  serve: (args: string[]) => StartChild;
  log: (message: string) => void;
  signals?: SignalSource;
}

/**
 * `pnpm start`: parse, `mkdir -p` the table file's parent, build the UI when
 * stale (unless skipped), then run `vtt-serve <file> … --open` (`--open`
 * left off with `--no-open`) and resolve
 * with its exit code. While the child runs the launcher ignores SIGINT (the
 * terminal sends Ctrl+C to the child too) and forwards SIGTERM to it; it
 * never resolves before the child has exited.
 */
export async function runStart(options: RunStartOptions): Promise<number> {
  const { log } = options;
  let args: StartArgs;
  try {
    args = parseStartArgs(options.argv);
  } catch (err) {
    if (!(err instanceof StartUsageError)) throw err;
    log(err.message);
    return 1;
  }

  await mkdir(dirname(resolve(options.cwd, args.file)), { recursive: true });

  if (args.build && (await uiBuildIsStale(options.repoRoot))) {
    const inputs = await buildInputs(options.repoRoot);
    log("building the UI (its build is missing or older than its sources)");
    const code = await options.build();
    if (code !== 0) {
      log(`UI build failed (exit code ${code})`);
      return 1;
    }
    await writeBuildManifest(options.repoRoot, inputs);
  }

  const signals = options.signals ?? process;
  const child = options.serve([args.file, ...args.forward, ...(args.open ? ["--open"] : [])]);
  const onInt = (): void => undefined;
  const onTerm = (): void => child.kill("SIGTERM");
  signals.on("SIGINT", onInt);
  signals.on("SIGTERM", onTerm);
  try {
    return await child.exited;
  } finally {
    signals.off("SIGINT", onInt);
    signals.off("SIGTERM", onTerm);
  }
}
