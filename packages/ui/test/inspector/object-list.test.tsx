/**
 * The inspector's object list (vtt-3l6.12; review r1 finding 6, r2 finding
 * 10; DESIGN.md §4.4, §4.6 View as in the UI; FORMULAS.md §5 query order):
 * the objects directly on the active board in the current view, topmost
 * first, zones marked; a click selects; hovering a zone row sets
 * `hoveredZone`. jsdom against a real in-process authority through the
 * shared helper.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import { createUiStore, Inspector, ObjectList, type TableSession, type UiStore } from "@vtt/ui";
import { afterEach, expect, test } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

/**
 * A room zone lying under an imported map image (z 10 over z 0), Aldric
 * inside the room, a goblin holding a die, a GM-only trap; a second board
 * with a statue.
 */
const SEED: WireOp[] = [
  { type: "add_board", id: "crypt", name: "Crypt" },
  {
    type: "create_object",
    id: "room",
    to: at(0, 0),
    init: {
      is_zone: true,
      shape: { type: "rect", width: 10, height: 10 },
      cells: { name: text("Guard room") },
    },
  },
  {
    type: "create_object",
    id: "map",
    to: at(0, 0),
    init: {
      shape: { type: "rect", width: 40, height: 40 },
      cells: { name: text("Map"), image: text("map.png") },
    },
  },
  {
    type: "create_object",
    id: "aldric",
    to: at(1, 1),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "goblin",
    to: at(3, 3),
    init: { cells: { name: text("Goblin") } },
  },
  {
    type: "create_object",
    id: "die",
    to: { type: "container", container: "goblin" },
    init: { cells: { name: text("Die") } },
  },
  {
    type: "create_object",
    id: "trap",
    to: at(4, 4),
    init: {
      cells: { name: text("Trap"), visible_to: { type: "viewers", viewers: ["gm"] } },
    },
  },
  {
    type: "create_object",
    id: "statue",
    to: { type: "board", board: "crypt", position: [0, 0] },
    init: { cells: { name: text("Statue") } },
  },
  // Creation lands each object on top (FORMULAS.md §3.1); fix the stacking order.
  ...(
    [
      ["room", 0],
      ["map", 10],
      ["aldric", 20],
      ["goblin", 5],
      ["trap", 30],
    ] as const
  ).map(([object, z]): WireOp => ({ type: "set_value", object, cell: "z", value: num(z) })),
];

async function setup(): Promise<{
  session: TableSession;
  ui: UiStore;
  seed: Awaited<ReturnType<Awaited<ReturnType<typeof startAuthority>>["client"]>>;
}> {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.boardView()?.objects.has("trap") === true, "the board view");
  const ui = createUiStore({ session });
  render(<ObjectList session={session} ui={ui} />);
  return { session, ui, seed };
}

const rows = () =>
  within(screen.getByRole("list", { name: "Objects on the board" })).queryAllByRole("listitem");
