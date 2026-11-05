/**
 * The `vtt-serve` process (vtt-5su.14): real subprocesses on port 0 with a
 * temp table file and a temp `XDG_CONFIG_HOME`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTable } from "@vtt/authority";
import { ProtocolClient } from "@vtt/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket as WsClient } from "ws";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BIN = join(PKG, "src", "bin", "serve.ts");

/** The bounded wait for a child's readiness or exit (tsx start-up included). */
const READY_MS = 20_000;

interface Printed {
  url: string;
  token: string;
  session: string;
  table_path: string;
  table_id: string;
}

interface Proc {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  /** Resolves with the exit code (null when killed by a signal) and signal. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let dir: string;
let config: string;
let file: string;
const procs: Proc[] = [];
const clients: ProtocolClient[] = [];
const blockers: Server[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-serve-")));
  config = join(dir, "config");
  file = join(dir, "crypt.table.json");
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const b of blockers.splice(0)) await new Promise((r) => b.close(r));
  await Promise.all(
    procs.splice(0).map(async (p) => {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await p.exited;
    }),
  );
  await rm(dir, { recursive: true, force: true });
});

function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Proc {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: config, ...env },
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

/** `node --import tsx src/bin/serve.ts …` from the package directory. */
function serve(args: string[]): Proc {
  return launch(process.execPath, ["--import", "tsx", BIN, ...args], PKG);
}

/** Waits for `pred`, polling every 10 ms, or fails after `ms`. */
async function until(pred: () => boolean, what: string, ms = READY_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The `--print-session` line, once the process is listening. */
async function printed(p: Proc): Promise<Printed> {
  await Promise.race([
    until(() => p.stdout.includes("\n"), "the --print-session line"),
    p.exited.then(({ code }) => {
      throw new Error(`vtt-serve exited (${code}) before listening:\n${p.stderr}`);
    }),
  ]);
  const lines = p.stdout.split("\n").filter((l) => l !== "");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Printed;
}

/** Waits for exit, bounded. */
async function exitOf(p: Proc): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`vtt-serve did not exit:\n${p.stderr}`)), READY_MS);
  });
  try {
    return await Promise.race([p.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function stop(p: Proc, signal: NodeJS.Signals = "SIGTERM") {
  p.child.kill(signal);
  return exitOf(p);
}

const sessionPath = () => join(config, "vtt", "session.json");
const readSession = async () => JSON.parse(await readFile(sessionPath(), "utf8"));

async function connect(s: { url: string; token: string }): Promise<ProtocolClient> {
  const client = new ProtocolClient({
    url: s.url,
    token: s.token,
    client: { name: "serve-cli-test", kind: "test" },
    onWarning: () => undefined,
  });
  clients.push(client);
  await client.connect();
  return client;
}

async function createOrc(client: ProtocolClient, id = "orc"): Promise<void> {
  const result = await client.transact([
    { type: "create_object", id, to: { type: "board", board: "gm_board", position: [1, 2] } },
  ]);
  expect(result.status).toBe("committed");
}

const healthz = async (url: string) => {
  const res = await fetch(url.replace(/^ws:/, "http:").replace(/\/ws$/, "/healthz"));
  return { status: res.status, body: await res.json() };
};

/** A port held by another listener on 127.0.0.1. */
async function busyPort(): Promise<number> {
  const blocker = createServer();
  blockers.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

describe("vtt-serve start-up", () => {
  test("creates a missing file with the gm_board board, writes the session file and answers /healthz", async () => {
    const p = serve([file, "--port", "0", "--print-session"]);
    const s = await printed(p);
    expect(s.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    expect(s.url).not.toBe("ws://127.0.0.1:0/ws");
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.session).toEqual(expect.any(String));
    expect(s.table_path).toBe(file);
    expect(s.table_id).toBe((await readFile(`${file}.table-id`, "utf8")).trim());

    const loaded = await loadTable(file);
    const snap = loaded.store.toSnapshot();
    expect(snap.boards).toEqual([{ id: "gm_board", name: "GM" }]);
    expect(snap.objects).toEqual({});
    expect(snap.revision).toBe(0);

    expect(statSync(sessionPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(sessionPath())).mode & 0o777).toBe(0o700);
    expect(await readSession()).toEqual({
      url: s.url,
      token: s.token,
      pid: p.child.pid,
      table_path: s.table_path,
      table_id: s.table_id,
    });

    expect(await healthz(s.url)).toEqual({ status: 200, body: { ok: true, revision: 0 } });
    expect(existsSync(`${file}.lock`)).toBe(true);
    // Logs go to stderr; stdout carries only the --print-session line.
    expect(p.stderr).toContain(file);
  });

  test("the root `serve` script form runs from the repository root", async () => {
    const p = launch(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/authority/src/bin/serve.ts",
        file,
        "--port",
        "0",
        "--print-session",
      ],
      ROOT,
    );
    const s = await printed(p);
    expect((await healthz(s.url)).status).toBe(200);
    expect(await stop(p)).toEqual({ code: 0, signal: null });
  });

  test("the bin runs through its shebang", async () => {
    const source = await readFile(BIN, "utf8");
    expect(source.startsWith("#!/usr/bin/env -S node --import tsx\n")).toBe(true);
    expect(statSync(BIN).mode & 0o111).not.toBe(0);
    const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
    expect(pkg.bin["vtt-serve"]).toBe("./src/bin/serve.ts");
    const p = launch(BIN, [file, "--port", "0", "--print-session"], PKG, {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    });
    const s = await printed(p);
    expect((await healthz(s.url)).status).toBe(200);
    expect(await stop(p)).toEqual({ code: 0, signal: null });
  });

  test("an unknown flag or a missing file argument exits 1 with a usage line", async () => {
    for (const args of [
      [file, "--bogus"],
      [],
      [file, "--port", "nope"],
      [file, "--port", "70000"],
    ]) {
      const p = serve(args);
      expect(await exitOf(p), args.join(" ")).toEqual({ code: 1, signal: null });
      expect(p.stderr).toMatch(/vtt-serve/);
      expect(p.stdout).toBe("");
    }
    expect(existsSync(file)).toBe(false);
  });

  test("a malformed .table-id exits 1 naming it and telling the user to fix or delete it", async () => {
    await writeFile(`${file}.table-id`, "not a uuid\n");
    const p = serve([file, "--port", "0", "--print-session"]);
    expect(await exitOf(p)).toEqual({ code: 1, signal: null });
    expect(p.stderr).toContain(`${file}.table-id`);
    expect(p.stderr).toMatch(/fix or delete it/);
    expect(p.stderr.trim().split("\n")).toHaveLength(1);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(sessionPath())).toBe(false);
  });

  test("a port in use exits 1 with a one-line message and leaves no lock file", async () => {
    const port = await busyPort();
    const p = serve([file, "--port", String(port), "--print-session"]);
    expect(await exitOf(p)).toEqual({ code: 1, signal: null });
    expect(p.stderr).toContain(String(port));
    expect(p.stderr).toMatch(/in use/);
    expect(p.stderr.trim().split("\n")).toHaveLength(1);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(sessionPath())).toBe(false);
    expect(p.stdout).toBe("");
  });
});

describe("vtt-serve shutdown", () => {
  test("SIGTERM after a transact saves, removes the session and lock files, and exits 0", async () => {
    const p = serve([file, "--port", "0", "--print-session"]);
    const s = await printed(p);
    const client = await connect(s);
    await createOrc(client);
    expect(await stop(p)).toEqual({ code: 0, signal: null });
    expect(Object.keys((await loadTable(file)).store.toSnapshot().objects)).toEqual(["orc"]);
    expect(existsSync(sessionPath())).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("SIGINT shuts down the same way", async () => {
    const p = serve([file, "--port", "0", "--print-session"]);
    const s = await printed(p);
    await createOrc(await connect(s));
    expect(await stop(p, "SIGINT")).toEqual({ code: 0, signal: null });
    expect(Object.keys((await loadTable(file)).store.toSnapshot().objects)).toEqual(["orc"]);
    expect(existsSync(sessionPath())).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("with --no-autosave, a transact committed just before SIGTERM is in the file after exit", async () => {
    const p = serve([file, "--port", "0", "--print-session", "--no-autosave"]);
    const s = await printed(p);
    const client = await connect(s);
    await createOrc(client);
    // No autosave ran: the file still holds the new table.
    expect((await loadTable(file)).store.toSnapshot().revision).toBe(0);
    expect(await stop(p)).toEqual({ code: 0, signal: null });
    const snap = (await loadTable(file)).store.toSnapshot();
    expect(snap.revision).toBe(1);
    expect(Object.keys(snap.objects)).toEqual(["orc"]);
  });

  test("a second signal during shutdown is ignored", async () => {
    const p = serve([file, "--port", "0", "--print-session", "--no-autosave"]);
    const s = await printed(p);
    await createOrc(await connect(s));
    p.child.kill("SIGTERM");
    p.child.kill("SIGINT");
    expect(await exitOf(p)).toEqual({ code: 0, signal: null });
    expect(Object.keys((await loadTable(file)).store.toSnapshot().objects)).toEqual(["orc"]);
  });

  test("a failing final save logs the error, removes the lock file and exits 1", async () => {
    const p = serve([file, "--port", "0", "--print-session", "--no-autosave"]);
    const s = await printed(p);
    await createOrc(await connect(s));
    // Replace the table file with a non-empty directory: the final save's rename fails.
    await rm(file);
    await mkdir(file);
    await writeFile(join(file, "keep"), "x");
    expect(await stop(p)).toEqual({ code: 1, signal: null });
    expect(p.stderr).toMatch(/save/i);
    expect(p.stderr).toMatch(/revision 1/);
    // Stage before_replace: the old file (here, the directory) is left in place.
    expect(p.stderr).toMatch(/not replaced/);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(sessionPath())).toBe(false);
  });
});

describe("vtt-serve locks", () => {
  test("a second vtt-serve on the same file exits 1 naming the lock holder; the first keeps serving", async () => {
    const first = serve([file, "--port", "0", "--print-session"]);
    const s = await printed(first);
    const before = await readFile(sessionPath(), "utf8");

    const second = serve([file, "--port", "0", "--print-session"]);
    expect(await exitOf(second)).toEqual({ code: 1, signal: null });
    expect(second.stderr).toContain(file);
    expect(second.stderr).toContain(`pid ${first.child.pid}`);
    expect(second.stderr).not.toMatch(/--force-unlock/);
    expect(second.stderr.trim().split("\n")).toHaveLength(1);
    expect(second.stdout).toBe("");

    // The session file is not touched, and the first still serves.
    expect(await readFile(sessionPath(), "utf8")).toBe(before);
    expect((await healthz(s.url)).status).toBe(200);
    await createOrc(await connect(s));
    expect(await stop(first)).toEqual({ code: 0, signal: null });
  });

  test("after SIGKILL the stale lock is refused with a --force-unlock hint; --force-unlock removes it and serves", async () => {
    const killed = serve([file, "--port", "0", "--print-session"]);
    await printed(killed);
    const killedPid = killed.child.pid;
    expect(await stop(killed, "SIGKILL")).toEqual({ code: null, signal: "SIGKILL" });
    expect(existsSync(`${file}.lock`)).toBe(true);

    const refused = serve([file, "--port", "0", "--print-session"]);
    expect(await exitOf(refused)).toEqual({ code: 1, signal: null });
    expect(refused.stderr).toContain(`pid ${killedPid}`);
    expect(refused.stderr).toMatch(/--force-unlock/);
    expect(refused.stderr.trim().split("\n")).toHaveLength(1);

    const forced = serve([file, "--port", "0", "--print-session", "--force-unlock"]);
    const s = await printed(forced);
    expect(forced.stderr).toMatch(/removed/);
    expect(forced.stderr).toContain(`pid ${killedPid}`);
    expect((await healthz(s.url)).status).toBe(200);
    expect((await readSession()).pid).toBe(forced.child.pid);
    expect(await stop(forced)).toEqual({ code: 0, signal: null });
  });

  test("--force-unlock with no lock logs that there was none and serves", async () => {
    const p = serve([file, "--port", "0", "--print-session", "--force-unlock"]);
    const s = await printed(p);
    expect(p.stderr).toMatch(/no lock/);
    expect((await healthz(s.url)).status).toBe(200);
    expect(await stop(p)).toEqual({ code: 0, signal: null });
  });

  test("--force-unlock removes an unreadable lock and says so", async () => {
    await writeFile(`${file}.lock`, "garbage");
    const refused = serve([file, "--port", "0", "--print-session"]);
    expect(await exitOf(refused)).toEqual({ code: 1, signal: null });
    expect(refused.stderr).toContain(`${file}.lock`);

    const p = serve([file, "--port", "0", "--print-session", "--force-unlock"]);
    const s = await printed(p);
    expect(p.stderr).toMatch(/removed/);
    expect(p.stderr).toMatch(/unreadable or malformed/);
    expect((await healthz(s.url)).status).toBe(200);
    expect(await stop(p)).toEqual({ code: 0, signal: null });
  });
});

describe("vtt-serve restarts", () => {
  test("--port <same> --token <same> serves the same url and token with a new session", async () => {
    const first = serve([file, "--port", "0", "--print-session"]);
    const a = await printed(first);
    const port = new URL(a.url).port;
    expect(await stop(first)).toEqual({ code: 0, signal: null });

    const second = serve([file, "--port", port, "--token", a.token, "--print-session"]);
    const b = await printed(second);
    expect(b.url).toBe(a.url);
    expect(b.token).toBe(a.token);
    expect(b.session).not.toBe(a.session);
    expect(b.table_id).toBe(a.table_id);
    expect(await readSession()).toMatchObject({
      url: a.url,
      token: a.token,
      pid: second.child.pid,
    });
    expect(await stop(second)).toEqual({ code: 0, signal: null });
  });

  test("without --token: a new token, the same table_path and table_id, the session file rewritten", async () => {
    const first = serve([file, "--port", "0", "--print-session"]);
    const a = await printed(first);
    await createOrc(await connect(a));
    expect(await stop(first)).toEqual({ code: 0, signal: null });

    const second = serve([file, "--port", "0", "--print-session"]);
    const b = await printed(second);
    expect(b.token).not.toBe(a.token);
    expect(b.session).not.toBe(a.session);
    expect(b.table_path).toBe(a.table_path);
    expect(b.table_id).toBe(a.table_id);
    expect(await readSession()).toEqual({
      url: b.url,
      token: b.token,
      pid: second.child.pid,
      table_path: a.table_path,
      table_id: a.table_id,
    });
    expect((await healthz(b.url)).body.revision).toBe(1);
    expect(await stop(second)).toEqual({ code: 0, signal: null });
  });

  test("--allow-origin admits the named origin's upgrade", async () => {
    const p = serve([
      file,
      "--port",
      "0",
      "--print-session",
      "--allow-origin",
      "http://localhost:5173",
      "--allow-origin",
      "http://example.test",
    ]);
    const s = await printed(p);
    const status = async (origin: string) => {
      const ws = new WsClient(s.url, { origin });
      return new Promise<string>((resolve) => {
        ws.on("open", () => {
          ws.close();
          resolve("open");
        });
        ws.on("error", () => resolve("refused"));
      });
    };
    expect(await status("http://localhost:5173")).toBe("open");
    expect(await status("http://example.test")).toBe("open");
    expect(await status("http://evil.test")).toBe("refused");
    expect(await stop(p)).toEqual({ code: 0, signal: null });
  });
});
