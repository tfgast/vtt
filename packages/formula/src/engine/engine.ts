/**
 * The formula engine core (FORMULAS.md §7; DESIGN.md §4.2, §7): memoized,
 * dependency-tracked, iterative evaluation over an `EvalHost`, one document
 * revision at a time.
 *
 * Propagation is lazy pull with dirty marking. After each committed revision
 * the caller calls `invalidate` once, with every change the commit made,
 * before any read; nothing recomputes until it is read, and each formula is
 * evaluated at most once per revision.
 */
import { err, type ObjectId, type Result } from "@vtt/schema";
import { validateRefs } from "../eval/refs";
import type { Registry } from "../functions/registry";
import { type CellKey, type Change, cellKey, type Dependency, type EvalHost } from "../host";
import { type ParseResult, parse } from "../syntax/parser";
import { type AdhocOptions, evaluateAdhoc, evaluateRecorded } from "./adhoc";
import { DEFAULT_BUDGET } from "./budget";
import { DependencyGraph, getOrCreate } from "./graph";
import { type EngineStats, resolve } from "./resolve";

export type { EngineStats } from "./resolve";

export interface EngineOptions {
  /** The function registry; defaults to the package's default registry. */
  registry?: Registry;
  /** Units each formula evaluation may spend (budget.ts); defaults to DEFAULT_BUDGET. */
  budget?: number;
}

/**
 * Host exceptions propagate out of `value` and `evaluate`. Results are stored
 * only when a cell's whole component finishes, and the work stack lives in
 * one `resolve` call, so a throw leaves every in-progress cell dirty (or
 * uncomputed) and the engine usable, with no reset needed.
 */
export interface Engine {
  /**
   * The result of `id`.`cell` at the current revision: `#REF` if the object
   * does not exist, `#NAME` if it has no such cell, a literal through
   * `validateRefs`, or a formula's memoized result, recomputed if dirty.
   */
  value(id: ObjectId, cell: string): Result;

  /**
   * Evaluate a formula that is not a cell (a `when` guard, a show-when) on
   * `options.thisId`, or on no object when it is absent (`this` is `#REF`,
   * bare names `#NAME`), at the current revision: budgeted, reading and
   * populating the memo, keeping no dependency entry (adhoc.ts).
   */
  evaluate(source: string, options: AdhocOptions): Result;

  /**
   * Evaluate a tracked expression: a formula that is not a cell (a `when`
   * guard, a show-when) under the caller's opaque `key`, on
   * `options.thisId` as `evaluate` does, keeping the dependencies its final
   * attempt recorded. The result is cached by key: while the key is clean
   * and `source` and `thisId` are those of its last evaluation, the cached
   * result is returned without evaluating; otherwise the expression is
   * evaluated and its result and dependency set replace the key's.
   * `invalidateAll` reports the key when a change may alter its result.
   * Tracked expressions are not cells: no formula can read them, and they
   * never appear in `invalidate`'s cells or `dependenciesOf`.
   */
  evaluateTracked(key: string, source: string, options: AdhocOptions): Result;

  /** Forget the tracked expression `key`, if any; it is never reported again. */
  dropTracked(key: string): void;

  /**
   * `invalidateAll(changes).cells`: tracked expressions are marked dirty
   * too, but not reported.
   */
  invalidate(changes: readonly Change[]): CellKey[];

  /**
   * Mark everything `changes` affects dirty and return the formula cells and
   * the tracked expression keys this call newly marked dirty. Call once per committed revision, before any
   * read. The host must report every changed cell, including the derived
   * `container` of a moved object and both parents' `contents`.
   *
   * A `cell` change dirties that cell (if it is a memoized formula) and,
   * transitively, every dependent; a change to an index cell (`position`,
   * `rotation`, `shape`, `z`, `board`, `tag`, `container`, `is_zone`,
   * `name`) also dirties every cell with an `index` dependency. Creating or
   * deleting an object dirties the index dependents, the cells that checked
   * its existence, and the readers of any of its cells; deletion also drops
   * the object's memoized results. A tracked expression is dirtied by the
   * same rules applied to its own dependency set, and when a cell it read is
   * dirtied. A key already dirty is not reported again until it is
   * re-evaluated.
   */
  invalidateAll(changes: readonly Change[]): Invalidation;

  /** The dependency set the cell's last complete evaluation recorded, if any. */
  dependenciesOf(id: ObjectId, cell: string): readonly Dependency[] | undefined;

  /** Cumulative counters, for tests. */
  stats(): EngineStats;
}

/** What `invalidateAll` newly marked dirty. */
export interface Invalidation {
  /** Formula cells. */
  cells: CellKey[];
  /** Tracked expression keys (`evaluateTracked`). */
  tracked: string[];
}

/** Cells whose change invalidates the spatial and tag index (FORMULAS §7). */
export const INDEX_CELLS: ReadonlySet<string> = new Set([
  "position",
  "rotation",
  "shape",
  "z",
  "board",
  "tag",
  "container",
  "is_zone",
  "name",
]);

interface Memo {
  result: Result;
  dirty: boolean;
}

interface Tracked extends Memo {
  source: string;
  thisId: ObjectId | undefined;
}

