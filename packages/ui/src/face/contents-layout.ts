/**
 * Grid and fan arrangements of a contents element's entries (DESIGN.md §4.6
 * Face elements, contents `layout`; §4.7 hands and trays; M6-D30). Pure:
 * where each entry's tile goes, element-local (origin at the element rect's
 * top-left, y down). The face model builds entries on these slots, the
 * painter draws them and hit testing reads them back. The list layout is
 * the face model's own rows (M5) and is not here.
 */
import type { Point, Rect } from "@vtt/schema";
import { type Affine, apply, compose, IDENTITY, rotate, translate } from "./face-transform";

/** A tile's width over its height (a playing card's 5:7). */
export const TILE_ASPECT = 5 / 7;
/** A grid cell's height, in list rows (a list row is a tenth of the element's width). */
export const GRID_CELL_ROWS = 4;
/** The gap between grid cells, as a fraction of the cell's width. */
export const GRID_GAP_RATIO = 0.05;
/** A tile's header (chevron and gear) height, as a fraction of the tile's width. */
export const TILE_HEADER_RATIO = 0.25;
/** The angle between neighbouring fan cards, in degrees, while the spread allows it. */
export const FAN_STEP_DEG = 7;
/** The widest fan, first card to last, in degrees. */
export const FAN_SPREAD_DEG = 42;
/** The fan's pivot below a card's bottom edge, in card heights. */
export const FAN_RADIUS = 3;

/**
 * One entry's place: `rect` upright, element-local, and `turn` (element-local
 * → element-local) rotating it into place. Grid tiles have no turn
 * (`IDENTITY`); fan cards turn about the fan's common pivot.
 */
export interface TileSlot {
  rect: Rect;
  turn: Affine;
}

/** The parts of a tile `rect` (upright, in its slot frame): header, chevron and body. */
export interface TileParts {
  /** The strip along the top holding the chevron, the collapsed face and the gear. */
  header: Rect;
  chevron: Rect;
  /** Below the header: where an expanded entry's drawing is fitted. */
  body: Rect;
}

/**
 * The grid cells of `count` entries in an element of `rect`'s size: left to
 * right, then top to bottom, from the top-left corner. A cell is
 * `GRID_CELL_ROWS` list rows high (at most the element's height) and
 * `TILE_ASPECT` as wide (at most the element's width), with
 * `GRID_GAP_RATIO` gaps between cells; as many columns as fit, at least
 * one. Rows past the element's height are still laid out (the painter
 * clips them; a grid does not scroll).
 */
export function gridSlots(rect: Rect, count: number): TileSlot[] {
  const [, , w, h] = rect;
  const rowH = w / 10;
  const cellH = Math.min(h, GRID_CELL_ROWS * rowH);
  const cellW = Math.min(w, cellH * TILE_ASPECT);
  const gap = cellW * GRID_GAP_RATIO;
  const columns = Math.max(1, Math.floor((w + gap) / (cellW + gap)));
  const out: TileSlot[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    out.push({ rect: [col * (cellW + gap), row * (cellH + gap), cellW, cellH], turn: IDENTITY });
  }
  return out;
}

/** The fan angle of each of `count` cards, in degrees clockwise, symmetric about 0. */
export function fanAngles(count: number): number[] {
  const step = count > 1 ? Math.min(FAN_STEP_DEG, FAN_SPREAD_DEG / (count - 1)) : 0;
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * step);
}

/** `deg` degrees clockwise about `pivot`. */
export function rotateAbout(pivot: Point, deg: number): Affine {
  if (deg === 0) return IDENTITY;
  return compose(translate(pivot[0], pivot[1]), rotate(deg), translate(-pivot[0], -pivot[1]));
}

/**
 * The fan of `count` cards in an element of `rect`'s size: upright cards of
 * `TILE_ASPECT` stood on a circle about a common pivot `FAN_RADIUS` card
 * heights below them, each turned by its `fanAngles` angle about it, then
 * the whole fan scaled uniformly and centred to fit the element (so it is
 * never clipped). List order is drawing order: the last card is on top.
 */
export function fanSlots(rect: Rect, count: number): TileSlot[] {
  if (count === 0) return [];
  const [, , w, h] = rect;
  // A unit fan: card height 1, pivot at the origin.
  const tw = TILE_ASPECT;
  const card: Rect = [-tw / 2, -FAN_RADIUS - 1, tw, 1];
  const angles = fanAngles(count);
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const deg of angles) {
    const t = rotate(deg);
    const [x, y, cw, ch] = card;
    for (const corner of [
      [x, y],
      [x + cw, y],
      [x + cw, y + ch],
      [x, y + ch],
    ] as Point[]) {
      const [px, py] = apply(t, corner);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }
  const s = Math.min(w / (maxX - minX), h / (maxY - minY));
  const pivot: Point = [w / 2 - (s * (minX + maxX)) / 2, h / 2 - (s * (minY + maxY)) / 2];
  const upright: Rect = [pivot[0] + s * card[0], pivot[1] + s * card[1], s * tw, s];
  return angles.map((deg) => ({ rect: [...upright], turn: rotateAbout(pivot, deg) }));
}

/** The slots of `count` entries for a grid or fan element of `rect`'s size. */
export function tileSlots(layout: "grid" | "fan", rect: Rect, count: number): TileSlot[] {
  return layout === "grid" ? gridSlots(rect, count) : fanSlots(rect, count);
}

/**
 * The parts of a tile: a header `TILE_HEADER_RATIO` of the width high (at
 * most half the tile), its chevron a square at the header's left, and the
 * body below.
 */
export function tileParts(tile: Rect): TileParts {
  const [x, y, w, h] = tile;
  const hh = Math.min(w * TILE_HEADER_RATIO, h / 2);
  return {
    header: [x, y, w, hh],
    chevron: [x, y, hh, hh],
    body: [x, y + hh, w, h - hh],
  };
}

/**
 * Maps `from` into `to` with one uniform scale (the smaller of the two
 * fits), centred in `to`.
 */
export function fitCentred(from: Rect, to: Rect): Affine {
  const s = Math.min(to[2] / from[2], to[3] / from[3]);
  const x = to[0] + (to[2] - from[2] * s) / 2;
  const y = to[1] + (to[3] - from[3] * s) / 2;
  return [s, 0, 0, s, x - from[0] * s, y - from[1] * s];
}
