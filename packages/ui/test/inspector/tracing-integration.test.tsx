/**
 * Dependency tracing end to end (vtt-3l6.24; DESIGN.md §4.6 Dependency
 * tracing, §4.4; FORMULAS.md §9; PROTOCOL.md §9 `explain_cell`, `zones`;
 * review r1 findings 3, 10, r2 finding 10): the real `CellList`/`CellRow`
 * and `ObjectList` drive the hover with user-event, `startTracing` asks the
 * in-process authority, and `UiStore.highlight` shows what the viewer may
 * see. jsdom against a real authority through the shared helper.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Viewer, WireOp } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import {
  CellList,
  createUiStore,
  ObjectList,
  startTracing,
  TableProvider,
  type TableSession,
  type UiStore,
  useSession,
} from "@vtt/ui";
import { afterEach, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  cleanup();
  await cleanupAuthorities();
});

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const formula = (source: string) => ({ type: "formula" as const, source });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});
const GM_ONLY = { type: "viewers" as const, viewers: ["gm" as const] };
const ALDRIC: Viewer = { type: "character", id: "aldric" };

/**
 * On `gm_board`: a goblin with a d20 die lying on it (FORMULAS.md §10 "A
 * goblin that shows HIT"); a sign whose `peek` reads the GM-only trap and the
 * goblin; a room zone under an imported map (map z 10 over room z 0) holding
 * Aldric, a guard and the GM-only trap, all above the map.
 */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(101, 101),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "goblin",
    to: at(0, 0),
    init: {
      shape: { type: "rect", width: 4, height: 4 },
      cells: {
        name: text("Goblin"),
        ac: num(13),
        hit: formula('any(on(this).where(tag has "d20").total >= ac)'),
      },
    },
  },
  {
    type: "create_object",
    id: "die",
    to: at(1, 1),
    init: { tag: ["d20"], cells: { name: text("Die"), total: num(15) } },
  },
  {
    type: "create_object",
    id: "sign",
    to: at(50, 50),
    init: {
      cells: { name: text("Sign"), peek: formula('obj("trap").z + obj("goblin").z') },
    },
  },
  {
    type: "create_object",
    id: "room",
    to: at(100, 100),
    init: {
      is_zone: true,
      shape: { type: "rect", width: 10, height: 10 },
      cells: { name: text("Guard room") },
    },
  },
  {
    type: "create_object",
    id: "map",
    to: at(80, 80),
    init: {
      shape: { type: "rect", width: 60, height: 60 },
      cells: { name: text("Map"), image: text("map.png") },
    },
  },
  {
    type: "create_object",
    id: "guard",
    to: at(102, 102),
    init: { cells: { name: text("Guard") } },
  },
  {
    type: "create_object",
    id: "trap",
    to: at(103, 103),
    init: { cells: { name: text("Trap"), visible_to: GM_ONLY } },
  },
  ...(
    [
      ["room", 0],
      ["map", 10],
      ["aldric", 20],
      ["guard", 20],
      ["trap", 20],
    ] as const
  ).map(([object, z]): WireOp => ({ type: "set_value", object, cell: "z", value: num(z) })),
];

function Harness({
  session,
  ui,
  object,
}: {
  session: TableSession;
  ui: UiStore;
  object: ObjectId;
}) {
  useSession((s) => s.viewVersion);
  const view = session.objectView(object);
  const readOnly = session.getSnapshot().viewer.type !== "gm";
  return (
    <>
      {view === null ? (
        <p>missing {object}</p>
      ) : (
        <CellList object={object} view={view} session={session} readOnly={readOnly} />
      )}
      <ObjectList session={session} ui={ui} />
    </>
  );
}

interface Held {
  readonly method: string;
  release(): void;
}

async function setup(object: ObjectId, options: { hold?: boolean } = {}) {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  expect(await seed.transact(SEED, { label: "Seed" })).toMatchObject({ status: "committed" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.boardView()?.objects.has("trap") === true, "the board view");
  const ui = createUiStore({ session });
  // Optionally hold explain and zones answers until the test releases them.
  const held: Held[] = [];
  const original = session.client.request.bind(session.client);
  const request = vi.spyOn(session.client, "request");
  request.mockImplementation(((method: string, params: unknown) => {
    const answer = (original as (m: string, p: unknown) => Promise<unknown>)(method, params);
    if (!options.hold || (method !== "explain_cell" && method !== "zones")) return answer;
    return new Promise<unknown>((resolve, reject) => {
      held.push({ method, release: () => answer.then(resolve, reject) });
    });
  }) as unknown as typeof session.client.request);
  stops.push(startTracing({ session, ui }));
  render(
    <TableProvider session={session} ui={ui}>
      <Harness session={session} ui={ui} object={object} />
    </TableProvider>,
  );
  const calls = (method: string) => request.mock.calls.filter(([m]) => m === method);
  return { session, ui, held, calls };
}

function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("[data-cell]")].find(
    (el) => el.getAttribute("data-cell") === name,
  );
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

