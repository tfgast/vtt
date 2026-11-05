/**
 * The inspector's cell list (vtt-3l6.11; DESIGN.md §4.4, §4.6 The inspector
 * and View as in the UI, M4-D11, M4-D12; FORMULAS.md §3.1; PROTOCOL.md §5,
 * §7.2): the user cells alphabetically, then a collapsible "Structural"
 * group in FORMULAS §3.1 order (`id` from `view.id`), each a `CellRow`; then,
 * for the GM, "Add cell" and the "Visibility rules" section, which lists
 * every per-cell visibility entry of the object (also for absent cells, from
 * the GM view's `absent_cell_visibility`) with a picker and "Clear", and adds
 * a rule for any valid cell name. Read-only (view-as) shows values only.
 * Every command captures the revision at the click.
 */
import type { CellView, InputViewers, ObjectView, WireViewers } from "@vtt/protocol";
import { type ObjectId, STRUCTURAL_CELLS } from "@vtt/schema";
import { type CSSProperties, type FormEvent, useState } from "react";
import { useSession } from "../session/hooks";
import type { TableSession } from "../session/table-session";
import type { CellAddress } from "../state/ui-state";
import {
  CellRow,
  cellNameProblem,
  inspectorRefLabel,
  STRUCTURAL_CELL_NAMES,
  useInspectorWrites,
} from "./CellRow";
import { type ViewerCharacter, ViewersPicker } from "./ViewersPicker";

export interface CellListProps {
  object: ObjectId;
  /** The current viewer's view of `object`. */
  view: ObjectView;
  session: TableSession;
  /** Character view (view-as): values only, no edits, no source, no visibility. */
  readOnly?: boolean;
  /** Called by a row's "Edit formula" after focusing the cell. */
  onEditFormula?: (cell: CellAddress) => void;
}

/** A per-cell visibility entry of an object, present cell or absent. */
export interface VisibilityRule {
  readonly cell: string;
  readonly viewers: WireViewers;
}

/** User cell names alphabetically (case-insensitive, then by code units). */
export function userCellNames(view: ObjectView): string[] {
  return Object.keys(view.cells)
    .filter((name) => !STRUCTURAL_CELL_NAMES.has(name))
    .sort(alphabetical);
}

/** Structural cell names of the view in FORMULAS §3.1 order; `id` always (from `view.id`). */
export function structuralCellNames(view: ObjectView): string[] {
  return STRUCTURAL_CELLS.map((spec) => spec.name).filter(
    (name) => name === "id" || Object.hasOwn(view.cells, name),
  );
}

/** Every per-cell visibility entry of the view (cells' `visibility` and `absent_cell_visibility`), by name. */
export function visibilityRules(view: ObjectView): VisibilityRule[] {
  const rules: VisibilityRule[] = [];
  for (const [cell, cellView] of Object.entries(view.cells)) {
    if (cellView.visibility !== undefined) rules.push({ cell, viewers: cellView.visibility });
  }
  for (const [cell, viewers] of Object.entries(view.absent_cell_visibility ?? {})) {
    if (!Object.hasOwn(view.cells, cell)) rules.push({ cell, viewers });
  }
  return rules.sort((a, b) => alphabetical(a.cell, b.cell));
}

function alphabetical(a: string, b: string): number {
  const folded = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  if (folded !== 0) return folded;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The directory's characters (not templates), labelled for `session`'s viewer, by label. */
function directoryCharacters(session: TableSession): ViewerCharacter[] {
  const viewer = session.getSnapshot().viewer;
  const characters: ViewerCharacter[] = [];
  for (const view of session.directory().values()) {
    if (view.is_character && !view.is_template) {
      characters.push({ id: view.id, label: session.refLabel(viewer, view.id) });
    }
  }
  return characters.sort((a, b) => alphabetical(a.label, b.label) || alphabetical(a.id, b.id));
}

const LIST_STYLE: CSSProperties = { margin: 0, padding: 0 };
const SECTION_STYLE: CSSProperties = { marginTop: "0.75em" };
const NOTE_STYLE: CSSProperties = { fontSize: "0.85em", marginLeft: "0.5em" };
const GROUP_BUTTON_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};

