// @vitest-environment node
/**
 * The `pnpm start` launcher (vtt-nb8.4; DESIGN.md §7 Platform; M6-D5; M6
 * plan Q9, review r1 findings 1 and 4, review r2 finding 6): the build-input
 * manifest and its freshness check on a temp tree with the repo's
 * `packages/*` layout, argument parsing, and `runStart` with a fake build, a
 * fake vtt-serve child and a fake signal source.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildInputs,
  parseStartArgs,
  runStart,
  START_USAGE,
  type StartChild,
  StartUsageError,
  uiBuildIsStale,
  writeBuildManifest,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let root: string;
let cwd: string;

/** The tree's files: every build input and an unrelated authority source. */
const TREE: Record<string, string> = {
  "package.json": '{"name":"root"}\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "tsconfig.base.json": "{}\n",
  "packages/ui/package.json": '{"name":"@vtt/ui"}\n',
  "packages/ui/index.html": "<!doctype html>\n",
  "packages/ui/vite.config.ts": "export default {};\n",
  "packages/ui/src/index.ts": "export const ui = 1;\n",
  "packages/ui/src/app/App.tsx": "export const App = () => null;\n",
  "packages/schema/package.json": '{"name":"@vtt/schema"}\n',
  "packages/schema/src/index.ts": "export const schema = 1;\n",
  "packages/formula/package.json": '{"name":"@vtt/formula"}\n',
  "packages/formula/src/index.ts": "export const formula = 1;\n",
  "packages/formula/src/dice/roll.ts": "export const roll = 1;\n",
  "packages/protocol/package.json": '{"name":"@vtt/protocol"}\n',
  "packages/protocol/src/index.ts": "export const protocol = 1;\n",
  "packages/authority/src/index.ts": "export const authority = 1;\n",
};

/** A fake `vite build` output. */
const DIST: Record<string, string> = {
  "index.html": "<!doctype html><title>built</title>\n",
  "ui-assets/index-abc123.js": "console.log(1);\n",
  "ui-assets/index-abc123.css": "body{}\n",
};

const at = (rel: string) => join(root, ...rel.split("/"));

async function put(rel: string, content: string): Promise<void> {
  await mkdir(dirname(at(rel)), { recursive: true });
  await writeFile(at(rel), content);
}

/** Writes the fake build output into `packages/ui/dist`. */
async function fakeViteBuild(): Promise<void> {
  await rm(at("packages/ui/dist"), { recursive: true, force: true });
  for (const [rel, content] of Object.entries(DIST)) await put(`packages/ui/dist/${rel}`, content);
}

/** Builds and records the manifest, as a successful `pnpm start` build step does. */
async function buildFresh(): Promise<void> {
  const inputs = await buildInputs(root);
  await fakeViteBuild();
  await writeBuildManifest(root, inputs);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "vtt-launcher-")));
  cwd = join(root, "cwd");
  await mkdir(cwd);
  for (const [rel, content] of Object.entries(TREE)) await put(rel, content);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildInputs", () => {
  test("hashes exactly the inputs, keyed by repo-relative POSIX path", async () => {
    const inputs = await buildInputs(root);
    const expected = Object.keys(TREE)
      .filter((k) => !k.startsWith("packages/authority/"))
      .sort();
    expect(Object.keys(inputs).sort()).toEqual(expected);
    for (const value of Object.values(inputs)) expect(value).toMatch(/^[0-9a-f]{64}$/);
    // sha256("export const schema = 1;\n")
    const { createHash } = await import("node:crypto");
    expect(inputs["packages/schema/src/index.ts"]).toBe(
      createHash("sha256")
        .update(TREE["packages/schema/src/index.ts"] as string)
        .digest("hex"),
    );
  });

  test("a missing single input is simply absent", async () => {
    await unlink(at("tsconfig.base.json"));
    expect(await buildInputs(root)).not.toHaveProperty("tsconfig.base.json");
  });
});

describe("the build manifest", () => {
  test("records the inputs and every dist file but itself", async () => {
    await buildFresh();
    const manifest = JSON.parse(await readFile(at("packages/ui/dist/.inputs.json"), "utf8"));
    expect(manifest.inputs).toEqual(await buildInputs(root));
    expect([...manifest.outputs].sort()).toEqual(Object.keys(DIST).sort());
  });
});

