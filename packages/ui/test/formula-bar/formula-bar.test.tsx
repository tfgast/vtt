/**
 * The formula bar (vtt-3l6.13; DESIGN.md §4.2, §4.6 The formula bar, Typing
 * into a cell, View as in the UI; FORMULAS.md §3.2; §5.2 base revisions).
 * jsdom against a real in-process authority through the shared helper.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellView, WireOp } from "@vtt/protocol";
import {
  type CellAddress,
  createUiStore,
  FormulaBar,
  requestFormulaBarFocus,
  sessionNotices,
  type TableSession,
  type UiStore,
} from "@vtt/ui";
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

/** Aldric; `goblin2`; the goblin with literal, formula, overridden, roll, dangling-ref and tiny cells. */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "goblin2",
    to: at(8, 0),
    init: { cells: { name: text("Goblin 2") } },
  },
  { type: "create_object", id: "ghost", to: at(9, 0), init: { cells: { name: text("Ghost") } } },
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
        temp: formula("max_hp + 1"),
        lastroll: { type: "roll", expr: "1d20", dice: [17], dropped: [], total: 17 },
        target: ref("ghost"),
        tiny: num(1e-7),
        multi: formula("max_hp +\n1"),
        lines: text("line one\nline two"),
      },
    },
  },
  { type: "set_value", object: "goblin", cell: "temp", value: num(20) },
  { type: "remove", object: "ghost" },
];

interface Setup {
  session: TableSession;
  ui: UiStore;
  other: Awaited<ReturnType<Awaited<ReturnType<typeof startAuthority>>["client"]>>;
  unmount(): void;
  /** The `transact` params the session sent since setup. */
  transacts(): { ops: WireOp[]; base_revision?: number }[];
}

async function setup(): Promise<Setup> {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const other = await authority.client("Scribe", { kind: "agent" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView("goblin") !== null, "the goblin view");
  const ui = createUiStore({ session });
  const utils = render(<FormulaBar session={session} ui={ui} />);
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    ui,
    other,
    unmount: () => utils.unmount(),
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number }),
  };
}

const cellOf = (session: TableSession, object: string, cell: string): CellView | undefined =>
  session.objectView(object)?.cells[cell];

const input = () =>
  screen.queryByRole("textbox", { name: "Formula" }) as HTMLTextAreaElement | null;

function bar(): HTMLTextAreaElement {
  const found = input();
  if (found === null) throw new Error("the formula bar has no input");
  return found;
}

function focus(ui: UiStore, cell: string | null, object = "goblin"): void {
  act(() => ui.focusCell(cell === null ? null : { object, cell }));
}

