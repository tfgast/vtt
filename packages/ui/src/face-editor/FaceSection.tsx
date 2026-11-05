/**
 * The inspector's Face section (vtt-1xv.18; DESIGN.md §4.6 The inspector,
 * Face layouts, Face elements, Collapsed face, View as in the UI; §7 Undo;
 * PROTOCOL.md §5 `set_face`, §6; M5 plan Q8, Q9), for the one selected
 * object. Rendered in the inspector by vtt-1xv.23; it provides its own
 * `TableProvider`, so it can be mounted alone.
 *
 * - Tabs Full / Collapsed, each listing its elements with the kind (value ↔
 *   editor), the cell or action picker, `x y w h`, `show_when` (parse-checked
 *   as typed with `@vtt/formula`'s `parse`; empty clears), `min_size`, the
 *   style (cell elements), the entries mode (contents), Move up / Move down
 *   and Delete; Add value / editor / button / contents; the default action;
 *   "Create face" (`defaultLayoutFor`) when there is none and "Remove face"
 *   (`set_face null`).
 * - Every edit is one `set_face` write of the whole new layout, built from
 *   the current layout with `face-ops`. Text fields capture the base
 *   revision on focus and write on Enter or blur (unchanged input writes
 *   nothing; Escape cancels); buttons, pickers and checkboxes capture it at
 *   the click. An invalid result is an error notice and writes nothing.
 * - The GM edits. In view-as the section shows the character's view of the
 *   face read-only (no `show_when`, which character views do not carry).
 *   A change of viewer, board or selected object drops pending drafts
 *   (reverting their text and forgetting their base revision), and no write
 *   is ever sent while the viewer is not the GM.
 */
import { parse } from "@vtt/formula";
import type { ObjectView, Viewer } from "@vtt/protocol";
import {
  type FaceElement,
  type FaceLayout,
  type FaceStyle,
  type ObjectId,
  type Rect,
  STRUCTURAL_CELLS,
} from "@vtt/schema";
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { inspectorRefLabel, useInspectorWrites } from "../inspector/CellRow";
import { TableProvider, useSession, useUi } from "../session/hooks";
import type { TableSession } from "../session/table-session";
import { sessionNotices } from "../session/writes";
import type { UiStore } from "../state/ui-state";
import {
  addElement,
  blankElement,
  defaultLayoutFor,
  type FaceElementFields,
  type FaceListName,
  type FaceOpResult,
  faceListOf,
  faceUserCells,
  type LayoutElementRef,
  layoutOfView,
  removeElement,
  reorderElement,
  resizeElement,
  setDefaultAction,
  setElementField,
  setFaceOps,
} from "./face-ops";

export interface FaceSectionProps {
  session: TableSession;
  ui: UiStore;
}

/** Why `source` cannot be a `show_when`, or null (empty is fine: it clears). */
export function showWhenProblem(source: string): string | null {
  if (source.trim() === "") return null;
  const parsed = parse(source);
  return parsed.ok ? null : parsed.message;
}

/** Why `text` is not a finite number, or null (`allowEmpty`: empty clears). */
function numberProblem(text: string, allowEmpty: boolean): string | null {
  if (text.trim() === "") return allowEmpty ? null : "Enter a number.";
  return Number.isFinite(Number(text.trim())) ? null : "Enter a number.";
}

const SECTION_STYLE: CSSProperties = { borderTop: "1px solid rgba(127, 127, 127, 0.3)" };
const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.25em",
};
const ITEM_STYLE: CSSProperties = {
  listStyle: "none",
  padding: "4px 0",
  borderBottom: "1px solid rgba(127, 127, 127, 0.15)",
};
const LIST_STYLE: CSSProperties = { margin: 0, padding: 0 };
const ERROR_STYLE: CSSProperties = { color: "#b3261e", fontSize: "0.85em" };
const NOTE_STYLE: CSSProperties = { opacity: 0.7 };

export function FaceSection({ session, ui }: FaceSectionProps) {
  return (
    <TableProvider session={session} ui={ui}>
      <SelectedFace session={session} />
    </TableProvider>
  );
}

