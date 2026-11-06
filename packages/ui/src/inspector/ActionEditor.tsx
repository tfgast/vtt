/**
 * The inspector's action editor (vtt-1xv.19; DESIGN.md §4.5 "the inspector
 * shows an action's steps and precondition and lets the GM edit them,
 * exactly as it does for formulas", §4.6 The inspector; FORMULAS.md §8.4).
 *
 * Edits one action as a draft: its name, its `when` (empty: no
 * precondition) and one input per step, with steps added, removed and
 * reordered. Every field is parse-checked as it is typed (`parse` for
 * `when`, `parseStep` for steps), showing the parser's message and a caret
 * under the offset; the name is checked against the object's other actions.
 * Save is disabled while any field has a problem. The editor is controlled
 * (the owner holds the draft, so it survives the list changing under it)
 * and writes nothing itself: `onSave` receives the action and the owner
 * writes it (`ActionsList`, which closes the editor once the write commits
 * and keeps it, text and all, otherwise).
 *
 * Guard preview (vtt-qf5.31; M5 plan section 5): given a `preview`, a `when`
 * that parses is evaluated ad hoc on the object (`preview.evaluate`, the GM's
 * `evaluate` with `this`) after a short debounce, and its value is shown
 * beside the field (`formatValue` full, with its tone). Each request is keyed
 * by the object, the revision and the text, and each run of the request
 * effect is cancelled when the key changes or the editor closes: only the
 * latest run's answer applies, so a stale answer is dropped (also when the
 * text returns to an earlier key). A shown value
 * stays while only the revision advances (until the new answer) and is
 * hidden as soon as the text differs. Empty text, a parse problem, a failed
 * request or no `preview` show nothing.
 */
import type { WireResult } from "@vtt/protocol";
import type { ActionDef, ObjectId } from "@vtt/schema";
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { formatValue, type RefLabel } from "../values/format";
import { type ActionDraft, actionOfDraft, draftProblems, type SourceProblem } from "./action-ops";
import { TONE_COLORS } from "./CellRow";

/** Milliseconds of typing quiet before a guard preview is requested. */
export const GUARD_PREVIEW_DELAY_MS = 150;

/** What the action editor needs to preview its `when` (GM only). */
export interface GuardPreview {
  /** The object the action belongs to (`this`). */
  object: ObjectId;
  /** The revision the views stand at; a new one asks again. */
  revision: number;
  /** Evaluates `source` with `this` = `object` (the GM's `evaluate`). */
  evaluate(source: string, object: ObjectId): Promise<WireResult>;
  refLabel: RefLabel;
  /** Debounce; default `GUARD_PREVIEW_DELAY_MS`. */
  delayMs?: number;
}

interface PreviewAnswer {
  readonly key: string;
  readonly object: ObjectId;
  readonly source: string;
  readonly value: WireResult;
}

/**
 * The current value of `source` per `preview`, or null (nothing to show).
 * `active` false (empty text, a parse problem) asks nothing.
 */
