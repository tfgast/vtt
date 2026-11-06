/**
 * The inspector's cell list (vtt-3l6.11; DESIGN.md §4.2, §4.6; FORMULAS.md
 * §2.3, §3.1; PROTOCOL.md §5, §6): rows, the value editor, overrides,
 * "Replace formula with value", structural rows, add/rename/delete and hover.
 * jsdom against a real in-process authority through the shared helper.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellView, WireOp } from "@vtt/protocol";
import type { ObjectId, OpGroup } from "@vtt/schema";
import {
  type CellAddress,
  CellList,
  createUiStore,
  sessionNotices,
  TableProvider,
  type TableSession,
  type UiStore,
  undo,
  useSession,
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
const ref = (object: string) => ({ type: "ref" as const, object });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

const REHIDE = 'if(len(contents(this).where(tag has "pc")) > 0, all, gm)';

/**
 * On `gm_board`: the character Aldric; a trap whose `boom` is `#DIV0`;
 * `goblin2`; the goblin with literal, formula, overridden, error, roll and
 * dangling-ref cells; an opaque room whose `visible_to` is the re-hiding
 * formula (FORMULAS.md §10).
 */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "trap",
    to: at(5, 5),
    init: { cells: { name: text("Trap"), boom: formula("1 / 0") } },
  },
  {
    type: "create_object",
    id: "goblin2",
    to: at(8, 0),
    init: { cells: { name: text("Goblin 2") } },
  },
  { type: "create_object", id: "ghost", to: at(9, 0), init: { cells: { name: text("Ghost") } } },
  {
    type: "create_object",
    id: "goblin",
    to: at(2, 0),
    init: {
      cells: {
        name: text("Goblin"),
        max_hp: num(12),
        damage_taken: num(3),
        hp: formula("max_hp - damage_taken"),
        ac: num(13),
        speed: num(30),
        temp: formula("max_hp + 1"),
        other: ref("trap"),
        relay: formula("other.boom"),
        lastroll: { type: "roll", expr: "1d20", dice: [17], dropped: [], total: 17 },
        target: ref("ghost"),
      },
    },
  },
  { type: "set_value", object: "goblin", cell: "temp", value: num(20) },
  { type: "remove", object: "ghost" },
  {
    type: "create_object",
    id: "room",
    to: at(20, 20),
    init: {
      is_zone: true,
      shape: { type: "rect", width: 6, height: 6 },
      cells: {
        name: text("Guard room"),
        opaque: { type: "boolean", value: true },
        visible_to: formula(REHIDE),
        ac: num(10),
      },
    },
  },
];

function Harness({
  session,
  object,
  onEditFormula,
}: {
  session: TableSession;
  object: ObjectId;
  onEditFormula?: (cell: CellAddress) => void;
}) {
  useSession((s) => s.viewVersion);
  const view = session.objectView(object);
  if (view === null) return <p>missing {object}</p>;
  const readOnly = session.getSnapshot().viewer.type !== "gm";
  return (
    <CellList
      object={object}
      view={view}
      session={session}
      readOnly={readOnly}
      {...(onEditFormula === undefined ? {} : { onEditFormula })}
    />
  );
}

interface Setup {
  session: TableSession;
  ui: UiStore;
  other: Awaited<ReturnType<Awaited<ReturnType<typeof startAuthority>>["client"]>>;
  onEditFormula: ReturnType<typeof vi.fn<(cell: CellAddress) => void>>;
  rerender(object: ObjectId): void;
  /** The `transact` params the session sent since setup. */
  transacts(): { ops: WireOp[]; base_revision?: number }[];
  /** The authority's log groups. */
  groups(): readonly OpGroup[];
}

async function setup(object: ObjectId = "goblin"): Promise<Setup> {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const other = await authority.client("Scribe", { kind: "agent" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView(object) !== null, `the ${object} view`);
  const ui = createUiStore({ session });
  const onEditFormula = vi.fn<(cell: CellAddress) => void>();
  const tree = (id: ObjectId) => (
    <TableProvider session={session} ui={ui}>
      <Harness session={session} object={id} onEditFormula={onEditFormula} />
    </TableProvider>
  );
  const utils = render(tree(object));
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    ui,
    other,
    onEditFormula,
    rerender: (id) => utils.rerender(tree(id)),
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number }),
    groups: () => authority.host.table.store.history.groups() as readonly OpGroup[],
  };
}

