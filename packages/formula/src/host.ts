/**
 * The boundary between the pure formula language and the document
 * (FORMULAS.md §3, §3.1, §6, §7; DESIGN.md §4.3).
 *
 * The evaluator never touches the document directly. It sees an `EvalEnv`;
 * the engine builds that over an `EvalHost`, a raw view of one document
 * revision. The doc comments here are the contract that every host (the M1
 * test hosts, M2's engine adapter vtt-75c.12) implements.
 *
 * Structural cell value shapes and defaults (canonical: STRUCTURAL_CELLS in
 * @vtt/schema, vtt-75c.3; stated here so M1 and M2 agree; FORMULAS §3.1):
 *
 * | Cell            | Reads as                                   | Default when not stored  |
 * |-----------------|--------------------------------------------|--------------------------|
 * | id              | text                                       | (always present)         |
 * | name            | text, literal only                         | empty                    |
 * | tag             | list of text, literal only                 | []                       |
 * | visible_to      | viewers                                    | viewers ["all"]          |
 * | owner, template | ref or empty                               | empty                    |
 * | contents        | list of refs, stored order                 | []                       |
 * | container       | ref or empty (derived)                     | empty                    |
 * | board           | ref or empty                               | empty (in a container)   |
 * | position        | list of two numbers, or a formula          | empty (in a container)   |
 * | rotation        | number (degrees clockwise about the anchor) | empty (read as 0)       |
 * | z               | number                                     | empty (read as 0)        |
 * | face_up         | boolean                                    | true                     |
 * | opaque          | boolean                                    | false                    |
 * | is_zone         | boolean                                    | false                    |
 * | shape           | ShapeValue                                 | empty (no shape)         |
 *
 * `is_template` and `is_character` are object fields, not readable cells.
 */
import type { Bounds, CellContent, ObjectId, Result } from "@vtt/schema";

/**
 * A view of one revision of the raw document. It never evaluates formulas.
 * Implemented by the test documents and by M2's engine adapter (vtt-75c.12)
 * over the document store.
 */
export interface EvalHost {
  /** Whether the object (or board) exists at this revision. */
  exists(id: ObjectId): boolean;

  /**
   * The stored content of a cell. An override is returned as its literal;
   * an unstored structural cell reads as its default (table above);
   * `undefined` means there is no such cell.
   */
  cell(id: ObjectId, name: string): CellContent | undefined;

  /** Exact match over literal names (`name` is literal-only, FORMULAS §3). */
  objectsNamed(name: string): ObjectId[];

  /** Every object in the document. */
  allObjects(): ObjectId[];

  /**
   * The candidate set, defined over literal geometry (FORMULAS §6): every
   * object placed directly on `board` (never inside a container) whose
   * literal indexBounds (vtt-75c.7: union of footprint bounds and anchor,
   * expanded by epsilon) intersect `near` (inclusive), plus every object on
   * `board` with any formula-valued geometry cell (`position`, `rotation`,
   * `z`, `shape`; a cell with an override counts as literal) regardless of
   * bounds. Each id once, any order. An object whose literal position is not
   * two finite numbers is not a candidate by bounds (the evaluator would
   * exclude it).
   *
   * Contract: the host never filters by visibility; result ordering and
   * exact tests are the evaluator's (vtt-o9i.8).
   */
  objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[];
}

/**
 * What the evaluator sees. Implemented by the engine, by M2's action context
 * (vtt-75c.15), and by the test double FakeEnv.
 */
export interface EvalEnv {
  /** The result of a cell; `undefined` means there is no such cell. */
  read(id: ObjectId, cell: string): Result | undefined;

  /** Whether the object (or board) exists. */
  exists(id: ObjectId): boolean;

  /** As `EvalHost.objectsNamed`. */
  objectsNamed(name: string): ObjectId[];

  /** As `EvalHost.allObjects`. */
  allObjects(): ObjectId[];

  /** As `EvalHost.objectsOnBoard`: the literal-geometry candidate set. */
  objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[];
}

/** What a commit changed, as reported to the engine. */
export type Change =
  | { type: "cell"; object: ObjectId; cell: string }
  | { type: "object_created"; object: ObjectId }
  | { type: "object_deleted"; object: ObjectId };

/**
 * What an evaluation read (FORMULAS §7): a cell, an existence check, or the
 * spatial and tag index that `contents`, `zones_containing`, `on`,
 * `objects`, and `obj` depend on.
 */
export type Dependency =
  | { type: "cell"; object: ObjectId; cell: string }
  | { type: "exists"; object: ObjectId }
  | { type: "index" };

/**
 * An object id plus a cell name, as one string. The separator `:` never
 * appears in an id (letters, digits, underscores), so the first `:` always
 * splits the key, whatever the cell name holds.
 */
export type CellKey = `${ObjectId}:${string}`;

/** The key of `object`'s cell `cell`. */
export function cellKey(object: ObjectId, cell: string): CellKey {
  return `${object}:${cell}`;
}
