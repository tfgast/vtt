/**
 * The inspector's Fog checkbox on zones (vtt-nb8.27; DESIGN.md §4.4, §4.6 The
 * inspector, §8.4 step 3). Checked writes the zone tools' `FOG_CELLS`
 * (`opaque` true, `visible_to` gm) as one group "Fog on <name>"; unchecked
 * writes `opaque` false and `visible_to` all as one group "Fog off <name>".
 * Both are plain `set_value`s, so a formula cell keeps its formula under an
 * override. The checkbox shows the evaluated state: checked, unchecked, or
 * indeterminate. Its visible text is "Fog" and its accessible name "Zone
 * fog", so it never collides with the toolbar's Fog option. Runs in jsdom against a real in-process authority.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp } from "@vtt/protocol";
import type { ObjectId, OpGroup } from "@vtt/schema";
import { createUiStore, FOG_CELLS, Inspector, type TableSession, undo } from "@vtt/ui";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanupAuthorities,
  startAuthority,
  type TestAuthority,
  until,
  whenReady,
} from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

const REHIDE = 'if(len(contents(this).where(tag has "pc")) > 0, all, gm)';
const text = (value: string) => ({ type: "text" as const, value });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});
const rect = { type: "rect" as const, width: 4, height: 4 };

const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "plain",
    to: at(0, 0),
    init: { is_zone: true, shape: rect, cells: { name: text("Plain") } },
  },
  {
    type: "create_object",
    id: "room2",
    to: at(10, 0),
    init: {
      is_zone: true,
      shape: rect,
      cells: {
        name: text("Room 2"),
        opaque: { type: "boolean", value: true },
        visible_to: { type: "formula", source: REHIDE },
      },
    },
  },
  {
    type: "create_object",
    id: "odd",
    to: at(20, 0),
    init: {
      is_zone: true,
      shape: rect,
      cells: {
        name: text("Odd"),
        opaque: { type: "boolean", value: true },
        visible_to: { type: "viewers", viewers: ["all"] },
      },
    },
  },
  {
    type: "create_object",
    id: "pawn",
    to: at(30, 0),
    init: { cells: { name: text("Pawn") } },
  },
];

async function setup(object: ObjectId) {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  const seeded = await seed.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView(object) !== null, "the object's view");
  const ui = createUiStore({ session });
  render(<Inspector session={session} ui={ui} />);
  act(() => ui.select([object]));
  const request = vi.spyOn(session.client, "request");
  return {
    authority,
    session,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number; label?: string }),
  };
}

const groups = (authority: TestAuthority): readonly OpGroup[] =>
  authority.host.table.store.history.groups() as readonly OpGroup[];
const stored = (authority: TestAuthority, object: ObjectId, cell: string): unknown =>
  authority.host.table.store.getObject(object)?.cells[cell];
const fog = () =>
  within(screen.getByRole("region", { name: "Object" })).getByRole("checkbox", {
    name: "Zone fog",
  }) as HTMLInputElement;
const state = () =>
  fog().indeterminate ? "indeterminate" : fog().checked ? "checked" : "unchecked";

function evaluated(session: TableSession, object: ObjectId) {
  const view = session.objectView(object);
  return { opaque: view?.cells.opaque?.value, visible_to: view?.cells.visible_to?.value };
}

test("FOG_CELLS are opaque true and visible_to gm; the box reads Fog", async () => {
  await setup("plain");
  expect(fog().closest("label")?.textContent?.trim()).toBe("Fog");
  expect(FOG_CELLS).toEqual({
    opaque: { type: "boolean", value: true },
    visible_to: { type: "viewers", viewers: ["gm"] },
  });
});

test("a zone made without fog gets both cells after one click, as one group; unchecking writes opaque false and visible_to all", async () => {
  const user = userEvent.setup();
  const { authority, session, transacts } = await setup("plain");
  expect(state()).toBe("unchecked");
  expect(fog().disabled).toBe(false);
  const before = groups(authority).length;

  await user.click(fog());
  await until(() => state() === "checked", "the checked box");
  expect(transacts()).toHaveLength(1);
  expect(transacts()[0]?.ops).toEqual([
    { type: "set_value", object: "plain", cell: "opaque", value: FOG_CELLS.opaque },
    { type: "set_value", object: "plain", cell: "visible_to", value: FOG_CELLS.visible_to },
  ]);
  expect(transacts()[0]?.base_revision).toBe(1);
  expect(groups(authority)).toHaveLength(before + 1);
  expect(groups(authority).at(-1)?.label).toBe("Fog on Plain");
  expect(stored(authority, "plain", "opaque")).toEqual({
    content: { type: "boolean", value: true },
  });
  expect(evaluated(session, "plain")).toEqual({
    opaque: { type: "boolean", value: true },
    visible_to: { type: "viewers", viewers: ["gm"] },
  });

  await user.click(fog());
  await until(() => state() === "unchecked", "the unchecked box");
  expect(transacts()).toHaveLength(2);
  expect(transacts()[1]?.ops).toEqual([
    {
      type: "set_value",
      object: "plain",
      cell: "opaque",
      value: { type: "boolean", value: false },
    },
    {
      type: "set_value",
      object: "plain",
      cell: "visible_to",
      value: { type: "viewers", viewers: ["all"] },
    },
  ]);
  expect(groups(authority)).toHaveLength(before + 2);
  expect(groups(authority).at(-1)?.label).toBe("Fog off Plain");
  expect(evaluated(session, "plain")).toEqual({
    opaque: { type: "boolean", value: false },
    visible_to: { type: "viewers", viewers: ["all"] },
  });
});

test("Ctrl+Z reverses one toggle as one group", async () => {
  const user = userEvent.setup();
  const { authority, session } = await setup("plain");
  await user.click(fog());
  await until(() => state() === "checked", "the checked box");
  await act(() => undo(session));
  await until(() => state() === "unchecked", "the undone toggle");
  expect(stored(authority, "plain", "opaque")).toBeUndefined();
  expect(stored(authority, "plain", "visible_to")).toBeUndefined();
  expect(session.objectView("plain")?.cells.opaque?.value ?? null).not.toEqual({
    type: "boolean",
    value: true,
  });
});

test("a re-hiding room shows checked; toggling off then on keeps the formula under an override", async () => {
  const user = userEvent.setup();
  const { authority, session } = await setup("room2");
  const formula = { type: "formula", source: REHIDE };
  expect(state()).toBe("checked");
  expect(stored(authority, "room2", "visible_to")).toEqual({ content: formula });

  await user.click(fog());
  await until(() => state() === "unchecked", "fog off");
  expect(groups(authority).at(-1)?.label).toBe("Fog off Room 2");
  expect(stored(authority, "room2", "visible_to")).toEqual({
    content: formula,
    override: { type: "viewers", viewers: ["all"] },
  });
  expect(stored(authority, "room2", "opaque")).toEqual({
    content: { type: "boolean", value: false },
  });

  await user.click(fog());
  await until(() => state() === "checked", "fog on");
  expect(groups(authority).at(-1)?.label).toBe("Fog on Room 2");
  expect(stored(authority, "room2", "visible_to")).toEqual({
    content: formula,
    override: { type: "viewers", viewers: ["gm"] },
  });
  expect(session.objectView("room2")?.cells.visible_to?.overridden).toBe(true);
  expect(evaluated(session, "room2")).toEqual({
    opaque: { type: "boolean", value: true },
    visible_to: { type: "viewers", viewers: ["gm"] },
  });
});

test("opaque true with visible_to all shows indeterminate; clicking turns fog on", async () => {
  const user = userEvent.setup();
  const { authority } = await setup("odd");
  expect(state()).toBe("indeterminate");
  await user.click(fog());
  await until(() => state() === "checked", "fog on");
  expect(groups(authority).at(-1)?.label).toBe("Fog on Odd");
});

test("the checkbox is absent on a non-zone", async () => {
  await setup("pawn");
  const header = screen.getByRole("region", { name: "Object" });
  expect(within(header).getByRole("checkbox", { name: "Character" })).toBeDefined();
  expect(within(header).queryByRole("checkbox", { name: "Zone fog" })).toBeNull();
});