/** The row of `name` (rows carry `data-cell`). */
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("[data-cell]")].find(
    (el) => el.getAttribute("data-cell") === name,
  );
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

const hasRow = (name: string) =>
  [...document.querySelectorAll("[data-cell]")].some((el) => el.getAttribute("data-cell") === name);

function shown(name: string): HTMLElement {
  const el = row(name).querySelector<HTMLElement>('[data-part="value"]');
  if (el === null) throw new Error(`no value in row ${name}`);
  return el;
}

const cellOf = (session: TableSession, object: string, cell: string): CellView | undefined =>
  session.objectView(object)?.cells[cell];

const editorOf = (name: string) =>
  within(row(name)).queryByRole("textbox", { name: `Value of ${name}` }) as HTMLInputElement | null;

async function openEditor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.dblClick(shown(name));
  const editor = editorOf(name);
  if (editor === null) throw new Error(`no editor for ${name}`);
  return editor;
}

describe("rows", () => {
  test("literal, formula, overridden and error rows show value, source, override and origin", async () => {
    const { session, ui } = await setup();
    // Literal.
    expect(shown("ac").textContent).toBe("13");
    expect(within(row("ac")).queryByText("ƒ")).toBeNull();
    // Formula: badge, source and computed result.
    expect(within(row("hp")).getByText("ƒ")).toBeDefined();
    expect(within(row("hp")).getByText("=max_hp - damage_taken")).toBeDefined();
    expect(shown("hp").textContent).toBe("9");
    // Overridden.
    expect(shown("temp").textContent).toBe("20");
    expect(
      within(row("temp")).getByText("Overridden: no longer follows its formula"),
    ).toBeDefined();
    expect(within(row("temp")).getByRole("button", { name: "Clear override" })).toBeDefined();
    expect(within(row("hp")).queryByText("Overridden: no longer follows its formula")).toBeNull();
    // Error: message and origin, with error tone.
    expect(shown("relay").textContent).toContain("#DIV0");
    expect(shown("relay").getAttribute("data-tone")).toBe("error");
    const origin = within(row("relay")).getByRole("button", { name: "from Trap.boom" });
    await userEvent.setup().click(origin);
    expect(ui.getState().selection).toEqual(["trap"]);
    expect(ui.getState().focusedCell).toEqual({ object: "trap", cell: "boom" });
    // Refs are labelled.
    expect(shown("other").textContent).toBe("Trap (trap)");
    expect(session.getSnapshot().revision).toBe(1);
  });

  test("user cells are alphabetical, then the Structural group in FORMULAS §3.1 order", async () => {
    await setup();
    const names = [...document.querySelectorAll("[data-cell]")].map((el) =>
      el.getAttribute("data-cell"),
    );
    expect(names.slice(0, 10)).toEqual([
      "ac",
      "damage_taken",
      "hp",
      "lastroll",
      "max_hp",
      "other",
      "relay",
      "speed",
      "target",
      "temp",
    ]);
    expect(names.slice(10)).toEqual([
      "id",
      "name",
      "tag",
      "visible_to",
      "owner",
      "template",
      "contents",
      "container",
      "board",
      "position",
      "rotation",
      "z",
      "face_up",
      "shape",
      "opaque",
      "is_zone",
    ]);
    expect(shown("id").textContent).toBe("goblin");
  });

  test("the Structural group collapses", async () => {
    const user = userEvent.setup();
    await setup();
    const toggle = screen.getByRole("button", { name: "Structural" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(hasRow("position")).toBe(false);
    expect(hasRow("hp")).toBe(true);
    await user.click(toggle);
    expect(hasRow("position")).toBe(true);
  });

  test("hovering a row sets hoveredCell and leaving clears it; a click focuses the cell", async () => {
    const user = userEvent.setup();
    const { ui } = await setup();
    await user.hover(row("hp"));
    expect(ui.getState().hoveredCell).toEqual({ object: "goblin", cell: "hp" });
    await user.unhover(row("hp"));
    expect(ui.getState().hoveredCell).toBeNull();
    await user.click(row("ac"));
    expect(ui.getState().focusedCell).toEqual({ object: "goblin", cell: "ac" });
    expect(ui.getState().highlight).toEqual([]);
  });

  test('"Edit formula" focuses the cell for the formula bar', async () => {
    const user = userEvent.setup();
    const { ui, onEditFormula, transacts } = await setup();
    expect(within(row("ac")).queryByRole("button", { name: "Edit formula" })).toBeNull();
    await user.click(within(row("hp")).getByRole("button", { name: "Edit formula" }));
    expect(ui.getState().focusedCell).toEqual({ object: "goblin", cell: "hp" });
    expect(onEditFormula).toHaveBeenCalledWith({ object: "goblin", cell: "hp" });
    expect(transacts()).toEqual([]);
  });
});

describe("the value editor", () => {
  test("typing 14 into a formula cell overrides it; Clear override removes the override", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "hp");
    expect(editor.value).toBe("9");
    await user.clear(editor);
    await user.type(editor, "14{Enter}");
    await until(() => cellOf(session, "goblin", "hp")?.overridden === true, "the override");
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "hp", value: num(14) },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    await screen.findByText("Overridden: no longer follows its formula", {
      selector: `[data-cell="hp"] *`,
    });
    expect(shown("hp").textContent).toBe("14");
    expect(editorOf("hp")).toBeNull();

    await user.click(within(row("hp")).getByRole("button", { name: "Clear override" }));
    await until(() => cellOf(session, "goblin", "hp")?.overridden !== true, "the cleared override");
    expect(transacts()[1]?.ops).toEqual([{ type: "clear_override", object: "goblin", cell: "hp" }]);
    expect(transacts()[1]?.base_revision).toBe(2);
    await until(() => shown("hp").textContent === "9", "the formula's value");
    expect(within(row("hp")).queryByText("Overridden: no longer follows its formula")).toBeNull();
  });

  test("typing =max_hp - damage_taken sets a formula", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "speed");
    await user.clear(editor);
    await user.type(editor, "=max_hp - damage_taken{Enter}");
    await until(() => cellOf(session, "goblin", "speed")?.kind === "formula", "the formula");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_formula", object: "goblin", cell: "speed", source: "max_hp - damage_taken" },
    ]);
    await until(() => shown("speed").textContent === "9", "the value");
    expect(within(row("speed")).getByText("=max_hp - damage_taken")).toBeDefined();
  });

  test("typing =max_hp into the value editor of a literal cell sets a formula", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    const editor = await openEditor(user, "ac");
    await user.clear(editor);
    await user.type(editor, "=max_hp{Enter}");
    await until(() => cellOf(session, "goblin", "ac")?.source === "max_hp", "the formula");
    await until(() => shown("ac").textContent === "12", "the value");
  });

  test("an unparseable formula shows the parser message and sends nothing", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    const editor = await openEditor(user, "ac");
    await user.clear(editor);
    await user.type(editor, "=max_hp -{Enter}");
    const alert = within(row("ac")).getByRole("alert");
    expect(alert.textContent?.length).toBeGreaterThan(0);
    expect(editorOf("ac")).not.toBeNull();
    expect(transacts()).toEqual([]);
    // Escape cancels.
    await user.keyboard("{Escape}");
    expect(editorOf("ac")).toBeNull();
    expect(shown("ac").textContent).toBe("13");
    expect(transacts()).toEqual([]);
  });

  test("the overridden-formula round trip: prefilled with the override, unchanged writes nothing", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "temp");
    expect(editor.value).toBe("20");
    await user.type(editor, "{Enter}");
    expect(editorOf("temp")).toBeNull();
    // Equal parsed contents also count as unchanged.
    const again = await openEditor(user, "temp");
    await user.clear(again);
    await user.type(again, " 20 {Enter}");
    expect(editorOf("temp")).toBeNull();
    expect(transacts()).toEqual([]);
    expect(cellOf(session, "goblin", "temp")).toMatchObject({
      kind: "formula",
      source: "max_hp + 1",
      overridden: true,
    });
  });

  test("vtt-1xv.29: committing the evaluated value over a formula cell writes one override", async () => {
    const user = userEvent.setup();
    const { session, transacts, groups } = await setup();
    const before = groups().length;
    const editor = await openEditor(user, "hp");
    expect(editor.value).toBe("9");
    await user.type(editor, "{Enter}");
    await until(() => cellOf(session, "goblin", "hp")?.overridden === true, "the override");
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "hp", value: num(9) },
    ]);
    expect(transacts()[0]?.base_revision).toBe(1);
    expect(groups().length).toBe(before + 1);
    expect(cellOf(session, "goblin", "hp")).toMatchObject({
      kind: "formula",
      source: "max_hp - damage_taken",
      overridden: true,
    });
  });

  test("vtt-1xv.29: the same literal over a literal cell writes nothing", async () => {
    const user = userEvent.setup();
    const { session, transacts, groups } = await setup();
    const before = groups().length;
    const editor = await openEditor(user, "ac");
    expect(editor.value).toBe("13");
    await user.type(editor, "{Enter}");
    expect(editorOf("ac")).toBeNull();
    const again = await openEditor(user, "ac");
    await user.clear(again);
    await user.type(again, " 13 {Enter}");
    expect(editorOf("ac")).toBeNull();
    expect(transacts()).toEqual([]);
    expect(groups().length).toBe(before);
    expect(cellOf(session, "goblin", "ac")?.value).toEqual(num(13));
  });

  test("vtt-1xv.29: the same text over an overridden formula cell writes nothing", async () => {
    const user = userEvent.setup();
    const { transacts, groups } = await setup();
    const before = groups().length;
    const editor = await openEditor(user, "temp");
    expect(editor.value).toBe("20");
    await user.type(editor, "{Enter}");
    expect(editorOf("temp")).toBeNull();
    expect(transacts()).toEqual([]);
    expect(groups().length).toBe(before);
  });

  test("a roll value opens the replace-value editor (empty, reason shown); typing 3 writes 3", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "lastroll");
    expect(editor.value).toBe("");
    expect(within(row("lastroll")).getByText(/a roll result cannot be typed/)).toBeDefined();
    await user.type(editor, "3{Enter}");
    await until(() => cellOf(session, "goblin", "lastroll")?.value.type === "number", "the number");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "lastroll", value: num(3) },
    ]);
    expect(cellOf(session, "goblin", "lastroll")?.value).toEqual(num(3));
  });

  test("a dangling ref shows #REF; the replace-value editor repairs it with @goblin2", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    expect(shown("target").textContent).toContain("#REF");
    const editor = await openEditor(user, "target");
    expect(editor.value).toBe("");
    expect(within(row("target")).getByText(/cannot be typed/)).toBeDefined();
    await user.type(editor, "@goblin2{Enter}");
    await until(
      () => cellOf(session, "goblin", "target")?.value.type === "ref",
      "the repaired ref",
    );
    expect(cellOf(session, "goblin", "target")).toMatchObject({
      kind: "literal",
      value: { type: "ref", object: "goblin2" },
    });
    await until(() => shown("target").textContent === "Goblin 2 (goblin2)", "the label");
  });

  test("adding nothing but a trailing space to name writes the new name", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "name");
    expect(editor.value).toBe("Goblin");
    await user.type(editor, " {Enter}");
    await until(() => transacts().length === 1, "the write");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "name", value: text("Goblin ") },
    ]);
    await until(
      () =>
        JSON.stringify(cellOf(session, "goblin", "name")?.value) ===
        JSON.stringify(text("Goblin ")),
      "the new name",
    );
  });

  test("review r1 finding 1: a concurrent write makes the commit stale; the other value stays", async () => {
    const user = userEvent.setup();
    const { session, other, transacts } = await setup();
    // The editor opens at revision r.
    const r = session.getSnapshot().revision;
    const editor = await openEditor(user, "ac");
    // A second client writes the same cell and the UI applies it.
    await other.transact([{ type: "set_value", object: "goblin", cell: "ac", value: num(15) }], {
      label: "Scribe sets ac",
    });
    await session.whenRevision(r + 1);
    await until(() => cellOf(session, "goblin", "ac")?.value.type === "number", "ac");
    expect(cellOf(session, "goblin", "ac")?.value).toEqual(num(15));
    // Committing yields stale_write.
    await user.clear(editor);
    await user.type(editor, "16{Enter}");
    const notices = sessionNotices(session);
    await until(() => notices.list().some((n) => n.kind === "stale"), "the stale notice");
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.base_revision).toBe(r);
    const notice = notices.list().find((n) => n.kind === "stale");
    expect(notice?.text).toContain("Scribe sets ac");
    expect(cellOf(session, "goblin", "ac")?.value).toEqual(num(15));
    expect(session.getSnapshot().revision).toBe(r + 1);
    await until(() => shown("ac").textContent === "15", "the shown value");
  });
});

