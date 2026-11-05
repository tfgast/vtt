/**
 * Query methods (PROTOCOL.md §4, §6, §9; DESIGN.md §5.2 Query, §4.4;
 * FORMULAS.md §5, §9; M3-D28, D29, D30): `list_objects`, `get_objects`,
 * `evaluate`, `zones`, `at_position`, `changes_since`, `log`, `document`.
 *
 * Every function takes `(table, params)` and returns the method's
 * `@vtt/protocol` result. Failures throw `ProtocolFailure(code, message)`:
 * `not_found` only for an unknown query target (a board for `zones` and
 * `at_position`, `this` for `evaluate`), `bad_request` for out-of-range
 * params the schema cannot check. Views, redaction and group views come
 * from `ViewBuilder`; nothing here evaluates for a character except through
 * the engine and visibility.
 */
import {
  type AtPositionParams,
  type AtPositionResult,
  type ChangesSinceParams,
  type ChangesSinceResult,
  type DocumentParams,
  type DocumentResult,
  type EvaluateParams,
  type EvaluateResult,
  type GetObjectsParams,
  type GetObjectsResult,
  type GroupView,
  LIMITS,
  type ListObjectsParams,
  type ListObjectsResult,
  type LogParams,
  type LogResult,
  type ObjectView,
  ProtocolFailure,
  type WireResult,
  type ZonesParams,
  type ZonesResult,
} from "@vtt/protocol";
import {
  GEOM_EPSILON,
  type ObjectId,
  type OpGroup,
  type Point,
  pointInRegion,
  type Result,
  type Shape,
  type TableLog,
} from "@vtt/schema";
import type { Table } from "../engine/table";
import type { Viewer } from "../visibility";
import { historyFloor } from "./conflicts";
import { ViewBuilder } from "./views";

/** `list_objects` and `log` page size when `limit` is absent. */
export const DEFAULT_PAGE_LIMIT = 50;
/** `changes_since` scan size when `limit` is absent. */
export const DEFAULT_CHANGES_LIMIT = 100;

const GM: Viewer = { type: "gm" };

