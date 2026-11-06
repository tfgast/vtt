/**
 * The effect algebra (DESIGN.md §4.1, §7): applying resolved effects, their
 * exact historical inverses, the persisted effects of a user undo, undo
 * conflict keys, and the readable cells an effect changes.
 */
import { type CellKey, cellKey } from "@vtt/formula";
import {
  type Board,
  type BoardEffect,
  type CreateEffect,
  type Effect,
  type Location,
  type ObjectId,
  type RemoveEffect,
  type RetireEffect,
  STRUCTURAL_CELLS,
  structuralCell,
  type TableObject,
} from "@vtt/schema";
import type { DocState } from "./doc";

const clone = structuredClone;

// Applying effects.

function enter(state: DocState, id: ObjectId, at: Location): void {
  const o = state.require(id, "place");
  if (at.type === "board") {
    if (state.getBoard(at.board) === undefined) throw new Error(`no board "${at.board}"`);
    o.board = at.board;
  } else {
    o.board = null;
    state.insertIntoContainer(id, at.container, at.index);
  }
}

function leave(state: DocState, id: ObjectId, at: Location): void {
  const o = state.require(id, "place");
  if (at.type === "board") {
    if (o.board !== at.board) throw new Error(`"${id}" is not on board "${at.board}"`);
    o.board = null;
  } else {
    state.takeFromContainer(id, at.container, at.index);
  }
}

function create(state: DocState, e: CreateEffect | RemoveEffect): void {
  const [root] = e.objects;
  if (root === undefined) throw new Error("create of an empty subtree");
  for (const o of e.objects) {
    if (state.hasObject(o.id) || state.getBoard(o.id) !== undefined) {
      throw new Error(`create: "${o.id}" is live`);
    }
  }
  for (const o of e.objects) state.insertObject(o);
  if (e.location.type === "container") {
    state.insertIntoContainer(root.id, e.location.container, e.location.index);
  }
}

function remove(state: DocState, e: CreateEffect | RemoveEffect): void {
  const [root] = e.objects;
  if (root === undefined) throw new Error("remove of an empty subtree");
  if (e.location.type === "container") {
    state.takeFromContainer(root.id, e.location.container, e.location.index);
  }
  for (const o of e.objects) state.deleteObject(o.id);
}

function board(state: DocState, e: BoardEffect): void {
  if (e.before === null && e.after === null) throw new Error("board effect with no board");
  if (e.before !== null && state.getBoard(e.before.id) === undefined) {
    throw new Error(`no board "${e.before.id}"`);
  }
  if (e.before === null && e.after !== null) {
    if (state.getBoard(e.after.id) !== undefined || state.hasObject(e.after.id)) {
      throw new Error(`board "${e.after.id}" is live`);
    }
  }
  if (e.before !== null && e.after !== null && e.before.id !== e.after.id) {
    throw new Error("a board effect cannot change a board's id");
  }
  if (e.after !== null) state.putBoard(e.after);
  else if (e.before !== null) state.deleteBoard(e.before.id);
}

/** Applies one effect to `state`. Throws, leaving `state` unspecified, if it does not apply. */
export function applyEffect(state: DocState, e: Effect): void {
  switch (e.type) {
    case "cell": {
      const spec = structuralCell(e.cell);
      if (spec !== undefined && spec.storage !== "cell") {
        throw new Error(`"${e.cell}" is not stored in cells`);
      }
      const o = state.require(e.object, "cell");
      if (e.after === null) delete o.cells[e.cell];
      else o.cells[e.cell] = clone(e.after);
      return;
    }
    case "cell_visibility": {
      const o = state.require(e.object, "cell_visibility");
      if (e.after === null) delete o.cell_visibility[e.cell];
      else o.cell_visibility[e.cell] = clone(e.after);
      return;
    }
    case "field": {
      const o = state.require(e.object, "field");
      // A face of null is no layout: the field is absent (M5-D7).
      if (e.field === "face" && e.after === null) {
        delete o.face;
        return;
      }
      // Each variant pairs a field with its own value type.
      (o as unknown as Record<string, unknown>)[e.field] = clone(e.after);
      return;
    }
    case "place":
      leave(state, e.object, e.before);
      enter(state, e.object, e.after);
      return;
    case "create":
      create(state, e);
      return;
    case "remove":
      remove(state, e);
      return;
    case "reorder":
      state.setContents(e.container, e.after);
      return;
    case "board":
      board(state, e);
      return;
    case "allocate":
      state.setNextSeq(e.seq_after);
      return;
    case "retire":
      state.addRetired(e.ids);
      return;
  }
}

