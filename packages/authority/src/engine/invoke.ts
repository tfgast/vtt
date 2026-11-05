/**
 * The action executor (DESIGN.md §4.5, §7 Transactions; FORMULAS.md §8.1,
 * §8.2 paths; M5-D5, M5-D6; review r1 finding 2, r2 finding 8).
 *
 * `createExecutor({handlers})` builds an executor from step handlers, one
 * per step kind: `coreHandlers` (steps-value.ts) for the value steps and the
 * placement handlers (steps-place.ts) for `move`, `spawn` and `remove`.
 * Callers compose them explicitly; nothing registers itself at import time.
 *
 * `runAction` executes one action inside a transaction the caller opened,
 * and never commits or aborts it: on a refusal the caller aborts by throwing
 * `new Rejected(rejection)` from its transaction function, so the store
 * discards the partial effects and `transactWithDice` resets the dice.
 * `invokeAction` is exactly that composition.
 *
 * Order (FORMULAS §8.1): the object and an action of exactly that name
 * (else `invalid`); `when` at the committed revision (`true` runs, an error
 * is `when_error`, anything else `when_false`); every step parsed (the first
 * failure is `step_error` `#SYNTAX` with its index); then the steps, in
 * order, through their handlers. Nothing before the first `roll` or
 * `shuffle` draws dice.
 *
 * Refusals inside a step: an evaluation error is `step_error` with its code;
 * a primitive's `Rejected` keeps its type (`protected_cell`,
 * `containment_cycle`, `type_error`) with the step index alongside, except
 * `invalid`, which becomes `step_error` without code and with the
 * primitive's message. Any other exception (a dice script's
 * `ScenarioError` included) propagates. The index is the step's 0-based
 * position in the action; a failure inside `each` reports the `each`'s.
 *
 * Limits (M5-D5): more than `MAX_ACTION_WRITES` primitive calls in one
 * invocation is `step_error` `#LIMIT` (`each`'s `MAX_EACH_ITEMS` is checked
 * by its handler).
 */
import {
  type DiceExpr,
  DEFAULT_BUDGET,
  type EvalEnv,
  type Expr,
  evaluate,
  limitError,
  type PathNode,
  parseStep,
  type Step,
  withBudget,
  Budget,
} from "@vtt/formula";
import {
  type Actor,
  type BoardId,
  type CellContent,
  type ErrorCode,
  MAX_ACTION_WRITES,
  type ObjectId,
  type Rejection,
  type Result,
  type RollValue,
  type Value,
} from "@vtt/schema";
import type { TransactResult } from "../store/document-store";
import { setTag, writeValue } from "../store/edits";
import { type Destination, move, remove, type SpawnResult, spawn } from "../store/structural";
import type { ChangeSummary } from "../store/summary";
import type { FrozenGroup } from "../store/history";
import { Rejected, type Transaction } from "../store/transaction";
import { ActionContext } from "./action-context";
import { type DiceSource, rollInto, shuffleWith, transactWithDice } from "./dice";
import type { Table } from "./table";

/** What one step's handler returns. */
export type StepOutcome = { ok: true } | { ok: false; rejection: Rejection };

/** Handles one step kind. A primitive's `Rejected` thrown inside it is mapped by the executor. */
export type StepHandler = (ctx: StepContext, step: Step) => StepOutcome;

export interface StepHandlerEntry {
  kind: Step["kind"];
  handle: StepHandler;
}

/** What the `table` destination resolves to: the invoker's board and viewport centre. */
export interface TableDestination {
  board: BoardId;
  position: [number, number];
}

/**
 * M2's primitives bound to the invocation's transaction and dice source.
 * Each call counts one primitive call toward `MAX_ACTION_WRITES`, checked
 * before the primitive runs.
 */
export interface StepPrimitives {
  writeValue(obj: ObjectId, cell: string, value: Value): void;
  setTag(obj: ObjectId, tags: string[]): void;
  rollInto(obj: ObjectId, cell: string, dice: string | DiceExpr): RollValue;
  shuffleWith(container: ObjectId): number[];
  move(obj: ObjectId, dest: Destination): void;
  spawn(
    template: ObjectId,
    dest: Destination,
    initialCells?: Record<string, CellContent>,
  ): SpawnResult;
  remove(obj: ObjectId): void;
}

