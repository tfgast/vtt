// @vitest-environment node
/**
 * Action list operations (vtt-1xv.19; DESIGN.md §4.5; FORMULAS.md §8.4;
 * PROTOCOL.md §5 `set_actions`): parse checks of `when` and steps, the
 * client-side mirror of `setActions`' refusals, and the pure list edits
 * that each become one `set_actions`.
 */
import type { ObjectView } from "@vtt/protocol";
import type { ActionDef } from "@vtt/schema";
import {
  actionNameProblem,
  actionOfDraft,
  actionsProblem,
  draftOf,
  draftProblems,
  editableActions,
  MAX_ACTION_NAME_LENGTH,
  moveAction,
  newActionName,
  removeAction,
  renameAction,
  sameActions,
  saveAction,
  setActionsOps,
  stepProblem,
  whenProblem,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const ROLL: ActionDef = { name: "Roll", when: "roll = empty", steps: ["roll(1d20) -> roll"] };
const RESET: ActionDef = { name: "Reset", steps: ["set(roll, empty)"] };
const APPLY: ActionDef = { name: "Apply", steps: ["add(target.hp, -dmg)", "set(applied, true)"] };
const LIST: ActionDef[] = [ROLL, RESET, APPLY];

function view(actions: ObjectView["actions"]): ObjectView {
  return { id: "card", actions, cells: {} } as unknown as ObjectView;
}

describe("parse checks", () => {
  test("a when that parses, and an empty when (no precondition), have no problem", () => {
    expect(whenProblem("hit and not applied")).toBeNull();
    expect(whenProblem("")).toBeNull();
    expect(whenProblem("   ")).toBeNull();
  });

  test("a when that does not parse gives the parser's message and offset", () => {
    const problem = whenProblem("hit and");
    expect(problem).not.toBeNull();
    expect(problem?.message).toMatch(/./);
    expect(problem?.offset).toBeGreaterThanOrEqual(4);
  });

  test("steps go through the step parser: valid steps pass, others carry message and offset", () => {
    expect(stepProblem("roll(1d20) -> roll")).toBeNull();
    expect(stepProblem("each(targets, roll(1d20) -> it.save_roll)")).toBeNull();
    const bad = stepProblem("roll(1d20)");
    expect(bad?.message).toMatch(/->/);
    const unknown = stepProblem("frobnicate(x)");
    expect(unknown?.offset).toBe(0);
    const late = stepProblem("set(hp, 1 +)");
    expect(late?.offset).toBeGreaterThan(4);
  });

  test("a blank step is a problem", () => {
    expect(stepProblem("  ")).toEqual({ message: "A step may not be blank.", offset: 0 });
  });
});

describe("names", () => {
  test("1 to 100 characters, counted as code points", () => {
    expect(actionNameProblem("", [])).toMatch(/name/i);
    expect(actionNameProblem("x".repeat(MAX_ACTION_NAME_LENGTH), [])).toBeNull();
    expect(actionNameProblem("x".repeat(MAX_ACTION_NAME_LENGTH + 1), [])).toMatch(/100/);
    expect(actionNameProblem("🎲".repeat(MAX_ACTION_NAME_LENGTH), [])).toBeNull();
  });

  test("unique by exact comparison", () => {
    expect(actionNameProblem("Roll", ["Roll", "Reset"])).toMatch(/already/);
    expect(actionNameProblem("roll", ["Roll"])).toBeNull();
    expect(actionNameProblem("Roll ", ["Roll"])).toBeNull();
  });

  test("a new name not taken", () => {
    expect(newActionName([])).toBe("New action");
    expect(newActionName(["New action", "New action 2"])).toBe("New action 3");
  });
});

describe("views and drafts", () => {
  test("a GM view's actions are editable; a character view's (names only) are not", () => {
    expect(editableActions(view(LIST))).toEqual(LIST);
    expect(editableActions(view([{ name: "Roll" }]))).toBeNull();
    expect(editableActions(view([]))).toEqual([]);
  });

  test("a draft round-trips; an empty when drops the precondition", () => {
    expect(actionOfDraft(draftOf(ROLL))).toEqual(ROLL);
    expect(draftOf(RESET)).toEqual({ name: "Reset", when: "", steps: ["set(roll, empty)"] });
    expect(actionOfDraft({ name: "A", when: "  ", steps: [] })).toEqual({ name: "A", steps: [] });
  });

  test("draft problems: the name against the other actions, the when, each step", () => {
    const problems = draftProblems(
      { name: "Reset", when: "hit and", steps: ["set(a, 1)", "roll(1d20)", ""] },
      ["Roll", "Reset", "Apply"],
      "Roll",
    );
    expect(problems.name).toMatch(/already/);
    expect(problems.when).not.toBeNull();
    expect(problems.steps[0]).toBeNull();
    expect(problems.steps[1]).not.toBeNull();
    expect(problems.steps[2]?.message).toBe("A step may not be blank.");
    expect(problems.ok).toBe(false);
    // Its own name is not a duplicate.
    const own = draftProblems(draftOf(ROLL), ["Roll", "Reset"], "Roll");
    expect(own).toEqual({ ok: true, name: null, when: null, steps: [null] });
  });
});

describe("list edits", () => {
  test("save replaces the original in place, or appends a new action", () => {
    const next = { name: "Roll it", steps: ["roll(1d6) -> roll"] };
    expect(saveAction(LIST, "Roll", next)).toEqual({ ok: true, actions: [next, RESET, APPLY] });
    expect(saveAction(LIST, null, next)).toEqual({ ok: true, actions: [...LIST, next] });
    // The original is gone (renamed or deleted elsewhere): the draft is appended.
    expect(saveAction([RESET], "Roll", next)).toEqual({ ok: true, actions: [RESET, next] });
  });

  test("save refuses a duplicate name", () => {
    const result = saveAction(LIST, "Roll", { name: "Apply", steps: [] });
    expect(result.ok).toBe(false);
  });

  test("remove, rename and move", () => {
    expect(removeAction(LIST, "Reset")).toEqual({ ok: true, actions: [ROLL, APPLY] });
    expect(removeAction(LIST, "Nope").ok).toBe(false);
    expect(renameAction(LIST, "Reset", "Clear")).toEqual({
      ok: true,
      actions: [ROLL, { ...RESET, name: "Clear" }, APPLY],
    });
    expect(renameAction(LIST, "Reset", "Roll").ok).toBe(false);
    expect(renameAction(LIST, "Reset", "").ok).toBe(false);
    expect(moveAction(LIST, "Apply", -1)).toEqual({ ok: true, actions: [ROLL, APPLY, RESET] });
    expect(moveAction(LIST, "Roll", 1)).toEqual({ ok: true, actions: [RESET, ROLL, APPLY] });
    expect(moveAction(LIST, "Roll", -1).ok).toBe(false);
    expect(moveAction(LIST, "Apply", 1).ok).toBe(false);
  });

  test("inputs are never mutated", () => {
    const list = structuredClone(LIST);
    saveAction(list, "Roll", { name: "X", steps: [] });
    removeAction(list, "Roll");
    renameAction(list, "Roll", "Y");
    moveAction(list, "Roll", 1);
    expect(list).toEqual(LIST);
  });

  test("actionsProblem mirrors setActions' refusals", () => {
    expect(actionsProblem(LIST)).toBeNull();
    expect(actionsProblem([ROLL, ROLL])).toMatch(/two actions named "Roll"/);
    expect(actionsProblem([{ name: "", steps: [] }])).toMatch(/name/i);
    expect(actionsProblem([{ name: "A", when: " ", steps: [] }])).toMatch(/blank/);
    expect(actionsProblem([{ name: "A", steps: ["set(a, 1)", " "] }])).toMatch(/blank/);
  });

  test("sameActions compares names, preconditions and steps in order", () => {
    expect(sameActions(LIST, structuredClone(LIST))).toBe(true);
    expect(sameActions(LIST, [RESET, ROLL, APPLY])).toBe(false);
    expect(sameActions([ROLL], [{ ...ROLL, when: "true" }])).toBe(false);
    expect(sameActions([RESET], [{ ...RESET, when: "true" }])).toBe(false);
    expect(sameActions([APPLY], [{ ...APPLY, steps: ["set(applied, true)"] }])).toBe(false);
  });

  test("setActionsOps is one set_actions with the whole list", () => {
    expect(setActionsOps("card", [ROLL])).toEqual([
      { type: "set_actions", object: "card", actions: [ROLL] },
    ]);
  });
});
