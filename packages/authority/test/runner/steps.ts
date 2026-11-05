/**
 * Run state and the M2 steps (FIXTURES.md §1 Names, §6; vtt-75c.13): `set`,
 * `override`, `clear_override`, `move`, `spawn`, `undo` and `bind`.
 *
 * Every step but `bind` and `undo` is one `transactWithDice` transaction, so
 * a refusal comes back as a rejection (for the rejection protocol, run.ts)
 * and a ScenarioError (a bad name, a step used wrongly, a bad dice script)
 * propagates. `undo` is the store's own transaction (`undo(store, actor,
 * {type: "latest"})`); it consumes no dice. `bind` changes nothing.
 */

import {
  clearOverride,
  type Destination,
  move,
  ScenarioError,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  spawn,
  Table,
  type Transaction,
  type TransactResult,
  transactWithDice,
  undo,
  writeValue,
} from "@vtt/authority";
import type {
  Destination as FixtureDestination,
  Value as FixtureValue,
  Scenario,
  Step,
} from "@vtt/fixtures";
import { equals } from "@vtt/formula";
import type { Actor, CellContent, ObjectId, Rejection, Snapshot, Value } from "@vtt/schema";
import { documentFromSetup, toContent, toValue } from "./setup";

/** Everything a run carries from step to step. */
export interface RunState {
  /** Replaced by each round-trip hop. */
  table: Table;
  readonly dice: ScriptedDiceSource;
  /** Binding name → engine id. */
  readonly bindings: Map<string, ObjectId>;
  /** Setup object and board ids. */
  readonly names: ReadonlySet<string>;
  /** The document right after setup, for `replay`. */
  readonly setup: Snapshot;
}

/** A fresh run of `scenario`: its setup document, its dice script, no bindings. */
export function newRunState(scenario: Scenario): RunState {
  const doc = documentFromSetup(scenario.setup);
  const table = Table.fromSnapshot(doc);
  return {
    table,
    dice: new ScriptedDiceSource(scenario.dice as ScriptedDiceEntry[]),
    bindings: new Map(),
    names: new Set([...scenario.setup.boards.map((b) => b.id), ...Object.keys(doc.objects)]),
    setup: table.store.toSnapshot(),
  };
}

// Names.

/** The id a setup id or binding stands for; an unknown name is a ScenarioError. */
export function resolveName(state: RunState, name: string): ObjectId {
  const bound = state.bindings.get(name);
  if (bound !== undefined) return bound;
  if (state.names.has(name)) return name;
  throw new ScenarioError(`unknown object or binding "${name}"`);
}

/** As resolveName, for an object that must still exist. */
export function liveObject(state: RunState, name: string): ObjectId {
  const id = resolveName(state, name);
  if (state.table.store.hasObject(id)) return id;
  if (state.table.store.boardIndex(id) >= 0) {
    throw new ScenarioError(`"${name}" is a board, not an object`);
  }
  throw new ScenarioError(`"${name}" has been removed`);
}

