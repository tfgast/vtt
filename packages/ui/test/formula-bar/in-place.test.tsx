/**
 * The in-place editor (vtt-3l6.13; DESIGN.md §4.6 Edit in place, Default
 * rendering until faces, Typing into a cell, Appearance cells (covers), View
 * as in the UI; §7 Platform (a DOM overlay over the cell); §5.2 base
 * revisions; M5 plan Q1 A5 (`rect`)). jsdom against a real in-process
 * authority, composed as vtt-3l6.17 will: `BoardCanvas` over a recording
 * context, the interaction runtime with a double-click tool defined here,
 * `createInPlaceEditorPort`, the `InPlaceEditor` in the canvas overlay and
 * the `FormulaBar`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellView, WireOp } from "@vtt/protocol";
import type { Bounds, Point } from "@vtt/schema";
import {
  BoardCanvas,
  buildScene,
  type CoverItem,
  captureStamp,
  createCanvas2DRenderer,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createRuntimeInputs,
  createToolContext,
  createUiStore,
  type EditorPort,
  FormulaBar,
  hitTest,
  ImageCache,
  InPlaceEditor,
  type InteractionRuntime,
  type InteractionStamp,
  inPlaceEditRequest,
  RecordingContext,
  type Scene,
  sessionNotices,
  type TableSession,
  type Tool,
  ToolRegistry,
  type ToolState,
  type UiStore,
  useInteraction,
} from "@vtt/ui";
import { useMemo, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
const num = (value: number) => ({ type: "number" as const, value });
const formula = (source: string) => ({ type: "formula" as const, source });
const ref = (object: string) => ({ type: "ref" as const, object });
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: BOARD,
  position: [x, y] as [number, number],
});
const rect = (width: number, height: number) => ({ type: "rect" as const, width, height });

/**
 * A note (`text`), a token (no `text`), a sign whose `text` is a formula, a
 * big 6 × 4 object, Aldric, `goblin2`, a memo whose `text` and `note` are `""`, and the goblin with an overridden
 * formula, a roll, a dangling ref and a tiny number.
 */
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(-20, -20),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "note",
    to: at(2, 1),
    init: { shape: rect(2, 1), cells: { name: text("Note"), text: text("hello") } },
  },
  {
    type: "create_object",
    id: "tok",
    to: at(-2, 0),
    init: { shape: { type: "circle", radius: 0.5 }, cells: { name: text("Goblin") } },
  },
  {
    type: "create_object",
    id: "sign",
    to: at(0, 3),
    init: {
      shape: rect(2, 1),
      cells: { name: text("Sign"), max_hp: num(5), text: formula("max_hp - 1") },
    },
  },
  {
    type: "create_object",
    id: "big",
    to: at(10, 0),
    init: { shape: rect(6, 4), cells: { name: text("Big"), text: text("big") } },
  },
  {
    type: "create_object",
    id: "goblin2",
    to: at(-20, 10),
    init: { cells: { name: text("Goblin 2") } },
  },
  { type: "create_object", id: "ghost", to: at(-20, 12), init: { cells: { name: text("Ghost") } } },
  {
    type: "create_object",
    id: "memo",
    to: at(-5, -3),
    init: { shape: rect(2, 1), cells: { name: text("Memo"), text: text(""), note: text("") } },
  },
  {
    type: "create_object",
    id: "goblin",
    to: at(-2, 3),
    init: {
      shape: rect(1, 1),
      cells: {
        name: text("Gob"),
        max_hp: num(12),
        temp: formula("max_hp + 1"),
        lastroll: { type: "roll", expr: "1d20", dice: [17], dropped: [], total: 17 },
        target: ref("ghost"),
        tiny: num(1e-7),
      },
    },
  },
  { type: "set_value", object: "goblin", cell: "temp", value: num(20) },
  { type: "remove", object: "ghost" },
];

// ---------------------------------------------------------------------------
// The double-click tool: opens the editor on the object under the pointer.

