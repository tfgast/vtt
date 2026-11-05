import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { CRYPT_MAP, exampleAssetPath, GOBLIN_IMAGE, type Rect } from "@vtt/fixtures";
import { describe, expect, test } from "vitest";
import { rasterCryptMap, rasterGoblin } from "./support/raster";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// An independent CRC-32 (ISO 3309, as PNG uses), so the check does not share
// code with the writer.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Chunk {
  type: string;
  data: Uint8Array;
}

/** Split a PNG into chunks, checking the signature and every chunk's CRC. */
function chunksOf(png: Uint8Array): Chunk[] {
  expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = view.getUint32(at);
    const typeAndData = png.subarray(at + 4, at + 8 + length);
    const type = String.fromCharCode(...typeAndData.subarray(0, 4));
    expect(view.getUint32(at + 8 + length), `CRC of ${type} at ${at}`).toBe(crc32(typeAndData));
    chunks.push({ type, data: typeAndData.subarray(4) });
    at += 12 + length;
  }
  expect(at).toBe(png.length);
  expect(chunks[0]?.type).toBe("IHDR");
  expect(chunks.at(-1)?.type).toBe("IEND");
  return chunks;
}

/** Decode an 8-bit palette PNG with filter 0 scanlines to one index per pixel. */
function decode(png: Uint8Array, width: number, height: number) {
  const chunks = chunksOf(png);
  const ihdr = chunks[0]?.data as Uint8Array;
  const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  expect(ihdr.length).toBe(13);
  expect(view.getUint32(0)).toBe(width);
  expect(view.getUint32(4)).toBe(height);
  expect(ihdr[8]).toBe(8); // bit depth
  expect(ihdr[9]).toBe(3); // colour type: palette
  expect([...ihdr.subarray(10)]).toEqual([0, 0, 0]); // compression, filter, interlace
  const idat = chunks.filter((c) => c.type === "IDAT").map((c) => c.data);
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let offset = 0;
  for (const d of idat) {
    joined.set(d, offset);
    offset += d.length;
  }
  const raw = inflateSync(joined);
  expect(raw.length).toBe(height * (width + 1));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    expect(raw[row], `filter byte of row ${y}`).toBe(0);
    pixels.set(raw.subarray(row + 1, row + 1 + width), y * width);
  }
  return { chunks, pixels };
}

const disjoint = (a: Rect, b: Rect): boolean =>
  a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];

describe("crypt map", () => {
  const { width_px: width, height_px: height } = CRYPT_MAP;

  test("CRYPT_MAP describes a 24 × 16 unit map with six numbered rooms", () => {
    expect(CRYPT_MAP.file).toBe("crypt-map.png");
    expect([width, height, CRYPT_MAP.px_per_unit]).toEqual([2400, 1600, 100]);
    expect(CRYPT_MAP.rooms.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(CRYPT_MAP.rooms.map((r) => r.name)).toEqual([
      "Entrance",
      "Hall",
      "Guard room",
      "Stair",
      "Barracks",
      "Shrine",
    ]);
    expect(CRYPT_MAP.corridors).toHaveLength(5);
  });

  test("rooms are inside the image and pairwise disjoint", () => {
    const rects = CRYPT_MAP.rooms.map((r) => r.rect_px);
    for (const [x, y, w, h] of rects) {
      expect(x >= 0 && y >= 0 && w > 0 && h > 0).toBe(true);
      expect(x + w <= width && y + h <= height).toBe(true);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(disjoint(rects[i] as Rect, rects[j] as Rect), `rooms ${i + 1} and ${j + 1}`).toBe(
          true,
        );
      }
    }
  });

  test("the raster has floor at every room centre, rock at [50, 50], numerals in their box", () => {
    const pixels = rasterCryptMap();
    expect(pixels.length).toBe(width * height);
    const at = (x: number, y: number) => pixels[y * width + x];
    expect(at(50, 50)).toBe(0);
    for (const {
      rect_px: [x, y, w, h],
    } of CRYPT_MAP.rooms) {
      expect(at(x + w / 2, y + h / 2)).toBe(1);
      expect(at(x, y)).toBe(2);
      expect(at(x + w - 1, y + h - 1)).toBe(2);
      expect(at(x + 4, y + h / 2)).toBe(1);
    }
    for (const [x, y, w, h] of CRYPT_MAP.corridors) expect(at(x + w / 2, y + h / 2)).toBe(1);
    // Numeral pixels exist for each room and lie only inside its digit box.
    const boxes = CRYPT_MAP.rooms.map(({ rect_px: [x, y] }) => [x + 30, y + 30, 60, 84] as Rect);
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (at(x, y) !== 3) continue;
        count++;
        expect(
          boxes.some(([bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh),
        ).toBe(true);
      }
    }
    for (const [bx, by] of boxes) {
      let inBox = 0;
      for (let y = by; y < by + 84; y++)
        for (let x = bx; x < bx + 60; x++) if (at(x, y) === 3) inBox++;
      expect(inBox).toBeGreaterThan(0);
    }
    expect(count).toBeGreaterThan(0);
  });

  test("crypt-map.png decodes to rasterCryptMap() exactly", async () => {
    const png = new Uint8Array(await readFile(exampleAssetPath(CRYPT_MAP.file)));
    expect(png.length).toBeLessThan(200 * 1024);
    const { chunks, pixels } = decode(png, width, height);
    const plte = chunks.find((c) => c.type === "PLTE")?.data;
    expect([...(plte ?? [])]).toEqual([
      0x2b, 0x2b, 0x2b, 0xb8, 0xa8, 0x88, 0x5a, 0x4a, 0x3a, 0x1a, 0x1a, 0x1a,
    ]);
    expect(pixels).toEqual(rasterCryptMap());
  });
});

describe("goblin image", () => {
  const { width_px: width, height_px: height } = GOBLIN_IMAGE;

  test("GOBLIN_IMAGE is a 128 px square", () => {
    expect(GOBLIN_IMAGE).toEqual({ file: "goblin.png", width_px: 128, height_px: 128 });
  });

  test("the raster is a green disc of radius 60 on transparency", () => {
    const pixels = rasterGoblin();
    expect(pixels.length).toBe(width * height);
    expect(pixels[64 * width + 64]).toBe(1);
    expect(pixels[0]).toBe(0);
    expect(pixels[64 * width + 4]).toBe(1);
    expect(pixels[64 * width + 3]).toBe(0);
  });

  test("goblin.png decodes to rasterGoblin() exactly, index 0 transparent", async () => {
    const png = new Uint8Array(await readFile(exampleAssetPath(GOBLIN_IMAGE.file)));
    expect(png.length).toBeLessThan(200 * 1024);
    const { chunks, pixels } = decode(png, width, height);
    const plte = chunks.find((c) => c.type === "PLTE")?.data;
    expect([...(plte ?? [])].slice(3, 6)).toEqual([0x4f, 0x8a, 0x3a]);
    const trns = chunks.find((c) => c.type === "tRNS")?.data;
    expect([...(trns ?? [])]).toEqual([0, 255]);
    expect(pixels).toEqual(rasterGoblin());
  });
});

test("exampleAssetPath is absolute and under packages/fixtures/assets", () => {
  const path = exampleAssetPath("goblin.png");
  expect(path).toMatch(/^(\/|[A-Za-z]:\\)/);
  expect(path).toMatch(/[\\/]packages[\\/]fixtures[\\/]assets[\\/]goblin\.png$/);
});
