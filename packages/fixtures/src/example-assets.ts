import { join } from "node:path";

/** A pixel rectangle `[x, y, w, h]` from an image's top-left corner. */
export type Rect = [x: number, y: number, w: number, h: number];

/** A numbered room of the example crypt map. */
export interface Room {
  n: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  rect_px: Rect;
}

/**
 * The example dungeon map (DESIGN.md §8.4 step 3; M6 plan Q11): a 2400 ×
 * 1600 px PNG imported at 100 px per board unit (M4 plan Q21), so 24 × 16
 * units. Each room is floor with a 4 px wall along its inside edge and its
 * number drawn at `[x + 30, y + 30]`; corridors are floor without walls.
 */
export const CRYPT_MAP: {
  readonly file: "crypt-map.png";
  readonly width_px: 2400;
  readonly height_px: 1600;
  readonly px_per_unit: 100;
  readonly rooms: readonly Room[];
  readonly corridors: readonly Rect[];
} = {
  file: "crypt-map.png",
  width_px: 2400,
  height_px: 1600,
  px_per_unit: 100,
  rooms: [
    { n: 1, name: "Entrance", rect_px: [100, 1100, 500, 400] },
    { n: 2, name: "Hall", rect_px: [700, 1100, 500, 400] },
    { n: 3, name: "Guard room", rect_px: [1300, 900, 700, 600] },
    { n: 4, name: "Stair", rect_px: [100, 100, 600, 600] },
    { n: 5, name: "Barracks", rect_px: [900, 100, 700, 600] },
    { n: 6, name: "Shrine", rect_px: [1800, 100, 500, 600] },
  ],
  corridors: [
    [600, 1250, 100, 100],
    [1200, 1250, 100, 100],
    [300, 700, 100, 400],
    [1400, 700, 100, 200],
    [1600, 300, 200, 100],
  ],
};

/** The example goblin token image (DESIGN.md §8.4 step 4): a green disc on transparency. */
export const GOBLIN_IMAGE: {
  readonly file: "goblin.png";
  readonly width_px: 128;
  readonly height_px: 128;
} = { file: "goblin.png", width_px: 128, height_px: 128 };

/** The absolute path of an example asset file under `packages/fixtures/assets/`. */
export function exampleAssetPath(file: string): string {
  return join(import.meta.dirname, "..", "assets", file);
}
