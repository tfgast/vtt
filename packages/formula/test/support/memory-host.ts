/**
 * MemoryHost: the mutable test document of M1 (FORMULAS.md §3.1, §6;
 * FIXTURES.md §3, §6). It implements EvalHost over plain TableObjects, never
 * evaluates a formula, and offers test-only mutators that each return the
 * Changes to feed the engine's invalidation.
 *
 * Mutators enforce the document's invariants (placement, containment,
 * literal-only `name` and `tag`) by throwing: a test that misuses them is a
 * broken test, not a rejected step. Rejection is the runner's business.
 */
import type { Setup } from "@vtt/fixtures";
import type { Change, EvalHost } from "@vtt/formula";
import {
  type Bounds,
  boundsIntersect,
  type Cell,
  type CellContent,
  type FormulaContent,
  indexBounds,
  isStructuralLiteral,
  list,
  num,
  type ObjectId,
  type Point,
  ref,
  type Shape,
  STRUCTURAL_CELLS,
  structuralCell,
  structuralDefault,
  type TableObject,
  type Value,
} from "@vtt/schema";
import { fromFixtureContent, fromFixtureValue } from "./fixture-values";

/** A board destination (FIXTURES §6); the fixture `type` tag is optional. */
export interface BoardDestination {
  type?: "board";
  board: ObjectId;
  position: Point;
}

/** A container destination (FIXTURES §6); `index` defaults to append. */
export interface ContainerDestination {
  type?: "container";
  container: ObjectId;
  index?: number;
}

export type Destination = BoardDestination | ContainerDestination;

/** Where `createObject` puts a new object. A board placement may hold a formula position. */
export type CreatePlacement =
  | { board: ObjectId; position: Point | FormulaContent }
  | { container: ObjectId; index?: number };

export interface CreateInit {
  /** Ordinary and cell-backed structural cells; not field-backed ones or `position`. */
  cells?: Record<string, CellContent>;
  tag?: string[];
  shape?: Shape;
  is_zone?: boolean;
  placement: CreatePlacement;
}

/** Cells that `cells` (setup or createObject) may not write: fields, derived, and `position`. */
const NOT_IN_CELLS = new Set(
  STRUCTURAL_CELLS.filter((s) => s.storage !== "cell")
    .map((s) => s.name as string)
    .concat("position"),
);

/** Cells that exist exactly when the object is on a board. */
const BOARD_ONLY = new Set(["position", "rotation", "z"]);

const GEOMETRY_FORMULA_CELLS = ["position", "rotation", "z", "shape"] as const;

const isFormula = (c: CellContent): c is FormulaContent => c.type === "formula";

const isFinitePoint = (v: CellContent | undefined): v is Value & { type: "list" } =>
  v !== undefined &&
  v.type === "list" &&
  v.items.length === 2 &&
  v.items.every((i) => i.type === "number" && Number.isFinite(i.value));

const pointValue = (p: Point): Value => list([num(p[0]), num(p[1])]);

/**
 * The candidate set of FORMULAS §6, by brute force over any host's literal
 * geometry: objects on `board` whose literal indexBounds meet `near`, plus
 * those with a formula-valued geometry cell. `host.cell` returns an override
 * as its literal, so an overridden formula counts as literal. The reference
 * other hosts are tested against.
 */
export function literalCandidates(host: EvalHost, board: ObjectId, near: Bounds): ObjectId[] {
  const out: ObjectId[] = [];
  for (const id of host.allObjects()) {
    const b = host.cell(id, "board");
    if (b?.type !== "ref" || b.object !== board) continue;
    const geometry = GEOMETRY_FORMULA_CELLS.map((name) => host.cell(id, name));
    if (geometry.some((c) => c !== undefined && isFormula(c))) {
      out.push(id);
      continue;
    }
    const [position, rotation, , shapeCell] = geometry;
    if (!isFinitePoint(position)) continue;
    const anchor: Point = [
      (position.items[0] as { value: number }).value,
      (position.items[1] as { value: number }).value,
    ];
    const deg = rotation?.type === "number" && Number.isFinite(rotation.value) ? rotation.value : 0;
    const s = shapeCell?.type === "shape" ? shapeCell.shape : null;
    if (boundsIntersect(indexBounds(s, anchor, deg), near)) out.push(id);
  }
  return out;
}

