/**
 * The scenario runner over the protocol (vtt-5su.12, vtt-1xv.13; FIXTURES.md
 * §1–§8, §11; DESIGN.md §5.2): the scenario's setup in an in-memory host
 * behind a real server on port 0, driven by one GM `ProtocolClient`. It
 * follows the direct runner (test/runner/run.ts) step for step: setup
 * expectations, then every step (`invoke` included) and its expectations
 * (`action` and `face_element` included), the same rejection protocol
 * (FIXTURES §6) with the refusal mapped through `toFixtureReason` (the
 * action refusals `when_false`, `when_error`, `step_error` included; a
 * refused step must consume no dice), the same leftover-dice check, and the
 * same failure messages (ScenarioFailure / ScenarioError naming the
 * scenario, the step and the expectation). After setup and after every
 * step, `onStep` receives the `document` result's snapshot (step -1 for
 * setup); at the end, `onEnd` receives the final `document` result.
 *
 * The server, the client and the host are closed when the run ends, passing
 * or failing.
 */
import { canonicalJson, ScenarioError } from "@vtt/authority";
import type { Expectation, RejectionReason, Scenario } from "@vtt/fixtures";
import type { DocumentResult, ProtocolRejection } from "@vtt/protocol";
import { type Rejection, toFixtureReason } from "@vtt/schema";
import { ScenarioFailure } from "../runner/expect";
import { describeRejection, type RunReport, reasonMatches, type StepReport } from "../runner/run";
import { checkWireExpectation } from "./expect";
import { openSession, type ProtocolSession } from "./session";
import { newProtocolRunState, type ProtocolRunState, refreshDocument } from "./state";
import { applyWireStep, type WireStepOutcome } from "./steps";

export { ScenarioFailure } from "../runner/expect";
export type { RunReport, StepReport } from "../runner/run";
export { closeAllSessions, openSession, type ProtocolSession } from "./session";

export interface ProtocolRunOptions {
  /** Called after setup and after every executed step (refused ones included) with a copy of the document. */
  onStep?: (report: StepReport) => void;
  /** Called once the session is open, before setup expectations; it is closed when the run ends. */
  onSession?: (session: ProtocolSession) => void;
  /** Called once after the last step with a copy of the final `document` result (snapshot and log). */
  onEnd?: (doc: DocumentResult) => void;
}

/** Awaits `fn`, prefixing any error with `where`, keeping its class. */
async function within<T>(where: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const message = `${where}: ${err.message}`;
    if (err instanceof ScenarioFailure) throw new ScenarioFailure(message);
    if (err instanceof ScenarioError) throw new ScenarioError(message);
    throw new Error(message, { cause: err });
  }
}

const SCHEMA_REJECTIONS: ReadonlySet<string> = new Set([
  "protected_cell",
  "containment_cycle",
  "undo_conflict",
  "nothing_to_undo",
  "type_error",
  "invalid",
  "when_false",
  "when_error",
  "step_error",
]);

/** The schema rejection a protocol rejection is, or null for the protocol's own (`stale_write`, `undo_target_changed`, …). */
const asSchemaRejection = (r: ProtocolRejection): Rejection | null =>
  SCHEMA_REJECTIONS.has(r.type) ? (r as Rejection) : null;

const fixtureReasonOf = (r: ProtocolRejection) => {
  const s = asSchemaRejection(r);
  return s === null ? null : toFixtureReason(s);
};

const describe = (r: ProtocolRejection): string =>
  describeRejection((asSchemaRejection(r) ?? { type: r.type, message: show(r) }) as Rejection);

const show = (x: unknown): string => JSON.stringify(x);

const matches = (want: RejectionReason, got: ProtocolRejection): boolean => {
  const s = asSchemaRejection(got);
  return s !== null && reasonMatches(want, s);
};

interface Before {
  snapshot: string;
  nextIndex: number;
  dice: number;
}

const before = (state: ProtocolRunState): Before => ({
  snapshot: canonicalJson(state.doc.snapshot),
  nextIndex: state.doc.log.first_index + state.doc.log.groups.length,
  dice: state.session.dice.remaining(),
});

