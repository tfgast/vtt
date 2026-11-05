/**
 * The spatial index (DESIGN.md §4.3, §7 Scale): computes, quickly, exactly
 * the candidate set of FORMULAS.md §6 that `EvalHost.objectsOnBoard`
 * requires. It never evaluates formulas, never orders its results, and never
 * decides membership or overlap; that is the evaluator's.
 *
 * The candidate set of `board` for query bounds `near`: every object placed
 * directly on `board` whose literal `indexBounds` intersect `near`
 * (inclusive), plus every object on `board` with a formula-valued geometry
 * cell (`position`, `rotation`, `z`; `shape` is a field and never a formula),
 * regardless of bounds. A cell with an override counts as the override's
 * literal. An object whose literal position is not two finite numbers, and
 * that has no formula geometry, is never a candidate. Budgets charge per
 * candidate, so the set is exact: neither a superset nor a subset.
 *
 * Per board: a uniform grid of 8×8 board-unit buckets holding object ids by
 * literal index bounds, a list of objects whose bounds span more than 64
 * buckets (or whose bucket coordinates are not safe integers), and the set of objects with formula geometry,
 * always returned. Bucketed and large objects are still tested with
 * `boundsIntersect`, so the grid only narrows the search.
 *
 * The index reads the store's committed document. `applyCommit` refreshes
 * every object a commit's effects may have moved or reshaped; register it as
 * an internal commit hook so it runs before anything queries the new
 * revision. `rebuild` recomputes everything (after a load or rewind that
 * replaces the document outside a commit).
 */
import {
  type BoardId,
  type Bounds,
  boundsIntersect,
  type Cell,
  type CellContent,
  indexBounds,
  type ObjectId,
  type Point,
  type Shape,
} from "@vtt/schema";
import type { DocView } from "../store/document-store";
import type { DeepReadonly } from "../store/history";
import type { CommitPayload } from "../store/transaction";

/** The side of a grid bucket, in board units. */
export const SPATIAL_BUCKET_SIZE = 8;

/** Objects whose bounds cover more buckets than this go on the large list. */
export const SPATIAL_MAX_BUCKETS = 64;

/** The geometry cells whose formula makes an object always a candidate. */
const GEOMETRY_CELLS = ["position", "rotation", "z"] as const;

/** What the index reads: the store's committed document. */
export type SpatialSource = Pick<DocView, "objectIds" | "getObject" | "getCell">;

/** Where an object on a board is held. */
type Entry =
  | { kind: "formula" }
  | { kind: "none" }
  | { kind: "large"; bounds: Bounds }
  | { kind: "grid"; bounds: Bounds; keys: string[] };

interface BoardIndex {
  /** Every object directly on the board, with where it is held. */
  readonly entries: Map<ObjectId, Entry>;
  readonly buckets: Map<string, Set<ObjectId>>;
  readonly large: Set<ObjectId>;
  readonly formula: Set<ObjectId>;
}

const bucketOf = (v: number): number => Math.floor(v / SPATIAL_BUCKET_SIZE);
const bucketKey = (bx: number, by: number): string => `${bx},${by}`;

/**
 * The bucket range of `b`, and how many buckets it covers. The count is NaN
 * unless every end is a safe integer: past 2^53 `bx++` no longer advances,
 * so such a range must never be enumerated (callers treat NaN as "too many").
 */
function bucketRange(b: Bounds): { x0: number; y0: number; x1: number; y1: number; count: number } {
  const x0 = bucketOf(b.minX);
  const y0 = bucketOf(b.minY);
  const x1 = bucketOf(b.maxX);
  const y1 = bucketOf(b.maxY);
  const safe = [x0, y0, x1, y1].every(Number.isSafeInteger);
  return { x0, y0, x1, y1, count: safe ? (x1 - x0 + 1) * (y1 - y0 + 1) : Number.NaN };
}

/** The literal a cell reads as: its override when it has one, else its content. */
const literalOf = (c: DeepReadonly<Cell> | undefined): DeepReadonly<CellContent> | undefined =>
  c === undefined ? undefined : (c.override ?? c.content);

const isFormula = (c: DeepReadonly<Cell> | undefined): boolean =>
  c !== undefined && c.content.type === "formula" && c.override === undefined;

export class SpatialIndex {
  readonly #source: SpatialSource;
  readonly #boards = new Map<BoardId, BoardIndex>();
  /** Object → the board it is indexed on. */
  readonly #boardOf = new Map<ObjectId, BoardId>();

  /** An index over `source` (normally a DocumentStore), built from its current document. */
  constructor(source: SpatialSource) {
    this.#source = source;
    this.rebuild();
  }

