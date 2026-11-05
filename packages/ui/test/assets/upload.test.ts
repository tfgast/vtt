// @vitest-environment node
/**
 * The browser upload helper against a real in-process authority with the
 * asset handler (PROTOCOL.md §1, `POST /assets`, `GET /assets/<path>`;
 * DESIGN.md §7, Revisions and assets). Node environment for Node's fetch,
 * `File` and `Blob`.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssetHttpHandler,
  DocumentStore,
  newTableSnapshot,
  type RunningServer,
  startServer,
  TableHost,
} from "@vtt/authority";
import { AssetUploadError, assetUrl, uploadAsset } from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let dir: string;
const servers: RunningServer[] = [];
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-ui-upload-")));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await rm(dir, { recursive: true, force: true });
});

async function serveTable(
  host?: TableHost,
): Promise<{ server: RunningServer; host: TableHost; base: string }> {
  const h =
    host ??
    (await TableHost.open(join(dir, "my table.json"), { createIfMissing: true, autosave: false }));
  hosts.push(h);
  const server = await startServer({
    port: 0,
    host: h,
    http: [createAssetHttpHandler({ host: h })],
  });
  servers.push(server);
  return { server, host: h, base: `http://127.0.0.1:${server.port}` };
}

describe("assetUrl", () => {
  test("is /assets/ plus the path's segments URI-encoded", () => {
    expect(assetUrl("my table.json.assets/a b-0123abcd.png")).toBe(
      "/assets/my%20table.json.assets/a%20b-0123abcd.png",
    );
    expect(assetUrl("maps/#1?.png")).toBe("/assets/maps/%231%3F.png");
    expect(assetUrl("x/ü.png")).toBe("/assets/x/%C3%BC.png");
  });
});

describe("uploadAsset", () => {
  test("returns the listed path, and assetUrl fetches the same bytes", async () => {
    const { server, host, base } = await serveTable();
    const file = new File([PNG], "Dungeon Map.png", { type: "image/png" });
    const { path } = await uploadAsset(file, { token: server.token, base });
    expect(path).toMatch(/^my table\.json\.assets\/dungeon-map-[0-9a-f]{8}\.png$/);
    expect(host.assets).toEqual([path]);
    const url = assetUrl(path);
    expect(url).toContain("my%20table.json.assets");
    const res = await fetch(base + url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("the slug option names the file; a Blob without a name is accepted", async () => {
    const { server, base } = await serveTable();
    const named = await uploadAsset(new File([PNG], "x.png"), {
      token: server.token,
      base,
      slug: "Big Boss",
    });
    expect(named.path).toMatch(/\/big-boss-[0-9a-f]{8}\.png$/);
    const blob = await uploadAsset(new Blob([PNG]), { token: server.token, base });
    expect(blob.path).toMatch(/\/image-[0-9a-f]{8}\.png$/);
  });

  test("base defaults to location.origin", async () => {
    const { server, base } = await serveTable();
    vi.stubGlobal("location", { origin: base });
    const { path } = await uploadAsset(new File([PNG], "a.png"), { token: server.token });
    expect(path).toMatch(/\/a-[0-9a-f]{8}\.png$/);
  });

  test("an injected fetch is used", async () => {
    const { server, base } = await serveTable();
    const calls: string[] = [];
    const spy: typeof fetch = (input, init) => {
      calls.push(String(input));
      return fetch(input, init);
    };
    await uploadAsset(new File([PNG], "a.png"), { token: server.token, base, fetch: spy });
    expect(calls).toEqual([`${base}/assets`]);
  });

  test("refusals reject with AssetUploadError carrying the HTTP status", async () => {
    const { server, base } = await serveTable();
    const status = async (p: Promise<unknown>): Promise<number> => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AssetUploadError);
      return (err as AssetUploadError).status;
    };
    expect(await status(uploadAsset(new File([PNG], "a.png"), { token: "wrong", base }))).toBe(401);
    const svg = new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "a.svg", {
      type: "image/svg+xml",
    });
    expect(await status(uploadAsset(svg, { token: server.token, base }))).toBe(415);
  });

  test("an in-memory table rejects with 409", async () => {
    const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
    const { server, base } = await serveTable(host);
    const err = await uploadAsset(new File([PNG], "a.png"), { token: server.token, base }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AssetUploadError);
    expect((err as AssetUploadError).status).toBe(409);
  });
});