export function CellList({
  object,
  view,
  session,
  readOnly = false,
  onEditFormula,
}: CellListProps) {
  // Re-render on view changes (the directory's characters and labels).
  useSession((s) => s.viewVersion);
  const [structuralOpen, setStructuralOpen] = useState(true);
  const characters = readOnly ? [] : directoryCharacters(session);
  const isTaken = (name: string) =>
    Object.hasOwn(view.cells, name) || STRUCTURAL_CELL_NAMES.has(name);

  const rowProps = {
    object,
    session,
    readOnly,
    characters,
    isTaken,
    ...(onEditFormula === undefined ? {} : { onEditFormula }),
  };
  const cellOf = (name: string): CellView | undefined =>
    name === "id"
      ? { kind: "structural", value: { type: "text", value: view.id } }
      : view.cells[name];

  const rows = (names: readonly string[]) =>
    names.map((name) => {
      const cell = cellOf(name);
      return cell === undefined ? null : (
        <CellRow key={name} name={name} cell={cell} {...rowProps} />
      );
    });

  return (
    <section aria-label="Cells">
      <ul style={LIST_STYLE}>{rows(userCellNames(view))}</ul>
      <div style={SECTION_STYLE}>
        <button
          type="button"
          style={GROUP_BUTTON_STYLE}
          aria-expanded={structuralOpen}
          onClick={() => setStructuralOpen((open) => !open)}
        >
          Structural
        </button>
        {structuralOpen && <ul style={LIST_STYLE}>{rows(structuralCellNames(view))}</ul>}
      </div>
      {!readOnly && (
        <>
          <AddCell object={object} session={session} isTaken={isTaken} />
          <VisibilityRules object={object} view={view} session={session} characters={characters} />
        </>
      )}
    </section>
  );
}

function AddCell({
  object,
  session,
  isTaken,
}: {
  object: ObjectId;
  session: TableSession;
  isTaken: (name: string) => boolean;
}) {
  const port = useInspectorWrites(session);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const baseRevision = session.getSnapshot().revision;
    const problem = cellNameProblem(name, isTaken);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setName("");
    setError(null);
    const label = `Add cell ${inspectorRefLabel(session)(object) ?? object}.${name}`;
    void port.write([{ type: "set_value", object, cell: name, value: { type: "empty" } }], {
      baseRevision,
      label,
    });
  };

  return (
    <form style={SECTION_STYLE} onSubmit={submit}>
      <input
        aria-label="New cell name"
        placeholder="New cell name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
      />{" "}
      <button type="submit">Add cell</button>
      {error !== null && (
        <span role="alert" style={NOTE_STYLE}>
          {error}
        </span>
      )}
    </form>
  );
}

function VisibilityRules({
  object,
  view,
  session,
  characters,
}: {
  object: ObjectId;
  view: ObjectView;
  session: TableSession;
  characters: readonly ViewerCharacter[];
}) {
  const port = useInspectorWrites(session);
  const [name, setName] = useState("");
  const [viewers, setViewers] = useState<InputViewers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const objectLabel = inspectorRefLabel(session)(object) ?? object;

  const setRule = (cell: string, next: InputViewers | null) => {
    const label =
      next === null
        ? `Clear visibility of ${objectLabel}.${cell}`
        : `Set visibility of ${objectLabel}.${cell}`;
    void port.write([{ type: "set_cell_visibility", object, cell, viewers: next }], {
      baseRevision: session.getSnapshot().revision,
      label,
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Any valid name: present or absent, user or structural (DESIGN.md §4.4).
    const problem = cellNameProblem(name, () => false);
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (viewers === null) {
      setError("Choose at least one viewer.");
      return;
    }
    setRule(name, viewers);
    setName("");
    setViewers(null);
    setError(null);
  };

  return (
    <section aria-label="Visibility rules" style={SECTION_STYLE}>
      <h4 style={{ margin: 0 }}>Visibility rules</h4>
      <ul style={LIST_STYLE}>
        {visibilityRules(view).map((rule) => (
          <li key={rule.cell} data-rule={rule.cell} style={{ listStyle: "none" }}>
            <span style={{ fontWeight: 600 }}>{rule.cell}</span>
            <ViewersPicker
              label={`Visibility of ${rule.cell}`}
              value={rule.viewers}
              onChange={(next) => setRule(rule.cell, next)}
              characters={characters}
            />
            <button type="button" onClick={() => setRule(rule.cell, null)}>
              Clear
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input
          aria-label="Rule cell name"
          placeholder="Cell name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <ViewersPicker
          label="New rule viewers"
          value={viewers}
          onChange={(next) => {
            setViewers(next);
            setError(null);
          }}
          characters={characters}
          allowDefault={false}
        />
        <button type="submit">Add visibility rule</button>
        {error !== null && (
          <span role="alert" style={NOTE_STYLE}>
            {error}
          </span>
        )}
      </form>
    </section>
  );
}
