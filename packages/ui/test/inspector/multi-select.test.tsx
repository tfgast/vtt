/**
 * The inspector's multi-selection mode (vtt-qf5.15; DESIGN.md §4.6 The
 * inspector, §8.1; M6-D36): with several objects selected it lists the cells
 * present on all of them, shows a shared value or "mixed", and setting a
 * shared cell writes one transact (one group, one undo) for every object.
 * jsdom against a real in-process authority through the shared helper.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellView, WireOp } from "@vtt/protocol";
import type { OpGroup } from "@vtt/schema";
import {
  createUiStore,
  Inspector,
  MIXED_TEXT,
  type TableSession,
  type UiStore,
  undo,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const formula = (source: string) => ({ type: "formula" as const, source });
const at = (x: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, 0] as [number, number],
});

/**
 * Three goblin tokens and a character. Every token has `hp` (7, 7, 9),
 * `ac` 13, `speed` (two literals and a formula), `bonus` (one formula
 * on all) and `step` (two formula sources); only two have `notes`.
 */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(-4),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  ...[
    ["g1", 7, num(30), text("sneaky")],
    ["g2", 7, num(30), text("loud")],
    ["g3", 9, formula("20 + 10"), null],
  ].map(
    ([id, hp, speed, notes], i): WireOp => ({
      type: "create_object",
      id: id as string,
      to: at(i * 2),
      init: {
        shape: { type: "circle", radius: 0.5 },
        cells: {
          name: text(`Goblin ${i + 1}`),
          hp: num(hp as number),
          ac: num(13),
          speed: speed as ReturnType<typeof num>,
          bonus: formula("ac - 10"),
          step: formula(id === "g3" ? "hp + 2" : "hp + 1"),
          ...(notes === null ? {} : { notes: notes as ReturnType<typeof text> }),
        },
      },
    }),
  ),
];

const TOKENS = ["g1", "g2", "g3"];

interface Setup {
  session: TableSession;
  ui: UiStore;
  transacts(): { ops: WireOp[]; base_revision?: number; label?: string }[];
  groups(): readonly OpGroup[];
}

async function setup(): Promise<Setup> {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => TOKENS.every((id) => session.objectView(id) !== null), "the tokens");
  const ui = createUiStore({ session });
  render(<Inspector session={session} ui={ui} />);
  const request = vi.spyOn(session.client, "request");
  act(() => ui.select(TOKENS));
  return {
    session,
    ui,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number; label?: string }),
    groups: () => authority.host.table.store.history.groups() as readonly OpGroup[],
  };
}

const shared = () => screen.getByRole("region", { name: "Shared cells" });
const rowNames = () =>
  [...shared().querySelectorAll("[data-cell]")].map((el) => el.getAttribute("data-cell"));
function row(name: string): HTMLElement {
  const found = shared().querySelector<HTMLElement>(`[data-cell="${name}"]`);
  if (found === null) throw new Error(`no row ${name}`);
  return found;
}
const shownValue = (name: string) => row(name).querySelector<HTMLElement>('[data-part="value"]');
const cellOf = (session: TableSession, object: string, cell: string): CellView | undefined =>
  session.objectView(object)?.cells[cell];
/** The number in a cell, or null. */
function numberOf(session: TableSession, object: string, cell: string): number | null {
  const v = cellOf(session, object, cell)?.value;
  return v?.type === "number" ? v.value : null;
}

