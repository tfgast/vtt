/**
 * Run state of a scenario over the protocol (vtt-5su.12) and name
 * resolution (FIXTURES.md §1 Names). Names resolve as in the M2 runner
 * (test/runner/steps.ts): a binding, else a setup object or board id; an
 * unknown name, a removed object or a board where an object is needed is a
 * ScenarioError. Whether an object is live is asked of the server
 * (`get_objects` as the GM: `missing` means removed).
 */
import { ScenarioError } from "@vtt/authority";
import type { Value as FixtureValue, Scenario } from "@vtt/fixtures";
import type { DocumentResult, ObjectView, ProtocolClient, Viewer } from "@vtt/protocol";
import type { ObjectId, Result, Snapshot, Value } from "@vtt/schema";
import { toValue } from "../runner/setup";
import type { ProtocolSession } from "./session";

export interface ProtocolRunState {
  readonly session: ProtocolSession;
  readonly client: ProtocolClient;
  /** Binding name → object id. */
  readonly bindings: Map<string, ObjectId>;
  /** Setup object and board ids. */
  readonly names: ReadonlySet<string>;
  /** The `document` snapshot right after setup, for `replay`. */
  readonly setup: Snapshot;
  /** The latest `document` result: after setup, then after every step. */
  doc: DocumentResult;
}

/** A fresh run over an open session. */
export async function newProtocolRunState(
  scenario: Scenario,
  session: ProtocolSession,
): Promise<ProtocolRunState> {
  const doc = await session.client.request("document", {});
  return {
    session,
    client: session.client,
    bindings: new Map(),
    names: new Set([
      ...scenario.setup.boards.map((b) => b.id),
      ...scenario.setup.objects.map((o) => o.id),
    ]),
    setup: structuredClone(doc.snapshot),
    doc,
  };
}

/** Fetches the current `document` into `state.doc`. */
export async function refreshDocument(state: ProtocolRunState): Promise<void> {
  state.doc = await state.client.request("document", {});
}

/** The id a setup id or binding stands for; an unknown name is a ScenarioError. */
export function resolveName(state: ProtocolRunState, name: string): ObjectId {
  const bound = state.bindings.get(name);
  if (bound !== undefined) return bound;
  if (state.names.has(name)) return name;
  throw new ScenarioError(`unknown object or binding "${name}"`);
}

/** A fixture value with every reference's name resolved to its id. */
export function resolveValue(state: ProtocolRunState, v: FixtureValue): Value {
  const walk = (x: Value): Value => {
    switch (x.type) {
      case "ref":
        return { type: "ref", object: resolveName(state, x.object) };
      case "list":
        return { type: "list", items: x.items.map(walk) };
      case "viewers":
        return {
          type: "viewers",
          viewers: x.viewers.map((e) =>
            typeof e === "string" ? e : { type: "ref", object: resolveName(state, e.object) },
          ),
        };
      default:
        return x;
    }
  };
  return walk(toValue(v));
}

/** `"gm"` or a character's name, as a `viewer` param. */
export function toViewer(state: ProtocolRunState, name: string): Viewer {
  return name === "gm" ? { type: "gm" } : { type: "character", id: resolveName(state, name) };
}

/** The view of `id` for `viewer` (the GM by default), or undefined when `missing`. */
export async function viewOf(
  state: ProtocolRunState,
  id: ObjectId,
  viewer?: Viewer,
): Promise<ObjectView | undefined> {
  const result = await state.client.request("get_objects", {
    ids: [id],
    ...(viewer === undefined ? {} : { viewer }),
  });
  return result.objects.find((o) => o.id === id);
}

/** As resolveName, for an object that must still exist: its id and GM view. */
export async function liveObject(
  state: ProtocolRunState,
  name: string,
): Promise<{ id: ObjectId; view: ObjectView }> {
  const id = resolveName(state, name);
  const view = await viewOf(state, id);
  if (view !== undefined) return { id, view };
  if (state.doc.snapshot.boards.some((b) => b.id === id)) {
    throw new ScenarioError(`"${name}" is a board, not an object`);
  }
  throw new ScenarioError(`"${name}" has been removed`);
}

/**
 * A cell's value in a GM view. A GM view holds every stored cell and every
 * readable structural cell (PROTOCOL.md §7.2), so a cell it lacks is no cell
 * of the object: `#NAME`, as the engine reads it (FORMULAS.md §2.1). The
 * structural `id` cell is the exception: a view carries identity as
 * `ObjectView.id`, outside `cells` (§7.2), and the cell reads as that text.
 */
export function cellValue(view: ObjectView, cell: string): Result {
  if (cell === "id") return { type: "text", value: view.id };
  const held = view.cells[cell];
  if (held !== undefined) return held.value as Result;
  return { type: "error", code: "#NAME", message: `no cell ${cell} on ${view.id}` };
}

/** The object ids of a `ref` list value (a `contents` cell); others are skipped. */
export function refIds(v: Result): ObjectId[] {
  if (v.type !== "list") return [];
  return v.items.flatMap((x) => (x.type === "ref" ? [x.object] : []));
}
