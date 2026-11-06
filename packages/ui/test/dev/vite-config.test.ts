// @vitest-environment node
/**
 * The UI's Vite config (vtt-3l6.15; PROTOCOL.md §1 HTTP routes, §2 Session
 * bootstrap; M4-D1): bundles live under `/ui-assets/`; the `vttSession()`
 * plugin injects the session element on the dev server only (never into a
 * `vite build`); the dev server proxies `/assets` to the authority with
 * `changeOrigin: true`. Also the real-build acceptance: the real UI is built
 * and served by `vtt-serve --ui-dir` with both route handlers installed.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssetHttpHandler,
  type RunningServer,
  sessionFilePath,
  startServer,
  TableHost,
  writeSessionFile,
} from "@vtt/authority";
import {
  build,
  createServer,
  type IndexHtmlTransformHook,
  type Plugin,
  type UserConfig,
  type UserConfigFnObject,
  type ViteDevServer,
} from "vite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import config, { vttSession } from "../../vite.config";

const UI = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CONFIG_FILE = join(UI, "vite.config.ts");
const AUTHORITY = join(ROOT, "packages", "authority");
const SERVE_BIN = join(AUTHORITY, "src", "bin", "serve.ts");

/** Generous bounds: the CI runner is slow, and builds and tsx start-up take seconds. */
const READY_MS = 30_000;
const TEST_MS = 120_000;

const PAGE = `<!doctype html>
<html>
  <head><title>page</title></head>
  <body><div id="root"></div></body>
</html>
`;

const FILE_SESSION = { url: "ws://127.0.0.1:4801/ws", token: "file-token-AAAA" };
const ENV_SESSION = { url: "ws://127.0.0.1:4802/ws", token: "env-token-BBBB" };

const png = (fill = "pixels"): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(fill)]);

const sessionElements = (html: string): string[] =>
  html.match(/<script id="vtt-session" type="application\/json">[^<]*<\/script>/g) ?? [];

const sessionOf = (html: string): unknown => {
  const elements = sessionElements(html);
  expect(elements).toHaveLength(1);
  return JSON.parse(
    (elements[0] as string).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""),
  );
};

/** Writes a session file for `session` under `xdg` (vtt-5su.14's format). */
function writeSession(xdg: string, session: { url: string; token: string }): void {
  writeSessionFile(
    { ...session, pid: process.pid, table_path: "/tmp/t.table.json", table_id: "id-1" },
    sessionFilePath({ XDG_CONFIG_HOME: xdg }),
  );
}

/** Runs the plugin's `transformIndexHtml` on `html`. */
async function transform(plugin: Plugin, html: string): Promise<string> {
  const hook = plugin.transformIndexHtml;
  expect(hook).toBeDefined();
  const fn = (typeof hook === "function" ? hook : (hook as { handler: unknown }).handler) as
    | IndexHtmlTransformHook
    | undefined;
  if (fn === undefined) throw new Error("no transformIndexHtml handler");
  const out = await fn.call({} as never, html, { path: "/index.html", filename: "index.html" });
  if (typeof out !== "string") throw new Error("expected the transform to return a string");
  return out;
}

/** The config the dev server gets (`vite`, `vite dev`). */
async function serveConfig(): Promise<UserConfig> {
  expect(typeof config).toBe("function");
  return await (config as UserConfigFnObject)({ command: "serve", mode: "development" });
}

/** Runs `fn` with `process.env` patched (undefined deletes), then restores it. */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(patch);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

