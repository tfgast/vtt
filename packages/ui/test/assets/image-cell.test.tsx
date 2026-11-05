/**
 * Choosing an image for a cell (vtt-nb8.7; DESIGN.md §4.6 Appearance cells,
 * M6-D4; §7 Undo and writes in the UI; PROTOCOL.md §1 `POST /assets`): the
 * inspector's `image` row's Upload… button, its hidden file input, and
 * `uploadIntoCell`. jsdom against a real in-process authority on a temp file
 * table with vtt-3l6.16's asset handler; uploads go to the authority's HTTP
 * origin through `bindCellUpload` (jsdom's origin is not the authority's).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAssetHttpHandler, type HttpHandler } from "@vtt/authority";
import type { ProtocolClient, WireOp } from "@vtt/protocol";
import {
  bindCellUpload,
  createUiStore,
  IMAGE_ACCEPT,
  Inspector,
  sessionNotices,
  type TableSession,
  type UiStore,
  uploadIntoCell,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  startAuthority,
  type TestAuthority,
  until,
  whenReady,
} from "../support/authority";

afterEach(async () => {
  cleanup();
  document.getElementById("vtt-session")?.remove();
  vi.restoreAllMocks();
  await cleanupAuthorities();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const text = (value: string) => ({ type: "text" as const, value });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

/** Aldric (a character) and a goblin token with an empty `image` cell and an `ac`. */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "goblin",
    to: at(2, 0),
    init: {
      shape: { type: "circle", radius: 0.5 },
      cells: { name: text("Goblin"), image: text(""), ac: { type: "number", value: 13 } },
    },
  },
];

/** A gate a fetch waits on, so a test can act while an upload is in flight. */
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface Setup {
  authority: TestAuthority;
  session: TableSession;
  ui: UiStore;
  other: ProtocolClient;
  base: string;
  /** Fetches made by uploads. */
  fetches: string[];
  transacts(): { ops: WireOp[]; base_revision?: number; label?: string }[];
  imageOf(id: string): unknown;
}

async function setup(options: { holdUpload?: Promise<void>; bind?: boolean } = {}): Promise<Setup> {
  // The asset handler needs the host, which the helper creates: route through a late binding.
  let assets: HttpHandler | null = null;
  const authority = await startAuthority({
    file: true,
    http: [(req, res, ctx) => (assets === null ? false : assets(req, res, ctx))],
  });
  assets = createAssetHttpHandler({ host: authority.host });
  const base = `http://127.0.0.1:${authority.server.port}`;
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const other = await authority.client("Scribe", { kind: "agent" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView("goblin") !== null, "the goblin view");
  const fetches: string[] = [];
  const spy: typeof fetch = async (input, init) => {
    fetches.push(String(input));
    const res = await fetch(input, init);
    if (options.holdUpload !== undefined) await options.holdUpload;
    return res;
  };
  if (options.bind !== false) bindCellUpload(session, { token: authority.token, base, fetch: spy });
  const ui = createUiStore({ session });
  render(<Inspector session={session} ui={ui} />);
  const request = vi.spyOn(session.client, "request");
  return {
    authority,
    session,
    ui,
    other,
    base,
    fetches,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number; label?: string }),
    imageOf: (id) => authority.host.table.store.getObject(id)?.cells.image?.content,
  };
}

function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("[data-cell]")].find(
    (el) => el.getAttribute("data-cell") === name,
  );
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

const uploadButton = (name: string) => within(row(name)).queryByRole("button", { name: "Upload…" });

function fileInput(name: string): HTMLInputElement {
  const input = row(name).querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error(`no file input in row ${name}`);
  return input;
}

const png = (name = "Goblin Face.png") => new File([PNG], name, { type: "image/png" });

