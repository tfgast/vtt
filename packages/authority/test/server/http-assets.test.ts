/**
 * `POST /assets` and `GET /assets/<path>` (PROTOCOL.md §1 HTTP routes;
 * DESIGN.md §7, Revisions and assets; M4-D1, M4-D2, M4-D3) on a real server
 * over a temp table file.
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssetHttpHandler,
  createUiHttpHandler,
  DocumentStore,
  type HttpHandler,
  MAX_ASSET_BYTES,
  newTableSnapshot,
  type RunningServer,
  saveTable,
  TableHost,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, serve } from "./helpers";

const png = (fill = "pixels"): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(fill)]);
const svg = (): Buffer =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A raw HTTP request (no URL normalization, so traversal paths reach the server as written). */
function send(
  server: RunningServer,
  path: string,
  options: { method?: string; headers?: OutgoingHttpHeaders; body?: Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${server.port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function post(
  server: RunningServer,
  body: Buffer,
  headers: OutgoingHttpHeaders = {},
  token: string | null = server.token,
): Promise<Reply> {
  return send(server, "/assets", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/octet-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "x-filename": "map.png",
      ...headers,
    },
  });
}

const json = (r: Reply): unknown => JSON.parse(r.body.toString("utf8"));

let dir: string;
let tablePath: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-http-assets-")));
  tablePath = join(dir, "dungeon.json");
});

afterEach(async () => {
  await cleanup();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await rm(dir, { recursive: true, force: true });
});

async function open(file = tablePath): Promise<TableHost> {
  const host = await TableHost.open(file, { createIfMissing: true, autosave: false });
  hosts.push(host);
  return host;
}

/** A server over a file host with the asset handler installed. */
async function serveAssets(
  host?: TableHost,
  extra: HttpHandler[] = [],
): Promise<{ server: RunningServer; host: TableHost }> {
  const h = host ?? (await open());
  return serve({ host: h, http: [createAssetHttpHandler({ host: h }), ...extra] });
}