describe("uiBuildIsStale", () => {
  test("stale when .inputs.json is missing", async () => {
    await fakeViteBuild();
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("stale when there is no dist at all", async () => {
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("stale when .inputs.json is unreadable", async () => {
    await buildFresh();
    await writeFile(at("packages/ui/dist/.inputs.json"), "{not json");
    expect(await uiBuildIsStale(root)).toBe(true);
    await writeFile(at("packages/ui/dist/.inputs.json"), '{"inputs": 3}');
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("fresh right after writeBuildManifest", async () => {
    await buildFresh();
    expect(await uiBuildIsStale(root)).toBe(false);
  });

  test("an unrelated package's source does not make it stale", async () => {
    await buildFresh();
    await put("packages/authority/src/index.ts", "export const authority = 2;\n");
    await put("packages/authority/src/extra.ts", "export {};\n");
    expect(await uiBuildIsStale(root)).toBe(false);
  });

  test("stale after editing a file under packages/schema/src (a dependency package)", async () => {
    await buildFresh();
    await put("packages/schema/src/index.ts", "export const schema = 2;\n");
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("stale after adding a file under packages/ui/src", async () => {
    await buildFresh();
    await put("packages/ui/src/app/New.tsx", "export {};\n");
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("stale after deleting a file under packages/formula/src", async () => {
    await buildFresh();
    await unlink(at("packages/formula/src/dice/roll.ts"));
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("stale after changing pnpm-lock.yaml", async () => {
    await buildFresh();
    await put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed\n");
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("stale after changing a package.json, tsconfig.base.json, index.html or vite.config.ts", async () => {
    for (const rel of [
      "package.json",
      "packages/protocol/package.json",
      "tsconfig.base.json",
      "packages/ui/index.html",
      "packages/ui/vite.config.ts",
    ]) {
      await buildFresh();
      expect(await uiBuildIsStale(root), rel).toBe(false);
      await put(rel, `${TREE[rel]}// changed\n`);
      expect(await uiBuildIsStale(root), rel).toBe(true);
    }
  });

  test("stale when a recorded bundle under dist/ is deleted with the manifest unchanged", async () => {
    await buildFresh();
    await unlink(at("packages/ui/dist/ui-assets/index-abc123.js"));
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("stale when dist/index.html is deleted", async () => {
    await buildFresh();
    await unlink(at("packages/ui/dist/index.html"));
    expect(await uiBuildIsStale(root)).toBe(true);
  });
});

describe("parseStartArgs", () => {
  test("rejects no arguments and a first argument starting with -", () => {
    for (const argv of [[], ["--no-build"], ["--port", "0"], ["-x", "t.json"]]) {
      expect(() => parseStartArgs(argv), argv.join(" ")).toThrow(StartUsageError);
      expect(() => parseStartArgs(argv), argv.join(" ")).toThrow(START_USAGE);
    }
    expect(START_USAGE).toBe(
      "usage: pnpm start <file> [--no-build] [--no-open] [vtt-serve flags…]",
    );
  });

  test("accepts a file that does not exist and forwards the rest", () => {
    expect(parseStartArgs(["tables/nope/crypt.table.json", "--port", "0"])).toEqual({
      file: "tables/nope/crypt.table.json",
      forward: ["--port", "0"],
      build: true,
      open: true,
    });
  });

  test("strips --no-build anywhere", () => {
    for (const argv of [
      ["--no-build", "t.json", "--port", "0"],
      ["t.json", "--no-build", "--port", "0"],
      ["t.json", "--port", "0", "--no-build"],
      ["--no-build", "t.json", "--no-build", "--port", "0", "--no-build"],
    ]) {
      expect(parseStartArgs(argv), argv.join(" ")).toEqual({
        file: "t.json",
        forward: ["--port", "0"],
        build: false,
        open: true,
      });
    }
  });

  test("--ui-dir (either form) skips the build", () => {
    expect(parseStartArgs(["t.json", "--ui-dir", "/x"])).toEqual({
      file: "t.json",
      forward: ["--ui-dir", "/x"],
      build: false,
      open: true,
    });
    expect(parseStartArgs(["t.json", "--ui-dir=/x"]).build).toBe(false);
  });

  test("strips --no-open anywhere and turns open off", () => {
    for (const argv of [
      ["--no-open", "t.json", "--port", "0"],
      ["t.json", "--no-open", "--port", "0"],
      ["t.json", "--port", "0", "--no-open"],
      ["--no-open", "--no-build", "t.json", "--port", "0", "--no-open"],
    ]) {
      expect(parseStartArgs(argv), argv.join(" ")).toEqual({
        file: "t.json",
        forward: ["--port", "0"],
        build: !argv.includes("--no-build"),
        open: false,
      });
    }
    expect(() => parseStartArgs(["--no-open"])).toThrow(START_USAGE);
  });
});

// ------------------------------------------------------------------ runStart

class FakeServe {
  calls: string[][] = [];
  kills: NodeJS.Signals[] = [];
  #finish: ((code: number) => void) | null = null;
  constructor(private readonly code: number | null = 0) {}
  /** The `serve` option: a child that exits at once with `code`, or on `finish` when null. */
  readonly serve = (args: string[]): StartChild => {
    this.calls.push(args);
    const exited = new Promise<number>((resolve) => {
      if (this.code !== null) resolve(this.code);
      else this.#finish = resolve;
    });
    return {
      exited,
      kill: (signal) => {
        this.kills.push(signal);
      },
    };
  };
  finish(code: number): void {
    this.#finish?.(code);
  }
}

class FakeBuild {
  runs = 0;
  constructor(
    private readonly code = 0,
    private readonly during: () => Promise<void> = async () => undefined,
  ) {}
  readonly build = async (): Promise<number> => {
    this.runs++;
    await this.during();
    if (this.code === 0) await fakeViteBuild();
    return this.code;
  };
}

function start(
  argv: string[],
  opts: { build?: FakeBuild; serve?: FakeServe; signals?: EventEmitter } = {},
) {
  const build = opts.build ?? new FakeBuild();
  const serve = opts.serve ?? new FakeServe();
  const logs: string[] = [];
  const run = runStart({
    argv,
    repoRoot: root,
    cwd,
    build: build.build,
    serve: serve.serve,
    log: (m) => logs.push(m),
    ...(opts.signals === undefined ? {} : { signals: opts.signals }),
  });
  return { run, build, serve, logs };
}

describe("runStart", () => {
  test("a usage error logs the usage and returns 1 without building or serving", async () => {
    const s = start(["--port", "0"]);
    expect(await s.run).toBe(1);
    expect(s.logs.join("\n")).toContain(START_USAGE);
    expect(s.build.runs).toBe(0);
    expect(s.serve.calls).toEqual([]);
  });

  test("builds when stale, writes the manifest, then serves with --open appended", async () => {
    const s = start(["tables/crypt.table.json", "--port", "0"]);
    expect(await s.run).toBe(0);
    expect(s.build.runs).toBe(1);
    expect(await uiBuildIsStale(root)).toBe(false);
    expect(s.serve.calls).toEqual([["tables/crypt.table.json", "--port", "0", "--open"]]);
  });

  test("does not build when fresh", async () => {
    await buildFresh();
    const s = start(["t.json"]);
    expect(await s.run).toBe(0);
    expect(s.build.runs).toBe(0);
    expect(s.serve.calls).toEqual([["t.json", "--open"]]);
  });

  test("--no-open serves without --open", async () => {
    await buildFresh();
    const s = start(["t.json", "--no-open", "--port", "0"]);
    expect(await s.run).toBe(0);
    expect(s.serve.calls).toEqual([["t.json", "--port", "0"]]);
  });

  test("never builds with --no-build or --ui-dir, even when stale", async () => {
    for (const argv of [
      ["t.json", "--no-build"],
      ["--no-build", "t.json"],
      ["t.json", "--ui-dir", "/somewhere"],
    ]) {
      const s = start(argv);
      expect(await s.run, argv.join(" ")).toBe(0);
      expect(s.build.runs, argv.join(" ")).toBe(0);
      expect(existsSync(at("packages/ui/dist/.inputs.json"))).toBe(false);
    }
  });

  test("a failed build logs, returns 1 without serving and writes no manifest", async () => {
    const s = start(["t.json"], { build: new FakeBuild(2) });
    expect(await s.run).toBe(1);
    expect(s.logs.join("\n")).toContain("UI build failed");
    expect(s.serve.calls).toEqual([]);
    expect(existsSync(at("packages/ui/dist/.inputs.json"))).toBe(false);
  });

  test("the manifest records the inputs from before the build started", async () => {
    // A source edited while the build runs leaves the build stale.
    const build = new FakeBuild(0, () => put("packages/ui/src/index.ts", "export const ui = 9;\n"));
    const s = start(["t.json"], { build });
    expect(await s.run).toBe(0);
    expect(build.runs).toBe(1);
    expect(await uiBuildIsStale(root)).toBe(true);
  });

  test("creates the table file's missing parent directory against cwd, not the file", async () => {
    const s = start(["tables/deep/crypt.table.json", "--no-build"]);
    expect(await s.run).toBe(0);
    expect(existsSync(join(cwd, "tables", "deep"))).toBe(true);
    expect(existsSync(join(cwd, "tables", "deep", "crypt.table.json"))).toBe(false);
  });

  test("resolves with the child's exit code", async () => {
    const s = start(["t.json", "--no-build"], { serve: new FakeServe(7) });
    expect(await s.run).toBe(7);
  });

  test("while the child runs, SIGTERM is forwarded and SIGINT ignored; never resolves before the child", async () => {
    const signals = new EventEmitter();
    const serve = new FakeServe(null);
    const s = start(["t.json", "--no-build"], { serve, signals });
    let settled = false;
    void s.run.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(serve.calls).toHaveLength(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);

    signals.emit("SIGINT", "SIGINT");
    expect(serve.kills).toEqual([]);
    signals.emit("SIGTERM", "SIGTERM");
    expect(serve.kills).toEqual(["SIGTERM"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    serve.finish(0);
    expect(await s.run).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
