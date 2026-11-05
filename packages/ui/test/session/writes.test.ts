// @vitest-environment node
/**
 * The UI's writes against a real in-process authority (vtt-3l6.21; DESIGN.md
 * §7 Undo, §5.2; PROTOCOL.md §6; M4-D7; review r1 finding 1): `baseRevision`
 * is sent unchanged, stale writes are shown and never rebased, uncertain
 * outcomes are sticky notices, undo targets `mine`, save is tracked.
 */
import type { Timers, WireOp } from "@vtt/protocol";
import {
  bindNotices,
  createNoticeStore,
  createWritePort,
  NOTICE_EXPIRY_MS,
  type NoticeStore,
  save,
  sessionNotices,
  sessionSaves,
  type TableSession,
  undo,
  type WriteOutcome,
  type WritePort,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  nodeWebSocket,
  startAuthority,
  type TestAuthority,
  until,
  whenReady,
} from "../support/authority";

afterEach(cleanupAuthorities);

const num = (value: number) => ({ type: "number" as const, value });

const create = (id: string, hp = 1): WireOp => ({
  type: "create_object",
  id,
  to: { type: "board", board: "gm_board", position: [0, 0] },
  init: { cells: { name: { type: "text", value: id }, hp: num(hp) } },
});

const setHp = (object: string, hp: number): WireOp => ({
  type: "set_value",
  object,
  cell: "hp",
  value: num(hp),
});

/** A manual clock implementing `Timers`. */
function manualClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn: () => void, ms: number) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  } satisfies Timers & { advance(ms: number): void };
}

const hpOf = (session: TableSession, id: string) => session.objectView(id)?.cells.hp?.value;

interface Setup {
  authority: TestAuthority;
  session: TableSession;
  port: WritePort;
  notices: NoticeStore;
  clock: ReturnType<typeof manualClock>;
}

/** An authority with `t1` (hp 1), a ready session with a manual-clock notice store, and its write port. */
async function setup(options: { file?: boolean } = {}): Promise<Setup> {
  const authority = await startAuthority(options);
  // An agent, so the seed is not the GM's to undo.
  const seed = await authority.client("seed", { kind: "agent" });
  await seed.transact([create("t1")], { label: "Seed" });
  const session = authority.session();
  const clock = manualClock();
  const notices = createNoticeStore({ timers: clock });
  bindNotices(session, notices);
  await whenReady(session);
  await session.whenRevision(1);
  return { authority, session, port: createWritePort(session), notices, clock };
}

describe("baseRevision", () => {
  test("a write carries exactly the given baseRevision, also when the session is ahead", async () => {
    const { authority, session, port } = await setup();
    const other = await authority.client("other");
    await other.transact([create("t2")], { label: "Second" });
    await other.transact([create("t3")], { label: "Third" });
    await session.whenRevision(3);
    const request = vi.spyOn(session.client, "request");
    const outcome = await port.write([setHp("t1", 4)], { baseRevision: 1, label: "Disjoint" });
    expect(outcome.status).toBe("committed");
    const sent = request.mock.calls.filter(([method]) => method === "transact");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toMatchObject({ base_revision: 1, label: "Disjoint" });
    // The session never substituted its latest revision.
    expect(session.getSnapshot().revision).toBe(4);
  });

  test("a write with the current revision commits and pushes no notice", async () => {
    const { session, port, notices } = await setup();
    const r = session.getSnapshot().revision;
    const outcome = await port.write([setHp("t1", 6)], { baseRevision: r, label: "Set hp" });
    expect(outcome).toMatchObject({ status: "committed", revision: r + 1 });
    await session.whenRevision(r + 1);
    expect(hpOf(session, "t1")).toEqual(num(6));
    expect(notices.list()).toEqual([]);
  });

  test("review r1 finding 1: an edit begun before a concurrent commit is rejected stale_write", async () => {
    const { authority, session, port, notices } = await setup();
    // The edit begins at revision r.
    const r = session.getSnapshot().revision;
    // A second client writes the same cell, and the session processes that commit.
    const scribe = await authority.client("Scribe", { kind: "agent" });
    await scribe.transact([setHp("t1", 5)], { label: "Scribe sets hp" });
    await session.whenRevision(r + 1);
    expect(hpOf(session, "t1")).toEqual(num(5));
    // The session then submits with the revision the edit began on.
    const request = vi.spyOn(session.client, "request");
    const outcome = await port.write([setHp("t1", 9)], { baseRevision: r, label: "GM sets hp" });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.rejection.type).toBe("stale_write");
    // Never retried or rebased.
    expect(request.mock.calls.filter(([m]) => m === "transact")).toHaveLength(1);
    // The notice names the second client's group and actor.
    const list = notices.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ level: "warning", kind: "stale" });
    expect(list[0]?.text).toContain("Scribe sets hp");
    expect(list[0]?.text).toContain("agent Scribe");
    // The second client's value is unchanged.
    expect(hpOf(session, "t1")).toEqual(num(5));
    const view = await scribe.request("get_objects", { ids: ["t1"] });
    expect(view.objects[0]?.cells.hp?.value).toEqual(num(5));
  });

  test("a non-stale rejection pushes the described rejection as an error", async () => {
    const { session, port, notices } = await setup();
    const outcome = await port.write(
      [{ type: "set_value", object: "t1", cell: "is_zone", value: num(3) }],
      { baseRevision: session.getSnapshot().revision, label: "Bad" },
    );
    expect(outcome.status).toBe("rejected");
    expect(notices.list()).toHaveLength(1);
    expect(notices.list()[0]?.level).toBe("error");
    expect(notices.list()[0]?.kind).toBeUndefined();
  });
});

