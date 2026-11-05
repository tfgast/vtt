/**
 * React bindings (vtt-3l6.21): `useSession`, `useUi` and `useNotices` over
 * `useSyncExternalStore`, in jsdom, against a real in-process authority
 * through the shared helper (which injects the `ws` client).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createUiStore,
  sessionNotices,
  TableProvider,
  type TableSession,
  type UiStore,
  useNoticeStore,
  useNotices,
  useSaveStatus,
  useSession,
  useTableSession,
  useUi,
} from "@vtt/ui";
import { afterEach, expect, test } from "vitest";
import { cleanupAuthorities, startAuthority, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

function Revision() {
  const revision = useSession((s) => s.revision);
  return <p data-testid="revision">revision {revision}</p>;
}

function TokenName({ id }: { id: string }) {
  const session = useTableSession();
  useSession((s) => s.viewVersion);
  const name = session.objectView(id)?.cells.name?.value;
  return <p data-testid="name">{name?.type === "text" ? name.value : "none"}</p>;
}

function Hover() {
  const hover = useUi((s) => s.hover);
  return <p data-testid="hover">{hover ?? "nothing"}</p>;
}

function Notices() {
  const notices = useNotices();
  const store = useNoticeStore();
  return (
    <ul>
      {notices.map((n) => (
        <li key={n.id}>
          {n.text}
          <button type="button" onClick={() => store.dismiss(n.id)}>
            Dismiss {n.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SaveStatus() {
  const status = useSaveStatus();
  return <p data-testid="save">{status?.status ?? "never"}</p>;
}

function Shell({ session, ui }: { session: TableSession; ui: UiStore }) {
  return (
    <TableProvider session={session} ui={ui}>
      <Revision />
      <TokenName id="t1" />
      <Hover />
      <Notices />
      <SaveStatus />
    </TableProvider>
  );
}

test("components re-render on a commit, a UI change and a notice", async () => {
  const authority = await startAuthority();
  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session });
  render(<Shell session={session} ui={ui} />);
  expect(screen.getByTestId("revision").textContent).toBe("revision 0");
  expect(screen.getByTestId("name").textContent).toBe("none");
  expect(screen.getByTestId("hover").textContent).toBe("nothing");
  expect(screen.getByTestId("save").textContent).toBe("never");

  // A commit by another client.
  const other = await authority.client("other");
  await other.transact([
    {
      type: "create_object",
      id: "t1",
      to: { type: "board", board: "gm_board", position: [0, 0] },
      init: { cells: { name: { type: "text", value: "Goblin" } } },
    },
  ]);
  await screen.findByText("revision 1");
  expect(screen.getByTestId("name").textContent).toBe("Goblin");

  // A UI change.
  act(() => ui.setHover("t1"));
  expect(screen.getByTestId("hover").textContent).toBe("t1");

  // A notice, then its dismissal.
  act(() => {
    sessionNotices(session).push({ level: "error", text: "Something failed" });
  });
  expect(screen.getByText("Something failed")).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss Something failed" }));
  expect(screen.queryByText("Something failed")).toBeNull();
});

test("the save status re-renders when a save event arrives", async () => {
  const authority = await startAuthority({ file: true });
  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session });
  render(<Shell session={session} ui={ui} />);
  const other = await authority.client("other");
  await other.request("save", {});
  await screen.findByText("saved");
});

test("hooks outside a TableProvider throw", () => {
  const quiet = console.error;
  console.error = () => undefined;
  try {
    expect(() => render(<Revision />)).toThrow(/TableProvider/);
  } finally {
    console.error = quiet;
  }
});