/** A fixture value with every reference's name resolved to its id. */
export function resolveValue(state: RunState, v: FixtureValue): Value {
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

/** `"gm"` or a character's name. */
export function toActor(state: RunState, name: string | undefined): Actor {
  if (name === undefined) throw new ScenarioError("the step has no actor");
  return name === "gm" ? { type: "gm" } : { type: "character", id: resolveName(state, name) };
}

function toDestination(state: RunState, to: FixtureDestination): Destination {
  return to.type === "board"
    ? { type: "board", board: resolveName(state, to.board), position: [...to.position] }
    : { type: "container", container: liveObject(state, to.container), index: to.index };
}

/** Introduces binding `name` for `id`; a name already in use is a ScenarioError. */
function bindName(state: RunState, name: string, id: ObjectId): void {
  if (state.bindings.has(name) || state.names.has(name)) {
    throw new ScenarioError(`"${name}" is already bound`);
  }
  state.bindings.set(name, id);
}

// Steps.

/** What a step did. */
export type StepOutcome =
  | { type: "committed" }
  | { type: "refused"; rejection: Rejection }
  /** A `bind`: nothing changed. */
  | { type: "bound" };

/** One step's transaction: `transactWithDice` over the run's table and dice script. */
export function transactStep(
  state: RunState,
  actor: Actor,
  label: string,
  fn: (tx: Transaction) => void,
): TransactResult {
  return transactWithDice(state.table, actor, { kind: "edit", label }, state.dice, fn);
}

const outcome = (r: TransactResult): StepOutcome =>
  r.ok ? { type: "committed" } : { type: "refused", rejection: r.rejection };

/** The stored content of `obj`.`cell` in the transaction's working copy. */
const stored = (tx: Transaction, obj: ObjectId, cell: string) => tx.doc.getCell(obj, cell);

/** Applies one step that is not `invoke`. */
export function applyStep(state: RunState, step: Step): StepOutcome {
  const d = step.do;
  if (d.type === "bind") {
    if (step.actor !== undefined) throw new ScenarioError("a bind step has no actor");
    bindName(state, d.as, bindTarget(state, d));
    return { type: "bound" };
  }
  const actor = toActor(state, step.actor);
  switch (d.type) {
    case "set": {
      const obj = liveObject(state, d.object);
      const value = resolveValue(state, d.value);
      return outcome(
        transactStep(state, actor, `set ${d.object}.${d.cell}`, (tx) => {
          if (stored(tx, obj, d.cell)?.content.type === "formula") {
            throw new ScenarioError(
              `set on "${d.object}.${d.cell}", which holds a formula (use override)`,
            );
          }
          writeValue(tx, obj, d.cell, value);
        }),
      );
    }
    case "override": {
      const obj = liveObject(state, d.object);
      const value = resolveValue(state, d.value);
      return outcome(
        transactStep(state, actor, `override ${d.object}.${d.cell}`, (tx) => {
          if (stored(tx, obj, d.cell)?.content.type !== "formula") {
            throw new ScenarioError(
              `override on "${d.object}.${d.cell}", which does not hold a formula (use set)`,
            );
          }
          writeValue(tx, obj, d.cell, value);
        }),
      );
    }
    case "clear_override": {
      const obj = liveObject(state, d.object);
      return outcome(
        transactStep(state, actor, `clear override ${d.object}.${d.cell}`, (tx) => {
          if (stored(tx, obj, d.cell)?.override === undefined) {
            throw new ScenarioError(`clear_override on "${d.object}.${d.cell}", which has none`);
          }
          clearOverride(tx, obj, d.cell);
        }),
      );
    }
    case "move": {
      const obj = liveObject(state, d.object);
      const dest = toDestination(state, d.to);
      return outcome(transactStep(state, actor, `move ${d.object}`, (tx) => move(tx, obj, dest)));
    }
    case "spawn": {
      const template = liveObject(state, d.template);
      const dest = toDestination(state, d.to);
      const cells: Record<string, CellContent> = {};
      for (const [name, c] of Object.entries(d.cells ?? {})) {
        cells[name] = c.type === "formula" ? toContent(c) : resolveValue(state, c);
      }
      const owned = Object.entries(d.owned ?? {}).map(
        ([key, name]) => [resolveName(state, key), name] as const,
      );
      let copies = new Map<ObjectId, ObjectId>();
      let root = "";
      const result = transactStep(state, actor, `spawn ${d.template}`, (tx) => {
        ({ root, copies } = spawn(tx, template, dest, cells));
      });
      if (result.ok) {
        bindName(state, d.as, root);
        for (const [original, name] of owned) {
          const copy = copies.get(original);
          if (copy === undefined) {
            throw new ScenarioError(`"${original}" is not in the subtree of "${d.template}"`);
          }
          bindName(state, name, copy);
        }
      }
      return outcome(result);
    }
    case "undo":
      return outcome(undo(state.table.store, actor, { type: "latest" }));
    case "invoke":
      throw new ScenarioError("invoke steps are not supported before M5");
  }
}

/** The one object a `bind` step names (FIXTURES.md §6, Bind). */
function bindTarget(state: RunState, d: Extract<Step["do"], { type: "bind" }>): ObjectId {
  const { store } = state.table;
  const container = d.in === undefined ? undefined : liveObject(state, d.in);
  const wanted = d.where === undefined ? undefined : resolveValue(state, d.where.value);
  const matches = store.objectIds().filter((id) => {
    if (!store.getObject(id)?.tag.includes(d.tag)) return false;
    if (container !== undefined && store.containerOf(id) !== container) return false;
    if (d.where === undefined || wanted === undefined) return true;
    const eq = equals(state.table.value(id, d.where.cell), wanted);
    return eq.type === "boolean" && eq.value;
  });
  if (matches.length !== 1) {
    throw new ScenarioError(
      `bind "${d.as}" matches ${matches.length} objects${matches.length > 0 ? ` (${matches.sort().join(", ")})` : ""}; it must match exactly one`,
    );
  }
  return matches[0] as ObjectId;
}
