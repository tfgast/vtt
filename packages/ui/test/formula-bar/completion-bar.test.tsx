/**
 * Completion in the formula bar (vtt-qf5.16; DESIGN.md §4.6 The formula bar;
 * FORMULAS.md §3, §6): suggestions for a bare prefix, a function prefix and
 * after `target.` (the target's cells as the viewer's view has them), the
 * keys and the pointer that accept or close them. jsdom against a real
 * in-process authority, set up as formula-bar.test.tsx.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import { createUiStore, FormulaBar, type TableSession, type UiStore } from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const formula = (source: string) => ({ type: "formula" as const, source });
const ref = (object: string) => ({ type: "ref" as const, object });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

/** The goblin (its `target` is the orc) and the orc. */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "orc",
    to: at(4, 0),
    init: { cells: { name: text("Orc"), ac: num(13), armor: num(2), axe: text("1d8") } },
  },
  {
    type: "create_object",
    id: "goblin",
    to: at(0, 0),
    init: {
      cells: {
        name: text("Goblin"),
        max_hp: num(12),
        mood: num(0),
        hp: formula("max_hp"),
        ac: num(11),
        target: ref("orc"),
      },
    },
  },
];

interface Setup {
  session: TableSession;
  ui: UiStore;
  transacts(): { ops: WireOp[] }[];
}

async function setup(): Promise<Setup> {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView("orc") !== null, "the orc view");
  const ui = createUiStore({ session });
  render(<FormulaBar session={session} ui={ui} />);
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    ui,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[] }),
  };
}

function bar(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Formula" }) as HTMLTextAreaElement;
}

const options = () => screen.queryAllByRole("option");
/** The suggestions shown, functions without their `()` mark. */
const labels = () => options().map((o) => (o.textContent ?? "").replace(/\(\)$/, ""));
const listbox = () => screen.queryByRole("listbox", { name: "Suggestions" });

/** Focuses `goblin.cell`, clicks into the bar, clears it and types `typed`. */
async function typeInto(ui: UiStore, cell: string, typed: string) {
  act(() => ui.focusCell({ object: "goblin", cell }));
  const user = userEvent.setup();
  await user.click(bar());
  await user.clear(bar());
  await user.type(bar(), typed);
  return user;
}

describe("formula bar completion", () => {
  test("a bare prefix suggests the object's cells, then functions", async () => {
    const { ui } = await setup();
    await typeInto(ui, "hp", "=ma");
    expect(labels()[0]).toBe("max_hp");
    expect(labels()).toContain("max");
    expect(labels().every((l) => l.toLowerCase().startsWith("ma"))).toBe(true);
    expect(options()[0]?.dataset.kind).toBe("cell");
    expect(options().at(-1)?.dataset.kind).toBe("function");
    expect(options().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    expect(document.activeElement).toBe(bar());
  });

  test("the edited cell is not suggested; focusing alone opens nothing", async () => {
    const { ui } = await setup();
    act(() => ui.focusCell({ object: "goblin", cell: "hp" }));
    await userEvent.setup().click(bar());
    expect(listbox()).toBeNull();
    await typeInto(ui, "hp", "=h");
    expect(labels()).not.toContain("hp");
  });

  test("a function prefix suggests functions", async () => {
    const { ui } = await setup();
    await typeInto(ui, "hp", "=1 + flo");
    expect(labels()).toEqual(["floor"]);
    expect(options()[0]?.dataset.kind).toBe("function");
  });

  test("after `target.`, the target's readable cells as the viewer's view has them", async () => {
    const { session, ui } = await setup();
    await typeInto(ui, "hp", "=target.");
    const orc = session.objectView("orc");
    if (orc === null) throw new Error("no orc view");
    const expected = [
      ...Object.keys(orc.cells),
      ...(Object.hasOwn(orc.cells, "id") ? [] : ["id"]),
    ].sort((a, b) => a.localeCompare(b));
    expect(labels()).toEqual(expected.slice(0, 8));
    expect(labels()).not.toContain("max_hp");
    await userEvent.setup().type(bar(), "a");
    expect(labels()).toEqual(["ac", "armor", "axe"]);
  });

  test("Down and Enter accept the highlighted suggestion; the caret is after it", async () => {
    const { ui, transacts } = await setup();
    const user = await typeInto(ui, "hp", "=target.a");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(bar().getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    await user.keyboard("{Enter}");
    expect(bar().value).toBe("=target.armor");
    expect(bar().selectionStart).toBe("=target.armor".length);
    expect(transacts()).toHaveLength(0);
    expect(listbox()).toBeNull();
    await user.keyboard(" + 1");
    expect(bar().value).toBe("=target.armor + 1");
  });

  test("Tab accepts the first suggestion in the middle of the text", async () => {
    const { ui } = await setup();
    const user = await typeInto(ui, "hp", "= + mood");
    await user.type(bar(), "ma", { initialSelectionStart: 1, initialSelectionEnd: 1 });
    expect(bar().value).toBe("=ma + mood");
    expect(labels()[0]).toBe("max_hp");
    await user.keyboard("{Tab}");
    expect(bar().value).toBe("=max_hp + mood");
    expect(bar().selectionStart).toBe("=max_hp".length);
    expect(document.activeElement).toBe(bar());
  });

  test("a click on a suggestion accepts it and keeps the input focused", async () => {
    const { ui } = await setup();
    const user = await typeInto(ui, "hp", "=1 + flo");
    const floor = options()[0];
    if (floor === undefined) throw new Error("no suggestion");
    await user.click(floor);
    expect(bar().value).toBe("=1 + floor(");
    expect(bar().selectionStart).toBe("=1 + floor(".length);
    expect(document.activeElement).toBe(bar());
  });

  test("Escape closes the list before it reverts; Enter with nothing highlighted commits", async () => {
    const { session, ui, transacts } = await setup();
    const user = await typeInto(ui, "hp", "=mo");
    expect(listbox()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(listbox()).toBeNull();
    expect(bar().value).toBe("=mo");
    await user.keyboard("{Escape}");
    expect(bar().value).toBe("=max_hp");

    await user.clear(bar());
    await user.type(bar(), "=mo");
    expect(listbox()).not.toBeNull();
    await user.keyboard("{Enter}");
    await until(() => session.objectView("goblin")?.cells.hp?.source === "mo", "the formula");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_formula", object: "goblin", cell: "hp", source: "mo" },
    ]);
  });

  test("no suggestions for a literal", async () => {
    const { ui } = await setup();
    await typeInto(ui, "ac", "ma");
    expect(listbox()).toBeNull();
  });
});
