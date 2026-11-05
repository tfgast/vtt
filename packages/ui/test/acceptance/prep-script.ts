/**
 * The driver of the M4 epic acceptance (vtt-3l6.18; DESIGN.md §8.4 steps 1–4
 * as interpreted by M4 plan Q19): an in-process authority on a temp table
 * file with the asset routes, the real composed `<App>` in jsdom with a
 * recording renderer, and the GM's gestures — `BoardCanvas` pointer events
 * in screen coordinates, user-event typing into the inspector, the formula
 * bar and the in-place editor — plus a second GM protocol client for the
 * assertions. It never reaches into product state to make something
 * happen; it reads state only to wait for it and to find screen points.
 */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createAssetHttpHandler,
  type HttpHandler,
  type RunningServer,
  startServer,
  TableHost,
} from "@vtt/authority";
import { ProtocolClient, type WireResult } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import {
  App,
  COVER_FILL,
  type CreateRenderer,
  createCanvas2DRenderer,
  createTableSession,
  createUiStore,
  ImageCache,
  type RecordedCall,
  RecordingContext,
  type TableSession,
  toScreen,
  type UiStore,
  type UploadedAsset,
  uploadAsset,
} from "@vtt/ui";
import { createElement } from "react";
import { JSDOM_ORIGIN, NodeWebSocket, until, whenReady } from "../support/authority";

/** The canvas's (mocked) client rectangle and viewport. */
export const RECT = { left: 0, top: 0, width: 800, height: 600 };
export const VIEWPORT = { width: RECT.width, height: RECT.height };

export const GM_BOARD = "gm_board";

/**
 * The example images of `@vtt/fixtures` (vtt-nb8.6). `@vtt/ui` does not
 * depend on `@vtt/fixtures`, so the files are read by path; their pixel
 * sizes are measured from the PNG header, as a browser would measure them.
 */
const FIXTURE_ASSETS = join(import.meta.dirname, "..", "..", "..", "fixtures", "assets");
export const CRYPT_MAP_FILE = join(FIXTURE_ASSETS, "crypt-map.png");
export const GOBLIN_FILE = join(FIXTURE_ASSETS, "goblin.png");

/** A PNG's pixel size from its IHDR chunk. */
export async function measurePng(file: Blob): Promise<{ width: number; height: number }> {
  const bytes = new DataView(await file.arrayBuffer());
  return { width: bytes.getUint32(16), height: bytes.getUint32(20) };
}

export async function pngFile(path: string, name: string): Promise<File> {
  return new File([await readFile(path)], name, { type: "image/png" });
}

// ---------------------------------------------------------------------------
// The authority

export interface PrepAuthority {
  readonly dir: string;
  readonly path: string;
  readonly host: TableHost;
  readonly server: RunningServer;
  /** The HTTP origin of the asset routes. */
  readonly base: string;
  client(name: string): Promise<ProtocolClient>;
  session(): TableSession;
  /** Closes the sessions, clients, the server and the host (the file stays). */
  close(): Promise<void>;
  /** `close`, then removes the temp directory. */
  cleanup(): Promise<void>;
}

/**
 * A new table on a temp file (`TableHost.open(createIfMissing)`, autosave
 * off) served by `startServer` with vtt-3l6.16's asset handler.
 */