describe("Replace formula with value", () => {
  test("on a user formula cell: one set_value with replace leaves a literal", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    expect(
      within(row("ac")).queryByRole("button", { name: "Replace formula with value" }),
    ).toBeNull();
    await user.click(within(row("hp")).getByRole("button", { name: "Replace formula with value" }));
    await until(() => cellOf(session, "goblin", "hp")?.kind === "literal", "the literal");
    expect(transacts()).toEqual([
      expect.objectContaining({
        base_revision: 1,
        ops: [{ type: "set_value", object: "goblin", cell: "hp", value: num(9), replace: true }],
      }),
    ]);
    expect(cellOf(session, "goblin", "hp")).toEqual({ kind: "literal", value: num(9) });
    await until(() => within(row("hp")).queryByText("ƒ") === null, "the badge to go");
  });

  test("on an overridden formula cell it keeps the override's value", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    await user.click(
      within(row("temp")).getByRole("button", { name: "Replace formula with value" }),
    );
    await until(() => cellOf(session, "goblin", "temp")?.kind === "literal", "the literal");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "temp", value: num(20), replace: true },
    ]);
    expect(cellOf(session, "goblin", "temp")?.overridden).toBeUndefined();
  });

  test("on a zone's visible_to formula: one write leaves a literal viewers value", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup("room");
    expect(within(row("visible_to")).getByText(`=${REHIDE}`)).toBeDefined();
    await user.click(
      within(row("visible_to")).getByRole("button", { name: "Replace formula with value" }),
    );
    await until(() => cellOf(session, "room", "visible_to")?.kind === "literal", "the literal");
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      {
        type: "set_value",
        object: "room",
        cell: "visible_to",
        value: { type: "viewers", viewers: ["gm"] },
        replace: true,
      },
    ]);
    expect(cellOf(session, "room", "visible_to")).toEqual({
      kind: "literal",
      value: { type: "viewers", viewers: ["gm"] },
    });
  });

  test("an error value cannot replace a formula", async () => {
    await setup();
    const button = within(row("relay")).getByRole("button", {
      name: "Replace formula with value",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("structural rows", () => {
  test("board, container, contents, tag, shape and id offer no value editor", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    for (const name of [
      "board",
      "container",
      "contents",
      "tag",
      "shape",
      "id",
      "is_zone",
      "template",
    ]) {
      await user.dblClick(shown(name));
      expect(within(row(name)).queryByRole("textbox")).toBeNull();
      expect(within(row(name)).queryByRole("button", { name: "Rename" })).toBeNull();
      expect(within(row(name)).queryByRole("button", { name: "Delete" })).toBeNull();
    }
    expect(shown("board").textContent).toBe("gm_board");
    expect(transacts()).toEqual([]);
  });

  test("position accepts [3, 4]", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "position");
    expect(editor.value).toBe("[2, 0]");
    await user.clear(editor);
    await user.type(editor, "[[3, 4]{Enter}");
    await until(() => shown("position").textContent === "[3, 4]", "the new position");
    expect(transacts()[0]?.ops).toEqual([
      {
        type: "set_value",
        object: "goblin",
        cell: "position",
        value: { type: "list", items: [num(3), num(4)] },
      },
    ]);
    expect(cellOf(session, "goblin", "position")?.value).toEqual({
      type: "list",
      items: [num(3), num(4)],
    });
  });

  test("name and face_up edit generically; rename and delete are hidden for structural cells", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    expect(within(row("name")).queryByRole("button", { name: "Rename" })).toBeNull();
    expect(within(row("visible_to")).queryByRole("button", { name: "Delete" })).toBeNull();
    const editor = await openEditor(user, "face_up");
    expect(editor.value).toBe("true");
    await user.clear(editor);
    await user.type(editor, "false{Enter}");
    await until(
      () =>
        JSON.stringify(cellOf(session, "goblin", "face_up")?.value) ===
        '{"type":"boolean","value":false}',
      "face_up",
    );
  });
});

