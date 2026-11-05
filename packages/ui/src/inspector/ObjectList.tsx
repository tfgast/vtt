/**
 * The inspector's object list (vtt-3l6.12; review r1 finding 6, r2 finding
 * 10; DESIGN.md §4.4, §4.6; FORMULAS.md §5 query order): the objects
 * directly on the active board in the current view (by placement, so an
 * invalid or hidden `position` does not drop a row), topmost first (`z`,
 * then id, descending: the reverse of query order), labelled with
 * `session.refLabel(viewer, id)`, zones marked. A click selects (Shift
 * toggles the row in the selection); hovering a zone row sets
 * `UiStore.hoveredZone` and leaving it clears it, so a room zone lying under
 * a map image can be selected and traced without the canvas. A hover the
 * list set is also cleared when its row disappears or the list unmounts.
 */
import type { ObjectView, WireResult } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import {
  type CSSProperties,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
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

/** A `z` as query order reads it: a finite number, a roll as its total, anything else 0. */
function orderZ(v: WireResult | undefined): number {
  const n = v?.type === "number" ? v.value : v?.type === "roll" ? v.total : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Ids compared by code point (FORMULAS.md §5). */
function compareIds(a: string, b: string): number {
  const ai = Array.from(a, (c) => c.codePointAt(0) as number);
  const bi = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
    if (ai[i] !== bi[i]) return (ai[i] as number) < (bi[i] as number) ? -1 : 1;
  }
  return ai.length - bi.length;
}

/**
 * Whether `view` is directly on `board`: its `board` cell names the board
 * and its `container` is not a ref. Placement only, never geometry: an
 * object whose `position` is invalid or hidden from the viewer is still on
 * the board.
 */
function directlyOn(view: ObjectView, board: BoardId): boolean {
  const boardCell = view.cells.board?.value;
  const container = view.cells.container?.value;
  return boardCell?.type === "ref" && boardCell.object === board && container?.type !== "ref";
}

function isZoneView(view: ObjectView): boolean {
  const v = view.cells.is_zone?.value;
  return v?.type === "boolean" && v.value;
}

/**
 * The objects directly on the active board in the session's current view,
 * topmost first: by `z` descending (as query order reads it), then by id
 * descending, the reverse of FORMULAS.md §5's order.
 */
export function boardObjectEntries(session: TableSession): BoardObjectEntry[] {
  const board = session.boardView();
  if (board === null) return [];
  const viewer = session.getSnapshot().viewer;
  const views = [...board.objects.values()].filter((view) => directlyOn(view, board.board));
  views.sort((a, b) => {
    const za = orderZ(a.cells.z?.value);
    const zb = orderZ(b.cells.z?.value);
    return za !== zb ? (za > zb ? -1 : 1) : compareIds(b.id, a.id);
  });
  return views.map((view) => ({
    id: view.id,
    label: session.refLabel(viewer, view.id),
    isZone: isZoneView(view),
  }));
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
  // A hovered zone row that is no longer listed (removed, hidden, another board or
  // viewer) gives up the hover it set; a hover set by someone else is left alone.
  const zoneKey = entries
    .filter((e) => e.isZone)
    .map((e) => e.id)
    .join("\u0000");
  useEffect(() => {
    const id = hovered.current;
    if (id === null || zoneKey.split("\u0000").includes(id)) return;
    hovered.current = null;
    if (ui.getState().hoveredZone === id) ui.setHoveredZone(null);
  }, [zoneKey, ui]);
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