/**
 * A retire effect for `ids`, recording only the ids not already retired (and
 * each once), or null when there are none.
 */
export function retireEffect(state: DocState, ids: readonly ObjectId[]): RetireEffect | null {
  const fresh = [...new Set(ids)].filter((id) => !state.isRetired(id));
  return fresh.length === 0 ? null : { type: "retire", ids: fresh };
}

// Historical inverses.

/**
 * The exact reversal of an effect, for rewind (DESIGN.md §7). Internal: never
 * persisted, and not an Effect. Most reversals are themselves effects;
 * `unallocate` restores `next_seq` to `seq_before`, `unretire` removes
 * exactly the ids a retire added, and `restore_board` re-inserts a removed
 * board at its former index in `boards`, none of which a persisted effect
 * may do. The inverse of a board creation is a plain board removal.
 */
export type HistoricalInverse =
  | { type: "effect"; effect: Effect }
  | { type: "restore_board"; board: Board; index: number }
  | { type: "unallocate"; seq_before: number; seq_after: number }
  | { type: "unretire"; ids: ObjectId[] };

/** The swap of an effect's before and after, for the kinds where that is the reversal. */
function swapped(e: Effect): Effect {
  switch (e.type) {
    case "cell": {
      // The reversal of an add is a plain write back, not an add (M6-D22).
      const { added: _, ...rest } = e;
      return { ...rest, before: e.after, after: e.before };
    }
    case "cell_visibility":
    case "field":
    case "place":
    case "reorder":
    case "board":
      return { ...e, before: e.after, after: e.before } as Effect;
    case "create":
      return { type: "remove", objects: e.objects, location: e.location };
    case "remove":
      return { type: "create", objects: e.objects, location: e.location };
    case "allocate":
    case "retire":
      throw new Error(`no effect reverses ${e.type}`);
  }
}

/**
 * The exact reversal of `e`, given `stateBefore`, the document just before
 * `e` applied (a board removal needs the board's index in it).
 */
export function historicalInverse(e: Effect, stateBefore: DocState): HistoricalInverse {
  switch (e.type) {
    case "board":
      if (e.before !== null && e.after === null) {
        const index = stateBefore.boardIndex(e.before.id);
        if (index < 0) throw new Error(`no board "${e.before.id}"`);
        return { type: "restore_board", board: { ...e.before }, index };
      }
      return { type: "effect", effect: clone(swapped(e)) };
    case "allocate":
      return { type: "unallocate", seq_before: e.seq_before, seq_after: e.seq_after };
    case "retire":
      return { type: "unretire", ids: [...e.ids] };
    default:
      return { type: "effect", effect: clone(swapped(e)) };
  }
}

export function applyHistoricalInverse(state: DocState, inv: HistoricalInverse): void {
  switch (inv.type) {
    case "effect":
      applyEffect(state, inv.effect);
      return;
    case "unallocate":
      if (state.nextSeq !== inv.seq_after) {
        throw new Error(`unallocate: next_seq is ${state.nextSeq}, not ${inv.seq_after}`);
      }
      state.setNextSeq(inv.seq_before);
      return;
    case "unretire":
      state.removeRetired(inv.ids);
      return;
    case "restore_board":
      state.insertBoardAt(inv.board, inv.index);
      return;
  }
}

// User undo.

/** The current subtree of `root` and its location, as a remove effect. */
function removalOf(state: DocState, root: ObjectId): RemoveEffect {
  const location = state.locationOf(root);
  if (location === null || !state.hasObject(root)) throw new Error(`undo: "${root}" is not placed`);
  const objects = state.subtreeOf(root).map((id) => clone(state.require(id, "undo")));
  return { type: "remove", objects, location };
}

/**
 * The persisted effects that undo `e` (DESIGN.md §4.1, §7), given `state`,
 * the document the undo applies to (after the reversals of any later effects
 * of the same group). User undo never decreases `next_seq` or shrinks
 * `retired_ids`: undoing a creation retires the created ids, undoing a
 * removal leaves the restored ids retired, and allocation and retirement
 * have no undo.
 */
export function invertForUndo(e: Effect, state: DocState): Effect[] {
  switch (e.type) {
    case "cell":
    case "cell_visibility":
    case "field":
    case "place":
    case "reorder":
    case "remove":
      return [clone(swapped(e))];
    case "create": {
      const [root] = e.objects;
      if (root === undefined) return [];
      const removal = removalOf(state, root.id);
      const retire = retireEffect(
        state,
        removal.objects.map((o) => o.id),
      );
      return retire === null ? [removal] : [removal, retire];
    }
    case "board": {
      if (e.before !== null) return [clone(swapped(e))];
      if (e.after === null) return [];
      const current = state.getBoard(e.after.id) ?? e.after;
      const retire = retireEffect(state, [current.id]);
      const removal: Effect = { type: "board", before: { ...current }, after: null };
      return retire === null ? [removal] : [removal, retire];
    }
    case "allocate":
    case "retire":
      return [];
  }
}

