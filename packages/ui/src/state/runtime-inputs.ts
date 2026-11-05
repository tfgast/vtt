/**
 * The runtime's live inputs and tool context (vtt-3l6.21; review r3 finding
 * 2): vtt-3l6.22's `RuntimeInputs` and `ToolContext` over vtt-3l6.4's
 * session and the `UiStore`.
 */
import type { Viewer } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import type { RuntimeInputs, ToolContext, UploadedAsset, Viewport } from "../interaction/contracts";
import { buildScene, type Scene } from "../scene/scene";
import type { TableSession } from "../session/table-session";
import { createWritePort, sessionNotices } from "../session/writes";
import type { UiStore } from "./ui-state";

const EMPTY_SCENE: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };

const viewerKey = (viewer: Viewer) => (viewer.type === "gm" ? "gm" : `character:${viewer.id}`);

const sameViewport = (a: Viewport, b: Viewport) =>
  a.width === b.width && a.height === b.height && a.dpr === b.dpr;

/**
 * `views` reads the current viewer's views (`session.objectView`); `scene()`
 * is `buildScene` over the board view and its covers with the viewer,
 * selection and highlight and no previews, memoized until any of those (or
 * the views) change; `onChange` fires on any change of board, viewer,
 * revision or viewport.
 */
export function createRuntimeInputs(session: TableSession, ui: UiStore): RuntimeInputs {
  let memo: {
    viewVersion: number;
    viewer: string;
    board: BoardId;
    selection: readonly ObjectId[];
    highlight: readonly ObjectId[];
    scene: Scene;
  } | null = null;

  return {
    views: (id) => session.objectView(id),
    scene() {
      const snapshot = session.getSnapshot();
      const board = session.boardView();
      if (board === null) return EMPTY_SCENE;
      const { selection, highlight } = ui.getState();
      const viewer = viewerKey(snapshot.viewer);
      if (
        memo !== null &&
        memo.viewVersion === snapshot.viewVersion &&
        memo.viewer === viewer &&
        memo.board === board.board &&
        memo.selection === selection &&
        memo.highlight === highlight
      ) {
        return memo.scene;
      }
      const scene = buildScene({
        views: board.objects.values(),
        covers: [...board.covers.values()],
        board: board.board,
        viewer: snapshot.viewer,
        selection,
        highlight,
      });
      memo = {
        viewVersion: snapshot.viewVersion,
        viewer,
        board: board.board,
        selection,
        highlight,
        scene,
      };
      return scene;
    },
    viewport: () => ui.getState().viewport,
    activeBoard: () => session.getSnapshot().activeBoard,
    viewer: () => session.getSnapshot().viewer,
    revision: () => session.getSnapshot().revision,
    onChange(fn) {
      let snapshot = session.getSnapshot();
      let viewport = ui.getState().viewport;
      const call = () => {
        try {
          fn();
        } catch {
          // A throwing listener must not break the stores.
        }
      };
      const offSession = session.subscribe(() => {
        const next = session.getSnapshot();
        const changed =
          next.activeBoard !== snapshot.activeBoard ||
          viewerKey(next.viewer) !== viewerKey(snapshot.viewer) ||
          next.revision !== snapshot.revision;
        snapshot = next;
        if (changed) call();
      });
      const offUi = ui.subscribe(() => {
        const next = ui.getState().viewport;
        const changed = !sameViewport(next, viewport);
        viewport = next;
        if (changed) call();
      });
      return () => {
        offSession();
        offUi();
      };
    },
  };
}

/** The ports `createToolContext` takes from the app shell (vtt-3l6.17). */
export interface ToolContextPorts {
  /** Resolves null when the dialog is dismissed. */
  pickFile(accept: string): Promise<File | null>;
  upload(file: File): Promise<UploadedAsset>;
}

/**
 * vtt-3l6.22's `ToolContext`: `write` is `createWritePort(session)`,
 * `camera` is `ui.cameraPort()`, `notify` pushes to the session's notice
 * store, and the reads are the session's.
 */
export function createToolContext(
  session: TableSession,
  ui: UiStore,
  ports: ToolContextPorts,
): ToolContext {
  return {
    activeBoard: () => session.getSnapshot().activeBoard,
    viewer: () => session.getSnapshot().viewer,
    revision: () => session.getSnapshot().revision,
    camera: ui.cameraPort(),
    write: createWritePort(session),
    notify(level, text) {
      sessionNotices(session).push({ level, text });
    },
    pickFile: (accept) => ports.pickFile(accept),
    upload: (file) => ports.upload(file),
  };
}
