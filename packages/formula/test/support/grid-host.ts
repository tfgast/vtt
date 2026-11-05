/**
 * GridHost: a test-only EvalHost that answers `objectsOnBoard` from a
 * uniform grid index instead of MemoryHost's brute force, to show that the
 * engine's results and budget charges do not depend on how a host computes
 * the literal-geometry candidate set (FORMULAS.md §6, §7).
 *
 * Every other method delegates to a MemoryHost, which tests keep mutating.
 * The index is rebuilt from the current literal geometry when a query sees
 * a changed document (a cheap content fingerprint), and candidates come
 * back in grid-walk order, not document order.
 */
import type { EvalHost } from "@vtt/formula";
import {
  type Bounds,
  boundsIntersect,
  type CellContent,
  indexBounds,
  type ObjectId,
  type Point,
} from "@vtt/schema";
import type { MemoryHost } from "./memory-host";

const GEOMETRY_FORMULA_CELLS = ["position", "rotation", "z", "shape"] as const;

interface BoardIndex {
  /** Objects with any formula-valued geometry cell: candidates of every query. */
  readonly loose: ObjectId[];
  /** Grid cell `"i,j"` to the objects whose index bounds touch it. */
  readonly grid: Map<string, ObjectId[]>;
  readonly bounds: Map<ObjectId, Bounds>;
}

export class GridHost implements EvalHost {
  private indexes = new Map<ObjectId, BoardIndex>();
  private fingerprint = "";
  /** How many times the index was rebuilt, for tests. */
  rebuilds = 0;

  constructor(
    readonly inner: MemoryHost,
    private readonly size = 3,
  ) {}

  exists(id: ObjectId): boolean {
    return this.inner.exists(id);
  }

  cell(id: ObjectId, name: string): CellContent | undefined {
    return this.inner.cell(id, name);
  }

  objectsNamed(name: string): ObjectId[] {
    return this.inner.objectsNamed(name).reverse();
  }

  allObjects(): ObjectId[] {
    return this.inner.allObjects().reverse();
  }

  objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[] {
    this.refresh();
    const index = this.indexes.get(board);
    if (index === undefined) return [];
    const out = new Set<ObjectId>();
    for (const [i, j] of this.span(near)) {
      for (const id of index.grid.get(`${i},${j}`) ?? []) {
        if (!out.has(id) && boundsIntersect(index.bounds.get(id) as Bounds, near)) out.add(id);
      }
    }
    for (const id of index.loose) out.add(id);
    return [...out];
  }

  /** The grid cells a bounds touches, row by row from the top right. */
  private *span(b: Bounds): Generator<[number, number]> {
    const s = this.size;
    for (let j = Math.floor(b.maxY / s); j >= Math.floor(b.minY / s); j--) {
      for (let i = Math.floor(b.maxX / s); i >= Math.floor(b.minX / s); i--) yield [i, j];
    }
  }

  private refresh(): void {
    const ids = this.inner.allObjects();
    const fp = JSON.stringify(
      ids.map((id) => [id, ...["board", ...GEOMETRY_FORMULA_CELLS].map((c) => this.cell(id, c))]),
    );
    if (fp === this.fingerprint) return;
    this.fingerprint = fp;
    this.rebuilds++;
    this.indexes = new Map();
    for (const id of ids) {
      const b = this.cell(id, "board");
      if (b?.type !== "ref") continue;
      let index = this.indexes.get(b.object);
      if (index === undefined) {
        index = { loose: [], grid: new Map(), bounds: new Map() };
        this.indexes.set(b.object, index);
      }
      const [position, rotation, , shape] = GEOMETRY_FORMULA_CELLS.map((c) => this.cell(id, c));
      if (GEOMETRY_FORMULA_CELLS.some((c) => this.cell(id, c)?.type === "formula")) {
        index.loose.push(id);
        continue;
      }
      if (position?.type !== "list" || position.items.length !== 2) continue;
      const [x, y] = position.items;
      if (x?.type !== "number" || y?.type !== "number") continue;
      if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) continue;
      const anchor: Point = [x.value, y.value];
      const deg =
        rotation?.type === "number" && Number.isFinite(rotation.value) ? rotation.value : 0;
      const bounds = indexBounds(shape?.type === "shape" ? shape.shape : null, anchor, deg);
      index.bounds.set(id, bounds);
      for (const [i, j] of this.span(bounds)) {
        const key = `${i},${j}`;
        const list = index.grid.get(key);
        if (list === undefined) index.grid.set(key, [id]);
        else list.push(id);
      }
    }
  }
}