function useGuardPreview(
  preview: GuardPreview | undefined,
  source: string,
  active: boolean,
): WireResult | null {
  const [answer, setAnswer] = useState<PreviewAnswer | null>(null);
  const evaluate = useRef(preview?.evaluate);
  evaluate.current = preview?.evaluate;
  const object = preview?.object;
  const revision = preview?.revision;
  const delay = preview?.delayMs ?? GUARD_PREVIEW_DELAY_MS;
  const key =
    object !== undefined && active && source.trim() !== ""
      ? JSON.stringify([object, revision, source])
      : null;

  useEffect(() => {
    if (key === null || object === undefined) return;
    // This run's own cancellation: a superseded run's answer never applies,
    // even when a later run has the same key (A → B → A).
    let cancelled = false;
    const timer = setTimeout(() => {
      const run = evaluate.current;
      if (run === undefined) return;
      run(source, object).then(
        (value) => {
          if (!cancelled) setAnswer({ key, object, source, value });
        },
        () => {
          if (!cancelled) setAnswer(null);
        },
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, object, source, delay]);

  if (key === null || answer === null) return null;
  if (answer.object !== object || answer.source !== source) return null;
  return answer.value;
}

export interface ActionEditorProps {
  /** The draft shown. */
  draft: ActionDraft;
  /** Called with every change of the draft. */
  onChange(draft: ActionDraft): void;
  /** The name of the action being edited, or null for a new action. */
  original: string | null;
  /** The names of the object's actions now (the draft may keep `original`). */
  names: readonly string[];
  /** A save is in flight: Save is disabled. */
  saving?: boolean;
  /** Called by Save with the action, only when the draft has no problem. */
  onSave(action: ActionDef): void;
  onCancel(): void;
  /** Previews the `when`'s value beside the field (the GM's editor); none: no preview. */
  preview?: GuardPreview;
}

const EDITOR_STYLE: CSSProperties = {
  margin: 0,
  border: "1px solid rgba(127, 127, 127, 0.4)",
  borderRadius: 4,
  padding: "0.5em",
  display: "grid",
  gap: "0.4em",
};
const ROW_STYLE: CSSProperties = { display: "flex", gap: "0.25em", alignItems: "center" };
const INPUT_STYLE: CSSProperties = { fontFamily: "monospace", flex: 1, minWidth: 0 };
const ERROR_STYLE: CSSProperties = { color: "#b3261e", fontSize: "0.85em" };
const CARET_STYLE: CSSProperties = { margin: 0, fontSize: "0.85em", whiteSpace: "pre" };
const LIST_STYLE: CSSProperties = { margin: 0, padding: 0, display: "grid", gap: "0.25em" };
const VALUE_STYLE: CSSProperties = { fontSize: "0.85em", whiteSpace: "pre-wrap" };

/** A parse problem: the message, then the source with a caret under the offset. */
function Problem({ id, source, problem }: { id: string; source: string; problem: SourceProblem }) {
  const offset = Math.max(0, Math.min(problem.offset, source.length));
  return (
    <div id={id} role="alert" style={ERROR_STYLE}>
      <div>{problem.message}</div>
      {source.trim() !== "" && (
        <pre aria-hidden="true" data-caret={offset} style={CARET_STYLE}>
          {source}
          {"\n"}
          {`${" ".repeat(offset)}^`}
        </pre>
      )}
    </div>
  );
}

export function ActionEditor({
  draft,
  onChange,
  original,
  names,
  saving = false,
  onSave,
  onCancel,
  preview,
}: ActionEditorProps) {
  const id = useId();
  const setDraft = (f: (d: ActionDraft) => ActionDraft) => onChange(f(draft));
  const problems = draftProblems(draft, names, original);
  const whenValue = useGuardPreview(preview, draft.when, problems.when === null);
  const whenFormatted =
    whenValue === null || preview === undefined
      ? null
      : formatValue(whenValue, { mode: "full", refLabel: preview.refLabel });

  const patch = (next: Partial<ActionDraft>) => setDraft((d) => ({ ...d, ...next }));
  const setStep = (i: number, source: string) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? source : s)) }));
  const removeStep = (i: number) =>
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }));
  const moveStep = (i: number, delta: -1 | 1) =>
    setDraft((d) => {
      const to = i + delta;
      if (to < 0 || to >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[to]] = [steps[to] as string, steps[i] as string];
      return { ...d, steps };
    });
  const addStep = () => setDraft((d) => ({ ...d, steps: [...d.steps, ""] }));

  const save = () => {
    if (saving || !problems.ok) return;
    onSave(actionOfDraft(draft));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  const nameError = `${id}-name-error`;
  const whenError = `${id}-when-error`;
  const title = original === null ? "New action" : `Edit ${original}`;
  return (
    <fieldset aria-label={title} style={EDITOR_STYLE} onKeyDown={onKeyDown}>
      <label style={ROW_STYLE}>
        <span>Name</span>
        <input
          aria-label="Action name"
          value={draft.name}
          aria-invalid={problems.name !== null}
          {...(problems.name === null ? {} : { "aria-describedby": nameError })}
          onChange={(e) => patch({ name: e.target.value })}
          style={{ flex: 1, minWidth: 0 }}
        />
      </label>
      {problems.name !== null && (
        <div id={nameError} role="alert" style={ERROR_STYLE}>
          {problems.name}
        </div>
      )}
      <label style={ROW_STYLE}>
        <span>when</span>
        <input
          aria-label="Condition (when)"
          placeholder="always"
          value={draft.when}
          aria-invalid={problems.when !== null}
          {...(problems.when === null ? {} : { "aria-describedby": whenError })}
          onChange={(e) => patch({ when: e.target.value })}
          style={INPUT_STYLE}
        />
        {whenFormatted !== null && (
          <output
            aria-label="Condition value"
            data-tone={whenFormatted.tone}
            style={{ ...VALUE_STYLE, color: TONE_COLORS[whenFormatted.tone] }}
          >
            {whenFormatted.text}
          </output>
        )}
      </label>
      {problems.when !== null && (
        <Problem id={whenError} source={draft.when} problem={problems.when} />
      )}
      <div>Steps</div>
      <ol style={LIST_STYLE}>
        {draft.steps.map((step, i) => {
          const problem = problems.steps[i] ?? null;
          const errorId = `${id}-step-${i}-error`;
          const n = i + 1;
          return (
            // Steps have no identity but their position.
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional source lines
            <li key={i} style={{ listStyle: "none" }}>
              <div style={ROW_STYLE}>
                <span>{n}.</span>
                <input
                  aria-label={`Step ${n}`}
                  value={step}
                  aria-invalid={problem !== null}
                  {...(problem === null ? {} : { "aria-describedby": errorId })}
                  onChange={(e) => setStep(i, e.target.value)}
                  style={INPUT_STYLE}
                />
                <button
                  type="button"
                  aria-label={`Move step ${n} up`}
                  disabled={i === 0}
                  onClick={() => moveStep(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move step ${n} down`}
                  disabled={i === draft.steps.length - 1}
                  onClick={() => moveStep(i, 1)}
                >
                  ↓
                </button>
                <button type="button" aria-label={`Remove step ${n}`} onClick={() => removeStep(i)}>
                  ✕
                </button>
              </div>
              {problem !== null && <Problem id={errorId} source={step} problem={problem} />}
            </li>
          );
        })}
      </ol>
      <div style={ROW_STYLE}>
        <button type="button" onClick={addStep}>
          Add step
        </button>
      </div>
      <div style={ROW_STYLE}>
        <button type="button" disabled={saving || !problems.ok} onClick={save}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}
