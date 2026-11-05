/**
 * Object and cover subscriptions (DESIGN.md §5.2, §7; FORMULAS.md §7
 * Propagation; PROTOCOL.md §7.5, §8): the subscription hub.
 *
 * Each subscription has a scope (`board`, `objects`, `all`; other scope
 * types such as `log` plug in through `registerScope`), a viewer and a cell
 * selection. `subscribe` builds full views with `ViewBuilder`; after every
 * commit the hub sends each connection one commit event whose deltas carry,
 * per changed subscription, the whole views whose canonical JSON changed,
 * the ids that left scope, were removed or became invisible, and the cover
 * changes by key.
 *
 * Selective recomputation. A commit's candidate objects are the objects of
 * its changed cells, field effects, creations, removals, moves (both
 * containers), per-cell visibility changes, action changes and newly dirty
 * formula cells, plus the holders of literal references to any id whose
 * existence the commit touched (the reference reverse index below). A GM
 * subscription re-views the candidates in scope and the objects that
 * entered it. A character subscription does the same, except after a
 * visibility-relevant commit (`isVisibilityRelevant`), when it re-views its
 * whole scope and recomputes its covers.
 *
 * Evaluation (PROTOCOL.md §8). Building a view pulls its cells through the
 * engine, which evaluates their transitive dependencies and the visibility
 * and geometry inputs of the views and covers wherever they lie; nothing
 * else is read, so every other dirty cell stays dirty until read.
 *
 * The reference reverse index. A ref read from stored literal content (not
 * through a formula) changes its value when its target disappears or
 * reappears, with no formula dependency to say so. So the hub maps every
 * referenced id (object or board) to the objects whose effective literal
 * content names it: a literal cell's value, or a formula cell's override,
 * with refs direct, in lists at any depth, or in viewers entries.
 */
import type { CellKey } from "@vtt/formula";
import {
  type BoardView,
  type CommitEvent,
  type Cover,
  type GroupHeader,
  type GroupView,
  LIMITS,
  type ObjectView,
  ProtocolFailure,
  type SubscribeParams,
  type SubscribeResult,
  type SubscriptionDelta,
} from "@vtt/protocol";
import type { BoardId, Cell, ObjectId, Value } from "@vtt/schema";
import type { Table, TableCommit } from "../engine/table";
import type { DeepReadonly, FrozenGroup } from "../store/history";
import type { ChangeSummary } from "../store/summary";
import type { Viewer } from "../visibility";
import { ViewBuilder } from "./views";

/** A subscription as a scope provider sees it. */
export interface ScopeSubscription {
  readonly id: string;
  readonly conn: string;
  readonly viewer: Viewer;
  readonly cells: "all" | "structural";
}

/** One commit, as the hub hands it to scope providers. */
export interface CommitInfo {
  group: FrozenGroup;
  summary: DeepReadonly<ChangeSummary>;
  /** The formula cells `engine.invalidate` newly marked dirty. */
  dirty: readonly CellKey[];
  /** `isVisibilityRelevant(group, summary, dirty)`. */
  visibilityRelevant: boolean;
}

/** What a provider adds to its subscription's delta for one commit. */
export interface ProviderDelta {
  groups_upserted?: GroupView[];
  groups_removed?: number[];
}

/**
 * A scope type maintained outside the hub (the `log` window, vtt-5su.20).
 * The hub allocates subscription ids, enforces the per-connection limit,
 * and calls `onCommit` for each of the provider's subscriptions on every
 * commit, after the Table's internal synchronization; a non-null result is
 * merged into that subscription's delta.
 */
export interface ScopeProvider {
  subscribe(sub: ScopeSubscription): { groups: GroupView[] };
  onCommit(sub: ScopeSubscription, commit: CommitInfo): ProviderDelta | null;
  drop(sub: ScopeSubscription): void;
}

/** The scope types a provider may be registered for. */
export type ProvidedScopeType = "log";

