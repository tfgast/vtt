// @vitest-environment node
/**
 * View-as and viewer isolation (DESIGN.md §4.4, §4.6; M4 plan Q2; review r1
 * finding 3) against a real in-process authority. Node environment for
 * Node's WebSocket (see lifecycle.test.ts).
 */
import {
  DocumentStore,
  newTableSnapshot,
  type RunningServer,
  startServer,
  TableHost,
} from "@vtt/authority";
import { type ObjectView, ProtocolClient, type Viewer, type WireOp } from "@vtt/protocol";
import { createTableSession, type TableSession } from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const servers: RunningServer[] = [];
const sessions: TableSession[] = [];
const clients: ProtocolClient[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function until(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const gmOnly = { type: "viewers" as const, viewers: ["gm" as const] };

/**
 * On `gm_board`: the character Aldric; a goblin whose `hp` is GM-only; an
 * object whose `name` is GM-only; an opaque GM-only room (a cover for
 * Aldric). On board `vault`: `far`, with a GM-only `secret`.
 */
const SETUP: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: { type: "board", board: "gm_board", position: [0, 0] },
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "goblin",
    to: { type: "board", board: "gm_board", position: [2, 0] },
    init: { cells: { name: text("Goblin"), hp: num(7) }, cell_visibility: { hp: gmOnly } },
  },
  {
    type: "create_object",
    id: "masked",
    to: { type: "board", board: "gm_board", position: [4, 0] },
    init: {
      cells: { name: text("The Masked One"), hp: num(3) },
      cell_visibility: { name: gmOnly },
    },
  },
  {
    type: "create_object",
    id: "room",
    to: { type: "board", board: "gm_board", position: [20, 20] },
    init: {
      is_zone: true,
      shape: { type: "rect", width: 4, height: 4 },
      cells: { visible_to: gmOnly, opaque: { type: "boolean", value: true } },
    },
  },
  { type: "add_board", id: "vault", name: "Vault" },
  {
    type: "create_object",
    id: "far",
    to: { type: "board", board: "vault", position: [0, 0] },
    init: {
      cells: { name: text("Far Chest"), secret: num(42) },
      cell_visibility: { secret: gmOnly },
    },
  },
];

let server: RunningServer;
let session: TableSession;

beforeEach(async () => {
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()));
  server = await startServer({ host, port: 0 });
  servers.push(server);
  const gm = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: "setup", kind: "test" },
    onWarning: () => undefined,
  });
  clients.push(gm);
  await gm.connect();
  await gm.transact(SETUP);
  session = createTableSession({ url: server.url, token: server.token });
  sessions.push(session);
  await until(() => session.getSnapshot().ready, "the session to be ready");
});

const hasCell = (view: ObjectView | null | undefined, cell: string) =>
  view !== null && view !== undefined && cell in view.cells;

describe("view as (DESIGN.md §4.6)", () => {
  test("switching to Aldric replaces the board view while the directory stays GM", async () => {
    expect(hasCell(session.objectView("goblin"), "hp")).toBe(true);
    expect(session.boardView()?.objects.has("room")).toBe(true);
    expect(session.boardView()?.covers.size).toBe(0);

    await session.setView("gm_board", ALDRIC);
    const snap = session.getSnapshot();
    expect(snap.viewer).toEqual(ALDRIC);
    expect(snap.activeBoard).toBe("gm_board");
    expect(snap.ready).toBe(true);
    expect(session.viewerKey()).toBe("character:aldric");
    const board = session.boardView();
    expect(board?.objects.has("goblin")).toBe(true);
    expect(hasCell(board?.objects.get("goblin"), "hp")).toBe(false);
    expect(board?.objects.has("room")).toBe(false);
    expect(board?.covers.size).toBe(1);
    expect(hasCell(session.objectView("goblin"), "hp")).toBe(false);

    // The directory is still the GM's: it lists the room Aldric cannot see.
    expect(session.directory().has("room")).toBe(true);
    expect(session.directory().get("masked")?.cells.name?.value).toEqual(text("The Masked One"));
    const params = session.client.liveSubscriptions().map((s) => s.params);
    expect(params).toContainEqual({
      scope: { type: "all" },
      viewer: GM,
      cells: "structural",
    });
    expect(params).toContainEqual({
      scope: { type: "board", board: "gm_board" },
      viewer: ALDRIC,
      cells: "all",
    });
    // The GM board view was unsubscribed after the switch.
    expect(params).toHaveLength(2);

    await session.setView("gm_board", GM);
    expect(hasCell(session.objectView("goblin"), "hp")).toBe(true);
    expect(session.viewerKey()).toBe("gm");
  });

  test("the board view is never empty during a switch", async () => {
    const sizes: number[] = [];
    session.subscribe(() => sizes.push(session.boardView()?.objects.size ?? -1));
    await session.setView("gm_board", ALDRIC);
    await session.setView("gm_board", GM);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((n) => n > 0)).toBe(true);
  });
});

