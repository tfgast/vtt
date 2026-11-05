/**
 * The `vtt-mcp` stdio process (vtt-5su.17; PROTOCOL.md §2, §11): real
 * `vtt-serve` and `vtt-mcp` subprocesses on temp tables with a temp
 * `XDG_CONFIG_HOME`, driven over stdio by the SDK's client.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const SERVE_BIN = join(PKG, "src", "bin", "serve.ts");
const MCP_BIN = join(PKG, "src", "bin", "mcp.ts");

/** The bounded wait for start-up, reconnection (backoff up to 5 s) and exits. */
const BOUND = 20_000;
/** Per-test timeout: a test may wait for several bounded steps. */
const TEST_MS = 90_000;

const AGENT_NAME = "stdio-test-agent";

/** The 14 request tools, the subscription tools, then `import_asset` (PROTOCOL.md §11). */
const TOOL_NAMES = [
  "table_info",
  "list_objects",
  "get_objects",
  "evaluate",
  "zones",
  "at_position",
  "changes_since",
  "log",
  "explain_cell",
  "explain_group",
  "explain_action",
  "transact",
  "undo",
  "save",
  "subscribe",
  "poll_changes",
  "unsubscribe",
  "import_asset",
];

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
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface Agent {
  client: Client;
  transport: StdioClientTransport;
  /** The child's pid once the transport has spawned it (also if initialization fails), else 0. */
  readonly pid: number;
  readonly stderr: string;
  /** The child's exit status once it has exited, else null. */
  readonly exit: { code: number | null; signal: NodeJS.Signals | null } | null;
}

type ToolResult = {
  isError?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
  structuredContent?: any;
  content: { type: string; text?: string }[];
};

let dir: string;
let config: string;
let file: string;
const procs: Proc[] = [];
const agents: Agent[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-mcp-")));
  config = join(dir, "config");
  file = join(dir, "crypt.table.json");
});

