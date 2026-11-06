/**
 * The first-visit fit (vtt-3l6.10; review r3 finding 11). vtt-3l6.21's
 * camera store marks a board `needsFit` when it becomes active with no
 * remembered camera; once that board's view has arrived, the camera is set
 * and the canvas has been measured (a viewport with positive width and
 * height), the camera is set to `fitBounds` of the board's item bounds
 * (vtt-3l6.5), or centered on 0,0 at zoom 1 for a board with no items, and
 * only then is the mark cleared. Saving and
 * restoring cameras is the camera store's.
 */
import type { Viewer } from "@vtt/protocol";
import type { Bounds } from "@vtt/schema";
import { useEffect } from "react";
import { type Camera, fitBounds, type ViewportSize } from "../scene/camera";
import { buildScene } from "../scene/scene";
import type { BoardViewState, TableSession } from "../session/table-session";
import type { CameraStore } from "../state/camera-store";
import type { UiStore } from "../state/ui-state";

/** Pixels left free on every side of a fitted board. */
export const FIT_MARGIN_PX = 48;

const CENTER: Camera = { x: 0, y: 0, zoom: 1 };

/**
 * The union of the items' `bounds`, or null with none (the first-visit fit's
 * and the minimap's extent, vtt-qf5.19).
 */
export function unionBounds(items: Iterable<{ readonly bounds: Bounds }>): Bounds | null {
  let bounds: Bounds | null = null;
  for (const item of items) {
    const b = item.bounds;
    bounds =
      bounds === null
        ? { ...b }
        : {
            minX: Math.min(bounds.minX, b.minX),
            minY: Math.min(bounds.minY, b.minY),
            maxX: Math.max(bounds.maxX, b.maxX),
            maxY: Math.max(bounds.maxY, b.maxY),
          };
  }
  return bounds;
}

/**
 * The camera of a first visit: `fitBounds` of the union of the bounds of the
 * items drawn on `view.board` for `viewer`, or 0,0 at zoom 1 with none.
 */
export function firstVisitCamera(
  view: BoardViewState,
  viewer: Viewer,
  viewport: ViewportSize,
): Camera {
  const scene = buildScene({
    views: view.objects.values(),
    covers: [],
    board: view.board,
    viewer,
  });
  const bounds = unionBounds(scene.items);
  return bounds === null ? { ...CENTER } : fitBounds(bounds, viewport, FIT_MARGIN_PX);
}

export interface FirstVisitFitOptions {
  session: Pick<TableSession, "getSnapshot" | "subscribe" | "boardView">;
  ui: Pick<UiStore, "getState" | "setCamera" | "subscribe">;
  cameraStore: Pick<CameraStore, "needsFit" | "clearNeedsFit" | "subscribe">;
}

/**
 * Follows the session, the camera store and the UI state (for the
 * viewport), fitting the active board when it is marked `needsFit`, its
 * board view has arrived and the viewport is measured. Returns the stopper.
 */
export function startFirstVisitFit({ session, ui, cameraStore }: FirstVisitFitOptions): () => void {
  const check = () => {
    const { activeBoard, viewer } = session.getSnapshot();
    if (activeBoard === null || !cameraStore.needsFit(activeBoard)) return;
    const view = session.boardView();
    if (view === null || view.board !== activeBoard) return;
    const viewport = ui.getState().viewport;
    if (!(viewport.width > 0 && viewport.height > 0)) return; // Not measured yet.
    ui.setCamera(firstVisitCamera(view, viewer, viewport));
    cameraStore.clearNeedsFit(activeBoard);
  };
  const offSession = session.subscribe(check);
  const offStore = cameraStore.subscribe(check);
  const offUi = ui.subscribe(check);
  check();
  return () => {
    offSession();
    offStore();
    offUi();
  };
}

/** `startFirstVisitFit` for the lifetime of the calling component. */
export function useFirstVisitFit({ session, ui, cameraStore }: FirstVisitFitOptions): void {
  useEffect(() => startFirstVisitFit({ session, ui, cameraStore }), [session, ui, cameraStore]);
}
