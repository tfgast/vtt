/**
 * Geometry reads and query plumbing for the spatial functions (FORMULAS.md
 * §5, §6; DESIGN.md §4.3). Used only by queries.ts. The shared geometry
 * readings and id order live in geometry.ts.
 */
import {
  type Bounds,
  EMPTY,
  type ErrorValue,
  err,
  list,
  type ObjectId,
  type Point,
  type Result,
  ref,
  type Shape,
} from "@vtt/schema";
import type { EvalEnv } from "../host";
import { anchorOf, compareIds, geometryNumber } from "./geometry";

/** An object's geometry cells as read, in read order. A missing cell reads as empty. */
export interface RawGeometry {
  readonly board: Result;
  readonly position: Result;
  readonly rotation: Result;
  readonly z: Result;
  readonly shape: Result;
  readonly isZone: Result;
}

/** The geometry cells, in the order they are read. */
const GEOMETRY_CELLS = ["board", "position", "rotation", "z", "shape", "is_zone"] as const;

/**
 * Reads every geometry cell of `id` through `env.read` (each a recorded,
 * charged dependency in the engine), in GEOMETRY_CELLS order. The first
 * error read is the result.
 */
export function readGeometry(env: EvalEnv, id: ObjectId): RawGeometry | ErrorValue {
  const out: Result[] = [];
  for (const cell of GEOMETRY_CELLS) {
    const r = env.read(id, cell) ?? EMPTY;
    if (failed(r)) return r;
    out.push(r);
  }
  const [board, position, rotation, z, shape, isZone] = out as [
    Result,
    Result,
    Result,
    Result,
    Result,
    Result,
  ];
  return { board, position, rotation, z, shape, isZone };
}

/** An object placed on a board with a valid position: a footprint plus its board and z. */
export interface Placed {
  readonly id: ObjectId;
  readonly board: ObjectId;
  readonly anchor: Point;
  /** Degrees clockwise about the anchor; empty read as 0. */
  readonly rotation: number;
  /** Empty read as 0, a roll result as its total. */
  readonly z: number;
  /** `null` for a shapeless object: a point footprint. */
  readonly shape: Shape | null;
  readonly isZone: boolean;
}

/** `is_zone` is true only for the boolean `true`. */
export function isTrue(r: Result): boolean {
  return r.type === "boolean" && r.value;
}

/**
 * The placement of `id` from its raw geometry: `null` when it is not on a
 * board or its position is not two finite numbers (excluded, not an
 * error); `#TYPE` when a placed object's rotation, z, or shape has the
 * wrong kind.
 */
export function place(id: ObjectId, raw: RawGeometry): Placed | ErrorValue | null {
  if (raw.board.type !== "ref") return null;
  const anchor = anchorOf(raw.position);
  if (anchor === undefined) return null;
  const rotation = geometryNumber(raw.rotation);
  if (rotation === undefined || !Number.isFinite(rotation)) {
    return err("#TYPE", `rotation of ${id} is not a finite number`);
  }
  const z = geometryNumber(raw.z);
  if (z === undefined) return err("#TYPE", `z of ${id} is not a number`);
  let shape: Shape | null;
  if (raw.shape.type === "shape") shape = raw.shape.shape;
  else if (raw.shape.type === "empty") shape = null;
  else return err("#TYPE", `shape of ${id} is not a shape`);
  return { id, board: raw.board.object, anchor, rotation, z, shape, isZone: isTrue(raw.isZone) };
}

/** Reads and places `id`, for a query subject or candidate. */
export function readPlaced(env: EvalEnv, id: ObjectId): Placed | ErrorValue | null {
  const raw = readGeometry(env, id);
  return failed(raw) ? raw : place(id, raw);
}

/** Distinct ids in code point order. */
export function sortedIds(ids: Iterable<ObjectId>): ObjectId[] {
  return [...new Set(ids)].sort(compareIds);
}

/** Query order (FORMULAS §5): ascending z, then id in code point order. */
export function queryResult(items: readonly { id: ObjectId; z: number }[]): Result {
  const sorted = [...items].sort((a, b) =>
    a.z !== b.z ? (a.z < b.z ? -1 : 1) : compareIds(a.id, b.id),
  );
  return list(sorted.map((item) => ref(item.id)));
}

/**
 * Tests the candidates `env.objectsOnBoard(board, near)` in id order:
 * `skip` (the query's subject) is never read; an error from a candidate's
 * geometry is the result; a candidate not placed, or placed on another
 * board, is excluded; otherwise `keep` decides. Kept candidates come back
 * in query order.
 */
export function scanBoard(
  env: EvalEnv,
  board: ObjectId,
  near: Bounds,
  skip: ObjectId,
  keep: (candidate: Placed) => boolean,
): Result {
  const kept: Placed[] = [];
  for (const id of sortedIds(env.objectsOnBoard(board, near))) {
    if (id === skip) continue;
    const c = readPlaced(env, id);
    if (c === null) continue;
    if (failed(c)) return c;
    if (c.board === board && keep(c)) kept.push(c);
  }
  return queryResult(kept);
}

/** Whether `x`, a result or something else entirely, is an error. */
export function failed<T>(x: T | ErrorValue): x is ErrorValue {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "error";
}
