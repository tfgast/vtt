/**
 * The walkthrough driver's contract tests (vtt-nb8.17; M6 plan Q2, Q13;
 * review r2 findings 2, 3): each case starts a fresh stocked table with
 * `startWalkthrough` and exercises the `DriverContext` facilities the step
 * beads build on, through the real composed `<App>`.
 */
import { access, readFile } from "node:fs/promises";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { exampleAssetPath } from "@vtt/fixtures";
import type { WireOp } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { assetUrl } from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";
import { until } from "../support/authority";
import type { DriverContext, Point } from "./contract";
import { startWalkthrough } from "./infra";
import { WALKTHROUGH_STEPS } from "./steps";

let ctx: DriverContext | null = null;

afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

async function start(): Promise<DriverContext> {
  ctx = await startWalkthrough({ dice: [] });
  return ctx;
}

const GM_BOARD = "gm_board";
const text = (value: string) => ({ type: "text" as const, value });
const ALL = { type: "viewers" as const, viewers: ["all" as const] };

/** A token named `name` on the GM board, as an op. */
const token = (id: string, name: string, position: Point): WireOp => ({
  type: "create_object",
  id,
  to: { type: "board", board: GM_BOARD, position },
  init: {
    shape: { type: "rect", width: 1, height: 1 },
    cells: { name: text(name), visible_to: ALL },
  },
});

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
}

/** One `transact` through `agent`'s MCP client, at the GM client's revision. */
async function agentTransact(c: DriverContext, name: string, ops: WireOp[], label: string) {
  const agent = await c.startAgent(name);
  const result = (await agent.mcp.callTool({
    name: "transact",
    arguments: { ops, base_revision: c.gm.revision, label },
  })) as ToolResult;
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  return { agent, result };
}

/** Waits until the app's session has caught up with the GM client. */
async function caughtUp(c: DriverContext): Promise<void> {
  await until(() => c.gm.revision > 0, "the GM client's revision");
  const revision = c.gm.revision;
  await act(() => c.session.whenRevision(revision));
}

/** A press and a release on the board canvas at board point `p`. */
function clickCanvas(c: DriverContext, p: Point): void {
  const canvas = c.root.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  const [clientX, clientY] = c.toScreen(p);
  const init = { pointerId: 1, clientX, clientY, button: 0 };
  act(() => {
    fireEvent.pointerDown(canvas, { ...init, buttons: 1 });
    fireEvent.pointerUp(canvas, { ...init, buttons: 0 });
  });
}

describe("WALKTHROUGH_STEPS (DESIGN.md §8.4 as amended by vtt-nb8.2)", () => {
  test("holds the fifteen steps' ids and titles", () => {
    expect(WALKTHROUGH_STEPS).toEqual([
      { id: "s1", title: "Open a new table" },
      { id: "s2", title: "Add the HIT badge, then make four characters" },
      { id: "s3", title: "Import the Crypt map and draw six opaque rooms" },
      { id: "s4", title: "Make a goblin template and place eight" },
      { id: "s5", title: "Ask the agent for difficult terrain and a Fireball card" },
      { id: "s6", title: "Scribble a note in ink and save" },
      { id: "s7", title: "View the Crypt as Aldric and reveal room 1" },
      { id: "s8", title: "Move the party, reveal room 3, watch room 2" },
      { id: "s9", title: "Roll initiative in a dice tray and line up markers" },
      { id: "s10", title: "Aldric attacks with the Attack card" },
      { id: "s11", title: "A goblin attacks back with its own die" },
      { id: "s12", title: "Aldric casts Fireball" },
      { id: "s13", title: "The rogue triggers the stair trap" },
      { id: "s14", title: "Undo the wrong goblin's damage and a mistaken delete" },
      { id: "s15", title: "Save, close and reopen" },
    ]);
  });
});

