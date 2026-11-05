/**
 * One row of the inspector's cell list (vtt-3l6.11; DESIGN.md §4.2, §4.6 The
 * inspector and Typing into a cell, M4-D6, M4-D7, M4-D17; FORMULAS.md §2.3,
 * §3.1; PROTOCOL.md §5).
 *
 * The row shows the name, the value (`formatValue` full, with its tone), the
 * `ƒ` badge and source of a formula cell (GM views carry it), the override
 * marker with "Clear override", a visibility glyph when the view carries the
 * cell's `visibility`, and for errors the message and an origin link.
 * Editing is offered only as `cellCapabilities` allows:
 *
 * - double-clicking the value opens the **value editor**, prefilled with
 *   `valueToInputText`; a value with no input text (an error, a roll, …)
 *   opens an empty **replace value** editor with the reason beside it. Enter
 *   commits through `cellInputToOps` (a literal, an override on a formula
 *   cell, or with a leading `=` a formula) unless `isUnchangedInput`; Escape
 *   cancels. The write carries the revision captured when the editor opened.
 * - "Edit formula" focuses the cell for the formula bar; "Replace formula with
 *   value" is one `set_value {replace: true}` with the shown value; "Clear
 *   override", rename and delete (user cells only) capture the revision at
 *   the click (the rename at the rename editor's opening).
 * - the `visible_to` row also carries the viewers picker, which writes the
 *   cell's literal (an override over a formula).
 *
 * Hovering sets `UiStore.hoveredCell` and leaving clears it (tracing is
 * vtt-3l6.24's); a click focuses the cell. The row element carries
 * `data-cell` with the cell's name.
 *
 * In the GM view (not view-as) the row is a drag source of
 * `application/x-vtt-cell` with data `{object, cell}` while no editor is open
 * (vtt-1xv.27): dropped on the object, it adds a value element to its face.
 */
