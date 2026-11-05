/**
 * Edit primitives (DESIGN.md §4.1, §4.2, §4.4; FORMULAS.md §3.1, §8.2;
 * FIXTURES.md §5, §6): cell writes, formulas and overrides, cell deletion and
 * renaming, per-cell visibility, object fields, action lists, reordering, and
 * boards. Each
 * takes the open transaction, checks its arguments against the working copy,
 * and records resolved effects through `tx.record`. A refusal throws
 * Rejected before recording anything.
 */
import {
  type ActionDef,
  type BoardId,
  type Cell,
  type CellEffect,
  isStructuralLiteral,
  isValidId,
  isValue,
  type ObjectId,
  type Rejection,
  type RollValue,
  type Shape,
  type StructuralCellSpec,
  shapeProblem,
  structuralCell,
  type TableObject,
  type Value,
  type ViewersValue,
} from "@vtt/schema";
import type { Transaction } from "./transaction";
import { Rejected } from "./transaction";

function reject(rejection: Rejection): never {
  throw new Rejected(rejection);
}

function invalid(message: string): never {
  reject({ type: "invalid", message });
}

function protectedCell(object: ObjectId, cell: string): never {
  reject({ type: "protected_cell", object, cell });
}

function typeError(object: ObjectId, cell: string, expected: string): never {
  reject({ type: "type_error", object, cell, expected });
}

/**
 * The object, or an `invalid` refusal. A transaction's reads are copies of
 * the working copy's records (transaction.ts), so dropping `readonly` is safe.
 */
function requireObject(tx: Transaction, id: ObjectId): TableObject {
  const o = tx.doc.getObject(id) as TableObject | undefined;
  return o ?? invalid(`no object "${id}"`);
}

/** A key `cells` or `cell_visibility` may hold (FIXTURES.md §1). */
function requireCellName(cell: string): void {
  if (typeof cell !== "string" || cell === "" || cell === "__proto__") {
    invalid(`"${String(cell)}" is not a cell name`);
  }
}

/** Object fields that are not cells (DESIGN.md §4.1): never a cell name. */
const FLAGS: ReadonlySet<string> = new Set(["is_template", "is_character"]);

/**
 * Checks a cell name for a primitive that writes cell content and returns
 * its structural spec, if any. Engine-only cells (`id`, `board`, `is_zone`,
 * `contents`, `container`) and `shape` are protected; `position` belongs to
 * board objects and `opaque` to zones.
 */
function guardContentWrite(o: TableObject, cell: string): StructuralCellSpec | undefined {
  requireCellName(cell);
  if (FLAGS.has(cell)) invalid(`"${cell}" is a field of the object, not a cell`);
  const spec = structuralCell(cell);
  if (spec === undefined) return undefined;
  if (spec.protection !== "none") protectedCell(o.id, cell);
  if (cell === "position" && o.board === null) protectedCell(o.id, cell);
  if (cell === "opaque" && !o.is_zone) protectedCell(o.id, cell);
  return spec;
}

const expectedOf = (spec: StructuralCellSpec): string => spec.literal.join(" or ");

const storedCell = (o: TableObject, cell: string): Cell | null =>
  Object.hasOwn(o.cells, cell) ? (o.cells[cell] ?? null) : null;

function cellEffect(
  object: ObjectId,
  cell: string,
  before: Cell | null,
  after: Cell | null,
  cause: CellEffect["cause"] = "edit",
): CellEffect {
  return { type: "cell", object, cell, before, after, cause };
}

/** A dense array of strings; a hole fails (`every` would skip it). */
function isTextList(x: unknown): x is string[] {
  if (!Array.isArray(x)) return false;
  for (let i = 0; i < x.length; i++) {
    if (!(i in x) || typeof x[i] !== "string") return false;
  }
  return true;
}

/** Whether `p` is a dense permutation of `0..n-1`; a hole fails. */
function isPermutation(p: unknown, n: number): p is number[] {
  if (!Array.isArray(p) || p.length !== n) return false;
  const seen = new Set<number>();
  for (let k = 0; k < p.length; k++) {
    const i: unknown = p[k];
    if (!(k in p) || typeof i !== "number" || !Number.isInteger(i)) return false;
    if (i < 0 || i >= n || seen.has(i)) return false;
    seen.add(i);
  }
  return seen.size === n;
}

