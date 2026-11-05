// @vitest-environment node
/**
 * The log session (vtt-1xv.20; DESIGN.md §4.4, §4.8, §7 Undo; PROTOCOL.md
 * §4 `log`, §7.6, §8 log scope; review r1 finding 12, r3 finding 9) against
 * a real in-process authority: the window, viewer switches without an empty
 * frame, older pages as a chain from a fixed boundary, invalidation and the
 * in-order rebuild, generation-tagged responses.
 */
import {
  type GroupView,
  type LogParams,
  type ProtocolClient,
  ProtocolFailure,
  type WireOp,
} from "@vtt/protocol";
import {
  createLogSession,
  createUiStore,
  type LogSession,
  type LogSnapshot,
  sessionNotices,
  type TableSession,
} from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";
import { whenReady } from "../support/authority";
import {
  ALDRIC,
  ALL,
  at,
  caughtUp,
  cleanupLogAuthorities,
  commit,
  commitMany,
  GM,
  GM_ONLY,
  num,
  PARTY_SEED,
  startLogAuthority,
  text,
  until,
  writers,
} from "./support";

const logs: LogSession[] = [];

afterEach(async () => {
  for (const log of logs.splice(0)) log.close();
  await cleanupLogAuthorities();
});

const indices = (snap: LogSnapshot) => snap.entries.map((e) => e.group.index);
const labels = (snap: LogSnapshot) => snap.entries.map((e) => e.group.label);

function open(session: TableSession): LogSession {
  const log = createLogSession(session);
  logs.push(log);
  return log;
}

async function live(log: LogSession): Promise<void> {
  await until(() => log.getSnapshot().live, "the log window to be live");
}

/** Every group view `viewer` sees, newest first, read page by page with `client`. */
async function allVisible(
  client: ProtocolClient,
  viewer: LogParams["viewer"],
): Promise<GroupView[]> {
  const out: GroupView[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await client.request("log", {
      ...(before === undefined ? {} : { before }),
      limit: 200,
      ...(viewer === undefined ? {} : { viewer }),
    });
    out.push(...page.groups);
    const last = page.groups.at(-1);
    if (page.groups.length < 200 || last === undefined || last.index === page.first_index) {
      return out;
    }
    before = last.index;
  }
}

/** Rebuilds every stale page (what the panel's render does) and waits until settled. */
async function settle(log: LogSession): Promise<void> {
  for (let k = 0; k < 20; k++) {
    for (const page of log.getSnapshot().pages) log.showPage(page.page);
    await log.idle();
    if (log.getSnapshot().pages.every((p) => !p.refreshing)) return;
  }
  throw new Error("the log did not settle");
}

async function setup(seed: WireOp[] = PARTY_SEED) {
  const authority = await startLogAuthority();
  const pool = await writers(authority);
  const gm = pool[0] as ProtocolClient;
  await commit(gm, seed, "Seed");
  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session });
  return { authority, gm, pool, session, ui };
}

describe("the window", () => {
  test("mirrors the log window newest first, with effects", async () => {
    const { gm, session } = await setup();
    await commitMany(gm, 3, "note", "n", "Step");
    await caughtUp(session, gm);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 4, "four groups");
    expect(labels(log.getSnapshot())).toEqual(["Step 2", "Step 1", "Step 0", "Seed"]);
    expect(log.getSnapshot().entries[0]?.group.effects?.length).toBe(1);
    expect(log.getSnapshot().entries.every((e) => e.page === null)).toBe(true);
    await commit(gm, [{ type: "set_value", object: "note", cell: "n", value: num(9) }], "Later");
    await until(() => log.getSnapshot().entries[0]?.group.label === "Later", "the new group");
  });

  test("switching viewer at an unchanged revision replaces the list without an empty frame", async () => {
    const { gm, session, ui } = await setup([
      ...PARTY_SEED,
      {
        type: "create_object",
        id: "vault",
        to: at(9, 9),
        init: {
          cells: { name: text("Vault"), gold: num(0) },
          cell_visibility: { name: GM_ONLY, gold: GM_ONLY },
        },
      },
    ]);
    await commitMany(gm, 2, "note", "n", "Public");
    await commitMany(gm, 2, "vault", "gold", "Secret");
    await caughtUp(session, gm);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 5, "five groups");
    const revision = session.getSnapshot().revision;

    const frames: LogSnapshot[] = [];
    const off = log.subscribe(() => frames.push(log.getSnapshot()));
    await ui.setViewer(ALDRIC);
    await until(() => log.getSnapshot().viewer.type === "character", "the Aldric list");
    off();
    expect(session.getSnapshot().revision).toBe(revision);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame.entries.length).toBeGreaterThan(0);
    // Each frame is wholly one viewer's: the GM's five groups, or Aldric's three.
    for (const frame of frames) {
      if (frame.viewer.type === "gm") expect(frame.entries).toHaveLength(5);
      else expect(labels(frame)).toEqual(["Public 1", "Public 0", null]);
    }
    expect(labels(log.getSnapshot())).toEqual(["Public 1", "Public 0", null]);
  });
});