export class MemoryHost implements EvalHost {
  private readonly boards = new Set<ObjectId>();
  private readonly objects = new Map<ObjectId, TableObject>();

  /** Build the post-setup document of a fixture scenario (FIXTURES §3). */
  static fromSetup(setup: Setup): MemoryHost {
    const host = new MemoryHost();
    for (const b of setup.boards) host.boards.add(b.id);
    for (const o of setup.objects) {
      if (host.idTaken(o.id)) throw new Error(`setup: duplicate id "${o.id}"`);
      const cells: Record<string, Cell> = {};
      for (const [name, c] of Object.entries(o.cells ?? {})) {
        checkCellContent(o.id, name, fromFixtureContent(c), "setup");
        cells[name] = { content: fromFixtureContent(c) };
      }
      let board: ObjectId | null = null;
      if (o.placement !== undefined) {
        board = o.placement.board;
        const p = o.placement.position;
        cells.position = { content: Array.isArray(p) ? pointValue(p) : fromFixtureContent(p) };
      }
      const cell_visibility: TableObject["cell_visibility"] = {};
      for (const [name, v] of Object.entries(o.cell_visibility ?? {})) {
        const viewers = fromFixtureValue(v);
        if (viewers.type !== "viewers") throw new Error(`setup: ${o.id} cell_visibility ${name}`);
        cell_visibility[name] = viewers;
      }
      host.objects.set(o.id, {
        id: o.id,
        is_template: o.is_template ?? false,
        is_zone: o.is_zone ?? false,
        is_character: setup.characters.includes(o.id),
        tag: [...(o.tag ?? [])],
        shape: o.shape === undefined ? null : structuredClone(o.shape),
        board,
        contents: [...(o.contents ?? [])],
        cells,
        cell_visibility,
        actions: (o.actions ?? []).map((a) => structuredClone(a)),
      });
    }
    host.checkPlacement();
    return host;
  }

  // ------------------------------------------------------------- EvalHost

  exists(id: ObjectId): boolean {
    return this.boards.has(id) || this.objects.has(id);
  }

  cell(id: ObjectId, name: string): CellContent | undefined {
    const obj = this.objects.get(id);
    if (obj === undefined) return undefined;
    const spec = structuralCell(name);
    if (spec?.name === "container") {
      const parent = this.containerOf(id);
      return parent === null ? structuralDefault("container", obj) : ref(parent);
    }
    if (spec !== undefined && spec.storage !== "cell") return structuralDefault(spec.name, obj);
    const stored = Object.hasOwn(obj.cells, name) ? obj.cells[name] : undefined;
    if (stored !== undefined) return structuredClone(stored.override ?? stored.content);
    return spec === undefined ? undefined : structuralDefault(spec.name, obj);
  }

  objectsNamed(name: string): ObjectId[] {
    return this.allObjects().filter((id) => {
      const n = this.cell(id, "name");
      return n?.type === "text" && n.value === name;
    });
  }

  allObjects(): ObjectId[] {
    return [...this.objects.keys()];
  }

  objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[] {
    return literalCandidates(this, board, near);
  }

  // ------------------------------------------------------------ inspection

  /** Whether the cell holds a formula with an override. */
  isOverridden(id: ObjectId, cell: string): boolean {
    const stored = this.storedCell(this.object(id), cell);
    return stored?.override !== undefined;
  }

  /** The object's `is_character` field (not a readable cell). */
  isCharacter(id: ObjectId): boolean {
    return this.object(id).is_character;
  }

  /** The object's `is_template` field (not a readable cell). */
  isTemplate(id: ObjectId): boolean {
    return this.object(id).is_template;
  }