export async function startPrepAuthority(): Promise<PrepAuthority> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-prep-")));
  const path = join(dir, "crypt.table.json");
  const host = await TableHost.open(path, { createIfMissing: true, autosave: false });
  const assets: HttpHandler = createAssetHttpHandler({ host });
  const server = await startServer({
    host,
    port: 0,
    allowOrigins: [JSDOM_ORIGIN],
    http: [assets],
  });
  const clients: ProtocolClient[] = [];
  const sessions: TableSession[] = [];
  let closed = false;
  const authority: PrepAuthority = {
    dir,
    path,
    host,
    server,
    base: `http://127.0.0.1:${server.port}`,
    async client(name) {
      const client = new ProtocolClient({
        url: server.url,
        token: server.token,
        client: { name, kind: "test" },
        WebSocket: NodeWebSocket,
        onWarning: () => undefined,
      });
      clients.push(client);
      await client.connect();
      return client;
    },
    session() {
      const session = createTableSession({
        url: server.url,
        token: server.token,
        WebSocket: NodeWebSocket,
      });
      sessions.push(session);
      return session;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const s of sessions.splice(0)) s.close();
      for (const c of clients.splice(0)) c.close();
      await server.close();
      await host.close().catch(() => undefined);
    },
    async cleanup() {
      await authority.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return authority;
}

// ---------------------------------------------------------------------------
// The app

export interface PrepApp {
  readonly session: TableSession;
  readonly ui: UiStore;
  readonly ctx: RecordingContext;
  readonly canvas: HTMLCanvasElement;
  /** The files the injected picker answers with, in order. */
  readonly picks: File[];
  unmount(): void;
}

/**
 * Renders `<App>` on a new session with the recording renderer, the picker
 * answering from `picks`, and an upload that measures the PNG header (jsdom
 * has no `createImageBitmap`) and posts with `uploadAsset`.
 */
export async function renderPrepApp(authority: PrepAuthority): Promise<PrepApp> {
  const session = authority.session();
  const ui = createUiStore({ session });
  const ctx = new RecordingContext();
  const createRenderer: CreateRenderer = (_canvas, { requestRedraw }) =>
    createCanvas2DRenderer(ctx, {
      images: new ImageCache({ resolve: (p) => p, onLoad: requestRedraw }),
    });
  const picks: File[] = [];
  const pickFile = async () => picks.shift() ?? null;
  const upload = async (file: File): Promise<UploadedAsset> => {
    const size = await measurePng(file);
    const { path } = await uploadAsset(file, {
      token: authority.server.token,
      base: authority.base,
    });
    return { path, ...size };
  };
  const utils = render(
    createElement(App, {
      session,
      ui,
      token: authority.server.token,
      createRenderer,
      pickFile,
      upload,
    }),
  );
  await whenReady(session);
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  let mounted = true;
  const unmount = () => {
    if (mounted) utils.unmount();
    mounted = false;
  };
  return { session, ui, ctx, canvas, picks, unmount };
}

// ---------------------------------------------------------------------------
// Waiting and reading

/** Lets pending renders and effects settle. */
export const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** A cell's value in the app's current view of `id`. */
export function cellOf(app: PrepApp, id: ObjectId, cell: string): WireResult | undefined {
  return app.session.objectView(id)?.cells[cell]?.value;
}

export function pointOf(v: WireResult | undefined): Point | null {
  if (v?.type !== "list" || v.items.length !== 2) return null;
  const [x, y] = v.items;
  return x?.type === "number" && y?.type === "number" ? [x.value, y.value] : null;
}

export function positionOf(app: PrepApp, id: ObjectId): Point {
  const p = pointOf(cellOf(app, id, "position"));
  if (p === null) throw new Error(`${id} has no position in the view`);
  return p;
}

export const refsOf = (v: WireResult | undefined): ObjectId[] =>
  v?.type === "list" ? v.items.flatMap((i) => (i.type === "ref" ? [i.object] : [])) : [];

/**
 * Waits until the selection is one id starting with `prefix` and not in
 * `except` (what a creation or a template drag selects), and its view has
 * arrived; returns it.
 */
export async function newSelection(
  app: PrepApp,
  prefix: string,
  what: string,
  except: readonly ObjectId[] = [],
): Promise<ObjectId> {
  const current = () => {
    const sel = app.ui.getState().selection;
    const id = sel[0];
    return sel.length === 1 && id !== undefined && id.startsWith(prefix) && !except.includes(id)
      ? id
      : null;
  };
  await until(() => current() !== null, what, 8000);
  const id = current() as ObjectId;
  await until(() => app.session.objectView(id) !== null, `the view of ${id}`);
  return id;
}

