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

/**
 * Returns `html` with every existing `vtt-session` script element removed and
 * exactly one inserted before the first `</head>`. The JSON has `<` escaped
 * as `\u003c`, so no token can close the element. Throws when `html` has no
 * `</head>`. Only `<script>` elements with that id are replaced; another
 * element carrying `id="vtt-session"` is left alone (the build has none,
 * PROTOCOL.md §2).
 */
export function injectSession(html: string, session: SessionCredentials): string {
  const json = JSON.stringify({ url: session.url, token: session.token }).replace(/</g, "\\u003c");
  const element = `<script id="vtt-session" type="application/json">${json}</script>`;
  const stripped = stripSessionScripts(html);
  const at = stripped.search(/<\/head\s*>/i);
  if (at < 0) throw new Error("injectSession: the page has no </head> to insert the session into");
  return stripped.slice(0, at) + element + stripped.slice(at);
}

const SESSION_ID = "vtt-session";

/** Whether `c` ends a tag name (`<script` must be followed by one of these to be a script tag). */
function endsTagName(c: string | undefined): boolean {
  return c === undefined || c === ">" || c === "/" || /\s/.test(c);
}

/**
 * Removes every `<script>` element whose start tag has an attribute named
 * exactly `id` (name case-insensitive, first occurrence wins as in HTML)
 * with the value `vtt-session`, through its `</script>` (or the end of the
 * page when unterminated). Start tags are scanned attribute by attribute,
 * honouring double-quoted, single-quoted and unquoted values, so a `>` inside
 * a quoted value does not end the tag and `data-id` is not `id`. Script
 * contents are skipped as raw text.
 */
function stripSessionScripts(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let kept = 0;
  let from = 0;
  for (;;) {
    let start = lower.indexOf("<script", from);
    while (start >= 0 && !endsTagName(lower[start + 7]))
      start = lower.indexOf("<script", start + 7);
    if (start < 0) break;
    const tag = scanStartTag(html, start + 7);
    if (tag === null) break; // an unterminated start tag: nothing more to find
    const end = scriptEnd(lower, tag.end);
    if (tag.attrs.get("id") === SESSION_ID) {
      out += html.slice(kept, start);
      kept = end;
    }
    from = end;
  }
  return out + html.slice(kept);
}

/** The index just past the `</script…>` that closes a script whose content starts at `from`. */
function scriptEnd(lower: string, from: number): number {
  let close = lower.indexOf("</script", from);
  while (close >= 0 && !endsTagName(lower[close + 8])) close = lower.indexOf("</script", close + 8);
  if (close < 0) return lower.length;
  const gt = lower.indexOf(">", close + 8);
  return gt < 0 ? lower.length : gt + 1;
}

/**
 * Scans a start tag's attributes from `i` (just after the tag name) to its
 * closing `>`; null when the page ends first. Attribute names are lowercased.
 */
function scanStartTag(html: string, i: number): { end: number; attrs: Map<string, string> } | null {
  const attrs = new Map<string, string>();
  const n = html.length;
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  for (;;) {
    while (i < n && (isSpace(html[i]) || html[i] === "/")) i++;
    if (i >= n) return null;
    if (html[i] === ">") return { end: i + 1, attrs };
    const nameStart = i;
    i++; // the first character is part of the name even when it is `=`
    while (i < n && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const name = html.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(html[i])) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && isSpace(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close < 0) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(html[i]) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    if (!attrs.has(name)) attrs.set(name, value);
  }
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
