/**
 * The log panel (vtt-1xv.20; DESIGN.md §4.8, §4.4, §7 Undo, §8.4 step 14;
 * PROTOCOL.md §4 `undo` group target, §7.6) in jsdom against a real
 * in-process authority: sentences of an Attack card's actions invoked with
 * scripted dice, per-group undo (an agent's group too), conflicts as
 * notices, the character filter, "Load older", links and filters.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProtocolClient } from "@vtt/protocol";
import {
  createUiStore,
  defaultFacePolicy,
  type ExtensionContext,
  type InteractionStamp,
  invokeExtension,
  LogPanel,
  requestInvoke,
  sessionNotices,
  type TableSession,
  type UiStore,
  undo,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { whenReady } from "../support/authority";
import {
  ALDRIC,
  ATTACK_SEED,
  at,
  caughtUp,
  cleanupLogAuthorities,
  commit,
  commitMany,
  GM_ONLY,
  num,
  PARTY_SEED,
  roll,
  startLogAuthority,
  text,
  until,
  writers,
} from "./support";

afterEach(async () => {
  cleanup();
  await cleanupLogAuthorities();
});

/** The group items, newest first. */
const groupItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-log-index]"));

const item = (header: string): HTMLElement => {
  const found = groupItems().find((el) => el.getAttribute("aria-label") === header);
  if (found === undefined) throw new Error(`no log group "${header}"`);
  return found;
};

const sentencesOf = (el: HTMLElement) =>
  within(el)
    .queryAllByRole("button", { name: /.*/ })
    .filter((b) => b.dataset.logSentence !== undefined)
    .map((b) => b.textContent);

const notices = (session: TableSession) =>
  sessionNotices(session)
    .list()
    .map((n) => n.text);

async function mount(session: TableSession, ui?: UiStore) {
  const store = ui ?? createUiStore({ session });
  render(<LogPanel session={session} ui={store} />);
  await until(() => document.querySelector("[data-log-live]") !== null, "the log panel");
  return store;
}

async function setup(seed = PARTY_SEED, dice: Parameters<typeof startLogAuthority>[0] = []) {
  const authority = await startLogAuthority(dice);
  const pool = await writers(authority);
  const gm = pool[0] as ProtocolClient;
  await commit(gm, seed, "Seed");
  const session = authority.session();
  await whenReady(session);
  return { authority, gm, pool, session };
}

async function invoke(client: ProtocolClient, action: string) {
  const result = await client.invoke({
    object: "attack",
    action,
    base_revision: client.revision,
  });
  if (result.status !== "committed") throw new Error(JSON.stringify(result));
  return result;
}

describe("the Attack card", () => {
  test("Apply is one group of two writes; the roll belongs to Roll damage; undoing Apply restores and strikes it", async () => {
    const { gm, session } = await setup(ATTACK_SEED, [
      roll("1d20", [12], 12),
      roll("1d8+3", [5], 8),
    ]);
    await invoke(session.client, "Roll");
    await invoke(session.client, "Roll damage");
    await invoke(session.client, "Apply");
    await caughtUp(session, gm);
    await mount(session);
    await until(() => groupItems().length === 4, "four groups");

    expect(groupItems().map((el) => el.getAttribute("aria-label"))).toEqual([
      "GM: Apply",
      "GM: Roll damage",
      "GM: Roll",
      "GM: Seed",
    ]);
    expect(sentencesOf(item("GM: Apply"))).toEqual([
      "Set Goblin.damage_taken to 8 (was 0)",
      "Set Attack.applied to true (was false)",
    ]);
    expect(sentencesOf(item("GM: Roll damage"))).toEqual(["Rolled 1d8+3 → 8 into Attack.dmg"]);
    expect(sentencesOf(item("GM: Roll"))).toEqual(["Rolled 1d20 → 12 into Attack.roll"]);

    const user = userEvent.setup();
    await user.click(within(item("GM: Apply")).getByRole("button", { name: "Undo GM: Apply" }));
    await until(() => item("GM: Apply").dataset.undone === "true", "Apply struck through");
    expect(item("GM: Apply").querySelector("s")?.textContent).toBe("GM: Apply");
    const goblin = await session.client.request("get_objects", { ids: ["goblin"] });
    expect(goblin.objects[0]?.cells.damage_taken?.value).toEqual({ type: "number", value: 0 });
    // The undo group itself has no Undo button; undone groups neither.
    expect(within(item("GM: Apply")).queryByRole("button", { name: /^Undo/ })).toBeNull();
    const undoGroup = groupItems()[0] as HTMLElement;
    expect(undoGroup.dataset.kind).toBe("undo");
    expect(within(undoGroup).queryByRole("button", { name: /^Undo/ })).toBeNull();
  });
});

