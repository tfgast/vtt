/**
 * Explain methods (PROTOCOL.md §9, §7.6; DESIGN.md §5.2 Explain, §4.4;
 * FORMULAS.md §7, §9; M3-D16): `explain_cell`, `explain_group`,
 * `explain_action`.
 *
 * Every function takes `(table, params)` and returns the method's
 * `@vtt/protocol` result. A target that does not exist and one the viewer
 * cannot see (object not visible, cell not readable, group view null)
 * answer the identical `ProtocolFailure("not_found", "not found")`; the
 * check runs before any evaluation result is exposed. Views, redaction and
 * group views come from `ViewBuilder`.
 */
import { type Dependency, parse } from "@vtt/formula";
import {
  type DepNode,
  type ExplainActionParams,
  type ExplainActionResult,
  type ExplainCellParams,
  type ExplainCellResult,
  type ExplainGroupParams,
  type ExplainGroupResult,
  LIMITS,
  ProtocolFailure,
} from "@vtt/protocol";
import { type ObjectId, type OpGroup, type Result, structuralCell } from "@vtt/schema";
import type { Table } from "../engine/table";
import type { DeepReadonly } from "../store/history";
import type { Viewer } from "../visibility";
import { STRUCTURAL_VIEW_CELLS, ViewBuilder } from "./views";

/** The longest `error_chain` (PROTOCOL.md §9). */
export const MAX_ERROR_CHAIN = 32;

const GM: Viewer = { type: "gm" };

const notFound = (): never => {
  throw new ProtocolFailure("not_found", "not found");
};

const builder = (table: Table, viewer: Viewer | undefined) => new ViewBuilder(table, viewer ?? GM);

const key = (object: ObjectId, cell: string) => `${object}:${cell}`;

// ---------------------------------------------------------------------------
// explain_cell

/**
 * Whether `cell` is a cell of `id` as object views name it: a structural
 * view cell (every readable structural cell but `id`) or a stored user
 * cell.
 */
function hasViewCell(table: Table, id: ObjectId, cell: string): boolean {
  const o = table.store.getObject(id);
  if (o === undefined) return false;
  if (STRUCTURAL_VIEW_CELLS.includes(cell)) return true;
  return structuralCell(cell) === undefined && Object.hasOwn(o.cells, cell);
}

/**
 * `explain_cell` (PROTOCOL.md §9):
 *
 * - Not found first: an object that is not live, a cell that is not one of
 *   its view cells, and, for a character, an object it cannot see or a cell
 *   it cannot read.
 * - The value (forcing evaluation), then the recorded dependencies
 *   (`engine.dependenciesOf`) breadth first to `depth` (default 1), each
 *   cell expanded once (the target counts as expanded), at most
 *   `max_explain_nodes` nodes in the tree (`truncated` when cut). An
 *   expanded node carries `dependencies` (possibly empty); a node not
 *   expanded (beyond depth, already expanded, hidden) has none.
 * - Character: a dependency cell on a visible object it cannot read is
 *   `{type:"cell", object, cell, hidden: true}`; a dependency on an object
 *   it cannot see (or one that no longer exists) has `object: null` and no
 *   value or `exists`; values redacted; no `source`.
 * - `error_chain` when the value is an error: the target, then each
 *   error's `origin` in turn, until an error originates at its own cell,
 *   has no origin, repeats a cell, or the origin's value is not an error;
 *   at most 32 entries.
 * - `last_write`: the newest retained group with a `cell` effect on the
 *   cell, as the viewer's log header plus that effect's `cause`; omitted
 *   when that group's view is null for the viewer.
 */