/** Waits for the active board's view of `board` and the measured viewport, then settles. */
export async function onBoard(app: PrepApp, board: string): Promise<void> {
  await until(
    () =>
      app.session.getSnapshot().activeBoard === board &&
      app.session.boardView()?.board === board &&
      app.ui.getState().viewport.width > 0,
    `the board ${board}`,
  );
  await settle(60);
}

// ---------------------------------------------------------------------------
// Canvas gestures (screen coordinates under the current camera)

export interface Mods {
  altKey?: boolean;
  shiftKey?: boolean;
}

export function screenOf(app: PrepApp, p: Point): Point {
  return toScreen(app.ui.getState().camera, p, VIEWPORT);
}

function pointer(app: PrepApp, type: "down" | "move" | "up", p: Point, mods: Mods = {}) {
  const [x, y] = screenOf(app, p);
  const init = {
    pointerId: 1,
    clientX: x,
    clientY: y,
    button: type === "move" ? -1 : 0,
    buttons: type === "up" ? 0 : 1,
    ...mods,
  };
  act(() => {
    if (type === "down") fireEvent.pointerDown(app.canvas, init);
    else if (type === "move") fireEvent.pointerMove(app.canvas, init);
    else fireEvent.pointerUp(app.canvas, init);
  });
}

export function click(app: PrepApp, p: Point, mods: Mods = {}) {
  pointer(app, "down", p, mods);
  pointer(app, "up", p, mods);
}

/** A press at `from`, a move half way and to `to`, a release at `to` (with `up` modifiers). */
export function drag(app: PrepApp, from: Point, to: Point, up: Mods = {}) {
  pointer(app, "down", from);
  pointer(app, "move", [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
  pointer(app, "move", to, up);
  pointer(app, "up", to, up);
}

export function doubleClick(app: PrepApp, p: Point) {
  const [x, y] = screenOf(app, p);
  act(() => {
    fireEvent.doubleClick(app.canvas, { clientX: x, clientY: y });
  });
}

/** Escape on the canvas: with no gesture in progress the select tool clears the selection. */
export function pressEscape(app: PrepApp) {
  act(() => {
    fireEvent.keyDown(app.canvas, { key: "Escape", code: "Escape" });
  });
}

/** One wheel event at the canvas center (positive `deltaY` zooms out). */
export function wheel(app: PrepApp, deltaY: number) {
  act(() => {
    fireEvent.wheel(app.canvas, {
      clientX: VIEWPORT.width / 2,
      clientY: VIEWPORT.height / 2,
      deltaY,
    });
  });
}

/** Alt+clicks `p` until `target` is the selection (DESIGN.md §4.6: Alt+click cycles). */
export async function altClickUntil(app: PrepApp, p: Point, target: ObjectId): Promise<void> {
  for (let i = 0; i < 4; i++) {
    click(app, p, { altKey: true });
    if (app.ui.getState().selection.join() === target) return;
  }
  throw new Error(`Alt+click at ${p.join(",")} never selected ${target}`);
}

// ---------------------------------------------------------------------------
// Chrome

export const user = userEvent.setup({ delay: null });

export function chooseTool(name: string) {
  const toolbar = screen.getByRole("toolbar", { name: "Tools" });
  fireEvent.click(within(toolbar).getByRole("button", { name }));
}

export function inspector(): HTMLElement {
  return screen.getByRole("complementary", { name: "Inspector panel" });
}

/** The inspector's header region, once it shows `id`. */
export async function header(id: ObjectId): Promise<HTMLElement> {
  return waitFor(() => {
    const region = within(inspector()).getByRole("region", { name: "Object" });
    if (!within(region).queryByText(id, { selector: "code" })) {
      throw new Error(`the inspector does not show ${id}`);
    }
    return region;
  });
}

/** The inspector row of `cell`. */
export async function row(cell: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = inspector().querySelector<HTMLElement>(`li[data-cell="${cell}"]`);
    if (el === null) throw new Error(`no row ${cell}`);
    return el;
  });
}

