/**
 * Per-cell visibility in the inspector's cell list (vtt-3l6.11; DESIGN.md
 * §4.4, §4.6 View as in the UI; PROTOCOL.md §5 `set_cell_visibility`, §7.2
 * `absent_cell_visibility`): the "Visibility rules" section, the viewers
 * picker on `visible_to`, view-as and read-only mode. jsdom against a real
 * in-process authority through the shared helper.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellView, ObjectId, WireOp } from "@vtt/protocol";
import { CellList, createUiStore, TableProvider, type TableSession, useSession } from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(async () => {
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

const REHIDE = 'if(len(contents(this).where(tag has "pc")) > 0, all, gm)';

/**
 * On `gm_board`: the characters Aldric and Bryn, a character template; the
 * goblin (hp a formula, ac a literal); an opaque room whose `visible_to` is
 * the re-hiding formula.
 */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "bryn",
    to: at(1, 0),
    init: { is_character: true, cells: { name: text("Bryn") } },
  },
  {
    type: "create_object",
    id: "hero_template",
    to: at(30, 30),
    init: { is_character: true, is_template: true, cells: { name: text("Hero template") } },
  },
  {
    type: "create_object",
    id: "goblin",
    to: at(2, 0),
    init: {
      cells: {
        name: text("Goblin"),
        max_hp: num(12),
        damage_taken: num(3),
        hp: formula("max_hp - damage_taken"),
        ac: num(13),
      },
    },
  },
  {
    type: "create_object",
    id: "room",
    to: at(20, 20),
    init: {
      is_zone: true,
      shape: { type: "rect", width: 6, height: 6 },
      cells: {
        name: text("Guard room"),
        opaque: { type: "boolean", value: true },
        visible_to: formula(REHIDE),
      },
    },
  },
];

function Harness({ session, object }: { session: TableSession; object: ObjectId }) {
  useSession((s) => s.viewVersion);
  const view = session.objectView(object);
  if (view === null) return <p>missing {object}</p>;
  const readOnly = session.getSnapshot().viewer.type !== "gm";
  return <CellList object={object} view={view} session={session} readOnly={readOnly} />;
}

async function setup(object: ObjectId = "goblin") {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView(object) !== null, `the ${object} view`);
  const ui = createUiStore({ session });
  render(
    <TableProvider session={session} ui={ui}>
      <Harness session={session} object={object} />
    </TableProvider>,
  );
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    ui,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number }),
  };
}

function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("[data-cell]")].find(
    (el) => el.getAttribute("data-cell") === name,
  );
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

const hasRow = (name: string) =>
  [...document.querySelectorAll("[data-cell]")].some((el) => el.getAttribute("data-cell") === name);

function rule(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-rule]")].find(
    (el) => el.getAttribute("data-rule") === name,
  );
}

const cellOf = (session: TableSession, object: string, cell: string): CellView | undefined =>
  session.objectView(object)?.cells[cell];

async function addRule(user: ReturnType<typeof userEvent.setup>, name: string, viewers: string[]) {
  await user.type(screen.getByRole("textbox", { name: "Rule cell name" }), name);
  const picker = screen.getByRole("group", { name: "New rule viewers" });
  for (const v of viewers) await user.click(within(picker).getByRole("checkbox", { name: v }));
  await user.click(screen.getByRole("button", { name: "Add visibility rule" }));
}

describe("visibility rules", () => {
  test('"Add visibility rule" for an absent cell secret with gm creates, lists and clears it', async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    expect(rule("secret")).toBeUndefined();
    await addRule(user, "secret", ["gm"]);
    await until(
      () => session.objectView("goblin")?.absent_cell_visibility !== undefined,
      "the rule",
    );
    expect(transacts()[0]).toMatchObject({
      base_revision: 1,
      ops: [
        {
          type: "set_cell_visibility",
          object: "goblin",
          cell: "secret",
          viewers: { type: "viewers", viewers: ["gm"] },
        },
      ],
    });
    expect(session.objectView("goblin")?.absent_cell_visibility).toEqual({
      secret: { type: "viewers", viewers: ["gm"] },
    });
    await until(() => rule("secret") !== undefined, "the listed rule");
    expect(hasRow("secret")).toBe(false);
    const listed = rule("secret") as HTMLElement;
    expect((within(listed).getByRole("checkbox", { name: "gm" }) as HTMLInputElement).checked).toBe(
      true,
    );
    await user.click(within(listed).getByRole("button", { name: "Clear" }));
    await until(() => rule("secret") === undefined, "the cleared rule");
    expect(transacts()[1]?.ops).toEqual([
      { type: "set_cell_visibility", object: "goblin", cell: "secret", viewers: null },
    ]);
    expect(session.objectView("goblin")?.absent_cell_visibility).toBeUndefined();
  });

  test("a rule's picker edits it and Default clears it", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    await addRule(user, "ac", ["gm"]);
    await until(() => rule("ac") !== undefined, "the ac rule");
    await user.click(within(rule("ac") as HTMLElement).getByRole("checkbox", { name: "Aldric" }));
    await until(
      () => (cellOf(session, "goblin", "ac")?.visibility?.viewers.length ?? 0) === 2,
      "the edited rule",
    );
    expect(transacts()[1]?.ops).toEqual([
      {
        type: "set_cell_visibility",
        object: "goblin",
        cell: "ac",
        viewers: { type: "viewers", viewers: ["gm", { type: "ref", object: "aldric" }] },
      },
    ]);
    await user.click(
      within(rule("ac") as HTMLElement).getByRole("checkbox", {
        name: "Default (object's visibility)",
      }),
    );
    await until(
      () => cellOf(session, "goblin", "ac")?.visibility === undefined,
      "the cleared rule",
    );
    expect(rule("ac")).toBeUndefined();
  });

  test("the pickers list characters from the directory, not templates", async () => {
    await setup();
    const picker = screen.getByRole("group", { name: "New rule viewers" });
    expect(within(picker).getByRole("checkbox", { name: "Aldric" })).toBeDefined();
    expect(within(picker).getByRole("checkbox", { name: "Bryn" })).toBeDefined();
    expect(within(picker).queryByRole("checkbox", { name: "Hero template" })).toBeNull();
  });

  test("an invalid rule name is refused locally", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    await addRule(user, "__proto__", ["gm"]);
    expect(screen.getByRole("alert").textContent).toMatch(/__proto__/);
    expect(transacts()).toEqual([]);
  });

  test("setting ac to gm with the picker hides ac from Aldric while hp stays", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    await addRule(user, "ac", ["gm"]);
    await until(() => cellOf(session, "goblin", "ac")?.visibility !== undefined, "the metadata");
    expect(cellOf(session, "goblin", "ac")?.visibility).toEqual({
      type: "viewers",
      viewers: ["gm"],
    });
    await until(() => within(row("ac")).queryByLabelText("Visible to gm") !== null, "the glyph");
    expect(within(row("hp")).queryByLabelText(/^Visible to/)).toBeNull();

    // View as Aldric: the inspector shows Aldric's view, read-only.
    await act(() =>
      session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
    );
    await until(() => !hasRow("ac") && hasRow("hp"), "Aldric's view");
    expect(hasRow("ac")).toBe(false);
    expect(hasRow("hp")).toBe(true);
  });
});

