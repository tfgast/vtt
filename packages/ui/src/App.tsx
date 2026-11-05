/**
 * The app shell (vtt-3l6.17): composes M4's pieces into the running UI.
 * DESIGN.md §7 Platform ("the scene is drawn on a canvas and the chrome …
 * is DOM"), §7 Undo, §8.1, §4.4, §4.6; PROTOCOL.md §2, §6; M4 plan Q9, Q14.
 *
 * Layout: the toolbar on top (tools, fog, view as, undo, save); board tabs
 * and the formula bar above the canvas; the inspector on the right; the
 * status bar at the bottom; notices floating above it.
 *
 * Wiring:
 * - the tools: vtt-3l6.7's select tool wrapped by vtt-3l6.9's `withHandles`,
 *   and vtt-3l6.8's creation tools, in one `ToolRegistry`;
 * - vtt-3l6.23's runtime over `createRuntimeInputs` and `createToolContext`
 *   (vtt-3l6.21; `pickFile` through a hidden file input, `upload` measuring
 *   with `createImageBitmap` then posting with vtt-3l6.16's `uploadAsset`),
 *   the session's `whenRevision` and vtt-3l6.13's in-place editor port;
 * - `BoardCanvas` fed with `buildScene` of the board view, the `UiStore` and
 *   the runtime's previews, with the runtime's overlays; its resizes set the
 *   store's viewport; the in-place editor in its overlay; images through an
 *   `ImageCache` resolving `assetUrl`;
 * - on mount: the camera store connected, the first-visit fit, dependency
 *   tracing and the keybindings; all undone on unmount.
 *
 * The renderer keeps vtt-3l6.6's order (objects, object-related overlays,
 * covers, chrome); the shell draws nothing on the canvas itself.
 */
