// Writes packages/fixtures/assets/crypt-map.png and goblin.png from the
// rasters in ./raster. Run once from the repo root and commit the output:
//   node --import tsx packages/fixtures/test/support/write-assets.ts
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { CRYPT_MAP, exampleAssetPath, GOBLIN_IMAGE } from "@vtt/fixtures";
import { CRYPT_PALETTE, GOBLIN_PALETTE, rasterCryptMap, rasterGoblin } from "./raster";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const rgb = (hex: string): number[] =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/**
 * An 8-bit palette PNG (colour type 3) of `pixels`, one index per pixel,
 * filter 0 on every scanline; `alpha`, when given, becomes a tRNS chunk.
 */
export function encodePalettePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  palette: readonly string[],
  alpha?: readonly number[],
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return concat([
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("PLTE", new Uint8Array(palette.flatMap(rgb))),
    ...(alpha ? [chunk("tRNS", new Uint8Array(alpha))] : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

async function main(): Promise<void> {
  await mkdir(exampleAssetPath("."), { recursive: true });
  const map = encodePalettePng(
    rasterCryptMap(),
    CRYPT_MAP.width_px,
    CRYPT_MAP.height_px,
    CRYPT_PALETTE,
  );
  const goblin = encodePalettePng(
    rasterGoblin(),
    GOBLIN_IMAGE.width_px,
    GOBLIN_IMAGE.height_px,
    GOBLIN_PALETTE,
    [0, 255],
  );
  for (const [file, bytes] of [
    [CRYPT_MAP.file, map],
    [GOBLIN_IMAGE.file, goblin],
  ] as const) {
    await writeFile(exampleAssetPath(file), bytes);
    console.log(`${exampleAssetPath(file)}: ${bytes.length} bytes`);
  }
}

await main();
