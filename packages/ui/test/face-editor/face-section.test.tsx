/**
 * The inspector's Face section (vtt-1xv.18; DESIGN.md §4.6 The inspector,
 * Face layouts, View as in the UI; §7 Undo; PROTOCOL.md §5 `set_face`, §6)
 * in jsdom against a real in-process authority through the shared helper:
 * each edit is one `set_face` write of the whole layout carrying the revision
 * captured on focus (text fields) or at the click (buttons and pickers).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import type { FaceElement, FaceLayout } from "@vtt/schema";
import {
  createUiStore,
  defaultLayoutFor,
  FaceSection,
  layoutOfView,
  sessionNotices,
  type TableSession,
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
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

const FACE: FaceLayout = {
  elements: [
    { type: "value", cell: "name", rect: [-2, -1.5, 4, 0.6], style: { size: "large" } },
    { type: "value", cell: "hp", rect: [-2, -0.9, 2, 0.6], style: { caption: true } },
    { type: "button", action: "Roll", rect: [-2, 0.5, 1.5, 0.45] },
  ],
  default_action: "Roll",
};

const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(10, 10),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "tok",
    to: at(2, 2),
    init: {
      shape: { type: "rect", width: 4, height: 3 },
      cells: { name: text("Goblin"), hp: num(7), roll: { type: "empty" } },
      actions: [{ name: "Roll", steps: ["roll(1d20) -> roll"] }],
      face: FACE,
    },
  },
  {
    type: "create_object",
    id: "bare",
    to: at(6, 2),
    init: {
      shape: { type: "rect", width: 2, height: 2 },
      cells: { name: text("Bare"), hp: num(3) },
      actions: [{ name: "Roll", steps: ["roll(1d20) -> hp"] }],
    },
  },
];

async function setup(selected = "tok") {
  const authority = await authorityWithSeed();
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView(selected) !== null, "the object view");
  const ui = createUiStore({ session });
  render(<FaceSection session={session} ui={ui} />);
  act(() => ui.select([selected]));
  const other = await authority.client("other");
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

async function authorityWithSeed() {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  return authority;
}

const faceOf = (session: TableSession, id = "tok") => {
  const view = session.objectView(id);
  return view === null ? undefined : layoutOfView(view);
};

/** The cell of the full list's element at `index`, if it names one. */
const cellAt = (session: TableSession, index: number) => {
  const e = faceOf(session)?.elements[index];
  return e !== undefined && "cell" in e ? e.cell : undefined;
};

const section = () => screen.getByRole("region", { name: "Face" });
const element = (n: number) => within(section()).getByRole("listitem", { name: `Element ${n}` });