describe("older pages", () => {
  test("'Load older' after 260 groups pages past the 200 window; the chain stays gap-free as the window slides", async () => {
    const { gm, pool, session } = await setup();
    await commitMany(pool, 260, "note", "n", "Step");
    await caughtUp(session, gm);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 200, "the window");
    const boundary = Math.min(...indices(log.getSnapshot()));

    await log.loadOlder();
    let snap = log.getSnapshot();
    expect(snap.boundary).toBe(boundary);
    expect(snap.entries).toHaveLength(250);
    expect(snap.pages).toEqual([{ page: 1, refreshing: false }]);
    expect(snap.canLoadOlder).toBe(true);
    await log.loadOlder();
    snap = log.getSnapshot();
    expect(snap.entries).toHaveLength(261);
    expect(snap.canLoadOlder).toBe(false);
    const all = indices(snap);
    expect(all).toEqual([...all].sort((a, b) => b - a));
    expect(new Set(all).size).toBe(all.length);
    expect(all.at(-1)).toBe(0);

    // New groups push old ones out of the window: they stay shown (no gap at the boundary).
    await commitMany(gm, 3, "note", "n", "More");
    await caughtUp(session, gm);
    await until(() => log.getSnapshot().entries[0]?.group.label === "More 2", "the new groups");
    const after = indices(log.getSnapshot());
    expect(after).toHaveLength(264);
    expect(after).toEqual(Array.from({ length: 264 }, (_, k) => 263 - k));
  });

  test("as the GM, undoing a group in a loaded page from a second client strikes it through after the rebuild", async () => {
    const { authority, gm, pool, session } = await setup();
    const lonely = await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "mark", value: num(1) }],
      "Lonely",
    );
    await commitMany(pool, 230, "note", "n", "Step");
    await caughtUp(session, gm);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 200, "the window");
    await log.loadOlder();
    const before = log.getSnapshot().entries.find((e) => e.group.index === lonely.index);
    expect(before?.page).toBe(1);
    expect(before?.group.undone).toBe(false);

    const other = await authority.client("other");
    const undone = await other.request("undo", { target: { type: "group", index: lonely.index } });
    expect(undone.status).toBe("committed");
    await caughtUp(session, other);
    await until(() => log.getSnapshot().pages[0]?.refreshing === true, "the chain to be stale");
    // Stale pages keep their content while refreshing.
    expect(log.getSnapshot().entries.some((e) => e.group.index === lonely.index)).toBe(true);
    await settle(log);
    const after = log.getSnapshot().entries.find((e) => e.group.index === lonely.index);
    expect(after?.group.undone).toBe(true);
    expect(after?.page).toBe(1);
  });

  test("as the GM, a commit that undoes nothing in the chain leaves it fresh", async () => {
    const { gm, pool, session } = await setup();
    await commitMany(pool, 210, "note", "n", "Step");
    await caughtUp(session, gm);
    const log = open(session);
    await live(log);
    await log.loadOlder();
    const generation = log.getSnapshot().generation;
    const last = await commit(gm, [
      { type: "set_value", object: "note", cell: "x", value: num(1) },
    ]);
    await gm.request("undo", { target: { type: "group", index: last.index } });
    await caughtUp(session, gm);
    await until(
      () => log.getSnapshot().entries.some((e) => e.group.index === last.index && e.group.undone),
      "the window to show the undo",
    );
    expect(log.getSnapshot().generation).toBe(generation);
    expect(log.getSnapshot().pages.every((p) => !p.refreshing)).toBe(true);
  });

  test("as Aldric, hiding an object whose effects appear only in loaded pages removes them after the rebuild", async () => {
    const { gm, pool, session, ui } = await setup([
      ...PARTY_SEED,
      {
        type: "create_object",
        id: "torch",
        to: at(4, 0),
        init: { cells: { name: text("Torch") } },
      },
    ]);
    await commitMany(gm, 30, "torch", "lit", "Torch");
    await commitMany(pool, 250, "note", "n", "Note");
    await caughtUp(session, gm);
    await ui.setViewer(ALDRIC);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 200, "the window");
    await log.loadOlder();
    await log.loadOlder();
    const torchCount = () =>
      log.getSnapshot().entries.filter((e) => e.group.label?.startsWith("Torch") === true).length;
    expect(torchCount()).toBe(30);

    await commit(
      gm,
      [{ type: "set_value", object: "torch", cell: "visible_to", value: GM_ONLY }],
      "Hide",
    );
    await caughtUp(session, gm);
    await until(() => log.getSnapshot().pages.some((p) => p.refreshing), "the chain to be stale");
    await settle(log);
    expect(torchCount()).toBe(0);
    const expected = await allVisible(gm, ALDRIC);
    expect(indices(log.getSnapshot())).toEqual(expected.map((g) => g.index));
  });

  test("as Aldric, revealing groups that cross a page boundary yields a gap-free chain", async () => {
    const { gm, pool, session, ui } = await setup([
      ...PARTY_SEED,
      {
        type: "create_object",
        id: "torch",
        to: at(4, 0),
        init: { cells: { name: text("Torch"), visible_to: GM_ONLY } },
      },
    ]);
    // Interleaved below the window: 40 public groups and 40 hidden ones.
    for (let k = 0; k < 40; k++) {
      await commit(
        gm,
        [{ type: "set_value", object: "note", cell: "n", value: num(k) }],
        `Note ${k}`,
      );
      await commit(
        gm,
        [{ type: "set_value", object: "torch", cell: "lit", value: num(k) }],
        `Torch ${k}`,
      );
    }
    await commitMany(pool, 200, "note", "m", "Window");
    await caughtUp(session, gm);
    await ui.setViewer(ALDRIC);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 200, "the window");
    const boundary = Math.min(...indices(log.getSnapshot()));
    await log.loadOlder();
    // 40 public groups and the seed: one short page, the end of the chain.
    expect(log.getSnapshot().pages).toHaveLength(1);
    expect(log.getSnapshot().canLoadOlder).toBe(false);

    await commit(
      gm,
      [{ type: "set_value", object: "torch", cell: "visible_to", value: ALL }],
      "Reveal",
    );
    await caughtUp(session, gm);
    await until(() => log.getSnapshot().pages.some((p) => p.refreshing), "the chain to be stale");
    await settle(log);
    while (log.getSnapshot().canLoadOlder) await log.loadOlder();
    const snap = log.getSnapshot();
    expect(snap.boundary).toBe(boundary);
    expect(snap.pages.length).toBeGreaterThanOrEqual(2);
    const shown = indices(snap);
    const expected = (await allVisible(gm, ALDRIC)).map((g) => g.index);
    expect(shown).toEqual(expected);
    // Every visible group below the boundary appears once, in order.
    const below = shown.filter((i) => i < boundary);
    expect(below).toEqual(expected.filter((i) => i < boundary));
    expect(below.length).toBe(81);
  });

  test("as Aldric with a window that shows no groups, 'Load older' still reaches older visible groups", async () => {
    const { gm, pool, session, ui } = await setup([
      ...PARTY_SEED,
      {
        type: "create_object",
        id: "vault",
        to: at(9, 9),
        init: {
          cells: { name: text("Vault"), gold: num(0) },
          cell_visibility: { name: GM_ONLY, gold: GM_ONLY },
        },
      },
    ]);
    await commitMany(gm, 10, "note", "n", "Public");
    await commitMany(pool, 210, "vault", "gold", "Secret");
    await caughtUp(session, gm);
    await ui.setViewer(ALDRIC);
    const log = open(session);
    await live(log);
    expect(log.getSnapshot().entries).toEqual([]);
    expect(log.getSnapshot().canLoadOlder).toBe(true);
    await log.loadOlder();
    const snap = log.getSnapshot();
    // The next index (221): paging starts from the newest group.
    expect(snap.boundary).toBe(221);
    expect(snap.entries.map((e) => e.group.label)).toEqual([
      ...Array.from({ length: 10 }, (_, k) => `Public ${9 - k}`),
      null,
    ]);
    expect(snap.canLoadOlder).toBe(false);
  });

  test("as Aldric, a chain emptied by a hide is rebuilt complete by the reveal", async () => {
    const authority = await startLogAuthority();
    const pool = await writers(authority);
    const gm = pool[0] as ProtocolClient;
    // Indices 0..9 touch only the torch; Aldric and the note are created at 10.
    await commit(
      gm,
      [
        {
          type: "create_object",
          id: "torch",
          to: at(4, 0),
          init: { cells: { name: text("Torch") } },
        },
      ],
      "Torch",
    );
    await commitMany(pool, 9, "torch", "lit", "Lit");
    await commit(gm, PARTY_SEED, "Seed");
    await commitMany(pool, 195, "note", "n", "Note");
    const session = authority.session();
    await whenReady(session);
    await caughtUp(session, gm);
    const ui = createUiStore({ session });
    await ui.setViewer(ALDRIC);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 200, "the window");
    await log.loadOlder();
    expect(indices(log.getSnapshot()).slice(-6)).toEqual([5, 4, 3, 2, 1, 0]);

    // Hide: every group below the boundary becomes invisible; the chain is empty.
    await commit(
      gm,
      [{ type: "set_value", object: "torch", cell: "visible_to", value: GM_ONLY }],
      "Hide",
    );
    await caughtUp(session, gm);
    await settle(log);
    expect(indices(log.getSnapshot()).filter((i) => i < 10)).toEqual([]);
    expect(log.getSnapshot().canLoadOlder).toBe(false);

    // Reveal: the empty end of the chain is rechecked.
    await commit(
      gm,
      [{ type: "set_value", object: "torch", cell: "visible_to", value: ALL }],
      "Reveal",
    );
    await caughtUp(session, gm);
    await settle(log);
    while (log.getSnapshot().canLoadOlder) await log.loadOlder();
    const shown = indices(log.getSnapshot());
    expect(shown).toEqual((await allVisible(gm, ALDRIC)).map((g) => g.index));
    expect(shown.slice(-10)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("an emptied chain is rechecked by 'Load older' too", async () => {
    const { gm, pool, session, ui } = await setup([
      ...PARTY_SEED,
      {
        type: "create_object",
        id: "torch",
        to: at(4, 0),
        init: { cells: { name: text("Torch") } },
      },
    ]);
    await commitMany(pool, 210, "note", "n", "Note");
    await caughtUp(session, gm);
    await ui.setViewer(ALDRIC);
    const log = open(session);
    await live(log);
    await log.loadOlder();
    await log.loadOlder();
    expect(log.getSnapshot().canLoadOlder).toBe(false);
    // Hiding the note empties nothing below the seed, but a rebuild that yields an
    // empty page must stay a stale-able end: hide everything, reveal, load older.
    await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "visible_to", value: GM_ONLY }],
      "Hide",
    );
    await commit(
      gm,
      [{ type: "set_value", object: "aldric", cell: "visible_to", value: GM_ONLY }],
      "Hide me",
    );
    await caughtUp(session, gm);
    await settle(log);
    await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "visible_to", value: ALL }],
      "Show",
    );
    await commit(
      gm,
      [{ type: "set_value", object: "aldric", cell: "visible_to", value: ALL }],
      "Show me",
    );
    await caughtUp(session, gm);
    while (log.getSnapshot().canLoadOlder || log.getSnapshot().pages.some((p) => p.refreshing)) {
      await log.loadOlder();
    }
    const shown = indices(log.getSnapshot());
    expect(shown).toEqual((await allVisible(gm, ALDRIC)).map((g) => g.index));
    expect(shown.at(-1)).toBe(0);
  });

  test("a response from a superseded generation is dropped", async () => {
    const { gm, pool, session, ui } = await setup([
      ...PARTY_SEED,
      {
        type: "create_object",
        id: "torch",
        to: at(4, 0),
        init: { cells: { name: text("Torch") } },
      },
    ]);
    await commitMany(gm, 30, "torch", "lit", "Torch");
    await commitMany(pool, 230, "note", "n", "Note");
    await caughtUp(session, gm);
    await ui.setViewer(ALDRIC);
    const log = open(session);
    await live(log);
    await until(() => log.getSnapshot().entries.length === 200, "the window");

    // Hold every `log` response until released.
    const held: (() => void)[] = [];
    let holding = true;
    const client = session.client;
    const original = client.request.bind(client);
    client.request = (async (method: string, params: unknown) => {
      const result = await (original as (m: string, p: unknown) => Promise<unknown>)(
        method,
        params,
      );
      if (method === "log" && holding) await new Promise<void>((resolve) => held.push(resolve));
      return result;
    }) as typeof client.request;

    const loading = log.loadOlder();
    await until(() => held.length === 1, "the first page request");
    const generation = log.getSnapshot().generation;
    await commit(
      gm,
      [{ type: "set_value", object: "torch", cell: "visible_to", value: GM_ONLY }],
      "Hide",
    );
    await caughtUp(session, gm);
    await until(() => log.getSnapshot().generation > generation, "a new generation");
    held.shift()?.();
    await until(() => held.length === 1, "the request of the new generation");
    // The superseded page (which held Torch groups) was not applied.
    expect(log.getSnapshot().entries.filter((e) => e.page !== null)).toEqual([]);
    holding = false;
    for (const release of held.splice(0)) release();
    await loading;
    await log.idle();
    const older = log.getSnapshot().entries.filter((e) => e.page !== null);
    expect(older.length).toBeGreaterThan(0);
    expect(older.some((e) => e.group.label?.startsWith("Torch") === true)).toBe(false);
  });
});

