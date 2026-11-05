/**
 * The formula bar (vtt-3l6.13; DESIGN.md §4.2, §4.6 The formula bar, Typing
 * into a cell, View as in the UI; FORMULAS.md §3.2; §5.2 and M4-D7: writes
 * carry the revision their interaction began on; review r1 findings 1, 10,
 * r2 finding 5, r3 finding 4).
 *
 * One persistent bar showing `object.cell` of `UiStore.focusedCell`. It
 * edits the formula source: a formula cell shows `=` + source (with an
 * "override: <value>" chip and "Clear" when overridden), a literal cell its
 * literal, and typing `=…` makes a formula. Editing is offered only as
 * `cellCapabilities` allows; a value with no input text (an error, a roll, a
 * shape, ink) of a cell that takes literals shows its reason and an empty
 * input that replaces it. Read-only (value only) in view-as, for cells that
 * allow neither literal nor formula, and with nothing focused.
 *
 * The input is a textarea that keeps the text exactly (multiline formula
 * sources and text). The revision is captured when it gains focus; Enter
 * commits with it unless the input is unchanged (Shift+Enter inserts a
 * newline); Escape reverts; leaving the input discards
 * the draft. Input that does not parse shows the parser's message (checked
 * as you type, debounced) and cannot be committed. Hovering or focusing the
 * bar sets `UiStore.hoveredCell` to the focused cell (tracing is
 * vtt-3l6.24's); leaving, blurring, clearing the focused cell and unmounting
 * clear the hover the bar set, never another component's. `requestFormulaBarFocus` (editor-port.ts) gives the input
 * keyboard focus.
 */
import type { CellView, ObjectView } from "@vtt/protocol";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { TableSession } from "../session/table-session";
import { createWritePort } from "../session/writes";
import type { CellAddress, UiStore } from "../state/ui-state";
import { formatValue, type RefLabel } from "../values/format";
import {
  type CellCapabilities,
  cellCapabilities,
  isUnchangedInput,
  parseCellInput,
  toInputText,
} from "../values/input";
import { cellInputToOps } from "../values/ops";
import { onFormulaBarFocusRequest } from "./editor-port";

/** How long typing pauses before the input's syntax is checked. */
export const SYNTAX_CHECK_DELAY_MS = 150;

export interface FormulaBarProps {
  session: TableSession;
  ui: UiStore;
}

/** What the input starts from: its text, and why the value has none (replace-value input). */
interface Start {
  readonly text: string;
  readonly reason?: string;
}

/** The text being edited, captured when the input gained focus. */
interface Draft {
  readonly key: string;
  readonly initial: string;
  readonly reason?: string;
  readonly text: string;
  readonly baseRevision: number;
  readonly error?: string;
}

/** `name` of `view`; the object's `id` (not a cell of views) reads as its id, as text. */
function cellOf(view: ObjectView | null, name: string): CellView | undefined {
  if (view === null) return undefined;
  if (Object.hasOwn(view.cells, name)) return view.cells[name];
  return name === "id"
    ? { kind: "structural", value: { type: "text", value: view.id } }
    : undefined;
}

const keyOf = (cell: CellAddress) => `${cell.object}\u0000${cell.cell}`;

/** The input's starting text, or null when the cell is shown read-only. */
function startOf(view: CellView, cellName: string, caps: CellCapabilities): Start | null {
  if (!caps.literal && !caps.formula) return null;
  const input = toInputText(view, cellName);
  switch (input.kind) {
    case "formula":
      return caps.formula ? { text: `=${input.source}` } : null;
    case "literal":
      return caps.literal ? { text: input.text } : null;
    case "unsupported":
      return caps.literal ? { text: "", reason: input.reason } : null;
  }
}

/** Why `text` cannot be committed to a cell with `caps`, or null. */
function problemOf(text: string, cellName: string, caps: CellCapabilities): string | null {
  const parsed = parseCellInput(text, { cell: cellName });
  if (!parsed.ok) return parsed.message;
  if (parsed.content.type === "formula" && !caps.formula)
    return `${cellName} cannot hold a formula.`;
  if (parsed.content.type !== "formula" && !caps.literal)
    return `${cellName} takes only a formula.`;
  return null;
}

