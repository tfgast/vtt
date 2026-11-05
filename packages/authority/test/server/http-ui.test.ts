/** Static UI serving with the injected session element (PROTOCOL.md §1, §2; vtt-3l6.14). */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiHttpHandler, injectSession } from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, serve } from "./helpers";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw GET (paths are sent verbatim, so traversal attempts reach the server unnormalized). */
function get(port: number, path: string, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const SESSION_RE = /<script\b[^>]*\bid="vtt-session"[^>]*>([\s\S]*?)<\/script>/g;

/** Every session element's JSON payload in `html`. */
function sessions(html: string): unknown[] {
  return [...html.matchAll(SESSION_RE)].map((m) => JSON.parse(m[1] ?? ""));
}

const INDEX = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>vtt</title>
    <script type="module" src="/ui-assets/app.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

let root: string;
let dist: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vtt-http-ui-"));
  dist = join(root, "dist");
  mkdirSync(join(dist, "ui-assets", "fonts"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "app.js"), "// outside the bundle directory\n");
  writeFileSync(join(dist, ".env"), "SECRET=1\n");
  writeFileSync(join(dist, "ui-assets", "app.js"), "console.log('app');\n");
  writeFileSync(join(dist, "ui-assets", "app.css"), "body{}\n");
  writeFileSync(join(dist, "ui-assets", "app.js.map"), "{}\n");
  writeFileSync(join(dist, "ui-assets", "icon.svg"), "<svg/>\n");
  writeFileSync(join(dist, "ui-assets", "fonts", "a b.woff2"), "font\n");
  writeFileSync(join(dist, "ui-assets", ".hidden.js"), "hidden\n");
  mkdirSync(join(dist, "ui-assets", ".git"));
  writeFileSync(join(dist, "ui-assets", ".git", "config"), "git\n");
  writeFileSync(join(root, "secret"), "top secret\n");
  symlinkSync(join(root, "secret"), join(dist, "ui-assets", "link.js"));
});

afterEach(async () => {
  await cleanup();
  rmSync(root, { recursive: true, force: true });
});

/** A server with the UI handler on `uiDir`, using the server's own url and token. */
async function serveUi(uiDir: string | null = dist, token = "tok-123") {
  const { server } = await serve({ token, http: [createUiHttpHandler({ uiDir })] });
  return server;
}

describe("injectSession", () => {
  const session = { url: "ws://127.0.0.1:4747/ws", token: "abc" };

  test("inserts exactly one element just before </head>", () => {
    const out = injectSession(INDEX, session);
    expect(sessions(out)).toEqual([session]);
    expect(out).toContain(
      `<script id="vtt-session" type="application/json">{"url":"ws://127.0.0.1:4747/ws","token":"abc"}</script></head>`,
    );
    expect(out.replace(/<script id="vtt-session"[^]*?<\/script>/, "")).toBe(INDEX);
  });

  test("replaces stale elements", () => {
    const stale = INDEX.replace(
      "</head>",
      `<script id="vtt-session" type="application/json">{"url":"ws://old/ws","token":"old"}</script>\n<SCRIPT type="application/json" id='vtt-session'>{"token":"older"}</SCRIPT >\n</head>`,
    );
    const out = injectSession(stale, session);
    expect(sessions(out)).toEqual([session]);
    expect(out).not.toContain("old");
    expect(out.toLowerCase().match(/vtt-session/g)).toHaveLength(1);
  });

  test("escapes < so a token cannot close the element", () => {
    const token = "</script><script>alert(1)</script><!--";
    const out = injectSession(INDEX, { url: session.url, token });
    expect(out.match(/<\/script>/g)).toHaveLength(2); // the app script and the session element
    expect(out).not.toContain("<script>alert");
    expect(out).toContain("\\u003c/script>");
    expect(sessions(out)).toEqual([{ url: session.url, token }]);
  });

  test("replacement patterns in the token are inserted literally", () => {
    const token = "$&$'$`$1";
    expect(sessions(injectSession(INDEX, { url: session.url, token }))).toEqual([
      { url: session.url, token },
    ]);
  });

  test("a page without </head> is refused", () => {
    expect(() => injectSession("<html><body></body></html>", session)).toThrow(/<\/head>/);
  });
});

