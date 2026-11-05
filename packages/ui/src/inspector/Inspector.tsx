/**
 * The inspector panel (vtt-3l6.12; DESIGN.md §4.6 The inspector and View as
 * in the UI, M4-D11; §4.4): two tabs, "Inspector" and "Objects" (the
 * `ObjectList`). The Inspector tab shows "Nothing selected", "N objects
 * selected", or for one selected object its `ObjectHeader`, `CellList`
 * (vtt-3l6.11), `ContentsList` and `ActionsList`, all from the current
 * viewer's view of the object (`session.objectView`). While viewing as a
 * character everything is read-only and shows the character's view.
 * Instantaneous commands capture `baseRevision` at the click.
 *
 * The panel provides the session and the `UiStore` to the hooks of its
 * children (a `TableProvider`), so it can be mounted alone.
 */
import type { ObjectId } from "@vtt/schema";
import { type CSSProperties, useState } from "react";
import { TableProvider, useSession, useUi } from "../session/hooks";
import type { TableSession } from "../session/table-session";
import type { CellAddress, UiStore } from "../state/ui-state";
import { ActionsList } from "./ActionsList";
import { CellList } from "./CellList";
import { ContentsList } from "./ContentsList";
import { ObjectHeader } from "./ObjectHeader";
import { ObjectList } from "./ObjectList";

export interface InspectorProps {
  session: TableSession;
  ui: UiStore;
  /** Called by a cell row's "Edit formula" after focusing the cell (the formula bar's cue). */
  onEditFormula?: (cell: CellAddress) => void;
}

/** The selection text for `count` selected objects other than one. */
export function selectionText(count: number): string {
  return count === 0 ? "Nothing selected" : `${count} objects selected`;
}

type Tab = "inspector" | "objects";

const TAB_LIST_STYLE: CSSProperties = { display: "flex", gap: "0.25em", marginBottom: "0.5em" };
const NOTE_STYLE: CSSProperties = { opacity: 0.7 };

export function Inspector({ session, ui, onEditFormula }: InspectorProps) {
  const [tab, setTab] = useState<Tab>("inspector");
  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`inspector-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`inspector-panel-${id}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );
  return (
    <TableProvider session={session} ui={ui}>
      <aside aria-label="Inspector panel">
        <div role="tablist" style={TAB_LIST_STYLE}>
          {tabButton("inspector", "Inspector")}
          {tabButton("objects", "Objects")}
        </div>
        <div role="tabpanel" id={`inspector-panel-${tab}`} aria-labelledby={`inspector-tab-${tab}`}>
          {tab === "inspector" ? (
            <SelectionInspector
              session={session}
              ui={ui}
              {...(onEditFormula === undefined ? {} : { onEditFormula })}
            />
          ) : (
            <ObjectList session={session} ui={ui} />
          )}
        </div>
      </aside>
    </TableProvider>
  );
}

function SelectionInspector({ session, ui, onEditFormula }: InspectorProps) {
  const selection = useUi((s) => s.selection);
  // Re-render on every view change (commits, view switches, resyncs).
  useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  if (selection.length !== 1) return <p style={NOTE_STYLE}>{selectionText(selection.length)}</p>;
  const object = selection[0] as ObjectId;
  const view = session.objectView(object);
  if (view === null) {
    return <p style={NOTE_STYLE}>{object}: not in the current view</p>;
  }
  const gm = viewer.type === "gm";
  const readOnly = !gm;
  return (
    // Keyed by object, so per-object local state (a drag, an open editor) never carries over.
    <div key={object}>
      <ObjectHeader object={object} view={view} session={session} readOnly={readOnly} />
      <CellList
        object={object}
        view={view}
        session={session}
        readOnly={readOnly}
        {...(onEditFormula === undefined ? {} : { onEditFormula })}
      />
      <ContentsList object={object} view={view} session={session} ui={ui} readOnly={readOnly} />
      <ActionsList view={view} gm={gm} />
    </div>
  );
}
