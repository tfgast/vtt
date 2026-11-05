/**
 * Board tabs (DESIGN.md §4.3, §4.6; PROTOCOL.md §5, §6, §8, §10; M4-D7;
 * review r1 findings 1, 5, 11) in jsdom against a real in-process authority
 * through the shared helper (which injects the `ws` client).
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WebSocketConstructor, WebSocketLike, WireOp } from "@vtt/protocol";
import {
  BoardTabs,
  createUiStore,
  NoBoards,
  TableProvider,
  type TableSession,
  type UiStore,
  undo,
  useNotices,
} from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";
import {
  cleanupAuthorities,
  NodeWebSocket,
  startAuthority,
  until,
  whenReady,
} from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

const text = (value: string) => ({ type: "text" as const, value });

function NoticeList() {
  const notices = useNotices();
  return (
    <ul aria-label="Notices">
      {notices.map((n) => (
        <li key={n.id}>{n.text}</li>
      ))}
    </ul>
  );
}

/** Frames sent by the UI's socket that pass `gate` are held until its promise settles. */
type Gate = (frame: { method?: string; params?: { ops?: WireOp[] } }) => Promise<unknown> | null;

/** A `ws` client whose sends can be held, and which records every transact it sends. */
function gatedWebSocket(gate: Gate, sent: unknown[]): WebSocketConstructor {
  return class GatedSocket implements WebSocketLike {
    readonly #inner: WebSocketLike;
    constructor(url: string) {
      this.#inner = new NodeWebSocket(url);
    }
    send(data: string): void {
      const frame = JSON.parse(data);
      if (frame.method === "transact") sent.push(frame.params);
      const held = gate(frame);
      if (held === null) this.#inner.send(data);
      else void held.finally(() => this.#inner.send(data));
    }
    close(code?: number, reason?: string): void {
      this.#inner.close(code, reason);
    }
    // biome-ignore lint/suspicious/noExplicitAny: matches WebSocketLike
    addEventListener(type: string, listener: (event: any) => void): void {
      this.#inner.addEventListener(type, listener);
    }
  };
}

interface Setup {
  session: TableSession;
  ui: UiStore;
  other: Awaited<ReturnType<Awaited<ReturnType<typeof startAuthority>>["client"]>>;
  /** The params of every transact the UI sent. */
  sent: { base_revision: number; ops: WireOp[]; label?: string }[];
}

async function setup(ops: WireOp[] = [], gate: Gate = () => null): Promise<Setup> {
  const authority = await startAuthority();
  const other = await authority.client("other");
  if (ops.length > 0) await other.transact(ops);
  const sent: Setup["sent"] = [];
  const session = authority.session({ WebSocket: gatedWebSocket(gate, sent) });
  await whenReady(session);
  const ui = createUiStore({ session });
  render(
    <TableProvider session={session} ui={ui}>
      <BoardTabs />
      <NoBoards />
      <NoticeList />
    </TableProvider>,
  );
  return { session, ui, other, sent };
}

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const activeTab = () =>
  screen.queryAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const boardIds = (s: TableSession) => s.getSnapshot().boards.map((b) => b.id);
const noticeTexts = () =>
  within(screen.getByRole("list", { name: "Notices" }))
    .queryAllByRole("listitem")
    .map((li) => li.textContent);

async function addBoard(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New board" }));
  await user.type(screen.getByRole("textbox", { name: "Board name" }), `${name}{Enter}`);
}

async function openTabMenu(name: string) {
  const user = userEvent.setup();
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("tab", { name }) });
  return screen.getByRole("menu", { name: `Board ${name}` });
}

describe("tabs", () => {
  test("one tab per board in board-list order, name else id; click activates", async () => {
    const t = await setup([
      { type: "add_board", id: "vault", name: "Vault" },
      { type: "add_board", id: "attic" },
    ]);
    expect(tabNames()).toEqual(["GM", "Vault", "attic"]);
    expect(activeTab()).toBe("GM");
    await userEvent.click(screen.getByRole("tab", { name: "Vault" }));
    await waitFor(() => expect(activeTab()).toBe("Vault"));
    expect(t.session.getSnapshot().activeBoard).toBe("vault");
  });
});