describe("viewer isolation (review r1 finding 3)", () => {
  test("a name with per-cell visibility gm: the object is visible to Aldric, refLabel gives its id", async () => {
    expect(session.refLabel(GM, "masked")).toBe("The Masked One");
    // Not the current viewer: no view of Aldric's is held, so only the id.
    expect(session.refLabel(ALDRIC, "goblin")).toBe("goblin");

    await session.setView("gm_board", ALDRIC);
    expect(session.objectView("masked")).not.toBeNull();
    expect(hasCell(session.objectView("masked"), "name")).toBe(false);
    expect(session.refLabel(ALDRIC, "masked")).toBe("masked");
    expect(session.refLabel(ALDRIC, "goblin")).toBe("Goblin");
    expect(session.refLabel(ALDRIC, "room")).toBe("room");
    // The directory never labels for a character.
    expect(session.refLabel(ALDRIC, "far")).toBe("far");
    // GM labels still come from the directory while viewing as Aldric.
    expect(session.refLabel(GM, "masked")).toBe("The Masked One");
    expect(session.refLabel(GM, "far")).toBe("Far Chest");
    expect(session.refLabel(GM, "nobody")).toBe("nobody");
  });

  test("a selected object outside the board view is watched with the current viewer and re-subscribed on a switch", async () => {
    await session.watchObjects(["goblin", "far"]);
    const selection = () =>
      session.client.liveSubscriptions().filter((s) => s.params.scope.type === "objects");
    expect(selection()).toHaveLength(1);
    // Only the id outside the board view is watched.
    expect(selection()[0]?.params).toEqual({
      scope: { type: "objects", ids: ["far"] },
      viewer: GM,
    });
    expect(hasCell(session.objectView("far"), "secret")).toBe(true);
    expect(session.refLabel(GM, "far")).toBe("Far Chest");

    const revision = session.getSnapshot().revision;
    const leaks: string[] = [];
    session.subscribe(() => {
      const snap = session.getSnapshot();
      if (snap.viewer.type !== "character") return;
      for (const id of ["far", "goblin"]) {
        const cell = id === "far" ? "secret" : "hp";
        if (hasCell(session.objectView(id), cell)) leaks.push(id);
      }
    });
    await session.setView("gm_board", ALDRIC);
    // No commit happened: the GM-only cell disappears through the re-subscription alone.
    expect(session.getSnapshot().revision).toBe(revision);
    expect(selection()).toHaveLength(1);
    expect(selection()[0]?.params).toEqual({
      scope: { type: "objects", ids: ["far"] },
      viewer: ALDRIC,
    });
    const far = session.objectView("far");
    expect(far?.id).toBe("far");
    expect(hasCell(far, "secret")).toBe(false);
    expect(session.refLabel(ALDRIC, "far")).toBe("Far Chest");
    expect(leaks).toEqual([]);

    // Deselecting drops the selection view.
    await session.watchObjects([]);
    expect(selection()).toHaveLength(0);
    expect(session.objectView("far")).toBeNull();
  });

  test("objectView never falls back to the GM directory or another viewer's mirror", async () => {
    await session.setView("gm_board", ALDRIC);
    // `far` is in the GM directory but in none of Aldric's views.
    expect(session.directory().has("far")).toBe(true);
    expect(session.objectView("far")).toBeNull();
    // The room is in the GM directory, but Aldric cannot see it.
    expect(session.objectView("room")).toBeNull();
  });

  test("switching boards keeps the viewer and recomputes the selection", async () => {
    await session.watchObjects(["far"]);
    await session.setView("vault", ALDRIC);
    const snap = session.getSnapshot();
    expect(snap.activeBoard).toBe("vault");
    expect(snap.viewer).toEqual(ALDRIC);
    // `far` is now in the board view: no selection view is needed.
    expect(
      session.client.liveSubscriptions().filter((s) => s.params.scope.type === "objects"),
    ).toHaveLength(0);
    expect(hasCell(session.objectView("far"), "secret")).toBe(false);
    expect(session.objectView("far")?.id).toBe("far");
  });
});
