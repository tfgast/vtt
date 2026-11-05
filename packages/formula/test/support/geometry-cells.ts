/**
 * Geometry cells for query tests over FakeEnv: objects placed on a board, and
 * an env that logs reads and candidate requests.
 */
import {
  type Bounds,
  bool,
  list,
  num,
  type ObjectId,
  type Result,
  ref,
  type Shape,
  shape as shapeValue,
} from "@vtt/schema";
import { FakeEnv } from "./fake-env";

export interface Placement {
  shape?: Shape;
  rotation?: number;
  z?: number;
  isZone?: boolean;
  /** Extra cells, merged last (so they may replace a geometry cell). */
  cells?: Record<string, Result>;
}

/** The cells of an object at `position` on `board`. */
export function placed(
  board: ObjectId,
  position: [number, number],
  options: Placement = {},
): Record<string, Result> {
  const cells: Record<string, Result> = {
    board: ref(board),
    position: list([num(position[0]), num(position[1])]),
  };
  if (options.rotation !== undefined) cells.rotation = num(options.rotation);
  if (options.z !== undefined) cells.z = num(options.z);
  if (options.shape !== undefined) cells.shape = shapeValue(options.shape);
  if (options.isZone !== undefined) cells.is_zone = bool(options.isZone);
  return { ...cells, ...options.cells };
}

/** A zone with `region` at `position` on `board`. */
export function zone(
  board: ObjectId,
  position: [number, number],
  region: Shape,
  options: Omit<Placement, "shape" | "isZone"> = {},
): Record<string, Result> {
  return placed(board, position, { ...options, shape: region, isZone: true });
}

/** A FakeEnv that records every read and every `objectsOnBoard` request. */
export class LoggingEnv extends FakeEnv {
  readonly reads: string[] = [];
  readonly nearCalls: { board: ObjectId; near: Bounds }[] = [];

  override read(id: ObjectId, cell: string): Result | undefined {
    this.reads.push(`${id}.${cell}`);
    return super.read(id, cell);
  }

  override objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[] {
    this.nearCalls.push({ board, near });
    return super.objectsOnBoard(board, near);
  }
}