export function explainCell(table: Table, params: ExplainCellParams): ExplainCellResult {
  const { object: id, cell } = params;
  const views = builder(table, params.viewer);
  const gm = views.viewer.type === "gm";
  if (!hasViewCell(table, id, cell)) notFound();
  if (!gm && !views.canSeeCell(id, cell)) notFound();

  const value = table.value(id, cell);
  const view = views.objectView(id, [cell])?.cells[cell];
  if (view === undefined) return notFound();

  const stored = table.store.getObject(id)?.cells[cell];
  let content: ExplainCellResult["content"];
  if (view.kind === "structural" || stored === undefined) {
    content = { type: "structural" };
  } else if (stored.content.type === "formula") {
    const parsed = parse(stored.content.source);
    content = {
      type: "formula",
      ...(gm ? { source: stored.content.source } : {}),
      overridden: stored.override !== undefined,
      parses: parsed.ok,
      ...(parsed.ok ? {} : { syntax_error: parsed.message }),
    };
  } else {
    content = { type: "literal" };
  }

  const { dependencies, truncated } = dependencyTree(views, id, cell, params.depth ?? 1);
  const result: ExplainCellResult = {
    revision: table.store.revision,
    object: id,
    cell,
    view,
    content,
    dependencies,
    truncated,
  };
  const chain = errorChain(views, id, cell, value);
  if (chain !== undefined) result.error_chain = chain;
  const last = lastWrite(views, id, cell);
  if (last !== undefined) result.last_write = last;
  return result;
}

type CellNode = Extract<DepNode, { type: "cell" }>;

interface Pending {
  node: CellNode;
  object: ObjectId;
  cell: string;
  level: number;
}

/** The breadth-first dependency tree of `id`.`cell` (see `explainCell`). */
function dependencyTree(
  views: ViewBuilder,
  id: ObjectId,
  cell: string,
  depth: number,
): { dependencies: DepNode[]; truncated: boolean } {
  const engine = views.table.engine;
  const expanded = new Set<string>([key(id, cell)]);
  const roots: DepNode[] = [];
  const queue: Pending[] = [];
  let count = 0;
  let truncated = false;

  /** Appends the nodes of `deps` to `into`; false once the node limit cuts. */
  const add = (deps: readonly Dependency[], into: DepNode[], level: number): boolean => {
    for (const d of deps) {
      if (count >= LIMITS.max_explain_nodes) {
        truncated = true;
        return false;
      }
      count++;
      const node = depNode(views, d);
      into.push(node);
      if (d.type === "cell" && node.type === "cell" && node.value !== undefined) {
        queue.push({ node, object: d.object, cell: d.cell, level });
      }
    }
    return true;
  };

  if (add(engine.dependenciesOf(id, cell) ?? [], roots, 1)) {
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i] as Pending;
      if (p.level >= depth) continue;
      const k = key(p.object, p.cell);
      if (expanded.has(k)) continue;
      expanded.add(k);
      const children: DepNode[] = [];
      p.node.dependencies = children;
      if (!add(engine.dependenciesOf(p.object, p.cell) ?? [], children, p.level + 1)) break;
    }
  }
  return { dependencies: roots, truncated };
}

/**
 * One dependency as the viewer sees it. A cell node carries a value exactly
 * when the viewer can read the cell, and only those are expanded. Reading
 * the value also brings the cell's recorded dependencies up to date.
 */
function depNode(views: ViewBuilder, d: Dependency): DepNode {
  const table = views.table;
  const gm = views.viewer.type === "gm";
  switch (d.type) {
    case "index":
      return { type: "index" };
    case "exists": {
      const isBoard = table.store.getBoard(d.object) !== undefined;
      if (gm || isBoard || views.canSeeObject(d.object)) {
        return {
          type: "exists",
          object: d.object,
          exists: isBoard || table.store.hasObject(d.object),
        };
      }
      return { type: "exists", object: null };
    }
    case "cell":
      if (!gm && !views.canSeeObject(d.object)) return { type: "cell", object: null, cell: d.cell };
      if (!gm && !views.canSeeCell(d.object, d.cell)) {
        return { type: "cell", object: d.object, cell: d.cell, hidden: true };
      }
      return {
        type: "cell",
        object: d.object,
        cell: d.cell,
        value: views.redact(table.value(d.object, d.cell)),
      };
  }
}