  // -------------------------------------------------------------- mutators

  /**
   * Hand-edit a literal (FIXTURES §6 `set`), creating an absent cell. Throws
   * on a formula cell (use `override`), on a structural cell only the engine
   * or `setShape` writes, and on a structural literal of the wrong type.
   */
  set(id: ObjectId, cell: string, value: Value): Change[] {
    const stored = this.storedCell(this.object(id), cell);
    if (stored !== undefined && isFormula(stored.content)) {
      throw new Error(`set: ${id}.${cell} holds a formula; use override`);
    }
    return this.replaceContent(id, cell, value);
  }

  /** Type a literal over a formula cell (FIXTURES §6 `override`). */
  override(id: ObjectId, cell: string, value: Value): Change[] {
    const obj = this.object(id);
    const stored = this.storedCell(obj, cell);
    if (stored === undefined || !isFormula(stored.content)) {
      throw new Error(`override: ${id}.${cell} does not hold a formula`);
    }
    checkStructuralLiteral(id, cell, value);
    return this.track([id], () => {
      stored.override = structuredClone(value);
    });
  }

  /** Remove an override (FIXTURES §6 `clear_override`). */
  clearOverride(id: ObjectId, cell: string): Change[] {
    const stored = this.storedCell(this.object(id), cell);
    if (stored?.override === undefined) {
      throw new Error(`clearOverride: ${id}.${cell} has no override`);
    }
    return this.track([id], () => {
      delete stored.override;
    });
  }

  /**
   * Replace a cell's content with a literal or a formula, dropping any
   * override. `tag` takes a literal list of text. Throws on a formula in
   * `name` or `tag`, and on structural cells only moves, spawns, or
   * `setShape` write.
   */
  replaceContent(id: ObjectId, cell: string, content: CellContent): Change[] {
    const obj = this.object(id);
    if (cell === "tag") {
      if (isFormula(content)) throw new Error(`${id}.tag is literal only`);
      checkStructuralLiteral(id, cell, content);
      const tag = (content as Value & { type: "list" }).items.map((i) =>
        i.type === "text" ? i.value : "",
      );
      return this.track([id], () => {
        obj.tag = tag;
      });
    }
    if (NOT_IN_CELLS.has(cell) && cell !== "position") {
      throw new Error(`${id}.${cell} is not written by a cell edit`);
    }
    if (BOARD_ONLY.has(cell) && obj.board === null) {
      throw new Error(`${id}.${cell} exists only on a board`);
    }
    checkCellContent(id, cell, content, "replaceContent");
    return this.track([id], () => {
      obj.cells[cell] = { content: structuredClone(content) };
    });
  }

  /**
   * Move an object (FIXTURES §6 destinations) with the landing rules of
   * FORMULAS §3.1. Throws on an unknown destination, an index past the end,
   * or a containment cycle.
   */
  move(id: ObjectId, dest: Destination): Change[] {
    const obj = this.object(id);
    const oldParent = this.containerOf(id);
    if ("container" in dest) {
      const parent = this.object(dest.container);
      if (dest.container === id || this.descendants(id).includes(dest.container)) {
        throw new Error(`move: ${id} into ${dest.container} makes a containment cycle`);
      }
      const remaining = parent.contents.filter((c) => c !== id);
      const index = dest.index ?? remaining.length;
      if (!Number.isInteger(index) || index < 0 || index > remaining.length) {
        throw new Error(`move: index ${index} out of range for ${dest.container}`);
      }
      return this.track([id, oldParent, dest.container], () => {
        this.detach(id);
        parent.contents = remaining;
        parent.contents.splice(index, 0, id);
        obj.board = null;
        for (const c of BOARD_ONLY) delete obj.cells[c];
      });
    }
    if (!this.boards.has(dest.board)) throw new Error(`move: no board "${dest.board}"`);
    const z = this.landingZ(id, dest.board);
    return this.track([id, oldParent], () => {
      this.detach(id);
      obj.board = dest.board;
      const position = pointValue(dest.position);
      const stored = this.storedCell(obj, "position");
      if (stored !== undefined && isFormula(stored.content)) stored.override = position;
      else obj.cells.position = { content: position };
      const zCell = this.storedCell(obj, "z");
      if (zCell === undefined || !isFormula(zCell.content)) obj.cells.z = { content: num(z) };
    });
  }