describe("POST /assets", () => {
  test("201 with the hashed path; the bytes are stored and listed; GET returns them with no-store", async () => {
    const { server, host } = await serveAssets();
    const bytes = png();
    const res = await post(server, bytes);
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const { path } = json(res) as { path: string };
    expect(path).toMatch(/^dungeon\.json\.assets\/map-[0-9a-f]{8}\.png$/);
    expect(await readFile(join(dir, path))).toEqual(bytes);
    expect(host.assets).toEqual([path]);

    const got = await send(server, `/assets/${path}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(bytes);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["cache-control"]).toBe("no-store");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("X-Filename and X-Slug are URL-decoded; X-Slug wins", async () => {
    const { server } = await serveAssets();
    const a = await post(server, png(), { "x-filename": encodeURIComponent("Höhle Karte.png") });
    expect((json(a) as { path: string }).path).toMatch(/^dungeon\.json\.assets\/h-hle-karte-/);
    const b = await post(server, png(), { "x-slug": encodeURIComponent("Big Boss") });
    expect((json(b) as { path: string }).path).toMatch(/^dungeon\.json\.assets\/big-boss-/);
  });

  test("the same bytes and slug give the same path without a second file", async () => {
    const { server, host } = await serveAssets();
    const first = json(await post(server, png())) as { path: string };
    const again = await post(server, png());
    expect(again.status).toBe(201);
    expect(json(again)).toEqual(first);
    expect(await readdir(join(dir, "dungeon.json.assets"))).toHaveLength(1);
    expect(host.assets).toEqual([first.path]);
  });

  test("a wrong, missing or malformed token is 401 and nothing is stored", async () => {
    const { server, host } = await serveAssets();
    expect((await post(server, png(), {}, "wrong")).status).toBe(401);
    expect((await post(server, png(), {}, null)).status).toBe(401);
    expect((await post(server, png(), {}, `${server.token}x`)).status).toBe(401);
    expect((await post(server, png(), { authorization: server.token })).status).toBe(401);
    expect((await post(server, png(), { authorization: `Basic ${server.token}` })).status).toBe(
      401,
    );
    expect(host.assets).toEqual([]);
  });

  test("an explicit token option is the one checked", async () => {
    const host = await open();
    const { server } = await serve({
      host,
      http: [createAssetHttpHandler({ host, token: "fixed-token" })],
    });
    expect((await post(server, png())).status).toBe(401);
    expect((await post(server, png(), {}, "fixed-token")).status).toBe(201);
  });

  test("SVG and text bytes are 415", async () => {
    const { server, host } = await serveAssets();
    expect((await post(server, svg(), { "x-filename": "x.svg" })).status).toBe(415);
    expect((await post(server, Buffer.from("plain text"))).status).toBe(415);
    expect((await post(server, Buffer.alloc(0))).status).toBe(415);
    expect(host.assets).toEqual([]);
  });

  test("more than 50 MiB is 413", async () => {
    const { server, host } = await serveAssets();
    const big = Buffer.alloc(MAX_ASSET_BYTES + 1);
    png().copy(big);
    const res = await post(server, big);
    expect(res.status).toBe(413);
    expect(host.assets).toEqual([]);
    // The connection stays usable for the next request on a fresh socket.
    expect((await post(server, png())).status).toBe(201);
  });

  test("more than 50 MiB without a Content-Length (chunked) is 413", async () => {
    const { server, host } = await serveAssets();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/assets",
          method: "POST",
          headers: {
            host: `127.0.0.1:${server.port}`,
            authorization: `Bearer ${server.token}`,
            "x-filename": "big.png",
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write(png());
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 51; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
    expect(host.assets).toEqual([]);
  });

  test("an in-memory table is 409", async () => {
    const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
    const { server } = await serve({ host, http: [createAssetHttpHandler({ host })] });
    expect((await post(server, png())).status).toBe(409);
    expect(host.assets).toEqual([]);
  });

  test("a missing X-Filename or a malformed URL-encoding is 400", async () => {
    const { server, host } = await serveAssets();
    const res = await send(server, "/assets", {
      method: "POST",
      body: png(),
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(400);
    expect((await post(server, png(), { "x-filename": "%E0%A4%A" })).status).toBe(400);
    expect((await post(server, png(), { "x-slug": "%" })).status).toBe(400);
    expect(host.assets).toEqual([]);
  });

  test("the bad token is checked before the body type and size", async () => {
    const { server } = await serveAssets();
    expect((await post(server, svg(), {}, "nope")).status).toBe(401);
  });

  test("an import followed by save lists the asset in the file", async () => {
    const { server, host } = await serveAssets();
    const { path } = json(await post(server, png())) as { path: string };
    expect((await host.save()).status).toBe("saved");
    const file = JSON.parse(await readFile(tablePath, "utf8")) as { assets: string[] };
    expect(file.assets).toEqual([path]);
  });
});

describe("GET /assets/<path>", () => {
  /** Writes a table file listing `assets`, plus the given files, then opens it. */
  async function tableListing(
    assets: string[],
    files: Record<string, Buffer | string>,
  ): Promise<TableHost> {
    const result = await saveTable(
      tablePath,
      DocumentStore.fromSnapshot(newTableSnapshot()),
      assets,
    );
    expect(result.ok).toBe(true);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
    return open();
  }

  test("an asset listed by a file loaded from disk (not imported) is served", async () => {
    const bytes = png("loaded");
    const host = await tableListing(["maps/Dungeon Map.webp"], {
      "maps/Dungeon Map.webp": bytes,
    });
    const { server } = await serveAssets(host);
    const res = await send(server, "/assets/maps/Dungeon%20Map.webp");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a listed path is matched after normalization ('.' segments, repeated slashes)", async () => {
    const bytes = png();
    const host = await tableListing(["./maps//a.jpeg"], { "maps/a.jpeg": bytes });
    const { server } = await serveAssets(host);
    const res = await send(server, "/assets/maps/a.jpeg");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });

  test("a path that exists but is not listed is 404", async () => {
    const host = await tableListing(["maps/a.png"], { "maps/a.png": png(), "maps/b.png": png() });
    const { server } = await serveAssets(host);
    expect((await send(server, "/assets/maps/b.png")).status).toBe(404);
    expect((await send(server, "/assets/dungeon.json")).status).toBe(404);
    expect((await send(server, "/assets/dungeon.json.table-id")).status).toBe(404);
    expect((await send(server, "/assets/")).status).toBe(404);
    expect((await send(server, "/assets")).status).toBe(404);
  });

  test("traversal is 404 even when it lands on a listed file", async () => {
    const host = await tableListing(["maps/a.png"], { "maps/a.png": png() });
    const { server } = await serveAssets(host);
    for (const p of [
      "/assets/maps/../maps/a.png",
      "/assets/./maps/a.png",
      "/assets/maps/./a.png",
      "/assets/maps//a.png",
      "/assets/maps%2Fa.png",
      "/assets/maps%5Ca.png",
      "/assets/%2e%2e/dungeon.json",
      "/assets/..%2Fdungeon.json",
      "/assets/maps/a.png%00",
      "/assets/%E0%A4%A",
      "/assets/../dungeon.json",
    ]) {
      expect((await send(server, p)).status, p).toBe(404);
    }
  });

  test("a listed path that escapes the table's directory is never served", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "vtt-outside-")));
    try {
      await writeFile(join(outside, "secret.png"), png("secret"));
      const name = outside.split("/").pop() ?? "";
      const host = await tableListing([`../${name}/secret.png`], {});
      const { server } = await serveAssets(host);
      expect((await send(server, `/assets/../${name}/secret.png`)).status).toBe(404);
      expect((await send(server, `/assets/%2e%2e/${name}/secret.png`)).status).toBe(404);
      expect((await send(server, `/assets/${outside.slice(1)}/secret.png`)).status).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a listed symlink that resolves outside the table's directory is 404", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "vtt-outside-")));
    try {
      await writeFile(join(outside, "secret.png"), png("secret"));
      const host = await tableListing(["link/secret.png", "file.png"], {});
      await symlink(outside, join(dir, "link"));
      await symlink(join(outside, "secret.png"), join(dir, "file.png"));
      const { server } = await serveAssets(host);
      expect((await send(server, "/assets/link/secret.png")).status).toBe(404);
      expect((await send(server, "/assets/file.png")).status).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a listed path that is missing or a directory is 404", async () => {
    const host = await tableListing(["gone.png", "maps"], { "maps/a.png": png() });
    const { server } = await serveAssets(host);
    expect((await send(server, "/assets/gone.png")).status).toBe(404);
    expect((await send(server, "/assets/maps")).status).toBe(404);
  });

  test("a listed file whose extension is not an image type is sent as octet-stream, sandboxed", async () => {
    const host = await tableListing(["notes/evil.svg"], { "notes/evil.svg": svg() });
    const { server } = await serveAssets(host);
    const res = await send(server, "/assets/notes/evil.svg");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/sandbox/);
  });

  test("a query string is ignored", async () => {
    const host = await tableListing(["a.gif"], { "a.gif": Buffer.from("GIF89a....") });
    const { server } = await serveAssets(host);
    const res = await send(server, "/assets/a.gif?v=2");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");
  });

  test("an in-memory host serves nothing", async () => {
    const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
    const { server } = await serve({ host, http: [createAssetHttpHandler({ host })] });
    expect((await send(server, "/assets/a.png")).status).toBe(404);
  });
});

describe("routing", () => {
  test("only /assets and /assets/ are taken; /ui-assets/ and others go to later handlers", async () => {
    const seen: string[] = [];
    const tail: HttpHandler = (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(204);
      res.end();
      return true;
    };
    const host = await open();
    const { server } = await serveAssets(host, [createUiHttpHandler({ uiDir: null }), tail]);
    expect((await send(server, "/ui-assets/x.js")).status).toBe(404); // the UI handler's
    expect((await send(server, "/assetsx")).status).toBe(204);
    expect((await send(server, "/assets", { method: "PUT" })).status).toBe(204);
    expect((await send(server, "/assets/a.png", { method: "POST" })).status).toBe(204);
    expect(seen).toEqual(["GET /assetsx", "PUT /assets", "POST /assets/a.png"]);
  });

  test("the Host check still applies before the asset handler", async () => {
    const { server } = await serveAssets();
    const res = await post(server, png(), { host: `evil.example:${server.port}` });
    expect(res.status).toBe(421);
  });
});