export type PathResolution =
  | { ok: true; object: ObjectId; cell: string }
  | { ok: false; rejection: Rejection };

export type RefResolution = { ok: true; object: ObjectId } | { ok: false; rejection: Rejection };

/** What a handler sees while its step runs. */
export interface StepContext {
  readonly tx: Transaction;
  readonly table: Table;
  readonly dice: DiceSource;
  /** The object whose action runs. */
  readonly thisId: ObjectId;
  /** The current item inside `each`. */
  readonly it?: Value;
  readonly tableDestination?: TableDestination;
  /** Handlers push spawned ids here, in creation order. */
  readonly created: ObjectId[];
  /**
   * Evaluates `expr` through the invocation's ActionContext (reads see this
   * action's writes, other cells read as of its start) with scope
   * `{thisId, it}` and a fresh `DEFAULT_BUDGET` (20,000 units).
   */
  evaluate(expr: Expr): Result;
  /**
   * A cell's current value through the ActionContext (read-your-writes);
   * undefined when the cell is absent, `#REF` when the object is gone.
   */
  read(object: ObjectId, cell: string): Result | undefined;
  /**
   * A path's object and cell (FORMULAS §8.2): a bare name is a cell of
   * `this`; otherwise the object part must be one reference to an existing
   * object (`empty` → `#REF`, a list or another kind → `#TYPE`, an error →
   * its code). Failures are step errors at the current index.
   */
  resolvePath(path: PathNode): PathResolution;
  /** `expr` as one reference to an existing object, by the rules of `resolvePath`. */
  resolveRef(expr: Expr): RefResolution;
  readonly primitives: StepPrimitives;
  /** Counts `n` extra primitive calls; past `MAX_ACTION_WRITES` the action refuses `#LIMIT`. */
  count(n: number): void;
  /** A `step_error` at the current step index. */
  refuse(reason: { code?: ErrorCode; message: string }): StepOutcome;
  /** Runs `step` with `it` bound, through its handler (used by `each`). */
  runStep(step: Step, scope: { it: Value }): StepOutcome;
}

export interface RunRequest {
  object: ObjectId;
  action: string;
  tableDestination?: TableDestination;
}

export type RunOutcome =
  | { ok: true; created: ObjectId[] }
  | { ok: false; rejection: Rejection; step?: number };

export interface InvokeRequest extends RunRequest {
  actor: Actor;
  /** The group label; defaults to the action name. */
  label?: string;
}

export type InvokeOutcome =
  | {
      ok: true;
      group: FrozenGroup;
      summary: ChangeSummary;
      created: ObjectId[];
      /** What public commit listeners threw; the commit stands. */
      listenerErrors: unknown[];
    }
  | { ok: false; rejection: Rejection; step?: number };

export interface Executor {
  runAction(tx: Transaction, ctx: { table: Table; dice: DiceSource }, req: RunRequest): RunOutcome;
  invokeAction(table: Table, dice: DiceSource, req: InvokeRequest): InvokeOutcome;
}

/** Thrown when the invocation's primitive calls pass `MAX_ACTION_WRITES`; caught per step. */
class WriteLimitExceeded extends Error {
  constructor() {
    super(`more than ${MAX_ACTION_WRITES} primitive calls in one action`);
    this.name = "WriteLimitExceeded";
  }
}

/** An EvalEnv that charges `budget` as the engine's recording env does (FORMULAS §7). */
function budgeted(env: EvalEnv, budget: Budget): EvalEnv {
  const enumerate = (ids: ObjectId[]) => {
    budget.charge(new Set(ids).size);
    return ids;
  };
  return {
    read(id, cell) {
      budget.charge();
      return env.read(id, cell);
    },
    exists(id) {
      budget.charge();
      return env.exists(id);
    },
    objectsNamed: (name) => enumerate(env.objectsNamed(name)),
    allObjects: () => enumerate(env.allObjects()),
    objectsOnBoard: (board, near) => enumerate(env.objectsOnBoard(board, near)),
  };
}