function unchanged(draft: Draft, cellName: string): boolean {
  // A replace-value input's "" is a placeholder: anything typed there writes.
  return draft.reason === undefined
    ? isUnchangedInput(draft.initial, draft.text, cellName)
    : draft.text === "";
}

const BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5em",
  padding: "2px 4px",
  fontFamily: "ui-monospace, monospace",
};
const ADDRESS_STYLE: CSSProperties = { fontWeight: 600, whiteSpace: "nowrap" };
const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "inherit",
  resize: "none",
};
const NOTE_STYLE: CSSProperties = { fontSize: "0.85em", whiteSpace: "nowrap" };
const ERROR_STYLE: CSSProperties = { ...NOTE_STYLE, color: "#b3261e" };
const MUTED_STYLE: CSSProperties = { color: "GrayText" };

export function FormulaBar({ session, ui }: FormulaBarProps) {
  const snapshot = useSyncExternalStore(
    useCallback((fn: () => void) => session.subscribe(fn), [session]),
    () => session.getSnapshot(),
  );
  const focused = useSyncExternalStore(
    useCallback((fn: () => void) => ui.subscribe(fn), [ui]),
    () => ui.getState().focusedCell,
  );
  const port = useMemo(() => createWritePort(session), [session]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draftState, setDraft] = useState<Draft | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const presence = useRef({ hovered: false, focused: false });
  /** The `hoveredCell` this bar set, so it clears only its own. */
  const ownHover = useRef<CellAddress | null>(null);

  const viewer = snapshot.viewer;
  const gm = viewer.type === "gm";
  const objectView = focused === null ? null : session.objectView(focused.object);
  const cellView = focused === null ? undefined : cellOf(objectView, focused.cell);
  const cellName = focused?.cell ?? "";
  const caps = cellCapabilities(cellName, cellView, { readOnly: !gm || cellView === undefined });
  const start = cellView === undefined ? null : startOf(cellView, cellName, caps);
  const key = focused === null ? null : keyOf(focused);
  // A draft belongs to its cell, and only to an editable one.
  const draft = draftState !== null && draftState.key === key && start !== null ? draftState : null;

  const refLabel: RefLabel = (id) => {
    const label = session.refLabel(viewer, id);
    return label === id ? null : label;
  };

  // -- hover (tracing reads `hoveredCell`)

  /**
   * Sets `hoveredCell` to the focused cell while the bar is hovered or
   * focused; otherwise clears the hover this bar set, unless another
   * component has replaced it since.
   */
  const syncHover = useCallback(
    (present = true) => {
      const { hovered, focused: inside } = presence.current;
      const cell = ui.getState().focusedCell;
      if (present && (hovered || inside) && cell !== null) {
        ownHover.current = cell;
        ui.setHoveredCell(cell);
        return;
      }
      const own = ownHover.current;
      ownHover.current = null;
      const current = ui.getState().hoveredCell;
      if (own !== null && current !== null && keyOf(current) === keyOf(own)) {
        ui.setHoveredCell(null);
      }
    },
    [ui],
  );

  // The focused cell changed (or was cleared): the hover follows it, or is cleared.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the focused cell changes
  useEffect(() => syncHover(), [key, syncHover]);
  // Unmounting clears the bar's own hover.
  useEffect(() => () => syncHover(false), [syncHover]);

  // A new focused cell while the input has keyboard focus: a new draft, at today's revision.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the focused cell changes
  useEffect(() => {
    if (inputRef.current !== null && document.activeElement === inputRef.current) beginDraft();
  }, [key]);

  // -- focus requests

  useEffect(() => onFormulaBarFocusRequest(ui, () => setFocusTick((n) => n + 1)), [ui]);
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);

  // -- syntax check as you type (debounced)

  const draftText = draft?.text;
  const draftError = draft?.error;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check only when the text changes
  useEffect(() => {
    if (draftText === undefined || draftError !== undefined || draftText === "") return;
    const timer = setTimeout(() => {
      const problem = problemOf(draftText, cellName, caps);
      if (problem === null) return;
      setDraft((current) =>
        current !== null && current.text === draftText ? { ...current, error: problem } : current,
      );
    }, SYNTAX_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draftText]);

  // -- editing

  const beginDraft = (): Draft | null => {
    if (key === null || start === null) return null;
    const next: Draft = {
      key,
      initial: start.text,
      ...(start.reason === undefined ? {} : { reason: start.reason }),
      text: start.text,
      baseRevision: session.getSnapshot().revision,
    };
    setDraft(next);
    return next;
  };

  const commit = (current: Draft) => {
    if (focused === null || cellView === undefined) return;
    if (unchanged(current, cellName)) {
      setDraft(null);
      inputRef.current?.blur();
      return;
    }
    const parsed = parseCellInput(current.text, { cell: cellName });
    const problem = problemOf(current.text, cellName, caps);
    if (!parsed.ok || problem !== null) {
      setDraft({ ...current, error: problem ?? "This input cannot be written." });
      return;
    }
    const where = `${refLabel(focused.object) ?? focused.object}.${cellName}`;
    const label = parsed.content.type === "formula" ? `Set formula of ${where}` : `Set ${where}`;
    void port.write(cellInputToOps(focused.object, cellName, parsed.content, cellView), {
      baseRevision: current.baseRevision,
      label,
    });
    setDraft(null);
    inputRef.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter inserts a newline (the textarea keeps the text exactly).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const current = draft ?? beginDraft();
      if (current !== null) commit(current);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (draft !== null) {
        const { error: _error, ...rest } = draft;
        setDraft({ ...rest, text: draft.initial });
      }
    }
  };

  const clearOverride = () => {
    if (focused === null) return;
    const where = `${refLabel(focused.object) ?? focused.object}.${cellName}`;
    void port.write([{ type: "clear_override", object: focused.object, cell: cellName }], {
      baseRevision: session.getSnapshot().revision,
      label: `Clear override on ${where}`,
    });
  };

  // -- render

  const address =
    focused === null ? null : `${session.refLabel(viewer, focused.object)}.${focused.cell}`;
  const overridden = gm && cellView?.kind === "formula" && cellView.overridden === true;
  const reason = draft?.reason ?? start?.reason;
  const commitDisabled = draft === null || draft.error !== undefined || unchanged(draft, cellName);

  let body: ReactNode;
  if (focused === null) {
    body = <span style={MUTED_STYLE}>No cell focused</span>;
  } else if (cellView === undefined) {
    body = <span style={MUTED_STYLE}>Not visible</span>;
  } else if (start === null) {
    const formatted = formatValue(cellView.value, { mode: "full", refLabel });
    body = (
      <span data-part="value" data-tone={formatted.tone}>
        {formatted.text}
      </span>
    );
  } else {
    body = (
      <>
        <textarea
          ref={inputRef}
          aria-label="Formula"
          style={INPUT_STYLE}
          rows={Math.max(1, (draft?.text ?? start.text).split("\n").length)}
          value={draft?.text ?? start.text}
          spellCheck={false}
          onFocus={() => {
            presence.current.focused = true;
            syncHover();
            if (draft === null) beginDraft();
          }}
          onBlur={() => {
            presence.current.focused = false;
            syncHover();
            setDraft(null);
          }}
          onChange={(e) => {
            const base = draft ?? beginDraft();
            if (base === null) return;
            const { error: _error, ...rest } = base;
            setDraft({ ...rest, text: e.target.value });
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          disabled={commitDisabled}
          // Keep the input focused (and its draft) while the button is pressed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (draft !== null) commit(draft);
          }}
        >
          Commit
        </button>
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover feeds dependency tracing only
    <div
      data-part="formula-bar"
      style={BAR_STYLE}
      onMouseEnter={() => {
        presence.current.hovered = true;
        syncHover();
      }}
      onMouseLeave={() => {
        presence.current.hovered = false;
        syncHover();
      }}
    >
      {address !== null && (
        <span data-part="address" style={ADDRESS_STYLE} title={focused?.object}>
          {address}
        </span>
      )}
      {body}
      {reason !== undefined && start !== null && (
        <span data-part="reason" style={NOTE_STYLE}>
          {reason}: type a value to replace it
        </span>
      )}
      {draft?.error !== undefined && (
        <span role="alert" style={ERROR_STYLE}>
          {draft.error}
        </span>
      )}
      {overridden && cellView !== undefined && (
        <span data-part="override" style={NOTE_STYLE}>
          override: {formatValue(cellView.value, { mode: "full", refLabel }).text}{" "}
          <button type="button" onClick={clearOverride}>
            Clear
          </button>
        </span>
      )}
    </div>
  );
}
