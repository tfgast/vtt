/**
 * Structural primitives (DESIGN.md §4.1; FORMULAS.md §3.1, §8.3; FIXTURES.md
 * §6): moving, creating, spawning and removing objects. Each takes the open
 * transaction, checks everything it can against the working copy first, and
 * records resolved effects through `tx.record`. A refusal throws Rejected
 * before recording anything.
 */
import {
  type BoardId,
  type Cell,
  type CellContent,
  type CellEffect,
  isCellContent,
  isStructuralLiteral,
  isValidId,
  isValue,
  type Location,
  list,
  num,
  type ObjectId,
  type Rejection,
  ref,
  structuralCell,
  type TableObject,
  TableObjectSchema,
  type Value,
  type ViewersValue,
  validateSnapshot,
} from "@vtt/schema";
import { setFormula, writeValue } from "./edits";
import type { Transaction } from "./transaction";
import { Rejected } from "./transaction";

/** Where a move or spawn puts an object (FIXTURES.md §6, Destinations). */
export type Destination =
  | { type: "board"; board: BoardId; position: [number, number] }
  /** `index` is the object's index after the move; absent appends. */
  | { type: "container"; container: ObjectId; index?: number };

/** The fields `createObject` takes; everything else starts at its default. */
export type ObjectInit = Partial<
  Pick<
    TableObject,
    | "is_template"
    | "is_zone"
    | "is_character"
    | "tag"
    | "shape"
    | "cells"
    | "cell_visibility"
    | "actions"
  >
>;

const INIT_FIELDS: ReadonlySet<string> = new Set([
  "is_template",
  "is_zone",
  "is_character",
  "tag",
  "shape",
  "cells",
  "cell_visibility",
  "actions",
]);

/** What `spawn` made: the root copy, and original → copy for the whole subtree. */
export interface SpawnResult {
  root: ObjectId;
  copies: Map<ObjectId, ObjectId>;
}

function reject(rejection: Rejection): never {
  throw new Rejected(rejection);
}

function invalid(message: string): never {
  reject({ type: "invalid", message });
}

/** The object, or `invalid`. Transaction reads are copies, so dropping `readonly` is safe. */
function requireObject(tx: Transaction, id: ObjectId): TableObject {
  const o = typeof id === "string" ? (tx.doc.getObject(id) as TableObject | undefined) : undefined;
  return o ?? invalid(`no object "${String(id)}"`);
}

/** Cells only an object on a board has (FORMULAS.md §3.1). */
const PLACEMENT_CELLS = ["position", "rotation", "z"] as const;

const storedCell = (o: TableObject, cell: string): Cell | null =>
  Object.hasOwn(o.cells, cell) ? (o.cells[cell] ?? null) : null;

const cellEffect = (
  object: ObjectId,
  cell: string,
  before: Cell | null,
  after: Cell | null,
): CellEffect => ({ type: "cell", object, cell, before, after, cause: "edit" });

// Destinations.

/** A checked destination: a board with a point value, or a container with a resolved index. */
type Target =
  | { type: "board"; board: BoardId; position: Value }
  | { type: "container"; container: ObjectId; index: number };

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function checkBoard(tx: Transaction, dest: Destination & { type: "board" }): Target {
  if (typeof dest.board !== "string" || tx.doc.getBoard(dest.board) === undefined) {
    invalid(`no board "${String(dest.board)}"`);
  }
  const p: unknown = dest.position;
  if (!Array.isArray(p) || p.length !== 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
    invalid("a board position is two finite numbers");
  }
  return { type: "board", board: dest.board, position: list([num(p[0]), num(p[1])]) };
}

/**
 * Checks a destination. A container destination's index is resolved against
 * `length`, the container's length once the moving object has left it.
 */
function checkDestination(
  tx: Transaction,
  dest: Destination,
  length: (container: ObjectId) => number,
): Target {
  if (typeof dest !== "object" || dest === null) invalid("no destination");
  if (dest.type === "board") return checkBoard(tx, dest);
  if (dest.type !== "container") {
    invalid(`unknown destination type "${String((dest as { type: unknown }).type)}"`);
  }
  requireObject(tx, dest.container);
  const n = length(dest.container);
  const index = dest.index ?? n;
  if (!Number.isInteger(index) || index < 0 || index > n) {
    invalid(`index ${String(index)} out of range for "${dest.container}"`);
  }
  return { type: "container", container: dest.container, index };
}