  /**
   * Create an object. A board placement writes `position` as given (no
   * landing rule: this is the setup constructor, not a spawn); a container
   * placement inserts at `index` (default append).
   */
  createObject(id: ObjectId, init: CreateInit): Change[] {
    if (this.idTaken(id)) throw new Error(`createObject: id "${id}" is taken`);
    const cells: Record<string, Cell> = {};
    for (const [name, c] of Object.entries(init.cells ?? {})) {
      checkCellContent(id, name, c, "createObject");
      cells[name] = { content: structuredClone(c) };
    }
    const obj: TableObject = {
      id,
      is_template: false,
      is_zone: init.is_zone ?? false,
      is_character: false,
      tag: [...(init.tag ?? [])],
      shape: init.shape === undefined ? null : structuredClone(init.shape),
      board: null,
      contents: [],
      cells,
      cell_visibility: {},
      actions: [],
    };
    const p = init.placement;
    if ("board" in p) {
      if (!this.boards.has(p.board)) throw new Error(`createObject: no board "${p.board}"`);
      obj.board = p.board;
      cells.position = {
        content: Array.isArray(p.position) ? pointValue(p.position) : structuredClone(p.position),
      };
      this.objects.set(id, obj);
      return [{ type: "object_created", object: id }];
    }
    const parent = this.object(p.container);
    const index = p.index ?? parent.contents.length;
    if (!Number.isInteger(index) || index < 0 || index > parent.contents.length) {
      throw new Error(`createObject: index ${index} out of range for ${p.container}`);
    }
    for (const c of BOARD_ONLY) {
      if (Object.hasOwn(cells, c)) throw new Error(`createObject: ${id}.${c} needs a board`);
    }
    const changes = this.track([p.container], () => {
      parent.contents.splice(index, 0, id);
    });
    this.objects.set(id, obj);
    return [{ type: "object_created", object: id }, ...changes];
  }

  /** Delete an object and everything in it, recursively. */
  deleteObject(id: ObjectId): Change[] {
    this.object(id);
    const removed = [id, ...this.descendants(id)];
    const parent = this.containerOf(id);
    const changes = this.track([parent], () => {
      this.detach(id);
      for (const r of removed) this.objects.delete(r);
    });
    return [...removed.map((r): Change => ({ type: "object_deleted", object: r })), ...changes];
  }

  // -------------------------------------------------------------- internals

  private idTaken(id: ObjectId): boolean {
    return this.exists(id);
  }

  private object(id: ObjectId): TableObject {
    const obj = this.objects.get(id);
    if (obj === undefined) throw new Error(`no object "${id}"`);
    return obj;
  }

  private storedCell(obj: TableObject, name: string): Cell | undefined {
    return Object.hasOwn(obj.cells, name) ? obj.cells[name] : undefined;
  }

  private containerOf(id: ObjectId): ObjectId | null {
    for (const o of this.objects.values()) if (o.contents.includes(id)) return o.id;
    return null;
  }

