/**
 * The table-image routes (PROTOCOL.md §1 HTTP routes; DESIGN.md §7,
 * Revisions and assets; M4-D1, M4-D3): `POST /assets` uploads an image
 * through `importAsset` and `GET /assets/<path>` serves a path listed in the
 * table's assets. Only the `/assets` namespace is handled; built UI bundles
 * are under `/ui-assets/` (http-ui.ts). The `Host` check runs in the server
 * before any handler (server.ts).
 */
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import {
  AssetImportError,
  type AssetImportErrorCode,
  importAsset,
  MAX_ASSET_BYTES,
} from "../host/assets";
import type { TableHost } from "../host/table-host";
import { tokensEqual } from "./connection";
import type { HttpHandler } from "./server";

export interface AssetHttpHandlerOptions {
  host: TableHost;
  /** The bearer token `POST /assets` requires; default: the serving server's session token. */
  token?: string;
}

const UPLOAD_PATH = "/assets";
const SERVE_PREFIX = "/assets/";

/** Content types by extension for served assets; any other extension is sent as octet-stream. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const STATUS_BY_CODE: Readonly<Record<AssetImportErrorCode, number>> = {
  in_memory: 409,
  too_large: 413,
  unsupported_type: 415,
};

/**
 * The asset route handler: `POST /assets` (bearer token compared in constant
 * time; body = the bytes; `X-Filename` and optional `X-Slug` URL-encoded) →
 * 201 `{"path"}`, or 401 bad token, 400 missing or malformed `X-Filename`/
 * `X-Slug`, 409 in-memory table, 413 too large, 415 unsupported type;
 * `GET /assets/<path>` → a listed asset's bytes with `Cache-Control:
 * no-store`, else 404. Other methods and paths fall through.
 */
export function createAssetHttpHandler(options: AssetHttpHandlerOptions): HttpHandler {
  const { host } = options;
  return async (req, res, ctx) => {
    const path = pathOf(req);
    if (req.method === "POST" && path === UPLOAD_PATH) {
      await upload(req, res, host, options.token ?? ctx.token);
      return true;
    }
    if (req.method === "GET" && path.startsWith(SERVE_PREFIX)) {
      await serve(res, host, path.slice(SERVE_PREFIX.length));
      return true;
    }
    return false;
  };
}

// Upload.

async function upload(
  req: IncomingMessage,
  res: ServerResponse,
  host: TableHost,
  token: string,
): Promise<void> {
  if (!authorized(req.headers.authorization, token)) {
    refuse(req, res, 401, "a valid bearer token is required");
    return;
  }
  if (host.path === null) {
    refuse(req, res, 409, "an in-memory table cannot store assets");
    return;
  }
  const filename = decodedHeader(req.headers["x-filename"]);
  const slugHeader = req.headers["x-slug"];
  const slug = slugHeader === undefined ? undefined : decodedHeader(slugHeader);
  if (filename === null || slug === null) {
    refuse(req, res, 400, "X-Filename (and X-Slug when present) must be one URL-encoded value");
    return;
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_ASSET_BYTES) {
    refuse(req, res, 413, `at most ${MAX_ASSET_BYTES} bytes are accepted`);
    return;
  }
  const bytes = await readBody(req, MAX_ASSET_BYTES);
  if (bytes === null) {
    reply(res, 413, { error: `at most ${MAX_ASSET_BYTES} bytes are accepted` });
    return;
  }
  try {
    const result = await importAsset(host, {
      bytes,
      filename,
      ...(slug === undefined ? {} : { slug }),
    });
    reply(res, 201, { path: result.path });
  } catch (err) {
    if (!(err instanceof AssetImportError)) throw err;
    reply(res, STATUS_BY_CODE[err.code], { error: err.message });
  }
}

/** Whether `header` is exactly `Bearer <token>`, compared in constant time. */
function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  return tokensEqual(header.slice("Bearer ".length), token);
}

/** A single URL-encoded header value, decoded; null when missing, repeated or malformed. */
function decodedHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * The request body, or null once it exceeds `limit` (the rest is then read
 * and discarded so the response can be delivered).
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}

/** Answers before reading the body, then discards the body so the client can read the answer. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  reply(res, status, { error });
  req.resume();
}

function reply(res: ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

// Serving.

async function serve(res: ServerResponse, host: TableHost, rest: string): Promise<void> {
  const file = await listedFile(host, rest);
  const bytes = file === null ? null : await readIfExists(file);
  if (file === null || bytes === null) {
    res.writeHead(404, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.end(bytes);
}

/**
 * The real path of the asset `rest` (the raw, still percent-encoded URL path
 * below `/assets/`) names, or null. The request's segments must decode, be
 * non-empty, not be `.` or `..`, and not contain `/`, `\` or NUL; joined
 * with `/` they must equal one of the host's listed paths after that path's
 * normalization (`listedKey`). The file must be a regular file whose real
 * path (symlinks resolved) is inside the table's real directory.
 */
async function listedFile(host: TableHost, rest: string): Promise<string | null> {
  if (host.path === null) return null;
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" || segment === "." || segment === ".." || /[/\\\0]/.test(segment)) {
      return null;
    }
    segments.push(segment);
  }
  const key = segments.join("/");
  if (!host.assets.some((listed) => listedKey(listed) === key)) return null;
  try {
    const root = await realpath(dirname(host.path));
    const file = await realpath(join(root, ...segments));
    if (!file.startsWith(root + sep)) return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * A listed asset path as the request key it may be served under: `/`
 * separated, with empty and `.` segments dropped; null (never served) when it
 * is absolute (a leading `/` or a drive letter), has a `..` segment, or
 * contains `\` or NUL.
 */
function listedKey(listed: string): string | null {
  if (/[\\\0]/.test(listed) || /^(\/|[A-Za-z]:)/.test(listed)) return null;
  const segments = listed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments.join("/");
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