const locationOf = (t: Target): Location =>
  t.type === "board"
    ? { type: "board", board: t.board }
    : { type: "container", container: t.container, index: t.index };

/**
 * The `z` an object landing on `board` gets: 1 + the top literal `z` of the
 * others (FORMULAS.md §3.1). An absent or empty `z` counts as 0, an
 * overridden formula as its override; a formula without an override is
 * skipped. With nothing counted, 1.
 */
function topZ(tx: Transaction, board: BoardId, except: ObjectId): number {
  let top: number | null = null;
  for (const id of tx.doc.objectsOnBoard(board)) {
    if (id === except) continue;
    const z = tx.doc.getCell(id, "z");
    const v = z === undefined ? undefined : z.content.type === "formula" ? z.override : z.content;
    const n = v?.type === "number" ? v.value : v?.type === "empty" ? 0 : null;
    if (n !== null && (top === null || n > top)) top = n;
  }
  return (top ?? 0) + 1;
}

/**
 * The landing rule (FORMULAS.md §3.1) for `obj`, already on `board`:
 * `position` written as a hand edit, and `z` on top unless it is a formula.
 */
function land(tx: Transaction, obj: ObjectId, board: BoardId, position: Value): void {
  writeValue(tx, obj, "position", position);
  if (tx.doc.getCell(obj, "z")?.content.type === "formula") return;
  writeValue(tx, obj, "z", num(topZ(tx, board, obj)));
}

/** Records the deletion of `obj`'s placement cells, or of those of `names` it stores. */
function dropPlacementCells(
  tx: Transaction,
  obj: ObjectId,
  names: readonly string[] = PLACEMENT_CELLS,
): void {
  const o = requireObject(tx, obj);
  for (const cell of names) {
    const before = storedCell(o, cell);
    if (before !== null) tx.record(cellEffect(obj, cell, before, null));
  }
}

// Move.

/**
 * Moves `obj` to `dest` (FORMULAS.md §8.3 `move`): out of its container or
 * off its board, then in at the destination, under the landing rule. Never
 * touches `owner`. Refuses a container that is `obj` or inside it.
 */
export function move(tx: Transaction, obj: ObjectId, dest: Destination): void {
  requireObject(tx, obj);
  const from = tx.doc.locationOf(obj) ?? invalid(`"${obj}" is not placed`);
  const target = checkDestination(tx, dest, (container) => {
    const n = tx.doc.contentsOf(container).length;
    return from.type === "container" && from.container === container ? n - 1 : n;
  });
  if (target.type === "container") {
    for (let c: ObjectId | null = target.container; c !== null; c = tx.doc.containerOf(c)) {
      if (c === obj)
        reject({ type: "containment_cycle", object: obj, container: target.container });
    }
  }
  tx.record({ type: "place", object: obj, before: from, after: locationOf(target) });
  if (target.type === "container") {
    dropPlacementCells(tx, obj);
    return;
  }
  // An object in a container has no rotation; this only clears a stray one.
  if (from.type === "container") dropPlacementCells(tx, obj, ["rotation"]);
  land(tx, obj, target.board, target.position);
}

// Ids.

/**
 * Allocates `<base>_<n>` for each base, `n` drawn from `next_seq` and
 * incremented per id, skipping reserved ids. Returns the ids and the new
 * `next_seq`; records nothing.
 */
