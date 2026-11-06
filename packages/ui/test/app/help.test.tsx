/**
 * Keyboard and gesture help (vtt-nb8.8; DESIGN.md §4.6 On the canvas, §4.7;
 * M6 plan Q12): the composed `App` in jsdom against an in-process authority.
 * `?` (Shift+/) and the toolbar's "?" button open a dialog listing every
 * `KEY_BINDINGS` entry, then every `HELP_GESTURES` row; Esc and its close
 * button close it; `?` typed in a text field (the formula bar) is text.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  App,
  type CreateRenderer,
  createCanvas2DRenderer,
  createUiStore,
  HELP_GESTURES,
  ImageCache,
  KEY_BINDINGS,
  keyCommand,
  RecordingContext,
  type TableSession,
  TOOL_KEYS,
  type UiStore,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  startAuthority,
  type TestAuthority,
  until,
  whenReady,
} from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    x: 0,
    y: 0,
    right: RECT.width,
    bottom: RECT.height,
    toJSON: () => ({}),
  });
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await cleanupAuthorities();
  localStorage.clear();
});

async function renderApp(
  authority: TestAuthority,
): Promise<{ session: TableSession; ui: UiStore }> {
  const session = authority.session();
  const ui = createUiStore({ session });
  const ctx = new RecordingContext();
  const createRenderer: CreateRenderer = (_canvas, { requestRedraw }) =>
    createCanvas2DRenderer(ctx, {
      images: new ImageCache({ resolve: (p) => p, onLoad: requestRedraw }),
    });
  render(<App session={session} ui={ui} createRenderer={createRenderer} />);
  await whenReady(session);
  await screen.findByRole("toolbar", { name: "Tools" });
  return { session, ui };
}

const helpDialog = () => screen.queryByRole("dialog", { name: "Keyboard and gesture help" });

/** Every binding, then every gesture, in the table's order, with both columns. */
function expectFullHelp(dialog: HTMLElement) {
  const rows = within(dialog)
    .getAllByRole("row")
    .map((row) =>
      within(row)
        .queryAllByRole("cell")
        .map((c) => c.textContent),
    )
    .filter((cells) => cells.length > 0);
  expect(rows).toEqual([
    ...KEY_BINDINGS.map((b) => [b.keys, b.label]),
    ...HELP_GESTURES.map((g) => [g.gesture, g.effect]),
  ]);
}

describe("the tables", () => {
  test("HELP_GESTURES is the bead's list, verbatim and in order", () => {
    expect(HELP_GESTURES).toEqual([
      { gesture: "Space-drag or middle-drag", effect: "pan" },
      {
        gesture: "Wheel or two-finger scroll",
        effect: "pan (over a list that scrolls: scroll it)",
      },
      { gesture: "Ctrl/Cmd+wheel or pinch", effect: "zoom about the pointer" },
      { gesture: "Click", effect: "select" },
      { gesture: "Alt+click", effect: "cycle through the objects under the pointer" },
      { gesture: "Drag one template", effect: "drop a copy" },
      { gesture: "Alt held at drag start", effect: "move the template instead of copying it" },
      { gesture: "Alt held at drop onto an object", effect: "put the dragged objects inside it" },
      {
        gesture: "Snap on (toolbar, the default)",
        effect: "a moved or dropped object lands on a half unit; the grid shows",
      },
      { gesture: "Drop on a card's editor field", effect: "set that cell to the dropped object" },
      { gesture: "Drop on a list", effect: "insert there" },
      { gesture: "Drop a template on a binder", effect: "give that binder a template" },
      { gesture: "Double-click", effect: "run the object's default action, else edit in place" },
      { gesture: "Click an editor field", effect: "edit it" },
      {
        gesture: "Chevron on a list entry",
        effect: "expand or collapse it (a template entry makes a working copy)",
      },
      { gesture: "Gear", effect: "edit a template" },
      {
        gesture: "Tab or Shift+Tab, one object selected",
        effect:
          "ring its next or previous face button, field or chevron; Enter or Space presses it",
      },
      {
        gesture: "Drag a cell row from the inspector onto an object (layout mode)",
        effect: "show the cell on the face",
      },
      { gesture: "Delete", effect: "remove the selection" },
      {
        gesture: "Drop on a board tab",
        effect:
          "move the dragged objects to that board (one template: a copy at its view's centre)",
      },
      { gesture: "Move selection to board…", effect: "move objects between boards" },
    ]);
  });

  test("KEY_BINDINGS is what dispatch reads: every row's command, ? included", () => {
    expect(KEY_BINDINGS.map((b) => b.keys)).toEqual([
      ...Object.keys(TOOL_KEYS).map((k) => k.toUpperCase()),
      "Ctrl/Cmd+Z",
      "Ctrl/Cmd+S",
      "+",
      "=",
      "-",
      "?",
    ]);
    const blank = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null };
    for (const b of KEY_BINDINGS) {
      expect(b.label).not.toBe("");
      const mod = b.keys.startsWith("Ctrl/Cmd+");
      const key = mod ? b.keys.slice("Ctrl/Cmd+".length) : b.keys;
      expect(keyCommand({ ...blank, key, ctrlKey: mod, shiftKey: key === "?" })).toEqual(b.command);
    }
    expect(keyCommand({ ...blank, key: "?", shiftKey: true })).toEqual({ type: "help" });
  });
});