describe("adding (board ids chosen in the UI)", () => {
  test('adding "Crypt" creates board crypt and activates it; again creates crypt_2', async () => {
    const t = await setup();
    await addBoard("Crypt");
    await waitFor(() => expect(activeTab()).toBe("Crypt"));
    expect(boardIds(t.session)).toEqual(["gm_board", "crypt"]);
    expect(t.session.getSnapshot().activeBoard).toBe("crypt");
    expect(t.sent.at(-1)?.ops).toEqual([{ type: "add_board", id: "crypt", name: "Crypt" }]);

    await addBoard("Crypt");
    await waitFor(() => expect(boardIds(t.session)).toEqual(["gm_board", "crypt", "crypt_2"]));
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt_2"));
    expect(tabNames()).toEqual(["GM", "Crypt", "Crypt"]);
  });

  test("a board id retired by an earlier removal is skipped after the rejection", async () => {
    const t = await setup([
      { type: "add_board", id: "crypt", name: "Crypt" },
      { type: "remove_board", id: "crypt" },
    ]);
    expect(boardIds(t.session)).toEqual(["gm_board"]);
    await addBoard("Crypt");
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt_2"));
    expect(boardIds(t.session)).toEqual(["gm_board", "crypt_2"]);
    // Two attempts with the same base revision; the retried refusal leaves no notice.
    expect(t.sent.map((p) => p.ops)).toEqual([
      [{ type: "add_board", id: "crypt", name: "Crypt" }],
      [{ type: "add_board", id: "crypt_2", name: "Crypt" }],
    ]);
    expect(t.sent[0]?.base_revision).toBe(t.sent[1]?.base_revision);
    expect(noticeTexts()).toEqual([]);
  });

  test("another client takes the chosen id just before the add is sent: the next suffix is tried", async () => {
    let other: Setup["other"] | null = null;
    let raced = false;
    const t = await setup([], (frame) => {
      const op = frame.params?.ops?.[0];
      if (frame.method !== "transact" || op?.type !== "add_board" || raced || other === null) {
        return null;
      }
      raced = true;
      // The id the UI chose becomes an object id (one namespace, DESIGN.md §4.1).
      return other.transact([
        {
          type: "create_object",
          id: op.id,
          to: { type: "board", board: "gm_board", position: [0, 0] },
        },
      ]);
    });
    other = t.other;
    await addBoard("Crypt");
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt_2"));
    expect(raced).toBe(true);
    expect(t.sent.map((p) => (p.ops[0] as { id: string }).id)).toEqual(["crypt", "crypt_2"]);
    expect(noticeTexts()).toEqual([]);
  });

  test("an id taken by an object the UI knows is skipped without a refusal", async () => {
    const t = await setup([
      {
        type: "create_object",
        id: "crypt",
        to: { type: "board", board: "gm_board", position: [0, 0] },
      },
    ]);
    await addBoard("Crypt");
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt_2"));
    expect(t.sent).toHaveLength(1);
  });

  test("the add captures the revision at the click", async () => {
    const t = await setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New board" }));
    const atClick = t.session.getSnapshot().revision;
    // An unrelated commit while the name is typed.
    await t.other.transact([{ type: "add_board", id: "attic" }]);
    await until(() => t.session.getSnapshot().revision > atClick, "the commit");
    await user.type(screen.getByRole("textbox", { name: "Board name" }), "Crypt{Enter}");
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt"));
    expect(t.sent[0]?.base_revision).toBe(atClick);
  });

  test("Escape cancels without a write", async () => {
    const t = await setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New board" }));
    await user.type(screen.getByRole("textbox", { name: "Board name" }), "Crypt{Escape}");
    expect(screen.queryByRole("textbox", { name: "Board name" })).toBeNull();
    expect(t.sent).toEqual([]);
  });
});

