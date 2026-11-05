/**
 * Expectations (FIXTURES.md §7, §8, §11; vtt-75c.13). Each check returns
 * normally when it holds, throws ScenarioFailure when it does not, and
 * throws ScenarioError when the scenario uses it wrongly (an unknown name,
 * an expectation other than `exists` on a removed object). `action` is
 * skipped (M5); `rejected` is the rejection protocol's, in run.ts.
 */

import { diffStoredState, replay, ScenarioError } from "@vtt/authority";
import type { Expectation, LogEffect } from "@vtt/fixtures";
import type { CellState, Effect, Result, Value, ViewerEntry } from "@vtt/schema";
import { liveObject, type RunState, resolveName, resolveValue } from "./steps";

/** An expectation that does not hold, or a rejection protocol violation. */
export class ScenarioFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

const show = (x: unknown): string => JSON.stringify(x);

const viewerKey = (v: ViewerEntry): string => (typeof v === "string" ? v : `@${v.object}`);
const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Fixture equality (FIXTURES.md §7), stricter than the language's `=`: the
 * kinds must match (a number never equals a roll result), numbers compare
 * exactly, roll results on every field, lists elementwise, refs by object,
 * viewer sets as sets, dice by notation as written. Restated from
 * packages/formula/test/support/runner.ts, which authority tests cannot
 * import (vtt-qf5.2); `expected` has its names already resolved.
 */
export function fixtureValueEquals(expected: Value, actual: Result): boolean {
  if (expected.type !== actual.type) return false;
  const a = actual as typeof expected;
  switch (expected.type) {
    case "empty":
      return true;
    case "number":
    case "text":
    case "boolean":
      return expected.value === (a as typeof expected).value;
    case "ref":
      return expected.object === (a as typeof expected).object;
    case "dice":
      return expected.expr === (a as typeof expected).expr;
    case "roll": {
      const r = a as typeof expected;
      return (
        expected.expr === r.expr &&
        expected.total === r.total &&
        sameNumbers(expected.dice, r.dice) &&
        sameNumbers(expected.dropped, r.dropped)
      );
    }
    case "viewers": {
      const ek = new Set(expected.viewers.map(viewerKey));
      const ak = new Set((a as typeof expected).viewers.map(viewerKey));
      return ek.size === ak.size && [...ek].every((k) => ak.has(k));
    }
    case "list": {
      const l = a as typeof expected;
      return (
        expected.items.length === l.items.length &&
        expected.items.every((item, i) => fixtureValueEquals(item, l.items[i] as Result))
      );
    }
    case "ink":
      return show(expected.strokes) === show((a as typeof expected).strokes);
    default:
      return false;
  }
}

function holds(ok: boolean, message: () => string): void {
  if (!ok) throw new ScenarioFailure(message());
}

const viewerOf = (state: RunState, name: string) =>
  name === "gm"
    ? ({ type: "gm" } as const)
    : { type: "character" as const, id: resolveName(state, name) };

/** The value a cell write resolved to: the override, else a literal content. */
function writtenValue(after: CellState): Value | undefined {
  if (after === null) return undefined;
  if (after.override !== undefined) return after.override;
  return after.content.type === "formula" ? undefined : after.content;
}

function effectMatches(state: RunState, want: LogEffect, e: Effect): boolean {
  if (e.type !== "cell") return false;
  if (want.type === "roll" && e.cause !== "roll") return false;
  if (e.object !== resolveName(state, want.object) || e.cell !== want.cell) return false;
  const written = writtenValue(e.after);
  return written !== undefined && fixtureValueEquals(resolveValue(state, want.value), written);
}

