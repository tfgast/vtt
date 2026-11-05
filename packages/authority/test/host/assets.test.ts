/**
 * Importing image assets into `<table basename>.assets/` (DESIGN.md §7,
 * Revisions and assets; PROTOCOL.md §1, `POST /assets`; M4-D2).
 */
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetImportError,
  assetSlug,
  assetTypeOf,
  DocumentStore,
  importAsset,
  loadTable,
  MAX_ASSET_BYTES,
  newTableSnapshot,
  TableHost,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/** The PNG signature followed by `fill` (only the magic bytes are checked). */
function png(fill = "pixels"): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(fill),
  ]);
}

const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("j")]);
const gif = (v: "87a" | "89a" = "89a"): Buffer => Buffer.from(`GIF${v}\x01\x00\x01\x00`, "latin1");
const webp = (): Buffer =>
  Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x10, 0, 0, 0]),
    Buffer.from("WEBPVP8 "),
    Buffer.from("w"),
  ]);
const svg = (): Buffer =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** The first 8 hex digits of the bytes' SHA-256. */
async function hash8(bytes: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

let dir: string;
let path: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-assets-")));
  path = join(dir, "dungeon.json");
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await rm(dir, { recursive: true, force: true });
});

async function open(file = path): Promise<TableHost> {
  const host = await TableHost.open(file, { createIfMissing: true, autosave: false });
  hosts.push(host);
  return host;
}

async function rejection(p: Promise<unknown>): Promise<AssetImportError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AssetImportError);
  return err as AssetImportError;
}