/** Every file under `root`, as `/`-separated paths relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort();
}

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-vite-config-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("vttSession()", () => {
  test("applies to the dev server only", () => {
    const plugin = vttSession({});
    expect(plugin.name).toBe("vtt-session");
    expect(plugin.apply).toBe("serve");
  });

  test("injects the session from the discovery file under XDG_CONFIG_HOME", async () => {
    writeSession(dir, FILE_SESSION);
    const html = await transform(vttSession({ XDG_CONFIG_HOME: dir }), PAGE);
    expect(sessionOf(html)).toEqual(FILE_SESSION);
    expect(html.indexOf("vtt-session")).toBeLessThan(html.indexOf("</head>"));
  });

  test("prefers VTT_URL/VTT_TOKEN over the discovery file", async () => {
    writeSession(dir, FILE_SESSION);
    const html = await transform(
      vttSession({ XDG_CONFIG_HOME: dir, VTT_URL: ENV_SESSION.url, VTT_TOKEN: ENV_SESSION.token }),
      PAGE,
    );
    expect(sessionOf(html)).toEqual(ENV_SESSION);
    expect(html).not.toContain(FILE_SESSION.token);
  });

  test("uses VTT_URL/VTT_TOKEN without any discovery file", async () => {
    const html = await transform(
      vttSession({ XDG_CONFIG_HOME: dir, VTT_URL: ENV_SESSION.url, VTT_TOKEN: ENV_SESSION.token }),
      PAGE,
    );
    expect(sessionOf(html)).toEqual(ENV_SESSION);
  });

  test("falls back to the discovery file when only one of VTT_URL/VTT_TOKEN is set", async () => {
    writeSession(dir, FILE_SESSION);
    for (const env of [{ VTT_URL: ENV_SESSION.url }, { VTT_TOKEN: ENV_SESSION.token }]) {
      const html = await transform(vttSession({ XDG_CONFIG_HOME: dir, ...env }), PAGE);
      expect(sessionOf(html)).toEqual(FILE_SESSION);
    }
  });

  test("injects nothing without either (the UI then shows its start screen)", async () => {
    const html = await transform(vttSession({ XDG_CONFIG_HOME: dir }), PAGE);
    expect(html).toBe(PAGE);
    expect(html).not.toContain("vtt-session");
  });

  test("re-reads the discovery file on every page load (an authority restart rotates the token)", async () => {
    const plugin = vttSession({ XDG_CONFIG_HOME: dir });
    writeSession(dir, FILE_SESSION);
    expect(sessionOf(await transform(plugin, PAGE))).toEqual(FILE_SESSION);
    writeSession(dir, { ...FILE_SESSION, token: "rotated-token" });
    expect(sessionOf(await transform(plugin, PAGE))).toEqual({
      ...FILE_SESSION,
      token: "rotated-token",
    });
  });

  test("replaces a stale session element rather than adding a second one", async () => {
    writeSession(dir, FILE_SESSION);
    const stale = PAGE.replace(
      "</head>",
      '<script id="vtt-session" type="application/json">{"url":"x","token":"old"}</script></head>',
    );
    const html = await transform(vttSession({ XDG_CONFIG_HOME: dir }), stale);
    expect(sessionOf(html)).toEqual(FILE_SESSION);
    expect(html).not.toContain('"old"');
  });
});

describe("vite.config.ts", () => {
  test("puts built bundles under ui-assets/ and installs the session plugin", async () => {
    const resolved = await withEnv(
      { XDG_CONFIG_HOME: dir, VTT_URL: undefined, VTT_TOKEN: undefined },
      serveConfig,
    );
    expect(resolved.build?.assetsDir).toBe("ui-assets");
    const flat: unknown[] = (resolved.plugins ?? []) as unknown[];
    const names = flat
      .flat(4)
      .map((p) => (p !== null && typeof p === "object" && "name" in p ? p.name : null));
    expect(names).toContain("vtt-session");
  });

  test("proxies /assets with changeOrigin to the http origin of VTT_URL", async () => {
    writeSession(dir, FILE_SESSION);
    const resolved = await withEnv(
      { XDG_CONFIG_HOME: dir, VTT_URL: ENV_SESSION.url, VTT_TOKEN: ENV_SESSION.token },
      serveConfig,
    );
    expect(resolved.server?.proxy?.["/assets"]).toMatchObject({
      target: "http://127.0.0.1:4802",
      changeOrigin: true,
    });
  });

  test("proxies /assets to the discovery file's authority when VTT_URL/VTT_TOKEN are unset", async () => {
    writeSession(dir, FILE_SESSION);
    const resolved = await withEnv(
      { XDG_CONFIG_HOME: dir, VTT_URL: undefined, VTT_TOKEN: undefined },
      serveConfig,
    );
    expect(resolved.server?.proxy?.["/assets"]).toMatchObject({
      target: "http://127.0.0.1:4801",
      changeOrigin: true,
    });
  });

  test("the dev and build scripts load the config with the module runner (M6-D41)", async () => {
    const pkg = JSON.parse(await readFile(join(UI, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.dev).toBe("vite --configLoader runner");
    expect(pkg.scripts.build).toBe("vite build --configLoader runner");
  });

  test("proxies /assets to the default port 4747 without any session", async () => {
    const resolved = await withEnv(
      { XDG_CONFIG_HOME: dir, VTT_URL: undefined, VTT_TOKEN: undefined },
      serveConfig,
    );
    expect(resolved.server?.proxy?.["/assets"]).toMatchObject({
      target: "http://127.0.0.1:4747",
      changeOrigin: true,
    });
  });
});

// The real build, shared by the build test and the serving acceptance.
describe("the real UI build", () => {
  let buildDir: string;
  let outDir: string;
  const procs: { child: ChildProcess; exited: Promise<unknown> }[] = [];

  beforeAll(async () => {
    buildDir = await realpath(await mkdtemp(join(tmpdir(), "vtt-ui-build-")));
    outDir = join(buildDir, "dist");
    const xdg = join(buildDir, "config");
    await mkdir(xdg, { recursive: true });
    writeSession(xdg, FILE_SESSION);
    await withEnv(
      { XDG_CONFIG_HOME: xdg, VTT_URL: ENV_SESSION.url, VTT_TOKEN: ENV_SESSION.token },
      () =>
        build({
          root: UI,
          configFile: CONFIG_FILE,
          configLoader: "runner",
          mode: "production",
          logLevel: "silent",
          build: { outDir, emptyOutDir: true },
        }),
    );
  }, TEST_MS);

  afterEach(async () => {
    await Promise.all(
      procs.splice(0).map(async (p) => {
        if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
        await p.exited;
      }),
    );
  });

  afterAll(async () => {
    await rm(buildDir, { recursive: true, force: true });
  });

  test("index.html has no session element and no token; every bundle is under ui-assets/", async () => {
    const html = await readFile(join(outDir, "index.html"), "utf8");
    expect(html).not.toContain("vtt-session");
    expect(html).not.toContain(ENV_SESSION.token);
    expect(html).not.toContain(FILE_SESSION.token);
    const files = await filesUnder(outDir);
    expect(files).toContain("index.html");
    const bundles = files.filter((f) => f !== "index.html");
    expect(bundles.length).toBeGreaterThan(0);
    for (const f of bundles) expect(f.startsWith("ui-assets/")).toBe(true);
    // No token in any emitted file either.
    for (const f of files) {
      const text = await readFile(join(outDir, f), "utf8");
      expect(text).not.toContain(ENV_SESSION.token);
      expect(text).not.toContain(FILE_SESSION.token);
    }
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref.startsWith("/ui-assets/")).toBe(true);
  });

  test(
    "vtt-serve --ui-dir serves it: one session element with the current token, every reference 200",
    async () => {
      const xdg = join(buildDir, "serve-config");
      const table = join(buildDir, "crypt.table.json");
      const child = spawn(
        process.execPath,
        ["--import", "tsx", SERVE_BIN, table, "--port", "0", "--ui-dir", outDir, "--print-session"],
        {
          cwd: AUTHORITY,
          env: { ...process.env, XDG_CONFIG_HOME: xdg },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = new Promise((resolve) => child.on("exit", resolve));
      procs.push({ child, exited });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (s: string) => {
        stdout += s;
      });
      child.stderr?.setEncoding("utf8").on("data", (s: string) => {
        stderr += s;
      });
      const end = Date.now() + READY_MS;
      while (!stdout.includes("\n")) {
        if (child.exitCode !== null) throw new Error(`vtt-serve exited:\n${stderr}`);
        if (Date.now() > end) throw new Error(`vtt-serve did not start:\n${stderr}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      const s = JSON.parse(stdout.trim()) as { url: string; token: string; http: string };

      for (const path of ["/", "/index.html"]) {
        const res = await fetch(new URL(path, s.http));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html.match(/vtt-session/g)).toHaveLength(1);
        expect(sessionOf(html)).toEqual({ url: s.url, token: s.token });

        const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
          const got = await fetch(new URL(ref, s.http));
          expect(got.status, ref).toBe(200);
          const type = got.headers.get("content-type");
          if (ref.endsWith(".js")) expect(type, ref).toBe("text/javascript; charset=utf-8");
          else if (ref.endsWith(".css")) expect(type, ref).toBe("text/css; charset=utf-8");
          else expect(type, ref).not.toBe("application/octet-stream");
          const body = Buffer.from(await got.arrayBuffer());
          const onDisk = await readFile(join(outDir, ...new URL(ref, s.http).pathname.split("/")));
          expect(body.equals(onDisk), ref).toBe(true);
        }
      }

      // The asset handler is installed beside the UI handler.
      const bytes = png("real-build");
      const posted = await fetch(new URL("/assets", s.http), {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}`, "x-filename": "map.png" },
        body: new Uint8Array(bytes),
      });
      expect(posted.status).toBe(201);
      const { path } = (await posted.json()) as { path: string };
      const got = await fetch(new URL(`/assets/${path}`, s.http));
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);
    },
    TEST_MS,
  );
});

describe("the dev server's /assets proxy", () => {
  let host: TableHost | null = null;
  let authority: RunningServer | null = null;
  let vite: ViteDevServer | null = null;

  afterEach(async () => {
    await vite?.close();
    vite = null;
    await authority?.close();
    authority = null;
    await host?.close();
    host = null;
  });

  /** A raw request (fetch cannot set `Host`). */
  function raw(
    port: number,
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  test(
    "an upload and a download go through the Vite server to a Host-guarded authority",
    async () => {
      host = await TableHost.open(join(dir, "crypt.table.json"), { createIfMissing: true });
      authority = await startServer({ host, port: 0, http: [createAssetHttpHandler({ host })] });
      // The plugin reads the environment on every page load, the proxy when the config loads.
      const env = {
        XDG_CONFIG_HOME: join(dir, "config"),
        VTT_URL: authority.url,
        VTT_TOKEN: authority.token,
      };
      vite = await withEnv(env, async () => {
        const server = await createServer({
          root: UI,
          configFile: CONFIG_FILE,
          configLoader: "runner",
          logLevel: "silent",
          server: { port: 0, host: "127.0.0.1", strictPort: true, hmr: false, ws: false },
        });
        await server.listen();
        return server;
      });
      const address = vite.httpServer?.address();
      if (typeof address !== "object" || address === null) throw new Error("no Vite address");
      const vitePort = address.port;
      expect(vitePort).not.toBe(authority.port);
      const viteBase = `http://127.0.0.1:${vitePort}`;

      const bytes = png("through-the-proxy");
      const posted = await fetch(`${viteBase}/assets`, {
        method: "POST",
        headers: { authorization: `Bearer ${authority.token}`, "x-filename": "map.png" },
        body: new Uint8Array(bytes),
      });
      expect(posted.status).toBe(201);
      const { path } = (await posted.json()) as { path: string };
      expect(path).toMatch(/^crypt\.table\.json\.assets\/map-[0-9a-f]{8}\.png$/);

      const got = await fetch(`${viteBase}/assets/${path}`);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);

      // Without changeOrigin the authority would see the Vite server's Host: 421.
      const misdirected = await raw(authority.port, `/assets/${path}`, {
        host: `localhost:${vitePort}`,
      });
      expect(misdirected.status).toBe(421);
      const direct = await raw(authority.port, `/assets/${path}`, {
        host: `127.0.0.1:${authority.port}`,
      });
      expect(direct.status).toBe(200);
      expect(direct.body.equals(bytes)).toBe(true);

      // The dev page carries the session of the authority it proxies to.
      const page = await withEnv(env, async () => {
        const res = await fetch(`${viteBase}/`);
        return { status: res.status, html: await res.text() };
      });
      expect(page.status).toBe(200);
      expect(sessionOf(page.html)).toEqual({
        url: authority.url,
        token: authority.token,
      });
    },
    TEST_MS,
  );
});
