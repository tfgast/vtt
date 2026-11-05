/**
 * The status bar from fake session snapshots (vtt-3l6.17; PROTOCOL.md §2
 * connection errors; review r1 finding 13): the connection banners and
 * terminal messages, the revision and the save status.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ConnectionError, ProtocolClient } from "@vtt/protocol";
import {
  createUiStore,
  type SessionSnapshot,
  StatusBar,
  save,
  TableProvider,
  type TableSession,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Fake {
  session: TableSession;
  set(patch: Partial<SessionSnapshot>): void;
  saveResult(result: unknown): void;
}

function fakeSession(initial: Partial<SessionSnapshot>): Fake {
  let snapshot: SessionSnapshot = {
    connection: null,
    ready: true,
    revision: 0,
    boards: [],
    table: null,
    activeBoard: null,
    viewer: { type: "gm" },
    viewVersion: 0,
    ...initial,
  };
  const listeners = new Set<() => void>();
  let resolveSave: (value: unknown) => void = () => {};
  const client = {
    on: () => () => {},
    request: (method: string) =>
      method === "save"
        ? new Promise((resolve) => {
            resolveSave = resolve;
          })
        : Promise.reject(new Error("unexpected request")),
  } as unknown as ProtocolClient;
  const session = {
    client,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    onConnectionNotice: () => () => {},
    setView: async () => {},
    watchObjects: async () => {},
  } as unknown as TableSession;
  return {
    session,
    set(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const l of [...listeners]) l();
    },
    saveResult: (result) => resolveSave(result),
  };
}

function renderStatus(fake: Fake) {
  const ui = createUiStore({ session: fake.session });
  render(
    <TableProvider session={fake.session} ui={ui}>
      <StatusBar />
    </TableProvider>,
  );
}

const conn = (c: ConnectionError) => ({ connection: c, ready: false });

describe("connection", () => {
  test("wrong_table renders a terminal message", () => {
    const fake = fakeSession(
      conn({ code: "wrong_table", message: "the authority now serves another table" }),
    );
    renderStatus(fake);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/different table/);
    expect(alert.textContent).toContain("the authority now serves another table");
  });

  test("unauthorized explains the new token and offers Reload, which reloads the page", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const fake = fakeSession(conn({ code: "unauthorized", message: "unauthorized" }));
    renderStatus(fake);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/restarted with a new token/);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("disconnected and recovering show banners after the first connection; none when connected", () => {
    const fake = fakeSession({ connection: null, ready: true, revision: 4 });
    renderStatus(fake);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Revision 4")).toBeDefined();
    act(() => fake.set(conn({ code: "disconnected", message: "connection lost" })));
    expect(screen.getByRole("alert").textContent).toMatch(/Disconnected/);
    act(() =>
      fake.set(conn({ code: "disconnected", message: "connection lost", recovering: true })),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Resynchronizing/);
    act(() => fake.set({ connection: null, ready: true }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("before the first welcome the status says Connecting", () => {
    const fake = fakeSession(conn({ code: "disconnected", message: "not connected yet" }));
    renderStatus(fake);
    expect(screen.getByRole("contentinfo").textContent).toMatch(/Connecting/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("save status", () => {
  test("Saving… then Saved, and Save failed with the reason", async () => {
    const fake = fakeSession({});
    renderStatus(fake);
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = save(fake.session);
    });
    expect(screen.getByText("Saving…")).toBeDefined();
    await act(async () => {
      fake.saveResult({ status: "saved", revision: 3 });
      await pending;
    });
    expect(screen.getByText("Saved")).toBeDefined();
    act(() => {
      pending = save(fake.session);
    });
    await act(async () => {
      fake.saveResult({ status: "failed", revision: 3, message: "disk full" });
      await pending;
    });
    expect(screen.getByText("Save failed: disk full")).toBeDefined();
  });
});
