/**
 * The inspector panel (vtt-3l6.12; DESIGN.md §4.6 The inspector and View as
 * in the UI, M4-D11; §4.4; §4.8 the log panel, M5 composition vtt-1xv.23):
 * three tabs, "Inspector", "Objects" (the `ObjectList`) and "Log"
 * (vtt-1xv.20's `LogPanel`, mounted while its tab is shown). The Inspector
 * tab shows "Nothing selected"; for two or more selected objects a header
 * "N objects" and the `MultiCellList` of their shared cells (vtt-qf5.15,
 * M6-D36), nothing else; or for one selected
 * object its `ObjectHeader`, `CellList` (vtt-3l6.11), `ContentsList`,
 * `ActionsList` (vtt-1xv.19, given the app's face policy and runtime) and
 * `FaceSection` (vtt-1xv.18), all from the current viewer's view of the
 * object (`session.objectView`). While viewing as a
 * character everything is read-only and shows the character's view.
 * Instantaneous commands capture `baseRevision` at the click.
 *
 * The panel provides the session and the `UiStore` to the hooks of its
 * children (a `TableProvider`), so it can be mounted alone.
 */
import type { ObjectId } from "@vtt/schema";
import { type CSSProperties, useState } from "react";
import type { FacePolicy } from "../face/face-contracts";
import { FaceSection } from "../face-editor/FaceSection";
import type { InteractionRuntime } from "../interaction/runtime";
import { LogPanel } from "../log/LogPanel";
import { TableProvider, useSession, useUi } from "../session/hooks";
import type { TableSession } from "../session/table-session";
import type { CellAddress, UiStore } from "../state/ui-state";
import { ActionsList } from "./ActionsList";
import { CellList } from "./CellList";
import { ContentsList } from "./ContentsList";
import { MultiCellList } from "./MultiCellList";
import { ObjectHeader } from "./ObjectHeader";
import { ObjectList } from "./ObjectList";

export interface InspectorProps {
  session: TableSession;
  ui: UiStore;
  /** Called by a cell row's "Edit formula" after focusing the cell (the formula bar's cue). */
  onEditFormula?: (cell: CellAddress) => void;
  /** Whether actions may be run (`ActionsList`'s `policy`; the app's binder policy). */
  policy?: FacePolicy;
  /** Executes Run's effects (the app's interaction runtime); without it there is no Run. */
  runtime?: Pick<InteractionRuntime, "execute">;
}

/** The selection text for `count` selected objects other than one (the multi-selection header). */
export function selectionText(count: number): string {
  return count === 0 ? "Nothing selected" : `${count} objects`;
}

type Tab = "inspector" | "objects" | "log";

const TAB_LIST_STYLE: CSSProperties = { display: "flex", gap: "0.25em", marginBottom: "0.5em" };
const NOTE_STYLE: CSSProperties = { opacity: 0.7 };

export function Inspector(props: InspectorProps) {
  const { session, ui } = props;
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
          {tabButton("log", "Log")}
        </div>
        <div role="tabpanel" id={`inspector-panel-${tab}`} aria-labelledby={`inspector-tab-${tab}`}>
          {tab === "inspector" ? (
            <SelectionInspector {...props} />
          ) : tab === "objects" ? (
            <ObjectList session={session} ui={ui} />
          ) : (
            <LogPanel session={session} ui={ui} />
          )}
        </div>
      </aside>
    </TableProvider>
  );
}

function SelectionInspector({ session, ui, onEditFormula, policy, runtime }: InspectorProps) {
  const selection = useUi((s) => s.selection);
  // Re-render on every view change (commits, view switches, resyncs).
  useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  if (selection.length === 0) return <p style={NOTE_STYLE}>{selectionText(0)}</p>;
  if (selection.length > 1) {
    const objects = selection.flatMap((id) => {
      const view = session.objectView(id);
      return view === null ? [] : [{ id, view }];
    });
    return (
      <div>
        <section aria-label="Selection">
          <h3 style={{ margin: 0 }}>{selectionText(selection.length)}</h3>
        </section>
        <MultiCellList objects={objects} session={session} readOnly={viewer.type !== "gm"} />
      </div>
    );
  }
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
      <ActionsList
        view={view}
        gm={gm}
        {...(policy === undefined ? {} : { policy })}
        {...(runtime === undefined ? {} : { runtime })}
      />
      <FaceSection session={session} ui={ui} />
    </div>
  );
}