export async function rowValue(cell: string): Promise<string> {
  const el = (await row(cell)).querySelector('[data-part="value"]');
  return el?.textContent ?? "";
}

/** Adds a user cell with "Add cell" (empty). */
export async function addCell(app: PrepApp, id: ObjectId, cell: string): Promise<void> {
  const input = within(inspector()).getByRole("textbox", { name: "New cell name" });
  await user.clear(input);
  await user.type(input, cell);
  await user.click(within(inspector()).getByRole("button", { name: "Add cell" }));
  await until(() => app.session.objectView(id)?.cells[cell] !== undefined, `${id}.${cell}`);
}

/**
 * Double-clicks the value of `cell` in the inspector and types `text` + Enter
 * (DESIGN.md §4.6 Typing into a cell: a literal, or `=…` a formula); waits
 * until the view of `id` satisfies `done`.
 */
export async function typeIntoRow(
  app: PrepApp,
  id: ObjectId,
  cell: string,
  text: string,
  done: (v: WireResult | undefined) => boolean,
): Promise<void> {
  const value = (await row(cell)).querySelector<HTMLElement>('[data-part="value"]');
  if (value === null) throw new Error(`no value in row ${cell}`);
  await user.dblClick(value);
  const input = within(inspector()).getByRole("textbox", { name: `Value of ${cell}` });
  await user.clear(input);
  await user.type(input, `${text}{Enter}`);
  await until(() => done(cellOf(app, id, cell)), `${id}.${cell} ← ${text}`);
}

export const isNumber = (n: number) => (v: WireResult | undefined) =>
  v?.type === "number" && v.value === n;
export const isText = (s: string) => (v: WireResult | undefined) =>
  v?.type === "text" && v.value === s;
export const isRef = (id: ObjectId) => (v: WireResult | undefined) =>
  v?.type === "ref" && v.object === id;

/** Adds `cell` with "Add cell" and types `text` into it. */
export async function addCellWith(
  app: PrepApp,
  id: ObjectId,
  cell: string,
  text: string,
  done: (v: WireResult | undefined) => boolean,
): Promise<void> {
  await addCell(app, id, cell);
  await typeIntoRow(app, id, cell, text, done);
}

/** Whether the app's view of `id.cell` is a formula with `source`. */
export function hasFormula(app: PrepApp, id: ObjectId, cell: string, source: string): boolean {
  const view = app.session.objectView(id)?.cells[cell];
  return view?.kind === "formula" && view.source === source;
}

/**
 * Focuses `cell` (a click on its row) and types `=source` + Enter into the
 * formula bar (DESIGN.md §4.6 The formula bar).
 */
export async function typeFormulaInBar(
  app: PrepApp,
  id: ObjectId,
  cell: string,
  source: string,
): Promise<void> {
  await user.click(await row(cell));
  const bar = await screen.findByRole("textbox", { name: "Formula" });
  await user.click(bar);
  await user.clear(bar);
  await user.type(bar, `=${source}{Enter}`);
  await until(() => hasFormula(app, id, cell, source), `the formula of ${id}.${cell}`);
}

/** Adds a tag with the header's tag control. */
export async function addTag(app: PrepApp, id: ObjectId, tag: string): Promise<void> {
  const input = within(await header(id)).getByRole("textbox", { name: "New tag" });
  await user.type(input, `${tag}{Enter}`);
  await until(() => tagsOf(app, id).includes(tag), `${id} tagged ${tag}`);
}

/** The tags in the app's view of `id`. */
export function tagsOf(app: PrepApp, id: ObjectId): string[] {
  const v = cellOf(app, id, "tag");
  return v?.type === "list" ? v.items.flatMap((i) => (i.type === "text" ? [i.value] : [])) : [];
}

