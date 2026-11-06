/**
 * The MCP tool `import_asset` (PROTOCOL.md §1 `POST /assets`, §11; DESIGN.md
 * §5.2, §7 Revisions and assets; M4-D3): the MCP process reads a local image
 * file, checks it with the rules of `POST /assets` (PNG, JPEG, WebP or GIF by
 * magic bytes, at most MAX_ASSET_BYTES) before sending, and POSTs it to the
 * authority's HTTP origin (the connection's WebSocket URL with `http:`, same
 * host and port) with the connection's current bearer token. Registered
 * through the connection gate; added to `createMcpServer` as an extension:
 * `createMcpServer({client, extensions: [importAssetTool()]})`.
 *
 * The credentials default to `ProtocolClient.credentials`, the pair the
 * connection uses, which follows every discovery refresh recovery hands to
 * `reopen`.
 */
import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assetTypeOf, MAX_ASSET_BYTES } from "../host/assets";
import { toolError, toolResult, withConnection } from "./gate";
import type { McpExtension } from "./server";

/** A WebSocket URL and the session token it is opened with. */
export interface AssetCredentials {
  url: string;
  token: string;
}

export interface ImportAssetToolOptions {
  /**
   * The connection's current credentials, read at every call; default: the
   * client's `credentials` getter.
   */
  credentials?: () => AssetCredentials;
  /** The directory a relative `path` resolves against; default `process.cwd()`. */
  cwd?: string;
  /** Reads a regular file's bytes; default: `fs` (a seam for tests). */
  readFile?: (file: string) => Promise<Uint8Array<ArrayBuffer>>;
}

async function readWholeFile(file: string): Promise<Uint8Array<ArrayBuffer>> {
  const handle = await open(file, "r");
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export const ImportAssetInputSchema = z.strictObject({
  path: z.string(),
  slug: z.string().optional(),
});

export type ImportAssetToolInput = z.infer<typeof ImportAssetInputSchema>;

export const IMPORT_ASSET_DESCRIPTION =
  "Uploads a local image file (PNG, JPEG, WebP or GIF, at most 50 MiB; no SVG) into the table's assets and returns its `path`. `path` is absolute or relative to this MCP process's working directory; `slug` names the stored file (default: the file name's stem). The returned path goes into an object's `image` cell: write it with transact (e.g. `set_value` of `image` to `{type: \"text\", value: <path>}`, or in a `create_object`'s cells).";

/** The `isError` codes the tool answers besides the connection gate's. */
export type ImportAssetErrorCode =
  | "file_missing"
  | "file_unreadable"
  | "unsupported_type"
  | "too_large"
  | "unauthorized"
  | "in_memory"
  | "upload_failed";

const fail = (
  code: ImportAssetErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult => toolError({ code, message, ...extra });

/** HTTP statuses of `POST /assets` mapped to error codes (PROTOCOL.md §1). */
const CODE_BY_STATUS: Readonly<Record<number, ImportAssetErrorCode>> = {
  401: "unauthorized",
  409: "in_memory",
  413: "too_large",
  415: "unsupported_type",
};

const MESSAGE_BY_STATUS: Readonly<Record<number, string>> = {
  401: "the authority refused the session token",
  409: "the table is in memory (not saved to a file), so it cannot store assets",
  413: `the authority refused the file as too large (at most ${MAX_ASSET_BYTES} bytes)`,
  415: "the authority refused the file type (PNG, JPEG, WebP or GIF only)",
};

/** `POST /assets` at the HTTP origin of WebSocket URL `wsUrl` (same host and port). */
export function assetUploadUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/assets";
  url.search = "";
  url.hash = "";
  return url.toString();
}

type ReadOutcome = { bytes: Uint8Array<ArrayBuffer> } | { error: CallToolResult };

/** Reads `file`, refusing a missing, unreadable, oversize or non-image file before sending anything. */
async function readImage(
  file: string,
  readFile: (file: string) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<ReadOutcome> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return { error: fail("file_unreadable", `${file} is not a regular file`) };
    size = info.size;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { error: fail("file_missing", `no file at ${file}`) };
    }
    return { error: fail("file_unreadable", `cannot read ${file}: ${(e as Error).message}`) };
  }
  if (size > MAX_ASSET_BYTES) return { error: tooLarge(file, size) };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readFile(file);
  } catch (e) {
    return { error: fail("file_unreadable", `cannot read ${file}: ${(e as Error).message}`) };
  }
  // The file may have grown since `stat`.
  if (bytes.length > MAX_ASSET_BYTES) return { error: tooLarge(file, bytes.length) };
  if (assetTypeOf(bytes) === null) {
    return {
      error: fail(
        "unsupported_type",
        `${file} is not a PNG, JPEG, WebP or GIF image (recognised by its magic bytes; SVG is not accepted)`,
      ),
    };
  }
  return { bytes };
}

const tooLarge = (file: string, size: number): CallToolResult =>
  fail("too_large", `${file} is ${size} bytes; at most ${MAX_ASSET_BYTES} are accepted`, {
    size,
    limit: MAX_ASSET_BYTES,
  });

/** The `error` text of a JSON error body, if any. */
async function serverMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** The `import_asset` tool as an `McpExtension` (PROTOCOL.md §11). */
export function importAssetTool(options: ImportAssetToolOptions = {}): McpExtension {
  return (server, client) => {
    const handler = async (input: ImportAssetToolInput): Promise<CallToolResult> => {
      const file = resolve(options.cwd ?? process.cwd(), input.path);
      const read = await readImage(file, options.readFile ?? readWholeFile);
      if ("error" in read) return read.error;
      // The gate ran before the read; the connection may have dropped since.
      // Recheck it immediately before sending (PROTOCOL.md §11: a gated call sends nothing).
      const gate = client.connectionError();
      if (gate !== null) return toolError({ code: gate.code, message: gate.message });

      const { url, token } = options.credentials?.() ?? client.credentials;
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "X-Filename": encodeURIComponent(basename(file)),
      };
      if (input.slug !== undefined) headers["X-Slug"] = encodeURIComponent(input.slug);

      let res: Response;
      try {
        res = await fetch(assetUploadUrl(url), { method: "POST", headers, body: read.bytes });
      } catch (e) {
        return fail("upload_failed", `cannot reach the authority: ${(e as Error).message}`);
      }
      if (res.status === 201) {
        let body: { path?: unknown };
        try {
          body = (await res.json()) as { path?: unknown };
        } catch {
          body = {};
        }
        if (typeof body.path !== "string") {
          return fail("upload_failed", "the authority answered 201 without a path", {
            status: 201,
          });
        }
        return toolResult({ path: body.path });
      }
      const detail = await serverMessage(res);
      const code = CODE_BY_STATUS[res.status] ?? "upload_failed";
      const message = MESSAGE_BY_STATUS[res.status] ?? `the authority answered HTTP ${res.status}`;
      return fail(code, detail === undefined ? message : `${message}: ${detail}`, {
        status: res.status,
      });
    };

    server.registerTool(
      "import_asset",
      { description: IMPORT_ASSET_DESCRIPTION, inputSchema: ImportAssetInputSchema },
      withConnection(client, handler),
    );
  };
}