  /** Every object inside `id`, transitively, in pre-order. */
  private descendants(id: ObjectId): ObjectId[] {
    const out: ObjectId[] = [];
    const walk = (o: ObjectId) => {
      for (const c of this.objects.get(o)?.contents ?? []) {
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }

  /** Take the object out of its container's contents, if any. */
  private detach(id: ObjectId): void {
    const parent = this.containerOf(id);
    if (parent !== null) {
      const p = this.object(parent);
      p.contents = p.contents.filter((c) => c !== id);
    }
  }

  /**
   * 1 + the largest literal `z` among the other objects on `board` (absent,
   * empty, or non-number as 0; an overridden formula as its override; a
   * formula without one skipped).
   */
  private landingZ(id: ObjectId, board: ObjectId): number {
    let top = 0;
    for (const o of this.objects.values()) {
      if (o.id === id || o.board !== board) continue;
      const stored = this.storedCell(o, "z");
      const literal =
        stored === undefined
          ? undefined
          : (stored.override ?? (isFormula(stored.content) ? null : stored.content));
      if (literal === null) continue;
      const z = literal?.type === "number" && Number.isFinite(literal.value) ? literal.value : 0;
      top = Math.max(top, z);
    }
    return top + 1;
  }

  /** Every object is on exactly one board or in exactly one container (DESIGN §4.1). */
  private checkPlacement(): void {
    const parents = new Map<ObjectId, ObjectId>();
    for (const o of this.objects.values()) {
      if (o.board !== null && !this.boards.has(o.board)) {
        throw new Error(`setup: ${o.id} is on unknown board "${o.board}"`);
      }
      for (const c of o.contents) {
        if (!this.objects.has(c)) throw new Error(`setup: ${o.id} contains unknown "${c}"`);
        if (parents.has(c)) throw new Error(`setup: ${c} is in two containers`);
        parents.set(c, o.id);
      }
    }
    for (const o of this.objects.values()) {
      const contained = parents.has(o.id);
      if (contained === (o.board !== null)) {
        throw new Error(`setup: ${o.id} must be on a board or in a container, not both or neither`);
      }
      if (this.descendants(o.id).includes(o.id)) {
        throw new Error(`setup: containment cycle through ${o.id}`);
      }
    }
  }

  /**
   * Run `mutate` and report every cell of the named objects whose stored
   * content or read value changed. Ids that are null or do not exist both
   * before and after are skipped (creation and deletion report themselves).
   */
  private track(ids: (ObjectId | null)[], mutate: () => void): Change[] {
    const live = [...new Set(ids.filter((i): i is ObjectId => i !== null))];
    const before = new Map(live.map((id) => [id, this.snapshot(id)]));
    mutate();
    const changes: Change[] = [];
    for (const id of live) {
      const a = before.get(id);
      const b = this.snapshot(id);
      if (a === undefined || b === undefined) continue;
      for (const name of new Set([...a.keys(), ...b.keys()])) {
        if (a.get(name) !== b.get(name)) changes.push({ type: "cell", object: id, cell: name });
      }
    }
    return changes;
  }

  /** Cell name to a canonical encoding of its read value and stored cell. */
  private snapshot(id: ObjectId): Map<string, string> | undefined {
    const obj = this.objects.get(id);
    if (obj === undefined) return undefined;
    const out = new Map<string, string>();
    const names = new Set([
      ...STRUCTURAL_CELLS.map((s) => s.name as string),
      ...Object.keys(obj.cells),
    ]);
    for (const name of names) {
      out.set(name, JSON.stringify([this.cell(id, name), this.storedCell(obj, name) ?? null]));
    }
    return out;
  }
}

function checkStructuralLiteral(id: ObjectId, cell: string, value: Value): void {
  const spec = structuralCell(cell);
  if (spec !== undefined && !isStructuralLiteral(spec, value)) {
    throw new Error(`${id}.${cell}: ${value.type} is not a valid ${cell}`);
  }
}

/** The rules for content written through `cells` or a cell edit. */
function checkCellContent(id: ObjectId, cell: string, content: CellContent, who: string): void {
  if (who !== "replaceContent" && NOT_IN_CELLS.has(cell)) {
    throw new Error(`${who}: ${id}.${cell} cannot be written in cells`);
  }
  const spec = structuralCell(cell);
  if (spec === undefined) return;
  if (isFormula(content)) {
    if (!spec.formula) throw new Error(`${who}: ${id}.${cell} is literal only`);
    return;
  }
  checkStructuralLiteral(id, cell, content);
}
