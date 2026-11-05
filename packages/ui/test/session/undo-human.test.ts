// @vitest-environment node
/**
 * Ctrl+Z's `undo(session)` targets `human` (vtt-nb8.3; DESIGN.md §7 Undo;
 * PROTOCOL.md §6; M6-D2) against a real in-process authority: it reverses a
 * button the GM pressed as a character from the same session, and never a
 * newer group of an agent.
 */
import type { WireOp } from "@vtt/protocol";
import { bindNotices, createNoticeStore, type NoticeStore, type TableSession, undo } from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  startAuthority,
  type TestAuthority,
  whenReady,
} from "../support/authority";

afterEach(cleanupAuthorities);

const num = (value: number) => ({ type: "number" as const, value });

const setup: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: { type: "board", board: "gm_board", position: [0, 0] },
    init: { is_character: true, cells: { hp: num(10) } },
  },
  {
    type: "create_object",
    id: "lever",
    to: { type: "board", board: "gm_board", position: [2, 0] },
    init: {
      cells: { pulls: num(0) },
      actions: [{ name: "Pull", steps: ["add(pulls, 1)"] }],
    },
  },
];

interface World {
  authority: TestAuthority;
  session: TableSession;
  notices: NoticeStore;
}

/** An authority whose agent `Seed` created `aldric` and `lever`, and a ready session. */
async function world(): Promise<World> {
  const authority = await startAuthority();
  const seed = await authority.client("Seed", { kind: "agent" });
  await seed.transact(setup, { label: "Seed" });
  const session = authority.session();
  const notices = createNoticeStore();
  bindNotices(session, notices);
  await whenReady(session);
  await session.whenRevision(1);
  return { authority, session, notices };
}

const pullsOf = (session: TableSession) => session.objectView("lever")?.cells.pulls?.value;

/** The session presses Pull on `lever` as Aldric (view-as). */
async function pullAsAldric(session: TableSession) {
  const r = await session.client.invoke({
    object: "lever",
    action: "Pull",
    base_revision: session.getSnapshot().revision,
    actor: { type: "character", id: "aldric" },
    label: "Aldric pulls",
  });
  expect(r.status, JSON.stringify(r)).toBe("committed");
  if (r.status !== "committed") throw new Error("unreachable");
  return r;
}

describe("undo(session) targets human", () => {
  test("sends target human", async () => {
    const { session } = await world();
    await pullAsAldric(session);
    const request = vi.spyOn(session.client, "request");
    await undo(session);
    expect(request.mock.calls.find(([m]) => m === "undo")?.[1]).toEqual({
      target: { type: "human" },
    });
  });

  test("reverses a character-actor invoke made by the same session", async () => {
    const { authority, session, notices } = await world();
    const pull = await pullAsAldric(session);
    await session.whenRevision(pull.revision);
    expect(pullsOf(session)).toEqual(num(1));
    const outcome = await undo(session);
    expect(outcome.status).toBe("committed");
    if (outcome.status !== "committed") throw new Error("unreachable");
    expect(authority.host.table.store.history.get(outcome.index)?.undoes).toBe(pull.index);
    await session.whenRevision(outcome.revision);
    expect(pullsOf(session)).toEqual(num(0));
    expect(notices.list()).toEqual([
      expect.objectContaining({ level: "success", text: "Undid: Aldric pulls" }),
    ]);
  });

  test("leaves a newer agent group and reverses the invoke before it", async () => {
    const { authority, session, notices } = await world();
    const pull = await pullAsAldric(session);
    const scribe = await authority.client("Scribe", { kind: "agent" });
    const note = await scribe.transact(
      [
        {
          type: "create_object",
          id: "note",
          to: { type: "board", board: "gm_board", position: [4, 0] },
          init: { cells: { n: num(3) } },
        },
      ],
      { label: "Scribe creates note" },
    );
    expect(note.status).toBe("committed");
    if (note.status !== "committed") throw new Error("unreachable");
    await session.whenRevision(note.revision);

    const outcome = await undo(session);
    expect(outcome.status).toBe("committed");
    if (outcome.status !== "committed") throw new Error("unreachable");
    const history = authority.host.table.store.history;
    expect(history.get(outcome.index)?.undoes).toBe(pull.index);
    expect(history.isUndone(note.index)).toBe(false);
    await session.whenRevision(outcome.revision);
    expect(pullsOf(session)).toEqual(num(0));
    expect(session.objectView("note")?.cells.n?.value).toEqual(num(3));
    expect(notices.list().map((n) => n.text)).toEqual(["Undid: Aldric pulls"]);
  });
});