describe("add, rename, delete", () => {
  test("add, rename and delete a cell", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    await user.type(screen.getByRole("textbox", { name: "New cell name" }), "notes");
    await user.click(screen.getByRole("button", { name: "Add cell" }));
    await until(() => hasRow("notes"), "the notes row");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "notes", value: { type: "empty" } },
    ]);

    await user.click(within(row("notes")).getByRole("button", { name: "Rename" }));
    const rename = within(row("notes")).getByRole("textbox", { name: "Rename notes" });
    await user.clear(rename);
    await user.type(rename, "remarks{Enter}");
    await until(() => hasRow("remarks") && !hasRow("notes"), "the renamed row");
    expect(transacts()[1]?.ops).toEqual([
      { type: "rename_cell", object: "goblin", from: "notes", to: "remarks" },
    ]);

    await user.click(within(row("remarks")).getByRole("button", { name: "Delete" }));
    await until(() => !hasRow("remarks"), "the deleted row");
    expect(transacts()[2]?.ops).toEqual([
      { type: "delete_cell", object: "goblin", cell: "remarks" },
    ]);
    expect(cellOf(session, "goblin", "remarks")).toBeUndefined();
  });

  test("renaming onto an existing name, and adding an existing or invalid name, is refused locally", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    await user.click(within(row("ac")).getByRole("button", { name: "Rename" }));
    const rename = within(row("ac")).getByRole("textbox", { name: "Rename ac" });
    await user.clear(rename);
    await user.type(rename, "hp{Enter}");
    expect(within(row("ac")).getByRole("alert").textContent).toMatch(/already/);
    await user.clear(rename);
    await user.type(rename, "position{Enter}");
    expect(within(row("ac")).getByRole("alert").textContent).toMatch(/already/);
    await user.keyboard("{Escape}");
    expect(within(row("ac")).queryByRole("textbox", { name: "Rename ac" })).toBeNull();

    const name = screen.getByRole("textbox", { name: "New cell name" });
    await user.type(name, "hp");
    await user.click(screen.getByRole("button", { name: "Add cell" }));
    expect(screen.getByRole("alert").textContent).toMatch(/already/);
    await user.clear(name);
    await user.type(name, "__proto__");
    await user.click(screen.getByRole("button", { name: "Add cell" }));
    expect(screen.getByRole("alert").textContent).toMatch(/__proto__/);
    await user.clear(name);
    await user.click(screen.getByRole("button", { name: "Add cell" }));
    expect(transacts()).toEqual([]);
  });

  test("Max HP: add, give it a visibility rule, rename and back, and read it in backticks", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    await user.type(screen.getByRole("textbox", { name: "New cell name" }), "Max HP");
    await user.click(screen.getByRole("button", { name: "Add cell" }));
    await until(() => editorOf("Max HP") !== null, "the Max HP editor");
    const editor = editorOf("Max HP") as HTMLInputElement;
    expect(editor.value).toBe("empty");
    await user.clear(editor);
    await user.type(editor, "20{Enter}");
    await until(() => shown("Max HP").textContent === "20", "Max HP = 20");

    // A visibility rule.
    await user.type(screen.getByRole("textbox", { name: "Rule cell name" }), "Max HP");
    const picker = screen.getByRole("group", { name: "New rule viewers" });
    await user.click(within(picker).getByRole("checkbox", { name: "gm" }));
    await user.click(screen.getByRole("button", { name: "Add visibility rule" }));
    await until(() => cellOf(session, "goblin", "Max HP")?.visibility !== undefined, "the rule");
    expect(cellOf(session, "goblin", "Max HP")?.visibility).toEqual({
      type: "viewers",
      viewers: ["gm"],
    });
    await until(() => within(row("Max HP")).queryByLabelText(/^Visible to/) !== null, "the glyph");

    // Rename and back.
    for (const [from, to] of [
      ["Max HP", "Max Hit Points"],
      ["Max Hit Points", "Max HP"],
    ] as const) {
      await user.click(within(row(from)).getByRole("button", { name: "Rename" }));
      const rename = within(row(from)).getByRole("textbox", { name: `Rename ${from}` });
      await user.clear(rename);
      await user.type(rename, `${to}{Enter}`);
      await until(() => hasRow(to) && !hasRow(from), `the row renamed to ${to}`);
    }
    expect(cellOf(session, "goblin", "Max HP")?.visibility).toEqual({
      type: "viewers",
      viewers: ["gm"],
    });

    // Another cell reads it in backticks.
    const speed = await openEditor(user, "speed");
    await user.clear(speed);
    await user.type(speed, "=`Max HP` - damage_taken{Enter}");
    await until(() => shown("speed").textContent === "17", "speed = 17");
    expect(transacts().at(-1)?.ops).toEqual([
      { type: "set_formula", object: "goblin", cell: "speed", source: "`Max HP` - damage_taken" },
    ]);
  });

  test("a store refusal surfaces as a notice", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    // `name` refuses a formula only in the store; here `name` input is text,
    // so provoke a refusal with a type error instead: rotation expects a number.
    const editor = await openEditor(user, "rotation");
    await user.type(editor, '"sideways"{Enter}');
    const notices = sessionNotices(session);
    await until(() => notices.list().length > 0, "the refusal notice");
    expect(notices.list()[0]?.level).toBe("error");
  });
});

