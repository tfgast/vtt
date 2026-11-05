/**
 * Action list operations for the inspector (vtt-1xv.19; DESIGN.md §4.5, §4.6
 * The inspector; FORMULAS.md §8.4; PROTOCOL.md §5 `set_actions`). Pure.
 *
 * - `whenProblem` and `stepProblem` parse-check source as it is typed
 *   (`@vtt/formula`'s `parse` and `parseStep`), giving the parser's message
 *   and the offset of the problem.
 * - `actionNameProblem` and `actionsProblem` mirror the refusals of the
 *   authority's `setActions`: names of 1 to 100 characters (code points),
 *   unique on the object by exact comparison, non-blank `when` and steps.
 * - The list edits (`saveAction`, `removeAction`, `renameAction`,
 *   `moveAction`) return a new whole list or why not; `setActionsOps` turns
 *   a list into the one `set_actions` op that replaces it. Inputs are never
 *   mutated.
 */
import { parse, parseStep } from "@vtt/formula";
import type { ObjectView, WireOp } from "@vtt/protocol";
import type { ActionDef, ObjectId } from "@vtt/schema";

/** The longest action name, in code points (the authority's limit). */
export const MAX_ACTION_NAME_LENGTH = 100;

/** Why some source does not parse, and where. */
export interface SourceProblem {
  readonly message: string;
  /** The 0-based offset in the source where the problem starts. */
  readonly offset: number;
}

/** A new whole action list, or why the edit is refused. */
export type ActionsResult =
  | { readonly ok: true; readonly actions: ActionDef[] }
  | { readonly ok: false; readonly message: string };

/** An action as the editor holds it: `when` empty means no precondition. */
export interface ActionDraft {
  name: string;
  when: string;
  steps: string[];
}

/** A draft's problems, field by field (`ok` when there are none). */
export interface DraftProblems {
  readonly ok: boolean;
  readonly name: string | null;
  readonly when: SourceProblem | null;
  readonly steps: (SourceProblem | null)[];
}

const BLANK_STEP: SourceProblem = { message: "A step may not be blank.", offset: 0 };

// ---------------------------------------------------------------------------
// Checks

/** Why `source` cannot be a `when`, or null (empty is fine: no precondition). */
export function whenProblem(source: string): SourceProblem | null {
  if (source.trim() === "") return null;
  const parsed = parse(source);
  return parsed.ok ? null : { message: parsed.message, offset: parsed.offset };
}

/** Why `source` is not a step (FORMULAS.md §8.4), or null. */
export function stepProblem(source: string): SourceProblem | null {
  if (source.trim() === "") return BLANK_STEP;
  const parsed = parseStep(source);
  return parsed.ok ? null : { message: parsed.message, offset: parsed.offset };
}

/** Why `name` cannot name an action beside `taken` (the object's other names), or null. */
export function actionNameProblem(name: string, taken: readonly string[]): string | null {
  if (name === "") return "An action needs a name.";
  if ([...name].length > MAX_ACTION_NAME_LENGTH) {
    return `An action name is at most ${MAX_ACTION_NAME_LENGTH} characters.`;
  }
  if (taken.includes(name)) return `An action named "${name}" already exists.`;
  return null;
}

/** Why the authority would refuse `actions` (its `setActions` checks), or null. */
export function actionsProblem(actions: readonly ActionDef[]): string | null {
  const seen = new Set<string>();
  for (const a of actions) {
    if (a.name === "") return "An action needs a name.";
    if ([...a.name].length > MAX_ACTION_NAME_LENGTH) {
      return `An action name is at most ${MAX_ACTION_NAME_LENGTH} characters.`;
    }
    if (seen.has(a.name)) return `There would be two actions named "${a.name}".`;
    seen.add(a.name);
    if (a.when !== undefined && a.when.trim() === "") return `"${a.name}" has a blank condition.`;
    if (a.steps.some((s) => s.trim() === "")) return `"${a.name}" has a blank step.`;
  }
  return null;
}

/** A new action name not in `taken`: "New action", else "New action 2", 3, …. */
export function newActionName(taken: readonly string[]): string {
  const base = "New action";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.includes(name)) return name;
  }
}

// ---------------------------------------------------------------------------
// Views and drafts

/**
 * The stored actions carried by `view`, or null when it does not carry
 * them all (a character's view has names only and cannot be edited from).
 */