describe("a character actor", () => {
  test("groups the GM drove as Aldric name him though they touch only other objects", async () => {
    const asAldric = { type: "character", id: "aldric" } as const;
    const { gm, session } = await setup(ATTACK_SEED, [roll("1d20", [12], 12)]);
    const r = await session.client.invoke({
      object: "attack",
      action: "Roll",
      base_revision: session.client.revision,
      actor: asAldric,
    });
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    const t = await session.client.transact(
      [{ type: "set_value", object: "goblin", cell: "damage_taken", value: num(3) }],
      { label: "Hurt", actor: asAldric },
    );
    if (t.status !== "committed") throw new Error(JSON.stringify(t));
    // A later rename does not change the names the log captured.
    await commit(
      gm,
      [{ type: "set_value", object: "aldric", cell: "name", value: text("Sir Aldric") }],
      "Rename",
    );
    await caughtUp(session, gm);
    await mount(session);
    await until(() => groupItems().length === 4, "four groups");
    expect(groupItems().map((el) => el.getAttribute("aria-label"))).toEqual([
      "GM: Rename",
      "Aldric: Hurt",
      "Aldric: Roll",
      "GM: Seed",
    ]);
  });
});

describe("a GM-view press on a card Aldric owns (M6-D15)", () => {
  test("is invoked as Aldric, so the log reads Aldric: Roll", async () => {
    const { gm, session } = await setup(ATTACK_SEED, [roll("1d20", [12], 12)]);
    await commit(
      gm,
      [
        {
          type: "set_value",
          object: "attack",
          cell: "owner",
          value: { type: "ref", object: "aldric" },
        },
      ],
      "Own",
    );
    await caughtUp(session, gm);
    const ui = await mount(session);
    const snapshot = session.getSnapshot();
    expect(snapshot.viewer).toEqual({ type: "gm" });
    const view = session.objectView("attack");
    if (view === null) throw new Error("no attack view");
    const stamp: InteractionStamp = {
      interactionId: "log-press",
      board: "gm_board",
      viewer: snapshot.viewer,
      baseRevision: snapshot.revision,
    };
    const [effect] = requestInvoke(defaultFacePolicy, view, "Roll", stamp, {
      camera: ui.getState().camera,
      views: (id) => session.objectView(id),
    });
    if (effect?.type !== "extension") throw new Error(JSON.stringify(effect));
    const outcome = await invokeExtension(session, sessionNotices(session))(
      effect,
      {} as ExtensionContext,
    );
    expect(outcome).toMatchObject({ status: "committed" });
    await caughtUp(session, gm);
    await until(
      () => groupItems()[0]?.getAttribute("aria-label") === "Aldric: Roll",
      "Aldric: Roll",
    );
  });
});

describe("undo", () => {
  test("undoing an agent's group works while Ctrl+Z (mine) does not reach it", async () => {
    const { authority, session } = await setup();
    const agent = await authority.client("Sage", "agent");
    await commit(
      agent,
      [{ type: "set_value", object: "note", cell: "n", value: num(4) }],
      "Agent note",
    );
    await caughtUp(session, agent);
    await mount(session);
    await until(() => groupItems().length === 2, "two groups");
    expect(item("Sage: Agent note")).toBeDefined();

    const mine = await undo(session);
    expect(mine.status).toBe("rejected");
    expect(item("Sage: Agent note").dataset.undone).toBe("false");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Undo Sage: Agent note" }));
    await until(() => item("Sage: Agent note").dataset.undone === "true", "the agent group undone");
    const note = await session.client.request("get_objects", { ids: ["note"] });
    expect(note.objects[0]?.cells.n?.value).toEqual({ type: "number", value: 0 });
  });

  test("an undo that conflicts shows the message", async () => {
    const { gm, session } = await setup();
    const first = await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "n", value: num(1) }],
      "First",
    );
    const second = await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "n", value: num(2) }],
      "Second",
    );
    await caughtUp(session, gm);
    await mount(session);
    await until(() => groupItems().length === 3, "three groups");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Undo GM: First" }));
    await until(() => notices(session).length > 0, "a notice");
    expect(notices(session)[0]).toMatch(
      new RegExp(`^Cannot undo #${first.index}: later edits #${second.index} conflict`),
    );
    expect(item("GM: First").dataset.undone).toBe("false");
  });
});