function objectRow(id: string): HTMLElement {
  const list = screen.getByRole("list", { name: "Objects on the board" });
  const found = within(list)
    .queryAllByRole("listitem")
    .find((li) => li.getAttribute("data-object") === id);
  if (found === undefined) throw new Error(`no object row for ${id}`);
  return found;
}

const highlight = (ui: UiStore) => [...ui.getState().highlight];
const sorted = (ids: readonly string[]) => [...ids].sort();

test("hovering the goblin's hit row highlights the die on it", async () => {
  const user = userEvent.setup();
  const { ui } = await setup("goblin");
  await user.hover(row("hit"));
  expect(ui.getState().hoveredCell).toEqual({ object: "goblin", cell: "hit" });
  await until(() => highlight(ui).length > 0, "the highlight");
  expect(highlight(ui)).toEqual(["die"]);
  await user.unhover(row("hit"));
  expect(highlight(ui)).toEqual([]);
});

test("as the GM, a formula reading the GM-only trap highlights the trap", async () => {
  const user = userEvent.setup();
  const { ui } = await setup("sign");
  await user.hover(row("peek"));
  await until(() => highlight(ui).length > 0, "the highlight");
  expect(sorted(highlight(ui))).toEqual(["goblin", "trap"]);
});

test("as Aldric, a formula reading the GM-only trap highlights nothing from it", async () => {
  const user = userEvent.setup();
  const { session, ui, calls } = await setup("sign");
  await act(() => ui.setViewer(ALDRIC));
  await until(() => session.viewerKey() === "character:aldric", "the view as Aldric");
  await until(() => session.objectView("sign") !== null, "Aldric's sign view");
  await user.hover(row("peek"));
  await until(() => highlight(ui).length > 0, "the highlight");
  expect(highlight(ui)).toEqual(["goblin"]);
  expect(calls("explain_cell").at(-1)?.[1]).toEqual({
    object: "sign",
    cell: "peek",
    depth: 1,
    viewer: ALDRIC,
  });
});

test("leaving a row before its explanation returns leaves no highlight", async () => {
  const user = userEvent.setup();
  const { ui, held } = await setup("goblin", { hold: true });
  await user.hover(row("hit"));
  await until(() => held.length === 1, "the explain request");
  await user.unhover(row("hit"));
  expect(ui.getState().hoveredCell).toBeNull();
  for (const h of held.splice(0)) h.release();
  // Let the answer arrive and be dropped.
  await new Promise((r) => setTimeout(r, 50));
  expect(highlight(ui)).toEqual([]);
});

test("a zone hovered while a cell is hovered shows its contents, then the cell's dependencies again", async () => {
  const user = userEvent.setup();
  const { ui } = await setup("goblin");
  await user.hover(row("hit"));
  await until(() => highlight(ui).length > 0, "the cell highlight");
  expect(highlight(ui)).toEqual(["die"]);
  act(() => ui.setHoveredZone("room"));
  await until(() => highlight(ui).includes("guard"), "the zone highlight");
  expect(sorted(highlight(ui))).toEqual(["aldric", "guard", "trap"]);
  expect(ui.getState().hoveredCell).toEqual({ object: "goblin", cell: "hit" });
  act(() => ui.setHoveredZone(null));
  expect(highlight(ui)).toEqual(["die"]);
});

test("with a zone hovered, switching to Aldric at an unchanged revision refreshes with Aldric's zones", async () => {
  const { session, ui, calls } = await setup("goblin");
  act(() => ui.setHoveredZone("room"));
  await until(() => highlight(ui).length > 0, "the GM's zone highlight");
  expect(sorted(highlight(ui))).toEqual(["aldric", "guard", "trap"]);
  const revision = session.getSnapshot().revision;
  await act(() => ui.setViewer(ALDRIC));
  await until(() => session.viewerKey() === "character:aldric", "the view as Aldric");
  await until(() => calls("zones").length === 2, "Aldric's zones request");
  expect(calls("zones")[1]?.[1]).toEqual({ board: "gm_board", viewer: ALDRIC });
  await until(() => highlight(ui).length > 0, "Aldric's zone highlight");
  expect(sorted(highlight(ui))).toEqual(["aldric", "guard"]);
  expect(session.getSnapshot().revision).toBe(revision);
});

test("hovering the object list's row of a room under a map highlights the tokens inside the room", async () => {
  const user = userEvent.setup();
  const { ui } = await setup("goblin");
  await user.hover(objectRow("room"));
  expect(ui.getState().hoveredZone).toBe("room");
  await until(() => highlight(ui).length > 0, "the zone highlight");
  expect(sorted(highlight(ui))).toEqual(["aldric", "guard", "trap"]);
  expect(highlight(ui)).not.toContain("map");
  await user.unhover(objectRow("room"));
  expect(highlight(ui)).toEqual([]);
});
