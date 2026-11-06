/**
 * The inspector's multi-selection mode (vtt-qf5.15; DESIGN.md §4.6 The
 * inspector, §8.1; M6-D36): with two or more objects selected, a header "N
 * objects" and a "Shared cells" list of the user cells whose name is present
 * on every selected object, alphabetically (`sharedCellNames`). Each row
 * shows the shared value when every object's agrees, else the placeholder
 * `MIXED_TEXT` (`sharedCell`).
 *
 * Every row is editable (double-click its value, as a `CellRow`); a shared
 * formula source is shown with the `ƒ` badge, any other mix of literals and
 * formulas as "mixed" until the user types. An untouched editor writes
 * nothing, except over a shared formula's prefilled value, which is an
 * override as on a `CellRow`; a touched one writes unless it holds an agreed
 * literal unchanged, so a cleared prefilled value writes `empty` to every
 * object (an override on a formula, DESIGN.md §4.6). Enter writes the value editor's input (`parseCellInput`: a
 * literal, or after `=` a formula) to every selected object as one write,
 * one `cellInputToOps` per object, labelled "Set <cell> on N objects": one
 * group, one undo. The write carries the revision captured when the editor
 * opened. Read-only (view-as, M4-D11) shows values only. There are no
 * actions, contents or face sections in this mode.
 */
import type { CellView, ObjectView, WireResult } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { type CSSProperties, type KeyboardEvent, useEffect, useState } from "react";
import { useSession } from "../session/hooks";
import type { TableSession } from "../session/table-session";
import { formatValue } from "../values/format";
import {
  cellCapabilities,
  isUnchangedInput,
  parseCellInput,
  valueToInputText,
} from "../values/input";
import { cellInputToOps } from "../values/ops";
import { userCellNames } from "./CellList";
import { inspectorRefLabel, TONE_COLORS, useInspectorWrites } from "./CellRow";

/** What a row shows when the selected objects' values (or formulas) differ. */
export const MIXED_TEXT = "mixed";

/** The user cell names present on every view, in `userCellNames` order. */
export function sharedCellNames(views: readonly ObjectView[]): string[] {
  const [first, ...rest] = views;
  if (first === undefined) return [];
  return userCellNames(first).filter((name) => rest.every((v) => Object.hasOwn(v.cells, name)));
}

/**
 * A shared cell: `literal` when no object's cell is a formula (or the view
 * carries no formula source, as in view-as), `formula` when
 * all are formulas with one source, else `mixed`. `value` is the common
 * value, or null when the values differ (the row shows `MIXED_TEXT`).
 */
export type SharedCell =
  | { kind: "literal"; value: WireResult | null }
  | { kind: "formula"; source: string; value: WireResult | null }
  | { kind: "mixed" };

export function sharedCell(cells: readonly CellView[]): SharedCell {
  const first = cells[0];
  if (first === undefined) return { kind: "mixed" };
  const agree = cells.every((c) => sameValue(c.value, first.value));
  const value = agree ? first.value : null;
  // A view without formula sources (view-as) compares values only.
  if (cells.every((c) => c.kind !== "formula" || c.source === undefined)) {
    return { kind: "literal", value };
  }
  const source = first.source;
  if (source !== undefined && cells.every((c) => c.kind === "formula" && c.source === source)) {
    return { kind: "formula", source, value };
  }
  return { kind: "mixed" };
}

/** Structural equality of two wire values (plain JSON data). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.hasOwn(b, k) &&
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export interface MultiCellListProps {
  /** The selected objects, with the current viewer's view of each, in selection order. */
  objects: readonly { id: ObjectId; view: ObjectView }[];
  session: TableSession;
  /** View-as: values only, no edits. */
  readOnly?: boolean;
}

const LIST_STYLE: CSSProperties = { margin: 0, padding: 0 };
const ROW_STYLE: CSSProperties = { listStyle: "none", padding: "2px 0" };
const NAME_STYLE: CSSProperties = { fontWeight: 600, marginRight: "0.5em" };
const BADGE_STYLE: CSSProperties = { fontStyle: "italic", marginRight: "0.25em" };
const SOURCE_STYLE: CSSProperties = { marginRight: "0.5em" };
const NOTE_STYLE: CSSProperties = { fontSize: "0.85em", marginLeft: "0.5em" };
const EMPTY_STYLE: CSSProperties = { opacity: 0.7 };