afterEach(async () => {
  for (const a of agents.splice(0)) {
    const pid = a.pid;
    if (pid > 0 && a.exit === null && alive(pid)) process.kill(pid, "SIGKILL");
    await a.client.close().catch(() => undefined);
  }
  await Promise.all(
    procs.splice(0).map(async (p) => {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await p.exited;
    }),
  );
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  // Never signal 0 or a negative pid: those address process groups.
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for `pred`, polling every 10 ms, or fails after `ms`. */
async function until(pred: () => boolean, what: string, ms = BOUND): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function launch(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin: "ignore" | "pipe" = "ignore",
): Proc {
  const child = spawn(command, args, {
    cwd: PKG,
    env: {
      ...process.env,
      VTT_URL: undefined,
      VTT_TOKEN: undefined,
      XDG_CONFIG_HOME: config,
      ...env,
    },
    stdio: [stdin, "pipe", "pipe"],
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

/** `vtt-serve <table> --print-session [args]` (port 0 unless `args` names one). */
function serve(table: string, args: string[] = []): Proc {
  const port = args.includes("--port") ? [] : ["--port", "0"];
  return launch(process.execPath, [
    "--import",
    "tsx",
    SERVE_BIN,
    table,
    ...port,
    "--print-session",
    ...args,
  ]);
}

/** The `--print-session` line, once `vtt-serve` is listening (and has written the session file). */
async function printed(p: Proc): Promise<Printed> {
  await Promise.race([
    until(() => p.stdout.includes("\n"), "the --print-session line"),
    p.exited.then(({ code }) => {
      throw new Error(`vtt-serve exited (${code}) before listening:\n${p.stderr}`);
    }),
  ]);
  return JSON.parse(p.stdout.split("\n")[0] as string) as Printed;
}

async function exitOf(p: Proc): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the process did not exit:\n${p.stderr}`)), BOUND);
  });
  try {
    return await Promise.race([p.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function stop(p: Proc): Promise<void> {
  p.child.kill("SIGTERM");
  expect(await exitOf(p)).toEqual({ code: 0, signal: null });
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no port");
  await new Promise((r) => server.close(r));
  return address.port;
}

const sessionPath = () => join(config, "vtt", "session.json");

// A generated token is base64url and starts with "-" one time in 64, which
// `--token <t>` reads as a missing value (exit 1 before MCP starts: vtt-qf5.32).
// Pass generated tokens as `--token=<t>`.

/** Starts `vtt-mcp [args]` through the SDK's stdio client transport and initializes MCP. */
async function agent(args: string[] = [], env: Record<string, string> = {}): Promise<Agent> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", MCP_BIN, ...args],
    cwd: PKG,
    env: { ...getDefaultEnvironment(), XDG_CONFIG_HOME: config, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  let child: ChildProcess | undefined;
  let exit: Agent["exit"] = null;
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  // The transport keeps its child private and forgets it on close. Its
  // `start()` spawns synchronously, so wrapping `start` on this instance
  // captures the child and attaches the exit listener before control returns
  // to the event loop: even a child that dies at once reports its status.
  // (An instance property, not a subclass: the SDK only runs its disposable
  // version-negotiation probe for the base class's own prototype.)
  const start = transport.start.bind(transport);
  transport.start = () => {
    const started = start();
    child = (transport as unknown as { _process?: ChildProcess })._process;
    child?.once("exit", (code, signal) => {
      exit = { code, signal };
    });
    return started;
  };
  const client = new Client({ name: AGENT_NAME, version: "1.0.0" });
  const entry: Agent = {
    client,
    transport,
    get pid() {
      return child?.pid ?? 0;
    },
    get stderr() {
      return stderr;
    },
    get exit() {
      return exit;
    },
  };
  agents.push(entry);
  await diagnosed(entry, "connect", client.connect(transport));
  expect(entry.pid).toBeGreaterThan(0);
  return entry;
}

/** The child's pid, exit status and stderr, for a failure message. */
function diagnosis(a: Agent): string {
  const exit = a.exit === null ? "still running" : JSON.stringify(a.exit);
  return `vtt-mcp pid ${a.pid}, exit ${exit}, stderr:\n${a.stderr}`;
}

/** Awaits `p`; a failure (such as an early "Connection closed") carries the child's diagnosis. */
async function diagnosed<T>(a: Agent, what: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    // The transport reports a close on the child's `close` event, after
    // `exit`; let the piped stderr drain before reporting.
    await sleep(50);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${what} failed: ${message}\n${diagnosis(a)}`, { cause: err });
  }
}

async function call(
  a: Agent,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await diagnosed(
    a,
    `tools/call ${name}`,
    a.client.callTool({ name, arguments: args }),
  )) as ToolResult;
}

const codeOf = (r: ToolResult): unknown => (r.isError ? r.structuredContent?.code : undefined);

/** Calls `name` every 100 ms until `pred` holds for its result; returns that result. */
async function untilTool(
  a: Agent,
  name: string,
  args: Record<string, unknown>,
  pred: (r: ToolResult) => boolean,
  what: string,
): Promise<ToolResult> {
  const end = Date.now() + BOUND;
  for (;;) {
    const result = await call(a, name, args);
    if (pred(result)) return result;
    if (Date.now() > end) {
      throw new Error(
        `timed out waiting for ${what}; last ${name}: ${JSON.stringify(result.structuredContent)}\n${diagnosis(a)}`,
      );
    }
    await sleep(100);
  }
}

const succeeded = (r: ToolResult) => r.isError !== true;
const failedWith = (code: string) => (r: ToolResult) => codeOf(r) === code;

async function connected(a: Agent): Promise<ToolResult> {
  return untilTool(a, "table_info", {}, succeeded, "table_info to succeed");
}

async function subscribeGm(a: Agent): Promise<string> {
  const result = await call(a, "subscribe", { scope: { type: "board", board: "gm_board" } });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent.subscription as string;
}

/** `table_info`, `poll_changes` and `get_objects` all answer `isError` with `code`. */
async function expectGated(a: Agent, handle: string, code: string): Promise<void> {
  for (const [name, args] of [
    ["table_info", {}],
    ["poll_changes", { subscription: handle }],
    ["get_objects", { ids: ["orc"] }],
  ] as const) {
    const result = await call(a, name, args);
    expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBe(true);
    expect(result.structuredContent).toMatchObject({ code, message: expect.any(String) });
  }
}

/** The process is still running and still serving MCP. */
async function expectServing(a: Agent): Promise<void> {
  expect(alive(a.pid), diagnosis(a)).toBe(true);
  const { tools } = await diagnosed(a, "tools/list", a.client.listTools());
  expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
}

describe("vtt-mcp with explicit credentials", () => {
  test(
    "--url/--token lists the 18 tools and answers table_info with the agent actor",
    async () => {
      const s = await printed(serve(file));
      const a = await agent(["--url", s.url, `--token=${s.token}`]);
      const { tools } = await diagnosed(a, "tools/list", a.client.listTools());
      expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
      const info = await connected(a);
      expect(info.structuredContent).toMatchObject({
        table: { path: file, id: s.table_id },
        session: s.session,
        actor: { type: "agent", name: AGENT_NAME },
      });
    },
    TEST_MS,
  );

  test(
    "VTT_URL/VTT_TOKEN are explicit credentials; --name sets the agent name",
    async () => {
      const s = await printed(serve(file));
      const a = await agent(["--name", "Mira"], { VTT_URL: s.url, VTT_TOKEN: s.token });
      const info = await connected(a);
      expect(info.structuredContent.actor).toEqual({ type: "agent", name: "Mira" });
      expect(info.structuredContent.session).toBe(s.session);
    },
    TEST_MS,
  );

  test(
    "a restart with a new token: table_info, poll_changes and get_objects answer unauthorized; the process stays up",
    async () => {
      const port = await freePort();
      const first = serve(file, ["--port", String(port), "--token", "first-token"]);
      const s = await printed(first);
      const a = await agent(["--url", s.url, `--token=${s.token}`]);
      await connected(a);
      const handle = await subscribeGm(a);
      await stop(first);
      await printed(serve(file, ["--port", String(port), "--token", "second-token"]));
      await untilTool(a, "table_info", {}, failedWith("unauthorized"), "unauthorized");
      await expectGated(a, handle, "unauthorized");
      await sleep(500);
      await expectGated(a, handle, "unauthorized");
      await expectServing(a);
    },
    TEST_MS,
  );

  test(
    "a token starting with a dash is accepted as --token=<t>",
    async () => {
      const token = "-dash-token";
      const s = await printed(serve(file, [`--token=${token}`]));
      expect(s.token).toBe(token);
      const a = await agent(["--url", s.url, `--token=${token}`]);
      const info = await connected(a);
      expect(info.structuredContent.session).toBe(s.session);
    },
    TEST_MS,
  );

  test(
    "started while no authority runs: disconnected, then connected once vtt-serve listens on that port and token",
    async () => {
      const port = await freePort();
      const url = `ws://127.0.0.1:${port}/ws`;
      const a = await agent(["--url", url, "--token", "fixed-token"]);
      const before = await call(a, "table_info");
      expect(before.isError).toBe(true);
      expect(before.structuredContent).toMatchObject({ code: "disconnected" });
      await sleep(300);
      expect(codeOf(await call(a, "table_info"))).toBe("disconnected");
      await printed(serve(file, ["--port", String(port), "--token", "fixed-token"]));
      const info = await connected(a);
      expect(info.structuredContent).toMatchObject({
        table: { path: file },
        actor: { type: "agent", name: AGENT_NAME },
      });
    },
    TEST_MS,
  );
});

describe("vtt-mcp discovery", () => {
  test(
    "without flags it connects through the session file",
    async () => {
      const s = await printed(serve(file));
      const a = await agent();
      const info = await connected(a);
      expect(info.structuredContent).toMatchObject({
        table: { path: file, id: s.table_id },
        session: s.session,
        actor: { type: "agent", name: AGENT_NAME },
      });
    },
    TEST_MS,
  );

  test(
    "a normal restart without --token: the next call succeeds on the new session and the handle reports a resync",
    async () => {
      const first = serve(file);
      const s1 = await printed(first);
      const a = await agent();
      await connected(a);
      const handle = await subscribeGm(a);
      await stop(first);
      const s2 = await printed(serve(file));
      expect(s2.token).not.toBe(s1.token);
      expect(s2.session).not.toBe(s1.session);
      expect(JSON.parse(await readFile(sessionPath(), "utf8")).token).toBe(s2.token);
      const info = await connected(a);
      expect(info.structuredContent.session).toBe(s2.session);
      const poll = await untilTool(
        a,
        "poll_changes",
        { subscription: handle, wait_ms: 1000 },
        (r) => succeeded(r) && r.structuredContent.changes.length > 0,
        "the resync record",
      );
      expect(poll.structuredContent.changes).toEqual([
        expect.objectContaining({ type: "resync", session_changed: true }),
      ]);
    },
    TEST_MS,
  );

  test(
    "a restart onto another table file: table_info, poll_changes and get_objects answer wrong_table",
    async () => {
      const first = serve(file);
      await printed(first);
      const a = await agent();
      await connected(a);
      const handle = await subscribeGm(a);
      await stop(first);
      await printed(serve(join(dir, "other.table.json")));
      await untilTool(a, "table_info", {}, failedWith("wrong_table"), "wrong_table");
      await expectGated(a, handle, "wrong_table");
      await expectServing(a);
    },
    TEST_MS,
  );

  test(
    "a restart on the same path with a replaced .table-id answers wrong_table",
    async () => {
      const first = serve(file);
      const s1 = await printed(first);
      const a = await agent();
      await connected(a);
      const handle = await subscribeGm(a);
      await stop(first);
      await writeFile(`${file}.table-id`, "0b0e8a52-7f2c-4b8e-9a51-6d3c2e1f0a99\n");
      const s2 = await printed(serve(file));
      expect(s2.table_path).toBe(s1.table_path);
      expect(s2.table_id).not.toBe(s1.table_id);
      await untilTool(a, "table_info", {}, failedWith("wrong_table"), "wrong_table");
      await expectGated(a, handle, "wrong_table");
      await expectServing(a);
    },
    TEST_MS,
  );

  test(
    "with the authority stopped the tools answer disconnected; after it restarts the next call of each succeeds",
    async () => {
      const first = serve(file);
      await printed(first);
      const a = await agent();
      await connected(a);
      const handle = await subscribeGm(a);
      await stop(first);
      await untilTool(a, "table_info", {}, failedWith("disconnected"), "disconnected");
      await expectGated(a, handle, "disconnected");
      await printed(serve(file));
      await connected(a);
      const poll = await call(a, "poll_changes", { subscription: handle });
      expect(poll.isError, JSON.stringify(poll.structuredContent)).not.toBe(true);
      expect(poll.structuredContent.subscription).toBe(handle);
      const got = await call(a, "get_objects", { ids: ["orc"] });
      expect(got.isError, JSON.stringify(got.structuredContent)).not.toBe(true);
      expect(got.structuredContent.missing).toEqual(["orc"]);
    },
    TEST_MS,
  );

  test(
    "started with a stale session file and no authority: disconnected, then connected once vtt-serve starts",
    async () => {
      // A session file left behind by an authority that is gone.
      const first = serve(file);
      await printed(first);
      first.child.kill("SIGKILL");
      await exitOf(first);
      expect(statSync(sessionPath()).isFile()).toBe(true);
      const a = await agent();
      expect(codeOf(await call(a, "table_info"))).toBe("disconnected");
      await sleep(300);
      expect(codeOf(await call(a, "table_info"))).toBe("disconnected");
      const s = await printed(serve(file, ["--force-unlock"]));
      const info = await connected(a);
      expect(info.structuredContent).toMatchObject({
        session: s.session,
        actor: { type: "agent", name: AGENT_NAME },
      });
    },
    TEST_MS,
  );

  test(
    "with no session file it stays up answering disconnected and connects once vtt-serve writes the file",
    async () => {
      const a = await agent();
      expect(codeOf(await call(a, "table_info"))).toBe("disconnected");
      await sleep(500);
      expect(codeOf(await call(a, "table_info"))).toBe("disconnected");
      expect(alive(a.pid)).toBe(true);
      const s = await printed(serve(file));
      const info = await connected(a);
      expect(info.structuredContent).toMatchObject({
        table: { path: file, id: s.table_id },
        session: s.session,
        actor: { type: "agent", name: AGENT_NAME },
      });
    },
    TEST_MS,
  );
});

describe("vtt-mcp process", () => {
  /** `vtt-mcp [args]` spawned directly, stdin piped. */
  const mcp = (args: string[], env: Record<string, string | undefined> = {}) =>
    launch(process.execPath, ["--import", "tsx", MCP_BIN, ...args], env, "pipe");

  test(
    "malformed or incomplete explicit credentials exit 1 with a one-line message",
    async () => {
      const cases: [string[], Record<string, string>][] = [
        [["--url", "ws://127.0.0.1:4747/ws"], {}],
        [["--token", "t"], {}],
        [["--url", "not a url", "--token", "t"], {}],
        [["--url", "http://127.0.0.1:4747/ws", "--token", "t"], {}],
        [["--url", "ws://127.0.0.1:4747/ws", "--token", ""], {}],
        [[], { VTT_URL: "ws://127.0.0.1:4747/ws" }],
        [[], { VTT_TOKEN: "t" }],
        [[], { VTT_URL: "ftp://127.0.0.1/", VTT_TOKEN: "t" }],
        [[], { VTT_URL: "", VTT_TOKEN: "" }],
        [[], { VTT_URL: "", VTT_TOKEN: "t" }],
        [[], { VTT_URL: "ws://127.0.0.1:4747/ws", VTT_TOKEN: "" }],
        [[], { VTT_URL: "" }],
        [[], { VTT_TOKEN: "" }],
        // Line breaks in a value stay on the one diagnostic line. (WHATWG URL
        // parsing strips them, so the URLs are otherwise malformed.)
        [["--url", "ftp://127.0.0.1/\nsecond line", "--token", "t"], {}],
        [["--bo\ngus"], {}],
        [["--url", "http://x/\r\nsecond line", "--token", "t"], {}],
        [[], { VTT_URL: "not a url\nsecond line", VTT_TOKEN: "t" }],
      ];
      await Promise.all(
        cases.map(async ([args, env]) => {
          const p = mcp(args, env);
          const label = `${args.join(" ")} ${JSON.stringify(env)}`;
          expect(await exitOf(p), label).toEqual({ code: 1, signal: null });
          expect(p.stderr.trim().split("\n"), label).toHaveLength(1);
          expect(p.stderr, label).toMatch(/^vtt-mcp: /);
          expect(p.stdout, label).toBe("");
        }),
      );
    },
    TEST_MS,
  );

  test(
    "closing stdin exits 0, also while connected; stdout carries only JSON-RPC",
    async () => {
      // Never initialized, discovery mode with no session file.
      const idle = mcp([]);
      await sleep(300);
      idle.child.stdin?.end();
      expect(await exitOf(idle)).toEqual({ code: 0, signal: null });
      expect(idle.stdout).toBe("");

      // Initialized and connected to an authority.
      const s = await printed(serve(file));
      const p = mcp(["--url", s.url, `--token=${s.token}`]);
      const send = (message: unknown) => p.child.stdin?.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw-agent", version: "1.0.0" },
        },
      });
      await until(() => p.stdout.includes('"id":1'), "the initialize result");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      let n = 2;
      const id = () => n++;
      for (;;) {
        const callId = id();
        send({
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name: "table_info", arguments: {} },
        });
        await until(() => p.stdout.includes(`"id":${callId}`), "a tools/call result");
        const line = p.stdout.split("\n").find((l) => l.includes(`"id":${callId}`)) as string;
        if (!JSON.parse(line).result.isError) break;
        await sleep(100);
      }
      p.child.stdin?.end();
      expect(await exitOf(p)).toEqual({ code: 0, signal: null });
      for (const line of p.stdout.split("\n").filter((l) => l !== "")) {
        expect(JSON.parse(line).jsonrpc).toBe("2.0");
      }
    },
    TEST_MS,
  );

  test(
    "a child that fails at once: the connect failure reports its exit status and stderr",
    async () => {
      const failure = agent(["--bogus"]);
      await expect(failure).rejects.toThrow(/^connect failed: /);
      const message = await failure.then(
        () => "",
        (err: Error) => err.message,
      );
      expect(message).toMatch(/vtt-mcp pid [1-9]\d*, exit \{"code":1,"signal":null\}, stderr:\n/);
      expect(message).toMatch(/\nvtt-mcp: .*'--bogus'.*; usage: vtt-mcp /);
    },
    TEST_MS,
  );

  test(
    "the bin is declared in package.json and runs through its shebang",
    async () => {
      const source = readFileSync(MCP_BIN, "utf8");
      expect(source.startsWith("#!/usr/bin/env -S node --import tsx\n")).toBe(true);
      expect(statSync(MCP_BIN).mode & 0o111).not.toBe(0);
      const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
      expect(pkg.bin["vtt-mcp"]).toBe("./src/bin/mcp.ts");
      const p = launch(MCP_BIN, ["--url", "ws://127.0.0.1:1/ws"], {
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      });
      expect(await exitOf(p)).toEqual({ code: 1, signal: null });
      expect(p.stderr).toMatch(/^vtt-mcp: .*--token/);
    },
    TEST_MS,
  );
});
