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
 * newline); Escape reverts; leaving the input for another element of the
 * page (a click elsewhere, Tab) discards the draft. The window losing focus
 * (alt-tab, switching to another app; `document.hasFocus()` false at blur)
 * keeps the draft and its revision, and focus coming back to the input
 * resumes it; if the window comes back with focus elsewhere, the kept draft
 * is discarded (vtt-nb8.21). Input that does not parse shows the parser's message (checked
 * as you type, debounced) and cannot be committed. Hovering or focusing the
 * bar sets `UiStore.hoveredCell` to the focused cell (tracing is
 * vtt-3l6.24's); leaving, blurring, clearing the focused cell and unmounting
 * clear the hover the bar set, never another component's. `requestFormulaBarFocus` (editor-port.ts) gives the input
 * keyboard focus.
 *
 * Completion (vtt-qf5.16, completion.ts): while a formula is being typed
 * (focusing alone opens nothing), a list under the input suggests names for
 * the identifier at the caret: the object's cells, functions, and after
 * `ref.` the referenced object's cells as the viewer's view shows them. Nothing is highlighted at first; Down and
 * Up move the highlight; Tab accepts the highlighted suggestion (else the
 * first); Enter accepts the highlighted one, and with none highlighted
 * commits as above; Escape closes the list (until the text or caret moves)
 * before it reverts. A click on a suggestion accepts it; the input keeps
 * focus throughout. Accepting replaces the identifier and puts the caret
 * after the insert.
 */
import type { CellView, ObjectView } from "@vtt/protocol";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
import { applyCompletion, type CompletionItem, suggestCompletions } from "./completion";
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
const FIELD_STYLE: CSSProperties = { position: "relative", flex: 1, minWidth: 0, display: "flex" };
const LIST_STYLE: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  zIndex: 20,
  margin: 0,
  padding: 0,
  minWidth: "12em",
  background: "Canvas",
  color: "CanvasText",
  border: "1px solid GrayText",
  boxShadow: "0 2px 6px rgba(0, 0, 0, 0.2)",
};
const OPTION_STYLE: CSSProperties = { padding: "1px 6px", cursor: "pointer", whiteSpace: "nowrap" };
const ACTIVE_OPTION_STYLE: CSSProperties = {
  ...OPTION_STYLE,
  background: "Highlight",
  color: "HighlightText",
};

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
  /** Whether the draft was kept over the window losing focus (vtt-nb8.21). */
  const keptOverWindowBlur = useRef(false);
  /** The `hoveredCell` this bar set, so it clears only its own. */
  const ownHover = useRef<CellAddress | null>(null);
  /** Whether the text was typed into since the draft began: completion follows typing only. */
  const [typing, setTyping] = useState(false);
  /** The input's caret while it is a collapsed selection, else null (completion). */
  const [caret, setCaret] = useState<number | null>(null);
  /** Escape closed the suggestions; typing or moving the caret reopens them. */
  const [dismissed, setDismissed] = useState(false);
  /** The highlighted suggestion, valid only at the text and caret it was chosen at. */
  const [highlight, setHighlight] = useState<{ at: string; index: number } | null>(null);
  /** Where to put the caret after accepting a suggestion re-renders the input. */
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

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

  // -- completion

  const completionAt = draft === null || caret === null ? null : `${caret}\u0000${draft.text}`;
  const completion =
    draft === null || caret === null || focused === null || !caps.formula || !typing
      ? null
      : suggestCompletions(draft.text, caret, {
          object: focused.object,
          cell: cellName,
          objectView: (id) => session.objectView(id),
        });
  const suggestions = completion !== null && !dismissed ? completion : null;
  const activeIndex = suggestions !== null && highlight?.at === completionAt ? highlight.index : -1;

  const syncCaret = (el: HTMLTextAreaElement) => {
    const next = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    if (next !== caret) setDismissed(false);
    setCaret(next);
  };

  // After accepting, the caret goes after the insert once the new text is rendered.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || inputRef.current === null) return;
    pendingCaret.current = null;
    inputRef.current.setSelectionRange(at, at);
  });

  const accept = (item: CompletionItem) => {
    if (draft === null || suggestions === null) return;
    const next = applyCompletion(draft.text, suggestions, item);
    const { error: _error, ...rest } = draft;
    setDraft({ ...rest, text: next.text });
    pendingCaret.current = next.caret;
    setCaret(next.caret);
  };

  /** Handles a key for the open suggestion list; true when it did. */
  const completionKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (suggestions === null || completionAt === null) return false;
    const { items } = suggestions;
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (!plain) return false;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const from = activeIndex < 0 ? (step > 0 ? -1 : 0) : activeIndex;
        setHighlight({ at: completionAt, index: (from + step + items.length) % items.length });
        return true;
      }
      case "Tab": {
        if (!plain) return false;
        event.preventDefault();
        const item = items[Math.max(activeIndex, 0)];
        if (item !== undefined) accept(item);
        return true;
      }
      case "Enter": {
        const item = items[activeIndex];
        if (!plain || item === undefined) return false;
        event.preventDefault();
        accept(item);
        return true;
      }
      case "Escape":
        event.preventDefault();
        setDismissed(true);
        return true;
      default:
        return false;
    }
  };

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
    else {
      // A draft kept over a window blur belongs to the cell it was typed in.
      keptOverWindowBlur.current = false;
      setDraft(null);
    }
  }, [key]);

  // The window came back: a kept draft whose input did not get focus back is discarded.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWindowFocus = () => {
      clearTimeout(timer);
      // After this task, so the input's own focus (restored by the browser) has fired.
      timer = setTimeout(() => {
        if (!keptOverWindowBlur.current) return;
        keptOverWindowBlur.current = false;
        if (inputRef.current === null || document.activeElement !== inputRef.current) {
          setDraft(null);
        }
      }, 0);
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

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
    setTyping(false);
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
    if (completionKey(event)) return;
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
        <div style={FIELD_STYLE}>
          <textarea
            ref={inputRef}
            aria-label="Formula"
            aria-autocomplete="list"
            aria-controls={suggestions === null ? undefined : listId}
            aria-activedescendant={activeIndex < 0 ? undefined : `${listId}-${activeIndex}`}
            style={INPUT_STYLE}
            rows={Math.max(1, (draft?.text ?? start.text).split("\n").length)}
            value={draft?.text ?? start.text}
            spellCheck={false}
            onFocus={() => {
              presence.current.focused = true;
              keptOverWindowBlur.current = false;
              syncHover();
              if (draft === null) beginDraft();
            }}
            onBlur={() => {
              presence.current.focused = false;
              setCaret(null);
              setTyping(false);
              setDismissed(false);
              syncHover();
              // The window losing focus blurs the input too: keep the draft for when it returns.
              if (!document.hasFocus()) keptOverWindowBlur.current = true;
              else setDraft(null);
            }}
            onChange={(e) => {
              const base = draft ?? beginDraft();
              if (base === null) return;
              const { error: _error, ...rest } = base;
              setDraft({ ...rest, text: e.target.value });
              setTyping(true);
              setDismissed(false);
              syncCaret(e.target);
            }}
            onSelect={(e) => syncCaret(e.currentTarget)}
            onKeyDown={onKeyDown}
          />
          {suggestions !== null && (
            <div id={listId} role="listbox" aria-label="Suggestions" style={LIST_STYLE}>
              {suggestions.items.map((item, index) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the input's keys drive the list
                <div
                  key={`${item.kind}:${item.label}`}
                  id={`${listId}-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeIndex}
                  data-kind={item.kind}
                  style={index === activeIndex ? ACTIVE_OPTION_STYLE : OPTION_STYLE}
                  // Keep the input focused (and its draft) while the suggestion is pressed.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => accept(item)}
                >
                  {item.label}
                  {item.kind === "function" && <span style={MUTED_STYLE}>()</span>}
                </div>
              ))}
            </div>
          )}
        </div>
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