describe("editing fields", () => {
  test("editing x writes one set_face and one undo restores it", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const r = session.getSnapshot().revision;
    const x = within(element(2)).getByRole("textbox", { name: "x" });
    expect((x as HTMLInputElement).value).toBe("-2");
    await user.click(x);
    await user.clear(x);
    await user.type(x, "0.5{Enter}");
    await until(() => faceOf(session)?.elements[1]?.rect[0] === 0.5, "the moved element");
    expect(transacts()).toHaveLength(1);
    const sent = transacts()[0];
    expect(sent?.base_revision).toBe(r);
    expect(sent?.ops).toEqual([
      {
        type: "set_face",
        object: "tok",
        face: {
          ...FACE,
          elements: [
            FACE.elements[0],
            { ...FACE.elements[1], rect: [0.5, -0.9, 2, 0.6] },
            FACE.elements[2],
          ],
        },
      },
    ]);
    // Blur after Enter writes nothing more.
    await user.click(document.body);
    expect(transacts()).toHaveLength(1);

    await act(() => undo(session));
    await until(() => faceOf(session)?.elements[1]?.rect[0] === -2, "the undo");
    expect(faceOf(session)).toEqual(FACE);
  });

  test("unchanged input writes nothing; a write on blur", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const w = within(element(2)).getByRole("textbox", { name: "w" });
    await user.click(w);
    await user.click(document.body);
    await user.click(w);
    await user.keyboard("{Enter}");
    expect(transacts()).toHaveLength(0);
    await user.click(w);
    await user.clear(w);
    await user.type(w, "3");
    await user.click(document.body);
    await until(() => faceOf(session)?.elements[1]?.rect[2] === 3, "the resized element");
    expect(transacts()).toHaveLength(1);
  });

  test("show_when: hp < 5 is written; a parse error blocks the write", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const field = within(element(2)).getByRole("textbox", { name: "Show when" });
    await user.click(field);
    await user.type(field, "hp < 5{Enter}");
    await until(() => faceOf(session)?.elements[1]?.show_when === "hp < 5", "show_when");
    expect(transacts()).toHaveLength(1);

    await user.click(field);
    await user.clear(field);
    await user.type(field, "hp <");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(element(2)).getByRole("alert").textContent).not.toBe("");
    await user.keyboard("{Enter}");
    await user.click(document.body);
    expect(transacts()).toHaveLength(1);
    expect(faceOf(session)?.elements[1]?.show_when).toBe("hp < 5");

    // Empty clears.
    await user.click(field);
    await user.clear(field);
    await user.keyboard("{Enter}");
    await until(() => faceOf(session)?.elements[1]?.show_when === undefined, "cleared");
    expect(transacts()).toHaveLength(2);
  });

  test("an invalid layout is a notice and writes nothing", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup();
    const h = within(element(1)).getByRole("textbox", { name: "h" });
    await user.click(h);
    await user.clear(h);
    await user.type(h, "0{Enter}");
    const notices = sessionNotices(session);
    await until(
      () => notices.list().some((n) => n.text.includes("width and height")),
      "the notice",
    );
    expect(transacts()).toHaveLength(0);
  });

  test("a concurrent set_face between focus and Enter is stale and keeps the other face", async () => {
    const user = userEvent.setup();
    const { session, other, transacts } = await setup();
    const r = session.getSnapshot().revision;
    const x = within(element(2)).getByRole("textbox", { name: "x" });
    await user.click(x);
    // Another client changes the face (another element) after the focus.
    const theirs: FaceLayout = {
      ...FACE,
      elements: [
        FACE.elements[0] as FaceElement,
        { ...(FACE.elements[1] as FaceElement), rect: [-2, -0.9, 3, 0.6] },
        FACE.elements[2] as FaceElement,
      ],
    };
    await other.transact([{ type: "set_face", object: "tok", face: theirs }], {
      label: "Scribe sets the face",
    });
    await session.whenRevision(r + 1);
    await until(() => faceOf(session)?.elements[1]?.rect[2] === 3, "the other face");
    await user.clear(x);
    await user.type(x, "1{Enter}");
    const notices = sessionNotices(session);
    await until(() => notices.list().some((n) => n.kind === "stale"), "the stale notice");
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.base_revision).toBe(r);
    expect(notices.list().find((n) => n.kind === "stale")?.text).toContain("Scribe sets the face");
    expect(faceOf(session)).toEqual(theirs);
    expect(session.getSnapshot().revision).toBe(r + 1);
  });
});

