/**
 * Image files dropped on the canvas (vtt-qf5.33; DESIGN.md §4.6 Appearance
 * cells, §8.1; M6 plan Q7 alternative a): the real `App` in jsdom against an
 * in-process authority on a temp-file table with vtt-3l6.16's asset handler.
 * The injected `upload` posts the file with `uploadAsset` to the authority's
 * HTTP origin and reports a fixed measured size (jsdom cannot decode
 * images). Drops are DOM `drop` events on the canvas carrying a
 * DataTransfer-like object with `Files` and the files.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createAssetHttpHandler } from "@vtt/authority";
import type { WireOp } from "@vtt/protocol";
import type { Point } from "@vtt/schema";
import {
  App,
  createAppRenderer,
  createUiStore,
  RecordingContext,
  sessionNotices,
  type TableSession,
  toScreen,
  type UiStore,
  type UploadedAsset,
  uploadAsset,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  startAuthority,
  type TestAuthority,
  until,
  whenReady,
} from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const VIEWPORT = { width: 800, height: 600 };
const BOARD = "gm_board";
const CAMERA = { x: 0, y: 0, zoom: 1 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MEASURED = { width: 300, height: 200 };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    x: 0,
    y: 0,
    right: RECT.width,
    bottom: RECT.height,
    toJSON: () => ({}),
  });
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await cleanupAuthorities();
  localStorage.clear();
});

const text = (value: string) => ({ type: "text" as const, value });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: BOARD,
  position: [x, y] as [number, number],
});

/** A goblin token at 2,0 and a statue at -2,0 whose `image` is a formula. */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "goblin",
    to: at(2, 0),
    init: { shape: { type: "rect", width: 1, height: 1 }, cells: { name: text("Goblin") } },
  },
  {
    type: "create_object",
    id: "statue",
    to: at(-2, 0),
    init: {
      shape: { type: "rect", width: 1, height: 1 },
      cells: { name: text("Statue"), image: { type: "formula", source: '="statue.png"' } },
    },
  },
];

const png = (name: string) => new File([PNG], name, { type: "image/png" });

/** A gate the injected upload waits on, so a test can act during an upload. */
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface World {
  authority: TestAuthority;
  session: TableSession;
  ui: UiStore;
  canvas: HTMLCanvasElement;
  uploads: { started: number };
  transacts(): { ops: WireOp[]; base_revision?: number; label?: string }[];
  notices(): string[];
  cell(id: string, cell: string): unknown;
  created(): string[];
  drop(files: File[], p: Point): void;
}

async function world(options: { holdUpload?: Promise<void> } = {}): Promise<World> {
  const authority = await startAuthority({
    file: true,
    http: (host) => [createAssetHttpHandler({ host })],
  });
  const base = `http://127.0.0.1:${authority.server.port}`;
  const seed = await authority.client("seed");
  const seeded = await seed.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));

  const session = authority.session();
  const ui = createUiStore({ session });
  const uploads = { started: 0 };
  const upload = async (file: File): Promise<UploadedAsset> => {
    uploads.started++;
    const { path } = await uploadAsset(file, { token: authority.token, base });
    if (options.holdUpload !== undefined) await options.holdUpload;
    return { path, ...MEASURED };
  };
  const ctx = new RecordingContext();
  const utils = render(
    <App
      session={session}
      ui={ui}
      upload={upload}
      createRenderer={(_canvas, { requestRedraw }) =>
        createAppRenderer(ctx, { resolve: (p) => p, requestRedraw })
      }
    />,
  );
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("goblin") === true, "the goblin's view");
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  // The first-visit fit, then the tests' camera.
  await waitFor(() => expect(ui.getState().camera.zoom).not.toBe(1));
  act(() => ui.setCamera(CAMERA));
  const request = vi.spyOn(session.client, "request");
  const store = authority.host.table.store;

  return {
    authority,
    session,
    ui,
    canvas,
    uploads,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number; label?: string }),
    notices: () =>
      sessionNotices(session)
        .list()
        .map((n) => n.text),
    cell: (id, cell) => store.getObject(id)?.cells[cell]?.content,
    created: () => store.objectsOnBoard(BOARD).filter((id) => /^image_\d+$/.test(id)),
    drop(files, p) {
      const [x, y] = toScreen(ui.getState().camera, p, VIEWPORT);
      const dt = { types: ["Files"], files, getData: () => "" };
      for (const type of ["dragover", "drop"]) {
        const ev = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
        act(() => {
          canvas.dispatchEvent(ev);
        });
      }
    },
  };
}

