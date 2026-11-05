/**
 * `vtt-serve`'s UI flags (vtt-3l6.15; PROTOCOL.md §1 HTTP routes, §2
 * Session bootstrap; M4-D1): real subprocesses on port 0 with a temp table,
 * a temp `XDG_CONFIG_HOME` and a hand-written UI build directory. The asset
 * handler (vtt-3l6.16) and the UI handler (vtt-3l6.14) are both installed;
 * `--no-ui` drops only the UI handler.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BIN = join(PKG, "src", "bin", "serve.ts");

/** The bounded wait for a child's readiness or exit (tsx start-up included; CI is slow). */
const READY_MS = 30_000;
const TEST_MS = 60_000;

interface Printed {
  url: string;
  token: string;
  session: string;
  table_path: string;
  table_id: string;
  http: string;
}

interface Proc {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let dir: string;
let config: string;
let file: string;
let uiDir: string;
const procs: Proc[] = [];

const INDEX = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>test build</title>
    <script type="module" src="/ui-assets/app.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;
const APP_JS = "console.log('the test build');\n";

const png = (fill = "pixels"): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(fill)]);

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-serve-ui-")));
  config = join(dir, "config");
  file = join(dir, "crypt.table.json");
  uiDir = join(dir, "dist");
  await mkdir(join(uiDir, "ui-assets"), { recursive: true });
  await writeFile(join(uiDir, "index.html"), INDEX);
  await writeFile(join(uiDir, "ui-assets", "app.js"), APP_JS);
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

/** `node --import tsx src/bin/serve.ts …` from the package directory. */
function serve(args: string[]): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args], {
    cwd: PKG,
    env: { ...process.env, XDG_CONFIG_HOME: config },
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

const sessionElements = (html: string): string[] =>
  html.match(/<script id="vtt-session" type="application\/json">[^<]*<\/script>/g) ?? [];

/** `POST /assets` with the bearer token, then `GET /assets/<path>`: the same bytes come back. */
async function assetRoundTrip(http: string, token: string): Promise<void> {
  const bytes = png("serve-ui");
  const posted = await fetch(new URL("/assets", http), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-filename": "map.png" },
    body: new Uint8Array(bytes),
  });
  expect(posted.status).toBe(201);
  const { path } = (await posted.json()) as { path: string };
  expect(path).toMatch(/^crypt\.table\.json\.assets\/map-[0-9a-f]{8}\.png$/);
  const got = await fetch(new URL(`/assets/${path}`, http));
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);
}

describe("vtt-serve --ui-dir", () => {
  test(
    "prints the http key, logs the Open line, serves the injected page and its bundles, and round-trips an asset",
    async () => {
      const p = serve([file, "--port", "0", "--ui-dir", uiDir, "--print-session"]);
      const s = await printed(p);
      const port = Number(new URL(s.url).port);
      expect(port).toBeGreaterThan(0);
      expect(s.http).toBe(`http://127.0.0.1:${port}/`);
      await until(
        () => p.stderr.includes(`Open http://127.0.0.1:${port}/`),
        "the Open line on stderr",
      );

      for (const path of ["/", "/index.html"]) {
        const res = await fetch(new URL(path, s.http));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        const elements = sessionElements(html);
        expect(elements).toHaveLength(1);
        expect(html.match(/vtt-session/g)).toHaveLength(1);
        const json = (elements[0] as string)
          .replace(/^<script[^>]*>/, "")
          .replace(/<\/script>$/, "");
        expect(JSON.parse(json)).toEqual({ url: s.url, token: s.token });
        expect(html).toContain('<script type="module" src="/ui-assets/app.js"></script>');
      }

      const bundle = await fetch(new URL("/ui-assets/app.js", s.http));
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await bundle.text()).toBe(APP_JS);

      await assetRoundTrip(s.http, s.token);
      // The image namespace never serves the UI build, nor the reverse.
      expect((await fetch(new URL("/assets/app.js", s.http))).status).toBe(404);
      expect((await fetch(new URL("/ui-assets/map.png", s.http))).status).toBe(404);
    },
    TEST_MS,
  );

  test(
    "a relative --ui-dir is resolved against the working directory",
    async () => {
      const rel = relative(PKG, uiDir);
      expect(rel.startsWith("/")).toBe(false);
      const p = serve([file, "--port", "0", "--ui-dir", rel, "--print-session"]);
      const s = await printed(p);
      const html = await (await fetch(new URL("/", s.http))).text();
      expect(html).toContain("<title>test build</title>");
      expect(sessionElements(html)).toHaveLength(1);
    },
    TEST_MS,
  );

  test(
    "without --ui-dir the default is packages/ui/dist (resolved from the module's location)",
    async () => {
      const p = serve([file, "--port", "0", "--print-session"]);
      const s = await printed(p);
      const res = await fetch(new URL("/", s.http));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      if (existsSync(join(ROOT, "packages", "ui", "dist", "index.html"))) {
        expect(sessionElements(html)).toHaveLength(1);
        expect(html).toContain(s.token);
      } else {
        // The UI handler's build hint: the default directory has no build.
        expect(html).toMatch(/not built/);
        expect(html).toContain("pnpm --filter @vtt/ui build");
      }
    },
    TEST_MS,
  );

  test(
    "a missing --ui-dir directory answers the build hint, not an error",
    async () => {
      const p = serve([file, "--port", "0", "--ui-dir", join(dir, "nope"), "--print-session"]);
      const s = await printed(p);
      const res = await fetch(new URL("/", s.http));
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/not built/);
    },
    TEST_MS,
  );
});

describe("vtt-serve --no-ui", () => {
  test(
    "GET / and the bundles are 404 while the asset routes still work; no Open line",
    async () => {
      const p = serve([file, "--port", "0", "--no-ui", "--print-session"]);
      const s = await printed(p);
      expect(s.http).toBe(`http://127.0.0.1:${new URL(s.url).port}/`);
      for (const path of ["/", "/index.html", "/ui-assets/app.js"]) {
        expect((await fetch(new URL(path, s.http))).status).toBe(404);
      }
      await assetRoundTrip(s.http, s.token);
      expect((await fetch(new URL("/healthz", s.http))).status).toBe(200);
      expect(p.stderr).not.toMatch(/Open http/);
    },
    TEST_MS,
  );

  test(
    "--no-ui with --ui-dir is a usage error",
    async () => {
      const p = serve([file, "--port", "0", "--no-ui", "--ui-dir", uiDir]);
      expect((await exitOf(p)).code).toBe(1);
      expect(p.stderr).toMatch(/--no-ui/);
      expect(p.stderr).toMatch(/usage: vtt-serve/);
      expect(p.stdout).toBe("");
    },
    TEST_MS,
  );

  test(
    "--ui-dir without a value is a usage error",
    async () => {
      const p = serve([file, "--port", "0", "--ui-dir"]);
      expect((await exitOf(p)).code).toBe(1);
      expect(p.stderr).toMatch(/usage: vtt-serve/);
    },
    TEST_MS,
  );
});