describe("uncertain", () => {
  test("a write lost with the server and answered by a new session is a sticky uncertain notice", async () => {
    const authority = await startAuthority();
    const seed = await authority.client("seed");
    await seed.transact([create("t1")], { label: "Seed" });
    let armed = false;
    let transacts = 0;
    const session = authority.session({
      WebSocket: nodeWebSocket((data) => {
        const frame = JSON.parse(data) as { method?: string };
        if (frame.method !== "transact") return true;
        transacts++;
        if (!armed) return true;
        armed = false;
        // The server drops after the send (never written here), then comes back as a new session.
        void authority.restart();
        return false;
      }),
    });
    const clock = manualClock();
    const notices = createNoticeStore({ timers: clock });
    bindNotices(session, notices);
    await whenReady(session);
    await session.whenRevision(1);
    const port = createWritePort(session);
    armed = true;
    const outcome: WriteOutcome = await port.write([setHp("t1", 2)], {
      baseRevision: session.getSnapshot().revision,
      label: "Lost edit",
    });
    expect(outcome.status).toBe("uncertain");
    if (outcome.status !== "uncertain") throw new Error("unreachable");
    expect(outcome.reason).not.toBe("");
    // Never resent: the session changed before the resend.
    expect(transacts).toBe(1);
    const list = notices.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "uncertain" });
    expect(list[0]?.text).toContain("may or may not have been applied: Lost edit");
    clock.advance(10 * NOTICE_EXPIRY_MS);
    expect(notices.list()).toHaveLength(1);
  });

  test("a write that is never sent fails with a notice", async () => {
    const authority = await startAuthority();
    const session = authority.session();
    const notices = createNoticeStore({ timers: manualClock() });
    bindNotices(session, notices);
    await whenReady(session);
    session.close();
    const outcome = await createWritePort(session).write([setHp("t1", 2)], {
      baseRevision: 0,
      label: "Closed",
    });
    expect(outcome.status).toBe("failed");
    expect(notices.list()).toHaveLength(1);
    expect(notices.list()[0]?.level).toBe("error");
  });
});