describe("renaming", () => {
  test("double-click renames; the tab updates after the commit event", async () => {
    const t = await setup([{ type: "add_board", id: "vault", name: "Vault" }]);
    const user = userEvent.setup();
    await user.dblClick(screen.getByRole("tab", { name: "Vault" }));
    const input = screen.getByRole("textbox", { name: "Rename board" });
    await user.clear(input);
    await user.type(input, "Old Vault{Enter}");
    await screen.findByRole("tab", { name: "Old Vault" });
    expect(t.session.getSnapshot().boards.find((b) => b.id === "vault")?.name).toBe("Old Vault");
    expect(t.sent.at(-1)).toMatchObject({
      ops: [{ type: "rename_board", id: "vault", name: "Old Vault" }],
    });
  });

  test("the rename is stale when another client renamed the board after the double-click", async () => {
    const t = await setup([{ type: "add_board", id: "vault", name: "Vault" }]);
    const user = userEvent.setup();
    await user.dblClick(screen.getByRole("tab", { name: "Vault" }));
    const atClick = t.session.getSnapshot().revision;
    await t.other.transact([{ type: "rename_board", id: "vault", name: "Their Vault" }]);
    await until(() => t.session.getSnapshot().revision > atClick, "the other rename");
    const input = screen.getByRole("textbox", { name: "Rename board" });
    await user.clear(input);
    await user.type(input, "Mine{Enter}");
    await waitFor(() =>
      expect(noticeTexts().some((n) => /table changed first/.test(n ?? ""))).toBe(true),
    );
    expect(t.sent.at(-1)?.base_revision).toBe(atClick);
    expect(screen.getByRole("tab", { name: "Their Vault" })).toBeDefined();
  });
});

describe("removing (review r1 finding 11)", () => {
  test("removing a non-empty board shows the refusal notice and keeps the tab", async () => {
    await setup([
      { type: "add_board", id: "vault", name: "Vault" },
      {
        type: "create_object",
        id: "chest",
        to: { type: "board", board: "vault", position: [0, 0] },
      },
    ]);
    const menu = await openTabMenu("Vault");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove board" }));
    await waitFor(() => expect(noticeTexts().some((n) => /not empty/.test(n ?? ""))).toBe(true));
    expect(tabNames()).toEqual(["GM", "Vault"]);
  });

  test("removing an empty active board removes the tab and activates another", async () => {
    const t = await setup([{ type: "add_board", id: "vault", name: "Vault" }]);
    await act(() => t.session.setView("vault", { type: "gm" }));
    await waitFor(() => expect(activeTab()).toBe("Vault"));
    const menu = await openTabMenu("Vault");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove board" }));
    await waitFor(() => expect(tabNames()).toEqual(["GM"]));
    await waitFor(() => expect(activeTab()).toBe("GM"));
    expect(t.sent.at(-1)?.ops).toEqual([{ type: "remove_board", id: "vault" }]);
  });

  test("another client removing the active board moves the tabs to the remaining board", async () => {
    const t = await setup([{ type: "add_board", id: "vault", name: "Vault" }]);
    await act(() => t.session.setView("vault", { type: "gm" }));
    await waitFor(() => expect(activeTab()).toBe("Vault"));
    await t.other.transact([{ type: "remove_board", id: "vault" }]);
    await waitFor(() => expect(tabNames()).toEqual(["GM"]));
    await waitFor(() => expect(activeTab()).toBe("GM"));
  });

  test('removing the last board shows the empty state, and "Add board" creates one', async () => {
    const t = await setup();
    expect(screen.queryByText("No boards")).toBeNull();
    const menu = await openTabMenu("GM");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove board" }));
    const empty = await screen.findByRole("region", { name: "No boards" });
    expect(tabNames()).toEqual([]);
    expect(t.session.getSnapshot().activeBoard).toBeNull();

    const user = userEvent.setup();
    await user.click(within(empty).getByRole("button", { name: "Add board" }));
    await user.type(within(empty).getByRole("textbox", { name: "Board name" }), "Fresh{Enter}");
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("fresh"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "No boards" })).toBeNull());
    expect(tabNames()).toEqual(["Fresh"]);
  });
});