describe("startWalkthrough (vtt-nb8.17)", () => {
  test("root holds the app's toolbar; session and ui are the app's", async () => {
    const c = await start();
    expect(within(c.root).getByRole("toolbar", { name: "Tools" })).toBeTruthy();
    expect(c.session.getSnapshot().ready).toBe(true);
    expect(c.session.getSnapshot().activeBoard).toBe(GM_BOARD);
    // A new table is stocked: the GM binder is on the GM board.
    expect(c.session.boardView()?.objects.has("gm_binder")).toBe(true);

    act(() => c.ui.select(["gm_binder"]));
    const inspector = within(c.root).getByRole("complementary", { name: "Inspector panel" });
    const header = await waitFor(() => within(inspector).getByRole("region", { name: "Object" }));
    await waitFor(() =>
      expect(within(header).getByRole("heading", { name: "GM binder" })).toBeTruthy(),
    );
    expect(within(header).getByText("gm_binder")).toBeTruthy();
    // The app draws into the recording context.
    await c.frame();
    expect(c.renderer.calls.length).toBeGreaterThan(0);
  }, 60_000);

  test("toBoard(toScreen(p)) round-trips at two zooms set by setCamera", async () => {
    const c = await start();
    const points: Point[] = [
      [0, 0],
      [3.25, -2.5],
      [-7.125, 4.75],
    ];
    for (const camera of [
      { center: [1.5, -2] as Point, zoom: 1 },
      { center: [-4, 3] as Point, zoom: 0.37 },
    ]) {
      await c.setCamera(camera);
      expect(c.ui.getState().camera).toEqual({
        x: camera.center[0],
        y: camera.center[1],
        zoom: camera.zoom,
      });
      // The center is the canvas's center.
      const [cx, cy] = c.toScreen(camera.center);
      expect(cx).toBeCloseTo(400, 6);
      expect(cy).toBeCloseTo(300, 6);
      for (const p of points) {
        const [x, y] = c.toBoard(c.toScreen(p));
        expect(Math.abs(x - p[0])).toBeLessThan(1e-6);
        expect(Math.abs(y - p[1])).toBeLessThan(1e-6);
      }
    }
    // Two zooms put the same board distance at different pixel distances.
    await c.setCamera({ center: [0, 0], zoom: 1 });
    const one = c.toScreen([1, 0])[0] - c.toScreen([0, 0])[0];
    await c.setCamera({ center: [0, 0], zoom: 0.5 });
    const half = c.toScreen([1, 0])[0] - c.toScreen([0, 0])[0];
    expect(half).toBeCloseTo(one / 2, 6);
  }, 60_000);

  test("pickFile feeds the image tool's file input; the image reports the PNG's size", async () => {
    const c = await start();
    const bytes = await readFile(exampleAssetPath("crypt-map.png"));
    c.pickFile(new File([bytes], "crypt-map.png", { type: "image/png" }));
    await c.setCamera({ center: [0, 0], zoom: 0.5 });
    const toolbar = within(c.root).getByRole("toolbar", { name: "Tools" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Image" }));
    clickCanvas(c, [20, 0]);

    const imported = (): ObjectId | null => {
      const [id] = c.ui.getState().selection;
      return id?.startsWith("image") === true && c.session.objectView(id) !== null ? id : null;
    };
    await until(() => imported() !== null, "the imported image");
    const id = imported() as ObjectId;
    const { objects } = await c.gm.request("get_objects", { ids: [id] });
    const view = objects[0];
    // 2400 × 1600 px at 100 px per unit.
    expect(view?.cells.shape?.value).toEqual({
      type: "shape",
      shape: { type: "rect", width: 24, height: 16 },
    });
    expect(view?.cells.name?.value).toEqual(text("crypt-map"));
    const path = view?.cells.image?.value;
    expect(path?.type).toBe("text");
    const served = await fetch(`${c.origin}${assetUrl((path as { value: string }).value)}`);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
  }, 60_000);

  test("upload returns a path served at /assets/", async () => {
    const c = await start();
    const bytes = new Uint8Array(await readFile(exampleAssetPath("goblin.png")));
    const { path } = await c.upload(bytes, "goblin.png");
    expect(path).toMatch(/goblin/);
    const res = await fetch(
      `${c.origin}/assets/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  }, 60_000);

  test("savedFile after Ctrl+S is the saved table, as JSON", async () => {
    const c = await start();
    await agentTransact(c, "Scribe", [token("saved_token", "Saved token", [4, 4])], "Add a token");
    await caughtUp(c);
    expect(await c.savedFile()).not.toContain("Saved token");

    act(() => {
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    });
    const status = within(c.root).getByRole("contentinfo");
    await waitFor(() => expect(within(status).getByText("Saved")).toBeTruthy(), {
      timeout: 20_000,
    });
    const saved = await c.savedFile();
    expect(() => JSON.parse(saved)).not.toThrow();
    expect(saved).toContain("Saved token");
    expect(saved).toContain("GM binder");
  }, 60_000);

  test("byName resolves one live object and throws naming the matches", async () => {
    const c = await start();
    expect(c.byName("GM binder")).toBe("gm_binder");
    expect(c.byName("GM binder", GM_BOARD)).toBe("gm_binder");
    // Templates in the binder count, on the binder's board.
    expect(c.byName("Token")).toBe("tpl_token");
    expect(c.byName("Token", GM_BOARD)).toBe("tpl_token");
    expect(() => c.byName("GM binder", "crypt")).toThrow(
      /no live object named "GM binder" on crypt/,
    );
    expect(() => c.byName("Nobody")).toThrow(/no live object named "Nobody"/);

    await agentTransact(c, "Maker", [token("second_token", "Token", [3, 3])], "Add a Token");
    await caughtUp(c);
    await until(() => c.session.directory().has("second_token"), "the second Token");
    expect(() => c.byName("Token")).toThrow(/2 objects named "Token": .*tpl_token/);
    expect(() => c.byName("Token")).toThrow(/second_token/);
  }, 60_000);

  test("startAgent lists the tools and commits a transact whose group actor is the agent", async () => {
    const c = await start();
    const agent = await c.startAgent("Claude");
    const { tools } = await agent.mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("transact");
    expect(names).toContain("import_asset");

    const result = (await agent.mcp.callTool({
      name: "transact",
      arguments: {
        ops: [token("agent_token", "Agent token", [5, 5])],
        base_revision: c.gm.revision,
        label: "Agent adds a token",
      },
    })) as ToolResult;
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);

    const log = await c.gm.request("log", { limit: 1 });
    const group = log.groups[0];
    expect(group?.label).toBe("Agent adds a token");
    expect(group?.actor).toEqual({ type: "agent", name: "Claude" });
    await agent.close();
  }, 60_000);

  test("restart after a write: every object equal through gm, the app connected on the same board", async () => {
    const c = await start();
    await agentTransact(
      c,
      "Builder",
      [
        { type: "add_board", id: "crypt", name: "Crypt" },
        token("before_restart", "Before", [1, 1]),
      ],
      "Build",
    );
    await caughtUp(c);
    const tabs = within(c.root).getByRole("tablist", { name: "Boards" });
    fireEvent.click(await within(tabs).findByRole("tab", { name: "Crypt" }));
    await until(() => c.session.boardView()?.board === "crypt", "the Crypt board");
    const before = await c.gm.request("document", {});
    const oldSession = c.session;
    const oldGm = c.gm;

    await c.restart();

    expect(c.session).not.toBe(oldSession);
    expect(c.gm).not.toBe(oldGm);
    expect(c.session.getSnapshot().ready).toBe(true);
    expect(c.session.getSnapshot().connection).toBeNull();
    expect(c.session.getSnapshot().activeBoard).toBe("crypt");
    expect(within(c.root).getByRole("toolbar", { name: "Tools" })).toBeTruthy();
    const after = await c.gm.request("document", {});
    expect(after.snapshot.objects).toEqual(before.snapshot.objects);
    expect(after.snapshot.boards).toEqual(before.snapshot.boards);
    expect(after.snapshot.revision).toBe(before.snapshot.revision);
    expect(c.byName("Before")).toBe("before_restart");
    // The new token works for uploads too.
    const bytes = new Uint8Array(await readFile(exampleAssetPath("goblin.png")));
    await expect(c.upload(bytes, "goblin.png")).resolves.toHaveProperty("path");
  }, 90_000);

  test("close disposes the app, agents, server and temp files", async () => {
    const c = await start();
    const agent = await c.startAgent("Leaver");
    const file = c.file;
    const origin = c.origin;
    const session = c.session;
    await access(file);

    await c.close();
    ctx = null;

    await expect(access(file)).rejects.toThrow();
    await expect(fetch(`${origin}/healthz`)).rejects.toThrow();
    expect(session.getSnapshot().ready).toBe(false);
    await expect(agent.mcp.callTool({ name: "log", arguments: { limit: 1 } })).rejects.toThrow();
    expect(document.querySelector("canvas")).toBeNull();
    expect(typeof globalThis.createImageBitmap).toBe("undefined");
    await c.close();
  }, 60_000);
});