  /** Recomputes the whole index from the source's current document. */
  rebuild(): void {
    this.#boards.clear();
    this.#boardOf.clear();
    for (const id of this.#source.objectIds()) this.#refresh(id);
  }

  /**
   * Brings the index up to date with a commit, reading the store's document
   * after it: refreshes each object a `place`, `create`, `remove`, `shape`
   * field, or `position`/`rotation`/`z` cell effect names.
   */
  applyCommit(payload: Pick<CommitPayload, "group" | "summary">): void {
    const touched = new Set<ObjectId>();
    for (const e of payload.group.effects) {
      switch (e.type) {
        case "cell":
          if ((GEOMETRY_CELLS as readonly string[]).includes(e.cell)) touched.add(e.object);
          break;
        case "field":
          if (e.field === "shape") touched.add(e.object);
          break;
        case "place":
          touched.add(e.object);
          break;
        case "create":
        case "remove":
          for (const o of e.objects) touched.add(o.id);
          break;
        default:
          break;
      }
    }
    for (const id of touched) this.#refresh(id);
    for (const b of payload.summary.boardsRemoved) {
      const board = this.#boards.get(b);
      if (board !== undefined && board.entries.size === 0) this.#boards.delete(b);
    }
  }

  /**
   * The candidate set of FORMULAS.md §6 for `board` and `near`: unordered,
   * each id once. Empty for an unknown board.
   */
  candidates(board: BoardId, near: Bounds): ObjectId[] {
    const b = this.#boards.get(board);
    if (b === undefined) return [];
    const out = new Set<ObjectId>(b.formula);
    const test = (id: ObjectId) => {
      const e = b.entries.get(id);
      if (e !== undefined && (e.kind === "grid" || e.kind === "large")) {
        if (boundsIntersect(e.bounds, near)) out.add(id);
      }
    };
    for (const id of b.large) test(id);
    const r = bucketRange(near);
    // A huge, inverted, non-finite, or unsafe-coordinate box: testing every entry is exact.
    if (!(r.count > 0 && r.count <= b.buckets.size)) {
      for (const [id, e] of b.entries) if (e.kind === "grid") test(id);
      return [...out];
    }
    for (let bx = r.x0; bx <= r.x1; bx++) {
      for (let by = r.y0; by <= r.y1; by++) {
        const bucket = b.buckets.get(bucketKey(bx, by));
        if (bucket !== undefined) for (const id of bucket) if (!out.has(id)) test(id);
      }
    }
    return [...out];
  }

  /** Every object placed directly on `board`, unordered. */
  objectsOnBoard(board: BoardId): ObjectId[] {
    return [...(this.#boards.get(board)?.entries.keys() ?? [])];
  }

  /** Re-indexes `id` from the source's current document. */
  #refresh(id: ObjectId): void {
    this.#drop(id);
    const o = this.#source.getObject(id);
    if (o === undefined || o.board === null) return;
    const board = this.#board(o.board);
    const entry = this.#entryFor(id, o.shape as Shape | null);
    board.entries.set(id, entry);
    this.#boardOf.set(id, o.board);
    switch (entry.kind) {
      case "formula":
        board.formula.add(id);
        return;
      case "large":
        board.large.add(id);
        return;
      case "grid":
        for (const k of entry.keys) {
          let bucket = board.buckets.get(k);
          if (bucket === undefined) {
            bucket = new Set();
            board.buckets.set(k, bucket);
          }
          bucket.add(id);
        }
        return;
      case "none":
        return;
    }
  }

  /** Where an object on a board with `shape` belongs, from its geometry cells. */
  #entryFor(id: ObjectId, shape: Shape | null): Entry {
    const [position, rotation, z] = GEOMETRY_CELLS.map((c) => this.#source.getCell(id, c));
    if (isFormula(position) || isFormula(rotation) || isFormula(z)) return { kind: "formula" };
    const p = literalOf(position);
    if (p?.type !== "list" || p.items.length !== 2) return { kind: "none" };
    const [x, y] = p.items;
    if (x?.type !== "number" || y?.type !== "number") return { kind: "none" };
    if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return { kind: "none" };
    const anchor: Point = [x.value, y.value];
    const r = literalOf(rotation);
    const deg = r?.type === "number" && Number.isFinite(r.value) ? r.value : 0;
    const bounds = indexBounds(shape, anchor, deg);
    const range = bucketRange(bounds);
    if (!(range.count <= SPATIAL_MAX_BUCKETS)) return { kind: "large", bounds };
    const keys: string[] = [];
    for (let bx = range.x0; bx <= range.x1; bx++) {
      for (let by = range.y0; by <= range.y1; by++) keys.push(bucketKey(bx, by));
    }
    return { kind: "grid", bounds, keys };
  }

  /** Removes `id` from wherever it is indexed. */
  #drop(id: ObjectId): void {
    const boardId = this.#boardOf.get(id);
    if (boardId === undefined) return;
    this.#boardOf.delete(id);
    const board = this.#boards.get(boardId);
    const entry = board?.entries.get(id);
    if (board === undefined || entry === undefined) return;
    board.entries.delete(id);
    board.formula.delete(id);
    board.large.delete(id);
    if (entry.kind === "grid") {
      for (const k of entry.keys) {
        const bucket = board.buckets.get(k);
        bucket?.delete(id);
        if (bucket?.size === 0) board.buckets.delete(k);
      }
    }
  }

  #board(id: BoardId): BoardIndex {
    let b = this.#boards.get(id);
    if (b === undefined) {
      b = { entries: new Map(), buckets: new Map(), large: new Set(), formula: new Set() };
      this.#boards.set(id, b);
    }
    return b;
  }
}
