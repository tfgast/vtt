/**
 * Queries and spatial functions (FORMULAS.md §3, §5, §6, §7; DESIGN.md
 * §4.3): `contents`, `zones_containing`, `on`, `distance`, `objects`, `obj`.
 * Registered into the default registry.
 *
 * The host supplies candidates over literal geometry; membership, overlap,
 * and distance are computed here with the schema geometry, reading every
 * geometry cell through `env.read`. None of these broadcast: a list
 * argument is `#TYPE`.
 */
import {
  anchorDistance,
  EMPTY,
  type ErrorValue,
  err,
  footprintsOverlap,
  num,
  type ObjectId,
  type Point,
  pointInRegion,
  type Result,
  ref,
  shapeBounds,
} from "@vtt/schema";
import { itemScope } from "../eval/scope";
import { truthy } from "../eval/values";
import type { EvalEnv } from "../host";
import type { Expr } from "../syntax/ast";
import type { FunctionDef } from "./registry";
import {
  anchorOf,
  failed,
  geometryNumber,
  isTrue,
  place,
  queryResult,
  readGeometry,
  readPlaced,
  scanBoard,
  sortedIds,
} from "./spatial";

/** The object `arg` refers to: `#TYPE` unless a reference, `#REF` if deleted. */
function subject(env: EvalEnv, name: string, arg: Result | undefined): ObjectId | ErrorValue {
  if (arg?.type !== "ref") {
    return err("#TYPE", `${name} takes a reference, got ${arg?.type ?? "nothing"}`);
  }
  if (!env.exists(arg.object)) return err("#REF", `reference to deleted object ${arg.object}`);
  return arg.object;
}

/**
 * `contents(zone)`: objects on the zone's board whose anchor lies in its
 * region, boundary inclusive, excluding the zone.
 */
function contents(env: EvalEnv, arg: Result | undefined): Result {
  const id = subject(env, "contents", arg);
  if (failed(id)) return id;
  const raw = readGeometry(env, id);
  if (failed(raw)) return raw;
  if (!isTrue(raw.isZone)) return err("#TYPE", `contents takes a zone; ${id} is not a zone`);
  const zone = place(id, raw);
  if (zone === null) return queryResult([]);
  if (failed(zone)) return zone;
  const region = zone.shape;
  if (region === null) return queryResult([]);
  const near = shapeBounds(region, zone.anchor, zone.rotation);
  return scanBoard(env, zone.board, near, id, (c) =>
    pointInRegion(c.anchor, region, zone.anchor, zone.rotation),
  );
}

/** `zones_containing(obj)`: zones on the object's board whose region holds its anchor. */
function zonesContaining(env: EvalEnv, arg: Result | undefined): Result {
  const id = subject(env, "zones_containing", arg);
  if (failed(id)) return id;
  const o = readPlaced(env, id);
  if (o === null) return queryResult([]);
  if (failed(o)) return o;
  const [x, y] = o.anchor;
  const near = { minX: x, minY: y, maxX: x, maxY: y };
  return scanBoard(
    env,
    o.board,
    near,
    id,
    (c) => c.isZone && c.shape !== null && pointInRegion(o.anchor, c.shape, c.anchor, c.rotation),
  );
}

/** `on(obj)`: non-zones above `obj` in z whose footprint overlaps its own, nearest first. */
function on(env: EvalEnv, arg: Result | undefined): Result {
  const id = subject(env, "on", arg);
  if (failed(id)) return id;
  const o = readPlaced(env, id);
  if (o === null) return queryResult([]);
  if (failed(o)) return o;
  const near = shapeBounds(o.shape, o.anchor, o.rotation);
  return scanBoard(
    env,
    o.board,
    near,
    id,
    (c) => !c.isZone && c.z > o.z && footprintsOverlap(c, o),
  );
}

/** `distance(a, b)`: Euclidean between anchors, in raw board units. */
function distance(env: EvalEnv, args: readonly Result[]): Result {
  const a = subject(env, "distance", args[0]);
  if (failed(a)) return a;
  const b = subject(env, "distance", args[1]);
  if (failed(b)) return b;
  const placements: { board: ObjectId; anchor: Point }[] = [];
  let placedBoth = true;
  for (const id of [a, b]) {
    const board = env.read(id, "board") ?? EMPTY;
    if (failed(board)) return board;
    const position = env.read(id, "position") ?? EMPTY;
    if (failed(position)) return position;
    const anchor = anchorOf(position);
    if (board.type !== "ref" || anchor === undefined) placedBoth = false;
    else placements.push({ board: board.object, anchor });
  }
  const [pa, pb] = placements;
  if (!placedBoth || pa === undefined || pb === undefined) return EMPTY;
  if (pa.board !== pb.board) return err("#TYPE", "distance across boards");
  const d = anchorDistance(pa.anchor, pb.anchor);
  // FORMULAS §4: a non-finite arithmetic result is #TYPE.
  if (!Number.isFinite(d)) return err("#TYPE", "result is not a finite number");
  return num(d);
}

/**
 * `objects(expr)`: every object, in id order, for which `expr` is truthy
 * with the object as `it` and bare names its cells. The first error is the
 * result. Results in query order (z read as for spatial queries).
 */
const objects: FunctionDef = {
  name: "objects",
  minArgs: 1,
  maxArgs: 1,
  kind: "lazy",
  broadcast: "none",
  impl: (args, ctx) => {
    const expr = args[0] as Expr;
    const kept: { id: ObjectId; z: number }[] = [];
    for (const id of sortedIds(ctx.env.allObjects())) {
      const r = ctx.evaluate(expr, itemScope(ctx.scope, ref(id)));
      if (failed(r)) return r;
      if (!truthy(r)) continue;
      const zr = ctx.env.read(id, "z") ?? EMPTY;
      if (failed(zr)) return zr;
      const z = geometryNumber(zr);
      if (z === undefined) return err("#TYPE", `z of ${id} is not a number`);
      kept.push({ id, z });
    }
    return queryResult(kept);
  },
};

/** `obj(x)`: an exact id, else the one object whose literal name is `x`, else `#REF`. */
function obj(env: EvalEnv, x: Result | undefined): Result {
  if (x?.type !== "text") return err("#TYPE", `obj takes text, got ${x?.type ?? "nothing"}`);
  if (env.exists(x.value)) return ref(x.value);
  const found = sortedIds(env.objectsNamed(x.value));
  if (found.length !== 1) {
    return err("#REF", `${found.length} objects are named ${JSON.stringify(x.value)}`);
  }
  const id = found[0] as ObjectId;
  // Read the name so the evaluating cell depends on it (FORMULAS §3).
  const name = env.read(id, "name");
  if (name !== undefined && failed(name)) return name;
  return ref(id);
}

/** An eager, non-broadcasting function of fixed arity. */
function eager(
  name: string,
  arity: number,
  impl: (env: EvalEnv, args: readonly Result[]) => Result,
): FunctionDef {
  return {
    name,
    minArgs: arity,
    maxArgs: arity,
    kind: "eager",
    broadcast: "none",
    impl: (args, ctx) => impl(ctx.env, args),
  };
}

export const QUERY_FUNCTIONS: readonly FunctionDef[] = [
  eager("contents", 1, (env, [zone]) => contents(env, zone)),
  eager("zones_containing", 1, (env, [o]) => zonesContaining(env, o)),
  eager("on", 1, (env, [o]) => on(env, o)),
  eager("distance", 2, distance),
  objects,
  eager("obj", 1, (env, [x]) => obj(env, x)),
];
