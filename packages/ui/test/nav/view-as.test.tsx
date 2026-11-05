/**
 * The view-as menu (DESIGN.md §4.1 Characters, §4.4, §4.6 View as in the UI;
 * M4-D11) in jsdom against a real in-process authority.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import { createUiStore, TableProvider, type TableSession, ViewAsMenu } from "@vtt/ui";
import { afterEach, expect, test } from "vitest";
import { cleanupAuthorities, startAuthority, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

const text = (value: string) => ({ type: "text" as const, value });
const gmOnly = { type: "viewers" as const, viewers: ["gm" as const] };
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

const SETUP: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "zed",
    to: at(1, 0),
    init: { is_character: true, cells: { name: text("Brena") } },
  },
  {
    type: "create_object",
    id: "brena",
    to: at(2, 0),
    init: { is_character: true, cells: { name: text("Brena") } },
  },
  { type: "create_object", id: "nameless", to: at(3, 0), init: { is_character: true } },
  {
    type: "create_object",
    id: "hero_template",
    to: at(4, 0),
    init: { is_character: true, is_template: true, cells: { name: text("Hero") } },
  },
  { type: "create_object", id: "goblin", to: at(5, 0), init: { cells: { name: text("Goblin") } } },
  {
    type: "create_object",
    id: "secret",
    to: at(6, 0),
    init: { cells: { name: text("Secret door"), visible_to: gmOnly } },
  },
  {
    type: "create_object",
    id: "room",
    to: at(20, 20),
    init: {
      is_zone: true,
      shape: { type: "rect", width: 4, height: 4 },
      cells: { visible_to: gmOnly, opaque: { type: "boolean", value: true } },
    },
  },
];

async function setup() {
  const authority = await startAuthority();
  const other = await authority.client("other");
  await other.transact(SETUP);
  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session });
  render(
    <TableProvider session={session} ui={ui}>
      <ViewAsMenu />
    </TableProvider>,
  );
  return { session, ui, other };
}

const viewerKey = (s: TableSession) => s.viewerKey();

test("lists GM and every character that is not a template, sorted by name then id", async () => {
  await setup();
  const select = screen.getByRole("combobox", { name: "View as" });
  const options = within(select)
    .getAllByRole("option")
    .map((o) => [o.textContent, (o as HTMLOptionElement).value]);
  expect(options).toEqual([
    ["GM", "gm"],
    ["Aldric", "character:aldric"],
    ["Brena", "character:brena"],
    ["Brena", "character:zed"],
    ["nameless", "character:nameless"],
  ]);
  expect((select as HTMLSelectElement).value).toBe("gm");
  expect(screen.queryByText(/Viewing as/)).toBeNull();
});

test("the list follows the directory", async () => {
  const t = await setup();
  await t.other.transact([{ type: "set_character_flag", object: "goblin", value: true }]);
  await screen.findByRole("option", { name: "Goblin" });
});

test("choosing Aldric switches the board view to Aldric's and shows the banner; Back to GM returns", async () => {
  const t = await setup();
  const view = () => t.session.boardView();
  expect(view()?.objects.has("secret")).toBe(true);
  expect(view()?.covers.size).toBe(0);

  await userEvent.selectOptions(screen.getByRole("combobox", { name: "View as" }), "Aldric");
  await waitFor(() => expect(viewerKey(t.session)).toBe("character:aldric"));
  // A hidden object disappears; the opaque GM-only room is a cover.
  expect(view()?.objects.has("secret")).toBe(false);
  expect(view()?.objects.has("goblin")).toBe(true);
  expect(view()?.covers.size).toBe(1);
  expect(t.session.getSnapshot().activeBoard).toBe("gm_board");
  const banner = await screen.findByRole("status");
  expect(banner.textContent).toContain("Viewing as Aldric — read-only inspector");
  expect((screen.getByRole("combobox", { name: "View as" }) as HTMLSelectElement).value).toBe(
    "character:aldric",
  );

  await userEvent.click(within(banner).getByRole("button", { name: "Back to GM" }));
  await waitFor(() => expect(viewerKey(t.session)).toBe("gm"));
  expect(view()?.objects.has("secret")).toBe(true);
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});

test("choosing GM in the menu returns to the GM view", async () => {
  const t = await setup();
  await act(() => t.session.setView("gm_board", { type: "character", id: "brena" }));
  await screen.findByText(/Viewing as Brena/);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "View as" }), "GM");
  await waitFor(() => expect(viewerKey(t.session)).toBe("gm"));
});

test("the GM selection is kept while switching to view-as", async () => {
  const t = await setup();
  act(() => t.ui.select(["goblin"]));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "View as" }), "Aldric");
  await waitFor(() => expect(viewerKey(t.session)).toBe("character:aldric"));
  expect(t.ui.getState().selection).toEqual(["goblin"]);
});
