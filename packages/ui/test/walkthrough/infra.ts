/**
 * The walkthrough's driver infrastructure (vtt-nb8.17; M6 plan decisions
 * Q1, Q2, Q13; M4-D13; review r1 finding 10, r2 findings 1–3):
 * `startWalkthrough` starts an in-process authority on a temp table file
 * created with `stockedTableSnapshot` (vtt-1xv.22) and served with
 * vtt-3l6.16's asset routes and a `ScriptedDiceSource`, and renders the real
 * composed `<App>` (vtt-1xv.23) in jsdom, drawn by the app's face renderer
 * into a `RecordingContext`. It returns the `DriverContext` of contract.ts.
 *
 * The app is the product's, wired as `startApp` wires it except for the
 * ports jsdom lacks:
 * - the canvas and every element measure 800 × 600 at the page origin
 *   (`getBoundingClientRect`), so the board viewport is that size;
 * - jsdom has no `createImageBitmap`: a stub reports a PNG's real pixel size
 *   from its header (as vtt-3l6.18 measured), so the app's own
 *   `measureImage` and `createBrowserUpload` run;
 * - jsdom's page origin is not the authority's, so the image tool's upload
 *   is `createBrowserUpload` with the authority's origin as `base`, and the
 *   inspector's Upload… is bound to it with `bindCellUpload`;
 * - jsdom opens no file dialog: a hidden file input's `click` takes the next
 *   file queued by `pickFile` and fires `change` (or `cancel` with nothing
 *   queued);
 * - the unauthorized banner's Reload (`location.reload`) remounts the app
 *   on a new session with the new token, as a page reload would.
 *
 * Autosave is off: a save is the GM's Ctrl+S (or a restart's final save).
 */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import {
  createAssetHttpHandler,
  createMcpServer,
  importAssetTool,
  type RunningServer,
  ScriptedDiceSource,
  startServer,
  stockedTableSnapshot,
  subscriptionTools,
  TableHost,
} from "@vtt/authority";
import { ProtocolClient } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import {
  App,
  assetUrl,
  bindCellUpload,
  createAppRenderer,
  createBrowserUpload,
  createFaceStateStore,
  createTableSession,
  createUiStore,
  type FaceStateStore,
  RecordingContext,
  type TableSession,
  toBoard,
  toScreen,
  type UiStore,
  uploadAsset,
} from "@vtt/ui";
import { createElement } from "react";
import { vi } from "vitest";
import { JSDOM_ORIGIN, NodeWebSocket, until, whenReady } from "../support/authority";
import type {
  CameraTarget,
  DriverContext,
  Point,
  WalkthroughAgent,
  WalkthroughOptions,
} from "./contract";

/** The size every element (the board canvas among them) measures, at the page origin. */
export const VIEWPORT = { width: 800, height: 600 } as const;

/** How long the app may take to connect, or to come back after a restart. */
const CONNECT_MS = 20_000;

