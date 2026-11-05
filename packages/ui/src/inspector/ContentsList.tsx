/**
 * The inspector's contents list (vtt-3l6.12; DESIGN.md §4.1 Containment, §4.4,
 * §4.6 View as in the UI; M4 plan Q12; review r2 finding 9; PROTOCOL.md §5
 * `reorder`, `move`, §6, §7.3):
 *
 * - the object's `contents` refs in order, labelled with
 *   `session.refLabel(viewer, id)` (the current viewer's views only, so never
 *   the GM directory in view-as); redacted entries read "hidden";
 * - a click selects the entry;
 * - dragging an entry onto another captures the revision and the ordered ids
 *   at drag start and, on the drop, submits `reorder` with the permutation of
 *   those ids against that revision, so a list changed meanwhile by another
 *   client is rejected `stale_write` instead of reordering something else;
 * - "Take out" moves the entry to the board of the outermost container, at
 *   its position + (1, 0); disabled when that chain is not on a board.
 *
 * Read-only (view-as) lists the entries without drag or "Take out".
 */
import type { ObjectView, WireResult, WireValue } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import { type CSSProperties, type DragEvent, useRef } from "react";
import type { TableSession } from "../session/table-session";
import type { UiStore } from "../state/ui-state";
import { inspectorRefLabel, useInspectorWrites } from "./CellRow";

export interface ContentsListProps {
  object: ObjectId;
  /** The current viewer's view of `object`. */
  view: ObjectView;
  session: TableSession;
  ui: UiStore;
  /** View-as: no reorder, no "Take out". */
  readOnly?: boolean;
}

/** One entry of a contents list as the viewer sees it. */
export type ContentsEntry = { type: "ref"; id: ObjectId } | { type: "hidden" };

/** The text shown for a redacted entry. */
export const HIDDEN_ENTRY = "hidden";

/** The entries of the view's `contents`, in order. */
export function contentsEntries(view: ObjectView): ContentsEntry[] {
  const v = view.cells.contents?.value;
  if (v?.type !== "list") return [];
  return v.items.map((item: WireValue) =>
    item.type === "ref" ? { type: "ref", id: item.object } : { type: "hidden" },
  );
}

/**
 * The `reorder` permutation that moves the entry at `from` to `to` in a list
 * of `length` (`after[i] = before[permutation[i]]`, PROTOCOL.md §5).
 */
export function reorderPermutation(length: number, from: number, to: number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  const [moved] = order.splice(from, 1);
  if (moved === undefined) return Array.from({ length }, (_, i) => i);
  order.splice(to, 0, moved);
  return order;
}

const MAX_CHAIN = 1024;

function pair(v: WireResult | undefined): [number, number] | null {
  if (v?.type !== "list" || v.items.length !== 2) return null;
  const [x, y] = v.items;
  if (x?.type !== "number" || y?.type !== "number") return null;
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return null;
  return [x.value, y.value];
}

/**
 * Where "Take out" puts an entry of `container`: the board of the outermost
 * container in `container`'s chain, at that container's position + (1, 0).
 * Null when the chain is not on a board (an unreadable `board` or a position
 * that is not two finite numbers). Read from the GM directory (structural
 * cells), else the current viewer's views.
 */
export function takeOutDestination(
  session: TableSession,
  container: ObjectId,
): { type: "board"; board: BoardId; position: [number, number] } | null {
  const viewOf = (id: ObjectId) => session.directory().get(id) ?? session.objectView(id);
  let current = container;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const view = viewOf(current);
    if (view === null || view === undefined) return null;
    const parent = view.cells.container?.value;
    if (parent?.type === "ref") {
      current = parent.object;
      continue;
    }
    const board = view.cells.board?.value;
    const position = pair(view.cells.position?.value);
    if (board?.type !== "ref" || position === null) return null;
    return { type: "board", board: board.object, position: [position[0] + 1, position[1]] };
  }
  return null;
}

interface Drag {
  readonly id: ObjectId;
  readonly ids: readonly ObjectId[];
  readonly revision: number;
}

const LIST_STYLE: CSSProperties = { margin: 0, padding: 0 };
const NOTE_STYLE: CSSProperties = { fontSize: "0.85em", opacity: 0.7 };
const LINK_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
};

export function ContentsList({ object, view, session, ui, readOnly = false }: ContentsListProps) {
  const port = useInspectorWrites(session);
  const drag = useRef<Drag | null>(null);
  const viewer = session.getSnapshot().viewer;
  const entries = contentsEntries(view);
  const ids = entries.flatMap((e) => (e.type === "ref" ? [e.id] : []));
  const destination = readOnly ? null : takeOutDestination(session, object);
  const containerLabel = () => inspectorRefLabel(session)(object) ?? object;

  const takeOut = (id: ObjectId, label: string) => {
    const baseRevision = session.getSnapshot().revision;
    const to = takeOutDestination(session, object);
    if (to === null) return;
    void port.write([{ type: "move", object: id, to }], {
      baseRevision,
      label: `Take ${label} out of ${containerLabel()}`,
    });
  };

  const onDragStart = (id: ObjectId) => (event: DragEvent) => {
    drag.current = { id, ids: [...ids], revision: session.getSnapshot().revision };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  };

  const onDrop = (target: ObjectId) => (event: DragEvent) => {
    event.preventDefault();
    const started = drag.current;
    drag.current = null;
    if (started === null) return;
    const from = started.ids.indexOf(started.id);
    const to = started.ids.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    void port.write(
      [
        {
          type: "reorder",
          container: object,
          permutation: reorderPermutation(started.ids.length, from, to),
        },
      ],
      { baseRevision: started.revision, label: `Reorder contents of ${containerLabel()}` },
    );
  };

  return (
    <section aria-label="Contents" style={{ marginTop: "0.75em" }}>
      <h4 style={{ margin: 0 }}>Contents</h4>
      {entries.length === 0 ? (
        <p style={NOTE_STYLE}>Empty</p>
      ) : (
        <ol style={LIST_STYLE}>
          {entries.map((entry, index) => {
            if (entry.type === "hidden") {
              return (
                // Redacted entries have no id; their position is all there is.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <li key={`hidden:${index}`} data-label={HIDDEN_ENTRY} style={{ listStyle: "none" }}>
                  <span style={NOTE_STYLE}>{HIDDEN_ENTRY}</span>
                </li>
              );
            }
            const { id } = entry;
            const label = session.refLabel(viewer, id);
            const draggable = !readOnly;
            return (
              <li
                key={`ref:${id}`}
                data-object={id}
                data-label={label}
                style={{ listStyle: "none", cursor: draggable ? "grab" : undefined }}
                {...(draggable
                  ? {
                      draggable: true,
                      onDragStart: onDragStart(id),
                      onDragOver: (e: DragEvent) => e.preventDefault(),
                      onDrop: onDrop(id),
                      onDragEnd: () => {
                        drag.current = null;
                      },
                    }
                  : {})}
              >
                <button type="button" style={LINK_STYLE} onClick={() => ui.select([id])}>
                  {label}
                </button>
                {!readOnly && (
                  <>
                    {" "}
                    <button
                      type="button"
                      aria-label={`Take out ${label}`}
                      disabled={destination === null}
                      onClick={() => takeOut(id, label)}
                    >
                      Take out
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