/** Records the elements `scrollIntoView` is called on (jsdom has none). */
function recordScrolls(): { scrolled: Element[]; restore(): void } {
  const scrolled: Element[] = [];
  const proto = Element.prototype as { scrollIntoView?: unknown };
  const had = Object.hasOwn(proto, "scrollIntoView");
  const previous = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  return {
    scrolled,
    restore: () => {
      if (had) proto.scrollIntoView = previous;
      else delete proto.scrollIntoView;
    },
  };
}

describe("the Cells section (vtt-nb8.25)", () => {
  test("the user cells have a Cells heading and the add-cell form precedes Structural", async () => {
    await setup();
    const heading = screen.getByRole("heading", { name: "Cells" });
    expect(heading.tagName).toBe("H4");
    const structural = screen.getByRole("button", { name: "Structural" });
    const input = screen.getByRole("textbox", { name: "New cell name" });
    const add = screen.getByRole("button", { name: "Add cell" });
    const visibility = screen.getByRole("heading", { name: "Visibility rules" });
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    // Heading, then the user cells, then the form, then Structural, then the rules.
    expect(follows(heading, row("ac"))).toBe(true);
    expect(follows(row("temp"), input)).toBe(true);
    expect(follows(input, add)).toBe(true);
    expect(follows(add, structural)).toBe(true);
    expect(follows(structural, visibility)).toBe(true);
    expect(follows(add, row("position"))).toBe(true);
  });

  test("Add cell scrolls the new row into view and focuses its value input", async () => {
    const scrolls = recordScrolls();
    try {
      const user = userEvent.setup();
      const { session, transacts } = await setup();
      await user.type(screen.getByRole("textbox", { name: "New cell name" }), "notes");
      await user.click(screen.getByRole("button", { name: "Add cell" }));
      await until(() => editorOf("notes") !== null, "the notes editor");
      const editor = editorOf("notes") as HTMLInputElement;
      await until(() => document.activeElement === editor, "the focused notes editor");
      expect(scrolls.scrolled).toContain(row("notes"));
      // The prefilled text is selected, so typing replaces it.
      await user.keyboard("7{Enter}");
      await until(() => cellOf(session, "goblin", "notes")?.value.type === "number", "notes = 7");
      expect(cellOf(session, "goblin", "notes")?.value).toEqual(num(7));
      expect(transacts().map((t) => t.ops)).toEqual([
        [{ type: "set_value", object: "goblin", cell: "notes", value: { type: "empty" } }],
        [{ type: "set_value", object: "goblin", cell: "notes", value: num(7) }],
      ]);
    } finally {
      scrolls.restore();
    }
  });

  test("vtt-qf5.48: Add cell with a value creates the cell and its value as one group, one undo", async () => {
    const user = userEvent.setup();
    const { session, transacts, groups } = await setup();
    const before = groups().length;
    await user.type(screen.getByRole("textbox", { name: "New cell name" }), "notes");
    // Enter in the value field submits, like Enter in the name field.
    await user.type(screen.getByRole("textbox", { name: "New cell value" }), "7{Enter}");
    await until(() => cellOf(session, "goblin", "notes")?.value.type === "number", "notes = 7");
    expect(cellOf(session, "goblin", "notes")?.value).toEqual(num(7));
    expect(transacts().map((t) => t.ops)).toEqual([
      [{ type: "set_value", object: "goblin", cell: "notes", value: num(7) }],
    ]);
    expect(groups().length).toBe(before + 1);
    expect(groups().at(-1)?.label).toBe("Add cell Goblin.notes");
    // Both fields clear; the row opens no editor, since the value is in.
    expect((screen.getByRole("textbox", { name: "New cell name" }) as HTMLInputElement).value).toBe(
      "",
    );
    expect(
      (screen.getByRole("textbox", { name: "New cell value" }) as HTMLInputElement).value,
    ).toBe("");
    expect(editorOf("notes")).toBeNull();

    // One undo removes the value and the cell.
    await undo(session);
    await until(() => !hasRow("notes"), "the notes row gone");
    expect(cellOf(session, "goblin", "notes")).toBeUndefined();
  });

  test("vtt-qf5.48: Add cell takes a formula value as the value editor does, and refuses a bad one", async () => {
    const user = userEvent.setup();
    const { session, transacts, groups } = await setup();
    const before = groups().length;
    const name = screen.getByRole("textbox", { name: "New cell name" });
    const value = screen.getByRole("textbox", { name: "New cell value" });
    await user.type(name, "bad");
    await user.type(value, "=1 +{Enter}");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(transacts()).toEqual([]);
    expect((name as HTMLInputElement).value).toBe("bad");

    await user.clear(name);
    await user.type(name, "double");
    await user.clear(value);
    await user.type(value, "=max_hp * 2");
    await user.click(screen.getByRole("button", { name: "Add cell" }));
    await until(() => shown("double").textContent === "24", "double = 24");
    expect(transacts().map((t) => t.ops)).toEqual([
      [{ type: "set_formula", object: "goblin", cell: "double", source: "max_hp * 2" }],
    ]);
    expect(groups().length).toBe(before + 1);
    expect(cellOf(session, "goblin", "double")).toMatchObject({
      kind: "formula",
      source: "max_hp * 2",
    });
  });

  test("the new cell's editor, left untouched, closes when focus moves to another field", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    const name = screen.getByRole("textbox", { name: "New cell name" });
    await user.type(name, "notes{Enter}");
    await until(() => document.activeElement === editorOf("notes"), "the focused notes editor");
    await user.click(name);
    await until(() => editorOf("notes") === null, "the closed notes editor");
    expect(shown("notes").textContent).toBe("empty");
    expect(transacts()).toHaveLength(1);
  });

  test("a value draft survives a window blur and writes nothing", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    const editor = await openEditor(user, "ac");
    await user.clear(editor);
    await user.type(editor, "15");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      // The window loses focus: the editor blurs while the document has no focus.
      fireEvent.blur(editor);
      fireEvent.focusOut(editor);
    } finally {
      hasFocus.mockRestore();
    }
    // The window comes back and the editor is focused again.
    editor.focus();
    expect(editorOf("ac")).toBe(editor);
    expect(editor.value).toBe("15");
    expect(transacts()).toEqual([]);
  });
});

