/**
 * The inspector panel (vtt-3l6.12; DESIGN.md §4.1 flags and tags, §4.5/§4.6
 * actions shown read-only, §4.6 The inspector and View as in the UI, M4-D11;
 * PROTOCOL.md §5 `set_tag`, `set_template_flag`, `set_character_flag`, §6
 * `base_revision`): selection text, the object header and the actions list.
 * jsdom against a real in-process authority through the shared helper.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import { createUiStore, Inspector, type TableSession, type UiStore } from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
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

/** Aldric (a character), a goblin with actions and tags, a pawn, a zone. */
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
      tag: ["creature", "goblinoid"],
      shape: { type: "circle", radius: 0.5 },
      cells: { name: text("Goblin"), hp: num(7), save_roll: { type: "empty" } },
      actions: [
        { name: "Roll save", when: "save_roll = empty", steps: ["roll(1d20) -> save_roll"] },
        { name: "Reset", steps: ["set(save_roll, empty)"] },
      ],
    },
  },
  { type: "create_object", id: "pawn", to: at(4, 0), init: { cells: { name: text("Pawn") } } },
  {
    type: "create_object",
    id: "room",
    to: at(10, 10),
    init: {
      is_zone: true,
      shape: { type: "rect", width: 4, height: 4 },
      cells: { name: text("Room") },
    },
  },
];

interface Setup {
  session: TableSession;
  ui: UiStore;
  transacts(): { ops: WireOp[]; base_revision?: number; label?: string }[];
}

async function setup(): Promise<Setup> {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView("goblin") !== null, "the goblin view");
  const ui = createUiStore({ session });
  render(<Inspector session={session} ui={ui} />);
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    ui,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number; label?: string }),
  };
}

const header = () => screen.getByRole("region", { name: "Object" });

async function viewAs(session: TableSession, id: string) {
  await act(() => session.setView(session.getSnapshot().activeBoard, { type: "character", id }));
  await until(() => session.getSnapshot().viewer.type === "character", "view-as");
}

describe("selection", () => {
  test("nothing, several and one selected", async () => {
    const { ui } = await setup();
    expect(screen.getByText("Nothing selected")).toBeDefined();
    act(() => ui.select(["goblin", "pawn", "room"]));
    expect(screen.getByText("3 objects selected")).toBeDefined();
    act(() => ui.select(["goblin"]));
    expect(within(header()).getByRole("heading", { name: "Goblin" })).toBeDefined();
    expect(within(header()).getByText("goblin")).toBeDefined();
    expect(screen.getByRole("region", { name: "Cells" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Contents" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Actions" })).toBeDefined();
    act(() => ui.select([]));
    expect(screen.getByText("Nothing selected")).toBeDefined();
  });

  test("the copy button copies the id", async () => {
    const user = userEvent.setup();
    const { ui } = await setup();
    act(() => ui.select(["goblin"]));
    await user.click(within(header()).getByRole("button", { name: "Copy id" }));
    expect(await navigator.clipboard.readText()).toBe("goblin");
  });
});

describe("header flags", () => {
  test("toggling Character writes set_character_flag; the character joins the view-as source", async () => {
    const user = userEvent.setup();
    const { session, ui, transacts } = await setup();
    act(() => ui.select(["pawn"]));
    const character = within(header()).getByRole("checkbox", { name: "Character" });
    expect((character as HTMLInputElement).checked).toBe(false);
    await user.click(character);
    await until(() => session.directory().get("pawn")?.is_character === true, "the flag");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_character_flag", object: "pawn", value: true },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    // The view-as list's source: directory characters that are not templates.
    const characters = [...session.directory().values()]
      .filter((v) => v.is_character && !v.is_template)
      .map((v) => v.id);
    expect(characters).toContain("pawn");
    await until(
      () =>
        (within(header()).getByRole("checkbox", { name: "Character" }) as HTMLInputElement).checked,
      "the checkbox to follow",
    );
  });

  test("toggling Template writes set_template_flag; is_zone is read-only", async () => {
    const user = userEvent.setup();
    const { session, ui, transacts } = await setup();
    act(() => ui.select(["pawn"]));
    await user.click(within(header()).getByRole("checkbox", { name: "Template" }));
    await until(() => session.objectView("pawn")?.is_template === true, "the template flag");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_template_flag", object: "pawn", value: true },
    ]);
    await user.click(within(header()).getByRole("checkbox", { name: "Template" }));
    await until(() => session.objectView("pawn")?.is_template === false, "the cleared flag");
    expect(transacts()[1]?.ops).toEqual([
      { type: "set_template_flag", object: "pawn", value: false },
    ]);
    expect(transacts()[1]?.base_revision).toBe(2);

    act(() => ui.select(["room"]));
    const zone = within(header()).getByRole("checkbox", { name: "Zone" }) as HTMLInputElement;
    expect(zone.checked).toBe(true);
    expect(zone.disabled).toBe(true);
  });
});

