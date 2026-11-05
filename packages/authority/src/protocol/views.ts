/**
 * Viewer-filtered views (DESIGN.md §4.3, §4.4 "What a viewer is sent", §7;
 * FORMULAS.md §9; PROTOCOL.md §7): object views, redaction, covers, effect
 * views and group views, computed for the GM or for a character from one
 * Table at one revision.
 *
 * The GM's views are lossless conversions. A character's are filtered by
 * the Table's `Visibility` (effective visibility, cover, per-cell
 * visibility, face-down): no formula source, no action source, no per-cell
 * visibility metadata, refs to what the viewer cannot see redacted in place,
 * and errors whose origin the viewer cannot see reduced to their code.
 */
import type {
  ActionView,
  CellStateView,
  CellView,
  Cover,
  EffectView,
  FaceLayoutElementView,
  FaceLayoutView,
  GroupView,
  LocationView,
  ObjectSnapshotView,
  ObjectView,
  WireResult,
  WireValue,
  WireViewers,
} from "@vtt/protocol";
import {
  type ActionDef,
  type Actor,
  type Board,
  type BoardId,
  type Cell,
  type Effect,
  type FaceElement,
  type FaceLayout,
  type Location,
  type ObjectId,
  type OpGroup,
  type Point,
  type Result,
  type Shape,
  STRUCTURAL_CELLS,
  structuralCell,
  type TableObject,
  type Value,
  type ViewersValue,
} from "@vtt/schema";
import type { Table } from "../engine/table";
import type { DeepReadonly } from "../store/history";
import type { Viewer } from "../visibility";

/**
 * Every readable structural cell except `id`, in FORMULAS.md §3.1 order:
 * the structural cells of an object view (PROTOCOL.md §7.2).
 */
export const STRUCTURAL_VIEW_CELLS: readonly string[] = Object.freeze(
  STRUCTURAL_CELLS.filter((s) => s.name !== "id").map((s) => s.name),
);

/** Which cells an object view holds: all, the structural ones, or the named ones. */
export type ViewCells = "all" | "structural" | readonly string[];

export interface GroupViewOptions {
  /** Whether the view carries `effects`. Never changes whether a group is omitted. */
  effects: boolean;
}

/**
 * An effect as a viewer sees it: `view` null when dropped; `reduced` when it
 * is not kept unreduced (dropped, or a cell, snapshot object, value, ref or
 * id omitted, nulled or redacted; a face element omitted). Omitting formula
 * source, action `when` and `steps`, face `show_when`, and per-cell
 * visibility metadata is how every character view presents them, not a
 * reduction. Always unreduced for the GM.
 */
export interface FilteredEffect {
  view: EffectView | null;
  reduced: boolean;
}

const REDACTED = Object.freeze({ type: "redacted" }) as { type: "redacted" };

/** Per Table, for the life of the process: zone id → its cover key (`c<n>`). */
const COVER_KEYS = new WeakMap<Table, { next: number; keys: Map<ObjectId, string> }>();

/** The stable cover key of `zone` on `table`; never contains the zone id. */
function coverKey(table: Table, zone: ObjectId): string {
  let entry = COVER_KEYS.get(table);
  if (entry === undefined) {
    entry = { next: 1, keys: new Map() };
    COVER_KEYS.set(table, entry);
  }
  let key = entry.keys.get(zone);
  if (key === undefined) {
    key = `c${entry.next++}`;
    entry.keys.set(zone, key);
  }
  return key;
}

/** The anchor, if `r` is a list of two finite numbers (as M2's cover oracle reads it). */
function anchorOf(r: Result): Point | undefined {
  if (r.type !== "list" || r.items.length !== 2) return undefined;
  const [x, y] = r.items;
  if (x?.type !== "number" || y?.type !== "number") return undefined;
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return undefined;
  return [x.value, y.value];
}