/** One invocation's shared state. */
interface Invocation {
  readonly tx: Transaction;
  readonly table: Table;
  readonly dice: DiceSource;
  readonly object: ObjectId;
  readonly action: string;
  readonly tableDestination?: TableDestination;
  readonly env: ActionContext;
  readonly created: ObjectId[];
  calls: number;
}

export function createExecutor(options: { handlers: StepHandlerEntry[] }): Executor {
  const handlers = new Map<Step["kind"], StepHandler>();
  for (const { kind, handle } of options.handlers) {
    if (handlers.has(kind)) throw new Error(`createExecutor: two handlers for step kind "${kind}"`);
    handlers.set(kind, handle);
  }

  const stepError = (
    inv: Invocation,
    step: number,
    code: ErrorCode | undefined,
    message: string,
  ): Rejection =>
    code === undefined
      ? { type: "step_error", object: inv.object, action: inv.action, step, message }
      : { type: "step_error", object: inv.object, action: inv.action, step, code, message };

  /** Runs `step` through its handler, mapping refusals to the step index `index`. */
  function runHandler(inv: Invocation, index: number, step: Step, it?: Value): StepOutcome {
    const handle = handlers.get(step.kind);
    if (handle === undefined) {
      return {
        ok: false,
        rejection: stepError(
          inv,
          index,
          undefined,
          `the step "${step.kind}" is not supported here`,
        ),
      };
    }
    try {
      return handle(context(inv, index, it), step);
    } catch (e) {
      if (e instanceof WriteLimitExceeded) {
        return { ok: false, rejection: stepError(inv, index, "#LIMIT", e.message) };
      }
      if (e instanceof Rejected) {
        const r = e.rejection;
        if (r.type === "invalid") {
          return { ok: false, rejection: stepError(inv, index, undefined, r.message) };
        }
        return { ok: false, rejection: r };
      }
      throw e;
    }
  }

  function context(inv: Invocation, index: number, it?: Value): StepContext {
    const { tx, dice } = inv;
    const count = (n: number) => {
      inv.calls += n;
      if (inv.calls > MAX_ACTION_WRITES) throw new WriteLimitExceeded();
    };
    const refuseWith = (code: ErrorCode | undefined, message: string) => ({
      ok: false as const,
      rejection: stepError(inv, index, code, message),
    });
    const evaluateExpr = (expr: Expr): Result => {
      const budget = new Budget(DEFAULT_BUDGET);
      const scope = it === undefined ? { thisId: inv.object } : { thisId: inv.object, it };
      return withBudget(
        () => evaluate(expr, scope, budgeted(inv.env, budget)),
        () => limitError(DEFAULT_BUDGET),
      );
    };
    const resolveRef = (expr: Expr): RefResolution => {
      const v = evaluateExpr(expr);
      switch (v.type) {
        case "error":
          return refuseWith(v.code, v.message ?? v.code);
        case "empty":
          return refuseWith("#REF", "needs a reference to an object, found empty");
        case "ref":
          if (!tx.doc.hasObject(v.object)) {
            return refuseWith("#REF", `reference to deleted object ${v.object}`);
          }
          return { ok: true, object: v.object };
        default:
          return refuseWith("#TYPE", `needs one reference to an object, found ${v.type}`);
      }
    };
    const ctx: StepContext = {
      tx,
      table: inv.table,
      dice,
      thisId: inv.object,
      ...(it === undefined ? {} : { it }),
      ...(inv.tableDestination === undefined ? {} : { tableDestination: inv.tableDestination }),
      created: inv.created,
      evaluate: evaluateExpr,
      read: (object, cell) => inv.env.read(object, cell),
      resolvePath(path) {
        if (path.object === null) {
          if (!tx.doc.hasObject(inv.object)) {
            return refuseWith("#REF", `reference to deleted object ${inv.object}`);
          }
          return { ok: true, object: inv.object, cell: path.cell };
        }
        const r = resolveRef(path.object);
        return r.ok ? { ok: true, object: r.object, cell: path.cell } : r;
      },
      resolveRef,
      primitives: {
        writeValue(obj, cell, value) {
          count(1);
          writeValue(tx, obj, cell, value);
        },
        setTag(obj, tags) {
          count(1);
          setTag(tx, obj, tags);
        },
        rollInto(obj, cell, d) {
          count(1);
          return rollInto(tx, dice, obj, cell, d);
        },
        shuffleWith(container) {
          count(1);
          return shuffleWith(tx, dice, container);
        },
        move(obj, dest) {
          count(1);
          move(tx, obj, dest);
        },
        spawn(template, dest, initialCells) {
          count(1);
          return spawn(tx, template, dest, initialCells);
        },
        remove(obj) {
          count(1);
          remove(tx, obj);
        },
      },
      count,
      refuse: ({ code, message }) => refuseWith(code, message),
      runStep: (step, scope) => runHandler(inv, index, step, scope.it),
    };
    return ctx;
  }

  function runAction(
    tx: Transaction,
    { table, dice }: { table: Table; dice: DiceSource },
    req: RunRequest,
  ): RunOutcome {
    const { object, action } = req;
    const o = tx.doc.getObject(object);
    if (o === undefined) {
      return { ok: false, rejection: { type: "invalid", message: `no object "${object}"` } };
    }
    const def = o.actions.find((a) => a.name === action);
    if (def === undefined) {
      return {
        ok: false,
        rejection: { type: "invalid", message: `"${object}" has no action named "${action}"` },
      };
    }
    if (def.when !== undefined) {
      const guard = table.engine.evaluate(def.when, { thisId: object });
      if (guard.type === "error") {
        const base = { type: "when_error", object, action, code: guard.code } as const;
        return {
          ok: false,
          rejection: guard.message === undefined ? base : { ...base, message: guard.message },
        };
      }
      if (guard.type !== "boolean" || !guard.value) {
        return { ok: false, rejection: { type: "when_false", object, action } };
      }
    }
    const inv: Invocation = {
      tx,
      table,
      dice,
      object,
      action,
      ...(req.tableDestination === undefined ? {} : { tableDestination: req.tableDestination }),
      env: new ActionContext(table, tx),
      created: [],
      calls: 0,
    };
    const steps: Step[] = [];
    for (const [i, source] of def.steps.entries()) {
      const parsed = parseStep(source);
      if (!parsed.ok) {
        return {
          ok: false,
          rejection: stepError(inv, i, "#SYNTAX", parsed.message),
          step: i,
        };
      }
      steps.push(parsed.step);
    }
    for (const [i, step] of steps.entries()) {
      const outcome = runHandler(inv, i, step);
      if (!outcome.ok) return { ok: false, rejection: outcome.rejection, step: i };
    }
    return { ok: true, created: [...inv.created] };
  }

  function invokeAction(table: Table, dice: DiceSource, req: InvokeRequest): InvokeOutcome {
    const { object, action } = req;
    let step: number | undefined;
    let created: ObjectId[] = [];
    const result: TransactResult = transactWithDice(
      table,
      req.actor,
      { kind: "action", label: req.label ?? action, origin: { object, action } },
      dice,
      (tx) => {
        const run: RunRequest =
          req.tableDestination === undefined
            ? { object, action }
            : { object, action, tableDestination: req.tableDestination };
        const r = runAction(tx, { table, dice }, run);
        if (!r.ok) {
          step = r.step;
          throw new Rejected(r.rejection);
        }
        created = r.created;
      },
    );
    if (!result.ok) {
      return step === undefined
        ? { ok: false, rejection: result.rejection }
        : { ok: false, rejection: result.rejection, step };
    }
    return {
      ok: true,
      group: result.group,
      summary: result.summary,
      created,
      listenerErrors: result.listenerErrors,
    };
  }

  return { runAction, invokeAction };
}