function allocateIds(tx: Transaction, bases: readonly string[]): { ids: ObjectId[]; seq: number } {
  let seq = tx.doc.nextSeq;
  const taken = new Set<ObjectId>();
  const ids = bases.map((base) => {
    for (;;) {
      const id = `${base}_${seq}`;
      seq += 1;
      if (!tx.doc.isReserved(id) && !taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  });
  return { ids, seq };
}

// Create.

/** The base of an allocated id for `createObject` when none is given. */
const DEFAULT_BASE = "obj";

/**
 * Checks a new object record with the document invariants that concern it
 * alone (validateSnapshot over a document holding only it, placement aside).
 */
function checkRecord(o: TableObject): void {
  const parsed = TableObjectSchema.safeParse(o);
  if (!parsed.success) invalid(`not an object: ${parsed.error.message}`);
  const violations = validateSnapshot({
    revision: 0,
    next_seq: 0,
    boards: [],
    objects: { [o.id]: { ...o, board: null, cells: withoutPlacement(o.cells) } },
    retired_ids: [],
  }).filter((v) => v.kind !== "placement");
  if (violations.length > 0) invalid(violations.map((v) => v.message).join("; "));
}

function withoutPlacement(cells: Record<string, Cell>): Record<string, Cell> {
  const rest = { ...cells };
  for (const c of PLACEMENT_CELLS) delete rest[c];
  return rest;
}

/**
 * Creates an object from `init` at `dest` and returns its id. An explicit
 * `id` must be valid and not reserved; otherwise `obj_<n>` is allocated.
 * Records `allocate` and `create`; on a board the landing rule applies.
 * Placement cells are refused for a container destination.
 */
export function createObject(
  tx: Transaction,
  init: ObjectInit,
  dest: Destination,
  id?: ObjectId,
): ObjectId {
  if (typeof init !== "object" || init === null) invalid("no initial fields");
  for (const key of Object.keys(init)) {
    if (!INIT_FIELDS.has(key)) invalid(`"${key}" is not an initial field`);
  }
  const target = checkDestination(tx, dest, (c) => tx.doc.contentsOf(c).length);
  let seq = tx.doc.nextSeq;
  if (id !== undefined) {
    if (typeof id !== "string" || !isValidId(id)) invalid(`"${String(id)}" is not a valid id`);
    if (tx.doc.isReserved(id)) invalid(`"${id}" is reserved`);
  } else {
    const allocated = allocateIds(tx, [DEFAULT_BASE]);
    id = allocated.ids[0] as ObjectId;
    seq = allocated.seq;
  }
  const record: TableObject = {
    is_template: false,
    is_zone: false,
    is_character: false,
    tag: [],
    shape: null,
    cells: {},
    cell_visibility: {},
    actions: [],
    ...structuredClone(init),
    id,
    board: target.type === "board" ? target.board : null,
    contents: [],
  };
  checkRecord(record);
  if (target.type === "container") {
    for (const c of PLACEMENT_CELLS) {
      if (Object.hasOwn(record.cells, c)) invalid(`"${c}" is for objects on a board`);
    }
  }
  tx.record({ type: "allocate", ids: [id], seq_before: tx.doc.nextSeq, seq_after: seq });
  tx.record({ type: "create", objects: [record], location: locationOf(target) });
  if (target.type === "board") land(tx, id, target.board, target.position);
  return id;
}

// Spawn.

/** `v` with every reference to a copied object replaced by its copy's. */
function remapValue(v: Value, copies: ReadonlyMap<ObjectId, ObjectId>): Value {
  switch (v.type) {
    case "ref":
      return ref(copies.get(v.object) ?? v.object);
    case "list":
      return list(v.items.map((i) => remapValue(i, copies)));
    case "viewers":
      return remapViewers(v, copies);
    default:
      return structuredClone(v);
  }
}

function remapViewers(v: ViewersValue, copies: ReadonlyMap<ObjectId, ObjectId>): ViewersValue {
  return {
    type: "viewers",
    viewers: v.viewers.map((e) =>
      typeof e === "string" ? e : ref(copies.get(e.object) ?? e.object),
    ),
  };
}

function remapCell(c: Cell, copies: ReadonlyMap<ObjectId, ObjectId>): Cell {
  const content: CellContent =
    c.content.type === "formula" ? { ...c.content } : remapValue(c.content, copies);
  return c.override === undefined
    ? { content }
    : { content, override: remapValue(c.override, copies) };
}

/**
 * Checks an initial cell as `writeValue` (a literal) or `setFormula` (a
 * formula) would on `root`, so a refusal comes before anything is recorded.
 */
function checkInitialCell(root: TableObject, cell: string, content: unknown): void {
  if (typeof cell !== "string" || cell === "" || cell === "__proto__") {
    invalid(`"${String(cell)}" is not a cell name`);
  }
  if (cell === "is_template" || cell === "is_character") {
    invalid(`"${cell}" is a field of the object, not a cell`);
  }
  if (!isCellContent(content)) invalid(`not a cell content for "${cell}"`);
  const spec = structuralCell(cell);
  if (spec === undefined) return;
  const protectedCell = () => reject({ type: "protected_cell", object: root.id, cell });
  if (spec.protection !== "none") protectedCell();
  if (cell === "position" && root.board === null) protectedCell();
  if (cell === "opaque" && !root.is_zone) protectedCell();
  if ((cell === "rotation" || cell === "z") && root.board === null) {
    invalid(`"${cell}" is for objects on a board`);
  }
  const expected = spec.literal.join(" or ");
  if (content.type === "formula") {
    if (!spec.formula)
      reject({ type: "type_error", object: root.id, cell, expected: `a literal ${expected}` });
  } else if (!isValue(content) || !isStructuralLiteral(spec, content)) {
    reject({ type: "type_error", object: root.id, cell, expected });
  }
}

/**
 * Spawns a copy of `template` and its contents, transitively, at `dest`
 * (DESIGN.md §4.1, Spawn; FORMULAS.md §8.3). Ids are `<original>_<n>`;
 * references into the subtree are remapped, others kept; every copy's
 * `template` names its original; the root copy is not a template.
 * `initialCells` then replace the root's copied cells (a literal through
 * `writeValue`, a formula through `setFormula`), and on a board the landing
 * rule applies.
 */
export function spawn(
  tx: Transaction,
  template: ObjectId,
  dest: Destination,
  initialCells: Record<string, CellContent> = {},
): SpawnResult {
  requireObject(tx, template);
  const target = checkDestination(tx, dest, (c) => tx.doc.contentsOf(c).length);
  if (typeof initialCells !== "object" || initialCells === null) invalid("no initial cells");
  const originals = tx.doc.subtreeOf(template);
  const { ids, seq } = allocateIds(tx, originals);
  const copies = new Map(originals.map((o, i) => [o, ids[i] as ObjectId]));
  const records = originals.map((id) => {
    const o = requireObject(tx, id);
    const cells: Record<string, Cell> = {};
    for (const [name, c] of Object.entries(o.cells)) cells[name] = remapCell(c, copies);
    cells.template = { content: ref(id) };
    const cell_visibility: Record<string, ViewersValue> = {};
    for (const [name, v] of Object.entries(o.cell_visibility)) {
      cell_visibility[name] = remapViewers(v, copies);
    }
    const copy: TableObject = {
      ...structuredClone(o),
      id: copies.get(id) as ObjectId,
      contents: o.contents.map((c) => copies.get(c) as ObjectId),
      cells,
      cell_visibility,
    };
    return copy;
  });
  const root = records[0] as TableObject;
  root.is_template = false;
  root.board = target.type === "board" ? target.board : null;
  if (target.type === "container") root.cells = withoutPlacement(root.cells);
  const initial = Object.entries(initialCells);
  for (const [cell, content] of initial) checkInitialCell(root, cell, content);
  // Initial cells replace the copied content: the copy is created without
  // them and the writes below create them.
  for (const [cell] of initial) {
    if (structuralCell(cell)?.storage !== "field") delete root.cells[cell];
  }
  tx.record({ type: "allocate", ids, seq_before: tx.doc.nextSeq, seq_after: seq });
  tx.record({ type: "create", objects: records, location: locationOf(target) });
  for (const [cell, content] of initial) {
    if (content.type === "formula") setFormula(tx, root.id, cell, content.source);
    else writeValue(tx, root.id, cell, content);
  }
  if (target.type === "board") land(tx, root.id, target.board, target.position);
  return { root: root.id, copies };
}

// Remove.

/**
 * Removes `obj` and its contents, recursively (FORMULAS.md §8.3 `remove`):
 * one `remove` effect with the subtree in preorder and the root's location,
 * and one `retire` of the ids not already retired. References elsewhere
 * dangle.
 */
export function remove(tx: Transaction, obj: ObjectId): void {
  requireObject(tx, obj);
  const location = tx.doc.locationOf(obj) ?? invalid(`"${obj}" is not placed`);
  const ids = tx.doc.subtreeOf(obj);
  const objects = ids.map((id) => requireObject(tx, id));
  tx.record({ type: "remove", objects, location });
  const fresh = ids.filter((id) => !tx.doc.isRetired(id));
  if (fresh.length > 0) tx.record({ type: "retire", ids: fresh });
}