/** A rotation as M2's cover oracle reads it: a number, empty as 0, a roll as its total. */
function rotationOf(r: Result): number | undefined {
  const n =
    r.type === "number"
      ? r.value
      : r.type === "empty"
        ? 0
        : r.type === "roll"
          ? r.total
          : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

const clone = <T>(x: DeepReadonly<T> | T): T => structuredClone(x) as T;

/** Tracks whether a character conversion reduced anything. */
interface Reduction {
  reduced: boolean;
}

/**
 * Builds views for one viewer from one Table. Meant for one build pass at
 * one revision: `canSeeObject` and `canSeeCell` are memoized, and the memo
 * is dropped if the store's revision moves on.
 */
export class ViewBuilder {
  readonly table: Table;
  readonly viewer: Viewer;
  #revision: number;
  #objects = new Map<ObjectId, boolean>();
  #cells = new Map<ObjectId, Map<string, boolean>>();

  constructor(table: Table, viewer: Viewer) {
    this.table = table;
    this.viewer = viewer;
    this.#revision = table.store.revision;
  }

  get #gm(): boolean {
    return this.viewer.type === "gm";
  }

  #fresh(): void {
    if (this.table.store.revision === this.#revision) return;
    this.#revision = this.table.store.revision;
    this.#objects = new Map();
    this.#cells = new Map();
  }

  /** `object_visible` for this viewer (memoized). False for an id that is not a live object. */
  canSeeObject(id: ObjectId): boolean {
    this.#fresh();
    let seen = this.#objects.get(id);
    if (seen === undefined) {
      seen = this.table.visibility.canSeeObject(this.viewer, id);
      this.#objects.set(id, seen);
    }
    return seen;
  }

  /** `cell_visible` for this viewer (memoized). */
  canSeeCell(id: ObjectId, cell: string): boolean {
    this.#fresh();
    let byCell = this.#cells.get(id);
    if (byCell === undefined) {
      byCell = new Map();
      this.#cells.set(id, byCell);
    }
    let seen = byCell.get(cell);
    if (seen === undefined) {
      seen = this.canSeeObject(id) && this.table.visibility.canSeeCell(this.viewer, id, cell);
      byCell.set(cell, seen);
    }
    return seen;
  }

  // Object views (PROTOCOL.md §7.2).

  /**
   * The view of a live object, or null: for the GM never null for a live
   * object; for a character null unless it can see the object, with only
   * the cells it can see.
   */
  objectView(id: ObjectId, cells: ViewCells): ObjectView | null {
    const o = this.table.store.getObject(id);
    if (o === undefined) return null;
    if (!this.#gm && !this.canSeeObject(id)) return null;
    const out: Record<string, CellView> = {};
    for (const name of this.#viewCells(o, cells)) {
      if (!this.#gm && !this.canSeeCell(id, name)) continue;
      out[name] = this.#cellView(o, name);
    }
    const view: ObjectView = {
      id,
      is_template: o.is_template,
      is_character: o.is_character,
      cells: out,
      actions: o.actions.map((a) => this.#action(a)),
    };
    if (this.#gm) {
      const absent = this.#absentCellVisibility(o, out);
      if (absent !== undefined) view.absent_cell_visibility = absent;
    }
    return view;
  }

  /**
   * The GM view's `absent_cell_visibility` (PROTOCOL.md §7.2 M4-D12): the
   * object's per-cell visibility entries for names not in the view's
   * `cells`, by code point; undefined when there are none.
   */
  #absentCellVisibility(
    o: DeepReadonly<TableObject>,
    cells: Record<string, CellView>,
  ): Record<string, WireViewers> | undefined {
    const names = Object.keys(o.cell_visibility)
      .filter((name) => !Object.hasOwn(cells, name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (names.length === 0) return undefined;
    const out: Record<string, WireViewers> = {};
    for (const name of names) {
      out[name] = clone<WireViewers>(o.cell_visibility[name] as DeepReadonly<ViewersValue>);
    }
    return out;
  }

  /** Structural view cells in table order, then stored user cells by code point. */
  #viewCells(o: DeepReadonly<TableObject>, cells: ViewCells): string[] {
    if (cells === "structural") return [...STRUCTURAL_VIEW_CELLS];
    const user = Object.keys(o.cells)
      .filter((name) => structuralCell(name) === undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const all = [...STRUCTURAL_VIEW_CELLS, ...user];
    if (cells === "all") return all;
    const wanted = new Set(cells);
    return all.filter((name) => wanted.has(name));
  }

  /**
   * `kind` comes from the object's own `cells` record: the store's `getCell`
   * also answers for field-backed and defaulted structural cells, which
   * have no stored content.
   */
  #cellView(o: DeepReadonly<TableObject>, name: string): CellView {
    const id = o.id;
    const value = this.redact(this.table.value(id, name));
    const stored = Object.hasOwn(o.cells, name) ? o.cells[name] : undefined;
    let view: CellView;
    if (stored === undefined) {
      view = { value, kind: "structural" };
    } else if (stored.content.type === "formula") {
      view = { value, kind: "formula" };
      if (this.#gm) view.source = stored.content.source;
      view.overridden = stored.override !== undefined;
    } else {
      view = { value, kind: "literal" };
    }
    if (this.#gm) {
      const entry = this.table.store.getCellVisibility(id, name);
      if (entry !== undefined) view.visibility = clone<ViewersValue>(entry);
    }
    return view;
  }

  #action(a: DeepReadonly<ActionDef>): ActionView {
    if (!this.#gm) return { name: a.name };
    const out: ActionView = { name: a.name };
    if (a.when !== undefined) out.when = a.when;
    out.steps = [...a.steps];
    return out;
  }

  // Redaction (PROTOCOL.md §7.3).

  /**
   * A result as this viewer may see it. GM: a copy. Character: every ref
   * (at any depth of lists, and in viewers entries) to an id that is
   * neither a board nor an object the viewer can see becomes
   * `{type:"redacted"}`; refs to boards are kept; an error whose origin
   * the viewer cannot see keeps only its code.
   */
  redact(value: Result): WireResult {
    return this.#result(value, this.#gm ? null : { reduced: false });
  }

  #result(r: DeepReadonly<Result>, track: Reduction | null): WireResult {
    if (r.type !== "error") return this.#value(r, track);
    if (track !== null && r.origin !== undefined) {
      if (!this.canSeeCell(r.origin.object, r.origin.cell)) {
        track.reduced = true;
        return { type: "error", code: r.code };
      }
    }
    return clone<WireResult>(r);
  }

  /** A stored or evaluated value; `track` null for the GM's identity conversion. */
  #value(v: DeepReadonly<Value>, track: Reduction | null): WireValue {
    if (track === null) return clone<WireValue>(v);
    switch (v.type) {
      case "ref":
        return this.#refVisible(v.object) ? { type: "ref", object: v.object } : redacted(track);
      case "list":
        return { type: "list", items: v.items.map((i) => this.#value(i, track)) };
      case "viewers":
        return this.#viewers(v, track);
      default:
        return clone<WireValue>(v);
    }
  }

  #viewers(v: DeepReadonly<ViewersValue>, track: Reduction | null): WireViewers {
    if (track === null) return clone<WireViewers>(v);
    return {
      type: "viewers",
      viewers: v.viewers.map((e) =>
        typeof e === "string"
          ? e
          : this.#refVisible(e.object)
            ? { type: "ref", object: e.object }
            : redacted(track),
      ),
    };
  }

  /** A board id is kept; otherwise the id must be an object the viewer can see. */
  #refVisible(id: ObjectId): boolean {
    if (this.table.store.getBoard(id) !== undefined) return true;
    return this.canSeeObject(id);
  }

  // Covers (PROTOCOL.md §7.5).

  /**
   * The covers of `board` for this viewer: one per zone directly on it that
   * the viewer cannot effectively see, classified as M2's cover oracle does.
   * Empty for the GM and for an unknown board.
   */
  covers(board: BoardId): Cover[] {
    if (this.#gm) return [];
    const store = this.table.store;
    if (store.getBoard(board) === undefined) return [];
    const out: Cover[] = [];
    for (const zone of store.objectsOnBoard(board)) {
      if (store.getObject(zone)?.is_zone !== true) continue;
      if (this.table.visibility.isEffectivelyVisible(this.viewer, zone)) continue;
      const region = this.#coverRegion(zone);
      if (region !== null) out.push({ key: coverKey(this.table, zone), board, region });
    }
    return out;
  }

  /**
   * PROTOCOL.md §7.5, in order: unreadable or invalid geometry covers the
   * whole board; no shape covers nothing; `opaque` false covers nothing;
   * otherwise (true, an error, a non-boolean) the zone's region.
   */
  #coverRegion(zone: ObjectId): Cover["region"] | null {
    const read = (cell: string) => this.table.value(zone, cell);
    const anchor = anchorOf(read("position"));
    const rotation = rotationOf(read("rotation"));
    const shape = read("shape");
    if (anchor === undefined || rotation === undefined) return { whole_board: true };
    if (shape.type !== "shape" && shape.type !== "empty") return { whole_board: true };
    if (shape.type === "empty") return null;
    const opaque = read("opaque");
    if (opaque.type === "boolean" && !opaque.value) return null;
    return { position: anchor, rotation, shape: clone<Shape>(shape.shape) };
  }

  /**
   * The boards `scopeObjects` are on, deduplicated in first-seen order; a
   * contained object counts on its outermost container's board. Ids that
   * are not live objects, and objects on no board, contribute nothing.
   */
  coverBoards(scopeObjects: readonly ObjectId[]): BoardId[] {
    const store = this.table.store;
    const out: BoardId[] = [];
    for (const id of scopeObjects) {
      if (!store.hasObject(id)) continue;
      const seen = new Set<ObjectId>();
      let o: ObjectId | null = id;
      while (o !== null && store.boardOf(o) === null && !seen.has(o)) {
        seen.add(o);
        o = store.containerOf(o);
      }
      const board = o === null ? null : store.boardOf(o);
      if (board !== null && !out.includes(board)) out.push(board);
    }
    return out;
  }

  // Effect views (PROTOCOL.md §7.6).

  /** The effect as this viewer sees it, or null when dropped. */
  effectView(effect: DeepReadonly<Effect>): EffectView | null {
    return this.filterEffect(effect).view;
  }

  /** The effect as this viewer sees it, and whether it was dropped or reduced. */
  filterEffect(effect: DeepReadonly<Effect>): FilteredEffect {
    const track: Reduction | null = this.#gm ? null : { reduced: false };
    const view = this.#effect(effect, track);
    return { view, reduced: track !== null && (view === null || track.reduced) };
  }

  #effect(e: DeepReadonly<Effect>, track: Reduction | null): EffectView | null {
    const gm = track === null;
    switch (e.type) {
      case "cell":
        if (!gm && !this.canSeeCell(e.object, e.cell)) return null;
        return {
          type: "cell",
          object: e.object,
          cell: e.cell,
          before: this.#cellState(e.before, track),
          after: this.#cellState(e.after, track),
          cause: e.cause,
        };
      case "cell_visibility":
        if (!gm) return null;
        return {
          type: "cell_visibility",
          object: e.object,
          cell: e.cell,
          before: e.before === null ? null : clone<WireViewers>(e.before),
          after: e.after === null ? null : clone<WireViewers>(e.after),
        };
      case "field":
        switch (e.field) {
          case "tag":
            if (!gm && !this.canSeeCell(e.object, "tag")) return null;
            return { ...base(e), field: "tag", before: [...e.before], after: [...e.after] };
          case "shape":
            if (!gm && !this.canSeeCell(e.object, "shape")) return null;
            return {
              ...base(e),
              field: "shape",
              before: e.before === null ? null : clone<Shape>(e.before),
              after: e.after === null ? null : clone<Shape>(e.after),
            };
          case "is_template":
          case "is_character":
            if (!gm && !this.canSeeObject(e.object)) return null;
            return { ...base(e), field: e.field, before: e.before, after: e.after };
          case "actions":
            if (!gm && !this.canSeeObject(e.object)) return null;
            return {
              ...base(e),
              field: "actions",
              before: e.before.map((a) => this.#action(a)),
              after: e.after.map((a) => this.#action(a)),
            };
          case "face":
            if (!gm && !this.canSeeObject(e.object)) return null;
            return {
              ...base(e),
              field: "face",
              before: e.before === null ? null : this.#face(e.object, e.before, track),
              after: e.after === null ? null : this.#face(e.object, e.after, track),
            };
        }
        return null;
      case "place":
        if (
          !gm &&
          !(
            this.canSeeObject(e.object) &&
            this.canSeeCell(e.object, "board") &&
            this.canSeeCell(e.object, "container")
          )
        ) {
          return null;
        }
        return {
          type: "place",
          object: e.object,
          before: this.#location(e.before, track),
          after: this.#location(e.after, track),
        };
      case "create":
      case "remove": {
        const objects = gm ? e.objects : e.objects.filter((o) => this.canSeeObject(o.id));
        if (objects.length === 0) return null;
        if (track !== null && objects.length < e.objects.length) track.reduced = true;
        return {
          type: e.type,
          location: this.#location(e.location, track),
          objects: objects.map((o) => this.#snapshot(o, track)),
        };
      }
      case "reorder":
        if (!gm && !(this.canSeeObject(e.container) && this.canSeeCell(e.container, "contents"))) {
          return null;
        }
        return {
          type: "reorder",
          container: e.container,
          before: this.#ids(e.before, track),
          after: this.#ids(e.after, track),
        };
      case "board":
        return { type: "board", before: boardView(e.before), after: boardView(e.after) };
      case "allocate":
        if (!gm) return null;
        return {
          type: "allocate",
          ids: [...e.ids],
          seq_before: e.seq_before,
          seq_after: e.seq_after,
        };
      case "retire":
        if (!gm) return null;
        return { type: "retire", ids: [...e.ids] };
    }
  }

  #cellState(cell: DeepReadonly<Cell> | null, track: Reduction | null): CellStateView | null {
    if (cell === null) return null;
    const content = cell.content;
    if (content.type !== "formula") {
      return { kind: "literal", value: this.#value(content, track) };
    }
    const out: CellStateView & { kind: "formula" } = { kind: "formula" };
    if (track === null) out.source = content.source;
    if (cell.override !== undefined) out.override = this.#value(cell.override, track);
    return out;
  }

  #location(loc: DeepReadonly<Location>, track: Reduction | null): LocationView {
    if (loc.type === "board") return { type: "board", board: loc.board };
    return {
      type: "container",
      container: this.#id(loc.container, track),
      index: loc.index,
    };
  }

  /** An object id, or null (a reduction) when a character cannot see it. */
  #id(id: ObjectId, track: Reduction | null): ObjectId | null {
    if (track === null || this.canSeeObject(id)) return id;
    track.reduced = true;
    return null;
  }

  #ids(ids: readonly ObjectId[], track: Reduction | null): (ObjectId | null)[] {
    return ids.map((id) => this.#id(id, track));
  }

  /** A created or removed object; for a character, one it can see now. */
  #snapshot(o: DeepReadonly<TableObject>, track: Reduction | null): ObjectSnapshotView {
    const readable = (cell: string): boolean => {
      if (track === null || this.canSeeCell(o.id, cell)) return true;
      track.reduced = true;
      return false;
    };
    const cells: Record<string, CellStateView> = {};
    for (const [name, cell] of Object.entries(o.cells)) {
      if (!readable(name)) continue;
      const state = this.#cellState(cell, track);
      if (state !== null) cells[name] = state;
    }
    const out: ObjectSnapshotView = {
      id: o.id,
      is_template: o.is_template,
      is_zone: o.is_zone,
      is_character: o.is_character,
      cells,
      actions: o.actions.map((a) => this.#action(a)),
    };
    if (readable("tag")) out.tag = [...o.tag];
    if (readable("shape")) out.shape = o.shape === null ? null : clone<Shape>(o.shape);
    if (readable("contents")) out.contents = this.#ids(o.contents, track);
    if (track === null) {
      out.cell_visibility = clone<Record<string, WireViewers>>(o.cell_visibility);
    }
    if (o.face !== undefined) out.face = this.#face(o.id, o.face, track);
    return out;
  }

  /**
   * A historical face (PROTOCOL.md §7.6, M5-D7): every element with its
   * stored `index`. Lossless for the GM. For a character, `show_when` is
   * withheld (as formula source is, not a reduction) and an element naming
   * a cell it cannot read now is omitted (a reduction); the others keep
   * their index. Never live state.
   */
  #face(object: ObjectId, face: DeepReadonly<FaceLayout>, track: Reduction | null): FaceLayoutView {
    const list = (elements: readonly DeepReadonly<FaceElement>[]): FaceLayoutElementView[] => {
      const out: FaceLayoutElementView[] = [];
      elements.forEach((e, index) => {
        if (track !== null && (e.type === "value" || e.type === "editor")) {
          if (!this.canSeeCell(object, e.cell)) {
            track.reduced = true;
            return;
          }
        }
        const element = { ...clone<FaceElement>(e), index };
        if (track !== null) delete element.show_when;
        out.push(element);
      });
      return out;
    };
    const out: FaceLayoutView = { elements: list(face.elements) };
    if (face.collapsed !== undefined) out.collapsed = list(face.collapsed);
    if (face.default_action !== undefined) out.default_action = face.default_action;
    return out;
  }

  // Group views (PROTOCOL.md §7.6).

  /**
   * GM: the group's fields plus `undone`, with effects converted losslessly
   * when asked. Character: `names` only for objects it can see whose `name`
   * cell it can read, effects filtered by `filterEffect`, null when both are
   * empty; `label` kept only when every effect but `allocate`/`retire` is
   * kept unreduced (PROTOCOL.md §7.6, D15), else null; `origin` only when
   * its object is visible. Withheld names and a withheld origin do not
   * affect the label.
   */
  groupView(group: DeepReadonly<OpGroup>, options: GroupViewOptions): GroupView | null {
    const gm = this.#gm;
    const filtered = group.effects.map((e) => ({ type: e.type, ...this.filterEffect(e) }));
    const effects = filtered.flatMap((f) => (f.view === null ? [] : [f.view]));
    const names: Record<ObjectId, string> = {};
    for (const [id, name] of Object.entries(group.names)) {
      if (gm || this.canSeeCell(id, "name")) names[id] = name;
    }
    const originVisible =
      group.origin === undefined || gm || this.canSeeObject(group.origin.object);
    let label: string | null = group.label;
    if (!gm) {
      if (Object.keys(names).length === 0 && effects.length === 0) return null;
      const reduced = filtered.some(
        (f) => f.type !== "allocate" && f.type !== "retire" && f.reduced,
      );
      if (reduced) label = null;
    }
    const view: GroupView = {
      index: group.index,
      revision: group.revision,
      actor: clone<Actor>(group.actor),
      kind: group.kind,
      label,
      base_revision: group.base_revision,
      undone: this.table.store.history.isUndone(group.index),
      names,
    };
    if (group.origin !== undefined && originVisible) {
      view.origin = { object: group.origin.object, action: group.origin.action };
    }
    if (group.undoes !== undefined) view.undoes = group.undoes;
    if (options.effects) view.effects = effects;
    return view;
  }
}

function redacted(track: Reduction): { type: "redacted" } {
  track.reduced = true;
  return { ...REDACTED };
}

const base = (e: { object: ObjectId }) => ({ type: "field" as const, object: e.object });

function boardView(b: DeepReadonly<Board> | null): { id: BoardId; name?: string } | null {
  if (b === null) return null;
  return b.name === undefined ? { id: b.id } : { id: b.id, name: b.name };
}