describe("drafts belong to their object", () => {
  test("switching objects with a value draft open discards it and writes nothing", async () => {
    const user = userEvent.setup();
    const { session, rerender, transacts } = await setup();
    const editor = await openEditor(user, "name");
    await user.clear(editor);
    await user.type(editor, "Draft name");
    rerender("room");
    await until(() => shown("name").textContent === "Guard room", "the room's rows");
    expect(editorOf("name")).toBeNull();
    rerender("goblin");
    await until(() => shown("name").textContent === "Goblin", "the goblin's rows");
    expect(editorOf("name")).toBeNull();
    expect(transacts()).toEqual([]);
    expect(cellOf(session, "room", "name")?.value).toEqual(text("Guard room"));
  });

  test("switching objects with a rename draft open discards it and writes nothing", async () => {
    const user = userEvent.setup();
    const { session, rerender, transacts } = await setup();
    await user.click(within(row("ac")).getByRole("button", { name: "Rename" }));
    const rename = within(row("ac")).getByRole("textbox", { name: "Rename ac" });
    await user.clear(rename);
    await user.type(rename, "armor");
    rerender("room");
    await until(() => shown("ac").textContent === "10", "the room's ac");
    expect(within(row("ac")).queryByRole("textbox", { name: "Rename ac" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(transacts()).toEqual([]);
    expect(cellOf(session, "room", "ac")?.value).toEqual(num(10));
    expect(cellOf(session, "room", "armor")).toBeUndefined();
  });
});

describe("replacing with empty", () => {
  test("a roll replaced with empty writes empty", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "lastroll");
    expect(editor.value).toBe("");
    await user.type(editor, "empty{Enter}");
    await until(() => cellOf(session, "goblin", "lastroll")?.value.type === "empty", "empty");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "lastroll", value: { type: "empty" } },
    ]);
  });

  test("an error replaced with empty writes empty", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const editor = await openEditor(user, "target");
    expect(editor.value).toBe("");
    await user.type(editor, "empty{Enter}");
    await until(() => cellOf(session, "goblin", "target")?.value.type === "empty", "empty");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "target", value: { type: "empty" } },
    ]);
  });

  test("an untouched replace-value editor writes nothing", async () => {
    const user = userEvent.setup();
    const { transacts } = await setup();
    const editor = await openEditor(user, "lastroll");
    await user.type(editor, "{Enter}");
    expect(editorOf("lastroll")).toBeNull();
    expect(transacts()).toEqual([]);
  });
});
