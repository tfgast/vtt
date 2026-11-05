/**
 * Expectations over the protocol (vtt-5su.12; FIXTURES.md §7, §8, §11).
 * Each is read from the server the way PROTOCOL.md exposes it:
 *
 * - `cell`, `cell_error`, `override`: the GM view (`get_objects`).
 * - `exists`: `get_objects` `missing`.
 * - `container`, `contents`, `placement`: the structural cells (`contents`,
 *   `container`, `board`, `position`) of GM views.
 * - `object_visible`: present in `get_objects` with that viewer.
 * - `cell_visible`: the viewer's view holds the cell (`cells` has the key),
 *   whatever its value, so a readable cell holding a redacted ref is visible.
 * - `log_groups`: the retained groups `log` pages through.
 * - `log_includes`: the GM `EffectView`s of `explain_group`.
 * - `replay`: `document`'s log replayed over the setup snapshot, compared
 *   with the stored state.
 * - `action` (vtt-1xv.13): `explain_action`'s `enabled`; the action must be
 *   in the GM view's `actions`.
 * - `face_element` (vtt-1xv.13; PROTOCOL.md §7.2): the viewer's
 *   `get_objects` face view, finding the element by its stored `index` in
 *   the named list: shown exactly when present with `shown: true`; absent,
 *   or the object absent from the viewer's result, is not shown. Live views
 *   compute `shown` with `faceElementVisible`, the predicate the direct
 *   runner checks, so the runners agree. The GM view (every stored element)
 *   decides the scenario errors: no layout, an index past the stored list.
 *
 * Messages and errors follow test/runner/expect.ts: ScenarioFailure when an
 * expectation does not hold, ScenarioError when the scenario uses it wrongly.
 * `rejected` belongs to the rejection protocol. Nothing is skipped.
 */
import { diffStoredState, replay, ScenarioError, storedStateEqual } from "@vtt/authority";
import type { Expectation, LogEffect } from "@vtt/fixtures";
import type { CellStateView, EffectView, FaceView, GroupView } from "@vtt/protocol";
import { ProtocolFailure } from "@vtt/protocol";
import type { OpGroup, Value } from "@vtt/schema";
import { fixtureValueEquals, ScenarioFailure } from "../runner/expect";
import {
  cellValue,
  liveObject,
  type ProtocolRunState,
  refIds,
  resolveName,
  resolveValue,
  toViewer,
  viewOf,
} from "./state";

const show = (x: unknown): string => JSON.stringify(x);

function holds(ok: boolean, message: () => string): void {
  if (!ok) throw new ScenarioFailure(message());
}

/** Every retained group, oldest first, paging `log` (newest first) to the start. */
async function retainedGroups(state: ProtocolRunState): Promise<GroupView[]> {
  const limit = state.client.limits?.max_page ?? 50;
  const newestFirst: GroupView[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await state.client.request("log", {
      limit,
      ...(before === undefined ? {} : { before }),
    });
    newestFirst.push(...page.groups);
    const oldest = page.groups.at(-1);
    if (oldest === undefined || oldest.index <= page.first_index) break;
    before = oldest.index;
  }
  return newestFirst.reverse();
}

/** The value a cell write resolved to: the override, else a literal content. */
function writtenValue(after: CellStateView | null): Value | undefined {
  if (after === null) return undefined;
  if (after.kind === "literal") return after.value as Value;
  return after.override as Value | undefined;
}

function effectMatches(state: ProtocolRunState, want: LogEffect, e: EffectView): boolean {
  if (e.type !== "cell") return false;
  if (want.type === "roll" && e.cause !== "roll") return false;
  if (e.object !== resolveName(state, want.object) || e.cell !== want.cell) return false;
  const written = writtenValue(e.after);
  return written !== undefined && fixtureValueEquals(resolveValue(state, want.value), written);
}

/** A face view's `full` (`elements`) or `collapsed` list. */
const faceList = (face: FaceView | undefined, list: "full" | "collapsed") =>
  face === undefined ? [] : list === "full" ? face.elements : (face.collapsed ?? []);