export interface HubStats {
  /** Object views built, at subscribe and after commits. */
  viewsBuilt: number;
}

export type CommitEventListener = (conn: string, event: CommitEvent) => void;

/**
 * Cells whose change (written, derived, or a formula newly dirty) can
 * change what a character sees or the covers it is sent.
 */
export const VISIBILITY_INPUT_CELLS: ReadonlySet<string> = new Set([
  "visible_to",
  "face_up",
  "opaque",
  "owner",
  "is_zone",
  "position",
  "rotation",
  "shape",
  "board",
  "container",
  "contents",
]);

const cellOf = (key: CellKey): string => key.slice(key.indexOf(":") + 1);
const objectOf = (key: CellKey): ObjectId => key.slice(0, key.indexOf(":"));

/**
 * Whether a commit can change what any character sees: a changed or dirty
 * key of a `VISIBILITY_INPUT_CELLS` cell; a `cell_visibility` effect; a
 * create or remove; an `is_character` field effect (on any object, the
 * viewer included); a board created or removed, by undo too (refs to a
 * board are kept while it exists and are dangling once it is gone).
 */
export function isVisibilityRelevant(
  group: FrozenGroup,
  summary: DeepReadonly<ChangeSummary>,
  dirty: readonly CellKey[],
): boolean {
  const relevant = (k: CellKey) => VISIBILITY_INPUT_CELLS.has(cellOf(k));
  if (summary.changedCells.some(relevant) || dirty.some(relevant)) return true;
  if (
    summary.visibility.length > 0 ||
    summary.created.length > 0 ||
    summary.removed.length > 0 ||
    summary.boardsCreated.length > 0 ||
    summary.boardsRemoved.length > 0
  ) {
    return true;
  }
  return group.effects.some(
    (e) =>
      e.type === "cell_visibility" ||
      e.type === "create" ||
      e.type === "remove" ||
      (e.type === "field" && e.field === "is_character") ||
      (e.type === "board" && (e.before === null) !== (e.after === null)),
  );
}

type ObjectScope = Exclude<SubscribeParams["scope"], { type: "log" }>;

interface ObjectSub {
  kind: "objects";
  info: ScopeSubscription;
  scope: ObjectScope;
  /** The scope at the last revision sent, visible or not. */
  inScope: Set<ObjectId>;
  /** Canonical JSON of every view sent and not since removed. */
  last: Map<ObjectId, string>;
  /** Canonical JSON of every cover sent and not since removed, by key. */
  covers: Map<string, string>;
}

interface ProvidedSub {
  kind: "provided";
  info: ScopeSubscription;
  provider: ScopeProvider;
}

type Sub = ObjectSub | ProvidedSub;

const GM: Viewer = Object.freeze({ type: "gm" }) as Viewer;

