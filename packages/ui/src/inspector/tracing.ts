/**
 * Dependency tracing (vtt-3l6.24): DESIGN.md §4.6 **Dependency tracing**
 * ("Hovering a formula highlights the objects and zones it references on the
 * canvas, filtered by what the viewer may see. Hovering a zone highlights its
 * contents"), §4.4 (filtered by the viewer's effective visibility);
 * FORMULAS.md §9; PROTOCOL.md §9 `explain_cell`, `zones`; M4 plan Q13;
 * review r1 findings 3, 10.
 *
 * `startTracing` is the sole writer of `UiStore.highlight`. It watches
 * `hoveredZone` and `hoveredCell`; a hovered zone wins over a hovered cell.
 *
 * - Hovered cell: `explain_cell {object, cell, depth: 1, viewer}`; every
 *   dependency node (cell and `exists`, at any depth returned) with a
 *   non-null `object` other than the cell's own object is highlighted. The
 *   authority reports objects a character cannot see as `object: null`, so
 *   nothing of them is highlighted. Boards (dependencies of spatial queries
 *   such as `on`) are not on the canvas and are left out.
 * - Hovered zone: `zones {board, viewer}` for the active board; that zone's
 *   `contents` (already restricted to visible objects) are highlighted.
 *
 * Requests and their cache are keyed `(viewerKey, board, revision, target)`,
 * where the target is the hovered cell, or the board's zones for a hovered
 * zone (one `zones` answer serves every zone of that board at that revision
 * for that viewer). An answer is shown only while its key is still the
 * current one; otherwise it is dropped (it still fills the cache, which is
 * exact per key). While an answer is pending the highlight is cleared,
 * except when only the revision advanced over the same viewer, board and
 * hover target, where the previous highlight stays until the new answer (no
 * flicker on every commit, and no other viewer's answer is ever shown). A
 * failed request highlights nothing and is not retried for the same key
 * until the session becomes ready again.
 */
import type { DepNode, ProtocolClient, Viewer, ZonesResult } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import type { TableSession } from "../session/table-session";
import type { CellAddress, UiStore } from "../state/ui-state";

/** What tracing needs from the session. */
export interface TracingSession
  extends Pick<TableSession, "subscribe" | "getSnapshot" | "viewerKey"> {
  readonly client: Pick<ProtocolClient, "request">;
}

/** What tracing needs from the UI store. */
export type TracingUi = Pick<UiStore, "getState" | "subscribe" | "setHighlight">;

export interface TracingOptions {
  session: TracingSession;
  ui: TracingUi;
}

/** The objects a dependency tree references, other than `own`, in first-seen order. */
export function tracedObjects(dependencies: readonly DepNode[], own: ObjectId): ObjectId[] {
  const seen = new Set<ObjectId>();
  const walk = (nodes: readonly DepNode[]) => {
    for (const node of nodes) {
      if (node.type === "index") continue;
      if (node.object !== null && node.object !== own) seen.add(node.object);
      if (node.type === "cell" && node.dependencies) walk(node.dependencies);
    }
  };
  walk(dependencies);
  return [...seen];
}

/** The visible contents of `zone` in a `zones` answer; none when the zone is absent. */
export function zoneContents(result: ZonesResult, zone: ObjectId): ObjectId[] {
  return [...(result.zones.find((z) => z.id === zone)?.contents ?? [])];
}

/** What is hovered, after precedence. */
type Hovered =
  | { readonly type: "zone"; readonly zone: ObjectId }
  | { readonly type: "cell"; readonly cell: CellAddress };

/** One request's answer, as cached. */
type Answer =
  | { readonly type: "cell"; readonly objects: readonly ObjectId[] }
  | { readonly type: "zones"; readonly result: ZonesResult };

interface Current {
  readonly hovered: Hovered;
  readonly viewer: Viewer;
  readonly viewerKey: string;
  readonly board: BoardId | null;
  readonly revision: number;
  /** The request key `(viewerKey, board, revision, target)`. */
  readonly key: string;
  /** The key without the revision, plus the precise hover target. */
  readonly stable: string;
}

const CACHE_LIMIT = 64;