describe("GET / and /index.html", () => {
  test("serve index.html with exactly one session element, the current token and url, no-store", async () => {
    const server = await serveUi();
    for (const path of ["/", "/index.html", "/?x=1"]) {
      const res = await get(server.port, path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/html/);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(sessions(res.body)).toEqual([{ url: server.url, token: "tok-123" }]);
      expect(res.body).toContain(`src="/ui-assets/app.js"`);
    }
  });

  test("a stale vtt-session element on disk is replaced, not duplicated", async () => {
    writeFileSync(
      join(dist, "index.html"),
      INDEX.replace(
        "</head>",
        `<script id="vtt-session" type="application/json">{"url":"ws://127.0.0.1:1/ws","token":"stale"}</script></head>`,
      ),
    );
    const server = await serveUi();
    const res = await get(server.port, "/");
    expect(sessions(res.body)).toEqual([{ url: server.url, token: "tok-123" }]);
    expect(res.body).not.toContain("stale");
  });

  test("the page is read per request, so a rebuild shows without a restart", async () => {
    const server = await serveUi();
    writeFileSync(
      join(dist, "index.html"),
      INDEX.replace("<title>vtt</title>", "<title>v2</title>"),
    );
    expect((await get(server.port, "/")).body).toContain("<title>v2</title>");
  });

  test("explicit url and token options win over the server's", async () => {
    const { server } = await serve({
      http: [createUiHttpHandler({ uiDir: dist, url: "ws://127.0.0.1:9/ws", token: "explicit" })],
    });
    const res = await get(server.port, "/");
    expect(sessions(res.body)).toEqual([{ url: "ws://127.0.0.1:9/ws", token: "explicit" }]);
  });

  test("without index.html, or with uiDir null, / gives the build hint page", async () => {
    rmSync(join(dist, "index.html"));
    for (const uiDir of [dist, null, join(root, "missing")]) {
      await cleanup();
      const server = await serveUi(uiDir);
      for (const path of ["/", "/index.html"]) {
        const res = await get(server.port, path);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/^text\/html/);
        expect(res.body).toContain("pnpm --filter @vtt/ui build");
        expect(res.body).not.toContain("tok-123");
      }
      expect((await get(server.port, "/ui-assets/app.js")).status).toBe(404);
    }
  });

  test("only GET is handled", async () => {
    const server = await serveUi();
    expect((await get(server.port, "/", "POST")).status).toBe(404);
    expect((await get(server.port, "/ui-assets/app.js", "POST")).status).toBe(404);
  });
});

describe("GET /ui-assets/", () => {
  test("serves bundles with content type by extension and nosniff", async () => {
    const server = await serveUi();
    const cases: [string, RegExp, string][] = [
      ["/ui-assets/app.js", /^text\/javascript/, "console.log('app');\n"],
      ["/ui-assets/app.css", /^text\/css/, "body{}\n"],
      ["/ui-assets/app.js.map", /^application\/json/, "{}\n"],
      ["/ui-assets/icon.svg", /^image\/svg\+xml/, "<svg/>\n"],
      ["/ui-assets/fonts/a%20b.woff2", /^font\/woff2/, "font\n"],
      ["/ui-assets/app.js?v=1", /^text\/javascript/, "console.log('app');\n"],
    ];
    for (const [path, type, body] of cases) {
      const res = await get(server.port, path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"], path).toMatch(type);
      expect(res.headers["x-content-type-options"], path).toBe("nosniff");
      expect(res.body, path).toBe(body);
    }
  });

  test("paths outside /ui-assets/ are not handled", async () => {
    const server = await serveUi();
    for (const path of ["/app.js", "/assets/app.js", "/assets/ui-assets/app.js", "/ui-assets"]) {
      expect((await get(server.port, path)).status, path).toBe(404);
    }
  });

  test("the UI handler leaves /assets/ to later handlers", async () => {
    const { server } = await serve({
      http: [
        createUiHttpHandler({ uiDir: dist }),
        (req, res) => {
          if (!req.url?.startsWith("/assets/")) return false;
          res.end("asset handler");
          return true;
        },
      ],
    });
    expect((await get(server.port, "/assets/app.js")).body).toBe("asset handler");
  });

  test("traversal, encoded traversal, dotfiles, directories and symlinks out are 404", async () => {
    const server = await serveUi();
    for (const path of [
      "/../secret",
      "/../../secret",
      "/%2e%2e/secret",
      "/ui-assets/../index.html",
      "/ui-assets/../../secret",
      "/ui-assets/%2e%2e/index.html",
      "/ui-assets/%2E%2E/%2E%2E/secret",
      "/ui-assets/..%2findex.html",
      "/ui-assets/..%2F..%2Fsecret",
      "/ui-assets/..%5cindex.html",
      "/ui-assets/%2e%2e%5c%2e%2e%5csecret",
      "/ui-assets/fonts/../../index.html",
      "/ui-assets/./app.js",
      "/ui-assets//app.js",
      "/ui-assets/%2fetc%2fpasswd",
      "/ui-assets/app.js%00.css",
      "/ui-assets/%E0%A4%A",
      "/.env",
      "/ui-assets/.hidden.js",
      "/ui-assets/.git/config",
      "/ui-assets/%2egit/config",
      "/ui-assets/",
      "/ui-assets/fonts",
      "/ui-assets/fonts/",
      "/ui-assets/missing.js",
      "/ui-assets/link.js",
    ]) {
      const res = await get(server.port, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain("top secret");
      expect(res.body, path).not.toContain("SECRET");
      expect(res.body, path).not.toContain("<html");
    }
  });
});