describe("the image row", () => {
  test("choosing a PNG sets the selected token's image to the returned path in one group", async () => {
    const user = userEvent.setup();
    const { authority, session, ui, transacts, imageOf } = await setup();
    act(() => ui.select(["goblin"]));
    const button = uploadButton("image");
    expect(button).not.toBeNull();
    const input = fileInput("image");
    expect(input.hidden).toBe(true);
    expect(input.accept).toBe(IMAGE_ACCEPT);
    const reader = await authority.client("reader");
    const before = (await reader.request("log", { limit: 50 })).groups.length;

    await user.click(button as HTMLElement);
    await user.upload(input, png());

    await until(() => {
      const v = imageOf("goblin") as { value?: string } | undefined;
      return typeof v?.value === "string" && v.value !== "";
    }, "the image cell");
    const path = (imageOf("goblin") as { value: string }).value;
    expect(path).toMatch(/^table\.json\.assets\/goblin-face-[0-9a-f]{8}\.png$/);
    expect(authority.host.assets).toContain(path);
    expect(transacts()).toEqual([
      {
        ops: [
          {
            type: "set_value",
            object: "goblin",
            cell: "image",
            value: { type: "text", value: path },
          },
        ],
        base_revision: 1,
        label: "Set image of Goblin",
        txn_id: expect.any(String),
      },
    ]);
    const log = await reader.request("log", { limit: 50 });
    expect(log.groups.length).toBe(before + 1);
    const newest = log.groups.reduce((a, b) => (b.index > a.index ? b : a));
    expect(newest.label).toBe("Set image of Goblin");
    expect(newest.revision).toBe(2);
    expect(input.value).toBe("");
    await until(
      () =>
        (session.objectView("goblin")?.cells.image?.value as { value?: string } | undefined)
          ?.value === path,
      "the mirror",
    );
    expect(sessionNotices(session).list()).toEqual([]);
  });

  test("the base revision is the one at the click: a write meanwhile makes it stale", async () => {
    const user = userEvent.setup();
    const hold = gate();
    const { session, ui, other, fetches, transacts, imageOf } = await setup({
      holdUpload: hold.promise,
    });
    act(() => ui.select(["goblin"]));
    await user.click(uploadButton("image") as HTMLElement);
    await user.upload(fileInput("image"), png());
    await until(() => fetches.length === 1, "the upload to start");
    await other.transact(
      [{ type: "set_value", object: "goblin", cell: "image", value: text("theirs.png") }],
      { label: "Agent image" },
    );
    await session.whenRevision(2);
    // The selection changes and the row goes away before the upload completes.
    act(() => ui.select([]));
    hold.open();
    await until(() => transacts().length === 1, "the write");
    expect(transacts()[0]?.base_revision).toBe(1);
    await until(
      () =>
        sessionNotices(session)
          .list()
          .some((n) => n.kind === "stale"),
      "the stale notice",
    );
    expect(imageOf("goblin")).toEqual(text("theirs.png"));
  });

  test("a 415 pushes an error notice and sends no transact", async () => {
    const user = userEvent.setup();
    const { session, ui, fetches, transacts, imageOf } = await setup();
    act(() => ui.select(["goblin"]));
    await user.click(uploadButton("image") as HTMLElement);
    // Claims to be a PNG; the authority recognises types by their bytes.
    await user.upload(
      fileInput("image"),
      new File(["not an image"], "x.png", { type: "image/png" }),
    );
    await until(() => sessionNotices(session).list().length > 0, "the notice");
    const [notice] = sessionNotices(session).list();
    expect(notice?.level).toBe("error");
    expect(notice?.text).toContain("Goblin");
    expect(notice?.text).toContain("PNG, JPEG, WebP and GIF");
    expect(fetches).toHaveLength(1);
    expect(transacts()).toEqual([]);
    expect(imageOf("goblin")).toEqual(text(""));
  });

  test("the button is absent for other rows and in view-as", async () => {
    const { session, ui } = await setup();
    act(() => ui.select(["goblin"]));
    expect(uploadButton("image")).not.toBeNull();
    for (const name of ["name", "ac", "position"]) {
      expect(uploadButton(name)).toBeNull();
      expect(row(name).querySelector('input[type="file"]')).toBeNull();
    }
    await act(() =>
      session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
    );
    await until(() => session.getSnapshot().viewer.type === "character", "view-as");
    expect(row("image")).toBeDefined();
    expect(uploadButton("image")).toBeNull();
    expect(row("image").querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload…" })).toBeNull();
  });
});

describe("uploadIntoCell", () => {
  test("unbound, it uses the page's session bootstrap token", async () => {
    const { authority, session, base, imageOf } = await setup({ bind: false });
    const script = document.createElement("script");
    script.id = "vtt-session";
    script.type = "application/json";
    script.textContent = JSON.stringify({ url: authority.url, token: authority.token });
    document.body.append(script);
    // jsdom's origin is not the authority's: point the default base at it.
    bindCellUpload(session, { base });
    const outcome = await uploadIntoCell({
      file: png("boss.png"),
      object: "goblin",
      cell: "image",
      baseRevision: 1,
      session,
    });
    expect(outcome?.status).toBe("committed");
    expect((imageOf("goblin") as { value: string }).value).toMatch(/\/boss-[0-9a-f]{8}\.png$/);
  });

  test("without a token it pushes a notice and writes nothing", async () => {
    const { session, base, transacts } = await setup({ bind: false });
    bindCellUpload(session, { base });
    const outcome = await uploadIntoCell({
      file: png(),
      object: "goblin",
      cell: "image",
      baseRevision: 1,
      session,
    });
    expect(outcome).toBeNull();
    expect(transacts()).toEqual([]);
    expect(sessionNotices(session).list()[0]?.text).toContain("no session token");
  });
});
