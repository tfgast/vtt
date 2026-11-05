/**
 * The inspector's contents list (vtt-3l6.12; DESIGN.md §4.1 Containment, §4.4,
 * §4.6 View as in the UI; M4 plan Q12; review r2 finding 9; PROTOCOL.md §5
 * `reorder`, `move`, §6 stale writes, §7.3 redaction): labels, "hidden"
 * entries, selection, "Take out", and reorder against the drag-start
 * revision. jsdom against a real in-process authority through the shared
 * helper.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import {
  createUiStore,
  Inspector,
  reorderPermutation,
  sessionNotices,
  type TableSession,
  type UiStore,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

describe("reorderPermutation", () => {
  test("moving one entry gives the permutation of the drag-start ids", () => {
    // after[i] = before[permutation[i]] (PROTOCOL.md §5 `reorder`).
    expect(reorderPermutation(3, 2, 0)).toEqual([2, 0, 1]);
    expect(reorderPermutation(3, 0, 2)).toEqual([1, 2, 0]);
    expect(reorderPermutation(3, 1, 1)).toEqual([0, 1, 2]);
    expect(reorderPermutation(4, 1, 2)).toEqual([0, 2, 1, 3]);
  });
});

const text = (value: string) => ({ type: "text" as const, value });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});
const into = (container: string) => ({ type: "container" as const, container });
const gmOnly = { type: "viewers" as const, viewers: ["gm" as const] };

/**
 * Aldric; a goblin token holding a d20, a "secret" whose name is GM-only,
 * and a "hidden" note invisible to Aldric; a chest holding a, b, c; a bag
 * inside a crate whose position is an error (its chain is not on a board).
 */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  { type: "create_object", id: "goblin", to: at(2, 3), init: { cells: { name: text("Goblin") } } },
  { type: "create_object", id: "d20", to: into("goblin"), init: { cells: { name: text("Die") } } },
  {
    type: "create_object",
    id: "secret",
    to: into("goblin"),
    init: { cells: { name: text("Secret name") }, cell_visibility: { name: gmOnly } },
  },
  {
    type: "create_object",
    id: "note",
    to: into("goblin"),
    init: { cells: { name: text("GM note"), visible_to: gmOnly } },
  },
  { type: "create_object", id: "chest", to: at(8, 0), init: { cells: { name: text("Chest") } } },
  { type: "create_object", id: "a", to: into("chest"), init: { cells: { name: text("A") } } },
  { type: "create_object", id: "b", to: into("chest"), init: { cells: { name: text("B") } } },
  { type: "create_object", id: "c", to: into("chest"), init: { cells: { name: text("C") } } },
  { type: "create_object", id: "crate", to: at(12, 0), init: { cells: { name: text("Crate") } } },
  { type: "set_formula", object: "crate", cell: "position", source: "1 / 0" },
  { type: "create_object", id: "bag", to: into("crate"), init: { cells: { name: text("Bag") } } },
  { type: "create_object", id: "coin", to: into("bag"), init: { cells: { name: text("Coin") } } },
];

interface Setup {
  session: TableSession;
  ui: UiStore;
  other: Awaited<ReturnType<Awaited<ReturnType<typeof startAuthority>>["client"]>>;
  transacts(): { ops: WireOp[]; base_revision?: number }[];
}

async function setup(selected: string): Promise<Setup> {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const other = await authority.client("Scribe", { kind: "agent" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  const ui = createUiStore({ session });
  render(<Inspector session={session} ui={ui} />);
  act(() => ui.select([selected]));
  await until(() => session.objectView(selected) !== null, `the ${selected} view`);
  await screen.findByRole("region", { name: "Contents" });
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    ui,
    other,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number }),
  };
}

const contentsRegion = () => screen.getByRole("region", { name: "Contents" });
const entries = () => within(contentsRegion()).queryAllByRole("listitem");
const labels = () => entries().map((li) => li.getAttribute("data-label"));
const entry = (label: string) => {
  const found = entries().find((li) => li.getAttribute("data-label") === label);
  if (found === undefined) throw new Error(`no entry ${label}`);
  return found;
};

function contentsOf(session: TableSession, id: string): string[] {
  const v = session.directory().get(id)?.cells.contents?.value;
  return v?.type === "list" ? v.items.map((i) => (i.type === "ref" ? i.object : "?")) : [];
}

describe("listing", () => {
  test("the GM sees every entry by name, in order; a click selects it", async () => {
    const user = userEvent.setup();
    const { ui } = await setup("goblin");
    expect(labels()).toEqual(["Die", "Secret name", "GM note"]);
    await user.click(within(entry("Die")).getByRole("button", { name: "Die" }));
    expect(ui.getState().selection).toEqual(["d20"]);
  });

  test("as Aldric: a GM-only name is listed by id, an invisible entry as hidden, nothing editable", async () => {
    const { session } = await setup("goblin");
    await act(() =>
      session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
    );
    await until(() => session.getSnapshot().viewer.type === "character", "view-as");
    await until(() => labels().includes("hidden"), "Aldric's contents");
    // Never the GM directory's name in view-as.
    expect(labels()).toEqual(["Die", "secret", "hidden"]);
    expect(within(contentsRegion()).queryByText("Secret name")).toBeNull();
    expect(within(contentsRegion()).queryByText("GM note")).toBeNull();
    expect(within(contentsRegion()).queryByRole("button", { name: /Take out/ })).toBeNull();
    for (const li of entries()) expect(li.getAttribute("draggable")).not.toBe("true");
  });

  test("an empty contents list says so", async () => {
    await setup("aldric");
    expect(within(contentsRegion()).getByText("Empty")).toBeDefined();
  });
});

