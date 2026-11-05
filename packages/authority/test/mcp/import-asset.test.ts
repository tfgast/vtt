/**
 * The MCP tool `import_asset` (vtt-3l6.20; PROTOCOL.md §1 `POST /assets`,
 * §11; DESIGN.md §5.2, §7 Revisions and assets; M4-D3): a real in-process
 * authority with the asset handler (vtt-3l6.16) over a temp table file or an
 * in-memory host, a `ProtocolClient` with recovery, and the MCP server
 * linked to an SDK client through the in-memory transport pair.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import {
  ConnectionCredentials,
  createAssetHttpHandler,
  createMcpServer,
  type HttpHandler,
  IMPORT_ASSET_DESCRIPTION,
  ImportAssetInputSchema,
  importAssetTool,
  MAX_ASSET_BYTES,
  type RunningServer,
  startServer,
  TableHost,
} from "@vtt/authority";
import { enableRecovery, ProtocolClient } from "@vtt/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memoryHost, until } from "../server/helpers";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (fill = "pixels"): Buffer =>
  Buffer.concat([Buffer.from(PNG_SIGNATURE), Buffer.from(fill)]);
const svg = (): Buffer =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type ToolResult = {
  isError?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: assertions read results loosely
  structuredContent?: any;
  content: { type: string; text?: string }[];
};

interface Setup {
  server: RunningServer;
  host: TableHost;
  client: ProtocolClient;
  mcp: Client;
  /** `POST /assets` requests the authority received. */
  uploads: () => number;
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
}

let dir: string;
const closers: (() => Promise<unknown> | unknown)[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-import-asset-")));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await rm(dir, { recursive: true, force: true });
});

async function fileHost(): Promise<TableHost> {
  const host = await TableHost.open(join(dir, "dungeon.json"), {
    createIfMissing: true,
    autosave: false,
  });
  closers.push(() => host.close());
  return host;
}

/** Counts `POST /assets` requests and passes them on. */
function counter(): { handler: HttpHandler; count: () => number } {
  let n = 0;
  return {
    handler: (req) => {
      if (req.method === "POST" && req.url?.split("?")[0] === "/assets") n++;
      return false;
    },
    count: () => n,
  };
}

async function start(
  options: {
    host?: TableHost;
    token?: string;
    port?: number;
    connect?: boolean;
    /** The tool's credentials; default: the server's url and token. */
    credentials?: () => { url: string; token: string };
    /** Discovery: recovery reads credentials from this source (given the server), tracked for the tool. */
    discovery?: (server: RunningServer) => () => Promise<{
      url: string;
      token: string;
      table_path: string | null;
      table_id: string | null;
    } | null>;
  } = {},
): Promise<Setup> {
  const host = options.host ?? (await fileHost());
  const count = counter();
  const server = await startServer({
    host,
    port: options.port ?? 0,
    ...(options.token === undefined ? {} : { token: options.token }),
    http: [count.handler, createAssetHttpHandler({ host })],
  });
  closers.push(() => server.close());
  const client = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: "import-asset-test", kind: "agent" },
    onWarning: () => undefined,
  });
  closers.push(() => client.close());
  const tracked = new ConnectionCredentials({ url: server.url, token: server.token });
  const mcpServer: McpServer = createMcpServer({
    client,
    extensions: [
      importAssetTool({ credentials: options.credentials ?? (() => tracked.current()) }),
    ],
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverSide);
  const mcp = new Client({ name: "import-asset-agent", version: "1.0.0" });
  await mcp.connect(clientSide);
  closers.push(async () => {
    await mcp.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
  });
  if (options.connect !== false) {
    const stop = enableRecovery(client, {
      reconnect: { initialMs: 10, maxMs: 50, factor: 2 },
      ...(options.discovery === undefined
        ? {}
        : { credentials: tracked.track(options.discovery(server)) }),
    });
    closers.push(stop);
    await until(() => client.ready, 5000, "the client to be ready");
  }
  return {
    server,
    host,
    client,
    mcp,
    uploads: count.count,
    call: async (args) =>
      (await mcp.callTool({ name: "import_asset", arguments: args })) as ToolResult,
  };
}

