/**
 * The inspector's actions (vtt-3l6.12, editing and Run vtt-1xv.19; DESIGN.md
 * §4.5, §4.6 The inspector and View as in the UI, §5.2; FORMULAS.md §8;
 * PROTOCOL.md §5 `set_actions`, §7.2 `action_states`; M5 plan Q3, Q13).
 *
 * - Every viewer sees each action's name and enabled state (`action_states`:
 *   `enabled`, `reason`). A character's view (view-as) shows only that: the
 *   inspector is read-only there.
 * - The GM also sees `when` and the steps (a step that does not parse is
 *   marked with the parser's message), and edits: "Edit" opens an
 *   `ActionEditor` capturing the base revision at the click, and Save writes
 *   one `set_actions` with the whole list (this action replaced), unless
 *   nothing changed; the editor closes once the write commits and keeps its
 *   text otherwise (a `stale_write` is the write port's sticky notice).
 *   "Add action" opens the editor for a new action, written by its Save.
 *   Delete, Rename (an inline field, base revision captured at the click),
 *   Move up and Move down are each one `set_actions`. Client-side checks
 *   (`action-ops`) mirror `setActions`' refusals and block the write.
 * - While the GM's editor is open, its `when` is previewed (vtt-qf5.31):
 *   evaluated ad hoc with `evaluate {source, this}` at the session's
 *   revision, its value shown beside the field (`ActionEditor`'s preview).
 * - "Run" (given a `runtime`) takes a stamp at the click and executes
 *   `requestInvoke(policy, view, action, stamp, {camera, views, directory})` through the
 *   runtime: the template refusal and the disabled-reason notice are the
 *   same single check as face buttons. It is drawn disabled (with the
 *   reason) when `policy.canInvoke` refuses or the action is not enabled;
 *   a click on it still goes through that check and sends nothing.
 *
 * Must be rendered inside a `TableProvider` (the inspector panel is one).
 */
import type { ActionStateView, ObjectView } from "@vtt/protocol";
import type { ActionDef, ObjectId } from "@vtt/schema";
import { type CSSProperties, type KeyboardEvent, useMemo, useRef, useState } from "react";
import { defaultFacePolicy, requestInvoke } from "../actions/invoke";
import type { FacePolicy } from "../face/face-contracts";
import type { InteractionStamp } from "../interaction/contracts";
import type { InteractionRuntime } from "../interaction/runtime";
import { useSession, useTableSession, useUiStore } from "../session/hooks";
import { sessionNotices } from "../session/writes";
import { ActionEditor, type GuardPreview } from "./ActionEditor";
import {
  type ActionDraft,
  type ActionsResult,
  actionNameProblem,
  actionOfDraft,
  draftOf,
  editableActions,
  moveAction,
  newActionName,
  removeAction,
  renameAction,
  sameActions,
  saveAction,
  setActionsOps,
  stepProblem,
} from "./action-ops";
import { inspectorRefLabel, useInspectorWrites } from "./CellRow";

export interface ActionsListProps {
  /** The current viewer's view of the object. */
  view: ObjectView;
  /** The GM's view: `when` and steps are shown and edited. */
  gm: boolean;
  /**
   * Whether the object's actions may be played from the UI (default
   * `defaultFacePolicy`: templates are not); the app passes the composed
   * binder policy, the same one its face buttons use.
   */
  policy?: FacePolicy;
  /** Executes Run's effects (the app's interaction runtime); without it there is no Run. */
  runtime?: Pick<InteractionRuntime, "execute">;
}

const LIST_STYLE: CSSProperties = { margin: 0, padding: 0 };
const ITEM_STYLE: CSSProperties = {
  listStyle: "none",
  padding: "4px 0",
  borderBottom: "1px solid rgba(127, 127, 127, 0.15)",
};
const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.25em",
};
const NOTE_STYLE: CSSProperties = { fontSize: "0.85em", opacity: 0.7 };
const ERROR_STYLE: CSSProperties = { color: "#b3261e", fontSize: "0.85em" };
const CODE_STYLE: CSSProperties = { fontFamily: "monospace", whiteSpace: "pre-wrap" };
const DISABLED_STYLE: CSSProperties = { opacity: 0.5, cursor: "not-allowed" };