describe('"Move selection to board…" (review r1 finding 5)', () => {
  const GOBLINS: WireOp[] = [
    { type: "add_board", id: "crypt", name: "Crypt" },
    ...[1, 2, 3].map(
      (n): WireOp => ({
        type: "create_object",
        id: `goblin${n}`,
        to: { type: "board", board: "gm_board", position: [n * 2, n + 0.5] },
        init: { cells: { name: text(`Goblin ${n}`) } },
      }),
    ),
    {
      type: "create_object",
      id: "pc",
      to: { type: "board", board: "gm_board", position: [9, 9] },
      init: { cells: { name: text("PC") } },
    },
  ];

  const placeOf = (s: TableSession, id: string) => {
    const cells = s.directory().get(id)?.cells;
    return { board: cells?.board?.value, position: cells?.position?.value };
  };

  test("moves three selected goblins to Crypt at the same positions in one undoable group, activates Crypt and keeps them selected", async () => {
    const t = await setup(GOBLINS);
    const ids = ["goblin1", "goblin2", "goblin3"];
    const before = ids.map((id) => placeOf(t.session, id).position);
    act(() => t.ui.select(ids));
    const user = userEvent.setup();
    const command = screen.getByRole("button", { name: "Move selection to board…" });
    await waitFor(() => expect(command).toHaveProperty("disabled", false));
    await user.click(command);
    const atClick = t.session.getSnapshot().revision;
    const menu = screen.getByRole("menu", { name: "Move selection to board" });
    expect(within(menu).getByRole("menuitem", { name: "GM" })).toHaveProperty("disabled", true);
    await user.click(within(menu).getByRole("menuitem", { name: "Crypt" }));

    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt"));
    await waitFor(() => expect(activeTab()).toBe("Crypt"));
    expect(t.ui.getState().selection).toEqual(ids);
    for (const [i, id] of ids.entries()) {
      expect(placeOf(t.session, id)).toEqual({
        board: { type: "ref", object: "crypt" },
        position: before[i],
      });
      expect(t.session.boardView()?.objects.has(id)).toBe(true);
    }
    expect(placeOf(t.session, "pc").board).toEqual({ type: "ref", object: "gm_board" });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      base_revision: atClick,
      label: "Move 3 objects to Crypt",
      ops: ids.map((id, i) => ({
        type: "move",
        object: id,
        to: {
          type: "board",
          board: "crypt",
          position: [(i + 1) * 2, i + 1.5],
        },
      })),
    });

    // One group: one undo puts all three back.
    const result = await undo(t.session);
    expect(result.status).toBe("committed");
    await waitFor(() =>
      expect(ids.map((id) => placeOf(t.session, id).board)).toEqual(
        ids.map(() => ({ type: "ref", object: "gm_board" })),
      ),
    );
  });

  test("only objects directly on the active board are moved", async () => {
    const t = await setup([
      ...GOBLINS,
      {
        type: "create_object",
        id: "die",
        to: { type: "container", container: "goblin1" },
      },
    ]);
    act(() => t.ui.select(["goblin1", "die"]));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Move selection to board…" }));
    await user.click(screen.getByRole("menuitem", { name: "Crypt" }));
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt"));
    expect(t.sent[0]).toMatchObject({ label: "Move 1 object to Crypt" });
    expect(t.sent[0]?.ops).toHaveLength(1);
    expect(t.ui.getState().selection).toEqual(["goblin1"]);
  });

  test("disabled without a selection, and for the active board in a tab's context menu", async () => {
    const t = await setup(GOBLINS);
    expect(screen.getByRole("button", { name: "Move selection to board…" })).toHaveProperty(
      "disabled",
      true,
    );
    let menu = await openTabMenu("Crypt");
    expect(within(menu).getByRole("menuitem", { name: "Move selection to Crypt" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.keyboard("{Escape}");

    act(() => t.ui.select(["goblin1"]));
    menu = await openTabMenu("GM");
    expect(within(menu).getByRole("menuitem", { name: "Move selection to GM" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.keyboard("{Escape}");
    expect(t.sent).toEqual([]);
  });

  test("a tab's context menu moves the selection to that board", async () => {
    const t = await setup(GOBLINS);
    act(() => t.ui.select(["goblin2"]));
    const menu = await openTabMenu("Crypt");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Move selection to Crypt" }));
    await waitFor(() => expect(t.session.getSnapshot().activeBoard).toBe("crypt"));
    expect(placeOf(t.session, "goblin2").board).toEqual({ type: "ref", object: "crypt" });
    expect(t.ui.getState().selection).toEqual(["goblin2"]);
    expect(t.sent[0]).toMatchObject({ label: "Move 1 object to Crypt" });
  });
});
