/**
 * The engine's recording `EvalEnv` (FORMULAS.md §6, §7): one per evaluation
 * attempt. It records every dependency the attempt touches, charges the
 * attempt's budget (budget.ts), reads literals through `validateRefs`, and
 * serves memoized formula results. What a read of an uncomputed formula cell
 * returns is the caller's business (`uncomputed`): the resolver's pending
 * marker and cycle detection, or ad hoc evaluation's collection.
 *
 * The query methods call the host, which never evaluates: the candidate set
 * is defined over literal geometry. Each records an `index` dependency. The
 * evaluator then reads candidates' geometry through `read`, so formula
 * positions are ordinary cell dependencies and can close a cycle.
 */
import type { Bounds, ObjectId, Result } from "@vtt/schema";
import { validateRefs } from "../eval/refs";
import { type CellKey, cellKey, type Dependency, type EvalEnv, type EvalHost } from "../host";
import { Budget } from "./budget";
import { dependencyKey } from "./graph";

export interface RecordingEnvOptions {
  readonly host: EvalHost;
  /** Units this attempt may spend. */
  readonly budget: number;
  /** Incremented once per `read`. */
  readonly stats: { reads: number };
  /** The clean memoized result of `key`, or `undefined` if uncomputed or dirty. */
  memoized(key: CellKey): Result | undefined;
  /** The value a read of the formula cell `key` with no clean memo sees. */
  uncomputed(key: CellKey, id: ObjectId, cell: string): Result;
}

export interface RecordingEnv extends EvalEnv {
  /** The dependencies recorded so far, each once, in first-touch order. */
  dependencies(): Dependency[];
  /** This attempt's spending. */
  readonly budget: Budget;
}

const INDEX: Dependency = { type: "index" };

export function createRecordingEnv(o: RecordingEnvOptions): RecordingEnv {
  const { host } = o;
  const deps = new Map<string, Dependency>();
  const budget = new Budget(o.budget);
  const record = (dep: Dependency) => {
    const k = dependencyKey(dep);
    if (!deps.has(k)) deps.set(k, dep);
  };
  /** Record before charging: an aborted attempt's outcome still depends on what it touched. */
  const enumerate = (ids: ObjectId[]): ObjectId[] => {
    budget.charge(new Set(ids).size);
    return ids;
  };
  const exists = (id: ObjectId): boolean => {
    record({ type: "exists", object: id });
    budget.charge();
    return host.exists(id);
  };
  return {
    budget,
    dependencies: () => [...deps.values()],
    exists,
    read(id, cell) {
      o.stats.reads++;
      record({ type: "cell", object: id, cell });
      budget.charge();
      const c = host.cell(id, cell);
      if (c === undefined) return undefined;
      if (c.type !== "formula") return validateRefs(c, exists);
      const key = cellKey(id, cell);
      return o.memoized(key) ?? o.uncomputed(key, id, cell);
    },
    objectsNamed(name) {
      record(INDEX);
      return enumerate(host.objectsNamed(name));
    },
    allObjects() {
      record(INDEX);
      return enumerate(host.allObjects());
    },
    objectsOnBoard(board: ObjectId, near: Bounds) {
      record(INDEX);
      return enumerate(host.objectsOnBoard(board, near));
    },
  };
}
