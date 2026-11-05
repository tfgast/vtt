/**
 * Iterative resolution (FORMULAS.md §7, "No depth limit"; §2.3 `#CYCLE`).
 *
 * Resolving a formula cell never recurses in JS across cells. An evaluation
 * attempt that reads an uncomputed formula cell gets an internal pending
 * marker (an `empty`) and carries on, collecting every uncomputed formula
 * cell it reaches; the attempt's result is discarded, the collected cells
 * are computed from an explicit work stack, and the reader is retried. Reads
 * of memoized cells are cheap, so a retry costs one read per dependency.
 *
 * Definite and speculative edges. Every read before an attempt's first
 * pending marker saw a final value, so the first pending cell is a true
 * dependency (definite). Reads after the marker may follow control flow the
 * marker changed (an `if` on a pending condition), so the rest are
 * speculative: they are computed to save retries, but they never take part
 * in cycle detection. A cycle closed through a speculative edge abandons
 * that speculative subtree (its memoized descendants stay valid) and the
 * cell is never pushed speculatively again during this resolution; if it is
 * really needed, a later attempt reaches it first and pushes it as definite.
 *
 * Cycles are the strongly connected components of the definite graph, found
 * with Tarjan's algorithm over the work stack. A cell needed while it is in
 * progress or pending in an unfinished component closes a cycle: the read
 * returns `#CYCLE` with that cell as origin. When a component's root
 * finishes, each member of a non-trivial component (or of a self-loop) is
 * forced to `#CYCLE` with itself as origin, whatever it computed, so an
 * `iserror` guard inside the cycle does not escape it. Cells outside read the
 * members' memoized errors and receive them, origin intact.
 */
import { EMPTY, type ErrorValue, err, type ObjectId, type Result } from "@vtt/schema";
import { evaluate } from "../eval/evaluate";
import { validateRefs } from "../eval/refs";
import type { Registry } from "../functions/registry";
import { type CellKey, cellKey, type Dependency, type EvalHost } from "../host";
import type { ParseResult } from "../syntax/parser";
import { limitError, withBudget } from "./budget";
import { createRecordingEnv } from "./env";

/** Counters for tests: evaluator runs, completed evaluations, and cell reads. */
export interface EngineStats {
  /** Formula results computed (one per formula per revision, cycle members included). */
  evaluations: number;
  /** Calls to the evaluator, complete or not. */
  attempts: number;
  /** `EvalEnv.read` calls across all attempts. */
  reads: number;
  /** Distinct formula sources parsed. */
  parses: number;
}

/** What resolution needs from the engine. */
export interface ResolveContext {
  readonly host: EvalHost;
  readonly registry: Registry | undefined;
  readonly stats: EngineStats;
  /** The clean memoized result of `key`, or `undefined` if uncomputed or dirty. */
  memoized(key: CellKey): Result | undefined;
  /** Record `key`'s result and dependency set for this revision. */
  store(key: CellKey, result: Result, deps: readonly Dependency[]): void;
  /** Parse `source`, once per distinct string. */
  parse(source: string): ParseResult;
  /** Units each formula evaluation may spend (budget.ts). */
  readonly budget: number;
}

/** The pending marker: a value the evaluator handles everywhere without stopping. */
export const PENDING: Result = EMPTY;

interface Pending {
  readonly key: CellKey;
  readonly id: ObjectId;
  readonly cell: string;
  readonly speculative: boolean;
}

interface Frame {
  readonly key: CellKey;
  readonly id: ObjectId;
  readonly cell: string;
  /** Tarjan discovery index. */
  readonly index: number;
  /** Tarjan low-link over definite edges. */
  low: number;
  /** Whether the edge from the frame below to this one is speculative. */
  readonly speculative: boolean;
  /** Read itself (a self-loop). */
  selfLoop: boolean;
  onCall: boolean;
  todo: readonly Pending[];
  next: number;
  result: Result;
  deps: readonly Dependency[];
}

type Outcome =
  | { kind: "done"; result: Result; deps: readonly Dependency[] }
  | { kind: "pending"; pending: readonly Pending[] }
  | { kind: "conflict"; unwind: Frame };

export function cycleError(id: ObjectId, cell: string): ErrorValue {
  return err("#CYCLE", `${id}.${cell} is in a dependency cycle`, { object: id, cell });
}

/**
 * Resolve the formula cell `id`.`cell` (which must exist and hold a formula)
 * and every uncomputed formula it needs, storing each result through `ctx`.
 * Returns the cell's result.
 */