const copyViewer = (viewer: Viewer): Viewer =>
  viewer.type === "gm" ? { type: "gm" } : { type: "character", id: viewer.id };

/** Starts dependency tracing; returns its disposer, which clears the highlight. */
export function startTracing({ session, ui }: TracingOptions): () => void {
  const cache = new Map<string, Answer>();
  const pending = new Set<string>();
  let failed: string | null = null;
  let current: Current | null = null;
  let wasReady = session.getSnapshot().ready;
  let disposed = false;

  const hoveredNow = (): Hovered | null => {
    const state = ui.getState();
    if (state.hoveredZone !== null) return { type: "zone", zone: state.hoveredZone };
    if (state.hoveredCell !== null) return { type: "cell", cell: state.hoveredCell };
    return null;
  };

  const compute = (): Current | null => {
    const hovered = hoveredNow();
    if (hovered === null) return null;
    const snapshot = session.getSnapshot();
    const viewerKey = session.viewerKey();
    const board = snapshot.activeBoard;
    if (hovered.type === "zone" && board === null) return null;
    const target =
      hovered.type === "zone" ? ["zones"] : ["cell", hovered.cell.object, hovered.cell.cell];
    const precise = hovered.type === "zone" ? ["zone", hovered.zone] : target;
    return {
      hovered,
      viewer: snapshot.viewer,
      viewerKey,
      board,
      revision: snapshot.revision,
      key: JSON.stringify([viewerKey, board, snapshot.revision, ...target]),
      stable: JSON.stringify([viewerKey, board, ...precise]),
    };
  };

  const shown = (now: Current, answer: Answer): ObjectId[] => {
    if (answer.type === "cell") {
      // A board is a dependency of spatial queries but is not drawn on the canvas.
      const boards = new Set(session.getSnapshot().boards.map((b) => b.id));
      return answer.objects.filter((id) => !boards.has(id));
    }
    return now.hovered.type === "zone" ? zoneContents(answer.result, now.hovered.zone) : [];
  };

  const remember = (key: string, answer: Answer) => {
    cache.delete(key);
    cache.set(key, answer);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const ask = (now: Current) => {
    if (pending.has(now.key) || failed === now.key) return;
    pending.add(now.key);
    const viewer = copyViewer(now.viewer);
    const { hovered, key } = now;
    const answer: Promise<Answer> =
      hovered.type === "cell"
        ? session.client
            .request("explain_cell", {
              object: hovered.cell.object,
              cell: hovered.cell.cell,
              depth: 1,
              viewer,
            })
            .then((result) => ({
              type: "cell" as const,
              objects: tracedObjects(result.dependencies, hovered.cell.object),
            }))
        : session.client
            .request("zones", { board: now.board as BoardId, viewer })
            .then((result) => ({ type: "zones" as const, result }));
    answer.then(
      (result) => {
        pending.delete(key);
        if (disposed) return;
        remember(key, result);
        if (current?.key === key) ui.setHighlight(shown(current, result));
      },
      () => {
        pending.delete(key);
        if (disposed) return;
        failed = key;
        if (current?.key === key) ui.setHighlight([]);
      },
    );
  };

  const update = () => {
    if (disposed) return;
    const ready = session.getSnapshot().ready;
    if (ready && !wasReady) failed = null;
    wasReady = ready;
    const previous = current;
    const now = compute();
    current = now;
    if (now === null) {
      ui.setHighlight([]);
      return;
    }
    const cached = cache.get(now.key);
    if (cached !== undefined) {
      ui.setHighlight(shown(now, cached));
      return;
    }
    if (failed === now.key) {
      ui.setHighlight([]);
      return;
    }
    // Keep the previous highlight only when just the revision advanced.
    if (previous === null || previous.stable !== now.stable) ui.setHighlight([]);
    ask(now);
  };

  const offUi = ui.subscribe(update);
  const offSession = session.subscribe(update);
  update();

  return () => {
    if (disposed) return;
    disposed = true;
    offUi();
    offSession();
    current = null;
    pending.clear();
    cache.clear();
    ui.setHighlight([]);
  };
}
