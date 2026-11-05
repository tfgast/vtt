/**
 * FakeEnv: a stateless EvalEnv over a plain map of results, for evaluator
 * tests that need no document. It holds no formulas and evaluates nothing.
 */
import { type EvalEnv, validateRefs } from "@vtt/formula";
import type { Bounds, ObjectId, Result } from "@vtt/schema";

/** Object id to cell name to the result a read returns. */
export type FakeCells = Record<ObjectId, Record<string, Result>>;

/** Stubbed query answers. A query without a stub falls back as documented on FakeEnv. */
export interface FakeStubs {
  /** Board id to the candidate ids `objectsOnBoard` returns for it, whatever `near` is. */
  objectsOnBoard?: Record<ObjectId, ObjectId[]>;
  /** Name to the ids `objectsNamed` returns for it. */
  objectsNamed?: Record<string, ObjectId[]>;
  /** What `allObjects` returns. */
  allObjects?: ObjectId[];
}

const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * - `read` returns the mapped result passed through `validateRefs` with this
 *   env's `exists` (so a reference to an id not in the map, directly or
 *   inside a list or viewers value, reads as `#REF`); a valid result is the
 *   mapped object itself. `undefined` when the object or cell is not in the
 *   map.
 * - `exists` is true for ids that are keys of the map.
 * - Without a stub: `allObjects` is the map's keys in insertion order,
 *   `objectsNamed` is the ids whose `name` result is text equal to the name,
 *   and `objectsOnBoard` is `[]`.
 * - Query results are fresh arrays, so callers cannot mutate the stubs.
 */
export class FakeEnv implements EvalEnv {
  constructor(
    private readonly cells: FakeCells,
    private readonly stubs: FakeStubs = {},
  ) {}

  read(id: ObjectId, cell: string): Result | undefined {
    const value = own(own(this.cells, id), cell);
    return value === undefined ? undefined : validateRefs(value, (ref) => this.exists(ref));
  }

  exists(id: ObjectId): boolean {
    return Object.hasOwn(this.cells, id);
  }

  objectsNamed(name: string): ObjectId[] {
    const stub = this.stubs.objectsNamed;
    if (stub !== undefined) return [...(own(stub, name) ?? [])];
    return Object.keys(this.cells).filter((id) => {
      const n = this.read(id, "name");
      return n?.type === "text" && n.value === name;
    });
  }

  allObjects(): ObjectId[] {
    return [...(this.stubs.allObjects ?? Object.keys(this.cells))];
  }

  objectsOnBoard(board: ObjectId, _near: Bounds): ObjectId[] {
    return [...(own(this.stubs.objectsOnBoard, board) ?? [])];
  }
}
