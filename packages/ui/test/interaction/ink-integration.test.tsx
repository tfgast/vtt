/**
 * The ink and text tools against a real in-process authority (vtt-1xv.21;
 * M4-D13; DESIGN.md §4.6 Ink and text, §8.4 step 6). Composed as vtt-1xv.23
 * will: `BoardCanvas` over a face scene (`buildFaceScene`) drawn by the real
 * Canvas2D renderer with `drawFaceItem` into a `RecordingContext`, the real
 * runtime with the ink, text and select tools, `createInPlaceEditorPort`
 * with the `InPlaceEditor` in the canvas overlay, and the `edit_created`
 * continuation from `editCreatedHandler`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { canonicalJson, parseTable, serializeTable } from "@vtt/authority";
import type { WireOp } from "@vtt/protocol";
import type { Point, Stroke, TableFile, TableObject } from "@vtt/schema";
import {
  BoardCanvas,
  buildFaceScene,
  createCanvas2DRenderer,
  createFaceStateStore,
  createInkTool,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createRuntimeInputs,
  createSelectTool,
  createTextTool,
  createToolContext,
  createUiStore,
  drawFaceItem,
  EDIT_CREATED,
  editCreatedHandler,
  type FaceScene,
  faceCullBounds,
  ImageCache,
  INK_STROKE,
  InPlaceEditor,
  type InteractionRuntime,
  RecordingContext,
  sessionNotices,
  type TableSession,
  ToolRegistry,
  type UiStore,
  undo,
  useInteraction,
} from "@vtt/ui";
import { useMemo, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Each case drives several authority round trips through jsdom; slow on loaded CI runners (vtt-qf5.9).
vi.setConfig({ testTimeout: 30_000 });

import { cleanupAuthorities, startAuthority, until, whenReady } from "../support/authority";

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const BOARD = "gm_board";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    x: 0,
    y: 0,
    right: RECT.width,
    bottom: RECT.height,
    toJSON: () => ({}),
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await cleanupAuthorities();
});

const text = (value: string) => ({ type: "text" as const, value });

/** A sticky note (as the note tool makes one) at (2, 1), rotated 90°. */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "note",
    to: { type: "board", board: BOARD, position: [2, 1] },
    init: {
      shape: { type: "rect", width: 2, height: 2 },
      cells: {
        name: text("Note"),
        color: text("#fff3a0"),
        text: text(""),
        rotation: { type: "number", value: 90 },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Composition

function useStore<T>(subscribe: (fn: () => void) => () => void, get: () => T): T {
  return useSyncExternalStore(subscribe, get);
}

const faceState = createFaceStateStore();

function Board(props: {
  session: TableSession;
  ui: UiStore;
  runtime: InteractionRuntime;
  ctx: RecordingContext;
  scenes: FaceScene[];
}) {
  const { session, ui, runtime, ctx, scenes } = props;
  const { overlays, previews, handlers } = useInteraction({ runtime });
  const snapshot = useStore(
    (fn) => session.subscribe(fn),
    () => session.getSnapshot(),
  );
  const state = useStore(
    (fn) => ui.subscribe(fn),
    () => ui.getState(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewVersion keys the live board view
  const scene: FaceScene = useMemo(() => {
    const view = session.boardView();
    return buildFaceScene(
      {
        views: view === null ? [] : view.objects.values(),
        covers: view === null ? [] : [...view.covers.values()],
        board: view?.board ?? BOARD,
        viewer: snapshot.viewer,
        selection: state.selection,
        previews,
      },
      { faceState },
    );
  }, [session, snapshot.viewVersion, snapshot.viewer, state.selection, previews]);
  scenes.push(scene);
  return (
    <BoardCanvas<FaceScene>
      scene={scene}
      toolOverlays={overlays}
      camera={state.camera}
      setViewport={ui.setViewport}
      createRenderer={() =>
        createCanvas2DRenderer<FaceScene>(ctx, {
          images: new ImageCache({ resolve: (p) => p }),
          drawItem: drawFaceItem,
          cullBounds: faceCullBounds,
        })
      }
      overlay={<InPlaceEditor session={session} ui={ui} camera={state.camera} scene={scene} />}
      {...handlers}
    />
  );
}

async function setup() {
  const authority = await startAuthority();
  const gm = await authority.client("gm");
  await gm.transact(SEED, { label: "Seed" });
  const session = authority.session();
  await whenReady(session);
  const ui = createUiStore({ session });
  await ui.setActiveBoard(BOARD);
  await until(() => session.boardView()?.objects.has("note") === true, "the board view");

  const inputs = createRuntimeInputs(session, ui);
  const editor = createInPlaceEditorPort(ui);
  const registry = new ToolRegistry();
  registry.register(createSelectTool());
  registry.register(createInkTool());
  registry.register(createTextTool());
  const runtime = createInteractionRuntime({
    registry,
    inputs,
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor,
    whenRevision: (r) => session.whenRevision(r),
    extensions: { continuations: { [EDIT_CREATED]: editCreatedHandler({ editor, inputs }) } },
  });
  const ctx = new RecordingContext();
  const scenes: FaceScene[] = [];
  const utils = render(
    <Board session={session} ui={ui} runtime={runtime} ctx={ctx} scenes={scenes} />,
  );
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await waitFor(() => expect(ui.getState().viewport.width).toBe(800));

  const object = (id: string): TableObject | undefined =>
    authority.host.table.store.getObject(id) as TableObject | undefined;
  const content = (id: string, cell: string) => object(id)?.cells[cell]?.content;
  const created = (prefix: string): string[] =>
    authority.host.table.store
      .objectsOnBoard(BOARD)
      .filter((id) => new RegExp(`^${prefix}_\\d+$`).test(id));
  return { authority, gm, session, ui, runtime, canvas, ctx, scenes, object, content, created };
}

/** Screen point of a board point under the default camera and the 800 × 600 canvas. */
const screenOf = (board: Point): Point => [400 + board[0] * 64, 300 + board[1] * 64];

function pointer(
  kind: "pointerDown" | "pointerMove" | "pointerUp",
  canvas: HTMLCanvasElement,
  at: Point,
  mods: { shiftKey?: boolean } = {},
) {
  const [x, y] = screenOf(at);
  act(() => {
    fireEvent[kind](canvas, {
      pointerId: 1,
      clientX: x,
      clientY: y,
      button: kind === "pointerMove" ? -1 : 0,
      buttons: kind === "pointerUp" ? 0 : 1,
      ...mods,
    });
  });
}

function drawStroke(canvas: HTMLCanvasElement, points: Point[]) {
  const [first, ...rest] = points as [Point, ...Point[]];
  pointer("pointerDown", canvas, first);
  for (const p of rest.slice(0, -1)) pointer("pointerMove", canvas, p);
  pointer("pointerUp", canvas, rest.at(-1) ?? first);
}

/** Every number in `json` has at most three decimals (vtt-qf5.44). */
function expectShortNumbers(json: string) {
  for (const n of json.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []) {
    expect(n).toMatch(/^-?\d+(\.\d{1,3})?$/);
  }
}

function expectPoints(actual: unknown, expected: Point[][]) {
  const strokes = actual as Point[][];
  expect(strokes).toHaveLength(expected.length);
  strokes.forEach((s, i) => {
    s.forEach((p, j) => {
      const e = (expected[i] as Point[])[j] as Point;
      expect(p[0]).toBeCloseTo(e[0], 9);
      expect(p[1]).toBeCloseTo(e[1], 9);
    });
    expect(s).toHaveLength((expected[i] as Point[]).length);
  });
}

// ---------------------------------------------------------------------------

describe("ink tool", () => {
  test("a stroke on a sticky note appends to its ink cell; its default face carries and draws it", async () => {
    const c = await setup();
    act(() => c.ui.setTool("ink"));
    // Board points over the note rotated 90° about (2, 1): local = (dy, -dx).
    drawStroke(c.canvas, [
      [2, 1.5],
      [2, 1.75],
      [1.5, 1.75],
    ]);
    const local: Point[][] = [
      [
        [0.5, 0],
        [0.75, 0],
        [0.75, 0.5],
      ],
    ];
    await until(() => c.content("note", "ink")?.type === "ink", "the note's ink");
    const ink = c.content("note", "ink") as { type: "ink"; strokes: Point[][] };
    expectPoints(ink.strokes, local);
    // The stored points are rounded to 0.001: no float noise from the rotation (vtt-qf5.44).
    expect(ink.strokes).toEqual(local);
    expectShortNumbers(JSON.stringify(ink));
    expect(c.created("ink")).toEqual([]);
    expect(c.runtime.machine().tool).toBe("ink");
    // The authority has the first stroke before the session does. The second
    // stroke captures its base (the note's ink and the revision) from the
    // session at pointer down, so it must wait for the session to catch up:
    // drawn earlier, it rebuilds the ink from a stale base and is refused as a
    // stale_write, and the second stroke never lands (vtt-qf5.60).
    await c.session.whenRevision(c.authority.host.table.store.revision);
    await until(
      () => c.session.objectView("note")?.cells.ink?.value.type === "ink",
      "the session's view of the first stroke",
    );

    // A second stroke appends.
    drawStroke(c.canvas, [
      [2.5, 1],
      [2.5, 0.5],
    ]);
    await until(
      () =>
        (c.content("note", "ink") as { strokes?: unknown[] } | undefined)?.strokes?.length === 2,
      "the second stroke",
    );
    const both: Point[][] = [
      ...local,
      [
        [0, -0.5],
        [-0.5, -0.5],
      ],
    ];
    expectPoints((c.content("note", "ink") as { strokes: Point[][] }).strokes, both);

    // The face model (vtt-1xv.14) carries it once the session has it ...
    await waitFor(() => {
      const face = c.scenes.at(-1)?.faces.get("note");
      const primitive = face?.primitives.find((p) => p.kind === "ink");
      expect(primitive).toBeDefined();
      expectPoints((primitive as { strokes: Point[][] }).strokes, both);
    });
    // ... and the renderer (vtt-1xv.15) strokes it in the note's frame with the one pen.
    await waitFor(() => {
      const strokes = c.ctx.paints.filter(
        (p) => p.name === "stroke" && p.style?.strokeStyle === INK_STROKE,
      );
      expect(strokes.length).toBeGreaterThanOrEqual(2);
    });
    const last = c.ctx.paints.filter(
      (p) => p.name === "stroke" && p.style?.strokeStyle === INK_STROKE,
    );
    // The note's frame is rotated 90°: the transform's b component is positive.
    expect(last.at(-1)?.transform[1]).toBeGreaterThan(0);
  });

  test("a stroke on empty board creates an ink_<n> object", async () => {
    const c = await setup();
    act(() => c.ui.setTool("ink"));
    drawStroke(c.canvas, [
      [-4, -2],
      [-3, -2.5],
      [-2, -2],
    ]);
    await until(() => c.created("ink").length === 1, "the ink object");
    const [id] = c.created("ink") as [string];
    expect(id).toMatch(/^ink_\d+$/);
    const obj = c.object(id);
    expect(obj?.shape).toEqual({ type: "rect", width: 2, height: 0.5 });
    expect(c.content(id, "color")).toEqual(text("transparent"));
    expect(c.content(id, "name")).toEqual(text("Ink"));
    const position = c.content(id, "position");
    expect(position).toEqual({
      type: "list",
      items: [
        { type: "number", value: -3 },
        { type: "number", value: -2.25 },
      ],
    });
    expectPoints((c.content(id, "ink") as { strokes: Point[][] }).strokes, [
      [
        [-1, 0.25],
        [0, -0.25],
        [1, 0.25],
      ],
    ]);
    expectShortNumbers(JSON.stringify(c.content(id, "ink")));
    expect(c.content("note", "ink")).toBeUndefined();
    expect(c.runtime.machine().tool).toBe("ink");
  });

  test("an off-grid stroke on the rotated note is stored with short decimals (vtt-qf5.44)", async () => {
    const c = await setup();
    act(() => c.ui.setTool("ink"));
    drawStroke(c.canvas, [
      [2.013, 1.31],
      [2.27, 1.777],
      [1.41, 1.903],
    ]);
    await until(() => c.content("note", "ink")?.type === "ink", "the note's ink");
    const ink = c.content("note", "ink") as { type: "ink"; strokes: Point[][] };
    expect(ink.strokes).toHaveLength(1);
    expect(ink.strokes[0]).toHaveLength(3);
    expectShortNumbers(JSON.stringify(ink));

    // Round trip through the save file, written as the host saves it.
    const host = c.authority.host;
    const saved = canonicalJson(serializeTable(host.table.store, host.assets));
    const file = JSON.parse(saved) as TableFile;
    const savedInk = file.snapshot.objects.note?.cells.ink?.content;
    expect(savedInk).toEqual(ink);
    expectShortNumbers(JSON.stringify(savedInk));
    const reloaded = parseTable(saved);
    expect(reloaded.editedExternally).toBe(false);
    const back = (reloaded.store.getObject("note") as TableObject | undefined)?.cells.ink?.content;
    expect(back).toEqual(ink);
  });

  test("a concurrent write to the note's ink between pointer down and up yields stale_write", async () => {
    const c = await setup();
    act(() => c.ui.setTool("ink"));
    pointer("pointerDown", c.canvas, [2, 1.5]);
    pointer("pointerMove", c.canvas, [2, 1.75]);
    const theirs = { type: "ink" as const, strokes: [[[0, 0] as Point, [0.1, 0.1] as Point]] };
    await c.gm.transact([{ type: "set_value", object: "note", cell: "ink", value: theirs }], {
      label: "Their ink",
    });
    const revision = c.authority.host.table.store.revision;
    await c.session.whenRevision(revision);
    const request = vi.spyOn(c.session.client, "request");
    pointer("pointerUp", c.canvas, [1.5, 1.75]);
    await until(
      () =>
        sessionNotices(c.session)
          .list()
          .some((n) => n.kind === "stale"),
      "the stale notice",
    );
    const transacts = request.mock.calls.filter(([m]) => m === "transact");
    expect(transacts).toHaveLength(1);
    expect(
      ((transacts[0] as unknown[])[1] as { base_revision: number }).base_revision,
    ).toBeLessThan(revision);
    expect(c.content("note", "ink")).toEqual(theirs);
  });
});

describe("ink pen and eraser (vtt-qf5.27, M6-D28)", () => {
  /** The note, unrotated at (-2, -1), with three strokes: two horizontal (one red, wide) and one far. */
  async function seedStrokes(c: Awaited<ReturnType<typeof setup>>) {
    const strokes: Stroke[] = [
      [
        [-0.5, 0],
        [0.5, 0],
      ],
      {
        points: [
          [-0.5, 0.4],
          [0.5, 0.4],
        ],
        color: "#d32f2f",
        width: 0.16,
      },
      [
        [-0.5, -0.8],
        [0.5, -0.8],
      ],
    ];
    await c.gm.transact(
      [
        {
          type: "create_object",
          id: "pad",
          to: { type: "board", board: BOARD, position: [-2, -1] },
          init: {
            shape: { type: "rect", width: 2, height: 2 },
            cells: { name: text("Pad"), ink: { type: "ink", strokes } },
          },
        },
      ],
      { label: "Pad" },
    );
    await c.session.whenRevision(c.authority.host.table.store.revision);
    await until(
      () => c.session.objectView("pad")?.cells.ink?.value.type === "ink",
      "the session's view of the pad's ink",
    );
    return strokes;
  }

  test("a stroke drawn with a colour and width reaches the cell with them", async () => {
    const c = await setup();
    act(() => c.ui.setTool("ink", { color: "#1e63d6", width: 0.08, eraser: false }));
    drawStroke(c.canvas, [
      [2, 1.5],
      [2, 1.75],
    ]);
    await until(() => c.content("note", "ink")?.type === "ink", "the note's ink");
    const [s] = (c.content("note", "ink") as { strokes: unknown[] }).strokes;
    expect(s).toMatchObject({ color: "#1e63d6", width: 0.08 });
    await waitFor(() => {
      const blue = c.ctx.paints.filter(
        (p) => p.name === "stroke" && p.style?.strokeStyle === "#1e63d6",
      );
      expect(blue.length).toBeGreaterThanOrEqual(1);
      expect(blue.at(-1)?.style?.lineWidth).toBeCloseTo(0.08);
    });
  });

  test("an eraser drag removes the two strokes it crosses in one group; one undo restores both", async () => {
    const c = await setup();
    const strokes = await seedStrokes(c);
    const before = c.authority.host.table.store.revision;
    act(() => c.ui.setTool("ink", { color: "#202020", width: 0.04, eraser: true }));
    // Down the pad's middle at x = -2, from local y = -0.3 to 0.6: crosses strokes 0 and 1.
    drawStroke(c.canvas, [
      [-2, -1.3],
      [-2, -0.8],
      [-2, -0.4],
    ]);
    await until(
      () => (c.content("pad", "ink") as { strokes?: unknown[] } | undefined)?.strokes?.length === 1,
      "the erase",
    );
    expect(c.content("pad", "ink")).toEqual({ type: "ink", strokes: [strokes[2]] });
    const store = c.authority.host.table.store;
    expect(store.revision).toBe(before + 1);
    const groups = store.history.groups();
    expect(groups.at(-1)?.label).toBe("Erase ink on Pad");
    expect(c.created("ink")).toEqual([]);

    await c.session.whenRevision(store.revision);
    await act(async () => {
      await undo(c.session);
    });
    await until(
      () => (c.content("pad", "ink") as { strokes?: unknown[] } | undefined)?.strokes?.length === 3,
      "the undo",
    );
    expect(c.content("pad", "ink")).toEqual({ type: "ink", strokes });
  });

  test("an eraser drag crossing nothing writes nothing", async () => {
    const c = await setup();
    await seedStrokes(c);
    const revision = c.authority.host.table.store.revision;
    act(() => c.ui.setTool("ink", { color: "#202020", width: 0.04, eraser: true }));
    const request = vi.spyOn(c.session.client, "request");
    drawStroke(c.canvas, [
      [-4, 3],
      [-3, 3.5],
      [-2, 3],
    ]);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(request.mock.calls.filter(([m]) => m === "transact")).toEqual([]);
    expect(c.authority.host.table.store.revision).toBe(revision);
    expect(c.created("ink")).toEqual([]);
  });
});

describe("text tool", () => {
  test("a click creates a text_<n> object, selects it and opens the editor on its text", async () => {
    const c = await setup();
    act(() => c.ui.setTool("text"));
    pointer("pointerDown", c.canvas, [-3, 3]);
    pointer("pointerUp", c.canvas, [-3, 3]);
    await until(() => c.created("text").length === 1, "the text object");
    const [id] = c.created("text") as [string];
    expect(id).toMatch(/^text_\d+$/);
    expect(c.object(id)?.shape).toEqual({ type: "rect", width: 4, height: 1 });
    expect(c.content(id, "text")).toEqual(text(""));
    expect(c.content(id, "color")).toEqual(text("transparent"));
    expect(c.content(id, "name")).toEqual(text("Text"));
    await until(() => c.ui.getState().selection.includes(id), "the selection");
    await until(() => c.runtime.machine().tool === "select", "the select tool");

    const field = await screen.findByRole("textbox", { name: "Edit text" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    // Typing commits with a base revision that includes the creation: no stale_write.
    // An empty text cell opens blank, not as its literal `""` (vtt-qf5.43): typing needs no clearing.
    expect((field as HTMLTextAreaElement).value).toBe("");
    await userEvent.type(field, "trap on the third stair{Enter}");
    await until(
      () => (c.content(id, "text") as { value?: string } | undefined)?.value !== "",
      "the typed text",
    );
    expect(c.content(id, "text")).toEqual(text("trap on the third stair"));
    expect(
      sessionNotices(c.session)
        .list()
        .filter((n) => n.kind === "stale"),
    ).toEqual([]);
  });

  test("committing the blank editor of a new text object writes nothing (vtt-qf5.43)", async () => {
    const c = await setup();
    act(() => c.ui.setTool("text"));
    pointer("pointerDown", c.canvas, [-3, 3]);
    pointer("pointerUp", c.canvas, [-3, 3]);
    await until(() => c.created("text").length === 1, "the text object");
    const [id] = c.created("text") as [string];
    const field = await screen.findByRole("textbox", { name: "Edit text" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    const revision = c.session.getSnapshot().revision;
    await userEvent.type(field, "{Enter}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit text" })).toBeNull());
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(c.session.getSnapshot().revision).toBe(revision);
    expect(c.content(id, "text")).toEqual(text(""));
  });

  test("with Shift held the text tool stays active", async () => {
    const c = await setup();
    act(() => c.ui.setTool("text"));
    pointer("pointerDown", c.canvas, [-3, 3], { shiftKey: true });
    pointer("pointerUp", c.canvas, [-3, 3], { shiftKey: true });
    await until(() => c.created("text").length === 1, "the text object");
    await screen.findByRole("textbox", { name: "Edit text" });
    expect(c.runtime.machine().tool).toBe("text");
  });
});