describe("as Aldric", () => {
  test("a group touching only GM-only cells is absent and a mixed one has no label; no Undo buttons", async () => {
    const { gm, session } = await setup([
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
    await commit(
      gm,
      [{ type: "set_value", object: "vault", cell: "gold", value: num(5) }],
      "Hide gold",
    );
    await commit(
      gm,
      [
        { type: "set_value", object: "note", cell: "n", value: num(3) },
        { type: "set_value", object: "vault", cell: "gold", value: num(6) },
      ],
      "Mixed",
    );
    await commit(gm, [{ type: "set_value", object: "note", cell: "n", value: num(4) }], "Public");
    await caughtUp(session, gm);
    const ui = createUiStore({ session });
    await act(() => ui.setViewer(ALDRIC));
    await mount(session, ui);
    await until(() => groupItems().length === 3, "Aldric's three groups");
    expect(groupItems().map((el) => el.getAttribute("aria-label"))).toEqual([
      "GM: Public",
      "GM: edit",
      "GM: edit",
    ]);
    expect(sentencesOf(groupItems()[1] as HTMLElement)).toEqual(["Set Note.n to 3 (was 0)"]);
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(screen.queryByText(/Hide gold/)).toBeNull();
  });
});

describe("paging", () => {
  test("'Load older' after 260 groups pages past the 200 window", async () => {
    const { gm, pool, session } = await setup();
    await commitMany(pool, 260, "note", "n", "Step");
    await caughtUp(session, gm);
    await mount(session);
    await until(() => groupItems().length === 200, "the window");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await until(() => groupItems().length === 250, "one older page");
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await until(() => groupItems().length === 261, "every group");
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    const shown = groupItems().map((el) => Number(el.dataset.logIndex));
    expect(shown).toEqual(Array.from({ length: 261 }, (_, k) => 260 - k));
    expect(item("GM: Seed").dataset.logPage).toBe("2");
  });

  test("without an IntersectionObserver, stale pages are rebuilt on the next render", async () => {
    const { authority, gm, pool, session } = await setup();
    const lonely = await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "mark", value: num(1) }],
      "Lonely",
    );
    await commitMany(pool, 210, "note", "n", "Step");
    await caughtUp(session, gm);
    await mount(session);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Load older" }));
    await until(() => groupItems().length === 212, "every group");
    const other = await authority.client("other");
    await other.request("undo", { target: { type: "group", index: lonely.index } });
    await caughtUp(session, other);
    await until(() => item("GM: Lonely").dataset.undone === "true", "the rebuilt page");
  });
});

describe("with an IntersectionObserver", () => {
  /** A stand-in observer whose intersections the test reports. */
  class FakeObserver {
    static last: FakeObserver | null = null;
    readonly observed = new Set<Element>();
    constructor(
      readonly callback: (records: { target: Element; isIntersecting: boolean }[]) => void,
    ) {
      FakeObserver.last = this;
    }
    observe(el: Element) {
      this.observed.add(el);
    }
    unobserve(el: Element) {
      this.observed.delete(el);
    }
    disconnect() {
      this.observed.clear();
    }
    report(isIntersecting: boolean, only?: Element) {
      const targets = only === undefined ? [...this.observed] : [only];
      this.callback(targets.map((target) => ({ target, isIntersecting })));
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a stale page is rebuilt only once it is reported in view", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const { authority, gm, pool, session } = await setup();
    const lonely = await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "mark", value: num(1) }],
      "Lonely",
    );
    await commitMany(pool, 210, "note", "n", "Step");
    await caughtUp(session, gm);
    await mount(session);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Load older" }));
    await until(() => groupItems().length === 212, "every group");
    const observer = FakeObserver.last as FakeObserver;
    expect(observer.observed.has(item("GM: Lonely"))).toBe(true);

    const other = await authority.client("other");
    await other.request("undo", { target: { type: "group", index: lonely.index } });
    await caughtUp(session, other);
    await until(() => item("GM: Lonely").dataset.refreshing !== undefined, "a stale page");
    await new Promise((r) => setTimeout(r, 50));
    expect(item("GM: Lonely").dataset.undone).toBe("false");
    expect(within(item("GM: Lonely")).getByText("refreshing")).toBeDefined();

    act(() => observer.report(true));
    await until(() => item("GM: Lonely").dataset.undone === "true", "the rebuilt page");
    expect(item("GM: Lonely").dataset.refreshing).toBeUndefined();
  });

  test("a page is rebuilt when only a middle row of it is in view", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const { authority, gm, pool, session } = await setup();
    const lonely = await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "mark", value: num(1) }],
      "Lonely",
    );
    await commitMany(pool, 260, "note", "n", "Step");
    await caughtUp(session, gm);
    await mount(session);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Load older" }));
    await until(() => groupItems().length === 250, "page 1");
    const page1 = groupItems().filter((el) => el.dataset.logPage === "1");
    expect(page1).toHaveLength(50);
    const middle = page1[25] as HTMLElement;
    const observer = FakeObserver.last as FakeObserver;
    expect(observer.observed.has(middle)).toBe(true);
    act(() => observer.report(true, middle));

    // Undoing a group below the boundary (the unloaded page 2 region) invalidates the chain.
    const other = await authority.client("other");
    await other.request("undo", { target: { type: "group", index: lonely.index } });
    await caughtUp(session, other);
    await until(() => middle.dataset.refreshing !== undefined, "page 1 stale");
    await until(() => middle.dataset.refreshing === undefined, "page 1 rebuilt");
    expect(groupItems().filter((el) => el.dataset.logPage === "1")).toHaveLength(50);
  });
});