export function resolve(ctx: ResolveContext, id: ObjectId, cell: string): Result {
  const target = cellKey(id, cell);
  /** Frames on the Tarjan stack (in progress or pending in an open component). */
  const states = new Map<CellKey, Frame>();
  const call: Frame[] = [];
  const tarjan: Frame[] = [];
  /** Cells abandoned after a speculative conflict: pushed only as definite from now on. */
  const deferred = new Set<CellKey>();
  let counter = 0;
  let speculativeOnCall = 0;

  const push = (key: CellKey, oid: ObjectId, ocell: string, speculative: boolean) => {
    const frame: Frame = {
      key,
      id: oid,
      cell: ocell,
      index: counter,
      low: counter,
      speculative,
      selfLoop: false,
      onCall: true,
      todo: [],
      next: 0,
      result: EMPTY,
      deps: [],
    };
    counter++;
    if (speculative) speculativeOnCall++;
    states.set(key, frame);
    call.push(frame);
    tarjan.push(frame);
  };

  const popCall = (): Frame => {
    const frame = call.pop() as Frame;
    frame.onCall = false;
    if (frame.speculative) speculativeOnCall--;
    return frame;
  };

  /** The topmost speculative frame on the call stack above discovery index `index`. */
  const speculativeAbove = (index: number): Frame | undefined => {
    if (speculativeOnCall === 0) return undefined;
    for (let i = call.length - 1; i >= 0; i--) {
      const f = call[i] as Frame;
      if (f.index <= index) return undefined;
      if (f.speculative) return f;
    }
    return undefined;
  };

  const attempt = (top: Frame): Outcome => {
    const content = ctx.host.cell(top.id, top.cell);
    let sawPending = false;
    let conflict: Frame | undefined;
    const pending: Pending[] = [];
    const collected = new Set<CellKey>();
    // A fresh env per attempt: dependencies and budget start from zero, so
    // only the final, complete attempt's charge decides the result.
    const env = createRecordingEnv({
      host: ctx.host,
      budget: ctx.budget,
      stats: ctx.stats,
      memoized: (key) => ctx.memoized(key),
      uncomputed(key, oid, ocell) {
        const open = states.get(key);
        if (open !== undefined) {
          // A cycle-closing read; definite only before the first pending marker.
          if (sawPending || conflict !== undefined) return PENDING;
          conflict = speculativeAbove(open.index);
          if (conflict !== undefined) return PENDING;
          top.low = Math.min(top.low, open.index);
          if (open === top) top.selfLoop = true;
          return cycleError(open.id, open.cell);
        }
        if (!collected.has(key)) {
          collected.add(key);
          pending.push({ key, id: oid, cell: ocell, speculative: sawPending });
        }
        sawPending = true;
        return PENDING;
      },
    });
    const origin = { object: top.id, cell: top.cell };
    if (content === undefined || content.type !== "formula") {
      // Not reachable within one revision; read as engine.value would.
      const result =
        content === undefined
          ? err("#NAME", `no cell ${top.cell} on ${top.id}`, origin)
          : withBudget(
              () => validateRefs(content, env.exists),
              () => limitError(ctx.budget, origin),
            );
      return { kind: "done", result, deps: env.dependencies() };
    }
    const parsed = ctx.parse(content.source);
    if (!parsed.ok) {
      return { kind: "done", result: err("#SYNTAX", parsed.message, origin), deps: [] };
    }

    ctx.stats.attempts++;
    const scope = { thisId: top.id, cell: top.cell };
    // Exceeding the budget stops the attempt where it is. The pending cells
    // collected so far are kept (the first is definite, so retries progress);
    // with none, every read so far was final and the final attempt would
    // stop at the same point: the result is #LIMIT.
    const result = withBudget(
      () =>
        ctx.registry === undefined
          ? evaluate(parsed.ast, scope, env)
          : evaluate(parsed.ast, scope, env, ctx.registry),
      () => limitError(ctx.budget, origin),
    );
    if (conflict !== undefined) return { kind: "conflict", unwind: conflict };
    if (pending.length > 0) return { kind: "pending", pending };
    return { kind: "done", result, deps: env.dependencies() };
  };

  const finish = (top: Frame, result: Result, deps: readonly Dependency[]) => {
    ctx.stats.evaluations++;
    top.result = result;
    top.deps = deps;
    popCall();
    if (top.low === top.index) {
      const members: Frame[] = [];
      let m: Frame;
      do {
        m = tarjan.pop() as Frame;
        members.push(m);
      } while (m !== top);
      const cyclic = members.length > 1 || top.selfLoop;
      for (const f of members) {
        states.delete(f.key);
        ctx.store(f.key, cyclic ? cycleError(f.id, f.cell) : f.result, f.deps);
      }
    }
    const parent = call[call.length - 1];
    if (parent !== undefined) parent.low = Math.min(parent.low, top.low);
  };

  /** Abandon speculative frame `s` and everything above it. */
  const unwind = (s: Frame) => {
    let f: Frame;
    do f = popCall();
    while (f !== s);
    while (tarjan.length > 0 && (tarjan[tarjan.length - 1] as Frame).index >= s.index) {
      states.delete((tarjan.pop() as Frame).key);
    }
    deferred.add(s.key);
  };

  push(target, id, cell, false);
  while (call.length > 0) {
    const top = call[call.length - 1] as Frame;
    if (top.next < top.todo.length) {
      const p = top.todo[top.next++] as Pending;
      if (ctx.memoized(p.key) !== undefined || states.has(p.key)) continue;
      if (p.speculative && deferred.has(p.key)) continue;
      push(p.key, p.id, p.cell, p.speculative);
      continue;
    }
    const outcome = attempt(top);
    switch (outcome.kind) {
      case "done":
        finish(top, outcome.result, outcome.deps);
        break;
      case "pending":
        top.todo = outcome.pending;
        top.next = 0;
        break;
      case "conflict":
        unwind(outcome.unwind);
        break;
    }
  }
  const result = ctx.memoized(target);
  if (result === undefined) throw new Error(`resolve: ${target} was not stored`);
  return result;
}
