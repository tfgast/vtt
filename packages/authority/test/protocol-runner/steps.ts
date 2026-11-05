/**
 * The M2 steps over the protocol (vtt-5su.12; FIXTURES.md §6; PROTOCOL.md
 * §4–§7). Each step is the request the M2 runner's primitive maps to:
 *
 * - `set`, `override` → `transact [set_value]`; `clear_override` →
 *   `transact [clear_override]`; `move` → `transact [move]`; `spawn` →
 *   `transact [spawn]` with `as`, the `owned` bindings taken from the
 *   result's `copies`; `undo` → `undo {type:"latest"}`; `invoke` →
 *   `invoke {object, action}` (vtt-1xv.13; PROTOCOL.md §4), labelled by the
 *   authority with the action's name as the direct runner's executor does.
 * - The scenario errors of `set`, `override` and `clear_override` are
 *   decided from the GM view (PROTOCOL.md §7.2): `set` on a cell whose
 *   `kind` is `"formula"` (structural cells such as `position` included),
 *   `override` on one whose `kind` is not `"formula"`, `clear_override` on
 *   one not `overridden`.
 * - A step's actor is the `actor` param (characters as `{type:"character",
 *   id}`, the GM by omission); `base_revision` is the client's revision;
 *   labels are the direct runner's.
 * - `bind` changes nothing: the contents of `in` (or `list_objects` with the
 *   tag filter) compared on GM views by FORMULAS §4 equality.
 */
import { ScenarioError } from "@vtt/authority";
import type { Destination as FixtureDestination, Step } from "@vtt/fixtures";
import { equals } from "@vtt/formula";
import type {
  Destination,
  InputCellContent,
  InvokeResult,
  ObjectView,
  ProtocolRejection,
  TransactParams,
  TransactResult,
  WireOp,
} from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { toContent } from "../runner/setup";
import {
  cellValue,
  liveObject,
  type ProtocolRunState,
  refIds,
  resolveName,
  resolveValue,
} from "./state";

/** What a step did. */
export type WireStepOutcome =
  | { type: "committed" }
  | { type: "refused"; rejection: ProtocolRejection }
  /** A `bind`: nothing changed. */
  | { type: "bound" };

type ActorParam = TransactParams["actor"];

/** `"gm"` (no `actor` param) or a character's name. */
function toActorParam(state: ProtocolRunState, name: string | undefined): ActorParam {
  if (name === undefined) throw new ScenarioError("the step has no actor");
  return name === "gm" ? undefined : { type: "character", id: resolveName(state, name) };
}

async function toDestination(
  state: ProtocolRunState,
  to: FixtureDestination,
): Promise<Destination> {
  if (to.type === "board") {
    return { type: "board", board: resolveName(state, to.board), position: [...to.position] };
  }
  const { id } = await liveObject(state, to.container);
  return {
    type: "container",
    container: id,
    ...(to.index === undefined ? {} : { index: to.index }),
  };
}

/** Introduces binding `name` for `id`; a name already in use is a ScenarioError. */
function bindName(state: ProtocolRunState, name: string, id: ObjectId): void {
  if (state.bindings.has(name) || state.names.has(name)) {
    throw new ScenarioError(`"${name}" is already bound`);
  }
  state.bindings.set(name, id);
}

const outcome = (r: TransactResult | InvokeResult): WireStepOutcome =>
  r.status === "committed" ? { type: "committed" } : { type: "refused", rejection: r.rejection };

function transact(
  state: ProtocolRunState,
  actor: ActorParam,
  label: string,
  op: WireOp,
): Promise<TransactResult> {
  return state.client.transact([op], {
    label,
    base_revision: state.client.revision,
    ...(actor === undefined ? {} : { actor }),
  });
}