/**
 * Writes a literal: a literal or absent cell becomes `value`; a formula cell
 * gets `value` as its override, or, with `replace`, loses its formula (and
 * any override) to `value`.
 */
function writeLiteral(
  tx: Transaction,
  id: ObjectId,
  cell: string,
  value: Value,
  cause: CellEffect["cause"],
  replace = false,
): void {
  const o = requireObject(tx, id);
  const spec = guardContentWrite(o, cell);
  if (!isValue(value)) invalid(`not a storable value for "${cell}"`);
  if (spec !== undefined && !isStructuralLiteral(spec, value)) {
    typeError(id, cell, expectedOf(spec));
  }
  if (spec?.storage === "field") {
    // Only `tag` reaches here: the other field-backed cells are protected.
    // isStructuralLiteral has checked it is a list of text.
    const items = value.type === "list" ? value.items : [];
    setTag(
      tx,
      id,
      items.map((i) => (i.type === "text" ? i.value : "")),
    );
    return;
  }
  const before = storedCell(o, cell);
  const after: Cell =
    !replace && before !== null && before.content.type === "formula"
      ? { content: before.content, override: value }
      : { content: value };
  tx.record(cellEffect(id, cell, before, after, cause));
}

/**
 * A hand edit (FIXTURES.md §6 `set`, `override`): a literal or absent cell
 * becomes `value`; a formula cell gets `value` as its override.
 */
export function writeValue(tx: Transaction, obj: ObjectId, cell: string, value: Value): void {
  writeLiteral(tx, obj, cell, value, "edit");
}

/**
 * Replaces a formula by a literal (PROTOCOL.md §5 M4-D17; DESIGN.md §4.2):
 * on a cell whose stored content is a formula, with or without an override,
 * one cell effect from that formula state to the literal `value`, the
 * override gone with the formula. On a literal or absent cell, exactly
 * `writeValue`. The guards and type checks are `writeValue`'s: protected
 * cells are refused, structural cells such as `visible_to`, `position` or
 * `rotation` are allowed.
 */
export function replaceFormula(tx: Transaction, obj: ObjectId, cell: string, value: Value): void {
  writeLiteral(tx, obj, cell, value, "edit", true);
}

/** As `writeValue`, recording a roll result with cause `roll`. */
export function rollWrite(tx: Transaction, obj: ObjectId, cell: string, roll: RollValue): void {
  if (!isValue(roll) || roll.type !== "roll") invalid(`not a roll result for "${cell}"`);
  writeLiteral(tx, obj, cell, roll, "roll");
}

/** Replaces a cell's content with a formula, dropping any override. Creates an absent cell. */
export function setFormula(tx: Transaction, obj: ObjectId, cell: string, source: string): void {
  const o = requireObject(tx, obj);
  const spec = guardContentWrite(o, cell);
  if (spec !== undefined && !spec.formula) typeError(obj, cell, `a literal ${expectedOf(spec)}`);
  if (typeof source !== "string" || source.trim() === "") invalid("formula source is blank");
  const before = storedCell(o, cell);
  tx.record(cellEffect(obj, cell, before, { content: { type: "formula", source } }));
}

/** Removes a formula cell's override, so it follows its formula again. */
export function clearOverride(tx: Transaction, obj: ObjectId, cell: string): void {
  const o = requireObject(tx, obj);
  guardContentWrite(o, cell);
  const before = storedCell(o, cell);
  if (before === null || before.override === undefined) {
    invalid(`"${obj}.${cell}" has no override`);
  }
  tx.record(cellEffect(obj, cell, before, { content: before.content }));
}

/** Checks a cell name for deletion or renaming: any structural cell is protected. */
function guardUserCell(o: TableObject, cell: string): void {
  requireCellName(cell);
  if (structuralCell(cell) !== undefined) protectedCell(o.id, cell);
  if (FLAGS.has(cell)) invalid(`"${cell}" is a field of the object, not a cell`);
}

/** Deletes a stored user cell. Its per-cell visibility entry, if any, stays. */
export function deleteCell(tx: Transaction, obj: ObjectId, cell: string): void {
  const o = requireObject(tx, obj);
  guardUserCell(o, cell);
  const before = storedCell(o, cell) ?? invalid(`"${obj}.${cell}" is absent`);
  tx.record(cellEffect(obj, cell, before, null));
}

