/**
 * The last active board per table (vtt-qf5.57; DESIGN.md §4.3 Boards,
 * M6-D24): the composed `<App>` in jsdom against a real file-backed
 * authority (a table with an identity), reloaded by unmounting it and
 * mounting it again on a new session.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  App,
  boardMemoryKey,
  type CreateRenderer,
  createCanvas2DRenderer,
  ImageCache,
  RecordingContext,
  type TableSession,
} from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  startAuthority,
  type TestAuthority,
  until,
  whenReady,
} from "../support/authority";

const GM_BOARD = "gm_board";

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await cleanupAuthorities();
  localStorage.clear();
});

const createRenderer: CreateRenderer = (_canvas, { requestRedraw }) =>
  createCanvas2DRenderer(new RecordingContext(), {
    images: new ImageCache({ resolve: (p) => p, onLoad: requestRedraw }),
  });

/** Mounts `<App>` on a new session (a page load); resolves once ready. */
async function load(authority: TestAuthority): Promise<{
  session: TableSession;
  /** Every active board the session's snapshots showed. */
  seen: (string | null)[];
  unmount(): void;
}> {
  const session = authority.session();
  const seen: (string | null)[] = [];
  session.subscribe(() => {
    const board = session.getSnapshot().activeBoard;
    if (seen.at(-1) !== board) seen.push(board);
  });
  const utils = render(<App session={session} createRenderer={createRenderer} />);
  await whenReady(session);
  return {
    session,
    seen,
    unmount() {
      utils.unmount();
      session.close();
    },
  };
}

/** A file-backed table with the GM board plus Crypt and Town. */
async function tableWithBoards(): Promise<TestAuthority> {
  const authority = await startAuthority({ file: true });
  const gm = await authority.client("gm");
  await gm.transact([
    { type: "add_board", id: "crypt", name: "Crypt" },
    { type: "add_board", id: "town", name: "Town" },
  ]);
  return authority;
}

async function switchTo(session: TableSession, name: string, board: string): Promise<void> {
  fireEvent.click(await screen.findByRole("tab", { name }));
  await until(
    () => session.getSnapshot().ready && session.getSnapshot().activeBoard === board,
    `the ${name} board`,
  );
}

describe("the last active board", () => {
  test("a reload lands on the board that was active", async () => {
    const authority = await tableWithBoards();
    const first = await load(authority);
    expect(first.session.getSnapshot().activeBoard).toBe(GM_BOARD);
    await switchTo(first.session, "Town", "town");
    await switchTo(first.session, "Crypt", "crypt");
    const table = first.session.getSnapshot().table;
    expect(table?.id).toBeTruthy();
    expect(localStorage.getItem(`vtt.board:${table?.id}`)).toBe("crypt");
    expect(boardMemoryKey(table)).toBe(`vtt.board:${table?.id}`);
    first.unmount();

    const second = await load(authority);
    await until(
      () =>
        second.session.getSnapshot().activeBoard === "crypt" &&
        second.session.boardView()?.board === "crypt",
      "the remembered Crypt board",
    );
    expect(screen.getByRole("tab", { name: "Crypt" }).getAttribute("aria-selected")).toBe("true");
    // The first board was never shown on the way: the restore came before any board view.
    expect(second.seen).not.toContain(GM_BOARD);
    expect(localStorage.getItem(`vtt.board:${table?.id}`)).toBe("crypt");
    second.unmount();
  });

  test("a reload after the authority restarts lands on the remembered board", async () => {
    const authority = await tableWithBoards();
    const first = await load(authority);
    await switchTo(first.session, "Town", "town");
    first.unmount();
    await authority.host.save();
    await authority.restart();

    const second = await load(authority);
    await until(
      () => second.session.getSnapshot().activeBoard === "town",
      "the remembered Town board",
    );
    second.unmount();
  });

  test("a remembered board that no longer exists falls back to the first board", async () => {
    const authority = await tableWithBoards();
    const first = await load(authority);
    await switchTo(first.session, "Town", "town");
    const key = boardMemoryKey(first.session.getSnapshot().table) ?? "";
    first.unmount();

    // Town goes away while the page is closed.
    const gm = await authority.client("gm2");
    await gm.transact([{ type: "remove_board", id: "town" }]);

    const second = await load(authority);
    expect(second.session.getSnapshot().activeBoard).toBe(GM_BOARD);
    await until(() => localStorage.getItem(key) === GM_BOARD, "the fallback remembered");
    second.unmount();
  });

  test("a refusing localStorage loses only the memory", async () => {
    const authority = await tableWithBoards();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const first = await load(authority);
    expect(first.session.getSnapshot().activeBoard).toBe(GM_BOARD);
    await switchTo(first.session, "Town", "town");
    first.unmount();

    const second = await load(authority);
    expect(second.session.getSnapshot().activeBoard).toBe(GM_BOARD);
    second.unmount();
  });

  test("an in-memory table (no id, no path) is not remembered", async () => {
    const authority = await startAuthority();
    const gm = await authority.client("gm");
    await gm.transact([{ type: "add_board", id: "town", name: "Town" }]);
    const first = await load(authority);
    expect(boardMemoryKey(first.session.getSnapshot().table)).toBeNull();
    await switchTo(first.session, "Town", "town");
    first.unmount();
    expect(localStorage.length).toBe(0);

    const second = await load(authority);
    expect(second.session.getSnapshot().activeBoard).toBe(GM_BOARD);
    second.unmount();
  });
});