describe("visible_to", () => {
  test("setting visible_to to gm with the picker", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const picker = within(row("visible_to")).getByRole("group", { name: "Viewers of visible_to" });
    expect(
      (within(picker).getByRole("checkbox", { name: "all" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      within(picker).queryByRole("checkbox", { name: "Default (object's visibility)" }),
    ).toBeNull();
    await user.click(within(picker).getByRole("checkbox", { name: "gm" }));
    await until(() => cellOf(session, "goblin", "visible_to")?.kind === "literal", "the literal");
    await user.click(
      within(
        within(row("visible_to")).getByRole("group", { name: "Viewers of visible_to" }),
      ).getByRole("checkbox", { name: "all" }),
    );
    await until(
      () =>
        JSON.stringify(cellOf(session, "goblin", "visible_to")?.value) ===
        '{"type":"viewers","viewers":["gm"]}',
      "visible_to = gm",
    );
    expect(transacts().map((t) => t.ops)).toEqual([
      [
        {
          type: "set_value",
          object: "goblin",
          cell: "visible_to",
          value: { type: "viewers", viewers: ["all", "gm"] },
        },
      ],
      [
        {
          type: "set_value",
          object: "goblin",
          cell: "visible_to",
          value: { type: "viewers", viewers: ["gm"] },
        },
      ],
    ]);
  });

  test("on the re-hiding formula, the picker writes an override and the marker shows", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup("room");
    const visibleTo = row("visible_to");
    expect(within(visibleTo).getByText(`=${REHIDE}`)).toBeDefined();
    const picker = within(visibleTo).getByRole("group", { name: "Viewers of visible_to" });
    expect((within(picker).getByRole("checkbox", { name: "gm" }) as HTMLInputElement).checked).toBe(
      true,
    );
    await user.click(within(picker).getByRole("checkbox", { name: "all" }));
    await until(() => cellOf(session, "room", "visible_to")?.overridden === true, "the override");
    expect(transacts()[0]?.ops).toEqual([
      {
        type: "set_value",
        object: "room",
        cell: "visible_to",
        value: { type: "viewers", viewers: ["all", "gm"] },
      },
    ]);
    await until(
      () =>
        within(row("visible_to")).queryByText("Overridden: no longer follows its formula") !== null,
      "the marker",
    );
    expect(within(row("visible_to")).getByText(`=${REHIDE}`)).toBeDefined();
  });
});

describe("read-only", () => {
  test("read-only mode renders no inputs, no source and no visibility glyphs", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    await addRule(user, "max_hp", ["gm", "Aldric"]);
    await until(() => cellOf(session, "goblin", "max_hp")?.visibility !== undefined, "the rule");
    await act(() =>
      session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
    );
    await until(() => session.getSnapshot().viewer.type === "character", "view-as");
    await until(() => document.querySelectorAll("input").length === 0, "the read-only list");
    expect(hasRow("hp")).toBe(true);
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(screen.queryByText("ƒ")).toBeNull();
    expect(screen.queryByText(/^=/)).toBeNull();
    expect(screen.queryByLabelText(/^Visible to/)).toBeNull();
    expect(screen.queryByText("Visibility rules")).toBeNull();
    for (const name of [
      "Rename",
      "Delete",
      "Edit formula",
      "Replace formula with value",
      "Add cell",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(row("hp").querySelector('[data-part="value"]')?.textContent).toBe("9");
    await user.dblClick(row("hp").querySelector('[data-part="value"]') as HTMLElement);
    expect(document.querySelectorAll("input, textarea")).toHaveLength(0);
  });
});