/** Compares ids by Unicode code point (FORMULAS.md §5 order). */
function compareIds(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

const notFound = (): never => {
  throw new ProtocolFailure("not_found", "not found");
};

const builder = (table: Table, viewer: Viewer | undefined) => new ViewBuilder(table, viewer ?? GM);

// ---------------------------------------------------------------------------
// list_objects, get_objects

/**
 * `list_objects` (PROTOCOL.md §4): every live object passing every given
 * filter (`board`: directly on it; `container`: directly in it; `tag`: its
 * tag list contains the text; `name`: a literal text `name` equal to it;
 * flags equal), then visible to the viewer, ordered by id (code point),
 * starting after `cursor`. Unknown filter ids are not query targets: they
 * match nothing. `next_cursor` is the page's last id, or null on the last
 * page.
 */
export function listObjects(table: Table, params: ListObjectsParams): ListObjectsResult {
  const store = table.store;
  const views = builder(table, params.viewer);
  const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
  const cells = params.cells ?? "structural";
  const filter = params.filter ?? {};
  const cursor = params.cursor;
  const matches = (id: ObjectId): boolean => {
    const o = store.getObject(id);
    if (o === undefined) return false;
    if (filter.board !== undefined && o.board !== filter.board) return false;
    if (filter.container !== undefined && store.containerOf(id) !== filter.container) {
      return false;
    }
    if (filter.tag !== undefined && !o.tag.includes(filter.tag)) return false;
    if (filter.name !== undefined) {
      const name = Object.hasOwn(o.cells, "name") ? o.cells.name?.content : undefined;
      if (name?.type !== "text" || name.value !== filter.name) return false;
    }
    if (filter.is_template !== undefined && o.is_template !== filter.is_template) return false;
    if (filter.is_zone !== undefined && o.is_zone !== filter.is_zone) return false;
    if (filter.is_character !== undefined && o.is_character !== filter.is_character) return false;
    return views.canSeeObject(id);
  };
  const objects: ObjectView[] = [];
  let more = false;
  for (const id of store.objectIds().sort(compareIds)) {
    if (cursor !== undefined && compareIds(id, cursor) <= 0) continue;
    if (!matches(id)) continue;
    if (objects.length === limit) {
      more = true;
      break;
    }
    const view = views.objectView(id, cells);
    if (view !== null) objects.push(view);
  }
  return {
    revision: store.revision,
    objects,
    next_cursor: more ? (objects.at(-1)?.id ?? null) : null,
  };
}

/**
 * `get_objects` (PROTOCOL.md §4): views in request order; an id that is not
 * a live object, or that the viewer cannot see, goes to `missing`, the two
 * indistinguishably.
 */
export function getObjects(table: Table, params: GetObjectsParams): GetObjectsResult {
  const views = builder(table, params.viewer);
  const cells = params.cells ?? "all";
  const objects: ObjectView[] = [];
  const missing: ObjectId[] = [];
  for (const id of params.ids) {
    const view = views.objectView(id, cells);
    if (view === null) missing.push(id);
    else objects.push(view);
  }
  return { revision: table.store.revision, objects, missing };
}

// ---------------------------------------------------------------------------
// evaluate

/**
 * `evaluate` (PROTOCOL.md §9, D28): GM only, so there is no viewer and the
 * result is unredacted. A source longer than `max_source_length` is
 * `bad_request`; an unknown `this` (not a live object) is `not_found`.
 *
 * Without `this`: the engine requires an evaluation subject and has no
 * object-free default, so the formula is evaluated on the first board in
 * board order. A board exists for the engine but has no cells, so
 * object-free formulas evaluate normally, bare names and `this.<cell>` are
 * `#NAME`, and `this` is a reference to that board. With no boards the
 * subject does not exist and the engine answers `#REF`.
 */
export function evaluateAdhoc(table: Table, params: EvaluateParams): EvaluateResult {
  if (params.source.length > LIMITS.max_source_length) {
    throw new ProtocolFailure(
      "bad_request",
      `source is longer than max_source_length (${LIMITS.max_source_length})`,
    );
  }
  let thisId: ObjectId;
  if (params.this !== undefined) {
    if (!table.store.hasObject(params.this)) notFound();
    thisId = params.this;
  } else {
    thisId = table.store.boards()[0]?.id ?? "";
  }
  const value = table.engine.evaluate(params.source, { thisId });
  return { revision: table.store.revision, value: structuredClone(value) as WireResult };
}

// ---------------------------------------------------------------------------
// zones

/**
 * `zones` (PROTOCOL.md §4): every `is_zone` object directly on the board
 * and visible to the viewer, ordered by id. `contents` is
 * `contents(this)` evaluated on the zone (FORMULAS.md §5 order), limited to
 * objects the viewer can see; when that is an error of any code,
 * `contents` is `[]` and `error` is the code. `view` is structural. An
 * unknown board is `not_found`.
 */
export function zonesOnBoard(table: Table, params: ZonesParams): ZonesResult {
  const store = table.store;
  if (store.getBoard(params.board) === undefined) notFound();
  const views = builder(table, params.viewer);
  const zones: ZonesResult["zones"] = [];
  const ids = store
    .objectsOnBoard(params.board)
    .filter((id) => store.getObject(id)?.is_zone === true && views.canSeeObject(id))
    .sort(compareIds);
  for (const id of ids) {
    const view = views.objectView(id, "structural");
    if (view === null) continue;
    const r = table.engine.evaluate("contents(this)", { thisId: id });
    if (r.type === "error") {
      zones.push({ id, contents: [], error: r.code, view });
      continue;
    }
    const contents =
      r.type === "list"
        ? r.items.flatMap((item) =>
            item.type === "ref" && views.canSeeObject(item.object) ? [item.object] : [],
          )
        : [];
    zones.push({ id, contents, view });
  }
  return { revision: store.revision, zones };
}

// ---------------------------------------------------------------------------
// at_position

/** A number as geometry reads it: empty as 0, a roll as its total; undefined otherwise. */
function geometryNumber(r: Result): number | undefined {
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

/** The anchor, if `r` is a list of two finite numbers. */
function anchorOf(r: Result): Point | undefined {
  if (r.type !== "list" || r.items.length !== 2) return undefined;
  const [x, y] = r.items;
  if (x?.type !== "number" || y?.type !== "number") return undefined;
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return undefined;
  return [x.value, y.value];
}

interface Footprint {
  anchor: Point;
  rotation: number;
  z: number;
  shape: Shape | null;
}

/**
 * The evaluated footprint of `id`, or undefined when it has no geometry: an
 * error in `position`, `rotation`, `shape` or `z` (including `#LIMIT`), a
 * position that is not two finite numbers, or a rotation, z or shape of
 * the wrong kind.
 */
function footprintOf(table: Table, id: ObjectId): Footprint | undefined {
  const position = table.value(id, "position");
  const rotationR = table.value(id, "rotation");
  const shapeR = table.value(id, "shape");
  const zR = table.value(id, "z");
  const anchor = anchorOf(position);
  const rotation = geometryNumber(rotationR);
  const z = geometryNumber(zR);
  if (anchor === undefined || rotation === undefined || z === undefined) return undefined;
  let shape: Shape | null;
  if (shapeR.type === "shape") shape = shapeR.shape;
  else if (shapeR.type === "empty") shape = null;
  else return undefined;
  return { anchor, rotation, z, shape };
}

/**
 * `at_position` (PROTOCOL.md §9, D29): the spatial index's candidates at
 * the point; those whose evaluated footprint contains it (boundary
 * inclusive; a shapeless object when its anchor is within GEOM_EPSILON),
 * split into non-zones and zones, each ascending `z` (empty = 0) then id,
 * and filtered by the viewer's visibility. Candidates are objects directly
 * on the board, so contained objects never appear. A candidate without
 * geometry (see `footprintOf`) is omitted. An unknown board is `not_found`.
 */
export function atPosition(table: Table, params: AtPositionParams): AtPositionResult {
  const store = table.store;
  if (store.getBoard(params.board) === undefined) notFound();
  const views = builder(table, params.viewer);
  const point: Point = [params.position[0], params.position[1]];
  const [x, y] = point;
  const objects: { id: ObjectId; z: number }[] = [];
  const zones: { id: ObjectId; z: number }[] = [];
  for (const id of table.index.candidates(params.board, { minX: x, minY: y, maxX: x, maxY: y })) {
    const o = store.getObject(id);
    if (o === undefined || o.board !== params.board) continue;
    const fp = footprintOf(table, id);
    if (fp === undefined) continue;
    const inside =
      fp.shape === null
        ? Math.hypot(x - fp.anchor[0], y - fp.anchor[1]) <= GEOM_EPSILON
        : pointInRegion(point, fp.shape, fp.anchor, fp.rotation);
    if (!inside || !views.canSeeObject(id)) continue;
    (o.is_zone ? zones : objects).push({ id, z: fp.z });
  }
  const order = (a: { id: ObjectId; z: number }, b: { id: ObjectId; z: number }) =>
    a.z !== b.z ? (a.z < b.z ? -1 : 1) : compareIds(a.id, b.id);
  return {
    revision: store.revision,
    objects: objects.sort(order).map((e) => e.id),
    zones: zones.sort(order).map((e) => e.id),
  };
}

// ---------------------------------------------------------------------------
// changes_since, log, document

/**
 * `changes_since` (PROTOCOL.md §9): scans at most `limit` retained groups
 * with `revision > params.revision`, oldest first, and returns the
 * non-null group views among them, with effects. `more`: retained groups
 * remain after the last scanned. `next_revision`: the last scanned group's
 * revision, or the current revision when none was scanned. `truncated`:
 * `params.revision` is below the floor (PROTOCOL.md §6). A revision above
 * the current one is `bad_request`.
 */
export function changesSince(table: Table, params: ChangesSinceParams): ChangesSinceResult {
  const store = table.store;
  const current = store.revision;
  if (params.revision > current) {
    throw new ProtocolFailure(
      "bad_request",
      `revision ${params.revision} is above the current revision ${current}`,
    );
  }
  const floor = historyFloor(store.history, current);
  const limit = params.limit ?? DEFAULT_CHANGES_LIMIT;
  const views = builder(table, params.viewer);
  const pending = store.history.groups().filter((g) => g.revision > params.revision);
  const scanned = pending.slice(0, limit);
  const groups: GroupView[] = [];
  for (const g of scanned) {
    const view = views.groupView(g, { effects: true });
    if (view !== null) groups.push(view);
  }
  return {
    revision: current,
    floor,
    groups,
    truncated: params.revision < floor,
    more: pending.length > scanned.length,
    next_revision: scanned.at(-1)?.revision ?? current,
  };
}

/**
 * `log` (PROTOCOL.md §4): retained groups newest first, below the exclusive
 * absolute index `before` (default: all), up to `limit` returned group
 * views; groups whose view is null for the viewer are skipped and do not
 * count. `effects` (default false) selects whether views carry effects.
 * `first_index`, `next_index` and `undo_barrier` are History's.
 */
export function logPage(table: Table, params: LogParams): LogResult {
  const history = table.store.history;
  const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
  const effects = params.effects ?? false;
  const views = builder(table, params.viewer);
  const retained = history.groups();
  const groups: GroupView[] = [];
  for (let i = retained.length - 1; i >= 0 && groups.length < limit; i--) {
    const g = retained[i];
    if (g === undefined) continue;
    if (params.before !== undefined && g.index >= params.before) continue;
    const view = views.groupView(g, { effects });
    if (view !== null) groups.push(view);
  }
  return {
    first_index: history.firstIndex,
    next_index: history.nextIndex,
    undo_barrier: history.undoBarrier,
    groups,
  };
}

/**
 * `document` (PROTOCOL.md §9, D30): GM only, unfiltered: the store's
 * canonical snapshot and a copy of the retained log.
 */
export function documentDump(table: Table, _params: DocumentParams): DocumentResult {
  const log = structuredClone(table.store.history.toLog()) as TableLog;
  return {
    snapshot: table.store.toSnapshot(),
    log: {
      first_index: log.first_index,
      groups: log.groups as OpGroup[],
      undo_barrier: log.undo_barrier,
    },
  };
}
