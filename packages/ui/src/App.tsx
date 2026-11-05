/**
 * The app shell (vtt-3l6.17; M5 composition vtt-1xv.23): composes the UI's
 * pieces into the running app. DESIGN.md §7 Platform ("the scene is drawn
 * on a canvas and the chrome (inspector, formula bar, log) is DOM"), §7
 * Undo, §4.4–§4.8, §8.1; PROTOCOL.md §2, §6; M4 plan Q9, Q14; M5 plan Q1,
 * Q12, Q19, Q20.
 *
 * Layout: the toolbar on top (tools, fog, view as, undo, save, help); board tabs
 * and the formula bar above the canvas; on the right the edit-template
 * banner and the inspector panel (tabs Inspector, Objects and Log); the
 * status bar at the bottom; notices floating above it; the keyboard and
 * gesture help (vtt-nb8.8) over everything while open (`?` or the toolbar's
 * "?" button toggles it, Esc closes it), the rest of the app `inert` then.
 *
 * Wiring (one of each per mounted app):
 * - one `FaceStateStore` (vtt-1xv.14) and one `RuntimeInputs` shared by the
 *   face scene, the binder policy, the tools and the runtime;
 * - the binder policy (vtt-1xv.17) over them, disposed with the runtime;
 * - the tools in one `ToolRegistry`: `withFaces(withHandles(select tool with
 *   the face drop override), {faceState, policy, gestures: [entry drag]})`
 *   (vtt-1xv.16, vtt-1xv.25, vtt-1xv.17), the creation tools (vtt-3l6.8),
 *   ink and text (vtt-1xv.21) and layout (vtt-1xv.27);
 * - vtt-3l6.23's runtime over them and `createToolContext` (vtt-3l6.21;
 *   `pickFile` through a hidden file input, `upload` measuring with
 *   `createImageBitmap` then posting with vtt-3l6.16's `uploadAsset`), the
 *   session's `whenRevision`, vtt-3l6.13's in-place editor port, the
 *   extensions `invoke` (effect), `expand_created` and `edit_created`
 *   (continuations) and the cell drop handler (vtt-1xv.27) as its data-drop
 *   handler, so a cell dropped on the canvas works whatever tool is active;
 * - `BoardCanvas` fed with `buildFaceScene` (vtt-1xv.26) of the board view,
 *   the `UiStore`, the runtime's previews and the face state, with the
 *   runtime's overlays; the renderer draws faces with `drawFaceItem`
 *   (vtt-1xv.15) and culls by `faceCullBounds`; its resizes set the store's
 *   viewport; the in-place editor in its overlay; images through an
 *   `ImageCache` resolving `assetUrl`;
 * - the inspector's actions (vtt-1xv.19) get the same policy and the
 *   runtime (Run);
 * - on mount: the camera store connected, the first-visit fit, dependency
 *   tracing and the keybindings; all undone on unmount.
 *
 * The renderer keeps vtt-3l6.6's order (objects with their faces, object
 * overlays, covers, chrome); the shell draws nothing on the canvas itself.
 */
