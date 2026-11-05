/** A point in board units. */
export type Point = [number, number];

/**
 * A region or outline, relative to its object's anchor. Positivity and
 * polygon simplicity are document invariants, not checked by the value guard.
 */
export type Shape =
  | { type: "rect"; width: number; height: number }
  | { type: "circle"; radius: number }
  | { type: "polygon"; points: Point[] };

/** An axis-aligned box in board units. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