describe("Take out", () => {
  test("a die in a token moves beside the token on the board", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup("goblin");
    await user.click(within(entry("Die")).getByRole("button", { name: "Take out Die" }));
    await until(() => !contentsOf(session, "goblin").includes("d20"), "the move");
    expect(transacts()[0]?.ops).toEqual([
      { type: "move", object: "d20", to: { type: "board", board: "gm_board", position: [3, 3] } },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    const d20 = session.directory().get("d20");
    expect(d20?.cells.board?.value).toEqual({ type: "ref", object: "gm_board" });
    expect(d20?.cells.position?.value).toEqual({
      type: "list",
      items: [
        { type: "number", value: 3 },
        { type: "number", value: 3 },
      ],
    });
    await until(() => !labels().includes("Die"), "the list to follow");
  });

  test("a nested entry goes beside the outermost container", async () => {
    const user = userEvent.setup();
    const { session, other, transacts } = await setup("bag");
    // Fix the crate's position, so the chain is on the board.
    await other.transact(
      [
        {
          type: "set_value",
          object: "crate",
          cell: "position",
          value: {
            type: "list",
            items: [
              { type: "number", value: 12 },
              { type: "number", value: 0 },
            ],
          },
          replace: true,
        },
      ],
      { label: "Fix crate" },
    );
    await session.whenRevision(2);
    await until(
      () =>
        !(within(entry("Coin")).getByRole("button", { name: "Take out Coin" }) as HTMLButtonElement)
          .disabled,
      "Take out enabled",
    );
    await user.click(within(entry("Coin")).getByRole("button", { name: "Take out Coin" }));
    await until(() => !contentsOf(session, "bag").includes("coin"), "the move");
    expect(transacts()[0]?.ops).toEqual([
      { type: "move", object: "coin", to: { type: "board", board: "gm_board", position: [13, 0] } },
    ]);
  });

  test("disabled when the chain is not on a board", async () => {
    await setup("bag");
    const button = within(entry("Coin")).getByRole("button", { name: "Take out Coin" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

/** Drags the entry `from` onto the entry `to` (HTML drag and drop). */
function dragStart(label: string) {
  fireEvent.dragStart(entry(label));
}
function drop(label: string) {
  fireEvent.dragOver(entry(label));
  fireEvent.drop(entry(label));
  fireEvent.dragEnd(entry(label));
}

describe("reorder", () => {
  test("dragging C onto A writes the permutation against the drag-start revision", async () => {
    const { session, transacts } = await setup("chest");
    expect(labels()).toEqual(["A", "B", "C"]);
    dragStart("C");
    drop("A");
    await until(() => contentsOf(session, "chest").join() === "c,a,b", "the reorder");
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      { type: "reorder", container: "chest", permutation: [2, 0, 1] },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    await until(() => labels().join() === "C,A,B", "the list to follow");
  });

  test("a drop on the dragged entry itself writes nothing", async () => {
    const { transacts } = await setup("chest");
    dragStart("B");
    drop("B");
    expect(transacts()).toEqual([]);
  });

  test("a drag begun before another client reordered the list is stale; the other order is kept", async () => {
    const { session, other, transacts } = await setup("chest");
    const notices = sessionNotices(session);
    dragStart("C");
    await other.transact([{ type: "reorder", container: "chest", permutation: [1, 0, 2] }], {
      label: "Shuffle chest",
    });
    await session.whenRevision(2);
    await until(() => labels().join() === "B,A,C", "the other client's order");
    drop("A");
    await until(() => notices.list().some((n) => n.kind === "stale"), "the stale notice");
    expect(transacts()[0]?.ops).toEqual([
      // The permutation of the drag-start ids [a, b, c], against the drag-start revision.
      { type: "reorder", container: "chest", permutation: [2, 0, 1] },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    expect(notices.list().find((n) => n.kind === "stale")?.text).toContain("Shuffle chest");
    expect(contentsOf(session, "chest")).toEqual(["b", "a", "c"]);
    expect(session.getSnapshot().revision).toBe(2);
  });

  test("a drag begun before another client removed a member is stale; the other change is kept", async () => {
    const { session, other, transacts } = await setup("chest");
    const notices = sessionNotices(session);
    dragStart("C");
    await other.transact([{ type: "move", object: "b", to: at(20, 20) }], { label: "Take B" });
    await session.whenRevision(2);
    await until(() => labels().join() === "A,C", "the other client's removal");
    drop("A");
    await until(() => notices.list().some((n) => n.kind === "stale"), "the stale notice");
    expect(transacts()[0]?.ops).toEqual([
      { type: "reorder", container: "chest", permutation: [2, 0, 1] },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    expect(contentsOf(session, "chest")).toEqual(["a", "c"]);
    expect(session.getSnapshot().revision).toBe(2);
  });
});