describe("commands", () => {
  test("Create face then Remove face", async () => {
    const user = userEvent.setup();
    const { session, transacts } = await setup("bare");
    expect(within(section()).queryByRole("button", { name: "Remove face" })).toBeNull();
    const r = session.getSnapshot().revision;
    await user.click(within(section()).getByRole("button", { name: "Create face" }));
    await until(() => faceOf(session, "bare") instanceof Object, "the created face");
    const view = session.objectView("bare");
    if (view === null) throw new Error("no view");
    const expected = defaultLayoutFor(view);
    if (!expected.ok) throw new Error(expected.message);
    expect(faceOf(session, "bare")).toEqual(expected.face);
    expect(transacts()[0]).toMatchObject({ base_revision: r });
    await until(
      () => within(section()).queryByRole("listitem", { name: "Element 1" }) !== null,
      "rows",
    );

    await user.click(within(section()).getByRole("button", { name: "Remove face" }));
    await until(() => faceOf(session, "bare") === null, "the removed face");
    expect(transacts()[1]?.ops).toEqual([{ type: "set_face", object: "bare", face: null }]);
    await until(
      () => within(section()).queryByRole("button", { name: "Create face" }) !== null,
      "Create face again",
    );
  });

  test("add, move down and delete in the full list; the default action", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    await user.click(within(section()).getByRole("button", { name: "Add editor" }));
    await until(() => faceOf(session)?.elements.length === 4, "the added editor");
    expect(faceOf(session)?.elements[3]).toMatchObject({ type: "editor", cell: "hp" });
    // The contents button adds one contents element, then is disabled.
    await user.click(within(section()).getByRole("button", { name: "Add contents" }));
    await until(() => faceOf(session)?.elements.length === 5, "the contents element");
    await until(
      () =>
        (within(section()).getByRole("button", { name: "Add contents" }) as HTMLButtonElement)
          .disabled,
      "Add contents disabled",
    );
    await user.click(within(element(1)).getByRole("button", { name: "Move down" }));
    await until(() => cellAt(session, 0) === "hp" && cellAt(session, 1) === "name", "the reorder");
    await user.click(within(element(5)).getByRole("button", { name: "Delete element" }));
    await until(() => faceOf(session)?.elements.length === 4, "the delete");
    await user.selectOptions(
      within(section()).getByRole("combobox", { name: "Default action" }),
      "",
    );
    await until(() => faceOf(session)?.default_action === undefined, "no default action");
  });

  test("pickers write at the change: kind, cell and caption", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    await user.selectOptions(within(element(2)).getByRole("combobox", { name: "Kind" }), "editor");
    await until(() => faceOf(session)?.elements[1]?.type === "editor", "the kind");
    await user.selectOptions(within(element(2)).getByRole("combobox", { name: "Cell" }), "roll");
    await until(
      () => (faceOf(session)?.elements[1] as { cell?: string } | undefined)?.cell === "roll",
      "the cell",
    );
    await user.click(within(element(2)).getByRole("checkbox", { name: "Caption" }));
    await until(
      () => (faceOf(session)?.elements[1] as { style?: object } | undefined)?.style === undefined,
      "the caption cleared",
    );
  });

  test("the Collapsed tab edits the collapsed list", async () => {
    const user = userEvent.setup();
    const { session } = await setup();
    await user.click(within(section()).getByRole("tab", { name: "Collapsed" }));
    expect(within(section()).queryByRole("listitem", { name: "Element 1" })).toBeNull();
    await user.click(within(section()).getByRole("button", { name: "Add value" }));
    await until(() => faceOf(session)?.collapsed?.length === 1, "the collapsed element");
    expect(faceOf(session)?.collapsed?.[0]).toEqual({
      type: "value",
      cell: "hp",
      rect: [0, 0, 2, 0.6],
    });
    expect(faceOf(session)?.elements).toEqual(FACE.elements);
    const w = within(element(1)).getByRole("textbox", { name: "w" });
    await user.click(w);
    await user.clear(w);
    await user.type(w, "6{Enter}");
    await until(() => faceOf(session)?.collapsed?.[0]?.rect[2] === 6, "the collapsed width");
    expect(faceOf(session)?.elements).toEqual(FACE.elements);
  });
});

describe("view-as", () => {
  test("the section is read-only as Aldric", async () => {
    const { session, transacts } = await setup();
    await act(() =>
      session.setView(session.getSnapshot().activeBoard, { type: "character", id: "aldric" }),
    );
    await until(() => session.getSnapshot().viewer.type === "character", "view-as");
    await until(
      () => within(section()).queryByRole("listitem", { name: "Element 1" }) !== null,
      "rows",
    );
    for (const name of [
      "Add value",
      "Add editor",
      "Add button",
      "Add contents",
      "Remove face",
      "Create face",
      "Delete element",
      "Move up",
      "Move down",
    ]) {
      expect(within(section()).queryByRole("button", { name })).toBeNull();
    }
    const inputs = within(section()).queryAllByRole("textbox");
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect((input as HTMLInputElement).readOnly).toBe(true);
    for (const select of within(section()).queryAllByRole("combobox")) {
      expect((select as HTMLSelectElement).disabled).toBe(true);
    }
    // The character's view has no show_when source.
    expect(within(section()).queryByRole("textbox", { name: "Show when" })).toBeNull();
    expect(transacts()).toHaveLength(0);
  });
});