describe("the help dialog in the app", () => {
  test("? opens it with every binding and gesture; Esc closes it", async () => {
    const authority = await startAuthority();
    await renderApp(authority);
    expect(helpDialog()).toBeNull();

    act(() => {
      fireEvent.keyDown(document.body, { key: "?", code: "Slash", shiftKey: true });
    });
    const dialog = helpDialog();
    expect(dialog).not.toBeNull();
    expectFullHelp(dialog as HTMLElement);

    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(helpDialog()).toBeNull();
  });

  test("? toggles it: pressed again, it closes", async () => {
    const authority = await startAuthority();
    await renderApp(authority);
    const user = userEvent.setup();
    await user.keyboard("?");
    expect(helpDialog()).not.toBeNull();
    await user.keyboard("?");
    expect(helpDialog()).toBeNull();
  });

  test("the toolbar's ? button opens it; its close button closes it", async () => {
    const authority = await startAuthority();
    await renderApp(authority);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Keyboard and gesture help" });
    expect(button.textContent).toBe("?");
    await user.click(button);
    const dialog = helpDialog() as HTMLElement;
    expect(dialog).not.toBeNull();
    expectFullHelp(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(helpDialog()).toBeNull();
  });

  test("while open, Tab and Shift+Tab stay in the dialog, the app is inert, and Esc still closes it", async () => {
    const authority = await startAuthority();
    await renderApp(authority);
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "Keyboard and gesture help" });
    await user.click(opener);
    const dialog = helpDialog() as HTMLElement;
    const toolbar = screen.getByRole("toolbar", { hidden: true, name: "Tools" });
    expect(toolbar.closest("[inert]")).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard("{Escape}");
    expect(helpDialog()).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("? typed in the formula bar is text, not help", async () => {
    const authority = await startAuthority();
    const gm = await authority.client("gm");
    await gm.transact([
      {
        type: "create_object",
        id: "goblin",
        to: { type: "board", board: "gm_board", position: [0, 0] },
        init: {
          shape: { type: "rect", width: 1, height: 1 },
          cells: { note: { type: "text", value: "" } },
        },
      },
    ]);
    const { session, ui } = await renderApp(authority);
    await until(() => session.boardView()?.objects.has("goblin") ?? false, "the goblin");
    act(() => ui.focusCell({ object: "goblin", cell: "note" }));
    const bar = await screen.findByRole("textbox", { name: "Formula" });
    const user = userEvent.setup();
    await user.click(bar);
    await user.keyboard("?");
    expect(helpDialog()).toBeNull();
    expect((bar as HTMLTextAreaElement).value).toContain("?");
  });
});
