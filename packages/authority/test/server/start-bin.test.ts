/**
 * `pnpm start`'s launcher binary (vtt-nb8.4; DESIGN.md §7 Platform and New
 * tables; PROTOCOL.md §2; M6-D5; M6 plan review r1 finding 1): the quick-start
 * command from a temp working directory with neither `tables/` nor the table
 * file, `--ui-dir` pointing at a hand-written build (so the real UI is not
 * built) and `BROWSER` pointing at a recording script (so no browser opens).
 *
 * The bead's command is `node --import tsx <start.ts> …`; Node resolves a bare
 * `--import` specifier against the working directory, which here is a temp
 * directory with no `node_modules`, so the test passes tsx's resolved loader
 * URL instead (the same module `pnpm start` loads from the repo root).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTable } from "@vtt/authority";
import { ProtocolClient } from "@vtt/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const START = join(PKG, "src", "bin", "start.ts");
const TSX = pathToFileURL(createRequire(join(PKG, "package.json")).resolve("tsx")).href;

const READY_MS = 30_000;
const TEST_MS = 60_000;

interface Proc {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let dir: string;
let cwd: string;
let uiDir: string;
let opened: string;
let browser: string;
const procs: Proc[] = [];
const clients: ProtocolClient[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-start-")));
  cwd = join(dir, "work");
  uiDir = join(dir, "ui");
  opened = join(dir, "opened.txt");
  browser = join(dir, "browser.mjs");
  await mkdir(cwd);
  await mkdir(uiDir);
  await writeFile(
    join(uiDir, "index.html"),
    "<!doctype html><html><head><title>quick start</title></head><body></body></html>\n",
  );
  await writeFile(
    browser,
    `#!${process.execPath}\nimport { renameSync, writeFileSync } from "node:fs";\nconst tmp = ${JSON.stringify(opened)} + "." + process.pid + ".tmp";\nwriteFileSync(tmp, process.argv[2] + "\\n");\nrenameSync(tmp, ${JSON.stringify(opened)});\n`,
  );
  await chmod(browser, 0o755);
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(
    procs.splice(0).map(async (p) => {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await p.exited;
    }),
  );
  await rm(dir, { recursive: true, force: true });
});

function launch(args: string[]): Proc {
  const child = spawn(process.execPath, ["--import", TSX, START, ...args], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), BROWSER: browser },
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

/**
 * The browser stub's record, or "" while it does not exist yet. Tests wait on
 * this reading as a complete line, never on the file merely existing: a file
 * can exist before its contents land (open-then-write), and under a loaded
 * full suite a read in that window saw "" (vtt-qf5.51). The stub also writes
 * a temp file and renames it into place, so the record appears whole.
 */
function record(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), READY_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "the quick-start command creates tables/ and the stocked table, opens the browser, serves, and saves on SIGTERM",
  async () => {
    expect(existsSync(join(cwd, "tables"))).toBe(false);
    const p = launch([
      "tables/crypt.table.json",
      "--port",
      "0",
      "--ui-dir",
      uiDir,
      "--print-session",
    ]);
    await Promise.race([
      until(() => p.stdout.includes("\n"), "the --print-session line"),
      p.exited.then(({ code }) => {
        throw new Error(`the launcher exited (${code}) before listening:\n${p.stderr}`);
      }),
    ]);
    const s = JSON.parse(p.stdout.split("\n")[0] as string) as {
      url: string;
      token: string;
      http: string;
      table_path: string;
    };
    const port = Number(new URL(s.url).port);
    expect(s.http).toBe(`http://127.0.0.1:${port}/`);
    expect(s.table_path).toBe(join(cwd, "tables", "crypt.table.json"));

    await until(() => record(opened).endsWith("\n"), "the browser script's record");
    expect(record(opened)).toBe(`http://127.0.0.1:${port}/\n`);

    const res = await fetch(s.http);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>quick start</title>");

    const client = new ProtocolClient({
      url: s.url,
      token: s.token,
      client: { name: "start-bin-test", kind: "test" },
      onWarning: () => undefined,
    });
    clients.push(client);
    await client.connect();
    expect(client.revision).toBe(0);
    expect(client.boards.map((b) => b.id)).toEqual(["gm_board"]);
    const got = await client.request("get_objects", { ids: ["gm_binder"] });
    expect(got.objects).toHaveLength(1);
    expect(got.objects[0]?.id).toBe("gm_binder");
    client.close();

    p.child.kill("SIGTERM");
    expect(await bounded(p.exited, "the launcher's exit")).toEqual({ code: 0, signal: null });
    // The server handled the forwarded SIGTERM (its log reaches the launcher's stderr).
    expect(p.stderr).toMatch(/vtt-serve: SIGTERM: shutting down/);
    const file = join(cwd, "tables", "crypt.table.json");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
    const snap = (await loadTable(file)).store.toSnapshot();
    expect(Object.keys(snap.objects)).toContain("gm_binder");
  },
  TEST_MS,
);

test(
  "--no-open starts and serves the table without running the browser",
  async () => {
    const p = launch([
      "tables/crypt.table.json",
      "--no-open",
      "--port",
      "0",
      "--ui-dir",
      uiDir,
      "--print-session",
    ]);
    await Promise.race([
      until(() => p.stdout.includes("\n"), "the --print-session line"),
      p.exited.then(({ code }) => {
        throw new Error(`the launcher exited (${code}) before listening:\n${p.stderr}`);
      }),
    ]);
    const s = JSON.parse(p.stdout.split("\n")[0] as string) as { url: string; http: string };
    const res = await fetch(s.http);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>quick start</title>");
    // With --open, vtt-serve spawns $BROWSER before it prints the session
    // line, so by now any opener has been started; a negative can only be
    // observed after a grace, so give a stray stub a second to land its record.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(record(opened)).toBe("");
    expect(existsSync(opened)).toBe(false);

    p.child.kill("SIGTERM");
    expect(await bounded(p.exited, "the launcher's exit")).toEqual({ code: 0, signal: null });
    expect(existsSync(opened)).toBe(false);
    expect(p.stderr).not.toMatch(/could not open a browser/);
  },
  TEST_MS,
);

test(
  "a usage error exits 1 with the launcher's usage line",
  async () => {
    const p = launch(["--port", "0"]);
    expect(await bounded(p.exited, "the launcher's exit")).toEqual({ code: 1, signal: null });
    expect(p.stderr).toContain(
      "usage: pnpm start <file> [--no-build] [--no-open] [vtt-serve flags…]",
    );
    expect(existsSync(join(cwd, "tables"))).toBe(false);
  },
  TEST_MS,
);