function SelectedFace({ session }: { session: TableSession }) {
  const selection = useUi((s) => s.selection);
  useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  const board = useSession((s) => s.activeBoard);
  if (selection.length !== 1) return null;
  const object = selection[0] as ObjectId;
  const view = session.objectView(object);
  if (view === null) return null;
  return (
    <FaceEditor
      // Keyed by board, viewer and object: a change of any drops pending
      // drafts and their captured base revisions (never written later).
      key={JSON.stringify([board, viewerKey(viewer), object])}
      object={object}
      view={view}
      session={session}
      readOnly={viewer.type !== "gm"}
    />
  );
}

/** A stable key for a viewer. */
function viewerKey(viewer: Viewer): string {
  return viewer.type === "character" ? `character:${viewer.id}` : viewer.type;
}

/** Whether the session's current viewer is the GM (the only one who edits faces). */
function viewingAsGm(session: TableSession): boolean {
  return session.getSnapshot().viewer.type === "gm";
}

interface FaceEditorProps {
  object: ObjectId;
  view: ObjectView;
  session: TableSession;
  readOnly: boolean;
}

/** The actions of one editor: writes built from the layout current at the commit. */
interface FaceWriter {
  /** The current layout of the object (null: none). */
  current(): FaceLayout | null;
  /** Writes `edit(current)` with `baseRevision`, or shows its problem as a notice. */
  edit(edit: (face: FaceLayout) => FaceOpResult, baseRevision: number): void;
  /** Writes `face` (null removes the layout). */
  replace(face: FaceLayout | null, baseRevision: number, verb: string): void;
  /** The session's revision now (for commands at the click). */
  now(): number;
}

function useFaceWriter(session: TableSession, object: ObjectId): FaceWriter {
  const port = useInspectorWrites(session);
  const notice = (text: string) => sessionNotices(session).push({ level: "error", text });
  const label = (verb: string) => `${verb} ${inspectorRefLabel(session)(object) ?? object}`;
  const current = () => {
    const view = session.objectView(object);
    return view === null ? null : layoutOfView(view);
  };
  const replace = (face: FaceLayout | null, baseRevision: number, verb: string) => {
    // Never from a character's view (view-as is read-only, and its layout is filtered).
    if (!viewingAsGm(session)) return;
    void port.write(setFaceOps(object, face), { baseRevision, label: label(verb) });
  };
  return {
    current,
    now: () => session.getSnapshot().revision,
    replace,
    edit(edit, baseRevision) {
      if (!viewingAsGm(session)) return;
      const face = current();
      if (face === null) {
        notice("The face was not changed: the object no longer has a face.");
        return;
      }
      const result = edit(face);
      if (!result.ok) {
        notice(`The face was not changed: ${result.message}.`);
        return;
      }
      replace(result.face, baseRevision, "Edit face of");
    },
  };
}