function editTool(): Tool<null> {
  return {
    id: "select",
    init: (options) => ({ tool: "select", options, phase: null }) as ToolState<null>,
    cursor: () => "default",
    reduce(state, event, input) {
      if (event.type !== "double_click") return { state, effects: [] };
      const hit = hitTest(input.scene, event.board, input.camera);
      const stamp = captureStamp(input);
      if (hit === null || stamp === null) return { state, effects: [] };
      return { state, effects: [{ type: "open_editor", stamp, object: hit }] };
    },
    cancel: (state) => ({ state, effects: [] }),
  };
}

// ---------------------------------------------------------------------------
// The board, composed as vtt-3l6.17 will

function useStore<T>(subscribe: (fn: () => void) => () => void, get: () => T): T {
  return useSyncExternalStore(subscribe, get);
}

function Board(props: {
  session: TableSession;
  ui: UiStore;
  runtime: InteractionRuntime;
  ctx: RecordingContext;
  covers: readonly CoverItem[];
}) {
  const { session, ui, runtime, ctx, covers } = props;
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
  const scene: Scene = useMemo(() => {
    const view = session.boardView();
    if (view === null) return { items: [], covers: [], objectOverlays: [], skipped: [] };
    const built = buildScene({
      views: view.objects.values(),
      covers: [...view.covers.values()],
      board: view.board,
      viewer: snapshot.viewer,
      selection: state.selection,
      previews,
    });
    return { ...built, covers: [...built.covers, ...covers] };
  }, [session, snapshot.viewVersion, snapshot.viewer, state.selection, previews, covers]);
  return (
    <div>
      <FormulaBar session={session} ui={ui} />
      <BoardCanvas
        scene={scene}
        toolOverlays={overlays}
        camera={state.camera}
        setViewport={ui.setViewport}
        createRenderer={() =>
          createCanvas2DRenderer(ctx, { images: new ImageCache({ resolve: (p) => p }) })
        }
        overlay={<InPlaceEditor session={session} ui={ui} camera={state.camera} scene={scene} />}
        {...handlers}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup

async function setup() {
  const authority = await startAuthority();
  const seed = await authority.client("seed");
  await seed.transact(SEED, { label: "Seed" });
  const other = await authority.client("Scribe", { kind: "agent" });
  const session = authority.session();
  await whenReady(session);
  await session.whenRevision(1);
  await until(() => session.boardView()?.objects.has("goblin") === true, "the board view");

  const ui = createUiStore({ session });
  const port: EditorPort = createInPlaceEditorPort(ui);
  const registry = new ToolRegistry();
  registry.register(editTool());
  const runtime = createInteractionRuntime({
    registry,
    inputs: createRuntimeInputs(session, ui),
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor: port,
    whenRevision: (r) => session.whenRevision(r),
  });
  const ctx = new RecordingContext();
  const tree = (covers: readonly CoverItem[]) => (
    <Board session={session} ui={ui} runtime={runtime} ctx={ctx} covers={covers} />
  );
  const utils = render(tree([]));
  const canvas = utils.container.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  await waitFor(() => expect(ui.getState().viewport.width).toBe(800));
  const request = vi.spyOn(session.client, "request");
  return {
    session,
    ui,
    other,
    port,
    canvas,
    setCovers: (covers: readonly CoverItem[]) => utils.rerender(tree(covers)),
    transacts: () =>
      request.mock.calls
        .filter(([method]) => method === "transact")
        .map(([, params]) => params as { ops: WireOp[]; base_revision?: number }),
    stamp: (): InteractionStamp => ({
      interactionId: "test",
      board: BOARD,
      viewer: { type: "gm" },
      baseRevision: session.getSnapshot().revision,
    }),
    /** Double-clicks board point `board` under a camera centered at the origin with `zoom`. */
    dblClick(board: Point, zoom = 1) {
      act(() => {
        fireEvent.doubleClick(canvas, {
          clientX: 400 + board[0] * 64 * zoom,
          clientY: 300 + board[1] * 64 * zoom,
        });
      });
    },
  };
}

const cellOf = (session: TableSession, object: string, cell: string): CellView | undefined =>
  session.objectView(object)?.cells[cell];

const editorOf = (cell: string) =>
  screen.queryByRole("textbox", { name: `Edit ${cell}` }) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;

async function openEditor(cell: string) {
  let found: HTMLInputElement | HTMLTextAreaElement | null = null;
  await waitFor(() => {
    found = editorOf(cell);
    expect(found).not.toBeNull();
  });
  return found as unknown as HTMLInputElement | HTMLTextAreaElement;
}

function frame(): { left: number; top: number; width: number; height: number } {
  const el = document.querySelector<HTMLElement>('[data-part="in-place-editor"]');
  if (el === null) throw new Error("no editor frame");
  return {
    left: Number.parseFloat(el.style.left),
    top: Number.parseFloat(el.style.top),
    width: Number.parseFloat(el.style.width),
    height: Number.parseFloat(el.style.height),
  };
}

function cover(key: string, b: Bounds): CoverItem {
  return {
    key,
    wholeBoard: false,
    anchor: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2],
    rotation: 0,
    shape: rect(b.maxX - b.minX, b.maxY - b.minY),
    bounds: b,
  };
}

/** Lets pending writes and renders settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

describe("in-place editor", () => {
  test("double-clicking a note edits its text in a textarea; Enter commits with the open revision", async () => {
    const { session, dblClick, transacts } = await setup();
    const base = session.getSnapshot().revision;
    dblClick([2, 1]);
    const editor = await openEditor("text");
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe("hello");
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "a{Shift>}{Enter}{/Shift}b{Enter}");
    await until(
      () => JSON.stringify(cellOf(session, "note", "text")?.value) === JSON.stringify(text("a\nb")),
      "the new text",
    );
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "note", cell: "text", value: text("a\nb") },
    ]);
    expect(transacts()[0]?.base_revision).toBe(base);
    expect(editorOf("text")).toBeNull();
  });

  test("double-clicking a token edits its name in an input; name input is always text", async () => {
    const { session, dblClick, transacts } = await setup();
    dblClick([-2, 0]);
    const editor = await openEditor("name");
    expect(editor.tagName).toBe("INPUT");
    expect(editor.value).toBe("Goblin");
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "=Boss{Enter}");
    await until(() => session.refLabel({ type: "gm" }, "tok") === "=Boss", "the rename");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "tok", cell: "name", value: text("=Boss") },
    ]);
  });

  test("double-clicking an object whose text is a formula focuses the formula bar", async () => {
    const { ui, dblClick } = await setup();
    dblClick([0, 3]);
    const bar = (await screen.findByRole("textbox", { name: "Formula" })) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(bar));
    expect(bar.value).toBe("=max_hp - 1");
    expect(ui.getState().focusedCell).toEqual({ object: "sign", cell: "text" });
    expect(editorOf("text")).toBeNull();
    expect(inPlaceEditRequest(ui)).toBeNull();
  });

  test("typing =… in the in-place editor writes a formula", async () => {
    const { session, dblClick, transacts } = await setup();
    dblClick([2, 1]);
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "=1 + 2{Enter}");
    await until(() => cellOf(session, "note", "text")?.kind === "formula", "the formula");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_formula", object: "note", cell: "text", source: "1 + 2" },
    ]);
  });

  test("an unparseable =… shows the parser message and writes nothing", async () => {
    const { dblClick, transacts } = await setup();
    dblClick([2, 1]);
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "=1 +{Enter}");
    expect(screen.getByRole("alert").textContent).not.toBe("");
    expect(editorOf("text")).not.toBeNull();
    expect(transacts()).toHaveLength(0);
  });

  test("overridden formula round trip: prefilled with the override, blur unchanged writes nothing", async () => {
    const { session, port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "temp" }));
    const editor = await openEditor("temp");
    expect(editor.value).toBe("20");
    // A blur within the page: the window keeps focus (jsdom reports none once nothing is focused).
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => editor.blur());
    await settle();
    expect(editorOf("temp")).toBeNull();
    expect(transacts()).toHaveLength(0);
    const temp = cellOf(session, "goblin", "temp");
    expect(temp?.kind).toBe("formula");
    expect(temp?.source).toBe("max_hp + 1");
    expect(temp?.overridden).toBe(true);
    expect(temp?.value).toEqual(num(20));
  });

  test("blur commits a changed value (an override over a formula)", async () => {
    const { session, port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "temp" }));
    const editor = await openEditor("temp");
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "7");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => editor.blur());
    await until(
      () => JSON.stringify(cellOf(session, "goblin", "temp")?.value) === JSON.stringify(num(7)),
      "the override",
    );
    expect(transacts()).toHaveLength(1);
    expect(cellOf(session, "goblin", "temp")?.overridden).toBe(true);
  });

  test("vtt-qf5.47: committing the evaluated value over a formula cell writes one override", async () => {
    const { session, other, port, stamp, transacts } = await setup();
    // The editor never opens on a formula cell without an override (it focuses
    // the formula bar), so the cell stops being overridden while it is open: a
    // second client sets max_hp to 19 and clears the override, so temp follows
    // `max_hp + 1` = 20, the text already shown. The stamp names the revision
    // of that change, so the commit tests the override rule, not the stale check.
    const base = session.getSnapshot().revision;
    act(() =>
      port.open({ stamp: { ...stamp(), baseRevision: base + 1 }, object: "goblin", cell: "temp" }),
    );
    const editor = await openEditor("temp");
    expect(editor.value).toBe("20");
    await other.transact(
      [
        { type: "set_value", object: "goblin", cell: "max_hp", value: num(19) },
        { type: "clear_override", object: "goblin", cell: "temp" },
      ],
      { label: "Scribe clears the override" },
    );
    await until(
      () => cellOf(session, "goblin", "temp")?.overridden !== true,
      "the cleared override",
    );
    expect(cellOf(session, "goblin", "temp")?.value).toEqual(num(20));
    const user = userEvent.setup();
    await user.type(editor, "{Enter}");
    await until(() => cellOf(session, "goblin", "temp")?.overridden === true, "the override");
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "goblin", cell: "temp", value: num(20) },
    ]);
    expect(transacts()[0]?.base_revision).toBe(base + 1);
    expect(cellOf(session, "goblin", "temp")).toMatchObject({
      kind: "formula",
      source: "max_hp + 1",
      overridden: true,
      value: num(20),
    });
  });

  test("vtt-qf5.47: the same literal over a literal cell writes nothing", async () => {
    const { session, port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "max_hp" }));
    const editor = await openEditor("max_hp");
    expect(editor.value).toBe("12");
    const user = userEvent.setup();
    await user.type(editor, "{Enter}");
    expect(editorOf("max_hp")).toBeNull();
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "max_hp" }));
    const again = await openEditor("max_hp");
    await user.clear(again);
    await user.type(again, " 12 {Enter}");
    expect(editorOf("max_hp")).toBeNull();
    await settle();
    expect(transacts()).toEqual([]);
    expect(cellOf(session, "goblin", "max_hp")?.value).toEqual(num(12));
  });

  test("vtt-qf5.47: the same text over an overridden formula cell writes nothing", async () => {
    const { port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "temp" }));
    const editor = await openEditor("temp");
    expect(editor.value).toBe("20");
    const user = userEvent.setup();
    await user.type(editor, "{Enter}");
    expect(editorOf("temp")).toBeNull();
    await settle();
    expect(transacts()).toEqual([]);
  });

  test("vtt-qf5.43: an empty text cell opens blank; a blank commit writes nothing", async () => {
    const { session, port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "memo" }));
    const editor = await openEditor("text");
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe("");
    const user = userEvent.setup();
    await user.type(editor, "{Enter}");
    expect(editorOf("text")).toBeNull();
    // Blur commits too: still nothing (a blank field is not `empty`).
    act(() => port.open({ stamp: stamp(), object: "memo" }));
    const again = await openEditor("text");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => again.blur());
    await settle();
    expect(editorOf("text")).toBeNull();
    expect(transacts()).toEqual([]);
    expect(cellOf(session, "memo", "text")?.value).toEqual(text(""));
  });

  test("vtt-qf5.43: typing into a blank text cell writes the text, no clearing needed", async () => {
    const { session, port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "memo" }));
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.type(editor, "abc{Enter}");
    await until(
      () => JSON.stringify(cellOf(session, "memo", "text")?.value) === JSON.stringify(text("abc")),
      "the typed text",
    );
    expect(transacts()).toHaveLength(1);
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "memo", cell: "text", value: text("abc") },
    ]);
  });

  test('vtt-qf5.43: typing "" into a blank text cell is unchanged; typing empty clears it', async () => {
    const { session, port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "memo" }));
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.type(editor, '""{Enter}');
    expect(editorOf("text")).toBeNull();
    await settle();
    expect(transacts()).toEqual([]);
    act(() => port.open({ stamp: stamp(), object: "memo" }));
    const again = await openEditor("text");
    await user.type(again, "empty{Enter}");
    await until(() => cellOf(session, "memo", "text")?.value.type === "empty", "the empty cell");
    expect(transacts()[0]?.ops).toEqual([
      { type: "set_value", object: "memo", cell: "text", value: { type: "empty" } },
    ]);
  });

  test("vtt-qf5.43: an empty text value in another cell opens blank too", async () => {
    const { port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "memo", cell: "note" }));
    const editor = await openEditor("note");
    expect(editor.tagName).toBe("INPUT");
    expect(editor.value).toBe("");
    const user = userEvent.setup();
    await user.type(editor, "{Enter}");
    expect(editorOf("note")).toBeNull();
    await settle();
    expect(transacts()).toEqual([]);
  });

  test("vtt-qf5.43: an overridden formula whose override is the empty text opens blank", async () => {
    const { session, other, port, stamp, transacts } = await setup();
    await other.transact([{ type: "set_value", object: "goblin", cell: "temp", value: text("") }], {
      label: "Scribe blanks the override",
    });
    await until(
      () => JSON.stringify(cellOf(session, "goblin", "temp")?.value) === JSON.stringify(text("")),
      "the empty override",
    );
    expect(cellOf(session, "goblin", "temp")?.overridden).toBe(true);
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "temp" }));
    const editor = await openEditor("temp");
    expect(editor.value).toBe("");
    const user = userEvent.setup();
    await user.type(editor, "{Enter}");
    expect(editorOf("temp")).toBeNull();
    await settle();
    expect(transacts()).toEqual([]);
    expect(cellOf(session, "goblin", "temp")).toMatchObject({
      kind: "formula",
      overridden: true,
      value: text(""),
    });
  });

  test("the window losing focus keeps the draft and writes nothing; Enter on return commits (vtt-nb8.21, vtt-qf5.59)", async () => {
    const { session, port, stamp, transacts } = await setup();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "temp" }));
    let editor = await openEditor("temp");
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "=max_hp +");
    act(() => editor.blur());
    await settle();
    expect(editorOf("temp")?.value).toBe("=max_hp +");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(transacts()).toHaveLength(0);
    // A parseable half-typed value is kept too, not committed.
    editor = editorOf("temp") as HTMLInputElement;
    await user.clear(editor);
    await user.type(editor, "7");
    act(() => editor.blur());
    await settle();
    expect(editorOf("temp")?.value).toBe("7");
    expect(transacts()).toHaveLength(0);
    // The window comes back with focus restored to the field: the draft resumes.
    hasFocus.mockReturnValue(true);
    editor = editorOf("temp") as HTMLInputElement;
    act(() => {
      editor.focus();
      window.dispatchEvent(new FocusEvent("focus"));
    });
    await settle();
    expect(editorOf("temp")?.value).toBe("7");
    expect(transacts()).toHaveLength(0);
    await user.type(editor, "{Enter}");
    await until(
      () => JSON.stringify(cellOf(session, "goblin", "temp")?.value) === JSON.stringify(num(7)),
      "the override",
    );
    expect(transacts()).toHaveLength(1);
    hasFocus.mockRestore();
  });

  test("the window coming back with focus elsewhere closes a kept draft without writing (vtt-qf5.59)", async () => {
    const { port, stamp, transacts } = await setup();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "temp" }));
    const editor = await openEditor("temp");
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "7");
    act(() => editor.blur());
    await settle();
    expect(editorOf("temp")?.value).toBe("7");
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new FocusEvent("focus"));
    });
    await settle();
    expect(editorOf("temp")).toBeNull();
    expect(transacts()).toHaveLength(0);
    hasFocus.mockRestore();
  });

  test("Escape cancels without writing", async () => {
    const { dblClick, transacts } = await setup();
    dblClick([2, 1]);
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.type(editor, " world");
    await user.keyboard("{Escape}");
    await settle();
    expect(editorOf("text")).toBeNull();
    expect(transacts()).toHaveLength(0);
  });

  test("a roll and a #REF open the empty replace-value editor with reasons; @goblin2 repairs the #REF", async () => {
    const { session, port, stamp, transacts } = await setup();
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "lastroll" }));
    const roll = await openEditor("lastroll");
    expect(roll.value).toBe("");
    expect(screen.getByText(/a roll result cannot be typed/)).toBeDefined();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await settle();
    expect(transacts()).toHaveLength(0);

    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "target" }));
    const target = await openEditor("target");
    expect(target.value).toBe("");
    expect(screen.getByText(/#REF/)).toBeDefined();
    await user.type(target, "@goblin2{Enter}");
    await until(() => cellOf(session, "goblin", "target")?.value.type === "ref", "the repair");
    expect(cellOf(session, "goblin", "target")?.value).toEqual(ref("goblin2"));
  });

  test("1e-7 is prefilled as decimal text, never with an exponent", async () => {
    const { port, stamp } = await setup();
    act(() => port.open({ stamp: stamp(), object: "goblin", cell: "tiny" }));
    const editor = await openEditor("tiny");
    expect(editor.value).toBe("0.0000001");
  });

  test("concurrent write: opened at r, a second client writes, committing is stale_write", async () => {
    const { session, other, dblClick, transacts } = await setup();
    const base = session.getSnapshot().revision;
    dblClick([2, 1]);
    const editor = await openEditor("text");
    await other.transact(
      [{ type: "set_value", object: "note", cell: "text", value: text("remote") }],
      { label: "Scribe edits the note" },
    );
    await until(() => session.getSnapshot().revision > base, "the second client's commit");
    const user = userEvent.setup();
    await user.type(editor, " edited{Enter}");
    await until(
      () =>
        sessionNotices(session)
          .list()
          .some((n) => n.kind === "stale"),
      "the stale notice",
    );
    expect(transacts()[0]?.base_revision).toBe(base);
    expect(cellOf(session, "note", "text")?.value).toEqual(text("remote"));
  });

  test("the overlay editor sits at the object's screen bounds and moves with the camera", async () => {
    const { ui, dblClick } = await setup();
    dblClick([2, 1]);
    await openEditor("text");
    // The note's bounds are x 1..3, y 0.5..1.5; 64 px per unit about the 800 × 600 center.
    expect(frame()).toEqual({ left: 464, top: 332, width: 128, height: 64 });
    act(() => ui.setCamera({ x: 1, y: 0, zoom: 2 }));
    expect(frame()).toEqual({ left: 400, top: 364, width: 256, height: 128 });
    expect(editorOf("text")).not.toBeNull();
  });

  test("a large object whose anchor is uncovered but whose rectangle overlaps a cover does not open", async () => {
    const { ui, setCovers, dblClick } = await setup();
    // big covers x 7..13, y -2..2; the cover takes its lower right corner.
    setCovers([cover("c1", { minX: 11.5, minY: 0.5, maxX: 13.5, maxY: 2.5 })]);
    dblClick([8, -1]);
    await settle();
    expect(editorOf("text")).toBeNull();
    expect(inPlaceEditRequest(ui)).toBeNull();
  });

  test("a cover appearing over the open editor closes it without writing", async () => {
    const { setCovers, dblClick, transacts } = await setup();
    dblClick([2, 1]);
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.type(editor, " typed");
    setCovers([cover("c1", { minX: 2.5, minY: 1, maxX: 4, maxY: 2 })]);
    await settle();
    expect(editorOf("text")).toBeNull();
    // Removing the cover does not bring it back.
    setCovers([]);
    await settle();
    expect(editorOf("text")).toBeNull();
    expect(transacts()).toHaveLength(0);
  });

  test("switching to view-as Aldric closes the open editor without writing", async () => {
    const { session, ui, dblClick, transacts } = await setup();
    dblClick([2, 1]);
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.type(editor, " typed");
    await act(async () => {
      await ui.setViewer({ type: "character", id: "aldric" });
    });
    await until(() => session.getSnapshot().viewer.type === "character", "view-as Aldric");
    await settle();
    expect(editorOf("text")).toBeNull();
    expect(transacts()).toHaveLength(0);
  });

  test("in view-as it does not open", async () => {
    const { session, ui, port } = await setup();
    await act(async () => {
      await ui.setViewer({ type: "character", id: "aldric" });
    });
    await until(() => session.getSnapshot().viewer.type === "character", "view-as Aldric");
    act(() =>
      port.open({
        stamp: {
          interactionId: "t",
          board: BOARD,
          viewer: { type: "character", id: "aldric" },
          baseRevision: session.getSnapshot().revision,
        },
        object: "note",
      }),
    );
    await settle();
    expect(editorOf("text")).toBeNull();
  });

  test("port.close closes the editor without writing", async () => {
    const { port, dblClick, transacts } = await setup();
    dblClick([2, 1]);
    const editor = await openEditor("text");
    const user = userEvent.setup();
    await user.type(editor, " typed");
    act(() => port.close());
    await settle();
    expect(editorOf("text")).toBeNull();
    expect(transacts()).toHaveLength(0);
  });

  test("a rect positions the editor over it, and the cover rule applies to the rect (Q1 A5)", async () => {
    const { ui, port, stamp, setCovers } = await setup();
    // The cover overlaps big's bounds (x 7..13, y -2..2) but not the rect.
    setCovers([cover("c1", { minX: 11.5, minY: 0.5, maxX: 13.5, maxY: 2.5 })]);
    act(() =>
      port.open({
        stamp: stamp(),
        object: "big",
        cell: "text",
        rect: { minX: 8, minY: -1, maxX: 10, maxY: 0 },
      }),
    );
    await openEditor("text");
    expect(frame()).toEqual({ left: 912, top: 236, width: 128, height: 64 });
    act(() => ui.setCamera({ x: 9, y: 0, zoom: 1 }));
    expect(frame()).toEqual({ left: 336, top: 236, width: 128, height: 64 });
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await settle();

    // A rect outside big's bounds that overlaps a cover: refused.
    setCovers([cover("c2", { minX: 14.5, minY: 0, maxX: 15.5, maxY: 1 })]);
    act(() =>
      port.open({
        stamp: stamp(),
        object: "big",
        cell: "text",
        rect: { minX: 14, minY: 0, maxX: 15, maxY: 1 },
      }),
    );
    await settle();
    expect(editorOf("text")).toBeNull();
  });

  test("a stamp for another board does not open", async () => {
    const { port, stamp } = await setup();
    act(() => port.open({ stamp: { ...stamp(), board: "elsewhere" }, object: "note" }));
    await settle();
    expect(editorOf("text")).toBeNull();
  });
  test("a small explicit rect is positioned exactly and opens beside an adjacent cover", async () => {
    const { port, stamp, setCovers } = await setup();
    // The rect is 32 × 16 px; the cover touches its right edge without overlapping it.
    setCovers([cover("c1", { minX: 8.5, minY: -1, maxX: 9.5, maxY: 0 })]);
    act(() =>
      port.open({
        stamp: stamp(),
        object: "big",
        cell: "text",
        rect: { minX: 8, minY: -1, maxX: 8.5, maxY: -0.75 },
      }),
    );
    await openEditor("text");
    expect(frame()).toEqual({ left: 912, top: 236, width: 32, height: 16 });
  });

  test("a zoomed-out object is positioned exactly and opens beside an adjacent cover", async () => {
    const { ui, setCovers, dblClick } = await setup();
    act(() => ui.setCamera({ x: 0, y: 0, zoom: 0.25 }));
    // The note (x 1..3, y 0.5..1.5) is 32 × 16 px; the cover touches its right edge.
    setCovers([cover("c1", { minX: 3, minY: 0.5, maxX: 4, maxY: 1.5 })]);
    dblClick([2, 1], 0.25);
    await openEditor("text");
    expect(frame()).toEqual({ left: 416, top: 308, width: 32, height: 16 });
  });
  test("a shapeless object (point bounds) under a cover does not open", async () => {
    const { port, stamp, setCovers } = await setup();
    setCovers([cover("c1", { minX: -21, minY: 9, maxX: -19, maxY: 11 })]);
    act(() => port.open({ stamp: stamp(), object: "goblin2" }));
    await settle();
    expect(editorOf("name")).toBeNull();
    setCovers([]);
    act(() => port.open({ stamp: stamp(), object: "goblin2" }));
    await openEditor("name");
  });
});