/** A PNG's pixel size from its IHDR chunk; throws for anything else. */
export async function measurePng(blob: Blob): Promise<{ width: number; height: number }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) {
    throw new Error("not a PNG: the walkthrough's createImageBitmap stub measures PNGs only");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const typeOf = (name: string): string =>
  IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Lets pending renders and effects settle. */
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** One mounted `<App>` on its own session. */
interface Mounted {
  readonly session: TableSession;
  readonly ui: UiStore;
  readonly faceState: FaceStateStore;
  readonly renderer: RecordingContext;
  readonly root: HTMLElement;
  unmount(): void;
}

/** A text cell's value in a directory view. */
function textOf(cells: Record<string, { value: unknown }>, cell: string): string | null {
  const v = cells[cell]?.value as { type?: string; value?: unknown } | undefined;
  return v?.type === "text" && typeof v.value === "string" ? v.value : null;
}

function refOf(cells: Record<string, { value: unknown }>, cell: string): string | null {
  const v = cells[cell]?.value as { type?: string; object?: unknown } | undefined;
  return v?.type === "ref" && typeof v.object === "string" ? v.object : null;
}

/**
 * Starts the walkthrough: a new stocked table on a temp file, its authority,
 * and the app connected to it as the GM on the GM board.
 */
export async function startWalkthrough(options: WalkthroughOptions): Promise<DriverContext> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-walkthrough-")));
  const file = join(dir, "first-session.table.json");
  const dice = new ScriptedDiceSource(options.dice);
  const openHost = (createIfMissing: boolean) =>
    TableHost.open(file, {
      createIfMissing,
      newTable: stockedTableSnapshot,
      dice,
      autosave: false,
    });
  const serve = (host: TableHost, port: number) =>
    startServer({
      host,
      port,
      allowOrigins: [JSDOM_ORIGIN],
      http: [createAssetHttpHandler({ host })],
    });

  // -- jsdom ports (restored by close)
  const restores: (() => void)[] = [];
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    right: VIEWPORT.width,
    bottom: VIEWPORT.height,
    toJSON: () => ({}),
  });
  restores.push(() => rect.mockRestore());

  if (typeof globalThis.createImageBitmap !== "function") {
    const stub = async (image: unknown) => {
      if (!(image instanceof Blob))
        throw new Error("the createImageBitmap stub measures Blobs only");
      const size = await measurePng(image);
      return { ...size, close: () => undefined } as unknown as ImageBitmap;
    };
    Object.defineProperty(globalThis, "createImageBitmap", {
      value: stub,
      configurable: true,
      writable: true,
    });
    restores.push(() => {
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    });
  }

  const picks: File[] = [];
  const realClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function click(this: HTMLInputElement) {
    if (this.type !== "file") {
      realClick.call(this);
      return;
    }
    const picked = picks.shift();
    // The dialog answers after the click returns, as a browser's does.
    setTimeout(() => {
      if (picked === undefined) {
        this.dispatchEvent(new Event("cancel"));
        return;
      }
      const list = { 0: picked, length: 1, item: (i: number) => (i === 0 ? picked : null) };
      Object.defineProperty(this, "files", {
        configurable: true,
        get: () => list as unknown as FileList,
      });
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }, 0);
  };
  restores.push(() => {
    HTMLInputElement.prototype.click = realClick;
  });

  try {
    localStorage.clear();
  } catch {
    // No storage: cameras are only kept for the page.
  }

  // -- the authority
  let host = await openHost(true);
  let server: RunningServer;
  try {
    server = await serve(host, 0);
  } catch (err) {
    await host.close();
    for (const restore of restores.reverse()) restore();
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const port = server.port;
  const origin = `http://127.0.0.1:${port}`;

  const newGm = async (): Promise<ProtocolClient> => {
    const client = new ProtocolClient({
      url: server.url,
      token: server.token,
      client: { name: "walkthrough-gm", kind: "test" },
      WebSocket: NodeWebSocket,
      onWarning: () => undefined,
    });
    await client.connect();
    return client;
  };

  // -- the app
  const mount = (): Mounted => {
    const token = server.token;
    const session = createTableSession({ url: server.url, token, WebSocket: NodeWebSocket });
    const unbind = bindCellUpload(session, { token, base: origin });
    const ui = createUiStore({ session });
    const faceState = createFaceStateStore();
    const renderer = new RecordingContext(VIEWPORT);
    const utils = render(
      createElement(App, {
        session,
        ui,
        faceState,
        token,
        createRenderer: (_canvas, { requestRedraw }) =>
          createAppRenderer(renderer, {
            requestRedraw,
            resolve: (path) => `${origin}${assetUrl(path)}`,
          }),
        upload: createBrowserUpload({ token, base: origin }),
      }),
    );
    let mounted = true;
    return {
      session,
      ui,
      faceState,
      renderer,
      root: utils.container,
      unmount() {
        if (!mounted) return;
        mounted = false;
        utils.unmount();
        utils.container.remove();
        unbind();
        session.close();
      },
    };
  };

  const connected = async (app: Mounted): Promise<void> => {
    await whenReady(app.session, CONNECT_MS);
    await until(
      () =>
        app.root.querySelector("canvas") !== null &&
        app.ui.getState().viewport.width > 0 &&
        app.session.boardView() !== null,
      "the app's board",
      CONNECT_MS,
    );
    await settle(60);
  };

  let app = mount();
  let gm: ProtocolClient | null = null;
  const agents = new Set<WalkthroughAgent>();
  let closed = false;

  const closeAgents = async () => {
    await Promise.all([...agents].map((a) => a.close()));
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    app.unmount();
    await closeAgents();
    gm?.close();
    await server.close();
    await host.close();
    for (const restore of restores.splice(0).reverse()) restore();
    try {
      localStorage.clear();
    } catch {
      // No storage.
    }
    await rm(dir, { recursive: true, force: true });
  };

  const frame = (): Promise<void> =>
    act(async () => {
      await new Promise<void>((resolve) => {
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 20);
        }
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

  const canvasOrigin = (): Point => {
    const canvas = app.root.querySelector("canvas");
    if (canvas === null) throw new Error("the app has no board canvas");
    const r = canvas.getBoundingClientRect();
    return [r.left, r.top];
  };

  const viewport = () => {
    const { width, height } = app.ui.getState().viewport;
    return { width, height };
  };

  /** The board of `id`'s outermost container, from the GM directory. */
  const boardOf = (id: ObjectId): BoardId | null => {
    const directory = app.session.directory();
    let at = id;
    for (let i = 0; i < 64; i++) {
      const view = directory.get(at);
      if (view === undefined) return null;
      const container = refOf(view.cells, "container");
      if (container === null) return refOf(view.cells, "board");
      at = container;
    }
    return null;
  };

  const ctx: DriverContext = {
    get root() {
      return app.root;
    },
    get session() {
      return app.session;
    },
    get ui() {
      return app.ui;
    },
    get faceState() {
      return app.faceState;
    },
    get renderer() {
      return app.renderer;
    },
    get gm() {
      if (gm === null) throw new Error("the walkthrough's GM client is not connected");
      return gm;
    },
    file,
    origin,

    toScreen(p) {
      const [x, y] = toScreen(app.ui.getState().camera, p, viewport());
      const [left, top] = canvasOrigin();
      return [x + left, y + top];
    },
    toBoard(p) {
      const [left, top] = canvasOrigin();
      const [x, y] = toBoard(app.ui.getState().camera, [p[0] - left, p[1] - top], viewport());
      return [x, y];
    },
    async setCamera({ center, zoom }: CameraTarget) {
      act(() => app.ui.setCamera({ x: center[0], y: center[1], zoom }));
      await frame();
    },
    frame,

    pickFile(f) {
      picks.push(f);
    },
    upload(bytes, name) {
      const blob = new File([new Uint8Array(bytes)], name, { type: typeOf(name) });
      return uploadAsset(blob, { token: server.token, base: origin });
    },
    savedFile() {
      return readFile(file, "utf8");
    },

    byName(name, board) {
      const matches: ObjectId[] = [];
      for (const [id, view] of app.session.directory()) {
        if (textOf(view.cells, "name") !== name) continue;
        if (board !== undefined && boardOf(id) !== board) continue;
        matches.push(id);
      }
      const only = matches[0];
      if (matches.length === 1 && only !== undefined) return only;
      const where = board === undefined ? "" : ` on ${board}`;
      throw new Error(
        matches.length === 0
          ? `byName: no live object named "${name}"${where}`
          : `byName: ${matches.length} objects named "${name}"${where}: ${matches.join(", ")}`,
      );
    },

    async startAgent(name) {
      const client = new ProtocolClient({
        url: server.url,
        token: server.token,
        client: { name, kind: "agent" },
        agent_name: name,
        WebSocket: NodeWebSocket,
        onWarning: () => undefined,
      });
      const mcpServer = createMcpServer({
        client,
        extensions: [
          subscriptionTools(),
          importAssetTool({ credentials: () => ({ url: server.url, token: server.token }) }),
        ],
      });
      const mcp = new Client({ name, version: "1.0.0" });
      let done: Promise<void> | null = null;
      const agent: WalkthroughAgent = {
        mcp,
        close() {
          done ??= (async () => {
            agents.delete(agent);
            await mcp.close().catch(() => undefined);
            await mcpServer.close().catch(() => undefined);
            client.close();
          })();
          return done;
        },
      };
      agents.add(agent);
      try {
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverSide);
        await mcp.connect(clientSide);
        await client.connect();
      } catch (err) {
        await agent.close();
        throw err;
      }
      return agent;
    },

    async restart() {
      if (closed) throw new Error("the walkthrough is closed");
      const board = app.session.getSnapshot().activeBoard;
      await closeAgents();
      gm?.close();
      gm = null;

      // The page reload the banner's Reload asks for.
      let reloaded!: () => void;
      const reloading = new Promise<void>((resolve) => {
        reloaded = resolve;
      });
      const location = Object.getOwnPropertyDescriptor(globalThis, "location");
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { ...window.location, reload: () => reloaded() },
      });
      try {
        await server.close("restart");
        const result = await host.close();
        if (!result.saved) throw new Error(`the restart's final save failed: ${result.error}`);
        host = await openHost(false);
        server = await serve(host, port);

        const status = within(app.root).getByRole("contentinfo");
        const reload = await waitFor(() => within(status).getByRole("button", { name: "Reload" }), {
          timeout: CONNECT_MS,
        });
        fireEvent.click(reload);
        await reloading;
      } finally {
        if (location === undefined) delete (globalThis as { location?: unknown }).location;
        else Object.defineProperty(globalThis, "location", location);
      }

      app.unmount();
      app = mount();
      await connected(app);
      gm = await newGm();
      // The app reopens on the board that was active (vtt-qf5.57, M6-D24).
      if (board !== null) {
        await until(
          () =>
            app.session.getSnapshot().activeBoard === board &&
            app.session.boardView()?.board === board,
          `the remembered board ${board} after the restart`,
          CONNECT_MS,
        );
        await settle(60);
      }
    },

    close,
  };

  try {
    await connected(app);
    gm = await newGm();
  } catch (err) {
    await close();
    throw err;
  }
  return ctx;
}