/** Applies one step. */
export async function applyWireStep(state: ProtocolRunState, step: Step): Promise<WireStepOutcome> {
  const d = step.do;
  if (d.type === "bind") {
    if (step.actor !== undefined) throw new ScenarioError("a bind step has no actor");
    bindName(state, d.as, await bindTarget(state, d));
    return { type: "bound" };
  }
  const actor = toActorParam(state, step.actor);
  switch (d.type) {
    case "set": {
      const { id, view } = await liveObject(state, d.object);
      const value = resolveValue(state, d.value);
      if (view.cells[d.cell]?.kind === "formula") {
        throw new ScenarioError(
          `set on "${d.object}.${d.cell}", which holds a formula (use override)`,
        );
      }
      const op: WireOp = { type: "set_value", object: id, cell: d.cell, value };
      return outcome(await transact(state, actor, `set ${d.object}.${d.cell}`, op));
    }
    case "override": {
      const { id, view } = await liveObject(state, d.object);
      const value = resolveValue(state, d.value);
      if (view.cells[d.cell]?.kind !== "formula") {
        throw new ScenarioError(
          `override on "${d.object}.${d.cell}", which does not hold a formula (use set)`,
        );
      }
      const op: WireOp = { type: "set_value", object: id, cell: d.cell, value };
      return outcome(await transact(state, actor, `override ${d.object}.${d.cell}`, op));
    }
    case "clear_override": {
      const { id, view } = await liveObject(state, d.object);
      if (view.cells[d.cell]?.overridden !== true) {
        throw new ScenarioError(`clear_override on "${d.object}.${d.cell}", which has none`);
      }
      const op: WireOp = { type: "clear_override", object: id, cell: d.cell };
      return outcome(await transact(state, actor, `clear override ${d.object}.${d.cell}`, op));
    }
    case "move": {
      const { id } = await liveObject(state, d.object);
      const to = await toDestination(state, d.to);
      const op: WireOp = { type: "move", object: id, to };
      return outcome(await transact(state, actor, `move ${d.object}`, op));
    }
    case "spawn":
      return spawnStep(state, actor, d);
    case "undo":
      if (actor !== undefined) {
        // PROTOCOL.md §4: `undo` takes no actor, so a character's undo
        // cannot be sent; no M2 scenario has one.
        throw new ScenarioError("an undo step by a character cannot be sent over the protocol");
      }
      return outcome(await state.client.request("undo", { target: { type: "latest" } }));
    case "invoke": {
      const { id } = await liveObject(state, d.object);
      return outcome(
        await state.client.request("invoke", {
          object: id,
          action: d.action,
          base_revision: state.client.revision,
          ...(actor === undefined ? {} : { actor }),
        }),
      );
    }
  }
}

async function spawnStep(
  state: ProtocolRunState,
  actor: ActorParam,
  d: Extract<Step["do"], { type: "spawn" }>,
): Promise<WireStepOutcome> {
  const { id: template } = await liveObject(state, d.template);
  const to = await toDestination(state, d.to);
  const cells: Record<string, InputCellContent> = {};
  for (const [name, c] of Object.entries(d.cells ?? {})) {
    cells[name] = (
      c.type === "formula" ? toContent(c) : resolveValue(state, c)
    ) as InputCellContent;
  }
  const owned = Object.entries(d.owned ?? {}).map(
    ([key, name]) => [resolveName(state, key), name] as const,
  );
  const as = `$${d.as}`;
  const op: WireOp = {
    type: "spawn",
    template,
    to,
    ...(Object.keys(cells).length > 0 ? { cells } : {}),
    as,
  };
  const result = await transact(state, actor, `spawn ${d.template}`, op);
  if (result.status === "committed") {
    const spawned = result.copies[0];
    const root = result.bindings[as];
    if (spawned === undefined || root === undefined || root !== spawned.root) {
      throw new Error(`spawn result without its root: ${JSON.stringify(result)}`);
    }
    bindName(state, d.as, root);
    for (const [original, name] of owned) {
      const copy = spawned.copies[original];
      if (copy === undefined) {
        throw new ScenarioError(`"${original}" is not in the subtree of "${d.template}"`);
      }
      bindName(state, name, copy);
    }
  }
  return outcome(result);
}

/** Every GM view of the objects tagged `tag`, through `list_objects`, all pages. */
async function taggedViews(state: ProtocolRunState, tag: string): Promise<ObjectView[]> {
  const out: ObjectView[] = [];
  let cursor: string | null = null;
  do {
    const page: { objects: ObjectView[]; next_cursor: string | null } = await state.client.request(
      "list_objects",
      {
        filter: { tag },
        cells: "all",
        ...(cursor === null ? {} : { cursor }),
      },
    );
    out.push(...page.objects);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return out;
}

const hasTag = (view: ObjectView, tag: string): boolean => {
  const tags = cellValue(view, "tag");
  return tags.type === "list" && tags.items.some((t) => t.type === "text" && t.value === tag);
};

/** The one object a `bind` step names (FIXTURES.md §6, Bind). */
async function bindTarget(
  state: ProtocolRunState,
  d: Extract<Step["do"], { type: "bind" }>,
): Promise<ObjectId> {
  let candidates: ObjectView[];
  if (d.in === undefined) {
    candidates = await taggedViews(state, d.tag);
  } else {
    const { view } = await liveObject(state, d.in);
    const ids = refIds(cellValue(view, "contents"));
    candidates =
      ids.length === 0 ? [] : (await state.client.request("get_objects", { ids })).objects;
  }
  const wanted = d.where === undefined ? undefined : resolveValue(state, d.where.value);
  const matches = candidates
    .filter((view) => {
      if (!hasTag(view, d.tag)) return false;
      if (d.where === undefined || wanted === undefined) return true;
      const eq = equals(cellValue(view, d.where.cell), wanted);
      return eq.type === "boolean" && eq.value;
    })
    .map((view) => view.id);
  if (matches.length !== 1) {
    throw new ScenarioError(
      `bind "${d.as}" matches ${matches.length} objects${matches.length > 0 ? ` (${matches.sort().join(", ")})` : ""}; it must match exactly one`,
    );
  }
  return matches[0] as ObjectId;
}
