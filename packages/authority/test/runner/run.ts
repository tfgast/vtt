/**
 * The direct scenario runner (FIXTURES.md §1–§8, §11; DESIGN.md §7;
 * vtt-75c.13, vtt-1xv.10). Builds the setup document, checks the top-level
 * expectations, then runs every step in order, checking each step's
 * expectations. Every step type and expectation is supported (M5 added
 * `invoke`, `action` and `face_element`), so a run that returns is
 * complete, with nothing skipped, and its dice script must be used up.
 *
 * Rejection protocol (FIXTURES §5, §6): a refused step appends no group
 * and consumes no dice; a `rejected` expectation predicts it with the
 * reason `toFixtureReason` maps; an unpredicted refusal, a predicted one that does not happen, or a
 * refusal the format has no reason for (`invalid`) fails.
 *
 * Failures throw: ScenarioFailure when an expectation does not hold,
 * ScenarioError when the scenario is wrong (FIXTURES §5, §6). Both name the
 * scenario, the step (or `setup`, or `after step N` for leftover dice) and the expectation.
 *
 * Round-trip mode: after setup and after every step, `serializeTable` →
 * `canonicalJson` → `parseTable`, asserting the snapshot and the log are
 * unchanged, and the run continues on the loaded table.
 */
import { canonicalJson, parseTable, ScenarioError, serializeTable, Table } from "@vtt/authority";
import type { Expectation, RejectionReason, Scenario } from "@vtt/fixtures";
import { type Rejection, type Snapshot, toFixtureReason } from "@vtt/schema";
import { checkExpectation, ScenarioFailure } from "./expect";
import { applyStep, newRunState, type RunState, type StepOutcome } from "./steps";

export { ScenarioFailure } from "./expect";

export interface RunReport {
  title: string;
  /** Every step ran (always, since M5: no step type is skipped). */
  complete: boolean;
  stepsRun: number;
  stepsTotal: number;
  /** Skipped expectations by type (always empty since M5). */
  skipped: Record<string, number>;
}

/** What `onStep` observes: `step` -1 after setup, then each executed step's index. */
export interface StepReport {
  step: number;
  snapshot: Snapshot;
}

export interface RunOptions {
  /** Serialize and reload the table after setup and after every step. */
  roundTrip?: boolean;
  /**
   * Called after setup and after every executed step (refused ones
   * included) with a copy of `table.store.toSnapshot()`; in round-trip
   * mode, of the reloaded table. Its return value is ignored.
   */
  onStep?: (report: StepReport) => void;
}

/** Runs `fn`, prefixing any error with `where`, keeping its class. */
function at<T>(where: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const message = `${where}: ${err.message}`;
    if (err instanceof ScenarioFailure) throw new ScenarioFailure(message);
    if (err instanceof ScenarioError) throw new ScenarioError(message);
    throw new Error(message, { cause: err });
  }
}

/** Serializes and reloads the table, asserting nothing was lost. */
function hop(state: RunState): void {
  const store = state.table.store;
  const text = canonicalJson(serializeTable(store, []));
  const loaded = parseTable(text);
  if (loaded.warnings.length > 0) {
    throw new ScenarioFailure(`round trip: load warnings ${JSON.stringify(loaded.warnings)}`);
  }
  const before = canonicalJson(store.toSnapshot());
  const after = canonicalJson(loaded.store.toSnapshot());
  if (before !== after) throw new ScenarioFailure("round trip: the snapshot changed");
  const logBefore = canonicalJson(store.history.toLog());
  const logAfter = canonicalJson(loaded.store.history.toLog());
  if (logBefore !== logAfter) throw new ScenarioFailure("round trip: the log changed");
  state.table = Table.fromStore(loaded.store);
}

/**
 * Whether the table's refusal is the predicted reason: the same type, the
 * same code for `when_error`, and for `step_error` the same code when the
 * prediction names one (FIXTURES §7: the code is optional there).
 */
export const reasonMatches = (want: RejectionReason, got: Rejection): boolean => {
  const mapped = toFixtureReason(got);
  if (mapped === null || mapped.type !== want.type) return false;
  if (want.type === "when_error") {
    return mapped.type === "when_error" && mapped.code === want.code;
  }
  if (want.type === "step_error" && want.code !== undefined) {
    return mapped.type === "step_error" && mapped.code === want.code;
  }
  return true;
};