/** JSON with object keys sorted, so equal views compare equal as strings. */
function canonical(x: unknown): string {
  return JSON.stringify(x, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** The ids a stored cell's effective literal content names (literal, or a formula's override). */
function literalRefs(cell: DeepReadonly<Cell> | undefined): Set<string> {
  const out = new Set<string>();
  if (cell === undefined) return out;
  const content = cell.content;
  const value = content.type === "formula" ? cell.override : content;
  if (value !== undefined) collectRefs(value as DeepReadonly<Value>, out);
  return out;
}

function collectRefs(v: DeepReadonly<Value>, out: Set<string>): void {
  switch (v.type) {
    case "ref":
      out.add(v.object);
      return;
    case "list":
      for (const item of v.items) collectRefs(item, out);
      return;
    case "viewers":
      for (const e of v.viewers) if (typeof e !== "string") out.add(e.object);
      return;
    default:
      return;
  }
}

const notFound = (): never => {
  throw new ProtocolFailure("not_found", "not found");
};

export class SubscriptionHub {
  readonly table: Table;
  readonly #subs = new Map<string, Sub>();
  /** Connection → its subscription ids, in subscription order. */
  readonly #conns = new Map<string, Set<string>>();
  readonly #providers = new Map<string, ScopeProvider>();
  readonly #listeners: CommitEventListener[] = [];
  /** Referenced id → the objects whose effective literal content names it. */
  readonly #refTargets = new Map<string, Set<ObjectId>>();
  /** Holder → cell → the ids that cell's effective literal content names. */
  readonly #holderCells = new Map<ObjectId, Map<string, Set<string>>>();
  readonly #off: () => void;
  #next = 1;
  #viewsBuilt = 0;

  constructor(table: Table) {
    this.table = table;
    for (const id of table.store.objectIds()) this.#indexObject(id);
    this.#off = table.onCommit((commit) => this.#onCommit(commit));
  }

  /** Stops listening to the table. The hub sends nothing afterwards. */
  close(): void {
    this.#off();
  }

  stats(): HubStats {
    return { viewsBuilt: this.#viewsBuilt };
  }

  /** Registers the provider of a scope type; `subscribe` delegates that type to it. */
  registerScope(type: ProvidedScopeType, provider: ScopeProvider): void {
    this.#providers.set(type, provider);
  }

  /** Registers a commit event listener; returns the function that unregisters it. */
  onCommitEvent(fn: CommitEventListener): () => void {
    this.#listeners.push(fn);
    return () => {
      const i = this.#listeners.indexOf(fn);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }

  /** Makes `conn` receive commit events, with or without subscriptions. Idempotent. */
  addConnection(conn: string): void {
    if (!this.#conns.has(conn)) this.#conns.set(conn, new Set());
  }

  /** Forgets `conn` and frees every subscription it has. */
  dropConnection(conn: string): void {
    const ids = this.#conns.get(conn);
    if (ids === undefined) return;
    this.#conns.delete(conn);
    for (const id of ids) this.#drop(id);
  }

  /**
   * Subscribes `conn` (registering it if needed) at the current revision.
   * `busy` beyond `max_subscriptions` per connection; `not_found` for an
   * unknown board; `unsupported` for a scope type with no provider.
   */
  subscribe(conn: string, params: SubscribeParams): SubscribeResult {
    this.addConnection(conn);
    const ids = this.#conns.get(conn) as Set<string>;
    if (ids.size >= LIMITS.max_subscriptions) {
      throw new ProtocolFailure(
        "busy",
        `at most ${LIMITS.max_subscriptions} subscriptions per connection`,
      );
    }
    const viewer: Viewer = params.viewer === undefined ? GM : structuredClone(params.viewer);
    const cells = params.cells ?? "all";
    const scope = params.scope;
    const revision = this.table.store.revision;
    if (scope.type === "log") {
      const provider = this.#providers.get(scope.type);
      if (provider === undefined) {
        throw new ProtocolFailure("unsupported", `scope "${scope.type}" is not supported`);
      }
      const info: ScopeSubscription = { id: `s${this.#next}`, conn, viewer, cells };
      const provided = provider.subscribe(info);
      this.#next++;
      this.#subs.set(info.id, { kind: "provided", info, provider });
      ids.add(info.id);
      return { subscription: info.id, revision, objects: [], covers: [], ...provided };
    }
    if (scope.type === "board" && this.table.store.getBoard(scope.board) === undefined) {
      notFound();
    }
    const info: ScopeSubscription = { id: `s${this.#next++}`, conn, viewer, cells };
    const sub: ObjectSub = {
      kind: "objects",
      info,
      scope: structuredClone(scope),
      inScope: new Set(),
      last: new Map(),
      covers: new Map(),
    };
    const builder = new ViewBuilder(this.table, viewer);
    const scopeIds = this.#scopeIds(sub.scope);
    sub.inScope = new Set(scopeIds);
    const objects: ObjectView[] = [];
    for (const id of scopeIds) {
      const view = this.#view(builder, id, cells);
      if (view === null) continue;
      objects.push(view);
      sub.last.set(id, canonical(view));
    }
    const covers = this.#covers(builder, sub.scope, scopeIds);
    for (const cover of covers) sub.covers.set(cover.key, canonical(cover));
    this.#subs.set(info.id, sub);
    ids.add(info.id);
    return { subscription: info.id, revision, objects, covers };
  }

  /** Ends one of `conn`'s subscriptions; `not_found` if it has no such subscription. */
  unsubscribe(conn: string, id: string): void {
    const ids = this.#conns.get(conn);
    if (ids === undefined || !ids.has(id)) notFound();
    ids?.delete(id);
    this.#drop(id);
  }

  /** The objects whose effective literal content names `target`, sorted (for tests). */
  referenceHolders(target: string): ObjectId[] {
    return [...(this.#refTargets.get(target) ?? [])].sort();
  }

  #drop(id: string): void {
    const sub = this.#subs.get(id);
    if (sub === undefined) return;
    this.#subs.delete(id);
    if (sub.kind === "provided") sub.provider.drop(sub.info);
  }

  #view(builder: ViewBuilder, id: ObjectId, cells: "all" | "structural"): ObjectView | null {
    this.#viewsBuilt++;
    return builder.objectView(id, cells);
  }

  /** The scope's objects at the current revision, in scope order, each once. */
  #scopeIds(scope: ObjectScope): ObjectId[] {
    const store = this.table.store;
    switch (scope.type) {
      case "board":
        if (store.getBoard(scope.board) === undefined) return [];
        return store.objectsOnBoard(scope.board).flatMap((id) => store.subtreeOf(id));
      case "objects": {
        const out = new Set<ObjectId>();
        for (const id of scope.ids) {
          if (!store.hasObject(id)) continue;
          for (const o of scope.subtree === true ? store.subtreeOf(id) : [id]) out.add(o);
        }
        return [...out];
      }
      case "all":
        return store.objectIds();
    }
  }

  /** The covers of the boards in scope (PROTOCOL.md §7.5); none for the GM. */
  #covers(builder: ViewBuilder, scope: ObjectScope, scopeIds: readonly ObjectId[]): Cover[] {
    if (builder.viewer.type === "gm") return [];
    const store = this.table.store;
    let boards: BoardId[];
    switch (scope.type) {
      case "board":
        boards = store.getBoard(scope.board) === undefined ? [] : [scope.board];
        break;
      case "all":
        boards = store.boards().map((b) => b.id);
        break;
      case "objects":
        boards = builder.coverBoards(scopeIds);
        break;
    }
    return boards.flatMap((b) => builder.covers(b));
  }

  // Commits.

  #onCommit({ group, summary, dirty }: TableCommit): void {
    const visibilityRelevant = isVisibilityRelevant(group, summary, dirty);
    const candidates = this.#candidates(group, summary, dirty);
    const commit: CommitInfo = { group, summary, dirty, visibilityRelevant };
    const header: GroupHeader = {
      index: group.index,
      revision: group.revision,
      actor: structuredClone(group.actor) as GroupHeader["actor"],
      kind: group.kind,
      label: group.label,
    };
    const boards: BoardView[] | undefined = group.effects.some((e) => e.type === "board")
      ? this.table.store
          .boards()
          .map((b) => (b.name === undefined ? { id: b.id } : { id: b.id, name: b.name }))
      : undefined;
    const events: [string, CommitEvent][] = [];
    for (const [conn, ids] of this.#conns) {
      const deltas: SubscriptionDelta[] = [];
      for (const id of ids) {
        const sub = this.#subs.get(id);
        if (sub === undefined) continue;
        const delta =
          sub.kind === "objects"
            ? this.#objectDelta(sub, candidates, visibilityRelevant)
            : this.#providedDelta(sub, commit);
        if (delta !== null) deltas.push(delta);
      }
      const event: CommitEvent = {
        type: "event",
        event: "commit",
        revision: group.revision,
        group: structuredClone(header),
        deltas,
      };
      if (boards !== undefined) event.boards = structuredClone(boards);
      events.push([conn, event]);
    }
    // Every listener gets every event; the first error is rethrown afterwards.
    let failure: { error: unknown } | null = null;
    for (const [conn, event] of events) {
      for (const fn of [...this.#listeners]) {
        try {
          fn(conn, event);
        } catch (error) {
          failure ??= { error };
        }
      }
    }
    if (failure !== null) throw failure.error;
  }

  /**
   * The candidate objects of a commit (see the module comment). Updates the
   * reference index from the commit; the holders of every id whose
   * existence the commit touched, before and after the update, join.
   */
  #candidates(
    group: FrozenGroup,
    summary: DeepReadonly<ChangeSummary>,
    dirty: readonly CellKey[],
  ): Set<ObjectId> {
    const out = new Set<ObjectId>();
    for (const k of summary.changedCells) out.add(objectOf(k));
    for (const k of dirty) out.add(objectOf(k));
    for (const id of summary.created) out.add(id);
    for (const id of summary.removed) out.add(id);
    for (const m of summary.moved) {
      out.add(m.object);
      for (const loc of [m.from, m.to]) if (loc.type === "container") out.add(loc.container);
    }
    for (const v of summary.visibility) out.add(v.object);
    for (const id of summary.actionsChanged) out.add(id);
    const existence: string[] = [];
    for (const e of group.effects) {
      switch (e.type) {
        case "field":
          out.add(e.object);
          break;
        case "reorder":
          out.add(e.container);
          break;
        case "create":
        case "remove":
          for (const o of e.objects) existence.push(o.id);
          break;
        case "retire":
          existence.push(...e.ids);
          break;
        case "board":
          // Renames too: over-approximation, refs to a board never change on rename.
          if (e.before !== null) existence.push(e.before.id);
          if (e.after !== null) existence.push(e.after.id);
          break;
        default:
          break;
      }
    }
    const addHolders = () => {
      for (const id of existence) for (const h of this.#refTargets.get(id) ?? []) out.add(h);
    };
    addHolders();
    this.#updateReferences(summary);
    addHolders();
    return out;
  }

  #objectDelta(
    sub: ObjectSub,
    candidates: ReadonlySet<ObjectId>,
    visibilityRelevant: boolean,
  ): SubscriptionDelta | null {
    const { viewer, cells } = sub.info;
    const builder = new ViewBuilder(this.table, viewer);
    const character = viewer.type === "character";
    const whole = character && visibilityRelevant;
    const scopeIds = this.#scopeIds(sub.scope);
    const next = new Set(scopeIds);
    const removed = [...sub.last.keys()].filter((id) => !next.has(id));
    for (const id of removed) sub.last.delete(id);
    const objects: ObjectView[] = [];
    for (const id of scopeIds) {
      if (!whole && sub.inScope.has(id) && !candidates.has(id)) continue;
      const view = this.#view(builder, id, cells);
      if (view === null) {
        if (sub.last.delete(id)) removed.push(id);
        continue;
      }
      const json = canonical(view);
      if (sub.last.get(id) === json) continue;
      sub.last.set(id, json);
      objects.push(view);
    }
    sub.inScope = next;
    const covers = whole ? this.#coverDelta(sub, builder, scopeIds) : null;
    if (objects.length === 0 && removed.length === 0 && covers === null) return null;
    const delta: SubscriptionDelta = { subscription: sub.info.id, objects, removed };
    if (covers !== null) delta.covers = covers;
    return delta;
  }

  #coverDelta(
    sub: ObjectSub,
    builder: ViewBuilder,
    scopeIds: readonly ObjectId[],
  ): { upsert: Cover[]; removed: string[] } | null {
    const fresh = new Map<string, Cover>();
    for (const cover of this.#covers(builder, sub.scope, scopeIds)) fresh.set(cover.key, cover);
    const upsert: Cover[] = [];
    for (const [key, cover] of fresh) {
      const json = canonical(cover);
      if (sub.covers.get(key) === json) continue;
      sub.covers.set(key, json);
      upsert.push(cover);
    }
    const removed = [...sub.covers.keys()].filter((key) => !fresh.has(key));
    for (const key of removed) sub.covers.delete(key);
    return upsert.length === 0 && removed.length === 0 ? null : { upsert, removed };
  }

  #providedDelta(sub: ProvidedSub, commit: CommitInfo): SubscriptionDelta | null {
    const result = sub.provider.onCommit(sub.info, commit);
    if (result === null) return null;
    const upserted = result.groups_upserted ?? [];
    const removed = result.groups_removed ?? [];
    if (upserted.length === 0 && removed.length === 0) return null;
    const delta: SubscriptionDelta = { subscription: sub.info.id, objects: [], removed: [] };
    if (result.groups_upserted !== undefined) delta.groups_upserted = upserted;
    if (result.groups_removed !== undefined) delta.groups_removed = removed;
    return delta;
  }

  // The reference reverse index.

  /** Re-reads every cell the commit changed, and created and removed objects whole. */
  #updateReferences(summary: DeepReadonly<ChangeSummary>): void {
    const store = this.table.store;
    for (const id of summary.removed) if (!store.hasObject(id)) this.#dropHolder(id);
    for (const id of summary.created) if (store.hasObject(id)) this.#indexObject(id);
    for (const key of summary.changedCells) {
      const id = objectOf(key);
      if (store.hasObject(id)) this.#indexCell(id, cellOf(key));
      else this.#dropHolder(id);
    }
  }

  #indexObject(id: ObjectId): void {
    this.#dropHolder(id);
    const o = this.table.store.getObject(id);
    if (o === undefined) return;
    for (const cell of Object.keys(o.cells)) this.#indexCell(id, cell);
  }

  /** Field-backed and defaulted cells have no stored content and hold no literal refs here. */
  #indexCell(holder: ObjectId, cell: string): void {
    const o = this.table.store.getObject(holder);
    const stored = o !== undefined && Object.hasOwn(o.cells, cell) ? o.cells[cell] : undefined;
    const targets = literalRefs(stored);
    let byCell = this.#holderCells.get(holder);
    const old = byCell?.get(cell);
    if (targets.size === 0) {
      byCell?.delete(cell);
      if (byCell?.size === 0) this.#holderCells.delete(holder);
    } else {
      if (byCell === undefined) {
        byCell = new Map();
        this.#holderCells.set(holder, byCell);
      }
      byCell.set(cell, targets);
    }
    for (const t of old ?? []) {
      if (!targets.has(t) && !this.#holds(holder, t)) this.#unlink(t, holder);
    }
    for (const t of targets) {
      let holders = this.#refTargets.get(t);
      if (holders === undefined) {
        holders = new Set();
        this.#refTargets.set(t, holders);
      }
      holders.add(holder);
    }
  }

  #holds(holder: ObjectId, target: string): boolean {
    for (const targets of this.#holderCells.get(holder)?.values() ?? []) {
      if (targets.has(target)) return true;
    }
    return false;
  }

  #dropHolder(holder: ObjectId): void {
    const byCell = this.#holderCells.get(holder);
    if (byCell === undefined) return;
    this.#holderCells.delete(holder);
    for (const targets of byCell.values()) for (const t of targets) this.#unlink(t, holder);
  }

  #unlink(target: string, holder: ObjectId): void {
    const holders = this.#refTargets.get(target);
    holders?.delete(holder);
    if (holders?.size === 0) this.#refTargets.delete(target);
  }
}