import type { WebSocketConstructor } from "@vtt/protocol";
import {
  type CSSProperties,
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { INVOKE_EXTENSION, invokeExtension } from "./actions/invoke";
import { HelpPanel } from "./app/HelpPanel";
import { appKeyActions, bindKeybindings } from "./app/keybindings";
import { Notices } from "./app/Notices";
import { StatusBar } from "./app/StatusBar";
import { Toolbar } from "./app/Toolbar";
import { assetUrl, uploadAsset } from "./assets/upload";
import {
  type BinderPolicy,
  binderPolicy,
  EXPAND_CREATED_EXTENSION,
  expandCreatedHandler,
} from "./binder/binder-policy";
import { EditTemplateBanner } from "./binder/EditTemplateBanner";
import { BoardCanvas, type CreateRenderer } from "./canvas/BoardCanvas";
import type { FacePolicy } from "./face/face-contracts";
import { buildFaceScene, type FaceScene, faceCullBounds } from "./face/face-scene";
import { createFaceStateStore, type FaceStateStore } from "./face/face-state";
import { createCellDropHandler } from "./face-editor/cell-drop";
import { createLayoutTool } from "./face-editor/layout-tool";
import { createInPlaceEditorPort, requestFormulaBarFocus } from "./formula-bar/editor-port";
import { FormulaBar } from "./formula-bar/FormulaBar";
import { InPlaceEditor } from "./formula-bar/InPlaceEditor";
import { Inspector } from "./inspector/Inspector";
import { startTracing } from "./inspector/tracing";
import type { RuntimeInputs, UploadedAsset, Viewport } from "./interaction/contracts";
import { registerCreationTools } from "./interaction/create-tools";
import { createFaceDropOverride } from "./interaction/drop-targets";
import { entryDragGesture } from "./interaction/entry-drag";
import { withFaces } from "./interaction/face-tool";
import { withHandles } from "./interaction/handles";
import { createInkTool } from "./interaction/ink-tool";
import { ToolRegistry } from "./interaction/registry";
import {
  createInteractionRuntime,
  type EditorPort,
  type InteractionRuntime,
} from "./interaction/runtime";
import { createSelectTool } from "./interaction/select-tool";
import { createTextTool, EDIT_CREATED, editCreatedHandler } from "./interaction/text-tool";
import { useInteraction } from "./interaction/use-interaction";
import { BoardTabs } from "./nav/BoardTabs";
import { useFirstVisitFit } from "./nav/first-visit-fit";
import { createCanvas2DRenderer } from "./render/canvas2d";
import { drawFaceItem } from "./render/face-draw";
import { ImageCache } from "./render/image-cache";
import type { Ctx2D, Renderer } from "./render/renderer";
import { readBootstrap } from "./session/bootstrap";
import { TableProvider, useSession, useTableSession, useUi, useUiStore } from "./session/hooks";
import { createTableSession, type TableSession } from "./session/table-session";
import { sessionNotices } from "./session/writes";
import { type CameraStore, createCameraStore } from "./state/camera-store";
import { createRuntimeInputs, createToolContext } from "./state/runtime-inputs";
import { createUiStore, type UiStore } from "./state/ui-state";

// ---------------------------------------------------------------------------
// Ports

/** An image's pixel size, measured with `createImageBitmap`. */
export async function measureImage(file: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("this browser cannot measure images");
  }
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export interface BrowserUploadOptions {
  /** The session token (bootstrap); without it every upload fails. */
  token: string | undefined;
  /** The authority's HTTP origin; default `location.origin`. */
  base?: string;
  /** Default: `measureImage`. */
  measure?: (file: Blob) => Promise<{ width: number; height: number }>;
}

/** The tool context's `upload`: measures the image, then posts it with `uploadAsset`. */
export function createBrowserUpload(
  options: BrowserUploadOptions,
): (file: File) => Promise<UploadedAsset> {
  return async (file) => {
    const token = options.token;
    if (token === undefined) throw new Error("uploads need the session token");
    const size = await (options.measure ?? measureImage)(file);
    const { path } = await uploadAsset(file, {
      token,
      ...(options.base === undefined ? {} : { base: options.base }),
    });
    return { path, width: size.width, height: size.height };
  };
}

export interface AppRendererOptions {
  /** Called when an image finishes loading. */
  requestRedraw: () => void;
  /** An image path's URL; default `assetUrl`. */
  resolve?: (path: string) => string;
}

/**
 * The app's renderer over `ctx`: Canvas2D drawing faces with `drawFaceItem`
 * and culling by `faceCullBounds` (presentation bounds), images from
 * `resolve`.
 */
export function createAppRenderer(ctx: Ctx2D, options: AppRendererOptions): Renderer<FaceScene> {
  return createCanvas2DRenderer<FaceScene>(ctx, {
    images: new ImageCache({ resolve: options.resolve ?? assetUrl, onLoad: options.requestRedraw }),
    drawItem: drawFaceItem,
    cullBounds: faceCullBounds,
  });
}

/** The app's renderer: `createAppRenderer` over the canvas's 2D context. */
export const appCreateRenderer: CreateRenderer<FaceScene> = (canvas, { requestRedraw }) => {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("the board canvas has no 2D context");
  return createAppRenderer(ctx, { requestRedraw });
};

export interface AppRegistryOptions {
  /** The face state the face scene uses. */
  faceState: FaceStateStore;
  /** The face policy (the app's binder policy). */
  policy: FacePolicy;
}

/**
 * A registry with the select tool (with handles, faces, the face drop
 * override and entry drags), the creation tools, ink, text and layout.
 */
export function createAppRegistry({ faceState, policy }: AppRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    withFaces(withHandles(createSelectTool({ dropOverride: createFaceDropOverride(faceState) })), {
      faceState,
      policy,
      gestures: [entryDragGesture({ faceState })],
    }),
  );
  registerCreationTools(registry);
  registry.register(createInkTool());
  registry.register(createTextTool());
  registry.register(createLayoutTool());
  return registry;
}