describe("assetTypeOf", () => {
  test("recognises PNG, JPEG, WebP and GIF by their magic bytes", () => {
    expect(assetTypeOf(png())).toEqual({ ext: "png", contentType: "image/png" });
    expect(assetTypeOf(jpeg())).toEqual({ ext: "jpg", contentType: "image/jpeg" });
    expect(assetTypeOf(webp())).toEqual({ ext: "webp", contentType: "image/webp" });
    expect(assetTypeOf(gif("87a"))).toEqual({ ext: "gif", contentType: "image/gif" });
    expect(assetTypeOf(gif("89a"))).toEqual({ ext: "gif", contentType: "image/gif" });
  });

  test("anything else is null: SVG, text, empty, truncated signatures, RIFF that is not WebP", () => {
    expect(assetTypeOf(svg())).toBeNull();
    expect(assetTypeOf(Buffer.from("just some text"))).toBeNull();
    expect(assetTypeOf(new Uint8Array())).toBeNull();
    expect(assetTypeOf(png().subarray(0, 7))).toBeNull();
    expect(assetTypeOf(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(assetTypeOf(Buffer.from("RIFF\x10\x00\x00\x00WAVEfmt ", "latin1"))).toBeNull();
    expect(assetTypeOf(Buffer.from("GIF90a", "latin1"))).toBeNull();
  });
});

describe("assetSlug", () => {
  test("lowercases, replaces characters outside [a-z0-9_-] with '-', keeps at most 40", () => {
    expect(assetSlug("Dungeon Map")).toBe("dungeon-map");
    expect(assetSlug("a_b-C9")).toBe("a_b-c9");
    expect(assetSlug("../../etc/passwd")).toBe("------etc-passwd");
    expect(assetSlug("Ünïcode 🐉")).toBe("-n-code--");
    expect(assetSlug("x".repeat(60))).toBe("x".repeat(40));
  });

  test("an empty slug becomes 'image'", () => {
    expect(assetSlug("")).toBe("image");
  });
});

describe("importAsset", () => {
  test("a PNG is written under <table basename>.assets/ and its hashed path returned and listed", async () => {
    const host = await open();
    const bytes = png();
    const { path: rel } = await importAsset(host, { bytes, filename: "Dungeon Map.png" });
    expect(rel).toBe(`dungeon.json.assets/dungeon-map-${await hash8(bytes)}.png`);
    expect(await readFile(join(dir, rel))).toEqual(bytes);
    expect(host.assets).toEqual([rel]);
    expect(host.assetsGeneration).toBe(1);
  });

  test("the slug is X-Slug when given, else the file stem; the extension follows the bytes", async () => {
    const host = await open();
    const bytes = jpeg();
    const h = await hash8(bytes);
    expect((await importAsset(host, { bytes, filename: "photo.PNG" })).path).toBe(
      `dungeon.json.assets/photo-${h}.jpg`,
    );
    expect((await importAsset(host, { bytes, filename: "photo.png", slug: "Hero!" })).path).toBe(
      `dungeon.json.assets/hero--${h}.jpg`,
    );
    expect((await importAsset(host, { bytes: webp(), filename: "w" })).path).toMatch(
      /^dungeon\.json\.assets\/w-[0-9a-f]{8}\.webp$/,
    );
    expect((await importAsset(host, { bytes: gif(), filename: ".gif" })).path).toMatch(
      /^dungeon\.json\.assets\/-gif-[0-9a-f]{8}\.gif$/,
    );
    expect((await importAsset(host, { bytes: gif("87a"), filename: "" })).path).toMatch(
      /^dungeon\.json\.assets\/image-[0-9a-f]{8}\.gif$/,
    );
    expect(host.assets).toHaveLength(5);
  });

  test("a filename with directories uses only its last component's stem", async () => {
    const host = await open();
    const bytes = png();
    expect((await importAsset(host, { bytes, filename: "../../maps/Cave.png" })).path).toBe(
      `dungeon.json.assets/cave-${await hash8(bytes)}.png`,
    );
    expect((await importAsset(host, { bytes, filename: "C:\\maps\\Cave.png" })).path).toBe(
      `dungeon.json.assets/cave-${await hash8(bytes)}.png`,
    );
  });

  test("a reimport of the same bytes and slug returns the same path without rewriting", async () => {
    const host = await open();
    const bytes = png();
    const first = await importAsset(host, { bytes, filename: "map.png" });
    const before = await stat(join(dir, first.path));
    const second = await importAsset(host, { bytes, filename: "map.png" });
    expect(second).toEqual(first);
    const after = await stat(join(dir, first.path));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(dir, "dungeon.json.assets"))).toEqual([first.path.split("/")[1]]);
    expect(host.assets).toEqual([first.path]);
    expect(host.assetsGeneration).toBe(1);
  });

  test("a damaged file at the hashed path is replaced with the bytes", async () => {
    const host = await open();
    const bytes = png();
    const { path: rel } = await importAsset(host, { bytes, filename: "map.png" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, rel), "damaged");
    expect((await importAsset(host, { bytes, filename: "map.png" })).path).toBe(rel);
    expect(await readFile(join(dir, rel))).toEqual(bytes);
  });

  test("no temp files are left behind", async () => {
    const host = await open();
    await importAsset(host, { bytes: png("a"), filename: "a.png" });
    await importAsset(host, { bytes: png("b"), filename: "b.png" });
    const names = await readdir(join(dir, "dungeon.json.assets"));
    expect(names).toHaveLength(2);
    for (const n of names) expect(n).toMatch(/^[ab]-[0-9a-f]{8}\.png$/);
  });

  test("SVG, text and empty bytes are refused as unsupported_type and nothing is written", async () => {
    const host = await open();
    for (const bytes of [svg(), Buffer.from("hello"), Buffer.alloc(0)]) {
      const err = await rejection(importAsset(host, { bytes, filename: "x.png" }));
      expect(err.code).toBe("unsupported_type");
    }
    expect(host.assets).toEqual([]);
    expect((await readdir(dir)).filter((n) => n.endsWith(".assets"))).toEqual([]);
  });

  test("more than MAX_ASSET_BYTES is refused as too_large; exactly the limit is accepted", async () => {
    expect(MAX_ASSET_BYTES).toBe(50 * 1024 * 1024);
    const host = await open();
    const big = Buffer.alloc(MAX_ASSET_BYTES + 1);
    png().copy(big);
    const err = await rejection(importAsset(host, { bytes: big, filename: "big.png" }));
    expect(err.code).toBe("too_large");
    expect(host.assets).toEqual([]);
    const { path: rel } = await importAsset(host, {
      bytes: big.subarray(0, MAX_ASSET_BYTES),
      filename: "big.png",
    });
    expect((await stat(join(dir, rel))).size).toBe(MAX_ASSET_BYTES);
  });

  test("an in-memory host is refused as in_memory", async () => {
    const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
    const err = await rejection(importAsset(host, { bytes: png(), filename: "x.png" }));
    expect(err.code).toBe("in_memory");
    expect(host.assets).toEqual([]);
  });

  test("an import followed by save lists the asset, and loadTable reports no missing asset", async () => {
    const host = await open();
    const { path: rel } = await importAsset(host, { bytes: png(), filename: "map.png" });
    expect((await host.save()).status).toBe("saved");
    const file = JSON.parse(await readFile(path, "utf8")) as { assets: string[] };
    expect(file.assets).toEqual([rel]);
    const loaded = await loadTable(path);
    expect(loaded.assets).toEqual([rel]);
    expect(loaded.warnings.filter((w) => w.type === "missing_asset")).toEqual([]);
  });

  test("the assets directory is named from the table's basename, spaces included", async () => {
    const host = await open(join(dir, "my table.vtt.json"));
    const bytes = png();
    const { path: rel } = await importAsset(host, { bytes, filename: "a b.png" });
    expect(rel).toBe(`my table.vtt.json.assets/a-b-${await hash8(bytes)}.png`);
    expect(await readFile(join(dir, rel))).toEqual(bytes);
  });
});