/** The rejection protocol for one step; `state.doc` is the document after it. */
function checkRejection(
  state: ProtocolRunState,
  where: string,
  list: readonly Expectation[],
  outcome: WireStepOutcome,
  prior: Before,
): void {
  const index = list.findIndex((e) => e.type === "rejected");
  const predicted = list[index];
  if (outcome.type === "refused") {
    if (fixtureReasonOf(outcome.rejection) === null) {
      throw new ScenarioError(
        `${where}: the table refused the step as ${describe(outcome.rejection)}, which is no rejection reason of the format`,
      );
    }
    if (predicted?.type !== "rejected") {
      throw new ScenarioFailure(
        `${where}, expect rejected (absent): the step was refused: ${describe(outcome.rejection)}`,
      );
    }
    const label = `${where}, expect #${index} (rejected)`;
    if (!matches(predicted.reason, outcome.rejection)) {
      throw new ScenarioFailure(
        `${label}: expected ${show(predicted.reason)}, got ${describe(outcome.rejection)}`,
      );
    }
    const after = before(state);
    if (after.snapshot !== prior.snapshot || after.nextIndex !== prior.nextIndex) {
      throw new ScenarioFailure(`${label}: the refused step changed the document or the log`);
    }
    if (after.dice !== prior.dice) {
      throw new ScenarioFailure(`${label}: the refused step consumed dice script entries`);
    }
  } else if (predicted !== undefined) {
    throw new ScenarioFailure(
      `${where}, expect #${index} (rejected): expected ${show(predicted.type === "rejected" ? predicted.reason : null)}, but the step was not refused`,
    );
  }
}

/** Checks `list` except `rejected`, counting skipped expectations by type. */
async function checkList(
  state: ProtocolRunState,
  where: string,
  list: readonly Expectation[],
  skipped: Record<string, number>,
): Promise<void> {
  for (const [i, e] of list.entries()) {
    if (e.type === "rejected") {
      if (where.endsWith("setup")) {
        throw new ScenarioError(`${where}, expect #${i} (rejected): only a step can be rejected`);
      }
      continue;
    }
    const ran = await within(`${where}, expect #${i} (${e.type})`, () =>
      checkWireExpectation(state, e),
    );
    if (!ran) skipped[e.type] = (skipped[e.type] ?? 0) + 1;
  }
}

/** Runs `scenario` over the protocol; see the module comment. */
export async function runScenarioOverProtocol(
  scenario: Scenario,
  options: ProtocolRunOptions = {},
): Promise<RunReport> {
  const title = JSON.stringify(scenario.title);
  const session = await within(`${title}: setup`, () => openSession(scenario));
  try {
    options.onSession?.(session);
    const state = await within(`${title}: setup`, () => newProtocolRunState(scenario, session));
    const observe = (step: number) =>
      options.onStep?.({ step, snapshot: structuredClone(state.doc.snapshot) });
    const skipped: Record<string, number> = {};

    await checkList(state, `${title}: setup`, scenario.expect ?? [], skipped);
    observe(-1);

    let stepsRun = 0;
    for (const [i, step] of scenario.steps.entries()) {
      const where = `${title}: step ${i}`;
      const list = step.expect ?? [];
      const prior = before(state);
      const outcome = await within(`${where} (${step.do.type})`, () => applyWireStep(state, step));
      await refreshDocument(state);
      checkRejection(state, where, list, outcome, prior);
      await checkList(state, where, list, skipped);
      stepsRun++;
      observe(i);
    }

    const complete = stepsRun === scenario.steps.length;
    const left = session.dice.remaining();
    if (complete && left > 0) {
      throw new ScenarioError(
        `${title}: after ${stepsRun === 0 ? "setup" : `step ${stepsRun - 1}`}, expect dice script exhausted: ${left} scripted dice ${left === 1 ? "entry" : "entries"} unused`,
      );
    }
    options.onEnd?.(structuredClone(state.doc));
    return {
      title: scenario.title,
      complete,
      stepsRun,
      stepsTotal: scenario.steps.length,
      skipped,
    };
  } finally {
    await session.close();
  }
}