/** Why an action is not enabled, in words (`reason` of `action_states`). */
function reasonText(state: ActionStateView): string {
  return state.reason === "when_error" ? "its condition is an error" : "its condition is false";
}

/** The words for an action's state (`action_states`), or null when the view carries none. */
export function actionStateText(state: ActionStateView | undefined): string | null {
  if (state === undefined) return null;
  return state.enabled ? "enabled" : `disabled: ${reasonText(state)}`;
}

/**
 * Why Run of `action` is drawn disabled, or null: the policy's refusal
 * (a template), else the action's state. The click still goes through
 * `requestInvoke`, whose notice is the authoritative wording.
 */
export function runBlockedReason(
  policy: FacePolicy,
  view: ObjectView,
  action: string,
): string | null {
  const allowed = policy.canInvoke(view);
  if (!allowed.ok) return allowed.reason;
  const state = (view.action_states ?? []).find((s) => s.name === action);
  if (state === undefined) return `${action} is not available.`;
  return state.enabled ? null : `${action}: ${reasonText(state)}.`;
}

/** Interaction ids of Run stamps (kept apart from the machine's `i<n>`). */
let runCounter = 0;
/** Identities of editing sessions: a write's completion only touches its own editor. */
let editCounter = 0;

function sameDraft(a: ActionDraft, b: ActionDraft): boolean {
  return (
    a.name === b.name &&
    a.when === b.when &&
    a.steps.length === b.steps.length &&
    a.steps.every((s, i) => s === b.steps[i])
  );
}

export function ActionsList(props: ActionsListProps) {
  // Keyed by role: an open editor or rename never survives a switch to view-as.
  return <ActionsBody key={props.gm ? "gm" : "character"} {...props} />;
}

/** What the GM has open: the editor (an action, or a new one) or a rename. */
type Open =
  | {
      kind: "edit";
      /** This editing session's identity (unique: never shared by a later editor). */
      id: number;
      original: string | null;
      /** What the editor started from (Save writes nothing while the draft equals it). */
      initial: ActionDraft;
      draft: ActionDraft;
      base: number;
      saving: boolean;
    }
  | { kind: "rename"; name: string; base: number };