/** Checks the header's Template or Character toggle. */
export async function setFlag(
  app: PrepApp,
  id: ObjectId,
  flag: "Template" | "Character",
): Promise<void> {
  await user.click(within(await header(id)).getByRole("checkbox", { name: flag }));
  await until(() => {
    const view = app.session.objectView(id);
    return flag === "Template" ? view?.is_template === true : view?.is_character === true;
  }, `${id} a ${flag}`);
}

/** Adds a per-cell visibility rule with the inspector's "Visibility rules" form. */
export async function addVisibilityRule(
  app: PrepApp,
  id: ObjectId,
  cell: string,
  viewer: "gm" | "all" | "owner",
): Promise<void> {
  const section = within(inspector()).getByRole("region", { name: "Visibility rules" });
  await user.type(within(section).getByRole("textbox", { name: "Rule cell name" }), cell);
  const group = within(section).getByRole("group", { name: "New rule viewers" });
  await user.click(within(group).getByRole("checkbox", { name: viewer }));
  await user.click(within(section).getByRole("button", { name: "Add visibility rule" }));
  await until(
    () => app.session.objectView(id)?.cells[cell]?.visibility !== undefined,
    `the visibility of ${id}.${cell}`,
  );
}

/** Double-clicks `at` on the canvas and types `text` into the in-place editor of `cell`. */
export async function editInPlace(
  app: PrepApp,
  id: ObjectId,
  at: Point,
  cell: string,
  text: string,
): Promise<void> {
  doubleClick(app, at);
  const editor = await screen.findByRole("textbox", { name: `Edit ${cell}` });
  await user.clear(editor);
  await user.type(editor, `${text}{Enter}`);
  await until(() => isText(text)(cellOf(app, id, cell)), `${id}.${cell} in place`);
}

/** "Move selection to board…" → `board`. */
export async function moveSelectionTo(app: PrepApp, board: string, boardId: string) {
  const command = screen.getByRole("button", { name: "Move selection to board…" });
  await waitFor(() => {
    if ((command as HTMLButtonElement).disabled) throw new Error("the command is disabled");
  });
  await user.click(command);
  const menu = screen.getByRole("menu", { name: "Move selection to board" });
  await user.click(within(menu).getByRole("menuitem", { name: board }));
  await onBoard(app, boardId);
}

/** Chooses `label` in the toolbar's "View as" and waits for that viewer's board view. */
export async function viewAs(app: PrepApp, label: string, key: string): Promise<void> {
  await user.selectOptions(screen.getByRole("combobox", { name: "View as" }), label);
  await until(
    () =>
      app.session.viewerKey() === key &&
      app.session.getSnapshot().viewer.type === (key === "gm" ? "gm" : "character"),
    `the view as ${label}`,
  );
  await settle(60);
}

// ---------------------------------------------------------------------------
// Frames

/** The recorded frames (each starts at the renderer's `clearRect`). */
export function frames(ctx: RecordingContext): RecordedCall[][] {
  const out: RecordedCall[][] = [];
  for (const call of ctx.calls) {
    if (call.name === "clearRect") out.push([]);
    out.at(-1)?.push(call);
  }
  return out;
}

export function lastFrame(app: PrepApp): RecordedCall[] {
  return frames(app.ctx).at(-1) ?? [];
}

/** The cover fills of a frame (vtt-3l6.6's `paintCover`). */
export function coverFills(frame: RecordedCall[]): RecordedCall[] {
  return frame.filter(
    (c) => (c.name === "fill" || c.name === "fillRect") && c.style?.fillStyle === COVER_FILL,
  );
}

/** The texts a frame draws (labels and `text` cells). */
export function texts(frame: RecordedCall[]): string[] {
  return frame.filter((c) => c.name === "fillText").map((c) => String(c.args[0]));
}