describe("tags", () => {
  test("tags show as chips; adding and removing write set_tag", async () => {
    const user = userEvent.setup();
    const { session, ui, transacts } = await setup();
    act(() => ui.select(["goblin"]));
    const tags = () => within(header()).getByRole("list", { name: "Tags" });
    expect(
      within(tags())
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-tag")),
    ).toEqual(["creature", "goblinoid"]);
    await user.type(within(header()).getByRole("textbox", { name: "New tag" }), "boss{Enter}");
    const tagsOf = () => {
      const v = session.objectView("goblin")?.cells.tag?.value;
      return v?.type === "list" ? v.items.map((i) => (i.type === "text" ? i.value : "?")) : [];
    };
    await until(() => tagsOf().includes("boss"), "the added tag");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_tag", object: "goblin", tags: ["creature", "goblinoid", "boss"] },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    // A duplicate is not written.
    await user.type(within(header()).getByRole("textbox", { name: "New tag" }), "boss{Enter}");
    expect(transacts()).toHaveLength(1);

    await until(() => within(tags()).queryAllByRole("listitem").length === 3, "three chips");
    await user.click(within(header()).getByRole("button", { name: "Remove tag goblinoid" }));
    await until(() => !tagsOf().includes("goblinoid"), "the removed tag");
    expect(transacts()[1]?.ops).toEqual([
      { type: "set_tag", object: "goblin", tags: ["creature", "boss"] },
    ]);
    expect(transacts()[1]?.base_revision).toBe(2);
  });
});

describe("actions", () => {
  test("the GM sees each action's when and steps, read-only", async () => {
    const { ui } = await setup();
    act(() => ui.select(["goblin"]));
    const actions = screen.getByRole("region", { name: "Actions" });
    const save = within(actions).getByText("Roll save").closest("li") as HTMLElement;
    expect(within(save).getByText("save_roll = empty")).toBeDefined();
    expect(within(save).getByText("roll(1d20) -> save_roll")).toBeDefined();
    const reset = within(actions).getByText("Reset").closest("li") as HTMLElement;
    expect(within(reset).getByText("set(save_roll, empty)")).toBeDefined();
    expect(within(reset).queryByText(/when/i)).toBeNull();
    expect(within(actions).getByText(/editing arrives with M5/)).toBeDefined();
    expect(within(actions).queryByRole("textbox")).toBeNull();
    expect(within(actions).queryByRole("button")).toBeNull();
  });

  test("viewing as Aldric shows action names only and a read-only inspector", async () => {
    const { session, ui } = await setup();
    act(() => ui.select(["goblin"]));
    await viewAs(session, "aldric");
    await until(
      () => session.objectView("goblin")?.actions[0]?.steps === undefined,
      "Aldric's view of the goblin",
    );
    const actions = await screen.findByRole("region", { name: "Actions" });
    expect(within(actions).getByText("Roll save")).toBeDefined();
    expect(within(actions).getByText("Reset")).toBeDefined();
    expect(within(actions).queryByText("save_roll = empty")).toBeNull();
    expect(within(actions).queryByText("roll(1d20) -> save_roll")).toBeNull();
    // Read-only: no flag edits, no tag edits, no shape commands, no cell editing.
    for (const name of ["Template", "Character", "Zone"]) {
      expect((within(header()).getByRole("checkbox", { name }) as HTMLInputElement).disabled).toBe(
        true,
      );
    }
    expect(within(header()).queryByRole("textbox", { name: "New tag" })).toBeNull();
    expect(within(header()).queryByRole("button", { name: /Remove tag/ })).toBeNull();
    expect(within(header()).queryByRole("button", { name: /shape/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add cell" })).toBeNull();
  });
});
