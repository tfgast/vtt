/**
 * The toolbar's Snap toggle (vtt-nb8.31; DESIGN.md §4.6 On the canvas,
 * M6-D13): a checkbox named "Snap", checked by default, beside Fog, that
 * sets the session's `UiState.snap` both ways and follows the store.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createUiStore,
  registerCreationTools,
  type SessionSnapshot,
  selectTool,
  TableProvider,
  type TableSession,
  Toolbar,
  ToolRegistry,
  type UiStore,
} from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";

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
  registerCreationTools(registry);
  render(
    <TableProvider session={session} ui={ui}>
      <Toolbar registry={registry} />
    </TableProvider>,
  );
  return ui;
}

describe("the Snap toggle (M6-D13)", () => {
  test("is a checkbox named Snap, on by default, right after Fog", () => {
    const ui = renderToolbar();
    expect(ui.getState().snap).toBe(true);
    const snap = screen.getByRole("checkbox", { name: "Snap" });
    expect((snap as HTMLInputElement).checked).toBe(true);
    const boxes = screen.getAllByRole("checkbox");
    const fog = screen.getByRole("checkbox", { name: "Fog" });
    expect(boxes.indexOf(snap)).toBe(boxes.indexOf(fog) + 1);
  });

  test("clicking it turns snap off and on in the UI state", async () => {
    const user = userEvent.setup();
    const ui = renderToolbar();
    const snap = screen.getByRole("checkbox", { name: "Snap" });
    await user.click(snap);
    expect(ui.getState().snap).toBe(false);
    expect((snap as HTMLInputElement).checked).toBe(false);
    await user.click(snap);
    expect(ui.getState().snap).toBe(true);
    expect((snap as HTMLInputElement).checked).toBe(true);
  });

  test("follows the store when snap is set elsewhere", () => {
    const ui = renderToolbar();
    act(() => ui.setSnap(false));
    expect((screen.getByRole("checkbox", { name: "Snap" }) as HTMLInputElement).checked).toBe(
      false,
    );
  });
});