export function createEngine(host: EvalHost, options: EngineOptions = {}): Engine {
  const memo = new Map<CellKey, Memo>();
  /** Memoized cell names per object, for dropping a deleted object's entries. */
  const memoByObject = new Map<ObjectId, Set<string>>();
  const graph = new DependencyGraph();
  const parses = new Map<string, ParseResult>();
  /** Tracked expressions by key, with their own graph (keys are not cells). */
  const tracked = new Map<string, Tracked>();
  const trackedGraph = new DependencyGraph();
  const counters: EngineStats = { evaluations: 0, attempts: 0, reads: 0, parses: 0 };

  const forget = (id: ObjectId, cell: string) => {
    const key = cellKey(id, cell);
    memo.delete(key);
    graph.delete(key);
    const cells = memoByObject.get(id);
    cells?.delete(cell);
    if (cells?.size === 0) memoByObject.delete(id);
  };

  const ctx = {
    host,
    registry: options.registry,
    budget: options.budget ?? DEFAULT_BUDGET,
    stats: counters,
    memoized(key: CellKey): Result | undefined {
      const m = memo.get(key);
      return m === undefined || m.dirty ? undefined : m.result;
    },
    store(key: CellKey, result: Result, deps: readonly Dependency[]) {
      memo.set(key, { result, dirty: false });
      graph.set(key, deps);
      const sep = key.indexOf(":");
      const id = key.slice(0, sep);
      getOrCreate(memoByObject, id, () => new Set<string>()).add(key.slice(sep + 1));
    },
    parse(source: string): ParseResult {
      let parsed = parses.get(source);
      if (parsed === undefined) {
        parsed = parse(source);
        parses.set(source, parsed);
        counters.parses++;
      }
      return parsed;
    },
  };

  /**
   * Marks dirty and returns the tracked keys that read a changed cell, the
   * index or an existence, or any cell of a created or deleted object, as
   * `changes` describe them, or a cell in `dirtied`.
   */
  const invalidateTracked = (changes: readonly Change[], dirtied: readonly CellKey[]): string[] => {
    const out: string[] = [];
    const dirtyAll = (keys: readonly CellKey[]) => {
      for (const k of keys) {
        const t = tracked.get(k);
        if (t === undefined || t.dirty) continue;
        t.dirty = true;
        out.push(k);
      }
    };
    for (const change of changes) {
      if (change.type === "cell") {
        dirtyAll(trackedGraph.readersOfCell(change.object, change.cell));
        if (INDEX_CELLS.has(change.cell)) dirtyAll(trackedGraph.readersOfIndex());
        continue;
      }
      dirtyAll(trackedGraph.readersOfIndex());
      dirtyAll(trackedGraph.readersOfExists(change.object));
      dirtyAll(trackedGraph.readersOfAnyCell(change.object));
    }
    for (const key of dirtied) {
      const sep = key.indexOf(":");
      dirtyAll(trackedGraph.readersOfCell(key.slice(0, sep), key.slice(sep + 1)));
    }
    return out;
  };

  const engine: Engine = {
    value(id, cell) {
      if (!host.exists(id)) return err("#REF", `reference to deleted object ${id}`);
      const content = host.cell(id, cell);
      if (content === undefined) {
        return err("#NAME", `no cell ${cell} on ${id}`, { object: id, cell });
      }
      if (content.type !== "formula") {
        // A formula replaced by a literal: its old entry is stale.
        if (memo.has(cellKey(id, cell))) forget(id, cell);
        return validateRefs(content, (oid) => host.exists(oid));
      }
      return ctx.memoized(cellKey(id, cell)) ?? resolve(ctx, id, cell);
    },

    evaluate(source, adhoc) {
      return evaluateAdhoc(ctx, source, adhoc);
    },

    evaluateTracked(key, source, adhoc) {
      const t = tracked.get(key);
      if (t !== undefined && !t.dirty && t.source === source && t.thisId === adhoc.thisId) {
        return t.result;
      }
      const { result, deps } = evaluateRecorded(ctx, source, adhoc);
      tracked.set(key, { result, dirty: false, source, thisId: adhoc.thisId });
      // The graph is typed by cell keys; tracked keys only live in their own graph.
      trackedGraph.set(key as CellKey, deps);
      return result;
    },

    dropTracked(key) {
      tracked.delete(key);
      trackedGraph.delete(key as CellKey);
    },

    invalidate(changes) {
      return engine.invalidateAll(changes).cells;
    },

    invalidateAll(changes) {
      const dirtied: CellKey[] = [];
      const work: CellKey[] = [];
      const dirty = (key: CellKey) => {
        const m = memo.get(key);
        if (m === undefined || m.dirty) return;
        m.dirty = true;
        dirtied.push(key);
        work.push(key);
      };
      const dirtyAll = (keys: readonly CellKey[]) => {
        for (const k of keys) dirty(k);
      };
      for (const change of changes) {
        if (change.type === "cell") {
          dirty(cellKey(change.object, change.cell));
          // Readers of the changed cell, even if it is a literal with no entry.
          dirtyAll(graph.readersOfCell(change.object, change.cell));
          if (INDEX_CELLS.has(change.cell)) dirtyAll(graph.readersOfIndex());
          continue;
        }
        if (change.type === "object_deleted") {
          for (const c of [...(memoByObject.get(change.object) ?? [])]) forget(change.object, c);
        }
        dirtyAll(graph.readersOfIndex());
        dirtyAll(graph.readersOfExists(change.object));
        dirtyAll(graph.readersOfAnyCell(change.object));
      }
      // Transitively through reverse edges. A cell already dirty before this
      // call has dirty dependents already, so the walk stops there.
      while (work.length > 0) {
        const key = work.pop() as CellKey;
        const sep = key.indexOf(":");
        dirtyAll(graph.readersOfCell(key.slice(0, sep), key.slice(sep + 1)));
      }
      return { cells: dirtied, tracked: invalidateTracked(changes, dirtied) };
    },

    dependenciesOf(id, cell) {
      return graph.get(cellKey(id, cell));
    },

    stats() {
      return { ...counters };
    },
  };
  return engine;
}