describe("viewers and subscriptions", () => {
  test("a viewer change drops older pages", async () => {
    const { gm, pool, session, ui } = await setup();
    await commitMany(pool, 210, "note", "n", "Step");
    await caughtUp(session, gm);
    const log = open(session);
    await live(log);
    await log.loadOlder();
    expect(log.getSnapshot().pages).toHaveLength(1);
    await ui.setViewer(ALDRIC);
    await until(() => log.getSnapshot().viewer.type === "character", "the Aldric list");
    expect(log.getSnapshot().pages).toEqual([]);
    expect(log.getSnapshot().boundary).toBeNull();
    expect(log.getSnapshot().entries.every((e) => e.page === null)).toBe(true);
    await ui.setViewer(GM);
    await until(() => log.getSnapshot().viewer.type === "gm", "the GM list");
  });

  test("a refused window subscription is a connection notice", async () => {
    const { session } = await setup();
    const client = session.client;
    const original = client.subscribe.bind(client);
    client.subscribe = ((params) =>
      params.scope.type === "log"
        ? Promise.reject(new ProtocolFailure("busy", "too many subscriptions"))
        : original(params)) as typeof client.subscribe;
    const log = open(session);
    await log.idle();
    expect(log.getSnapshot().live).toBe(false);
    expect(
      sessionNotices(session)
        .list()
        .map((n) => n.text),
    ).toEqual([
      "The log could not be updated. The table is busy; try again in a moment (too many subscriptions).",
    ]);
  });

  test("close unsubscribes and stops updating", async () => {
    const { gm, session } = await setup();
    const log = open(session);
    await live(log);
    log.close();
    expect(log.getSnapshot().live).toBe(false);
    await commit(gm, [{ type: "set_value", object: "note", cell: "n", value: num(1) }]);
    await caughtUp(session, gm);
    expect(session.client.liveSubscriptions().some((s) => s.params.scope.type === "log")).toBe(
      false,
    );
  });
});