describe("multi-selection inspector", () => {
  test("lists only the user cells present on every selected object", async () => {
    await setup();
    expect(screen.getByRole("heading", { name: "3 objects" })).toBeDefined();
    // `notes` is missing on g3; structural cells are not listed.
    expect(rowNames()).toEqual(["ac", "bonus", "hp", "speed", "step"]);
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Contents" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Face" })).toBeNull();
  });

  test("an agreed value is shown, differing values show the mixed placeholder", async () => {
    await setup();
    expect(shownValue("ac")?.textContent).toBe("13");
    expect(shownValue("hp")?.textContent).toBe(MIXED_TEXT);
    expect(shownValue("hp")?.getAttribute("data-mixed")).toBe("true");
    // A shared formula shows its source; the values agree (3 everywhere).
    expect(within(row("bonus")).getByText("=ac - 10")).toBeDefined();
    expect(shownValue("bonus")?.textContent).toBe("3");
    // Literals on two, a formula on one: read-only mixed.
    expect(shownValue("speed")?.textContent).toBe(MIXED_TEXT);
  });

  test("setting a shared cell on three tokens is one transact, one group, one undo", async () => {
    const user = userEvent.setup();
    const { session, transacts, groups } = await setup();
    const before = groups().length;
    const revision = session.getSnapshot().revision;
    await user.dblClick(shownValue("hp") as HTMLElement);
    const editor = within(row("hp")).getByRole("textbox", { name: "Value of hp" });
    expect((editor as HTMLInputElement).value).toBe("");
    await user.type(editor, "12{Enter}");
    await until(
      () => TOKENS.every((id) => numberOf(session, id, "hp") === 12),
      "hp = 12 on every token",
    );
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]).toMatchObject({
      ops: TOKENS.map((object) => ({ type: "set_value", object, cell: "hp", value: num(12) })),
      base_revision: revision,
      label: "Set hp on 3 objects",
    });
    expect(groups().length).toBe(before + 1);
    expect(groups().at(-1)?.label).toBe("Set hp on 3 objects");
    expect(shownValue("hp")?.textContent).toBe("12");

    // One undo restores all three.
    await act(() => undo(session));
    await until(() => numberOf(session, "g3", "hp") === 9, "the undone hp");
    expect(TOKENS.map((id) => cellOf(session, id, "hp")?.value)).toEqual([num(7), num(7), num(9)]);
    expect(shownValue("hp")?.textContent).toBe(MIXED_TEXT);
  });

  test("an agreed value left unchanged, or an untouched mixed placeholder, writes nothing", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    await user.dblClick(shownValue("ac") as HTMLElement);
    const editor = within(row("ac")).getByRole("textbox", { name: "Value of ac" });
    expect((editor as HTMLInputElement).value).toBe("13");
    await user.type(editor, "{Enter}");
    await user.dblClick(shownValue("speed") as HTMLElement);
    const speed = within(row("speed")).getByRole("textbox", { name: "Value of speed" });
    expect((speed as HTMLInputElement).value).toBe("");
    await user.type(speed, "{Enter}");
    expect(transacts()).toEqual([]);
  });

  test("a cleared prefilled value writes empty on every object", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    await user.dblClick(shownValue("ac") as HTMLElement);
    const editor = within(row("ac")).getByRole("textbox", { name: "Value of ac" });
    await user.clear(editor);
    await user.type(editor, "{Enter}");
    await until(() => transacts().length === 1, "the write");
    expect(transacts()[0]?.ops).toEqual(
      TOKENS.map((object) => ({ type: "set_value", object, cell: "ac", value: { type: "empty" } })),
    );
    await until(() => cellOf(session, "g3", "ac")?.value.type === "empty", "ac emptied");
  });

  test("a row mixing literals and a formula takes input for every object", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    expect(shownValue("speed")?.textContent).toBe(MIXED_TEXT);
    await user.dblClick(shownValue("speed") as HTMLElement);
    await user.type(within(row("speed")).getByRole("textbox"), "25{Enter}");
    await until(() => transacts().length === 1, "the write");
    expect(transacts()[0]).toMatchObject({
      ops: TOKENS.map((object) => ({ type: "set_value", object, cell: "speed", value: num(25) })),
      label: "Set speed on 3 objects",
    });
    // On g3 that is an override over its formula.
    await until(() => numberOf(session, "g3", "speed") === 25, "speed = 25");
    expect(cellOf(session, "g3", "speed")?.overridden).toBe(true);
  });

  test("a row with differing formula sources shows mixed and takes a formula for every object", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    // `step` is `hp + 1` on g1 and g2 and `hp + 2` on g3: values and sources differ.
    expect(shownValue("step")?.textContent).toBe(MIXED_TEXT);
    expect(within(row("step")).queryByText(/^=/)).toBeNull();
    await user.dblClick(shownValue("step") as HTMLElement);
    await user.type(within(row("step")).getByRole("textbox"), "=ac{Enter}");
    await until(() => transacts().length === 1, "the write");
    expect(transacts()[0]?.ops).toEqual(
      TOKENS.map((object) => ({ type: "set_formula", object, cell: "step", source: "ac" })),
    );
    await until(() => numberOf(session, "g3", "step") === 13, "step = ac");
  });

  test("a formula typed with = is set on every object", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    await user.dblClick(shownValue("ac") as HTMLElement);
    const editor = within(row("ac")).getByRole("textbox", { name: "Value of ac" });
    await user.clear(editor);
    await user.type(editor, "=hp + 5{Enter}");
    await until(() => transacts().length === 1, "the write");
    expect(transacts()[0]?.ops).toEqual(
      TOKENS.map((object) => ({ type: "set_formula", object, cell: "ac", source: "hp + 5" })),
    );
    await until(() => cellOf(session, "g3", "ac")?.kind === "formula", "the formula");
  });

  test("view-as is read-only", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    await act(() =>
      session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
    );
    await until(() => session.getSnapshot().viewer.type === "character", "view-as");
    await until(() => shownValue("ac") !== null, "the ac row");
    expect(shownValue("ac")?.textContent).toBe("13");
    // No formula source in view-as.
    expect(within(row("bonus")).queryByText("=ac - 10")).toBeNull();
    expect(shownValue("bonus")?.textContent).toBe("3");
    await user.dblClick(shownValue("ac") as HTMLElement);
    expect(within(row("ac")).queryByRole("textbox")).toBeNull();
  });
});