describe("links and filters", () => {
  test("clicking a sentence selects the object, or says it is gone", async () => {
    const { gm, session } = await setup();
    await commit(gm, [{ type: "set_value", object: "note", cell: "n", value: num(1) }], "Touch");
    await commit(gm, [{ type: "remove", object: "note" }], "Remove");
    await commit(gm, [{ type: "set_value", object: "aldric", cell: "hp", value: num(9) }], "Hurt");
    await caughtUp(session, gm);
    const ui = await mount(session);
    await until(() => groupItems().length === 4, "four groups");
    const user = userEvent.setup();
    await user.click(within(item("GM: Hurt")).getByRole("button", { name: "Set Aldric.hp to 9" }));
    await until(() => ui.getState().selection[0] === "aldric", "Aldric selected");
    await user.click(
      within(item("GM: Touch")).getByRole("button", { name: "Set Note.n to 1 (was 0)" }),
    );
    await until(() => notices(session).length > 0, "a notice");
    expect(notices(session)).toEqual(["Note no longer exists or is hidden."]);
    expect(ui.getState().selection).toEqual(["aldric"]);
  });

  test("filters by actor, kind and text", async () => {
    const { authority, gm, session } = await setup();
    const agent = await authority.client("Sage", "agent");
    await commit(gm, [{ type: "set_value", object: "note", cell: "n", value: num(1) }], "Write");
    await commit(
      agent,
      [{ type: "set_value", object: "aldric", cell: "hp", value: num(2) }],
      "Heal",
    );
    const last = await commit(
      gm,
      [{ type: "set_value", object: "note", cell: "m", value: num(1) }],
      "Mark",
    );
    await gm.request("undo", { target: { type: "group", index: last.index } });
    await caughtUp(session, gm);
    await mount(session);
    await until(() => groupItems().length === 5, "five groups");
    const headers = () => groupItems().map((el) => el.getAttribute("aria-label"));
    const user = userEvent.setup();

    await user.selectOptions(screen.getByRole("combobox", { name: "Actor" }), "agent");
    expect(headers()).toEqual(["Sage: Heal"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Actor" }), "gm");
    expect(headers()).toHaveLength(4);
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "undos");
    expect(groupItems().map((el) => el.dataset.kind)).toEqual(["undo"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "edits");
    await user.selectOptions(screen.getByRole("combobox", { name: "Actor" }), "all");
    expect(headers()).toEqual(["GM: Mark", "Sage: Heal", "GM: Write", "GM: Seed"]);
    await user.type(screen.getByRole("searchbox", { name: "Search the log" }), "aldric");
    // Names: the seed and Heal touched Aldric.
    expect(headers()).toEqual(["Sage: Heal", "GM: Seed"]);
    await user.clear(screen.getByRole("searchbox", { name: "Search the log" }));
    await user.type(screen.getByRole("searchbox", { name: "Search the log" }), "writ");
    expect(headers()).toEqual(["GM: Write"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "actions");
    expect(headers()).toEqual([]);
  });
});