/**
 * Moves a user cell to an absent name, with its per-cell visibility: `to`
 * takes `from`'s entry (or loses its own when `from` has none), and `from`'s
 * entry is removed. Formulas naming `from` are not rewritten.
 */
export function renameCell(tx: Transaction, obj: ObjectId, from: string, to: string): void {
  const o = requireObject(tx, obj);
  guardUserCell(o, from);
  guardUserCell(o, to);
  const cell = storedCell(o, from) ?? invalid(`"${obj}.${from}" is absent`);
  if (storedCell(o, to) !== null || from === to) invalid(`"${obj}.${to}" exists`);
  tx.record(cellEffect(obj, from, cell, null));
  tx.record(cellEffect(obj, to, null, cell));
  const fromEntry = visibilityEntry(o, from);
  const toEntry = visibilityEntry(o, to);
  if (fromEntry !== null || toEntry !== null) {
    tx.record({
      type: "cell_visibility",
      object: obj,
      cell: to,
      before: toEntry,
      after: fromEntry,
    });
  }
  if (fromEntry !== null) {
    tx.record({ type: "cell_visibility", object: obj, cell: from, before: fromEntry, after: null });
  }
}

const visibilityEntry = (o: TableObject, cell: string): ViewersValue | null =>
  Object.hasOwn(o.cell_visibility, cell) ? (o.cell_visibility[cell] ?? null) : null;

/**
 * Sets or, with null, removes a cell's per-cell visibility (DESIGN.md §4.4).
 * Valid for any cell name, stored or not. Removing an entry that is not
 * there records nothing.
 */
export function setCellVisibility(
  tx: Transaction,
  obj: ObjectId,
  cell: string,
  viewers: ViewersValue | null,
): void {
  const o = requireObject(tx, obj);
  requireCellName(cell);
  if (viewers !== null && (!isValue(viewers) || viewers.type !== "viewers")) {
    typeError(obj, cell, "a non-empty viewers value");
  }
  const before = visibilityEntry(o, cell);
  if (before === null && viewers === null) return;
  tx.record({ type: "cell_visibility", object: obj, cell, before, after: viewers });
}

/** Replaces the object's tags. */
export function setTag(tx: Transaction, obj: ObjectId, tags: string[]): void {
  const o = requireObject(tx, obj);
  if (!isTextList(tags)) typeError(obj, "tag", "text_list");
  tx.record({ type: "field", object: obj, field: "tag", before: o.tag, after: [...tags] });
}

/** Replaces the object's shape, or clears it with null; the only way `shape` changes. */
export function setShape(tx: Transaction, obj: ObjectId, shape: Shape | null): void {
  const o = requireObject(tx, obj);
  if (shape !== null) {
    if (!isValue({ type: "shape", shape })) typeError(obj, "shape", "shape");
    const problem = shapeProblem(shape);
    if (problem !== undefined) typeError(obj, "shape", `a valid shape (${problem})`);
  }
  tx.record({ type: "field", object: obj, field: "shape", before: o.shape, after: shape });
}

function requireBoolean(obj: ObjectId, field: string, value: boolean): void {
  if (typeof value !== "boolean") invalid(`"${obj}.${field}" takes a boolean`);
}

export function setTemplateFlag(tx: Transaction, obj: ObjectId, value: boolean): void {
  const o = requireObject(tx, obj);
  requireBoolean(obj, "is_template", value);
  tx.record({
    type: "field",
    object: obj,
    field: "is_template",
    before: o.is_template,
    after: value,
  });
}

export function setCharacterFlag(tx: Transaction, obj: ObjectId, value: boolean): void {
  const o = requireObject(tx, obj);
  requireBoolean(obj, "is_character", value);
  tx.record({
    type: "field",
    object: obj,
    field: "is_character",
    before: o.is_character,
    after: value,
  });
}

/**
 * Reorders a container's contents: `new[i] = old[permutation[i]]`
 * (FIXTURES.md §5). `permutation` must be a permutation of the length.
 */
export function reorder(tx: Transaction, container: ObjectId, permutation: number[]): void {
  const o = requireObject(tx, container);
  const old = o.contents;
  if (!isPermutation(permutation, old.length))
    invalid(`not a permutation of ${old.length} for "${container}"`);
  const after = permutation.map((i) => old[i] as ObjectId);
  tx.record({ type: "reorder", container, before: [...old], after });
}

