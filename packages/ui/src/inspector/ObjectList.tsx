/**
 * The inspector's object list (vtt-3l6.12; review r1 finding 6, r2 finding
 * 10; DESIGN.md §4.4, §4.6; FORMULAS.md §5 query order): the objects
 * directly on the active board in the current view, topmost first (the
 * reverse of the scene's draw order), labelled with
 * `session.refLabel(viewer, id)`, zones marked. A click selects (Shift
 * toggles the row in the selection); hovering a zone row sets
 * `UiStore.hoveredZone` and leaving it clears it, so a room zone lying under
 * a map image can be selected and traced without the canvas.
 */
import type { BoardId, ObjectId } from "@vtt/schema";
import {
  type CSSProperties,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { buildScene } from "../scene/scene";
import type { TableSession } from "../session/table-session";
import type { UiStore } from "../state/ui-state";

export interface ObjectListProps {
  session: TableSession;
  ui: UiStore;
}

/** A row of the object list. */
export interface BoardObjectEntry {
  readonly id: ObjectId;
  readonly label: string;
  readonly isZone: boolean;
}

/** The objects directly on the active board in the session's current view, topmost first. */
export function boardObjectEntries(session: TableSession): BoardObjectEntry[] {
  const board = session.boardView();
  if (board === null) return [];
  const viewer = session.getSnapshot().viewer;
  const scene = buildScene({
    views: board.objects.values(),
    covers: [],
    board: board.board as BoardId,
    viewer,
  });
  return scene.items
    .map((item) => ({ id: item.id, label: session.refLabel(viewer, item.id), isZone: item.isZone }))
    .reverse();
}

const LIST_STYLE: CSSProperties = { margin: 0, padding: 0 };
const ROW_BUTTON_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  textAlign: "left",
};
const ZONE_STYLE: CSSProperties = {
  fontSize: "0.75em",
  marginLeft: "0.5em",
  padding: "0 0.3em",
  border: "1px dashed currentColor",
  borderRadius: "0.3em",
};

export function ObjectList({ session, ui }: ObjectListProps) {
  const subscribeSession = useCallback((fn: () => void) => session.subscribe(fn), [session]);
  useSyncExternalStore(subscribeSession, () => session.getSnapshot().viewVersion);
  const subscribeUi = useCallback((fn: () => void) => ui.subscribe(fn), [ui]);
  const selection = useSyncExternalStore(subscribeUi, () => ui.getState().selection);
  const entries = boardObjectEntries(session);
  // The zone row under the pointer, cleared when the list unmounts.
  const hovered = useRef<ObjectId | null>(null);
  useEffect(
    () => () => {
      if (hovered.current !== null && ui.getState().hoveredZone === hovered.current) {
        ui.setHoveredZone(null);
      }
    },
    [ui],
  );

  const select = (id: ObjectId) => (event: MouseEvent) => {
    if (event.shiftKey) {
      const current = ui.getState().selection;
      ui.select(current.includes(id) ? current.filter((s) => s !== id) : [...current, id]);
    } else {
      ui.select([id]);
    }
  };

  return (
    <ul aria-label="Objects on the board" style={LIST_STYLE}>
      {entries.map((entry) => (
        <li
          key={entry.id}
          data-object={entry.id}
          data-selected={selection.includes(entry.id) || undefined}
          style={{
            listStyle: "none",
            fontWeight: selection.includes(entry.id) ? 600 : undefined,
          }}
          {...(entry.isZone
            ? {
                onMouseEnter: () => {
                  hovered.current = entry.id;
                  ui.setHoveredZone(entry.id);
                },
                onMouseLeave: () => {
                  hovered.current = null;
                  if (ui.getState().hoveredZone === entry.id) ui.setHoveredZone(null);
                },
              }
            : {})}
        >
          <button type="button" style={ROW_BUTTON_STYLE} onClick={select(entry.id)}>
            {entry.label}
            {entry.isZone && <span style={ZONE_STYLE}>zone</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
