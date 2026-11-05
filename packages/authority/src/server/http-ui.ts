/**
 * Serving the built UI (DESIGN.md §7 Platform; PROTOCOL.md §1 HTTP routes,
 * §2 Session bootstrap; M4-D1): `GET /` and `/index.html` answer the build's
 * `index.html` with exactly one injected `vtt-session` element and
 * `Cache-Control: no-store`; `GET /ui-assets/<path>` answers the build's
 * bundles from `<uiDir>/ui-assets/`. Everything else, including the
 * table-image namespace `/assets/` (vtt-3l6.16), is left to later handlers.
 * The `Host` check runs in the server before any handler (server.ts).
 */
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { HttpHandler } from "./server";

/** The credentials the session bootstrap element carries (PROTOCOL.md §2). */
export interface SessionCredentials {
  url: string;
  token: string;
}

/** Matches every `<script … id="vtt-session" …>…</script>` element, any case or quoting. */
const SESSION_ELEMENT_RE =
  /<script\b[^>]*\bid\s*=\s*(?:"vtt-session"|'vtt-session'|vtt-session(?=[\s>]))[^>]*>[\s\S]*?<\/script\s*>/gi;

/**
 * Returns `html` with every existing `vtt-session` element removed and
 * exactly one inserted before the first `</head>`. The JSON has `<` escaped
 * as `<`, so no token can close the element. Throws when `html` has no
 * `</head>`.
 */
export function injectSession(html: string, session: SessionCredentials): string {
  const json = JSON.stringify({ url: session.url, token: session.token }).replace(/</g, "\\u003c");
  const element = `<script id="vtt-session" type="application/json">${json}</script>`;
  const stripped = html.replace(SESSION_ELEMENT_RE, "");
  const at = stripped.search(/<\/head\s*>/i);
  if (at < 0) throw new Error("injectSession: the page has no </head> to insert the session into");
  return stripped.slice(0, at) + element + stripped.slice(at);
}

export interface UiHttpHandlerOptions {
  /** The UI build directory (holding `index.html` and `ui-assets/`), or null when there is none. */
  uiDir: string | null;
  /** The injected `url`; default: the serving server's (`ws://127.0.0.1:<port>/ws`). */
  url?: string;
  /** The injected `token`; default: the serving server's. */
  token?: string;
}

/** The build's bundle directory under `uiDir` and its URL prefix (vtt-3l6.15's `build.assetsDir`). */
const BUNDLE_DIR = "ui-assets";
const BUNDLE_PREFIX = `/${BUNDLE_DIR}/`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const BUILD_HINT = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>vtt: no UI build</title></head>
  <body>
    <h1>The UI is not built</h1>
    <p>Run <code>pnpm --filter @vtt/ui build</code>, then reload this page.</p>
  </body>
</html>
`;

/**
 * The UI route handler: `GET /`, `GET /index.html` and `GET /ui-assets/<path>`
 * (PROTOCOL.md §1). With `uiDir` null or no `index.html` in it, `GET /`
 * answers a page saying how to build the UI.
 */
export function createUiHttpHandler(options: UiHttpHandlerOptions): HttpHandler {
  const uiDir = options.uiDir === null ? null : resolve(options.uiDir);
  return async (req, res, ctx) => {
    if (req.method !== "GET") return false;
    const path = pathOf(req);
    if (path === "/" || path === "/index.html") {
      await serveIndex(res, uiDir, {
        url: options.url ?? ctx.url,
        token: options.token ?? ctx.token,
      });
      return true;
    }
    if (path.startsWith(BUNDLE_PREFIX)) {
      await serveBundle(res, uiDir, path.slice(BUNDLE_PREFIX.length));
      return true;
    }
    return false;
  };
}

async function serveIndex(
  res: ServerResponse,
  uiDir: string | null,
  session: SessionCredentials,
): Promise<void> {
  const html = uiDir === null ? null : await readIfExists(join(uiDir, "index.html"));
  const body = html === null ? BUILD_HINT : injectSession(html.toString("utf8"), session);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function serveBundle(res: ServerResponse, uiDir: string | null, rest: string): Promise<void> {
  const file = uiDir === null ? null : await bundleFile(join(uiDir, BUNDLE_DIR), rest);
  const bytes = file === null ? null : await readIfExists(file);
  if (file === null || bytes === null) {
    res.writeHead(404, { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": bytes.length,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(bytes);
}

/**
 * The real path of the regular file `rest` (the raw, still percent-encoded
 * URL path below `/ui-assets/`) names inside `bundleDir`, or null. Refuses
 * undecodable segments, empty segments, segments starting with `.` (dotfiles,
 * `.` and `..`), segments that decode to a separator or NUL, and any file
 * whose real path (symlinks resolved) is not inside the real `bundleDir`.
 */
async function bundleFile(bundleDir: string, rest: string): Promise<string | null> {
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" || segment.startsWith(".") || /[/\\\0]/.test(segment)) return null;
    segments.push(segment);
  }
  try {
    const root = await realpath(bundleDir);
    const file = await realpath(join(root, ...segments));
    if (!file.startsWith(root + sep)) return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** `file`'s bytes, or null when it does not exist (or is a directory). */
async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw err;
  }
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}