describe("undo", () => {
  test("undoes the session's own group and not a newer group of another client", async () => {
    const { authority, session, port, notices } = await setup();
    await port.write([setHp("t1", 2)], {
      baseRevision: session.getSnapshot().revision,
      label: "GM sets hp",
    });
    const scribe = await authority.client("Scribe", { kind: "agent" });
    await scribe.transact([create("t2", 7)], { label: "Scribe creates t2" });
    await session.whenRevision(3);
    const outcome = await undo(session);
    expect(outcome.status).toBe("committed");
    await session.whenRevision(4);
    expect(hpOf(session, "t1")).toEqual(num(1));
    expect(hpOf(session, "t2")).toEqual(num(7));
    const list = notices.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ level: "success", text: "Undid: GM sets hp" });
  });

  test("sends target mine", async () => {
    const { session, port } = await setup();
    await port.write([setHp("t1", 2)], { baseRevision: 1, label: "Edit" });
    const request = vi.spyOn(session.client, "request");
    await undo(session);
    expect(request.mock.calls.find(([m]) => m === "undo")?.[1]).toEqual({
      target: { type: "mine" },
    });
  });

  test("a refused undo pushes the undo_conflict message", async () => {
    const { authority, session, port, notices } = await setup();
    await port.write([setHp("t1", 2)], { baseRevision: 1, label: "GM sets hp" });
    const scribe = await authority.client("Scribe", { kind: "agent" });
    await scribe.transact([setHp("t1", 3)], { label: "Scribe sets hp" });
    await session.whenRevision(3);
    const outcome = await undo(session);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.rejection.type).toBe("undo_conflict");
    const list = notices.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.level).toBe("error");
    expect(list[0]?.text).toMatch(/^Cannot undo #\d+: later edits #\d+ conflict/);
    expect(hpOf(session, "t1")).toEqual(num(3));
  });

  test("with nothing to undo the refusal is a notice", async () => {
    const { session, notices } = await setup();
    const outcome = await undo(session);
    expect(outcome.status).toBe("rejected");
    expect(notices.list().map((n) => n.text)).toEqual(["There is nothing to undo."]);
  });
});

describe("save", () => {
  test("save on a file-backed host is tracked as saved at the session's revision", async () => {
    const { session, port } = await setup({ file: true });
    await port.write([setHp("t1", 3)], { baseRevision: 1, label: "Edit" });
    await session.whenRevision(2);
    const tracker = sessionSaves(session);
    const seen: (string | undefined)[] = [];
    tracker.subscribe(() => seen.push(tracker.get()?.status));
    const result = await save(session);
    expect(result).toMatchObject({ status: "saved", revision: 2 });
    expect(tracker.get()).toMatchObject({ status: "saved", revision: 2 });
    expect(seen[0]).toBe("saving");
    expect(seen.at(-1)).toBe("saved");
  });

  test("a failed save (no file) is tracked and pushes an error notice", async () => {
    const { session, notices } = await setup();
    const result = await save(session);
    expect(result.status).toBe("failed");
    expect(sessionSaves(session).get()).toMatchObject({ status: "failed", revision: 1 });
    await until(() => notices.list().length > 0, "the save notice");
    expect(notices.list()).toHaveLength(1);
    expect(notices.list()[0]).toMatchObject({ level: "error" });
    expect(notices.list()[0]?.text).toContain("no file");
  });

  test("save events from other clients are tracked too", async () => {
    const { authority, session } = await setup({ file: true });
    const tracker = sessionSaves(session);
    const other = await authority.client("other");
    await other.request("save", {});
    await until(() => tracker.get()?.status === "saved", "the save event");
    expect(tracker.get()).toMatchObject({ status: "saved", revision: 1 });
  });
});

describe("connection notices", () => {
  test("a connection notice from the session becomes an error notice", async () => {
    const { session, notices } = await setup();
    // Directory + board view + 14 batches fill max_subscriptions; the 15th batch is refused.
    const ids = Array.from({ length: 15 * 200 }, (_, i) => `ghost_${i}`);
    await session.watchObjects(ids);
    await until(() => notices.list().length > 0, "the connection notice");
    expect(notices.list()).toHaveLength(1);
    expect(notices.list()[0]?.level).toBe("error");
    expect(notices.list()[0]?.text).toContain("could not be updated");
  });

  test("sessionNotices returns the bound store, else one store per session", async () => {
    const authority = await startAuthority();
    const a = authority.session();
    const b = authority.session();
    expect(sessionNotices(a)).toBe(sessionNotices(a));
    expect(sessionNotices(a)).not.toBe(sessionNotices(b));
    const store = createNoticeStore();
    bindNotices(b, store);
    expect(sessionNotices(b)).toBe(store);
  });
});
