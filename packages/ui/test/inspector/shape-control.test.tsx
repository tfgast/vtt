/**
 * The inspector's shape control (vtt-3l6.12; review r3 finding 12; FORMULAS.md
 * §3.1 `shape`; PROTOCOL.md §5 `set_shape`, §6): add, change kind and remove,
 * each one `set_shape` write captured at the click and one undoable group.
 * Conversions are pure; the commands run in jsdom against a real in-process
 * authority through the shared helper.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ObjectView, WireOp } from "@vtt/protocol";
import type { Shape } from "@vtt/schema";
import {
  ADD_SHAPE_DEFAULTS,
  convertShape,
  createUiStore,
  Inspector,
  shapeSummary,
  type TableSession,
  undo,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

afterEach(async () => {
  cleanup();
  await cleanupAuthorities();
});

describe("conversions", () => {
  test("Add shape defaults", () => {
    expect(ADD_SHAPE_DEFAULTS.rect).toEqual({ type: "rect", width: 1, height: 1 });
    expect(ADD_SHAPE_DEFAULTS.circle).toEqual({ type: "circle", radius: 0.5 });
    expect(ADD_SHAPE_DEFAULTS.polygon).toEqual({
      type: "polygon",
      points: [
        [0, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ],
    });
  });

  test("Change kind converts within the bounding box", () => {
    const rect: Shape = { type: "rect", width: 2, height: 4 };
    expect(convertShape(rect, "circle")).toEqual({ type: "circle", radius: 2 });
    expect(convertShape(rect, "polygon")).toEqual({
      type: "polygon",
      points: [
        [-1, -2],
        [1, -2],
        [1, 2],
        [-1, 2],
      ],
    });
    expect(convertShape({ type: "circle", radius: 1.5 }, "rect")).toEqual({
      type: "rect",
      width: 3,
      height: 3,
    });
    const triangle: Shape = {
      type: "polygon",
      points: [
        [0, -1],
        [3, 1],
        [-1, 1],
      ],
    };
    expect(convertShape(triangle, "rect")).toEqual({ type: "rect", width: 4, height: 2 });
    // Circle → polygon and polygon → circle go through the bounding rect.
    expect(convertShape({ type: "circle", radius: 1 }, "polygon")).toEqual({
      type: "polygon",
      points: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
    });
    expect(convertShape(triangle, "circle")).toEqual({ type: "circle", radius: 2 });
  });

  test("the summary shows kind and size", () => {
    expect(shapeSummary(null)).toBe("No shape");
    expect(shapeSummary({ type: "rect", width: 2, height: 1.5 })).toBe("rect 2 × 1.5");
    expect(shapeSummary({ type: "circle", radius: 0.5 })).toBe("circle r 0.5");
    expect(shapeSummary(ADD_SHAPE_DEFAULTS.polygon)).toBe("polygon, 3 points, 1 × 1");
  });
});

const text = (value: string) => ({ type: "text" as const, value });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

/** A shapeless pawn with cells, tags, rotation and z. */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "pawn",
    to: at(4, 3),
    init: {
      tag: ["pc"],
      cells: {
        name: text("Pawn"),
        hp: { type: "number", value: 7 },
        rotation: { type: "number", value: 30 },
        z: { type: "number", value: 2 },
        twice: { type: "formula", source: "hp * 2" },
      },
    },
  },
];

async function setup() {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.objectView("pawn") !== null, "the pawn view");
  const ui = createUiStore({ session });
  render(<Inspector session={session} ui={ui} />);
  act(() => ui.select(["pawn"]));
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number }),
  };
}

const control = () => screen.getByRole("group", { name: "Shape" });

function shapeOf(session: TableSession): Shape | null {
  const v = session.objectView("pawn")?.cells.shape?.value;
  return v?.type === "shape" ? v.shape : null;
}

/** Everything of the pawn's view except its shape. */
function rest(session: TableSession): Omit<ObjectView, "cells"> & { cells: object } {
  const view = session.objectView("pawn") as ObjectView;
  const { shape: _shape, ...cells } = view.cells;
  return { ...view, cells };
}

test("a shapeless pawn gets a circle, changes to a rect and loses its shape; each step undoes alone", async () => {
  const user = userEvent.setup();
  const { session, transacts } = await setup();
  const before = rest(session);
  expect(within(control()).getByText("No shape")).toBeDefined();
  expect(within(control()).queryByRole("button", { name: "Remove shape" })).toBeNull();

  // Add a circle.
  await user.click(within(control()).getByRole("button", { name: "Add circle" }));
  await until(() => shapeOf(session)?.type === "circle", "the circle");
  expect(transacts()[0]?.ops).toEqual([
    { type: "set_shape", object: "pawn", shape: { type: "circle", radius: 0.5 } },
  ]);
  expect(transacts()[0]?.base_revision).toBe(1);
  await until(() => within(control()).queryByText("circle r 0.5") !== null, "the summary");

  // Change to a rect: within the bounding box.
  await user.click(within(control()).getByRole("button", { name: "Change to rect" }));
  await until(() => shapeOf(session)?.type === "rect", "the rect");
  expect(transacts()[1]?.ops).toEqual([
    { type: "set_shape", object: "pawn", shape: { type: "rect", width: 1, height: 1 } },
  ]);
  expect(transacts()[1]?.base_revision).toBe(2);
  await until(() => within(control()).queryByText("rect 1 × 1") !== null, "the rect summary");

  // Remove.
  await user.click(within(control()).getByRole("button", { name: "Remove shape" }));
  await until(() => shapeOf(session) === null && session.getSnapshot().revision === 4, "removal");
  expect(transacts()[2]?.ops).toEqual([{ type: "set_shape", object: "pawn", shape: null }]);
  expect(transacts()[2]?.base_revision).toBe(3);
  expect(transacts()).toHaveLength(3);
  expect(rest(session)).toEqual(before);

  // Each write is one group: undo restores the previous shape, step by step.
  await act(() => undo(session));
  await until(() => shapeOf(session)?.type === "rect", "undo to the rect");
  expect(rest(session)).toEqual(before);
  await act(() => undo(session));
  await until(() => shapeOf(session)?.type === "circle", "undo to the circle");
  expect(shapeOf(session)).toEqual({ type: "circle", radius: 0.5 });
  expect(rest(session)).toEqual(before);
  await act(() => undo(session));
  await until(() => shapeOf(session) === null && session.getSnapshot().revision === 7, "undo");
  expect(rest(session)).toEqual(before);
});

test("Add rect and Add polygon write the defaults", async () => {
  const user = userEvent.setup();
  const { session, transacts } = await setup();
  await user.click(within(control()).getByRole("button", { name: "Add polygon" }));
  await until(() => shapeOf(session)?.type === "polygon", "the polygon");
  expect(transacts()[0]?.ops).toEqual([
    { type: "set_shape", object: "pawn", shape: ADD_SHAPE_DEFAULTS.polygon },
  ]);
  await until(
    () => within(control()).queryByRole("button", { name: "Change to rect" }) !== null,
    "the change buttons",
  );
  // The current kind is not offered.
  expect(within(control()).queryByRole("button", { name: "Change to polygon" })).toBeNull();
  await user.click(within(control()).getByRole("button", { name: "Change to rect" }));
  await until(() => shapeOf(session)?.type === "rect", "the rect");
  expect(shapeOf(session)).toEqual({ type: "rect", width: 1, height: 1 });
});