/** A raw GET with the loopback Host header. */
function get(server: RunningServer, path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server.port, path, headers: { host: `127.0.0.1:${server.port}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function expectError(result: ToolResult, code: string): void {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
  expect(result.structuredContent).toMatchObject({ code, message: expect.any(String) });
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
}

describe("import_asset in tools/list", () => {
  test("is listed with its strict schema and a description naming the image cell", async () => {
    const s = await start();
    const { tools } = await s.mcp.listTools();
    const tool = tools.find((t) => t.name === "import_asset");
    expect(tool).toBeDefined();
    expect(tool?.description).toBe(IMPORT_ASSET_DESCRIPTION);
    expect(tool?.description).toMatch(/`image` cell/);
    expect(tool?.description).toMatch(/transact/);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" }, slug: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
    expect(ImportAssetInputSchema.safeParse({ path: "a.png", extra: 1 }).success).toBe(false);
  });

  test("an unknown key is an input error and uploads nothing", async () => {
    const s = await start();
    const file = join(dir, "map.png");
    await writeFile(file, png());
    const result = await s.call({ path: file, url: "http://example.com" });
    expect(result.isError).toBe(true);
    expect(s.uploads()).toBe(0);
  });
});

describe("importing a file", () => {
  test("a PNG returns a listed path; transact sets `image` to it; GET returns the bytes", async () => {
    const s = await start();
    const bytes = png();
    const file = join(dir, "Goblin Map.png");
    await writeFile(file, bytes);

    const result = await s.call({ path: file });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const { path } = result.structuredContent as { path: string };
    expect(path).toMatch(/^dungeon\.json\.assets\/goblin-map-[0-9a-f]{8}\.png$/);
    expect(result.structuredContent).toEqual({ path });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ path }) }]);
    expect(s.host.assets).toEqual([path]);
    expect(s.uploads()).toBe(1);
    expect(await readFile(join(dir, path))).toEqual(bytes);

    const write = (await s.mcp.callTool({
      name: "transact",
      arguments: {
        base_revision: s.client.revision,
        ops: [
          {
            type: "create_object",
            id: "map",
            to: { type: "board", board: s.client.boards[0]?.id, position: [0, 0] },
            init: { cells: { image: { type: "text", value: path } } },
          },
        ],
      },
    })) as ToolResult;
    expect(write.isError, JSON.stringify(write.structuredContent)).toBeFalsy();
    expect(write.structuredContent).toMatchObject({ status: "committed" });
    const { objects } = await s.client.request("get_objects", { ids: ["map"] });
    expect(JSON.stringify(objects)).toContain(path);

    const got = await get(s.server, `/assets/${path}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(bytes);
  });

  test("a relative path resolves against the working directory; `slug` names the file", async () => {
    const s = await start();
    const file = join(dir, "x.png");
    await writeFile(file, png("relative"));
    const result = await s.call({ path: relative(process.cwd(), file), slug: "Town Square" });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(result.structuredContent.path).toMatch(
      /^dungeon\.json\.assets\/town-square-[0-9a-f]{8}\.png$/,
    );
  });

  test("a missing file, an SVG and an oversize file are errors and upload nothing", async () => {
    const s = await start();
    expectError(await s.call({ path: join(dir, "nope.png") }), "file_missing");

    const vector = join(dir, "map.svg");
    await writeFile(vector, svg());
    expectError(await s.call({ path: vector }), "unsupported_type");

    const big = join(dir, "big.png");
    await writeFile(big, Buffer.concat([png(), Buffer.alloc(MAX_ASSET_BYTES)]));
    expectError(await s.call({ path: big }), "too_large");

    expectError(await s.call({ path: dir }), "file_unreadable");
    expect(s.uploads()).toBe(0);
    expect(s.host.assets).toEqual([]);
  });

  test("a wrong token maps 401 to an error", async () => {
    let token: string | null = null;
    const s = await start({
      credentials: () => ({ url: s.server.url, token: token ?? s.server.token }),
    });
    token = "not-the-token";
    const file = join(dir, "map.png");
    await writeFile(file, png());
    const result = await s.call({ path: file });
    expectError(result, "unauthorized");
    expect(result.structuredContent.status).toBe(401);
    expect(s.uploads()).toBe(1);
    expect(s.host.assets).toEqual([]);
  });

  test("an in-memory authority maps 409 to an error", async () => {
    const s = await start({ host: memoryHost() });
    const file = join(dir, "map.png");
    await writeFile(file, png());
    const result = await s.call({ path: file });
    expectError(result, "in_memory");
    expect(result.structuredContent.status).toBe(409);
    expect(s.uploads()).toBe(1);
  });

  test("uses the current credentials after a discovery refresh", async () => {
    const host = await fileHost();
    let session: {
      url: string;
      token: string;
      table_path: string | null;
      table_id: string | null;
    } | null = null;
    const s = await start({
      host,
      token: "first-token",
      discovery: (first) => async () =>
        session ?? {
          url: first.url,
          token: first.token,
          table_path: host.path,
          table_id: host.tableId,
        },
    });
    // The authority restarts on the same port with a new token; the session file follows.
    await s.server.close();
    await until(() => !s.client.ready, 5000, "the client to notice the restart");
    const second = await startServer({
      host,
      port: s.server.port,
      token: "second-token",
      http: [createAssetHttpHandler({ host })],
    });
    closers.push(() => second.close());
    session = {
      url: second.url,
      token: second.token,
      table_path: host.path,
      table_id: host.tableId,
    };
    await until(() => s.client.ready, 10000, "the reconnect through discovery");

    const file = join(dir, "map.png");
    await writeFile(file, png());
    const result = await s.call({ path: file });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(host.assets).toEqual([result.structuredContent.path]);
  });
});

describe("the connection gate", () => {
  test("while the client reports `disconnected` the tool answers that and uploads nothing", async () => {
    const s = await start({ connect: false });
    const file = join(dir, "map.png");
    await writeFile(file, png());
    expectError(await s.call({ path: file }), "disconnected");
    expect(s.uploads()).toBe(0);
  });
});

describe("ConnectionCredentials", () => {
  test("tracks every pair a discovery source yields and ignores null reads", async () => {
    const tracked = new ConnectionCredentials({ url: "ws://127.0.0.1:1/ws", token: "a" });
    let next: { url: string; token: string; table_path: null; table_id: null } | null = {
      url: "ws://127.0.0.1:2/ws",
      token: "b",
      table_path: null,
      table_id: null,
    };
    const source = tracked.track(async () => next);
    expect(tracked.current()).toEqual({ url: "ws://127.0.0.1:1/ws", token: "a" });
    expect(await source()).toEqual(next);
    expect(tracked.current()).toEqual({ url: "ws://127.0.0.1:2/ws", token: "b" });
    next = null;
    expect(await source()).toBeNull();
    expect(tracked.current()).toEqual({ url: "ws://127.0.0.1:2/ws", token: "b" });
  });
});
