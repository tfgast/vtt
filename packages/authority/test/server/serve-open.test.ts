/**
 * `vtt-serve --open` (vtt-nb8.4; PROTOCOL.md §2 "Opening a browser (M6-D5)"):
 * real subprocesses on port 0 with a temp table, a temp `XDG_CONFIG_HOME`, a
 * hand-written UI build directory and `BROWSER` pointing at a missing
 * executable or at a recording script, so no real browser opens.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const BIN = join(PKG, "src", "bin", "serve.ts");

const READY_MS = 30_000;
const TEST_MS = 60_000;

interface Proc {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let dir: string;
let file: string;
let uiDir: string;
const procs: Proc[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-serve-open-")));
  file = join(dir, "crypt.table.json");
  uiDir = join(dir, "dist");
  await mkdir(uiDir);
  await writeFile(join(uiDir, "index.html"), "<!doctype html><title>open test</title>\n");
});

afterEach(async () => {
  await Promise.all(
    procs.splice(0).map(async (p) => {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await p.exited;
    }),
  );
  await rm(dir, { recursive: true, force: true });
});

function serve(args: string[], env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args], {
    cwd: PKG,
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (s: string) => {
    stdout += s;
  });
  child.stderr?.setEncoding("utf8").on("data", (s: string) => {
    stderr += s;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const proc: Proc = {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    exited,
  };
  procs.push(proc);
  return proc;
}

async function until(pred: () => boolean, what: string, ms = READY_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function printedHttp(p: Proc): Promise<string> {
  await Promise.race([
    until(() => p.stdout.includes("\n"), "the --print-session line"),
    p.exited.then(({ code }) => {
      throw new Error(`vtt-serve exited (${code}) before listening:\n${p.stderr}`);
    }),
  ]);
  return (JSON.parse(p.stdout.split("\n")[0] as string) as { http: string }).http;
}

describe("vtt-serve --open", () => {
  test(
    "a browser that cannot be opened logs one line and the server keeps serving",
    async () => {
      const p = serve([file, "--port", "0", "--ui-dir", uiDir, "--print-session", "--open"], {
        BROWSER: "/nonexistent",
      });
      const http = await printedHttp(p);
      expect(http).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      await until(() => p.stderr.includes("could not open a browser"), "the could-not-open line");
      const line = p.stderr.split("\n").find((l) => l.includes("could not open a browser"));
      expect(line).toMatch(
        new RegExp(
          `^vtt-serve: could not open a browser \\(.*ENOENT.*\\); open ${http.replace(/[.]/g, "\\.")}$`,
        ),
      );
      const res = await fetch(http);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>open test</title>");
      p.child.kill("SIGTERM");
      expect(await p.exited).toEqual({ code: 0, signal: null });
    },
    TEST_MS,
  );

  test(
    "$BROWSER is run with the served URL as its only argument",
    async () => {
      const opened = join(dir, "opened.txt");
      const browser = join(dir, "browser.mjs");
      await writeFile(
        browser,
        `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(opened)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
      );
      await chmod(browser, 0o755);
      const p = serve([file, "--port", "0", "--ui-dir", uiDir, "--print-session", "--open"], {
        BROWSER: browser,
      });
      const http = await printedHttp(p);
      await until(() => existsSync(opened), "the browser script's record");
      await until(() => p.stderr.includes(`Open ${http}`), "the Open line");
      expect((await readFile(opened, "utf8")).trim()).toBe(JSON.stringify([http]));
      expect(p.stderr).not.toContain("could not open a browser");
    },
    TEST_MS,
  );

  test(
    "without --open no browser is run",
    async () => {
      const opened = join(dir, "opened.txt");
      const browser = join(dir, "browser.mjs");
      await writeFile(
        browser,
        `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(opened)}, "x\\n");\n`,
      );
      await chmod(browser, 0o755);
      const p = serve([file, "--port", "0", "--ui-dir", uiDir, "--print-session", "--no-open"], {
        BROWSER: browser,
      });
      const http = await printedHttp(p);
      expect((await fetch(http)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(opened)).toBe(false);
    },
    TEST_MS,
  );

  test(
    "--open with --no-ui exits 1 with the usage message",
    async () => {
      const p = serve([file, "--port", "0", "--no-ui", "--open"], { BROWSER: "/nonexistent" });
      expect(await p.exited).toEqual({ code: 1, signal: null });
      expect(p.stderr).toMatch(/--open/);
      expect(p.stderr).toMatch(/--no-ui/);
      expect(p.stderr).toMatch(/usage: vtt-serve .*\[--open\]/);
      expect(p.stdout).toBe("");
      expect(existsSync(file)).toBe(false);
    },
    TEST_MS,
  );
});