// ---------------------------------------------------------------------------
// Components

export interface AppProps {
  session: TableSession;
  /** Default: `appCreateRenderer`. */
  createRenderer?: CreateRenderer<FaceScene>;
  /** Default: a new store over `session`. */
  ui?: UiStore;
  /** The session's face state (expanded entries, scroll offsets); default: a new store. */
  faceState?: FaceStateStore;
  /** The session token, for image uploads (from the bootstrap). */
  token?: string;
  /** Default: the hidden file input. */
  pickFile?: (accept: string) => Promise<File | null>;
  /** Default: `createBrowserUpload({token})`. */
  upload?: (file: File) => Promise<UploadedAsset>;
}

const EMPTY_SCENE: FaceScene = {
  items: [],
  covers: [],
  objectOverlays: [],
  skipped: [],
  faces: new Map(),
  presentation: new Map(),
  transforms: new Map(),
};

const ROOT_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  height: "100vh",
  margin: 0,
  fontFamily: "system-ui, sans-serif",
};
const MAIN_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(16em, 24em)",
  minHeight: 0,
};
const BOARD_COLUMN_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
};
const CANVAS_AREA_STYLE: CSSProperties = { position: "relative", flex: 1, minHeight: 0 };
const INSPECTOR_STYLE: CSSProperties = {
  overflow: "auto",
  padding: "6px",
  borderLeft: "1px solid #d0d0d6",
};
const BANNER_STYLE: CSSProperties = { marginBottom: "6px" };

export function App(props: AppProps) {
  const { session } = props;
  const [ui] = useState(() => props.ui ?? createUiStore({ session }));
  return (
    <TableProvider session={session} ui={ui}>
      <Shell {...props} ui={ui} />
    </TableProvider>
  );
}

/** What the shell composes on mount: the binder policy, the tools and the runtime. */
interface Composition {
  policy: BinderPolicy;
  registry: ToolRegistry;
  runtime: InteractionRuntime;
}

/**
 * Creates the composition on mount and disposes its runtime and policy on
 * unmount (also under StrictMode's remount): the policy follows the
 * selection and the inputs from its creation on.
 */
function useComposition(create: () => Composition): Composition | null {
  const [composition, setComposition] = useState<Composition | null>(null);
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(() => {
    const created = createRef.current();
    setComposition(created);
    return () => {
      created.runtime.dispose();
      created.policy.dispose();
      setComposition((current) => (current === created ? null : current));
    };
  }, []);
  return composition;
}

/** A number that changes with every change of `faceState` (keys the face scene). */
function useFaceStateVersion(faceState: FaceStateStore): number {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => faceState.subscribe(bump), [faceState]);
  return version;
}