function ActionsBody({ view, gm, policy = defaultFacePolicy, runtime }: ActionsListProps) {
  const session = useTableSession();
  const ui = useUiStore();
  const port = useInspectorWrites(session);
  const [open, setOpen] = useState<Open | null>(null);
  const object = view.id;
  const revision = useSession((s) => s.revision);
  const viewerIsGm = useSession((s) => s.viewer.type === "gm");
  const evaluate = useMemo(
    () => async (source: string, target: ObjectId) =>
      (await session.client.request("evaluate", { source, this: target })).value,
    [session],
  );
  const preview: GuardPreview | undefined =
    gm && viewerIsGm
      ? { object, revision, evaluate, refLabel: inspectorRefLabel(session) }
      : undefined;
  const editable = gm ? editableActions(view) : null;
  const states = new Map((view.action_states ?? []).map((s) => [s.name, s]));
  const names = view.actions.map((a) => a.name);

  const notice = (text: string) => sessionNotices(session).push({ level: "error", text });
  const now = () => session.getSnapshot().revision;
  const label = (verb: string) => `${verb} on ${inspectorRefLabel(session)(object) ?? object}`;

  /** The object's stored actions now (null: not the GM's view, or gone). */
  const current = (): ActionDef[] | null => {
    if (session.getSnapshot().viewer.type !== "gm") return null;
    const v = session.objectView(object);
    return v === null ? null : editableActions(v);
  };

  /**
   * Writes the list `edit` makes of the current one; resolves the revision
   * the actions now stand at when it committed (or nothing needed writing),
   * else null.
   */
  const write = async (
    edit: (actions: ActionDef[]) => ActionsResult,
    base: number,
    verb: string,
  ): Promise<number | null> => {
    const actions = current();
    if (actions === null) {
      notice("The actions were not changed: the object is not in the GM's view.");
      return null;
    }
    const result = edit(actions);
    if (!result.ok) {
      notice(`The actions were not changed: ${result.message}`);
      return null;
    }
    if (sameActions(actions, result.actions)) return base;
    const outcome = await port.write(setActionsOps(object, result.actions), {
      baseRevision: base,
      label: label(verb),
    });
    return outcome.status === "committed" ? outcome.revision : null;
  };

  const run = (action: string) => {
    if (runtime === undefined) return;
    const snapshot = session.getSnapshot();
    if (snapshot.activeBoard === null) {
      notice(`${action} was not run: no board is open.`);
      return;
    }
    const stamp: InteractionStamp = {
      interactionId: `inspector-run-${++runCounter}`,
      board: snapshot.activeBoard,
      viewer: snapshot.viewer,
      baseRevision: snapshot.revision,
    };
    const live = session.objectView(object) ?? view;
    runtime.execute(
      requestInvoke(policy, live, action, stamp, {
        camera: ui.getState().camera,
        views: (id) => session.objectView(id),
        directory: (id) => session.directory().get(id) ?? null,
      }),
    );
  };

  const startEdit = (action: ActionDef | null) => {
    const base = now();
    const initial: ActionDraft =
      action === null ? { name: newActionName(names), when: "", steps: [""] } : draftOf(action);
    setOpen({
      kind: "edit",
      id: ++editCounter,
      original: action?.name ?? null,
      initial,
      draft: { ...initial, steps: [...initial.steps] },
      base,
      saving: false,
    });
  };

  const setDraft = (draft: ActionDraft) =>
    setOpen((o) => (o?.kind === "edit" ? { ...o, draft } : o));

  const save = async (edit: Extract<Open, { kind: "edit" }>, action: ActionDef) => {
    if (edit.original !== null && sameActions([action], [actionOfDraft(edit.initial)])) {
      setOpen(null);
      return;
    }
    // The submission: this session's draft as Save sent it.
    const submitted: ActionDraft = { ...edit.draft, steps: [...edit.draft.steps] };
    const mine = (o: Open | null): o is Extract<Open, { kind: "edit" }> =>
      o?.kind === "edit" && o.id === edit.id;
    setOpen((o) => (mine(o) ? { ...o, saving: true } : o));
    const revision = await write(
      (actions) => saveAction(actions, edit.original, action),
      edit.base,
      edit.original === null ? `Add action ${action.name}` : `Edit action ${action.name}`,
    );
    setOpen((o) => {
      // Another editor (or none) is open now: it is not this write's to touch.
      if (!mine(o)) return o;
      // Not committed: keep the editor and its text.
      if (revision === null) return { ...o, saving: false };
      // Committed and unchanged since Save: done.
      if (sameDraft(o.draft, submitted)) return null;
      // Committed, but edited since Save: keep the newer text, now editing the
      // saved action from the revision it was saved at.
      return { ...o, original: action.name, initial: submitted, base: revision, saving: false };
    });
  };

  const editor = (edit: Extract<Open, { kind: "edit" }>) => (
    <ActionEditor
      draft={edit.draft}
      onChange={setDraft}
      original={edit.original}
      names={names}
      saving={edit.saving}
      onSave={(a) => void save(edit, a)}
      onCancel={() => setOpen(null)}
      {...(preview === undefined ? {} : { preview })}
    />
  );

  const editing = open?.kind === "edit" ? open : null;
  return (
    <section aria-label="Actions" style={{ marginTop: "0.75em" }}>
      <h4 style={{ margin: 0 }}>Actions</h4>
      {view.actions.length === 0 ? (
        <p style={NOTE_STYLE}>No actions</p>
      ) : (
        <ul style={LIST_STYLE}>
          {view.actions.map((action, i) => {
            const stored = editable?.[i];
            const stateText = actionStateText(states.get(action.name));
            if (editing !== null && editing.original === action.name) {
              return (
                <li key={action.name} data-action={action.name} style={ITEM_STYLE}>
                  {editor(editing)}
                </li>
              );
            }
            const blocked =
              gm && runtime !== undefined ? runBlockedReason(policy, view, action.name) : null;
            return (
              <li key={action.name} data-action={action.name} style={ITEM_STYLE}>
                <div style={ROW_STYLE}>
                  {open?.kind === "rename" && open.name === action.name ? (
                    <RenameField
                      name={action.name}
                      others={names.filter((n) => n !== action.name)}
                      onDone={(to) => {
                        const base = open.base;
                        setOpen(null);
                        if (to !== null && to !== action.name) {
                          void write(
                            (list) => renameAction(list, action.name, to),
                            base,
                            `Rename action ${action.name}`,
                          );
                        }
                      }}
                    />
                  ) : (
                    <span style={{ fontWeight: 600 }}>{action.name}</span>
                  )}
                  {stateText !== null && (
                    <span data-role="action-state" style={NOTE_STYLE}>
                      {stateText}
                    </span>
                  )}
                </div>
                {gm && action.when !== undefined && (
                  <div>
                    <span style={NOTE_STYLE}>when </span>
                    <code style={CODE_STYLE}>{action.when}</code>
                  </div>
                )}
                {gm && action.steps !== undefined && action.steps.length > 0 && (
                  <ol style={{ margin: 0 }}>
                    {action.steps.map((step, j) => {
                      const problem = stepProblem(step);
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity but their position
                        <li key={j}>
                          <code style={CODE_STYLE}>{step}</code>
                          {problem !== null && <span style={ERROR_STYLE}> {problem.message}</span>}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {gm && (
                  <div style={ROW_STYLE}>
                    {runtime !== undefined && (
                      <button
                        type="button"
                        aria-label={`Run ${action.name}`}
                        aria-disabled={blocked !== null}
                        title={blocked ?? undefined}
                        style={blocked === null ? undefined : DISABLED_STYLE}
                        onClick={() => run(action.name)}
                      >
                        Run
                      </button>
                    )}
                    {stored !== undefined && (
                      <>
                        <button
                          type="button"
                          aria-label={`Edit ${action.name}`}
                          onClick={() => startEdit(stored)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Rename ${action.name}`}
                          onClick={() =>
                            setOpen({ kind: "rename", name: action.name, base: now() })
                          }
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${action.name} up`}
                          disabled={i === 0}
                          onClick={() => {
                            const base = now();
                            void write(
                              (list) => moveAction(list, action.name, -1),
                              base,
                              `Move action ${action.name}`,
                            );
                          }}
                        >
                          Move up
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${action.name} down`}
                          disabled={i === view.actions.length - 1}
                          onClick={() => {
                            const base = now();
                            void write(
                              (list) => moveAction(list, action.name, 1),
                              base,
                              `Move action ${action.name}`,
                            );
                          }}
                        >
                          Move down
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${action.name}`}
                          onClick={() => {
                            const base = now();
                            void write(
                              (list) => removeAction(list, action.name),
                              base,
                              `Delete action ${action.name}`,
                            );
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {blocked !== null && <span style={NOTE_STYLE}>{blocked}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing !== null &&
        (editing.original === null || !names.includes(editing.original)) &&
        editor(editing)}
      {editable !== null && editing === null && (
        <button type="button" onClick={() => startEdit(null)}>
          Add action
        </button>
      )}
    </section>
  );
}

/** The inline rename field: Enter or blur commits (null: cancelled), Escape cancels. */
function RenameField({
  name,
  others,
  onDone,
}: {
  name: string;
  others: readonly string[];
  onDone(to: string | null): void;
}) {
  const [text, setText] = useState(name);
  const done = useRef(false);
  const problem = text === name ? null : actionNameProblem(text, others);
  const finish = (commit: boolean) => {
    if (done.current) return;
    if (commit && problem !== null) return;
    done.current = true;
    onDone(commit ? text : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };
  return (
    <span style={ROW_STYLE}>
      <input
        aria-label={`New name for ${name}`}
        value={text}
        aria-invalid={problem !== null}
        // biome-ignore lint/a11y/noAutofocus: the field opens on the user's Rename click
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(problem === null)}
      />
      {problem !== null && (
        <span role="alert" style={ERROR_STYLE}>
          {problem}
        </span>
      )}
    </span>
  );
}