/** Lets pending timers and renders settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

const part = (name: string) => document.querySelector<HTMLElement>(`[data-part="${name}"]`);

describe("formula bar", () => {
  test("nothing focused: no input", async () => {
    await setup();
    expect(input()).toBeNull();
    expect(screen.getByText("No cell focused")).toBeDefined();
  });

  test("focusing a formula cell shows =source and the address", async () => {
    const { ui } = await setup();
    focus(ui, "hp");
    expect(bar().value).toBe("=max_hp - damage_taken");
    expect(part("address")?.textContent).toBe("Goblin.hp");
    expect(part("override")).toBeNull();
  });

  test("a literal cell shows its literal; committing =max_hp - damage_taken sets the formula", async () => {
    const { session, ui, transacts } = await setup();
    focus(ui, "ac");
    expect(bar().value).toBe("13");
    const user = userEvent.setup();
    await user.click(bar());
    const base = session.getSnapshot().revision;
    await user.clear(bar());
    await user.type(bar(), "=max_hp - damage_taken{Enter}");
    await until(() => cellOf(session, "goblin", "ac")?.kind === "formula", "the formula");
    expect(cellOf(session, "goblin", "ac")?.source).toBe("max_hp - damage_taken");
    expect(cellOf(session, "goblin", "ac")?.value).toEqual(num(9));
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_formula", object: "goblin", cell: "ac", source: "max_hp - damage_taken" },
    ]);
    expect(transacts()[0]?.base_revision).toBe(base);
    await waitFor(() => expect(bar().value).toBe("=max_hp - damage_taken"));
  });

  test("typing 9 over a formula cell overrides it and the chip appears; Clear clears it", async () => {
    const { session, ui, transacts } = await setup();
    focus(ui, "hp");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "9{Enter}");
    await until(() => cellOf(session, "goblin", "hp")?.overridden === true, "the override");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "hp", value: num(9) },
    ]);
    await waitFor(() => expect(part("override")?.textContent).toContain("override: 9"));
    // The bar still edits the formula source.
    expect(bar().value).toBe("=max_hp - damage_taken");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await until(() => cellOf(session, "goblin", "hp")?.overridden !== true, "the clear");
    expect(transacts()[1]?.ops).toEqual([{ type: "clear_override", object: "goblin", cell: "hp" }]);
    expect(cellOf(session, "goblin", "hp")?.value).toEqual(num(9));
    await waitFor(() => expect(part("override")).toBeNull());
  });

  test("an overridden cell shows =source with its override chip", async () => {
    const { ui } = await setup();
    focus(ui, "temp");
    expect(bar().value).toBe("=max_hp + 1");
    expect(part("override")?.textContent).toContain("override: 20");
  });

  test("=max_hp - shows the parser message, disables commit and sends nothing", async () => {
    const { ui, transacts } = await setup();
    focus(ui, "hp");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "=max_hp -");
    // Checked as you type (debounced).
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toBe("");
    expect(screen.getByRole("button", { name: "Commit" }).hasAttribute("disabled")).toBe(true);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toBeDefined();
    expect(transacts()).toHaveLength(0);
  });

  test("Enter with unchanged input writes nothing", async () => {
    const { ui, transacts } = await setup();
    focus(ui, "hp");
    const user = userEvent.setup();
    await user.click(bar());
    await user.type(bar(), "  {Enter}");
    focus(ui, "ac");
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "13.0{Enter}");
    expect(transacts()).toHaveLength(0);
  });

  test("Escape restores the original text", async () => {
    const { ui, transacts } = await setup();
    focus(ui, "hp");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "=1 + 2");
    expect(bar().value).toBe("=1 + 2");
    await user.keyboard("{Escape}");
    expect(bar().value).toBe("=max_hp - damage_taken");
    await user.keyboard("{Enter}");
    expect(transacts()).toHaveLength(0);
  });

  test("a roll value opens an empty replace-value input with its reason; typing 3 writes 3", async () => {
    const { session, ui, transacts } = await setup();
    focus(ui, "lastroll");
    expect(bar().value).toBe("");
    expect(part("reason")?.textContent).toMatch(/a roll result cannot be typed/);
    const user = userEvent.setup();
    await user.click(bar());
    await user.type(bar(), "3{Enter}");
    await until(() => cellOf(session, "goblin", "lastroll")?.value.type === "number", "the 3");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "lastroll", value: num(3) },
    ]);
  });

  test("a #REF value opens the replace-value input; typing @goblin2 repairs it", async () => {
    const { session, ui } = await setup();
    focus(ui, "target");
    expect(cellOf(session, "goblin", "target")?.value).toMatchObject({
      type: "error",
      code: "#REF",
    });
    expect(bar().value).toBe("");
    expect(part("reason")?.textContent).toMatch(/#REF/);
    const user = userEvent.setup();
    await user.click(bar());
    await user.type(bar(), "@goblin2{Enter}");
    await until(() => cellOf(session, "goblin", "target")?.value.type === "ref", "the repair");
    expect(cellOf(session, "goblin", "target")?.value).toEqual(ref("goblin2"));
  });

  test("a replace-value input left empty writes nothing", async () => {
    const { ui, transacts } = await setup();
    focus(ui, "lastroll");
    const user = userEvent.setup();
    await user.click(bar());
    await user.keyboard("{Enter}");
    expect(transacts()).toHaveLength(0);
  });

  test("1e-7 is shown as decimal text, never with an exponent", async () => {
    const { ui } = await setup();
    focus(ui, "tiny");
    expect(bar().value).toBe("0.0000001");
    expect(bar().value).not.toMatch(/e/i);
  });

  test("concurrent write: focused at r, a second client writes, commit is stale_write", async () => {
    const { session, ui, other, transacts } = await setup();
    focus(ui, "ac");
    const user = userEvent.setup();
    await user.click(bar());
    const base = session.getSnapshot().revision;
    await other.transact([{ type: "set_value", object: "goblin", cell: "ac", value: num(15) }], {
      label: "Scribe sets AC",
    });
    await until(() => session.getSnapshot().revision > base, "the second client's commit");
    expect(cellOf(session, "goblin", "ac")?.value).toEqual(num(15));
    await user.clear(bar());
    await user.type(bar(), "14{Enter}");
    await until(
      () =>
        sessionNotices(session)
          .list()
          .some((n) => n.kind === "stale"),
      "the stale notice",
    );
    expect(transacts()[0]?.base_revision).toBe(base);
    const notice = sessionNotices(session)
      .list()
      .find((n) => n.kind === "stale");
    expect(notice?.text).toContain("Scribe sets AC");
    expect(cellOf(session, "goblin", "ac")?.value).toEqual(num(15));
  });

  test("the bar is read-only as Aldric (value only)", async () => {
    const { session, ui } = await setup();
    focus(ui, "hp");
    await act(async () => {
      await ui.setViewer({ type: "character", id: "aldric" });
    });
    await until(() => session.getSnapshot().viewer.type === "character", "view-as Aldric");
    await waitFor(() => expect(input()).toBeNull());
    expect(part("value")?.textContent).toBe("9");
    expect(screen.queryByText(/max_hp/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
  });

  test("the board, container, contents and id rows offer no editing", async () => {
    const { ui } = await setup();
    for (const cell of ["board", "container", "contents", "id"]) {
      focus(ui, cell);
      expect(input()).toBeNull();
      expect(part("value")).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
    }
  });

  test("name input is always text", async () => {
    const { session, ui, transacts } = await setup();
    focus(ui, "name");
    expect(bar().value).toBe("Goblin");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "=Boss{Enter}");
    await until(() => session.refLabel({ type: "gm" }, "goblin") === "=Boss", "the rename");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "name", value: text("=Boss") },
    ]);
  });

  test("hovering or focusing the bar sets hoveredCell; leaving and blurring clear it", async () => {
    const { ui } = await setup();
    focus(ui, "hp");
    const cell: CellAddress = { object: "goblin", cell: "hp" };
    const user = userEvent.setup();
    const root = part("formula-bar") as HTMLElement;
    await user.hover(root);
    expect(ui.getState().hoveredCell).toEqual(cell);
    await user.unhover(root);
    expect(ui.getState().hoveredCell).toBeNull();
    act(() => bar().focus());
    expect(ui.getState().hoveredCell).toEqual(cell);
    act(() => bar().blur());
    expect(ui.getState().hoveredCell).toBeNull();
  });

  test("requestFormulaBarFocus focuses the cell and the bar's input", async () => {
    const { ui } = await setup();
    act(() => requestFormulaBarFocus(ui, { object: "goblin", cell: "temp" }));
    await waitFor(() => expect(document.activeElement).toBe(bar()));
    expect(ui.getState().focusedCell).toEqual({ object: "goblin", cell: "temp" });
    expect(bar().value).toBe("=max_hp + 1");
  });

  test("a new focused cell discards the draft", async () => {
    const { ui, transacts } = await setup();
    focus(ui, "ac");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "99");
    focus(ui, "hp");
    expect(bar().value).toBe("=max_hp - damage_taken");
    expect(transacts()).toHaveLength(0);
  });
  test("the window losing focus keeps the draft; it is there when focus returns (vtt-nb8.21)", async () => {
    const { ui, transacts } = await setup();
    focus(ui, "ac");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "=max_hp +");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => bar().blur());
    expect(document.activeElement).not.toBe(bar());
    expect(bar().value).toBe("=max_hp +");
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new FocusEvent("focus"));
      bar().focus();
    });
    await settle();
    expect(document.activeElement).toBe(bar());
    expect(bar().value).toBe("=max_hp +");
    await user.type(bar(), " 1{Enter}");
    await waitFor(() => expect(transacts()).toHaveLength(1));
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_formula", object: "goblin", cell: "ac", source: "max_hp + 1" },
    ]);
    hasFocus.mockRestore();
  });

  test("a draft kept over a window blur is discarded when the window comes back to another element", async () => {
    const { ui } = await setup();
    focus(ui, "ac");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "99");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => bar().blur());
    expect(bar().value).toBe("99");
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new FocusEvent("focus"));
    });
    await settle();
    expect(bar().value).toBe("13");
    hasFocus.mockRestore();
  });

  test("a blur to another element of the page (the window keeps focus) still discards the draft", async () => {
    const { ui, transacts } = await setup();
    focus(ui, "ac");
    const user = userEvent.setup();
    await user.click(bar());
    await user.clear(bar());
    await user.type(bar(), "99");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => bar().blur());
    expect(bar().value).toBe("13");
    act(() => bar().focus());
    expect(bar().value).toBe("13");
    expect(transacts()).toHaveLength(0);
    hasFocus.mockRestore();
  });

  test("a multiline formula source round-trips unchanged; Shift+Enter inserts a newline", async () => {
    const { session, ui, transacts } = await setup();
    focus(ui, "multi");
    expect(bar().tagName).toBe("TEXTAREA");
    expect(bar().value).toBe("=max_hp +\n1");
    const user = userEvent.setup();
    await user.click(bar());
    await user.keyboard("{Enter}");
    expect(transacts()).toHaveLength(0);
    await user.click(bar());
    await user.type(bar(), "{Shift>}{Enter}{/Shift}+ 2{Enter}");
    await until(
      () => cellOf(session, "goblin", "multi")?.source === "max_hp +\n1\n+ 2",
      "the source",
    );
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_formula", object: "goblin", cell: "multi", source: "max_hp +\n1\n+ 2" },
    ]);
    await user.click(bar());
    await user.type(bar(), "x");
    await user.keyboard("{Escape}");
    expect(bar().value).toBe("=max_hp +\n1\n+ 2");
  });

  test("a multiline text literal round-trips unchanged", async () => {
    const { session, ui, transacts } = await setup();
    focus(ui, "lines");
    expect(bar().value).toBe("line one\nline two");
    const user = userEvent.setup();
    await user.click(bar());
    await user.keyboard("{Enter}");
    expect(transacts()).toHaveLength(0);
    await user.click(bar());
    await user.type(bar(), "!{Enter}");
    await until(
      () =>
        JSON.stringify(cellOf(session, "goblin", "lines")?.value) ===
        JSON.stringify(text("line one\nline two!")),
      "the text",
    );
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "lines", value: text("line one\nline two!") },
    ]);
  });

  test("the bar's hover clears when focus is removed, and never clears another component's hover", async () => {
    const { ui, unmount } = await setup();
    focus(ui, "hp");
    const user = userEvent.setup();
    const root = part("formula-bar") as HTMLElement;
    await user.hover(root);
    expect(ui.getState().hoveredCell).toEqual({ object: "goblin", cell: "hp" });
    focus(ui, null);
    expect(ui.getState().hoveredCell).toBeNull();
    await user.unhover(root);
    expect(ui.getState().hoveredCell).toBeNull();

    // Another component's hover survives the bar's leave and unmount.
    focus(ui, "ac");
    await user.hover(root);
    expect(ui.getState().hoveredCell).toEqual({ object: "goblin", cell: "ac" });
    act(() => ui.setHoveredCell({ object: "goblin", cell: "max_hp" }));
    await user.unhover(root);
    expect(ui.getState().hoveredCell).toEqual({ object: "goblin", cell: "max_hp" });

    // The bar's own hover is cleared on unmount.
    await user.hover(root);
    expect(ui.getState().hoveredCell).toEqual({ object: "goblin", cell: "ac" });
    unmount();
    expect(ui.getState().hoveredCell).toBeNull();
  });
});