function Shell(props: AppProps & { ui: UiStore }) {
  const { session, ui } = props;
  const [faceState] = useState<FaceStateStore>(() => props.faceState ?? createFaceStateStore());
  const [inputs] = useState<RuntimeInputs>(() => createRuntimeInputs(session, ui));
  const [editor] = useState<EditorPort>(() => createInPlaceEditorPort(ui));
  const [cameraStore] = useState<CameraStore>(() => createCameraStore({ ui, session }));
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingPick = useRef<((file: File | null) => void) | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [helpOpen, setHelpOpen] = useState(false);
  const toggleHelp = useCallback(() => setHelpOpen((open) => !open), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  const pickFile = useCallback((accept: string): Promise<File | null> => {
    const injected = propsRef.current.pickFile;
    if (injected !== undefined) return injected(accept);
    const input = fileInput.current;
    // A newer pick ends an unanswered one as dismissed.
    pendingPick.current?.(null);
    if (input === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (file: File | null) => {
        input.removeEventListener("change", onChange);
        input.removeEventListener("cancel", onCancel);
        if (pendingPick.current === done) pendingPick.current = null;
        resolve(file);
      };
      const onChange = () => done(input.files?.[0] ?? null);
      const onCancel = () => done(null);
      pendingPick.current = done;
      input.accept = accept;
      input.value = "";
      input.addEventListener("change", onChange);
      input.addEventListener("cancel", onCancel);
      input.click();
    });
  }, []);

  const upload = useCallback((file: File): Promise<UploadedAsset> => {
    const { upload: injected, token } = propsRef.current;
    return (injected ?? createBrowserUpload({ token }))(file);
  }, []);

  const composition = useComposition(() => {
    const policy = binderPolicy({ faceState, ui, inputs });
    const registry = createAppRegistry({ faceState, policy });
    const runtime = createInteractionRuntime({
      registry,
      inputs,
      toolContext: createToolContext(session, ui, { pickFile, upload }),
      ui,
      editor,
      whenRevision: (revision) => session.whenRevision(revision),
      extensions: {
        effects: { [INVOKE_EXTENSION]: invokeExtension(session, sessionNotices(session)) },
        continuations: {
          [EXPAND_CREATED_EXTENSION]: expandCreatedHandler(faceState, ui, inputs),
          [EDIT_CREATED]: editCreatedHandler({ editor, inputs }),
        },
      },
      dataDropHandlers: [createCellDropHandler({ faceState })],
    });
    return { policy, registry, runtime };
  });

  useEffect(() => cameraStore.connect(), [cameraStore]);
  useFirstVisitFit({ session, ui, cameraStore });
  useEffect(() => startTracing({ session, ui }), [session, ui]);
  useEffect(
    () => bindKeybindings(window, appKeyActions(session, ui, toggleHelp)),
    [session, ui, toggleHelp],
  );
  useEffect(
    () => () => {
      pendingPick.current?.(null);
    },
    [],
  );

  return (
    <>
      <div style={ROOT_STYLE} inert={helpOpen}>
        {composition === null ? (
          <header />
        ) : (
          <Toolbar registry={composition.registry} onHelp={toggleHelp} />
        )}
        <div style={MAIN_STYLE}>
          <main style={BOARD_COLUMN_STYLE}>
            <BoardTabs />
            <FormulaBar session={session} ui={ui} />
            <div style={CANVAS_AREA_STYLE}>
              {composition === null ? null : (
                <CanvasPane
                  runtime={composition.runtime}
                  registry={composition.registry}
                  faceState={faceState}
                  createRenderer={props.createRenderer ?? appCreateRenderer}
                />
              )}
            </div>
          </main>
          <div style={INSPECTOR_STYLE}>
            {composition === null ? null : (
              <EditTemplateBanner policy={composition.policy} style={BANNER_STYLE} />
            )}
            <Inspector
              session={session}
              ui={ui}
              onEditFormula={(cell) => requestFormulaBarFocus(ui, cell)}
              {...(composition === null
                ? {}
                : { policy: composition.policy, runtime: composition.runtime })}
            />
          </div>
        </div>
        <StatusBar />
        <Notices />
        <input ref={fileInput} type="file" hidden aria-hidden="true" tabIndex={-1} />
      </div>
      {helpOpen ? <HelpPanel onClose={closeHelp} /> : null}
    </>
  );
}

