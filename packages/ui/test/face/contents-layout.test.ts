// @vitest-environment node
/**
 * Grid and fan slots of a contents element (vtt-qf5.28; DESIGN.md §4.6
 * contents `layout`, §4.7; M6-D30): pure geometry.
 */
import type { Point, Rect } from "@vtt/schema";
import {
  apply,
  FAN_SPREAD_DEG,
  FAN_STEP_DEG,
  fanAngles,
  fanSlots,
  fitCentred,
  GRID_CELL_ROWS,
  GRID_GAP_RATIO,
  gridSlots,
  IDENTITY,
  TILE_ASPECT,
  TILE_HEADER_RATIO,
  type TileSlot,
  tileParts,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const corners = ([x, y, w, h]: Rect): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe("gridSlots", () => {
  test("cells in rows, left to right then top to bottom, sized from the list row", () => {
    // A 10 × 3 element: list rows are 1 high; a cell is min(3, 4) = 3 high, 15/7 wide.
    const slots = gridSlots([5, 5, 10, 3], 6);
    const cellH = Math.min(3, GRID_CELL_ROWS * 1);
    const cellW = cellH * TILE_ASPECT;
    const gap = cellW * GRID_GAP_RATIO;
    const columns = Math.floor((10 + gap) / (cellW + gap));
    expect(columns).toBe(4);
    expect(slots).toHaveLength(6);
    slots.forEach((s, i) => {
      expect(s.turn).toEqual(IDENTITY);
      const [x, y, w, h] = s.rect;
      near(x, (i % columns) * (cellW + gap));
      near(y, Math.floor(i / columns) * (cellH + gap));
      near(w, cellW);
      near(h, cellH);
    });
    // The first row stays inside the element's width; the fifth entry wraps.
    const lastOfRow = slots[3]?.rect as Rect;
    expect(lastOfRow[0] + lastOfRow[2]).toBeLessThanOrEqual(10);
    expect(slots[4]?.rect[0]).toBe(0);
  });

  test("a short element: cells as high as it, more of them to a row", () => {
    const slots = gridSlots([0, 0, 4, 0.5], 12);
    expect(slots[0]?.rect[3]).toBe(0.5);
    // 0.5 × 5/7 wide with 5 % gaps: ten to a row; the eleventh wraps below the element.
    expect(slots.filter((s) => s.rect[1] === 0)).toHaveLength(10);
    expect(slots[10]?.rect[0]).toBe(0);
    expect(slots[10]?.rect[1]).toBeGreaterThan(0.5);
  });

  test("no entries, no slots", () => {
    expect(gridSlots([0, 0, 4, 4], 0)).toEqual([]);
  });
});

describe("fanAngles", () => {
  test("symmetric about zero, FAN_STEP_DEG apart until the spread caps them", () => {
    expect(fanAngles(0)).toEqual([]);
    expect(fanAngles(1)).toEqual([0]);
    expect(fanAngles(3)).toEqual([-FAN_STEP_DEG, 0, FAN_STEP_DEG]);
    const many = fanAngles(13);
    near((many.at(-1) as number) - (many[0] as number), FAN_SPREAD_DEG);
    near(many[6] as number, 0);
  });
});

describe("fanSlots", () => {
  const element: Rect = [0, 0, 8, 2];

  test("every card fits inside the element, upright cards of TILE_ASPECT", () => {
    for (const n of [1, 2, 5, 12]) {
      for (const s of fanSlots(element, n)) {
        near(s.rect[2] / s.rect[3], TILE_ASPECT);
        for (const c of corners(s.rect)) {
          const [x, y] = apply(s.turn, c);
          expect(x).toBeGreaterThanOrEqual(-1e-9);
          expect(x).toBeLessThanOrEqual(8 + 1e-9);
          expect(y).toBeGreaterThanOrEqual(-1e-9);
          expect(y).toBeLessThanOrEqual(2 + 1e-9);
        }
      }
    }
  });

  test("one card is upright and as tall as the element, centred", () => {
    const [only] = fanSlots(element, 1);
    expect(only?.turn).toEqual(IDENTITY);
    const [x, y, w, h] = (only as TileSlot).rect;
    near(h, 2);
    near(y, 0);
    near(x + w / 2, 4);
  });

  test("cards turn about one pivot below them, left to right, and overlap", () => {
    const slots = fanSlots(element, 5);
    // The same upright rect for every card; only the turn differs.
    for (const s of slots) expect(s.rect).toEqual(slots[0]?.rect);
    const [x, y, w, h] = (slots[0] as TileSlot).rect;
    const pivot: Point = [x + w / 2, y + h + 3 * h];
    for (const s of slots) {
      const p = apply(s.turn, pivot);
      near(p[0], pivot[0]);
      near(p[1], pivot[1]);
    }
    const tops = slots.map((s) => apply(s.turn, [x + w / 2, y])[0]);
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1] as number);
      // Neighbours are closer than a card is wide: they overlap.
      expect((tops[i] as number) - (tops[i - 1] as number)).toBeLessThan(w);
    }
    // The middle card is upright; the first leans left (counterclockwise).
    expect(slots[2]?.turn).toEqual(IDENTITY);
    expect(slots[0]?.turn[1]).toBeLessThan(0);
  });

  test("no entries, no slots", () => {
    expect(fanSlots(element, 0)).toEqual([]);
  });
});

describe("tileParts and fitCentred", () => {
  test("a header TILE_HEADER_RATIO of the width high, its chevron square, the body below", () => {
    const parts = tileParts([1, 2, 2, 4]);
    const hh = 2 * TILE_HEADER_RATIO;
    expect(parts.header).toEqual([1, 2, 2, hh]);
    expect(parts.chevron).toEqual([1, 2, hh, hh]);
    expect(parts.body).toEqual([1, 2 + hh, 2, 4 - hh]);
  });

  test("fitCentred scales uniformly and centres", () => {
    const m = fitCentred([-1, -1, 2, 2], [0, 0, 4, 2]);
    expect(apply(m, [-1, -1])).toEqual([1, 0]);
    expect(apply(m, [1, 1])).toEqual([3, 2]);
  });
});
