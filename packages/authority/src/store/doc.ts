/**
 * The in-memory document (DESIGN.md §4.1, §7): a mutable snapshot with a
 * derived `containerOf` map and the read API the store re-exposes.
 *
 * The mutators below are the effect algebra's primitives. They keep the
 * derived maps consistent but check no document invariant; callers change a
 * DocState only through `applyEffect` and `applyHistoricalInverse`.
 */
import {
  type Board,
  type BoardId,
  type Cell,
  EMPTY,
  type Location,
  type ObjectId,
  ref,
  type Snapshot,
  structuralCell,
  structuralDefault,
  type TableObject,
  type ViewersValue,
} from "@vtt/schema";

export class DocState {
  revision: number;
  #nextSeq: number;
  readonly #objects = new Map<ObjectId, TableObject>();
  readonly #boards = new Map<BoardId, Board>();
  /**
   * Every board id seen, live or removed, in document order. A removed board
   * keeps its slot, so re-creating it (a rewind or a user undo of its
   * removal) puts it back where it was.
   */
  readonly #boardOrder: BoardId[] = [];
  readonly #retired: ObjectId[] = [];
  readonly #retiredSet = new Set<ObjectId>();
  readonly #containerOf = new Map<ObjectId, ObjectId>();

  private constructor(revision: number, nextSeq: number) {
    this.revision = revision;
    this.#nextSeq = nextSeq;
  }

