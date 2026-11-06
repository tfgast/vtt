/**
 * The toolbar's pen group and the E key (vtt-qf5.27; DESIGN.md §4.6 Ink and
 * text; M6-D28): shown only while the ink tool is active, a swatch per
 * palette colour, a width menu and the Eraser toggle, all setting the ink
 * tool's options in the UI store; D picks the pen, E the eraser.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  activateInkEraser,
  activateTool,
  bindKeybindings,
  createInkTool,
  createUiStore,
  DEFAULT_TOOL_OPTIONS,
  INK_PALETTE,
  INK_WIDTHS,
  type KeyActions,
  keyCommand,
  type SessionSnapshot,
  selectTool,
  TableProvider,
  type TableSession,
  Toolbar,
  ToolRegistry,
  type UiStore,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  cleanup();
});

function fakeSession(): TableSession {
  const snapshot: SessionSnapshot = {
    connection: null,
    ready: true,
    revision: 0,
    boards: [],
    table: null,
    activeBoard: null,
    viewer: { type: "gm" },
    viewVersion: 0,
  };
  return {
    client: { on: () => () => {} },
    onConnectionNotice: () => () => {},
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    directory: () => new Map(),
    refLabel: (_viewer: unknown, id: string) => id,
    setView: async () => {},
    watchObjects: async () => {},
  } as unknown as TableSession;
}

function renderToolbar(): UiStore {
  const session = fakeSession();
  const ui = createUiStore({ session });
  const registry = new ToolRegistry();
  registry.register(selectTool);
  registry.register(createInkTool());
  render(
    <TableProvider session={session} ui={ui}>
      <Toolbar registry={registry} />
    </TableProvider>,
  );
  return ui;
}

const inkOptions = (ui: UiStore) => {
  const tool = ui.getState().tool;
  expect(tool.id).toBe("ink");
  return tool.options;
};

describe("the pen group (M6-D28)", () => {
  test("shows only while the ink tool is active", async () => {
    const user = userEvent.setup();
    const ui = renderToolbar();
    expect(screen.queryByRole("group", { name: "Pen" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ink" }));
    const group = screen.getByRole("group", { name: "Pen" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(INK_PALETTE.map((c) => `${c.label} ink`));
    const width = within(group).getByRole("combobox", { name: "Pen width" }) as HTMLSelectElement;
    expect([...width.options].map((o) => o.textContent)).toEqual(INK_WIDTHS.map((w) => w.label));
    expect(width.value).toBe("0.04");
    expect(inkOptions(ui)).toEqual(DEFAULT_TOOL_OPTIONS.ink);
    act(() => ui.setTool("select"));
    expect(screen.queryByRole("group", { name: "Pen" })).toBeNull();
  });

  test("a swatch, the width menu and Eraser set the ink tool's options; they are kept across tools", async () => {
    const user = userEvent.setup();
    const ui = renderToolbar();
    await user.click(screen.getByRole("button", { name: "Ink" }));
    await user.click(screen.getByRole("button", { name: "Red ink" }));
    expect(inkOptions(ui)).toEqual({ color: "#d32f2f", width: 0.04, eraser: false });
    expect(screen.getByRole("button", { name: "Red ink" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Pen width" }), "Marker");
    expect(inkOptions(ui)).toEqual({ color: "#d32f2f", width: 0.16, eraser: false });
    await user.click(screen.getByRole("checkbox", { name: "Eraser" }));
    expect(inkOptions(ui)).toEqual({ color: "#d32f2f", width: 0.16, eraser: true });
    // Picking a colour goes back to the pen.
    await user.click(screen.getByRole("button", { name: "Blue ink" }));
    expect(inkOptions(ui)).toEqual({ color: "#1e63d6", width: 0.16, eraser: false });
    // Away and back: the pen is kept.
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: "Ink" }));
    expect(inkOptions(ui)).toEqual({ color: "#1e63d6", width: 0.16, eraser: false });
  });
});

describe("D and E", () => {
  test("E is the eraser command; D activates the pen, E the eraser, keeping colour and width", () => {
    const blank = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null };
    expect(keyCommand({ ...blank, key: "e" })).toEqual({ type: "eraser" });
    expect(keyCommand({ ...blank, key: "E", shiftKey: true })).toEqual({ type: "eraser" });
    const ui = createUiStore({ session: fakeSession() });
    activateInkEraser(ui);
    expect(inkOptions(ui)).toEqual({ ...DEFAULT_TOOL_OPTIONS.ink, eraser: true });
    ui.setTool("ink", { color: "#2e8b3a", width: 0.08, eraser: true });
    activateTool(ui, "ink");
    expect(inkOptions(ui)).toEqual({ color: "#2e8b3a", width: 0.08, eraser: false });
    activateTool(ui, "select");
    activateInkEraser(ui);
    expect(inkOptions(ui)).toEqual({ color: "#2e8b3a", width: 0.08, eraser: true });
  });

  test("bindKeybindings dispatches E to the eraser action", () => {
    const actions: KeyActions = {
      undo: vi.fn(),
      save: vi.fn(),
      help: vi.fn(),
      tool: vi.fn(),
      eraser: vi.fn(),
    };
    const off = bindKeybindings(window, actions);
    fireEvent.keyDown(document.body, { key: "e" });
    expect(actions.eraser).toHaveBeenCalledTimes(1);
    expect(actions.tool).not.toHaveBeenCalled();
    off();
  });
});