/** The error-origin chain from `id`.`cell`, or undefined when its value is not an error. */
function errorChain(
  views: ViewBuilder,
  id: ObjectId,
  cell: string,
  value: Result,
): ExplainCellResult["error_chain"] {
  if (value.type !== "error") return undefined;
  const gm = views.viewer.type === "gm";
  const chain: NonNullable<ExplainCellResult["error_chain"]> = [];
  const seen = new Set<string>();
  let at = { object: id, cell };
  let current: Result = value;
  while (current.type === "error" && chain.length < MAX_ERROR_CHAIN) {
    seen.add(key(at.object, at.cell));
    if (gm || views.canSeeCell(at.object, at.cell)) {
      chain.push({ object: at.object, cell: at.cell, code: current.code });
    } else if (views.canSeeObject(at.object)) {
      chain.push({ object: at.object, cell: null, code: current.code });
    } else {
      chain.push({ object: null, cell: null, code: current.code });
    }
    const origin = current.origin;
    if (origin === undefined || seen.has(key(origin.object, origin.cell))) break;
    at = { object: origin.object, cell: origin.cell };
    current = views.table.value(at.object, at.cell);
  }
  return chain;
}

/** The viewer's `last_write` for `id`.`cell` (see `explainCell`). */
function lastWrite(
  views: ViewBuilder,
  id: ObjectId,
  cell: string,
): ExplainCellResult["last_write"] {
  const groups = views.table.store.history.groups();
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as DeepReadonly<OpGroup>;
    let cause: "edit" | "roll" | undefined;
    for (const e of g.effects) {
      if (e.type === "cell" && e.object === id && e.cell === cell) cause = e.cause;
    }
    if (cause === undefined) continue;
    const view = views.groupView(g, { effects: false });
    if (view === null) return undefined;
    const { index, revision, actor, kind, label } = view;
    return { index, revision, actor, kind, label, cause };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// explain_group

/**
 * `explain_group` (PROTOCOL.md §9): the group view with effects; for the
 * GM, when the group has an origin whose object still exists and still has
 * an action of that name, that action's current definition with
 * `current: true`. An index that is not retained, or a group whose view is
 * null for the viewer, is `not_found`.
 */
export function explainGroup(table: Table, params: ExplainGroupParams): ExplainGroupResult {
  const views = builder(table, params.viewer);
  const g = table.store.history.get(params.index);
  if (g === undefined) return notFound();
  const group = views.groupView(g, { effects: true });
  if (group === null) return notFound();
  const result: ExplainGroupResult = { group };
  if (views.viewer.type === "gm" && g.origin !== undefined) {
    const { object, action } = g.origin;
    const def = table.store.getObject(object)?.actions.find((a) => a.name === action);
    if (def !== undefined) {
      result.action = {
        object,
        name: def.name,
        ...(def.when === undefined ? {} : { when: def.when }),
        steps: [...def.steps],
        current: true,
      };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// explain_action

/**
 * `explain_action` (PROTOCOL.md §9): `enabled` is true iff the action has
 * no `when` or `engine.evaluate(when, {thisId})` is boolean `true`;
 * `reason` only when not enabled (`when_error` for an error, `when_false`
 * otherwise); `guard` only when there is a `when`, with its value (redacted
 * for a character) and, for the GM, its source; `steps` for the GM only.
 * An object that is not live or not visible to the viewer, and an unknown
 * action, are `not_found`.
 */
export function explainAction(table: Table, params: ExplainActionParams): ExplainActionResult {
  const views = builder(table, params.viewer);
  const gm = views.viewer.type === "gm";
  const o = table.store.getObject(params.object);
  if (o === undefined) return notFound();
  if (!gm && !views.canSeeObject(params.object)) notFound();
  const def = o.actions.find((a) => a.name === params.action);
  if (def === undefined) return notFound();

  const result: ExplainActionResult = { object: params.object, action: def.name, enabled: true };
  if (def.when !== undefined) {
    const value = table.engine.evaluate(def.when, { thisId: params.object });
    const enabled = value.type === "boolean" && value.value;
    result.enabled = enabled;
    if (!enabled) result.reason = value.type === "error" ? "when_error" : "when_false";
    result.guard = { ...(gm ? { source: def.when } : {}), value: views.redact(value) };
  }
  if (gm) result.steps = [...def.steps];
  return result;
}