/** Lets pending promises and timers run. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

describe("image file drops on the canvas", () => {
  test("a PNG dropped on a token sets its image in one group, with the revision at the drop", async () => {
    const hold = gate();
    const w = await world({ holdUpload: hold.promise });
    const atDrop = w.session.getSnapshot().revision;
    expect(w.ui.getState().tool.id).toBe("select");

    w.drop([png("goblin.png")], [2, 0]);
    await until(() => w.uploads.started === 1, "the upload to start");
    // A disjoint write lands during the upload; the drop's base revision stays the drop's.
    const other = await w.authority.client("other");
    await other.transact([
      { type: "set_value", object: "statue", cell: "name", value: text("Old statue") },
    ]);
    await until(() => w.session.getSnapshot().revision > atDrop, "the other write");
    hold.open();

    await until(() => w.cell("goblin", "image") !== undefined, "the goblin's image");
    const image = w.cell("goblin", "image") as { type: string; value: string };
    expect(image.type).toBe("text");
    expect(image.value).toMatch(/goblin.*\.png$/);
    // One transact is one group (M3-D6).
    expect(w.transacts()).toMatchObject([
      {
        ops: [{ type: "set_value", object: "goblin", cell: "image", value: text(image.value) }],
        base_revision: atDrop,
        label: "Set image of Goblin",
      },
    ]);
    expect(w.created()).toEqual([]);
    expect(w.ui.getState().tool.id).toBe("select");
  }, 30_000);

  test("a PNG dropped on empty board space creates a selected image object at the drop point", async () => {
    const w = await world();
    w.drop([png("Crypt Map.png")], [0, 3]);
    await until(() => w.created().length === 1, "the image object");
    const [id] = w.created();
    if (id === undefined) throw new Error("no image object");
    expect(w.cell(id, "name")).toEqual(text("Crypt Map"));
    expect(w.cell(id, "image")).toMatchObject({ type: "text" });
    expect(w.authority.host.table.store.getObject(id)?.shape).toEqual({
      type: "rect",
      width: 3,
      height: 2,
    });
    const transacts = w.transacts();
    expect(transacts).toHaveLength(1);
    expect(transacts[0]?.label).toBe("Import Crypt Map");
    expect(transacts[0]?.ops[0]).toMatchObject({
      type: "create_object",
      id_base: "image",
      to: { type: "board", board: BOARD, position: [0, 3] },
    });
    await waitFor(() => expect(w.ui.getState().selection).toEqual([id]));
    expect(w.ui.getState().tool.id).toBe("select");
    expect(w.cell("goblin", "image")).toBeUndefined();
  }, 30_000);

  test("a tool switch during an empty-space drop's upload still creates the object, leaving selection and tool alone", async () => {
    const hold = gate();
    const w = await world({ holdUpload: hold.promise });
    act(() => w.ui.select(["goblin"]));
    w.drop([png("map.png")], [0, 3]);
    await until(() => w.uploads.started === 1, "the upload to start");
    act(() => w.ui.setTool("token"));
    hold.open();
    await until(() => w.created().length === 1, "the image object");
    await settle();
    expect(w.ui.getState().selection).toEqual(["goblin"]);
    expect(w.ui.getState().tool.id).toBe("token");
  }, 30_000);

  test("Escape during an empty-space drop's upload still creates the object, leaving selection and tool alone", async () => {
    const hold = gate();
    const w = await world({ holdUpload: hold.promise });
    act(() => w.ui.select(["goblin"]));
    w.drop([png("map.png")], [0, 3]);
    await until(() => w.uploads.started === 1, "the upload to start");
    act(() => {
      fireEvent.keyDown(w.canvas, { key: "Escape", code: "Escape" });
    });
    act(() => w.ui.select(["goblin"]));
    hold.open();
    await until(() => w.created().length === 1, "the image object");
    await settle();
    expect(w.ui.getState().selection).toEqual(["goblin"]);
    expect(w.ui.getState().tool.id).toBe("select");
  }, 30_000);

  test("an unsupported file pushes a notice and writes nothing", async () => {
    const w = await world();
    w.drop([new File(["<svg/>"], "goblin.svg", { type: "image/svg+xml" })], [2, 0]);
    await settle();
    expect(w.notices()).toContain("Drop a PNG, JPEG, WebP or GIF image.");
    expect(w.uploads.started).toBe(0);
    expect(w.transacts()).toEqual([]);
    expect(w.cell("goblin", "image")).toBeUndefined();
  }, 30_000);

  test("a drop on an object whose image is a formula pushes a notice and writes nothing", async () => {
    const w = await world();
    w.drop([png("statue.png")], [-2, 0]);
    await settle();
    expect(w.notices()).toContain(
      "The image of Statue is a formula; the dropped image was not used.",
    );
    expect(w.uploads.started).toBe(0);
    expect(w.transacts()).toEqual([]);
    expect(w.cell("statue", "image")).toMatchObject({ type: "formula" });
  }, 30_000);

  test("several files: the first image is used and the rest are noticed as ignored", async () => {
    const w = await world();
    const notes = new File(["hi"], "notes.txt", { type: "text/plain" });
    w.drop([notes, png("goblin.png"), png("other.png")], [2, 0]);
    await until(() => w.cell("goblin", "image") !== undefined, "the goblin's image");
    expect((w.cell("goblin", "image") as { value: string }).value).toMatch(/goblin.*\.png$/);
    expect(w.uploads.started).toBe(1);
    expect(w.transacts()).toHaveLength(1);
    expect(w.notices()).toContain('Only "goblin.png" was used; 2 other files were ignored.');
  }, 30_000);
});