const ids = () => rows().map((li) => li.getAttribute("data-object"));
const rowOf = (id: string) => {
  const found = rows().find((li) => li.getAttribute("data-object") === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

test("lists the objects directly on the board, topmost first, zones marked", async () => {
  await setup();
  expect(ids()).toEqual(["trap", "aldric", "map", "goblin", "room"]);
  expect(within(rowOf("map")).getByText("Map")).toBeDefined();
  expect(within(rowOf("room")).getByText("Guard room")).toBeDefined();
  expect(within(rowOf("room")).getByText("zone")).toBeDefined();
  expect(within(rowOf("map")).queryByText("zone")).toBeNull();
});

test("a click selects the zone under the map; hovering its row sets hoveredZone", async () => {
  const user = userEvent.setup();
  const { ui } = await setup();
  await user.click(within(rowOf("room")).getByRole("button", { name: /Guard room/ }));
  expect(ui.getState().selection).toEqual(["room"]);
  await user.hover(rowOf("room"));
  expect(ui.getState().hoveredZone).toBe("room");
  await user.unhover(rowOf("room"));
  expect(ui.getState().hoveredZone).toBeNull();
  // A non-zone row does not set it.
  await user.hover(rowOf("map"));
  expect(ui.getState().hoveredZone).toBeNull();
  // Shift-click adds to the selection.
  await user.keyboard("{Shift>}");
  await user.click(within(rowOf("goblin")).getByRole("button", { name: /Goblin/ }));
  await user.keyboard("{/Shift}");
  expect(ui.getState().selection).toEqual(["room", "goblin"]);
});

test("viewing as Aldric lists only what Aldric sees; another board lists its own objects", async () => {
  const { session } = await setup();
  await act(() =>
    session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
  );
  await until(() => !ids().includes("trap"), "Aldric's list");
  expect(ids()).toEqual(["aldric", "map", "goblin", "room"]);
  await act(() => session.setView("crypt", { type: "gm" }));
  await until(() => ids().join() === "statue", "the crypt list");
});

test("the inspector has an Objects tab holding the list", async () => {
  const user = userEvent.setup();
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  await until(() => session.boardView()?.objects.has("trap") === true, "the board view");
  const ui = createUiStore({ session });
  render(<Inspector session={session} ui={ui} />);
  expect(screen.getByText("Nothing selected")).toBeDefined();
  await user.click(screen.getByRole("tab", { name: "Objects" }));
  await user.click(within(rowOf("room")).getByRole("button", { name: /Guard room/ }));
  expect(ui.getState().selection).toEqual(["room"]);
  await user.click(screen.getByRole("tab", { name: "Inspector" }));
  expect(
    within(screen.getByRole("region", { name: "Object" })).getByRole("heading", {
      name: "Guard room",
    }),
  ).toBeDefined();
});

test("an object whose position is invalid, or hidden from the viewer, is still listed", async () => {
  const { session, seed } = await setup();
  await seed.transact(
    [
      {
        type: "create_object",
        id: "broken",
        to: at(6, 6),
        init: { cells: { name: text("Broken") } },
      },
      { type: "set_value", object: "broken", cell: "z", value: num(25) },
      { type: "set_formula", object: "broken", cell: "position", source: "1 / 0" },
      {
        type: "create_object",
        id: "sneak",
        to: at(2, 2),
        init: { cells: { name: text("Sneak") } },
      },
      { type: "set_value", object: "sneak", cell: "z", value: num(15) },
      {
        type: "set_cell_visibility",
        object: "sneak",
        cell: "position",
        viewers: { type: "viewers", viewers: ["gm"] },
      },
    ],
    { label: "Add broken and sneak" },
  );
  await session.whenRevision(2);
  await until(() => ids().includes("broken"), "the broken token");
  expect(ids()).toEqual(["trap", "broken", "aldric", "sneak", "map", "goblin", "room"]);
  await act(() =>
    session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
  );
  await until(() => !ids().includes("trap"), "Aldric's list");
  expect(session.objectView("sneak")?.cells.position).toBeUndefined();
  expect(ids()).toEqual(["broken", "aldric", "sneak", "map", "goblin", "room"]);
});

test("a hovered zone row that disappears clears hoveredZone", async () => {
  const user = userEvent.setup();
  const { session, ui, seed } = await setup();
  await user.hover(rowOf("room"));
  expect(ui.getState().hoveredZone).toBe("room");
  await seed.transact([{ type: "remove", object: "room" }], { label: "Remove room" });
  await session.whenRevision(2);
  await until(() => !ids().includes("room"), "the room row to go");
  expect(ui.getState().hoveredZone).toBeNull();
});

test("a board change clears the list's zone hover, but not a hover it does not own", async () => {
  const user = userEvent.setup();
  const { session, ui } = await setup();
  await user.hover(rowOf("room"));
  expect(ui.getState().hoveredZone).toBe("room");
  await act(() => session.setView("crypt", { type: "gm" }));
  await until(() => ids().join() === "statue", "the crypt list");
  expect(ui.getState().hoveredZone).toBeNull();
  // A hover set by someone else (the canvas) is left alone.
  act(() => ui.setHoveredZone("room"));
  await act(() => session.setView("gm_board", { type: "gm" }));
  await until(() => ids().includes("room"), "the gm board list");
  await act(() => session.setView("crypt", { type: "gm" }));
  await until(() => ids().join() === "statue", "the crypt list again");
  expect(ui.getState().hoveredZone).toBe("room");
});

test("a viewer change that hides the hovered zone clears hoveredZone", async () => {
  const user = userEvent.setup();
  const { session, ui, seed } = await setup();
  await seed.transact(
    [
      {
        type: "set_value",
        object: "room",
        cell: "visible_to",
        value: { type: "viewers", viewers: ["gm"] },
      },
    ],
    { label: "Hide room" },
  );
  await session.whenRevision(2);
  await user.hover(rowOf("room"));
  expect(ui.getState().hoveredZone).toBe("room");
  await act(() =>
    session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
  );
  await until(() => !ids().includes("room"), "Aldric's list");
  expect(ui.getState().hoveredZone).toBeNull();
});