interface CanvasPaneProps {
  runtime: InteractionRuntime;
  registry: ToolRegistry;
  faceState: FaceStateStore;
  createRenderer: CreateRenderer<FaceScene>;
}

function CanvasPane({ runtime, registry, faceState, createRenderer }: CanvasPaneProps) {
  const session = useTableSession();
  const ui = useUiStore();
  const { overlays, previews, handlers } = useInteraction({ runtime });
  const viewVersion = useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  const selection = useUi((s) => s.selection);
  const hover = useUi((s) => s.hover);
  const highlight = useUi((s) => s.highlight);
  const camera = useUi((s) => s.camera);
  const faceVersion = useFaceStateVersion(faceState);
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion keys the board view's live maps, faceVersion the face state
  const scene = useMemo(() => {
    const view = session.boardView();
    if (view === null) return EMPTY_SCENE;
    return buildFaceScene(
      {
        views: view.objects.values(),
        covers: [...view.covers.values()],
        board: view.board,
        viewer,
        selection,
        hover,
        highlight,
        previews,
      },
      { faceState },
    );
  }, [session, viewVersion, viewer, selection, hover, highlight, previews, faceState, faceVersion]);
  const setViewport = useCallback((viewport: Viewport) => ui.setViewport(viewport), [ui]);

  const machine = runtime.machine();
  const active = registry.get(machine.tool);
  const toolState = machine.tools[machine.tool];
  const cursor =
    active === undefined || toolState === undefined ? "default" : active.cursor(toolState as never);

  return (
    <div style={{ position: "absolute", inset: 0, cursor }}>
      <BoardCanvas<FaceScene>
        scene={scene}
        toolOverlays={overlays}
        camera={camera}
        onEvent={handlers.onEvent}
        createRenderer={createRenderer}
        setViewport={setViewport}
        overlay={<InPlaceEditor session={session} ui={ui} camera={camera} scene={scene} />}
      />
    </div>
  );
}

/** The start screen of a page served without a session bootstrap. */
export function NoAuthority() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2em", maxWidth: "40em" }}>
      <h1>No authority running</h1>
      <p>
        This page was not served by a table authority, so it has nothing to connect to. Start one
        for a table file and open the page it prints:
      </p>
      <pre>
        <code>vtt-serve path/to/table.json --open</code>
      </pre>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Entry

export interface StartAppOptions {
  container: Element;
  /** Where the bootstrap element is read from; default `document`. */
  doc?: Document;
  /** Default: the global `WebSocket`. */
  WebSocket?: WebSocketConstructor;
  createRenderer?: CreateRenderer<FaceScene>;
}

export interface StartedApp {
  /** The session created from the bootstrap; null without one. */
  readonly session: TableSession | null;
  /** Unmounts the app and closes its session. */
  unmount(): void;
}

/**
 * The entry (PROTOCOL.md §2 session bootstrap): reads the `vtt-session`
 * element; without it renders the "No authority running" screen, else
 * connects with those explicit credentials and renders the app.
 */
export function startApp(options: StartAppOptions): StartedApp {
  const bootstrap = readBootstrap(options.doc ?? document);
  const root = createRoot(options.container);
  if (bootstrap === null) {
    root.render(
      <StrictMode>
        <NoAuthority />
      </StrictMode>,
    );
    return { session: null, unmount: () => root.unmount() };
  }
  const session = createTableSession({
    url: bootstrap.url,
    token: bootstrap.token,
    ...(options.WebSocket === undefined ? {} : { WebSocket: options.WebSocket }),
  });
  root.render(
    <StrictMode>
      <App
        session={session}
        token={bootstrap.token}
        {...(options.createRenderer === undefined
          ? {}
          : { createRenderer: options.createRenderer })}
      />
    </StrictMode>,
  );
  return {
    session,
    unmount() {
      root.unmount();
      session.close();
    },
  };
}