/** Checks one expectation other than `rejected`. Resolves false when it is skipped (none is). */
export async function checkWireExpectation(
  state: ProtocolRunState,
  e: Expectation,
): Promise<boolean> {
  switch (e.type) {
    case "action": {
      const { id, view } = await liveObject(state, e.object);
      const def = view.actions.find((a) => a.name === e.action);
      if (def === undefined) throw new ScenarioError(`${e.object} has no action "${e.action}"`);
      const explained = await state.client.request("explain_action", {
        object: id,
        action: e.action,
      });
      const got = explained.enabled;
      const guard = explained.guard;
      holds(
        got === e.enabled,
        () =>
          `${e.object}[${e.action}]: expected enabled ${e.enabled}, got ${got}${guard === undefined ? " (no guard)" : ` (guard ${guard.source ?? def.when} is ${show(guard.value)})`}`,
      );
      return true;
    }
    case "face_element": {
      const { id, view } = await liveObject(state, e.object);
      const list = e.list ?? "full";
      const viewer = e.viewer ?? "gm";
      const where = `${e.object} face ${list}[${e.element}]`;
      if (view.face === undefined) throw new ScenarioError(`${e.object} has no face layout`);
      const stored = faceList(view.face, list);
      if (e.element >= stored.length) {
        throw new ScenarioError(`${where}: the stored list has ${stored.length} elements`);
      }
      const seen = await viewOf(state, id, toViewer(state, viewer));
      const element = faceList(seen?.face, list).find((x) => x.index === e.element);
      const got = element?.shown === true;
      holds(got === e.shown, () => `${where} for ${viewer}: expected shown ${e.shown}, got ${got}`);
      return true;
    }
    case "rejected":
      throw new Error("checkWireExpectation: rejected belongs to the rejection protocol");
    case "cell": {
      const { view } = await liveObject(state, e.object);
      const want = resolveValue(state, e.value);
      const got = cellValue(view, e.cell);
      holds(
        fixtureValueEquals(want, got),
        () => `${e.object}.${e.cell}: expected ${show(want)}, got ${show(got)}`,
      );
      return true;
    }
    case "cell_error": {
      const { view } = await liveObject(state, e.object);
      const got = cellValue(view, e.cell);
      holds(
        got.type === "error" && got.code === e.code,
        () => `${e.object}.${e.cell}: expected ${e.code}, got ${show(got)}`,
      );
      return true;
    }
    case "override": {
      const { view } = await liveObject(state, e.object);
      const got = view.cells[e.cell]?.overridden === true;
      holds(
        got === e.overridden,
        () => `${e.object}.${e.cell}: expected overridden ${e.overridden}, got ${got}`,
      );
      return true;
    }
    case "exists": {
      const id = resolveName(state, e.object);
      const result = await state.client.request("get_objects", { ids: [id] });
      const got = !result.missing.includes(id);
      holds(got === e.exists, () => `${e.object}: expected exists ${e.exists}, got ${got}`);
      return true;
    }
    case "container": {
      const { id } = await liveObject(state, e.object);
      const { view } = await liveObject(state, e.container);
      const contents = refIds(cellValue(view, "contents"));
      const own = await viewOf(state, id);
      const inside = own === undefined ? undefined : cellValue(own, "container");
      const where = inside?.type === "ref" ? inside.object : null;
      holds(
        contents.indexOf(id) === e.index,
        () =>
          `${e.object}: expected at index ${e.index} of ${e.container}, whose contents are ${show(contents)} (it is in ${show(where)})`,
      );
      return true;
    }
    case "placement": {
      const { view } = await liveObject(state, e.object);
      const board = resolveName(state, e.board);
      const boardCell = cellValue(view, "board");
      const onBoard = boardCell.type === "ref" ? boardCell.object : null;
      const position = cellValue(view, "position");
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
      const { view } = await liveObject(state, e.object);
      const want = e.contents.map((name) => resolveName(state, name));
      const got = refIds(cellValue(view, "contents"));
      holds(
        want.length === got.length && want.every((x, i) => x === got[i]),
        () => `${e.object}: expected contents ${show(want)}, got ${show(got)}`,
      );
      return true;
    }
    case "cell_visible": {
      const { id } = await liveObject(state, e.object);
      const seen = await viewOf(state, id, toViewer(state, e.viewer));
      const got = seen !== undefined && Object.hasOwn(seen.cells, e.cell);
      holds(
        got === e.visible,
        () => `${e.object}.${e.cell} for ${e.viewer}: expected visible ${e.visible}, got ${got}`,
      );
      return true;
    }
    case "object_visible": {
      const { id } = await liveObject(state, e.object);
      const got = (await viewOf(state, id, toViewer(state, e.viewer))) !== undefined;
      holds(
        got === e.visible,
        () => `${e.object} for ${e.viewer}: expected visible ${e.visible}, got ${got}`,
      );
      return true;
    }
    case "log_groups": {
      const got = (await retainedGroups(state)).length;
      holds(got === e.count, () => `expected ${e.count} log groups, got ${got}`);
      return true;
    }
    case "log_includes": {
      await liveObject(state, e.effect.object);
      const groups = await retainedGroups(state);
      const header = e.group < 0 ? groups.at(e.group) : groups.find((g) => g.index === e.group);
      if (header === undefined) {
        throw new ScenarioFailure(`no log group ${e.group} (the log holds ${groups.length})`);
      }
      let group: GroupView;
      try {
        group = (await state.client.request("explain_group", { index: header.index })).group;
      } catch (err) {
        if (err instanceof ProtocolFailure && err.error.code === "not_found") {
          throw new ScenarioFailure(`no log group ${e.group} (explain_group: not found)`);
        }
        throw err;
      }
      const effects = group.effects ?? [];
      holds(
        effects.some((x) => effectMatches(state, e.effect, x)),
        () =>
          `group ${group.index} "${group.label}" does not record ${show(e.effect)}; its cell effects: ${show(effects.filter((x) => x.type === "cell"))}`,
      );
      return true;
    }
    case "replay": {
      const before = state.session.dice.remaining();
      const { snapshot, log } = await state.client.request("document", {});
      const replayed = replay(state.setup, log.groups as readonly OpGroup[]);
      const ok = storedStateEqual(replayed, snapshot);
      holds(
        ok,
        () =>
          `replay differs from the stored state: ${diffStoredState(replayed, snapshot).join("; ")}`,
      );
      const after = state.session.dice.remaining();
      holds(after === before, () => `replay consumed ${before - after} dice script entries`);
      return true;
    }
  }
  throw new ScenarioError(`unknown expectation type ${show((e as { type: unknown }).type)}`);
}
