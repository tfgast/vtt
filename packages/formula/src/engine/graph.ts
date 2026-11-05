/**
 * The dependency graph (FORMULAS.md §7): for each evaluated formula cell,
 * the set of dependencies its last complete evaluation recorded, plus the
 * reverse edges invalidation walks. A new set replaces the old one.
 */
import type { ObjectId } from "@vtt/schema";
import type { CellKey, Dependency } from "../host";

/** A canonical string for a dependency, for de-duplication. */
export function dependencyKey(dep: Dependency): string {
  switch (dep.type) {
    case "cell":
      return `c:${dep.object}:${dep.cell}`;
    case "exists":
      return `e:${dep.object}`;
    case "index":
      return "i";
  }
}

/** `map`'s entry for `key`, created with `make` if absent. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/**
 * Forward and reverse dependency edges. Reverse edges are kept per object so
 * that creating or deleting an object finds every reader of any of its cells.
 * There is one global index key in v1.
 */
export class DependencyGraph {
  private readonly forward = new Map<CellKey, readonly Dependency[]>();
  private readonly cellReaders = new Map<ObjectId, Map<string, Set<CellKey>>>();
  private readonly existsReaders = new Map<ObjectId, Set<CellKey>>();
  private readonly indexReaders = new Set<CellKey>();

  /** The last recorded set of `key`, or `undefined` if none is recorded. */
  get(key: CellKey): readonly Dependency[] | undefined {
    return this.forward.get(key);
  }

  /** Replace `key`'s dependency set. */
  set(key: CellKey, deps: readonly Dependency[]): void {
    this.delete(key);
    this.forward.set(key, deps);
    for (const dep of deps) {
      switch (dep.type) {
        case "cell": {
          const cells = getOrCreate(this.cellReaders, dep.object, () => new Map());
          getOrCreate(cells, dep.cell, () => new Set()).add(key);
          break;
        }
        case "exists": {
          getOrCreate(this.existsReaders, dep.object, () => new Set()).add(key);
          break;
        }
        case "index":
          this.indexReaders.add(key);
          break;
      }
    }
  }

  /** Forget `key`'s dependency set and its reverse edges. */
  delete(key: CellKey): void {
    const old = this.forward.get(key);
    if (old === undefined) return;
    this.forward.delete(key);
    for (const dep of old) {
      switch (dep.type) {
        case "cell": {
          const cells = this.cellReaders.get(dep.object);
          const readers = cells?.get(dep.cell);
          readers?.delete(key);
          if (readers?.size === 0) cells?.delete(dep.cell);
          if (cells?.size === 0) this.cellReaders.delete(dep.object);
          break;
        }
        case "exists": {
          const readers = this.existsReaders.get(dep.object);
          readers?.delete(key);
          if (readers?.size === 0) this.existsReaders.delete(dep.object);
          break;
        }
        case "index":
          this.indexReaders.delete(key);
          break;
      }
    }
  }

  /** Cells whose recorded set reads `object`'s cell `cell`. */
  readersOfCell(object: ObjectId, cell: string): readonly CellKey[] {
    return [...(this.cellReaders.get(object)?.get(cell) ?? [])];
  }

  /** Cells whose recorded set reads any cell of `object`. */
  readersOfAnyCell(object: ObjectId): readonly CellKey[] {
    const out: CellKey[] = [];
    for (const readers of this.cellReaders.get(object)?.values() ?? []) {
      for (const r of readers) out.push(r);
    }
    return out;
  }

  /** Cells whose recorded set checks whether `object` exists. */
  readersOfExists(object: ObjectId): readonly CellKey[] {
    return [...(this.existsReaders.get(object) ?? [])];
  }

  /** Cells whose recorded set depends on the spatial and tag index. */
  readersOfIndex(): readonly CellKey[] {
    return [...this.indexReaders];
  }
}