import type { WebSocketConstructor } from "@vtt/protocol";
import {
  type CSSProperties,
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { appKeyActions, bindKeybindings } from "./app/keybindings";
import { Notices } from "./app/Notices";
import { StatusBar } from "./app/StatusBar";
import { Toolbar } from "./app/Toolbar";
import { assetUrl, uploadAsset } from "./assets/upload";
import { BoardCanvas, type CreateRenderer } from "./canvas/BoardCanvas";
import { createInPlaceEditorPort, requestFormulaBarFocus } from "./formula-bar/editor-port";
import { FormulaBar } from "./formula-bar/FormulaBar";
import { InPlaceEditor } from "./formula-bar/InPlaceEditor";
import { Inspector } from "./inspector/Inspector";
import { startTracing } from "./inspector/tracing";
import type { UploadedAsset, Viewport } from "./interaction/contracts";
import { registerCreationTools } from "./interaction/create-tools";
import { withHandles } from "./interaction/handles";
import { ToolRegistry } from "./interaction/registry";
import { createInteractionRuntime, type InteractionRuntime } from "./interaction/runtime";
import { createSelectTool } from "./interaction/select-tool";
import { useInteraction } from "./interaction/use-interaction";
import { BoardTabs } from "./nav/BoardTabs";
import { useFirstVisitFit } from "./nav/first-visit-fit";
import { createCanvas2DRenderer } from "./render/canvas2d";
import { ImageCache } from "./render/image-cache";
import { buildScene, type Scene } from "./scene/scene";
import { readBootstrap } from "./session/bootstrap";
import { TableProvider, useSession, useTableSession, useUi, useUiStore } from "./session/hooks";
import { createTableSession, type TableSession } from "./session/table-session";
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

/** The app's renderer: Canvas2D over the canvas's context, images from `assetUrl`. */
export const appCreateRenderer: CreateRenderer = (canvas, { requestRedraw }) => {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("the board canvas has no 2D context");
  return createCanvas2DRenderer(ctx, {
    images: new ImageCache({ resolve: assetUrl, onLoad: requestRedraw }),
  });
};

/** A registry with the select tool (with handles) and the creation tools. */
export function createAppRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(withHandles(createSelectTool()));
  registerCreationTools(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// Components

export interface AppProps {
  session: TableSession;
  /** Default: `appCreateRenderer`. */
  createRenderer?: CreateRenderer;
  /** Default: a new store over `session`. */
  ui?: UiStore;
  /** The session token, for image uploads (from the bootstrap). */
  token?: string;
  /** Default: the hidden file input. */
  pickFile?: (accept: string) => Promise<File | null>;
  /** Default: `createBrowserUpload({token})`. */
  upload?: (file: File) => Promise<UploadedAsset>;
}

const EMPTY_SCENE: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };

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

export function App(props: AppProps) {
  const { session } = props;
  const [ui] = useState(() => props.ui ?? createUiStore({ session }));
  return (
    <TableProvider session={session} ui={ui}>
      <Shell {...props} ui={ui} />
    </TableProvider>
  );
}

/** Creates the runtime on mount and disposes it on unmount (also under StrictMode's remount). */
function useRuntime(create: () => InteractionRuntime): InteractionRuntime | null {
  const [runtime, setRuntime] = useState<InteractionRuntime | null>(null);
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(() => {
    const created = createRef.current();
    setRuntime(created);
    return () => {
      created.dispose();
      setRuntime((current) => (current === created ? null : current));
    };
  }, []);
  return runtime;
}

function Shell(props: AppProps & { ui: UiStore }) {
  const { session, ui } = props;
  const [registry] = useState(createAppRegistry);
  const [cameraStore] = useState<CameraStore>(() => createCameraStore({ ui, session }));
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingPick = useRef<((file: File | null) => void) | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

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

  const runtime = useRuntime(() =>
    createInteractionRuntime({
      registry,
      inputs: createRuntimeInputs(session, ui),
      toolContext: createToolContext(session, ui, { pickFile, upload }),
      ui,
      editor: createInPlaceEditorPort(ui),
      whenRevision: (revision) => session.whenRevision(revision),
    }),
  );

  useEffect(() => cameraStore.connect(), [cameraStore]);
  useFirstVisitFit({ session, ui, cameraStore });
  useEffect(() => startTracing({ session, ui }), [session, ui]);
  useEffect(() => bindKeybindings(window, appKeyActions(session, ui)), [session, ui]);
  useEffect(
    () => () => {
      pendingPick.current?.(null);
    },
    [],
  );

  return (
    <div style={ROOT_STYLE}>
      <Toolbar registry={registry} />
      <div style={MAIN_STYLE}>
        <main style={BOARD_COLUMN_STYLE}>
          <BoardTabs />
          <FormulaBar session={session} ui={ui} />
          <div style={CANVAS_AREA_STYLE}>
            {runtime === null ? null : (
              <CanvasPane
                runtime={runtime}
                registry={registry}
                createRenderer={props.createRenderer ?? appCreateRenderer}
              />
            )}
          </div>
        </main>
        <div style={INSPECTOR_STYLE}>
          <Inspector
            session={session}
            ui={ui}
            onEditFormula={(cell) => requestFormulaBarFocus(ui, cell)}
          />
        </div>
      </div>
      <StatusBar />
      <Notices />
      <input ref={fileInput} type="file" hidden aria-hidden="true" tabIndex={-1} />
    </div>
  );
}

interface CanvasPaneProps {
  runtime: InteractionRuntime;
  registry: ToolRegistry;
  createRenderer: CreateRenderer;
}

function CanvasPane({ runtime, registry, createRenderer }: CanvasPaneProps) {
  const session = useTableSession();
  const ui = useUiStore();
  const { overlays, previews, handlers } = useInteraction({ runtime });
  const viewVersion = useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  const selection = useUi((s) => s.selection);
  const hover = useUi((s) => s.hover);
  const highlight = useUi((s) => s.highlight);
  const camera = useUi((s) => s.camera);
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion keys the board view's live maps
  const scene = useMemo(() => {
    const view = session.boardView();
    if (view === null) return EMPTY_SCENE;
    return buildScene({
      views: view.objects.values(),
      covers: [...view.covers.values()],
      board: view.board,
      viewer,
      selection,
      hover,
      highlight,
      previews,
    });
  }, [session, viewVersion, viewer, selection, hover, highlight, previews]);
  const setViewport = useCallback((viewport: Viewport) => ui.setViewport(viewport), [ui]);

  const machine = runtime.machine();
  const active = registry.get(machine.tool);
  const toolState = machine.tools[machine.tool];
  const cursor =
    active === undefined || toolState === undefined ? "default" : active.cursor(toolState as never);

  return (
    <div style={{ position: "absolute", inset: 0, cursor }}>
      <BoardCanvas
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
  createRenderer?: CreateRenderer;
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