/**
 * Creates a board under a fresh caller-chosen id: valid, and not reserved
 * (a live board, a live object, or retired). Allocates the id without
 * changing `next_seq`.
 */
export function addBoard(tx: Transaction, id: BoardId, name?: string): void {
  if (typeof id !== "string" || !isValidId(id)) invalid(`"${String(id)}" is not a valid id`);
  if (tx.doc.isReserved(id)) invalid(`"${id}" is reserved`);
  if (name !== undefined && typeof name !== "string") invalid("a board name is text");
  const seq = tx.doc.nextSeq;
  tx.record({ type: "allocate", ids: [id], seq_before: seq, seq_after: seq });
  tx.record({ type: "board", before: null, after: name === undefined ? { id } : { id, name } });
}

export function renameBoard(tx: Transaction, id: BoardId, name: string): void {
  const before = tx.doc.getBoard(id) ?? invalid(`no board "${id}"`);
  if (typeof name !== "string") invalid("a board name is text");
  tx.record({ type: "board", before, after: { ...before, name } });
}

/**
 * Removes a board (DESIGN.md §4.3). Refused unless the board exists and no
 * object is directly on it; there is no cascade. Records the board's removal
 * and the retirement of its id, which stays reserved: user undo re-creates
 * the board, but `addBoard` with that id is refused for good.
 */
export function removeBoard(tx: Transaction, id: BoardId): void {
  const before = tx.doc.getBoard(id) ?? invalid(`no board "${String(id)}"`);
  const on = tx.doc.objectsOnBoard(id);
  if (on.length > 0) invalid(`board "${id}" is not empty (${on.length} on it)`);
  tx.record({ type: "board", before, after: null });
  if (!tx.doc.isRetired(id)) tx.record({ type: "retire", ids: [id] });
}

/** The longest action name, in characters (code points). */
const MAX_ACTION_NAME = 100;

const ACTION_KEYS: ReadonlySet<string> = new Set(["name", "when", "steps"]);

const isSource = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

/** A checked copy of one action, or an `invalid` refusal. */
function actionDef(obj: ObjectId, a: unknown, i: number): ActionDef {
  if (typeof a !== "object" || a === null || Array.isArray(a)) {
    invalid(`action ${i} of "${obj}" is not an action`);
  }
  const r = a as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !ACTION_KEYS.has(k));
  if (extra !== undefined) invalid(`action ${i} of "${obj}" has an unknown key "${extra}"`);
  const { name, when, steps } = r;
  if (typeof name !== "string" || name === "") invalid(`action ${i} of "${obj}" has no name`);
  if ([...name].length > MAX_ACTION_NAME) {
    invalid(`action name "${name.slice(0, 20)}…" is longer than ${MAX_ACTION_NAME} characters`);
  }
  if (when !== undefined && !isSource(when)) {
    invalid(`action "${name}" of "${obj}": \`when\` is not source text`);
  }
  if (!isTextList(steps)) invalid(`action "${name}" of "${obj}": steps are not a list of text`);
  if (!steps.every(isSource)) invalid(`action "${name}" of "${obj}" has a blank step`);
  return when === undefined ? { name, steps: [...steps] } : { name, when, steps: [...steps] };
}

/**
 * Replaces the object's whole action list (DESIGN.md §4.5, §5.2; FORMULAS.md
 * §8) with one field effect. Names are non-empty, at most 100 characters,
 * and unique on the object (exact comparison). `when` and steps are source
 * text, stored verbatim and not parsed.
 */
export function setActions(tx: Transaction, obj: ObjectId, actions: ActionDef[]): void {
  const o = requireObject(tx, obj);
  if (!Array.isArray(actions)) invalid(`the actions of "${obj}" are not a list`);
  const after: ActionDef[] = [];
  const names = new Set<string>();
  for (let i = 0; i < actions.length; i++) {
    if (!(i in actions)) invalid(`action ${i} of "${obj}" is missing`);
    const a = actionDef(obj, actions[i], i);
    if (names.has(a.name)) invalid(`"${obj}" has two actions named "${a.name}"`);
    names.add(a.name);
    after.push(a);
  }
  tx.record({ type: "field", object: obj, field: "actions", before: o.actions, after });
}