// Undo conflict keys.

/**
 * An undo conflict key: `cell:<object>/<cell>`, `actions:<object>` (the
 * object's action list), `face:<object>` (its face layout, M5-D7),
 * `obj:<object>` (every key on that object), or `board:<board>`. Not a
 * CellKey.
 */
export type TouchedKey =
  | `cell:${ObjectId}/${string}`
  | `actions:${ObjectId}`
  | `face:${ObjectId}`
  | `obj:${ObjectId}`
  | `board:${string}`;

const cellTouch = (object: ObjectId, cell: string): TouchedKey => `cell:${object}/${cell}`;

const containerTouch = (at: Location): TouchedKey[] =>
  at.type === "container" ? [cellTouch(at.container, "contents")] : [];

/** The keys `e` touches, for undo conflicts (DESIGN.md §7), each once. */
export function touchedKeys(e: Effect): TouchedKey[] {
  const keys = ((): TouchedKey[] => {
    switch (e.type) {
      case "cell":
      case "cell_visibility":
        return [cellTouch(e.object, e.cell)];
      case "field":
        if (e.field === "actions") return [`actions:${e.object}`];
        if (e.field === "face") return [`face:${e.object}`];
        return [cellTouch(e.object, e.field)];
      case "place":
        return [
          cellTouch(e.object, "board"),
          cellTouch(e.object, "position"),
          ...containerTouch(e.before),
          ...containerTouch(e.after),
        ];
      case "create":
      case "remove":
        return [...e.objects.map((o): TouchedKey => `obj:${o.id}`), ...containerTouch(e.location)];
      case "reorder":
        return [cellTouch(e.container, "contents")];
      case "board": {
        const b = e.after ?? e.before;
        return b === null ? [] : [`board:${b.id}`];
      }
      case "allocate":
      case "retire":
        return [];
    }
  })();
  return [...new Set(keys)];
}

/** The object a key names, or null for a board key. */
function keyObject(key: string): ObjectId | null {
  if (key.startsWith("obj:")) return key.slice(4);
  if (key.startsWith("actions:")) return key.slice(8);
  if (key.startsWith("face:")) return key.slice(5);
  if (key.startsWith("cell:")) {
    const slash = key.indexOf("/");
    return slash < 0 ? null : key.slice(5, slash);
  }
  return null;
}

/** Whether two keys conflict: equal, or one is `obj:<id>` and the other names `<id>`. */
export function keysConflict(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith("obj:") || b.startsWith("obj:")) {
    const oa = keyObject(a);
    return oa !== null && oa === keyObject(b);
  }
  return false;
}

/** Whether any key of `a` conflicts with any key of `b`. */
export function keysIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => keysConflict(x, y)));
}

// Changed cells.

/** The readable cells of an object: every structural cell and every stored cell. */
function readableCells(o: TableObject): CellKey[] {
  return [
    ...STRUCTURAL_CELLS.map((s) => cellKey(o.id, s.name)),
    ...Object.keys(o.cells).map((c) => cellKey(o.id, c)),
  ];
}

const containerCells = (at: Location): CellKey[] =>
  at.type === "container" ? [cellKey(at.container, "contents")] : [];

/**
 * Every readable cell whose value `e` may change, derived ones included, each
 * once. Over-approximates: a write of the same value still lists its cell.
 * `stateBefore` is the document before `e`; no M2 effect needs more than the
 * effect itself, but derived changes are defined against it.
 */
export function changedCells(e: Effect, _stateBefore: DocState): CellKey[] {
  const keys = ((): CellKey[] => {
    switch (e.type) {
      case "cell":
        return [cellKey(e.object, e.cell)];
      case "field":
        // is_template, is_character, actions and face are fields, not readable cells.
        return e.field === "tag" || e.field === "shape" ? [cellKey(e.object, e.field)] : [];
      case "place":
        return [
          ...["board", "position", "rotation", "z", "container"].map((c) => cellKey(e.object, c)),
          ...containerCells(e.before),
          ...containerCells(e.after),
        ];
      case "create":
      case "remove":
        return [...e.objects.flatMap(readableCells), ...containerCells(e.location)];
      case "reorder":
        return [cellKey(e.container, "contents")];
      case "cell_visibility":
      case "board":
      case "allocate":
      case "retire":
        return [];
    }
  })();
  return [...new Set(keys)];
}