  /** A state holding a deep copy of `snapshot`. */
  static fromSnapshot(snapshot: Snapshot): DocState {
    const s = new DocState(snapshot.revision, snapshot.next_seq);
    for (const b of snapshot.boards) s.putBoard(b);
    for (const o of Object.values(snapshot.objects)) s.#objects.set(o.id, structuredClone(o));
    for (const o of s.#objects.values()) for (const c of o.contents) s.#containerOf.set(c, o.id);
    s.addRetired(snapshot.retired_ids);
    return s;
  }

  /** A deep copy of the current document. */
  toSnapshot(): Snapshot {
    return {
      revision: this.revision,
      next_seq: this.#nextSeq,
      boards: this.boards(),
      objects: Object.fromEntries(
        [...this.#objects].map(([id, o]) => [id, structuredClone(o)] as const),
      ),
      retired_ids: [...this.#retired],
    };
  }

  // Reads. Returned objects are the live records: callers must not mutate them.

  get nextSeq(): number {
    return this.#nextSeq;
  }

  /** The live object, or undefined. */
  getObject(id: ObjectId): TableObject | undefined {
    return this.#objects.get(id);
  }

  hasObject(id: ObjectId): boolean {
    return this.#objects.has(id);
  }

  /** Every live object id, in no particular order. */
  objectIds(): ObjectId[] {
    return [...this.#objects.keys()];
  }

  getBoard(id: BoardId): Board | undefined {
    return this.#boards.get(id);
  }

  /** The live boards, in document order, as copies. */
  boards(): Board[] {
    return this.#boardOrder.flatMap((id) => {
      const b = this.#boards.get(id);
      return b === undefined ? [] : [{ ...b }];
    });
  }

  /**
   * A readable cell: the stored Cell, or the structural default (field-backed
   * and derived cells read from the document, FORMULAS.md §3.1). Undefined
   * for an unknown object or a user cell that is not stored.
   */
  getCell(id: ObjectId, cell: string): Cell | undefined {
    const o = this.#objects.get(id);
    if (o === undefined) return undefined;
    const spec = structuralCell(cell);
    if (spec === undefined || spec.storage === "cell") {
      const stored = Object.hasOwn(o.cells, cell) ? o.cells[cell] : undefined;
      if (stored !== undefined || spec === undefined) return stored;
    }
    if (spec.name === "container") {
      const c = this.#containerOf.get(id);
      return { content: c === undefined ? EMPTY : ref(c) };
    }
    return { content: structuralDefault(spec.name, o) };
  }

  /** The per-cell visibility entry of a cell, or undefined when it has none. */
  getCellVisibility(id: ObjectId, cell: string): ViewersValue | undefined {
    const o = this.#objects.get(id);
    return o !== undefined && Object.hasOwn(o.cell_visibility, cell)
      ? o.cell_visibility[cell]
      : undefined;
  }

  /** The container directly holding `id`, or null. */
  containerOf(id: ObjectId): ObjectId | null {
    return this.#containerOf.get(id) ?? null;
  }

  /** The board `id` is placed directly on (its `board` field), or null. */
  boardOf(id: ObjectId): BoardId | null {
    return this.#objects.get(id)?.board ?? null;
  }

  /** Where `id` is: on a board, at an index of a container, or null (nowhere or unknown). */
  locationOf(id: ObjectId): Location | null {
    const container = this.#containerOf.get(id);
    if (container !== undefined) {
      const index = this.#objects.get(container)?.contents.indexOf(id) ?? -1;
      return { type: "container", container, index };
    }
    const board = this.boardOf(id);
    return board === null ? null : { type: "board", board };
  }

  /** A copy of `id`'s contents, in order; empty for an unknown object. */
  contentsOf(id: ObjectId): ObjectId[] {
    return [...(this.#objects.get(id)?.contents ?? [])];
  }

  /** `id` and everything inside it, transitively, in preorder. Empty if unknown. */
  subtreeOf(id: ObjectId): ObjectId[] {
    const o = this.#objects.get(id);
    return o === undefined ? [] : [id, ...o.contents.flatMap((c) => this.subtreeOf(c))];
  }

  /** The objects placed directly on `board` (never those inside containers). */
  objectsOnBoard(board: BoardId): ObjectId[] {
    return [...this.#objects.values()].filter((o) => o.board === board).map((o) => o.id);
  }

  /** Whether `id` is taken for the document's lifetime: a live board, a live object, or retired. */
  isReserved(id: string): boolean {
    return this.#objects.has(id) || this.#boards.has(id) || this.#retiredSet.has(id);
  }

  isRetired(id: string): boolean {
    return this.#retiredSet.has(id);
  }

  // Primitives for the effect algebra.

  /** The live record, or an error naming `what` needed it. */
  require(id: ObjectId, what: string): TableObject {
    const o = this.#objects.get(id);
    if (o === undefined) throw new Error(`${what}: no object "${id}"`);
    return o;
  }

  /** Adds an object record (a copy) and derives the containers of its contents. */
  insertObject(o: TableObject): void {
    if (this.#objects.has(o.id)) throw new Error(`object "${o.id}" already exists`);
    this.#objects.set(o.id, structuredClone(o));
    for (const c of o.contents) this.#containerOf.set(c, o.id);
  }

  /** Deletes an object record and the container entries of its contents. */
  deleteObject(id: ObjectId): TableObject {
    const o = this.require(id, "delete");
    this.#objects.delete(id);
    for (const c of o.contents) {
      if (this.#containerOf.get(c) === id) this.#containerOf.delete(c);
    }
    return o;
  }

  /** Puts `id` into `container`'s contents at `index`. */
  insertIntoContainer(id: ObjectId, container: ObjectId, index: number): void {
    const c = this.require(container, "insert");
    if (!Number.isInteger(index) || index < 0 || index > c.contents.length) {
      throw new Error(`index ${index} out of range for "${container}"`);
    }
    c.contents.splice(index, 0, id);
    this.#containerOf.set(id, container);
  }

  /** Takes `id` out of `container`'s contents, expecting it at `index`. */
  takeFromContainer(id: ObjectId, container: ObjectId, index: number): void {
    const c = this.require(container, "take");
    if (c.contents[index] !== id) {
      throw new Error(`"${id}" is not at index ${index} of "${container}"`);
    }
    c.contents.splice(index, 1);
    if (this.#containerOf.get(id) === container) this.#containerOf.delete(id);
  }

  /** Replaces `container`'s contents with a reordering of the same members. */
  setContents(container: ObjectId, contents: ObjectId[]): void {
    const c = this.require(container, "reorder");
    const sorted = (xs: ObjectId[]) => [...xs].sort().join("\0");
    if (sorted(c.contents) !== sorted(contents)) {
      throw new Error(`reorder of "${container}" changes its membership`);
    }
    c.contents = [...contents];
  }

  /** Adds or replaces a board, keeping a known board's slot. */
  putBoard(b: Board): void {
    if (!this.#boardOrder.includes(b.id)) this.#boardOrder.push(b.id);
    this.#boards.set(b.id, { ...b });
  }

  deleteBoard(id: BoardId): void {
    if (!this.#boards.delete(id)) throw new Error(`no board "${id}"`);
  }

  setNextSeq(seq: number): void {
    this.#nextSeq = seq;
  }

  /** Appends ids to `retired_ids`; refuses ids already retired. */
  addRetired(ids: readonly ObjectId[]): void {
    for (const id of ids) {
      if (this.#retiredSet.has(id)) throw new Error(`"${id}" is already retired`);
      this.#retiredSet.add(id);
      this.#retired.push(id);
    }
  }

  /** Removes exactly `ids` from `retired_ids`; refuses ids not retired. */
  removeRetired(ids: readonly ObjectId[]): void {
    for (const id of ids) {
      if (!this.#retiredSet.delete(id)) throw new Error(`"${id}" is not retired`);
      this.#retired.splice(this.#retired.lastIndexOf(id), 1);
    }
  }
}