export const describeRejection = (r: Rejection): string =>
  "message" in r ? `${r.type} (${r.message})` : r.type;

/**
 * The rejection protocol for one step. `before` is the document and the
 * next group index just before it.
 */
function checkRejection(
  state: RunState,
  where: string,
  list: readonly Expectation[],
  outcome: StepOutcome,
  before: { snapshot: string; nextIndex: number; dice: number },
): void {
  const index = list.findIndex((e) => e.type === "rejected");
  const predicted = list[index];
  if (outcome.type === "refused") {
    if (toFixtureReason(outcome.rejection) === null) {
      throw new ScenarioError(
        `${where}: the table refused the step as ${describeRejection(outcome.rejection)}, which is no rejection reason of the format`,
      );
    }
    if (predicted?.type !== "rejected") {
      throw new ScenarioFailure(
        `${where}, expect rejected (absent): the step was refused: ${describeRejection(outcome.rejection)}`,
      );
    }
    const label = `${where}, expect #${index} (rejected)`;
    if (!reasonMatches(predicted.reason, outcome.rejection)) {
      throw new ScenarioFailure(
        `${label}: expected ${JSON.stringify(predicted.reason)}, got ${describeRejection(outcome.rejection)}`,
      );
    }
    const store = state.table.store;
    if (
      canonicalJson(store.toSnapshot()) !== before.snapshot ||
      store.history.nextIndex !== before.nextIndex
    ) {
      throw new ScenarioFailure(`${label}: the refused step changed the document or the log`);
    }
    if (state.dice.remaining() !== before.dice) {
      throw new ScenarioFailure(`${label}: the refused step consumed dice script entries`);
    }
  } else if (predicted !== undefined) {
    throw new ScenarioFailure(
      `${where}, expect #${index} (rejected): expected ${JSON.stringify(predicted.type === "rejected" ? predicted.reason : null)}, but the step was not refused`,
    );
  }
}

/** Checks `list` except `rejected`, counting skipped expectations by type. */
function checkList(
  state: RunState,
  where: string,
  list: readonly Expectation[],
  skipped: Record<string, number>,
): void {
  list.forEach((e, i) => {
    if (e.type === "rejected") {
      if (where.endsWith("setup")) {
        throw new ScenarioError(`${where}, expect #${i} (rejected): only a step can be rejected`);
      }
      return;
    }
    const ran = at(`${where}, expect #${i} (${e.type})`, () => checkExpectation(state, e));
    if (!ran) skipped[e.type] = (skipped[e.type] ?? 0) + 1;
  });
}

/** Runs `scenario`; see the module comment. */
export function runScenario(scenario: Scenario, options: RunOptions = {}): RunReport {
  const title = JSON.stringify(scenario.title);
  const observe = (step: number) =>
    options.onStep?.({ step, snapshot: state.table.store.toSnapshot() });
  const skipped: Record<string, number> = {};

  const state = at(`${title}: setup`, () => newRunState(scenario));
  if (options.roundTrip) at(`${title}: setup (round trip)`, () => hop(state));
  checkList(state, `${title}: setup`, scenario.expect ?? [], skipped);
  observe(-1);

  let stepsRun = 0;
  for (const [i, step] of scenario.steps.entries()) {
    const where = `${title}: step ${i}`;
    const list = step.expect ?? [];
    const store = state.table.store;
    const before = {
      snapshot: canonicalJson(store.toSnapshot()),
      nextIndex: store.history.nextIndex,
      dice: state.dice.remaining(),
    };
    const outcome = at(`${where} (${step.do.type})`, () => applyStep(state, step));
    checkRejection(state, where, list, outcome, before);
    if (options.roundTrip) at(`${where} (round trip)`, () => hop(state));
    checkList(state, where, list, skipped);
    stepsRun++;
    observe(i);
  }

  const complete = stepsRun === scenario.steps.length;
  const left = state.dice.remaining();
  if (complete && left > 0) {
    throw new ScenarioError(
      `${title}: after ${stepsRun === 0 ? "setup" : `step ${stepsRun - 1}`}: ${left} scripted dice ${left === 1 ? "entry" : "entries"} unused`,
    );
  }
  return { title: scenario.title, complete, stepsRun, stepsTotal: scenario.steps.length, skipped };
}
