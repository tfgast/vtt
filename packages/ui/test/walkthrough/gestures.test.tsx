/**
 * The walkthrough's gesture helpers (vtt-nb8.18; M6 plan Q2, Q13; DESIGN.md
 * §4.6, §4.7): each case starts a fresh stocked table with
 * `startWalkthrough` and drives the real composed `<App>` through
 * `createGestures`, checking outcomes through the GM assertion client.
 */
import { fireEvent, within } from "@testing-library/react";
import { LIMITS, type ObjectView, type WireOp } from "@vtt/protocol";
import type { ObjectId, Point, Rect } from "@vtt/schema";
import {
  apply,
  buildFaceScene,
  type ContentsPrimitive,
  compose,
  entryTransform,
  type FaceDrawing,
  type FaceScene,
  faceHitAt,
  invert,
  screenHeight,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { until } from "../support/authority";
import type { DiceEntry, DriverContext, Gestures } from "./contract";
import { createGestures, parseKeyCombo } from "./gestures";
import { startWalkthrough } from "./infra";

let ctx: DriverContext | null = null;

afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

const roll = (value: number): DiceEntry => ({
  type: "roll",
  expr: "1d20",
  dice: [value],
  dropped: [],
  total: value,
});

async function start(dice: DiceEntry[] = []): Promise<{ c: DriverContext; g: Gestures }> {
  const c = await startWalkthrough({ dice });
  ctx = c;
  return { c, g: createGestures(c) };
}

const BINDER = "gm_binder";

async function view(c: DriverContext, id: ObjectId): Promise<ObjectView> {
  const { objects } = await c.gm.request("get_objects", { ids: [id] });
  const v = objects[0];
  if (v === undefined) throw new Error(`no object ${id}`);
  return v;
}

const cellValue = async (c: DriverContext, id: ObjectId, cell: string) =>
  (await view(c, id)).cells[cell]?.value;

/** The newest log group's index (GM). */
async function newest(c: DriverContext): Promise<number> {
  const log = await c.gm.request("log", { limit: 1 });
  return log.groups[0]?.index ?? -1;
}

/** The ids of the directory now. */
const ids = (c: DriverContext): Set<ObjectId> => new Set(c.session.directory().keys());

/** Drags `entry` out of the GM binder to `to` and returns the one new object it spawned. */
async function spawnFromBinder(
  c: DriverContext,
  g: Gestures,
  entry: ObjectId,
  to: Point,
): Promise<ObjectId> {
  const before = ids(c);
  await g.dragEntry(BINDER, entry, to);
  const made = [...ids(c)].filter((id) => !before.has(id));
  const board = made.filter((id) => {
    const v = c.session.directory().get(id)?.cells.board?.value as { type?: string } | undefined;
    return v?.type === "ref";
  });
  expect(board).toHaveLength(1);
  return board[0] as ObjectId;
}

const refsOf = (v: unknown): ObjectId[] => {
  const list = v as { type?: string; items?: { type: string; object?: string }[] } | undefined;
  return list?.type === "list"
    ? (list.items ?? []).flatMap((i) => (i.type === "ref" && i.object ? [i.object] : []))
    : [];
};

/** The face scene the app draws now. */
function faces(c: DriverContext): FaceScene {
  const v = c.session.boardView();
  if (v === null) throw new Error("no board view");
  return buildFaceScene(
    {
      views: v.objects.values(),
      covers: [...v.covers.values()],
      board: v.board,
      viewer: c.session.getSnapshot().viewer,
    },
    { faceState: c.faceState },
  );
}

/** Follows `path` (board object, then nested entries) to the last one's drawing and frame → board. */
function drawn(
  scene: FaceScene,
  path: readonly ObjectId[],
): {
  drawing: FaceDrawing;
  toBoard: ReturnType<typeof compose>;
  lists: { list: ContentsPrimitive; toBoard: ReturnType<typeof compose> }[];
} {
  const [first, ...rest] = path;
  let drawing = scene.faces.get(first as ObjectId) as FaceDrawing;
  let toBoard = scene.transforms.get(first as ObjectId) as ReturnType<typeof compose>;
  const lists: { list: ContentsPrimitive; toBoard: ReturnType<typeof compose> }[] = [];
  for (const id of rest) {
    const list = drawing.primitives.find(
      (p): p is ContentsPrimitive =>
        p.kind === "contents" && p.entries.some((e) => e.id === id && e.drawing !== null),
    );
    if (list === undefined) throw new Error(`${id} is not drawn`);
    lists.push({ list, toBoard });
    const entry = list.entries.find((e) => e.id === id);
    if (entry?.drawing == null) throw new Error(`${id} has no drawing`);
    toBoard = compose(toBoard, entryTransform(list, entry));
    drawing = entry.drawing;
  }
  return { drawing, toBoard, lists };
}

const inRect = (p: Point, r: Rect) =>
  p[0] >= r[0] - 1e-9 &&
  p[0] <= r[0] + r[2] + 1e-9 &&
  p[1] >= r[1] - 1e-9 &&
  p[1] <= r[1] + r[3] + 1e-9;

/**
 * Asserts the editor of `cell` on the last object of `path` is on screen,
 * at least its min_size, unclipped by every list around it, and hit there.
 */
function expectEditorInView(c: DriverContext, path: readonly ObjectId[], cell: string): void {
  const scene = faces(c);
  const { drawing, toBoard, lists } = drawn(scene, path);
  const editor = drawing.primitives.find((p) => p.kind === "editor" && p.cell === cell);
  if (editor === undefined) throw new Error(`no editor ${cell}`);
  const cam = c.ui.getState().camera;
  expect(screenHeight(editor.rect, toBoard, cam)).toBeGreaterThanOrEqual(editor.minSize);
  const [x, y, w, h] = editor.rect;
  for (const corner of [
    [x, y],
    [x + w, y + h],
  ] as Point[]) {
    const board = apply(toBoard, corner);
    const [sx, sy] = c.toScreen(board);
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sx).toBeLessThanOrEqual(800);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sy).toBeLessThanOrEqual(600);
    for (const { list, toBoard: frame } of lists) {
      const local = apply(invert(frame), board);
      expect(inRect(local, list.rect)).toBe(true);
      expect(screenHeight(list.rect, frame, cam)).toBeGreaterThanOrEqual(list.minSize);
    }
  }
  const mid = apply(toBoard, [x + w / 2, y + h / 2]);
  expect(faceHitAt(scene, mid, cam)).toMatchObject({
    object: path.at(-1),
    target: { type: "editor", cell },
  });
}

