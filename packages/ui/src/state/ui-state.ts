/**
 * Local UI state (vtt-3l6.21; review r1 finding 10, r2 finding 3): selection,
 * focused and hovered cells, hover, hovered zone, highlight, tool, camera and
 * viewport. The only owner of camera state (`cameraPort()` is vtt-3l6.22's
 * `CameraPort`). The active board and the viewer are the session's
 * (vtt-3l6.4), read and set through it.
 *
 * Writers: `hoveredCell` — the inspector cells and the formula bar
 * (vtt-3l6.11, vtt-3l6.13); `hover` and `hoveredZone` — the interaction
 * runtime from the select tool's `hover` effect (vtt-3l6.23, vtt-3l6.7), and
 * `hoveredZone` also the object list (vtt-3l6.12); `highlight` — only
 * dependency tracing (vtt-3l6.24); `altHover` — the interaction runtime
 * from the select tool's `alt_hover` effect (M6-D12).
 */
import type { Viewer } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import type { CameraPort, Viewport } from "../interaction/contracts";
import { DEFAULT_TOOL_OPTIONS, type ToolId, type ToolOptionsMap } from "../interaction/tool";
import type { Camera } from "../scene/camera";
import type { TableSession } from "../session/table-session";

/** A cell of an object. */
export interface CellAddress {
  readonly object: ObjectId;
  readonly cell: string;
}

/** The active tool and its options, tagged by `id`. */
export type UiTool = {
  [K in ToolId]: { readonly id: K; readonly options: ToolOptionsMap[K] };
}[ToolId];

export interface UiState {
  readonly selection: readonly ObjectId[];
  readonly focusedCell: CellAddress | null;
  readonly hover: ObjectId | null;
  readonly hoveredCell: CellAddress | null;
  readonly hoveredZone: ObjectId | null;
  /** The object an Alt-held drag hovers, whose `when_selected` lists show (M6-D12). */
  readonly altHover: ObjectId | null;
  readonly highlight: readonly ObjectId[];
  readonly tool: UiTool;
  readonly camera: Camera;
  readonly viewport: Viewport;
}

/** What the store needs from the session. */
export type UiSession = Pick<TableSession, "getSnapshot" | "setView" | "watchObjects">;

export interface UiStoreOptions {
  session: UiSession;
  camera?: Camera;
  viewport?: Viewport;
}

export interface UiStore {
  /** The current state; the same object until something changes. */
  getState(): UiState;
  /** Adds a listener called after every change; returns its remover. */
  subscribe(listener: () => void): () => void;
  /** Sets the selection (duplicates dropped) and calls `session.watchObjects`. */
  select(ids: readonly ObjectId[]): void;
  focusCell(cell: CellAddress | null): void;
  setHover(id: ObjectId | null): void;
  setHoveredCell(cell: CellAddress | null): void;
  setHoveredZone(id: ObjectId | null): void;
  setAltHover(id: ObjectId | null): void;
  setHighlight(ids: readonly ObjectId[]): void;
  /** Activates a tool with `options`, else the options it last had, else its defaults. */
  setTool<K extends ToolId>(id: K, options?: ToolOptionsMap[K]): void;
  setCamera(camera: Camera): void;
  setViewport(viewport: Viewport): void;
  /** The camera port over this store's camera. */
  cameraPort(): CameraPort;
  /** The session's active board. */
  activeBoard(): BoardId | null;
  /** The session's viewer. */
  viewer(): Viewer;
  /** Shows `board` with the current viewer (`session.setView`). */
  setActiveBoard(board: BoardId | null): Promise<void>;
  /** Shows the active board as `viewer` (`session.setView`). */
  setViewer(viewer: Viewer): Promise<void>;
}

const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const DEFAULT_VIEWPORT: Viewport = { width: 0, height: 0, dpr: 1 };

const sameIds = (a: readonly ObjectId[], b: readonly ObjectId[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

const sameCell = (a: CellAddress | null, b: CellAddress | null) =>
  a === b || (a !== null && b !== null && a.object === b.object && a.cell === b.cell);

const sameCamera = (a: Camera, b: Camera) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

const sameViewport = (a: Viewport, b: Viewport) =>
  a.width === b.width && a.height === b.height && a.dpr === b.dpr;

/** Shallow equality of tool options (they are flat records). */
function sameOptions(a: object, b: object): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
  );
}

export function createUiStore(options: UiStoreOptions): UiStore {
  const session = options.session;
  const listeners = new Set<() => void>();
  const toolOptions: Partial<Record<ToolId, object>> = {};
  let state: UiState = {
    selection: [],
    focusedCell: null,
    hover: null,
    hoveredCell: null,
    hoveredZone: null,
    altHover: null,
    highlight: [],
    tool: { id: "select", options: DEFAULT_TOOL_OPTIONS.select },
    camera: { ...(options.camera ?? DEFAULT_CAMERA) },
    viewport: { ...(options.viewport ?? DEFAULT_VIEWPORT) },
  };

  const update = (patch: Partial<UiState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing listener must not break the store.
      }
    }
  };

  const setCamera = (camera: Camera) => {
    if (!sameCamera(state.camera, camera)) update({ camera: { ...camera } });
  };
  const port: CameraPort = { get: () => state.camera, set: setCamera };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select(ids) {
      const selection = [...new Set(ids)];
      if (sameIds(state.selection, selection)) return;
      update({ selection });
      void session.watchObjects(selection);
    },
    focusCell(cell) {
      if (!sameCell(state.focusedCell, cell)) update({ focusedCell: cell && { ...cell } });
    },
    setHover(id) {
      if (state.hover !== id) update({ hover: id });
    },
    setHoveredCell(cell) {
      if (!sameCell(state.hoveredCell, cell)) update({ hoveredCell: cell && { ...cell } });
    },
    setHoveredZone(id) {
      if (state.hoveredZone !== id) update({ hoveredZone: id });
    },
    setAltHover(id) {
      if (state.altHover !== id) update({ altHover: id });
    },
    setHighlight(ids) {
      if (!sameIds(state.highlight, ids)) update({ highlight: [...ids] });
    },
    setTool(id, options) {
      const chosen = (options ?? toolOptions[id] ?? DEFAULT_TOOL_OPTIONS[id]) as object;
      toolOptions[id] = chosen;
      if (state.tool.id === id && sameOptions(state.tool.options, chosen)) return;
      update({ tool: { id, options: chosen } as UiTool });
    },
    setCamera,
    setViewport(viewport) {
      if (!sameViewport(state.viewport, viewport)) update({ viewport: { ...viewport } });
    },
    cameraPort: () => port,
    activeBoard: () => session.getSnapshot().activeBoard,
    viewer: () => session.getSnapshot().viewer,
    setActiveBoard: (board) => session.setView(board, session.getSnapshot().viewer),
    setViewer: (viewer) => session.setView(session.getSnapshot().activeBoard, viewer),
  };
}