import type {
  CellView,
  InputValue,
  InputViewers,
  WireOp,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import { CellNameSchema, type ObjectId, STRUCTURAL_CELLS } from "@vtt/schema";
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import { CELL_DRAG_MIME, cellDragData } from "../face-editor/cell-drop";
import type { WritePort } from "../interaction/contracts";
import { useUiStore } from "../session/hooks";
import type { TableSession } from "../session/table-session";
import { createWritePort } from "../session/writes";
import type { CellAddress } from "../state/ui-state";
import { type FormatTone, formatValue, type RefLabel } from "../values/format";
import {
  cellCapabilities,
  isUnchangedInput,
  parseCellInput,
  valueToInputText,
} from "../values/input";
import { cellInputToOps, replaceFormulaOps } from "../values/ops";
import { type ViewerCharacter, ViewersPicker } from "./ViewersPicker";

/** The text of the override marker (DESIGN.md §4.2: "the inspector says so"). */
export const OVERRIDE_TEXT = "Overridden: no longer follows its formula";

/** The structural cell names (FORMULAS.md §3.1), which cannot be renamed, deleted or added. */
export const STRUCTURAL_CELL_NAMES: ReadonlySet<string> = new Set(
  STRUCTURAL_CELLS.map((spec) => spec.name),
);

/**
 * Why `name` cannot name a new cell (or a rename target), or null: it must
 * pass `@vtt/schema`'s `CellNameSchema` (any non-empty string except
 * `__proto__`, so `Max HP` is fine) and must not be taken.
 */
export function cellNameProblem(name: string, isTaken: (name: string) => boolean): string | null {
  const parsed = CellNameSchema.safeParse(name);
  if (!parsed.success) {
    return name === ""
      ? "A cell name cannot be empty."
      : (parsed.error.issues[0]?.message ?? "Invalid name.");
  }
  if (isTaken(name)) return `"${name}" already exists on this object.`;
  return null;
}

/** A shown value as an input value, or null when it cannot be stored (errors, hidden values). */
export function storableValue(v: WireResult): InputValue | null {
  if (v.type === "error") return null;
  return storableWire(v);
}

function storableWire(v: WireValue): InputValue | null {
  switch (v.type) {
    case "redacted":
      return null;
    case "ref":
      return { type: "ref", object: v.object };
    case "list": {
      const items: InputValue[] = [];
      for (const item of v.items) {
        const stored = storableWire(item);
        if (stored === null) return null;
        items.push(stored);
      }
      return { type: "list", items };
    }
    case "viewers": {
      const viewers: InputViewers["viewers"] = [];
      for (const entry of v.viewers) {
        if (typeof entry === "string") viewers.push(entry);
        else if (entry.type === "ref") viewers.push({ type: "ref", object: entry.object });
        else return null;
      }
      return { type: "viewers", viewers };
    }
    default:
      return v;
  }
}

/** `session.refLabel` as a `formatValue` label: null when there is no name to show. */
export function inspectorRefLabel(session: TableSession): RefLabel {
  const viewer = session.getSnapshot().viewer;
  return (id) => {
    const label = session.refLabel(viewer, id);
    return label === id ? null : label;
  };
}

/** The session's write port, one per session. */
export function useInspectorWrites(session: TableSession): WritePort {
  return useMemo(() => createWritePort(session), [session]);
}

export interface CellRowProps {
  object: ObjectId;
  name: string;
  cell: CellView;
  session: TableSession;
  /** Character view (view-as): values only, nothing editable. */
  readOnly?: boolean;
  /** Offered by the `visible_to` row's picker. */
  characters?: readonly ViewerCharacter[];
  /** Whether a rename may not take a name (other cells, structural names). */
  isTaken?: (name: string) => boolean;
  /** Called by "Edit formula" after focusing the cell (the formula bar takes focus). */
  onEditFormula?: (cell: CellAddress) => void;
}

interface ValueEditor {
  readonly initial: string;
  readonly text: string;
  /** Why the value has no input text (the replace-value editor). */
  readonly reason?: string;
  readonly error?: string;
  readonly baseRevision: number;
}

interface RenameEditor {
  readonly text: string;
  readonly error?: string;
  readonly baseRevision: number;
}

const NO_CHARACTERS: readonly ViewerCharacter[] = [];
const neverTaken = () => false;

const TONE_COLORS: Record<FormatTone, string | undefined> = {
  normal: undefined,
  muted: "GrayText",
  error: "#b3261e",
  redacted: "GrayText",
};

const ROW_STYLE: CSSProperties = { listStyle: "none", padding: "2px 0" };
const NAME_STYLE: CSSProperties = { fontWeight: 600, marginRight: "0.5em" };
const BADGE_STYLE: CSSProperties = { fontStyle: "italic", marginRight: "0.25em" };
const SOURCE_STYLE: CSSProperties = { marginRight: "0.5em" };
const NOTE_STYLE: CSSProperties = { fontSize: "0.85em", marginLeft: "0.5em" };

export function CellRow({
  object,
  name,
  cell,
  session,
  readOnly = false,
  characters = NO_CHARACTERS,
  isTaken = neverTaken,
  onEditFormula,
}: CellRowProps) {
  const ui = useUiStore();
  const port = useInspectorWrites(session);
  const [editorState, setEditor] = useState<ValueEditor | null>(null);
  const [renameState, setRename] = useState<RenameEditor | null>(null);

  const caps = cellCapabilities(name, cell, { readOnly });
  const address: CellAddress = { object, cell: name };
  const structural = STRUCTURAL_CELL_NAMES.has(name);
  // An open editor closes, uncommitted, once editing is no longer allowed
  // (view-as switched to a character, M4-D11).
  const editor = caps.literal ? editorState : null;
  const rename = !readOnly && !structural ? renameState : null;
  useEffect(() => {
    if (readOnly) {
      setEditor(null);
      setRename(null);
    }
  }, [readOnly]);
  // Drafts belong to their object: a new target discards them uncommitted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on target change
  useEffect(() => {
    setEditor(null);
    setRename(null);
  }, [object, name]);
  const refLabel = inspectorRefLabel(session);
  const revision = () => session.getSnapshot().revision;
  const where = () => `${refLabel(object) ?? object}.${name}`;

  // A row that goes away while hovered clears its hover.
  useEffect(
    () => () => {
      const hovered = ui.getState().hoveredCell;
      if (hovered?.object === object && hovered.cell === name) ui.setHoveredCell(null);
    },
    [ui, object, name],
  );

  const write = (ops: WireOp[], baseRevision: number, label: string) => {
    void port.write(ops, { baseRevision, label });
  };

  // -- value editor

  const openEditor = () => {
    if (!caps.literal || editor !== null) return;
    const input = valueToInputText(cell.value, name);
    setEditor(
      input.kind === "literal"
        ? { initial: input.text, text: input.text, baseRevision: revision() }
        : { initial: "", text: "", reason: input.reason, baseRevision: revision() },
    );
  };

  const commitEditor = (current: ValueEditor) => {
    // A replace-value editor's "" is a placeholder, not the value: anything
    // typed there writes (also `empty`); only an untouched editor writes nothing.
    const unchanged =
      current.reason === undefined
        ? isUnchangedInput(current.initial, current.text, name)
        : current.text === "";
    if (unchanged) {
      setEditor(null);
      return;
    }
    const parsed = parseCellInput(current.text, { cell: name });
    if (!parsed.ok) {
      setEditor({ ...current, error: parsed.message });
      return;
    }
    if (parsed.content.type === "formula" && !caps.formula) {
      setEditor({ ...current, error: `${name} cannot hold a formula.` });
      return;
    }
    setEditor(null);
    const label =
      parsed.content.type === "formula" ? `Set formula of ${where()}` : `Set ${where()}`;
    write(cellInputToOps(object, name, parsed.content, cell), current.baseRevision, label);
  };

  const onEditorKey = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (editor === null) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commitEditor(editor);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditor(null);
    }
  };

  // -- rename

  const commitRename = (current: RenameEditor) => {
    if (current.text === name) {
      setRename(null);
      return;
    }
    const problem = cellNameProblem(current.text, isTaken);
    if (problem !== null) {
      setRename({ ...current, error: problem });
      return;
    }
    setRename(null);
    write(
      [{ type: "rename_cell", object, from: name, to: current.text }],
      current.baseRevision,
      `Rename ${where()} to ${current.text}`,
    );
  };

  const onRenameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (rename === null) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename(rename);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setRename(null);
    }
  };

  // -- commands (the revision is captured at the click)

  const clearOverride = () =>
    write(
      [{ type: "clear_override", object, cell: name }],
      revision(),
      `Clear override on ${where()}`,
    );

  const replaceValue = storableValue(cell.value);
  const replaceFormula = () => {
    if (replaceValue === null) return;
    write(
      replaceFormulaOps(object, name, replaceValue),
      revision(),
      `Replace formula of ${where()}`,
    );
  };

  const editFormula = () => {
    ui.focusCell(address);
    onEditFormula?.(address);
  };

  const deleteCell = () =>
    write([{ type: "delete_cell", object, cell: name }], revision(), `Delete ${where()}`);

  const setViewers = (next: InputViewers | null) => {
    if (next === null) return;
    write(cellInputToOps(object, name, next, cell), revision(), `Set ${where()}`);
  };

  // -- hover and focus

  const onEnter = () => ui.setHoveredCell(address);
  const onLeave = () => {
    const hovered = ui.getState().hoveredCell;
    if (hovered?.object === object && hovered.cell === name) ui.setHoveredCell(null);
  };

  // -- value

  const value = cell.value;
  const origin = value.type === "error" ? value.origin : undefined;
  const formatted = formatValue(value.type === "error" ? withoutOrigin(value) : value, {
    mode: "full",
    refLabel,
  });

  const goToOrigin = (event: MouseEvent) => {
    event.stopPropagation();
    if (origin === undefined) return;
    const view = session.objectView(origin.object);
    ui.select([origin.object]);
    if (view === null || Object.hasOwn(view.cells, origin.cell)) {
      ui.focusCell({ object: origin.object, cell: origin.cell });
    }
  };
  const originExists =
    origin !== undefined &&
    (session.objectView(origin.object) !== null || session.directory().has(origin.object));

  // A drag source of the cell for face layouts (vtt-1xv.27), GM view only.
  const draggable = !readOnly && editor === null && rename === null;
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(CELL_DRAG_MIME, cellDragData(object, name));
    event.dataTransfer.effectAllowed = "copy";
  };

  const isFormula = cell.kind === "formula";
  const showSource = !readOnly && isFormula && cell.source !== undefined;
  const visibility = !readOnly ? cell.visibility : undefined;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard focus of cells is the formula bar's
    <li
      data-cell={name}
      style={ROW_STYLE}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={() => ui.focusCell(address)}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
    >
      {rename === null ? (
        <span style={NAME_STYLE}>{name}</span>
      ) : (
        <span>
          <input
            aria-label={`Rename ${name}`}
            value={rename.text}
            // biome-ignore lint/a11y/noAutofocus: the rename editor opens on request
            autoFocus
            onChange={(e) => setRename({ ...rename, text: e.target.value, error: undefined })}
            onKeyDown={onRenameKey}
          />
          {rename.error !== undefined && (
            <span role="alert" style={NOTE_STYLE}>
              {rename.error}
            </span>
          )}
        </span>
      )}
      {showSource && (
        <>
          <span style={BADGE_STYLE} title="formula">
            ƒ
          </span>
          <code style={SOURCE_STYLE}>={cell.source}</code>
        </>
      )}
      {editor === null ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: double-click opens the editor; the formula bar is the keyboard path
        <span
          data-part="value"
          data-tone={formatted.tone}
          style={{ color: TONE_COLORS[formatted.tone], cursor: caps.literal ? "text" : "default" }}
          onDoubleClick={openEditor}
        >
          {formatted.text}
        </span>
      ) : (
        <span>
          {editor.initial.includes("\n") ? (
            <textarea
              aria-label={`Value of ${name}`}
              value={editor.text}
              // biome-ignore lint/a11y/noAutofocus: the editor opens on double-click
              autoFocus
              onChange={(e) => setEditor({ ...editor, text: e.target.value, error: undefined })}
              onKeyDown={onEditorKey}
            />
          ) : (
            <input
              aria-label={`Value of ${name}`}
              value={editor.text}
              // biome-ignore lint/a11y/noAutofocus: the editor opens on double-click
              autoFocus
              onChange={(e) => setEditor({ ...editor, text: e.target.value, error: undefined })}
              onKeyDown={onEditorKey}
            />
          )}
          {editor.reason !== undefined && (
            <span style={NOTE_STYLE}>{editor.reason}: type a value to replace it</span>
          )}
          {editor.error !== undefined && (
            <span role="alert" style={NOTE_STYLE}>
              {editor.error}
            </span>
          )}
        </span>
      )}
      {origin !== undefined && (
        <button type="button" style={NOTE_STYLE} disabled={!originExists} onClick={goToOrigin}>
          from {refLabel(origin.object) ?? origin.object}.{origin.cell}
        </button>
      )}
      {visibility !== undefined && (
        <span
          role="img"
          style={NOTE_STYLE}
          aria-label={`Visible to ${formatValue(visibility, { mode: "full", refLabel }).text}`}
          title={`Visible to ${formatValue(visibility, { mode: "full", refLabel }).text}`}
        >
          👁
        </span>
      )}
      {!readOnly && cell.overridden === true && (
        <span style={NOTE_STYLE}>
          <span>{OVERRIDE_TEXT}</span>{" "}
          <button type="button" onClick={clearOverride}>
            Clear override
          </button>
        </span>
      )}
      {isFormula && caps.formula && (
        <button type="button" style={NOTE_STYLE} onClick={editFormula}>
          Edit formula
        </button>
      )}
      {caps.replace && (
        <button
          type="button"
          style={NOTE_STYLE}
          disabled={replaceValue === null}
          title={replaceValue === null ? "This value cannot be stored." : undefined}
          onClick={replaceFormula}
        >
          Replace formula with value
        </button>
      )}
      {!readOnly && !structural && rename === null && (
        <>
          <button
            type="button"
            style={NOTE_STYLE}
            onClick={() => setRename({ text: name, baseRevision: revision() })}
          >
            Rename
          </button>
          <button type="button" style={NOTE_STYLE} onClick={deleteCell}>
            Delete
          </button>
        </>
      )}
      {name === "visible_to" && caps.literal && (
        <ViewersPicker
          label="Viewers of visible_to"
          value={value.type === "viewers" ? value : null}
          onChange={setViewers}
          characters={characters}
          allowDefault={false}
        />
      )}
    </li>
  );
}

function withoutOrigin(error: Extract<WireResult, { type: "error" }>): WireResult {
  const { origin: _origin, ...rest } = error;
  return rest;
}