export function MultiCellList({ objects, session, readOnly = false }: MultiCellListProps) {
  // Re-render on view changes.
  useSession((s) => s.viewVersion);
  const names = sharedCellNames(objects.map((o) => o.view));
  return (
    <section aria-label="Shared cells">
      <h4 style={{ margin: 0 }}>Shared cells</h4>
      {names.length === 0 ? (
        <p style={EMPTY_STYLE}>No cell is on every selected object.</p>
      ) : (
        <ul style={LIST_STYLE}>
          {names.map((name) => (
            <SharedCellRow
              key={name}
              name={name}
              objects={objects.map((o) => o.id)}
              cells={objects.map((o) => o.view.cells[name] as CellView)}
              session={session}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface Editor {
  readonly initial: string;
  readonly text: string;
  /** Whether the user has typed (or cleared) anything. */
  readonly touched: boolean;
  readonly error?: string;
  readonly baseRevision: number;
}

function SharedCellRow({
  name,
  objects,
  cells,
  session,
  readOnly,
}: {
  name: string;
  objects: readonly ObjectId[];
  cells: readonly CellView[];
  session: TableSession;
  readOnly: boolean;
}) {
  const port = useInspectorWrites(session);
  const [editorState, setEditor] = useState<Editor | null>(null);
  const shared = sharedCell(cells);
  const caps = cellCapabilities(name, cells[0], { readOnly });
  const editable = caps.literal;
  // An open editor closes, uncommitted, once editing is no longer allowed.
  const editor = editable ? editorState : null;
  // A new selection discards a draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on target change
  useEffect(() => setEditor(null), [objects.join("\u0000"), name]);

  const value = shared.kind === "mixed" ? null : shared.value;
  const openEditor = () => {
    if (!editable || editor !== null) return;
    const input = value === null ? null : valueToInputText(value, name);
    const text = input?.kind === "literal" ? input.text : "";
    setEditor({
      initial: text,
      text,
      touched: false,
      baseRevision: session.getSnapshot().revision,
    });
  };

  const commit = (current: Editor) => {
    // Untouched: nothing, unless a shared formula's prefilled value (an
    // override, as on a cell row). Touched: anything but an agreed literal
    // left as it was, so a cleared value writes `empty` everywhere.
    const unchanged = !current.touched
      ? !(shared.kind === "formula" && current.initial !== "")
      : shared.kind === "literal" &&
        value !== null &&
        isUnchangedInput(current.initial, current.text, name);
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
    const ops = objects.flatMap((object, i) =>
      cellInputToOps(object, name, parsed.content, cells[i]),
    );
    void port.write(ops, {
      baseRevision: current.baseRevision,
      label: `Set ${name} on ${objects.length} objects`,
    });
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (editor === null) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit(editor);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditor(null);
    }
  };

  const formatted =
    value === null
      ? { text: MIXED_TEXT, tone: "muted" as const }
      : formatValue(value, { mode: "full", refLabel: inspectorRefLabel(session) });

  return (
    <li data-cell={name} style={ROW_STYLE}>
      <span style={NAME_STYLE}>{name}</span>
      {shared.kind === "formula" && !readOnly && (
        <>
          <span style={BADGE_STYLE} title="formula">
            ƒ
          </span>
          <code style={SOURCE_STYLE}>={shared.source}</code>
        </>
      )}
      {editor === null ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: double-click opens the editor, as on a cell row
        <span
          data-part="value"
          data-tone={formatted.tone}
          data-mixed={value === null ? "true" : undefined}
          style={{ color: TONE_COLORS[formatted.tone], cursor: editable ? "text" : "default" }}
          onDoubleClick={openEditor}
        >
          {formatted.text}
        </span>
      ) : (
        <span>
          <input
            aria-label={`Value of ${name}`}
            value={editor.text}
            placeholder={value === null ? MIXED_TEXT : undefined}
            // biome-ignore lint/a11y/noAutofocus: the editor opens on double-click
            autoFocus
            onChange={(e) =>
              setEditor({ ...editor, text: e.target.value, touched: true, error: undefined })
            }
            onKeyDown={onKey}
          />
          {editor.error !== undefined && (
            <span role="alert" style={NOTE_STYLE}>
              {editor.error}
            </span>
          )}
        </span>
      )}
    </li>
  );
}
