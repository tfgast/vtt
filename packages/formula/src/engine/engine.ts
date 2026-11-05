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
import { DependencyGraph, getOrCreate } from "./graph";
import { type EngineStats, resolve } from "./resolve";

export type { EngineStats } from "./resolve";

export interface EngineOptions {
  /** The function registry; defaults to the package's default registry. */
  registry?: Registry;
}

export interface Engine {
  /**
   * The result of `id`.`cell` at the current revision: `#REF` if the object
   * does not exist, `#NAME` if it has no such cell, a literal through
   * `validateRefs`, or a formula's memoized result, recomputed if dirty.
   */
  value(id: ObjectId, cell: string): Result;

  /**
   * Mark everything `changes` affects dirty and return the formula cells this
   * call newly marked dirty. Call once per committed revision, before any
   * read. The host must report every changed cell, including the derived
   * `container` of a moved object and both parents' `contents`.
   *
   * A `cell` change dirties that cell (if it is a memoized formula) and,
   * transitively, every dependent; a change to an index cell (`position`,
   * `rotation`, `shape`, `z`, `board`, `tag`, `container`, `is_zone`,
   * `name`) also dirties every cell with an `index` dependency. Creating or
   * deleting an object dirties the index dependents, the cells that checked
   * its existence, and the readers of any of its cells; deletion also drops
   * the object's memoized results.
   */
  invalidate(changes: readonly Change[]): CellKey[];

  /** The dependency set the cell's last complete evaluation recorded, if any. */
  dependenciesOf(id: ObjectId, cell: string): readonly Dependency[] | undefined;

  /** Cumulative counters, for tests. */
  stats(): EngineStats;
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

export function createEngine(host: EvalHost, options: EngineOptions = {}): Engine {
  const memo = new Map<CellKey, Memo>();
  /** Memoized cell names per object, for dropping a deleted object's entries. */
  const memoByObject = new Map<ObjectId, Set<string>>();
  const graph = new DependencyGraph();
  const parses = new Map<string, ParseResult>();
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

  return {
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

    invalidate(changes) {
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
      return dirtied;
    },

    dependenciesOf(id, cell) {
      return graph.get(cellKey(id, cell));
    },

    stats() {
      return { ...counters };
    },
  };
}
