/**
 * The M1 fixture scenario runner (docs/FIXTURES.md §1, §6, §7): builds a
 * MemoryHost from a scenario's setup and an engine over it, applies the
 * plain content and placement steps (`set`, `override`, `clear_override`,
 * `move`) as host writes whose Changes go to `engine.invalidate`, and checks
 * `cell` and `cell_error` expectations against `engine.value`.
 *
 * Everything else is skipped and reported: the first `invoke`, `spawn`,
 * `undo`, or `bind` step stops the walk (its expectations and every later
 * step's are skipped), and every other expectation type is skipped by type.
 * A step the host refuses (a broken scenario) throws.
 */
import type { Expectation, Value as FixtureValue, Scenario, Step } from "@vtt/fixtures";
import { createEngine, type Engine } from "@vtt/formula";
import type { Result, ViewerEntry } from "@vtt/schema";
import { fromFixtureValue } from "./fixture-values";
import { MemoryHost } from "./memory-host";

/** `setup#i` for the top-level expectations, `step N#i` for step N's. */
export type Location = string;

/** `checked` lists every evaluated `cell`/`cell_error` location, pass or fail; `failures` the mismatches among them. */
export interface Report {
  title: string;
  checked: Location[];
  skipped: { location: Location; reason: string }[];
  failures: { location: Location; expected: unknown; actual: Result }[];
}

const APPLIED = new Set(["set", "override", "clear_override", "move"]);

export function runFormulaScenario(scenario: Scenario): Report {
  const report: Report = { title: scenario.title, checked: [], skipped: [], failures: [] };
  const host = MemoryHost.fromSetup(scenario.setup);
  const engine = createEngine(host);

  checkAll(engine, scenario.expect ?? [], "setup", report);
  let stopped: string | null = null;
  scenario.steps.forEach((step, n) => {
    const list = step.expect ?? [];
    if (stopped === null && !APPLIED.has(step.do.type)) {
      stopped = `after unsupported step ${n} (${step.do.type})`;
    }
    if (stopped !== null) {
      for (let i = 0; i < list.length; i++) {
        report.skipped.push({ location: `step ${n}#${i}`, reason: stopped });
      }
      return;
    }
    engine.invalidate(apply(host, step.do));
    checkAll(engine, list, `step ${n}`, report);
  });
  return report;
}

function apply(host: MemoryHost, d: Step["do"]) {
  switch (d.type) {
    case "set":
      return host.set(d.object, d.cell, fromFixtureValue(d.value));
    case "override":
      return host.override(d.object, d.cell, fromFixtureValue(d.value));
    case "clear_override":
      return host.clearOverride(d.object, d.cell);
    case "move":
      return host.move(d.object, d.to);
    default:
      throw new Error(`runner: step ${d.type} is not applied`);
  }
}

function checkAll(engine: Engine, list: readonly Expectation[], where: string, report: Report) {
  list.forEach((e, i) => {
    const location = `${where}#${i}`;
    if (e.type === "cell") {
      const actual = engine.value(e.object, e.cell);
      report.checked.push(location);
      if (!fixtureValueEquals(e.value, actual)) {
        report.failures.push({ location, expected: e.value, actual });
      }
    } else if (e.type === "cell_error") {
      const actual = engine.value(e.object, e.cell);
      report.checked.push(location);
      if (actual.type !== "error" || actual.code !== e.code) {
        report.failures.push({ location, expected: { type: "error", code: e.code }, actual });
      }
    } else {
      report.skipped.push({ location, reason: `type ${(e as { type: string }).type}` });
    }
  });
}

const viewerKey = (v: ViewerEntry): string => (typeof v === "string" ? v : `@${v.object}`);

const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Fixture equality (FIXTURES §7), stricter than the language's `=`: the
 * kinds must match (a number never equals a roll result), numbers compare
 * exactly, roll results on every field, lists elementwise and recursively,
 * refs by object, viewer sets as sets. Dice compare by notation as written.
 */
export function fixtureValueEquals(expected: FixtureValue, actual: Result): boolean {
  const e = fromFixtureValue(expected);
  if (e.type !== actual.type) return false;
  switch (e.type) {
    case "empty":
      return true;
    case "number":
    case "text":
    case "boolean":
      return e.value === (actual as typeof e).value;
    case "ref":
      return e.object === (actual as typeof e).object;
    case "dice":
      return e.expr === (actual as typeof e).expr;
    case "roll": {
      const a = actual as typeof e;
      return (
        e.expr === a.expr &&
        e.total === a.total &&
        sameNumbers(e.dice, a.dice) &&
        sameNumbers(e.dropped, a.dropped)
      );
    }
    case "viewers": {
      const ek = new Set(e.viewers.map(viewerKey));
      const ak = new Set((actual as typeof e).viewers.map(viewerKey));
      return ek.size === ak.size && [...ek].every((k) => ak.has(k));
    }
    case "list": {
      const a = actual as typeof e;
      return (
        e.items.length === a.items.length &&
        e.items.every((item, i) => fixtureValueEquals(item as FixtureValue, a.items[i] as Result))
      );
    }
    case "ink":
      return JSON.stringify(e.strokes) === JSON.stringify((actual as typeof e).strokes);
    default:
      return false;
  }
}