function FaceEditor({ object, view, session, readOnly }: FaceEditorProps) {
  const [tab, setTab] = useState<FaceListName>("full");
  const writer = useFaceWriter(session, object);
  const face = layoutOfView(view);

  const create = () => {
    const baseRevision = writer.now();
    const result = defaultLayoutFor(view);
    if (!result.ok) {
      sessionNotices(session).push({
        level: "error",
        text: `The face was not created: ${result.message}.`,
      });
      return;
    }
    writer.replace(result.face, baseRevision, "Create face of");
  };

  if (face === null) {
    return (
      <section aria-label="Face" style={SECTION_STYLE}>
        <h4 style={{ margin: "0.5em 0 0.25em" }}>Face</h4>
        {readOnly ? (
          <p style={NOTE_STYLE}>No face</p>
        ) : (
          <button type="button" onClick={create}>
            Create face
          </button>
        )}
      </section>
    );
  }

  const list = faceListOf(face, tab);
  const live = tab === "full" ? view.face?.elements : view.face?.collapsed;
  const add = (kind: FaceElement["type"]) => {
    const baseRevision = writer.now();
    const element = blankElement(kind, view, tab);
    if (element === null) return;
    writer.edit((f) => addElement(f, tab, element), baseRevision);
  };
  const hasContents = list.some((e) => e.type === "contents");
  const actions = view.actions.map((a) => a.name);
  const tabButton = (id: FaceListName, text: string) => (
    <button type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
      {text}
    </button>
  );

  return (
    <section aria-label="Face" style={SECTION_STYLE}>
      <h4 style={{ margin: "0.5em 0 0.25em" }}>Face</h4>
      <div role="tablist" aria-label="Face lists" style={ROW_STYLE}>
        {tabButton("full", "Full")}
        {tabButton("collapsed", "Collapsed")}
      </div>
      <div role="tabpanel">
        {list.length === 0 && (
          <p style={NOTE_STYLE}>
            {tab === "full" ? "No elements" : "No collapsed elements (the default shows the name)"}
          </p>
        )}
        <ul aria-label={tab === "full" ? "Full elements" : "Collapsed elements"} style={LIST_STYLE}>
          {list.map((element, index) => {
            const hidden = live?.[index];
            return (
              <ElementRow
                // biome-ignore lint/suspicious/noArrayIndexKey: elements are identified by position
                key={`${tab}-${index}`}
                element={element}
                elementRef={{ list: tab, index }}
                count={list.length}
                view={view}
                session={session}
                writer={writer}
                readOnly={readOnly}
                hiddenReason={hidden?.shown === false ? (hidden.reason ?? null) : null}
              />
            );
          })}
        </ul>
        {!readOnly && (
          <div style={ROW_STYLE}>
            <button type="button" onClick={() => add("value")}>
              Add value
            </button>
            <button type="button" onClick={() => add("editor")}>
              Add editor
            </button>
            <button
              type="button"
              disabled={actions.length === 0}
              title={actions.length === 0 ? "The object has no actions" : undefined}
              onClick={() => add("button")}
            >
              Add button
            </button>
            <button
              type="button"
              disabled={hasContents}
              title={hasContents ? "A list has at most one contents element" : undefined}
              onClick={() => add("contents")}
            >
              Add contents
            </button>
          </div>
        )}
      </div>
      <div style={ROW_STYLE}>
        <label>
          Default action{" "}
          <select
            aria-label="Default action"
            value={face.default_action ?? ""}
            disabled={readOnly}
            onChange={(e) => {
              const baseRevision = writer.now();
              const value = e.target.value;
              writer.edit(
                (f) => setDefaultAction(f, value === "" ? undefined : value),
                baseRevision,
              );
            }}
          >
            <option value="">None</option>
            {withCurrent(actions, face.default_action).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {!readOnly && (
          <button
            type="button"
            onClick={() => writer.replace(null, writer.now(), "Remove face of")}
          >
            Remove face
          </button>
        )}
      </div>
    </section>
  );
}

/** `names` plus `current` when it is set and missing (a dangling name stays selectable). */
function withCurrent(names: readonly string[], current: string | undefined): string[] {
  return current === undefined || names.includes(current) ? [...names] : [...names, current];
}

/** The cell names offered by the cell picker: user cells, then structural cells present. */
function cellChoices(view: ObjectView): string[] {
  const structural = STRUCTURAL_CELLS.map((spec) => spec.name).filter(
    (name) => name !== "id" && Object.hasOwn(view.cells, name),
  );
  return [...faceUserCells(view), ...structural];
}

const HIDDEN_TEXT: Record<string, string> = {
  show_when_false: "hidden: show_when is false",
  show_when_error: "hidden: show_when is an error",
  no_action: "hidden: no such action",
};

interface ElementRowProps {
  element: FaceElement;
  elementRef: LayoutElementRef;
  count: number;
  view: ObjectView;
  session: TableSession;
  writer: FaceWriter;
  readOnly: boolean;
  hiddenReason: string | null;
}

function ElementRow({
  element,
  elementRef,
  count,
  view,
  session,
  writer,
  readOnly,
  hiddenReason,
}: ElementRowProps) {
  const { index } = elementRef;
  /** Sets one field at the click. */
  const pick = <K extends keyof FaceElementFields>(
    field: K,
    value: FaceElementFields[K] | undefined,
  ) => {
    const baseRevision = writer.now();
    writer.edit((f) => setElementField(f, elementRef, field, value), baseRevision);
  };
  /** Commits one rect coordinate (0–3) typed into a text field. */
  const commitRect = (i: number) => (text: string, baseRevision: number) => {
    writer.edit((f) => {
      const current = faceListOf(f, elementRef.list)[index];
      if (current === undefined) return { ok: false, message: "the element no longer exists" };
      const rect = [...current.rect] as Rect;
      rect[i] = Number(text.trim());
      return resizeElement(f, elementRef, rect);
    }, baseRevision);
  };
  const commitOptional =
    (field: "show_when" | "label" | "min_size") => (text: string, baseRevision: number) => {
      const trimmed = text.trim();
      const value = trimmed === "" ? undefined : field === "min_size" ? Number(trimmed) : text;
      writer.edit(
        (f) => setElementField(f, elementRef, field, value as FaceElementFields[typeof field]),
        baseRevision,
      );
    };
  const command = (run: (f: FaceLayout) => FaceOpResult) => {
    const baseRevision = writer.now();
    writer.edit(run, baseRevision);
  };
  const style: FaceStyle = "style" in element ? (element.style ?? {}) : {};
  const setStyle = <K extends keyof FaceStyle>(key: K, value: FaceStyle[K] | undefined) => {
    const next: FaceStyle = { ...style };
    if (value === undefined) delete next[key];
    else next[key] = value;
    pick("style", next);
  };
  const field = (label: string, value: string, onCommit: DraftCommit, validate?: Validate) => (
    <DraftField
      key={label}
      label={label}
      value={value}
      session={session}
      readOnly={readOnly}
      onCommit={onCommit}
      {...(validate === undefined ? {} : { validate })}
    />
  );

  return (
    <li aria-label={`Element ${index + 1}`} style={ITEM_STYLE}>
      <div style={ROW_STYLE}>
        {element.type === "value" || element.type === "editor" ? (
          <>
            <select
              aria-label="Kind"
              value={element.type}
              disabled={readOnly}
              onChange={(e) => pick("type", e.target.value as "value" | "editor")}
            >
              <option value="value">value</option>
              <option value="editor">editor</option>
            </select>
            <select
              aria-label="Cell"
              value={element.cell}
              disabled={readOnly}
              onChange={(e) => pick("cell", e.target.value)}
            >
              {withCurrent(cellChoices(view), element.cell).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span>{element.type}</span>
        )}
        {element.type === "button" && (
          <>
            <select
              aria-label="Action"
              value={element.action}
              disabled={readOnly}
              onChange={(e) => pick("action", e.target.value)}
            >
              {withCurrent(
                view.actions.map((a) => a.name),
                element.action,
              ).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {field("Label", element.label ?? "", commitOptional("label"))}
          </>
        )}
        {element.type === "contents" && (
          <select
            aria-label="Entries"
            value={element.entries ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              pick(
                "entries",
                e.target.value === "" ? undefined : (e.target.value as "collapsed" | "full"),
              )
            }
          >
            <option value="">Default (collapsed)</option>
            <option value="collapsed">Collapsed</option>
            <option value="full">Full</option>
          </select>
        )}
        {hiddenReason !== null && (
          <span style={NOTE_STYLE}>{HIDDEN_TEXT[hiddenReason] ?? "hidden"}</span>
        )}
      </div>
      <div style={ROW_STYLE}>
        {(["x", "y", "w", "h"] as const).map((name, i) =>
          field(name, String(element.rect[i]), commitRect(i), (t) => numberProblem(t, false)),
        )}
      </div>
      <div style={ROW_STYLE}>
        {!readOnly &&
          field("Show when", element.show_when ?? "", commitOptional("show_when"), showWhenProblem)}
        {field(
          "Min size",
          element.min_size === undefined ? "" : String(element.min_size),
          commitOptional("min_size"),
          (t) => numberProblem(t, true),
        )}
      </div>
      {(element.type === "value" || element.type === "editor") && (
        <div style={ROW_STYLE}>
          <select
            aria-label="Size"
            value={style.size ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              setStyle(
                "size",
                e.target.value === "" ? undefined : (e.target.value as FaceStyle["size"]),
              )
            }
          >
            <option value="">Size: default</option>
            <option value="small">small</option>
            <option value="normal">normal</option>
            <option value="large">large</option>
            <option value="huge">huge</option>
          </select>
          <select
            aria-label="Align"
            value={style.align ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              setStyle(
                "align",
                e.target.value === "" ? undefined : (e.target.value as FaceStyle["align"]),
              )
            }
          >
            <option value="">Align: default</option>
            <option value="left">left</option>
            <option value="center">center</option>
            <option value="right">right</option>
          </select>
          <label>
            <input
              type="checkbox"
              checked={style.caption === true}
              disabled={readOnly}
              onChange={(e) => setStyle("caption", e.target.checked ? true : undefined)}
            />{" "}
            Caption
          </label>
        </div>
      )}
      {!readOnly && (
        <div style={ROW_STYLE}>
          <button
            type="button"
            disabled={index === 0}
            onClick={() => command((f) => reorderElement(f, elementRef, index - 1))}
          >
            Move up
          </button>
          <button
            type="button"
            disabled={index === count - 1}
            onClick={() => command((f) => reorderElement(f, elementRef, index + 1))}
          >
            Move down
          </button>
          <button type="button" onClick={() => command((f) => removeElement(f, elementRef))}>
            Delete element
          </button>
        </div>
      )}
    </li>
  );
}

type DraftCommit = (text: string, baseRevision: number) => void;
type Validate = (text: string) => string | null;

interface Draft {
  readonly text: string;
  readonly initial: string;
  readonly baseRevision: number;
}

interface DraftFieldProps {
  label: string;
  /** The current value as text (shown while not editing). */
  value: string;
  session: TableSession;
  readOnly: boolean;
  /** Called on Enter or blur with changed, valid text and the revision captured on focus. */
  onCommit: DraftCommit;
  /** The problem with the text as typed, or null. A problem blocks the commit. */
  validate?: Validate;
}

/**
 * A text field that captures the base revision on focus and commits on
 * Enter or blur. Unchanged text commits nothing; Escape cancels; invalid
 * text shows its problem and commits nothing (a blur then reverts it).
 */
function DraftField({ label, value, session, readOnly, onCommit, validate }: DraftFieldProps) {
  const [draft, setDraftState] = useState<Draft | null>(null);
  const ref = useRef<Draft | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // Becoming read-only drops a pending draft without writing it.
  useEffect(() => {
    if (readOnly && ref.current !== null) {
      ref.current = null;
      setDraftState(null);
    }
  }, [readOnly]);
  const setDraft = (next: Draft | null) => {
    ref.current = next;
    setDraftState(next);
  };
  const start = (text: string): Draft => ({
    text,
    initial: value,
    baseRevision: session.getSnapshot().revision,
  });
  const finish = (commit: boolean) => {
    const current = ref.current;
    if (current === null) return;
    setDraft(null);
    if (readOnlyRef.current || !viewingAsGm(session)) return;
    if (!commit || current.text === current.initial) return;
    if (validate?.(current.text)) return;
    onCommit(current.text, current.baseRevision);
  };
  const problem = draft !== null && validate !== undefined ? validate(draft.text) : null;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (problem === null) finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };
  const id = useId();
  return (
    <span style={{ display: "inline-flex", flexDirection: "column" }}>
      <label style={{ display: "inline-flex", gap: "0.25em", alignItems: "center" }}>
        <span>{label}</span>
        <input
          aria-label={label}
          aria-invalid={problem !== null}
          aria-describedby={problem !== null ? id : undefined}
          size={label.length > 2 ? 12 : 5}
          value={draft?.text ?? value}
          readOnly={readOnly}
          onFocus={() => {
            if (!readOnly) setDraft(start(value));
          }}
          onChange={(e) => {
            if (readOnly) return;
            const base = ref.current ?? start(value);
            setDraft({ ...base, text: e.target.value });
          }}
          onKeyDown={onKeyDown}
          onBlur={() => finish(true)}
        />
      </label>
      {problem !== null && (
        <span id={id} role="alert" style={ERROR_STYLE}>
          {problem}
        </span>
      )}
    </span>
  );
}