/** Checks one expectation other than `rejected`. Returns false when it is skipped. */
export function checkExpectation(state: RunState, e: Expectation): boolean {
  const { table } = state;
  const { store } = table;
  switch (e.type) {
    case "action":
      return false;
    case "rejected":
      throw new Error("checkExpectation: rejected belongs to the rejection protocol");
    case "cell": {
      const obj = liveObject(state, e.object);
      const want = resolveValue(state, e.value);
      const got = table.value(obj, e.cell);
      holds(
        fixtureValueEquals(want, got),
        () => `${e.object}.${e.cell}: expected ${show(want)}, got ${show(got)}`,
      );
      return true;
    }
    case "cell_error": {
      const obj = liveObject(state, e.object);
      const got = table.value(obj, e.cell);
      holds(
        got.type === "error" && got.code === e.code,
        () => `${e.object}.${e.cell}: expected ${e.code}, got ${show(got)}`,
      );
      return true;
    }
    case "override": {
      const obj = liveObject(state, e.object);
      const got = table.isOverridden(obj, e.cell);
      holds(
        got === e.overridden,
        () => `${e.object}.${e.cell}: expected overridden ${e.overridden}, got ${got}`,
      );
      return true;
    }
    case "exists": {
      const id = resolveName(state, e.object);
      const got = store.hasObject(id);
      holds(got === e.exists, () => `${e.object}: expected exists ${e.exists}, got ${got}`);
      return true;
    }
    case "container": {
      const obj = liveObject(state, e.object);
      const container = liveObject(state, e.container);
      const contents = store.contentsOf(container);
      holds(
        contents.indexOf(obj) === e.index,
        () =>
          `${e.object}: expected at index ${e.index} of ${e.container}, whose contents are ${show(contents)} (it is in ${show(store.containerOf(obj))})`,
      );
      return true;
    }
    case "placement": {
      const obj = liveObject(state, e.object);
      const board = resolveName(state, e.board);
      const onBoard = store.boardOf(obj);
      const position = table.value(obj, "position");
      const at =
        position.type === "list" &&
        position.items.length === 2 &&
        position.items.every((p, i) => p.type === "number" && p.value === e.position[i]);
      holds(
        onBoard === board && at,
        () =>
          `${e.object}: expected on ${e.board} at ${show(e.position)}, got board ${show(onBoard)} position ${show(position)}`,
      );
      return true;
    }
    case "contents": {
      const obj = liveObject(state, e.object);
      const want = e.contents.map((name) => resolveName(state, name));
      const got = store.contentsOf(obj);
      holds(
        sameIds(want, got),
        () => `${e.object}: expected contents ${show(want)}, got ${show(got)}`,
      );
      return true;
    }
    case "cell_visible": {
      const obj = liveObject(state, e.object);
      const got = table.visibility.canSeeCell(viewerOf(state, e.viewer), obj, e.cell);
      holds(
        got === e.visible,
        () => `${e.object}.${e.cell} for ${e.viewer}: expected visible ${e.visible}, got ${got}`,
      );
      return true;
    }
    case "object_visible": {
      const obj = liveObject(state, e.object);
      const got = table.visibility.canSeeObject(viewerOf(state, e.viewer), obj);
      holds(
        got === e.visible,
        () => `${e.object} for ${e.viewer}: expected visible ${e.visible}, got ${got}`,
      );
      return true;
    }
    case "log_groups": {
      const got = store.history.groups().length;
      holds(got === e.count, () => `expected ${e.count} log groups, got ${got}`);
      return true;
    }
    case "log_includes": {
      liveObject(state, e.effect.object);
      const groups = store.history.groups();
      const group = e.group < 0 ? groups.at(e.group) : store.history.get(e.group);
      if (group === undefined) {
        throw new ScenarioFailure(`no log group ${e.group} (the log holds ${groups.length})`);
      }
      const effects = group.effects as readonly Effect[];
      holds(
        effects.some((x) => effectMatches(state, e.effect, x)),
        () =>
          `group ${group.index} "${group.label}" does not record ${show(e.effect)}; its cell effects: ${show(effects.filter((x) => x.type === "cell"))}`,
      );
      return true;
    }
    case "replay": {
      const before = state.dice.remaining();
      const replayed = replay(state.setup, store.history.groups());
      const diffs = diffStoredState(replayed, store.toSnapshot());
      holds(diffs.length === 0, () => `replay differs from the stored state: ${diffs.join("; ")}`);
      const after = state.dice.remaining();
      holds(after === before, () => `replay consumed ${before - after} dice script entries`);
      return true;
    }
  }
  throw new ScenarioError(`unknown expectation type ${show((e as { type: unknown }).type)}`);
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
