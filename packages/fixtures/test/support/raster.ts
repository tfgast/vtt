import { CRYPT_MAP, GOBLIN_IMAGE, type Rect } from "@vtt/fixtures";

/** Palette of crypt-map.png: rock, floor, wall, numeral. */
export const CRYPT_PALETTE = ["#2b2b2b", "#b8a888", "#5a4a3a", "#1a1a1a"] as const;
/** Palette of goblin.png: transparent (via tRNS), green. */
export const GOBLIN_PALETTE = ["#000000", "#4f8a3a"] as const;

const ROCK = 0;
const FLOOR = 1;
const WALL = 2;
const NUMERAL = 3;
const WALL_PX = 4;
const DIGIT_SCALE = 12;
const DIGIT_OFFSET = 30;

/** 5 × 7 digit bitmaps, one string per row, `#` set. */
const DIGITS: Record<number, readonly string[]> = {
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
};

function fill(pixels: Uint8Array, width: number, [x, y, w, h]: Rect, index: number): void {
  for (let row = y; row < y + h; row++) pixels.fill(index, row * width + x, row * width + x + w);
}

/** The crypt map as one palette index per pixel, row-major. */
export function rasterCryptMap(): Uint8Array {
  const { width_px: width, height_px: height } = CRYPT_MAP;
  const pixels = new Uint8Array(width * height).fill(ROCK);
  for (const corridor of CRYPT_MAP.corridors) fill(pixels, width, corridor, FLOOR);
  for (const { n, rect_px } of CRYPT_MAP.rooms) {
    const [x, y, w, h] = rect_px;
    fill(pixels, width, rect_px, WALL);
    fill(pixels, width, [x + WALL_PX, y + WALL_PX, w - 2 * WALL_PX, h - 2 * WALL_PX], FLOOR);
    const bitmap = DIGITS[n] as readonly string[];
    bitmap.forEach((line, row) => {
      [...line].forEach((cell, col) => {
        if (cell !== "#") return;
        const left = x + DIGIT_OFFSET + col * DIGIT_SCALE;
        const top = y + DIGIT_OFFSET + row * DIGIT_SCALE;
        fill(pixels, width, [left, top, DIGIT_SCALE, DIGIT_SCALE], NUMERAL);
      });
    });
  }
  return pixels;
}

/** The goblin as one palette index per pixel: 1 within 60 px of [64, 64], else 0. */
export function rasterGoblin(): Uint8Array {
  const { width_px: width, height_px: height } = GOBLIN_IMAGE;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - 64) ** 2 + (y - 64) ** 2 <= 60 ** 2) pixels[y * width + x] = 1;
    }
  }
  return pixels;
}