// ---------------------------------------------------------------------------

describe("parseKeyCombo", () => {
  test("reads modifiers, letters and named keys", () => {
    expect(parseKeyCombo("Ctrl+Z")).toMatchObject({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(parseKeyCombo("Delete")).toMatchObject({ key: "Delete", code: "Delete" });
    expect(parseKeyCombo("Shift+r")).toMatchObject({ key: "R", code: "KeyR", shiftKey: true });
    expect(parseKeyCombo("Escape")).toMatchObject({ key: "Escape", ctrlKey: false });
  });
});

describe("createGestures (vtt-nb8.18)", () => {
  test("dragEntry brings tpl_d20 (the binder's last row) into view and spawns a die at the point; doubleClick rolls it; pressButton rolls a second die", async () => {
    const { c, g } = await start([roll(7), roll(11)]);
    // The last row starts below the fold of the binder's list.
    expect(c.faceState.scrollOffset(BINDER, 1)).toBe(0);

    const die = await spawnFromBinder(c, g, "tpl_d20", [8, 2]);
    expect(c.faceState.scrollOffset(BINDER, 1)).toBeGreaterThan(0);
    const v = await view(c, die);
    expect(v.cells.template?.value).toEqual({ type: "ref", object: "tpl_d20" });
    expect(v.cells.position?.value).toEqual({
      type: "list",
      items: [
        { type: "number", value: 8 },
        { type: "number", value: 2 },
      ],
    });

    await g.doubleClick(die);
    expect(await cellValue(c, die, "value")).toMatchObject({ type: "roll", total: 7 });

    const second = await spawnFromBinder(c, g, "tpl_d20", [10.5, 2]);
    expect(second).not.toBe(die);
    expect(g.elementShown(second, { action: "Roll" })).toBe(true);
    expect(g.elementEnabled(second, "Roll")).toBe(true);
    await g.pressButton(second, "Roll");
    expect(await cellValue(c, second, "value")).toMatchObject({ type: "roll", total: 11 });
    expect(await cellValue(c, die, "value")).toMatchObject({ type: "roll", total: 7 });
  }, 60_000);

  test("bringIntoView reaches an editor inside an expanded entry from a zoomed-out camera: a sheet in the token's list, and a working copy in the binder in the token's list", async () => {
    const { c, g } = await start();
    const token = await spawnFromBinder(c, g, "tpl_character", [10, 0]);
    const [sheet, binder] = refsOf(await cellValue(c, token, "contents"));
    if (sheet === undefined || binder === undefined) throw new Error("no sheet or binder");

    await g.expandEntry(token, sheet);
    await c.setCamera({ center: [-40, 30], zoom: 1 / 16 });
    await g.bringIntoView({ object: sheet, element: { cell: "ac" } });
    expectEditorInView(c, [token, sheet], "ac");
    // Then the sheet's last editor, further down the token's list.
    await c.setCamera({ center: [40, -30], zoom: 1 / 16 });
    await g.bringIntoView({ object: sheet, element: { cell: "notes" } });
    expectEditorInView(c, [token, sheet], "notes");

    // Two lists deep: the binder in the token's list, its Attack working copy in the binder's.
    await g.expandEntry(token, binder);
    const [attack] = refsOf(await cellValue(c, binder, "contents"));
    if (attack === undefined) throw new Error("no attack template");
    await g.expandEntry(binder, attack);
    const [copy] = c.ui.getState().selection;
    if (copy === undefined || copy === attack) throw new Error("no working copy selected");
    await c.setCamera({ center: [-60, -60], zoom: 1 / 32 });
    await g.bringIntoView({ object: copy, element: { cell: "target" } });
    expectEditorInView(c, [token, binder, copy], "target");

    // A collapsed entry's elements are not drawn: bringIntoView says so.
    await expect(g.bringIntoView({ object: attack, element: { action: "Roll" } })).rejects.toThrow(
      /Roll is not drawn/,
    );
  }, 60_000);

  test("editInPlace, inspectorSet, inspectorAddCell, inspectorCellVisibility and inspectorFlags each commit their group", async () => {
    const { c, g } = await start();
    const token = await spawnFromBinder(c, g, "tpl_token", [8, 0]);
    const note = await spawnFromBinder(c, g, "tpl_note", [8, 4]);

    const groups = async (run: () => Promise<void>): Promise<number> => {
      const before = await newest(c);
      await run();
      return (await newest(c)) - before;
    };

    // A value element (double-click) and an editor element (click).
    expect(await groups(() => g.editInPlace(token, "name", "Goblin"))).toBe(1);
    expect(await cellValue(c, token, "name")).toEqual({ type: "text", value: "Goblin" });
    expect(await groups(() => g.editInPlace(note, "text", "DC 12"))).toBe(1);
    expect(await cellValue(c, note, "text")).toEqual({ type: "text", value: "DC 12" });

    expect(await groups(() => g.inspectorSet(token, "ac", "13"))).toBe(1);
    expect(await cellValue(c, token, "ac")).toEqual({ type: "number", value: 13 });

    // Add cell is its own write ("Add cell"); the formula is typed into the new row.
    expect(await groups(() => g.inspectorAddCell(token, "bonus", "=ac + 1"))).toBe(2);
    const bonus = (await view(c, token)).cells.bonus;
    expect(bonus?.kind).toBe("formula");
    expect(bonus?.value).toEqual({ type: "number", value: 14 });

    expect(await groups(() => g.inspectorCellVisibility(token, "ac", "gm"))).toBe(1);
    expect((await view(c, token)).cells.ac?.visibility).toEqual({
      type: "viewers",
      viewers: ["gm"],
    });

    expect(await groups(() => g.inspectorFlags(token, { character: true }))).toBe(1);
    expect((await view(c, token)).is_character).toBe(true);
    expect(await groups(() => g.inspectorFlags(token, { character: true }))).toBe(0);
  }, 60_000);

  test("addBoard, showBoard, then marquee and moveSelectionToBoard move two objects, positions kept", async () => {
    const { c, g } = await start();
    const a = await spawnFromBinder(c, g, "tpl_token", [8, 0]);
    const b = await spawnFromBinder(c, g, "tpl_token", [10, 0]);

    await g.addBoard("Crypt");
    const crypt = c.session.getSnapshot().boards.find((x) => x.name === "Crypt")?.id;
    expect(crypt).toBeDefined();
    expect(c.session.getSnapshot().activeBoard).toBe(crypt);
    await g.showBoard("GM");
    expect(c.session.getSnapshot().activeBoard).toBe("gm_board");

    await g.marquee([6.5, -1.5], [11.5, 2.5]);
    expect([...c.ui.getState().selection].sort()).toEqual([a, b].sort());
    await g.moveSelectionToBoard("Crypt");
    expect(c.session.getSnapshot().activeBoard).toBe(crypt);
    for (const [id, x] of [
      [a, 8],
      [b, 10],
    ] as const) {
      const v = await view(c, id);
      expect(v.cells.board?.value).toEqual({ type: "ref", object: crypt });
      expect(v.cells.position?.value).toEqual({
        type: "list",
        items: [
          { type: "number", value: x },
          { type: "number", value: 0 },
        ],
      });
    }
    expect((await view(c, BINDER)).cells.board?.value).toEqual({ type: "ref", object: "gm_board" });
  }, 60_000);

  test("drawZone with fog makes an opaque GM-only zone; viewing as a spawned character draws one cover", async () => {
    const { c, g } = await start();
    await spawnFromBinder(c, g, "tpl_character", [10, 0]);
    const zone = await g.drawZone([14, -3], [20, 3], { fog: true });
    const v = await view(c, zone);
    expect(v.cells.opaque?.value).toEqual({ type: "boolean", value: true });
    expect(v.cells.visible_to?.value).toEqual({ type: "viewers", viewers: ["gm"] });
    expect(v.cells.shape?.value).toEqual({
      type: "shape",
      shape: { type: "rect", width: 6, height: 6 },
    });

    await g.viewAs("Character");
    expect(c.session.viewerKey()).toMatch(/^character:/);
    await c.setCamera({ center: [12, 0], zoom: 0.5 });
    expect(g.covers()).toBe(1);
    await g.viewAs("GM");
    await c.frame();
    expect(g.covers()).toBe(0);
  }, 60_000);

  test("pressButton with expectDisabled sends no request; dropOnEditor sets a working Attack copy's target", async () => {
    const { c, g } = await start();
    await g.expandEntry(BINDER, "tpl_attack");
    const [copy] = c.ui.getState().selection;
    if (copy === undefined || copy === "tpl_attack") throw new Error("no working copy");
    const token = await spawnFromBinder(c, g, "tpl_token", [8, 0]);

    expect(g.elementShown(copy, { action: "Roll" })).toBe(true);
    expect(g.elementEnabled(copy, "Roll")).toBe(false);
    const request = vi.spyOn(c.session.client, "request");
    const revision = c.gm.revision;
    await g.pressButton(copy, "Roll", { expectDisabled: true });
    expect(request.mock.calls.filter(([m]) => m === "invoke")).toEqual([]);
    expect(c.gm.revision).toBe(revision);
    request.mockRestore();

    await g.dropOnEditor(token, copy, "target");
    expect(await cellValue(c, copy, "target")).toEqual({ type: "ref", object: token });
    expect(await cellValue(c, token, "position")).toEqual({
      type: "list",
      items: [
        { type: "number", value: 8 },
        { type: "number", value: 0 },
      ],
    });
    await until(() => g.elementEnabled(copy, "Roll"), "Roll enabled");
    // Disabled-press checks refuse an enabled button.
    await expect(g.pressButton(copy, "Roll", { expectDisabled: true })).rejects.toThrow(/enabled/);
  }, 60_000);

  test("logGroups lists the groups above; logLoadOlder pages older groups past the live window", async () => {
    const { c, g } = await start();
    const token = await spawnFromBinder(c, g, "tpl_token", [8, 0]);
    await g.editInPlace(token, "name", "Scout");

    expect(() => g.logGroups()).toThrow(/Log tab is not open/);
    await g.logLoadOlder();
    const log = await c.gm.request("log", { limit: 2, effects: true });
    const shown = g.logGroups();
    expect(shown.slice(0, 2).map((x) => x.index)).toEqual(log.groups.map((x) => x.index));
    expect(shown.slice(0, 2).map((x) => x.label)).toEqual(log.groups.map((x) => x.label));
    expect(shown.slice(0, 2).every((x) => x.actor === "GM" && !x.undone)).toBe(true);
    expect(shown[0]?.sentences.join(" ")).toContain("Scout");
    const scoutGroup = shown[0]?.index as number;
    // Every group is in the live window: there was nothing older to load.
    expect(within(c.root).queryByRole("button", { name: "Load older" })).toBeNull();
    await expect(g.logLoadOlder()).rejects.toThrow(/nothing older/);

    // With the Log tab closed, push the GM's groups out of the live window.
    fireEvent.click(within(c.root).getByRole("tab", { name: "Inspector" }));
    expect(() => g.logGroups()).toThrow(/Log tab is not open/);
    const agent = await c.startAgent("Filler");
    const count = LIMITS.max_log_window + 10;
    for (let i = 0; i < count; i++) {
      const op: WireOp = {
        type: "set_value",
        object: token,
        cell: "counter",
        value: { type: "number", value: i },
      };
      const result = (await agent.mcp.callTool({
        name: "transact",
        arguments: { ops: [op], base_revision: c.gm.revision, label: `Fill ${i}` },
      })) as { isError?: boolean };
      expect(result.isError ?? false).toBe(false);
    }
    const top = await newest(c);
    // Opened again: the live window, then one older page with the GM's groups.
    await g.logLoadOlder();
    const after = g.logGroups();
    expect(after[0]).toMatchObject({ index: top, actor: "Filler", label: `Fill ${count - 1}` });
    expect(after.length).toBeGreaterThan(LIMITS.max_log_window);
    expect(after.find((x) => x.index === scoutGroup)).toMatchObject({ actor: "GM", undone: false });
  }, 90_000);

  test("dragObject moves exactly (also far, panning mid-drag) and spawns from a board template; gear selects a template; click selects; editInPlace renames a faceless zone", async () => {
    const { c, g } = await start();
    const pos = async (id: ObjectId) => {
      const v = (await cellValue(c, id, "position")) as { items: { value: number }[] };
      return v.items.map((i) => i.value);
    };
    const token = await spawnFromBinder(c, g, "tpl_token", [8, 0]);
    await g.dragObject(token, [12.5, -3]);
    expect(await pos(token)).toEqual([12.5, -3]);
    // Too far for one camera at the token's size: the camera pans between press and drop.
    await g.dragObject(token, [80, 40]);
    expect(await pos(token)).toEqual([80, 40]);

    await g.click(BINDER);
    expect(c.ui.getState().selection).toEqual([BINDER]);
    await g.gear("tpl_character");
    expect(c.ui.getState().selection).toEqual(["tpl_character"]);
    expect(within(c.root).getByRole("status", { name: "Editing template" })).toBeTruthy();

    // A template on the board: a plain drag spawns a copy where it is dropped.
    const tpl = await spawnFromBinder(c, g, "tpl_token", [8, 4]);
    await g.inspectorFlags(tpl, { template: true });
    const before = ids(c);
    await g.dragObject(tpl, [14, 4]);
    const copies = [...ids(c)].filter((id) => !before.has(id));
    expect(copies).toHaveLength(1);
    expect(c.ui.getState().selection).toEqual(copies);
    expect(await pos(copies[0] as ObjectId)).toEqual([14, 4]);
    expect(await pos(tpl)).toEqual([8, 4]);
    await g.gear(tpl);
    expect(c.ui.getState().selection).toEqual([tpl]);

    const zone = await g.drawZone([20, -2], [24, 2]);
    expect((await view(c, zone)).cells.opaque?.value).toEqual({ type: "boolean", value: false });
    await g.editInPlace(zone, "name", "Room 1");
    expect(await cellValue(c, zone, "name")).toEqual({ type: "text", value: "Room 1" });

    // An entry dropped on a token's contents list is copied into it; dragged out, it lands on the board.
    const holder = await spawnFromBinder(c, g, "tpl_token", [8, -4]);
    await g.dragEntry(BINDER, "tpl_d20", { object: holder, contents: true });
    const [die] = refsOf(await cellValue(c, holder, "contents"));
    if (die === undefined) throw new Error("no die in the token");
    expect((await view(c, die)).cells.template?.value).toEqual({ type: "ref", object: "tpl_d20" });
    await g.dragObject(die, [10, -6]);
    expect(refsOf(await cellValue(c, holder, "contents"))).toEqual([]);
    expect(await pos(die)).toEqual([10, -6]);
  }, 60_000);

  test('key("Ctrl+Z") undoes one group', async () => {
    const { c, g } = await start();
    const token = await spawnFromBinder(c, g, "tpl_token", [8, 0]);
    await g.editInPlace(token, "name", "Scout");
    const named = await newest(c);
    await g.key("Ctrl+Z");
    expect(await cellValue(c, token, "name")).toEqual({ type: "text", value: "Token" });
    const log = await c.gm.request("log", { limit: 3 });
    expect(log.groups[0]?.index).toBe(named + 1);
    expect(log.groups[0]?.kind).toBe("undo");
    expect(log.groups.find((x) => x.index === named)?.undone).toBe(true);
    // The spawn is not undone.
    expect(c.session.directory().has(token)).toBe(true);
  }, 60_000);
});