export function editableActions(view: ObjectView): ActionDef[] | null {
  const out: ActionDef[] = [];
  for (const a of view.actions) {
    if (a.steps === undefined) return null;
    out.push(
      a.when === undefined
        ? { name: a.name, steps: [...a.steps] }
        : {
            name: a.name,
            when: a.when,
            steps: [...a.steps],
          },
    );
  }
  return out;
}

/** The draft of `action`. */
export function draftOf(action: ActionDef): ActionDraft {
  return { name: action.name, when: action.when ?? "", steps: [...action.steps] };
}

/** The action a draft saves as: a blank `when` is no precondition; steps verbatim. */
export function actionOfDraft(draft: ActionDraft): ActionDef {
  const steps = [...draft.steps];
  return draft.when.trim() === ""
    ? { name: draft.name, steps }
    : { name: draft.name, when: draft.when, steps };
}

/**
 * The problems of `draft` on an object whose actions are named `names`;
 * `original` is the name of the action being edited (null for a new one),
 * which the draft may keep.
 */
export function draftProblems(
  draft: ActionDraft,
  names: readonly string[],
  original: string | null,
): DraftProblems {
  const name = actionNameProblem(
    draft.name,
    names.filter((n) => n !== original),
  );
  const when = whenProblem(draft.when);
  const steps = draft.steps.map(stepProblem);
  return {
    ok: name === null && when === null && steps.every((s) => s === null),
    name,
    when,
    steps,
  };
}

// ---------------------------------------------------------------------------
// List edits

function checked(actions: ActionDef[]): ActionsResult {
  const problem = actionsProblem(actions);
  return problem === null ? { ok: true, actions } : { ok: false, message: problem };
}

function indexOf(actions: readonly ActionDef[], name: string): number {
  return actions.findIndex((a) => a.name === name);
}

/**
 * `actions` with the action named `original` replaced by `next`, in place;
 * `next` appended when `original` is null (a new action) or no longer there.
 */
export function saveAction(
  actions: readonly ActionDef[],
  original: string | null,
  next: ActionDef,
): ActionsResult {
  const at = original === null ? -1 : indexOf(actions, original);
  const out = [...actions];
  if (at < 0) out.push(next);
  else out[at] = next;
  return checked(out);
}

/** `actions` without the action named `name`. */
export function removeAction(actions: readonly ActionDef[], name: string): ActionsResult {
  const at = indexOf(actions, name);
  if (at < 0) return { ok: false, message: `There is no action named "${name}".` };
  return checked(actions.filter((_, i) => i !== at));
}

/** `actions` with the action named `from` renamed `to`. */
export function renameAction(
  actions: readonly ActionDef[],
  from: string,
  to: string,
): ActionsResult {
  const at = indexOf(actions, from);
  if (at < 0) return { ok: false, message: `There is no action named "${from}".` };
  const problem = actionNameProblem(
    to,
    actions.filter((_, i) => i !== at).map((a) => a.name),
  );
  if (problem !== null) return { ok: false, message: problem };
  return checked(actions.map((a, i) => (i === at ? { ...a, name: to } : a)));
}

/** `actions` with the action named `name` moved one place up (-1) or down (1). */
export function moveAction(
  actions: readonly ActionDef[],
  name: string,
  delta: -1 | 1,
): ActionsResult {
  const at = indexOf(actions, name);
  if (at < 0) return { ok: false, message: `There is no action named "${name}".` };
  const to = at + delta;
  if (to < 0 || to >= actions.length) {
    return { ok: false, message: `"${name}" cannot move ${delta < 0 ? "up" : "down"}.` };
  }
  const out = [...actions];
  [out[at], out[to]] = [out[to] as ActionDef, out[at] as ActionDef];
  return checked(out);
}

/** Whether two lists define the same actions in the same order. */
export function sameActions(a: readonly ActionDef[], b: readonly ActionDef[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i] as ActionDef;
      return (
        x.name === y.name &&
        x.when === y.when &&
        x.steps.length === y.steps.length &&
        x.steps.every((s, j) => s === y.steps[j])
      );
    })
  );
}

/** The one `set_actions` op replacing `object`'s whole action list. */
export function setActionsOps(object: ObjectId, actions: readonly ActionDef[]): WireOp[] {
  return [
    { type: "set_actions", object, actions: actions.map((a) => ({ ...a, steps: [...a.steps] })) },
  ];
}
