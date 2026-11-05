// @vitest-environment node
/**
 * The interaction runtime against fake ports (vtt-3l6.23; DESIGN.md §7 Undo;
 * M4 plan Q10, review r2 findings 3, 4, 8, r3 findings 1, 2): writes keep
 * their stamp's base revision, continuations run in order on `committed`
 * only while the interaction is live, started uploads finish on their
 * stamped board, held previews last until the commit is visible.
 */
import type { Viewer, WireOp } from "@vtt/protocol";
import type { BoardId, ObjectId, Point } from "@vtt/schema";
import {
  type CancelReason,
  type CommittedWrite,
  type Continuation,
  captureStamp,
  createInteractionRuntime,
  createUiStore,
  type EditorOpenRequest,
  type EditorPort,
  type Effect,
  type InteractionEvent,
  type InteractionStamp,
  type Modifiers,
  type NoticeLevel,
  type Previews,
  type RuntimeInputs,
  type Scene,
  type SettledOutcome,
  type Tool,
  type ToolContext,
  type ToolId,
  ToolRegistry,
  type ToolState,
  type UiSession,
  type UploadedAsset,
  type WriteOptions,
  type WriteOutcome,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Fakes

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
const SHIFT: Modifiers = { ...NO_MODS, shift: true };
const EMPTY_SCENE: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface World {
  board: BoardId | null;
  viewer: Viewer;
  revision: number;
}

function fakeInputs(world: World): RuntimeInputs & { fire(): void } {
  const listeners = new Set<() => void>();
  return {
    views: () => null,
    scene: () => EMPTY_SCENE,
    viewport: () => ({ width: 800, height: 600, dpr: 1 }),
    activeBoard: () => world.board,
    viewer: () => world.viewer,
    revision: () => world.revision,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    fire() {
      for (const fn of [...listeners]) fn();
    },
  };
}

function fakeUiSession(world: World): UiSession {
  return {
    getSnapshot: () => ({
      connection: null,
      ready: true,
      revision: world.revision,
      boards: [{ id: "main" }, { id: "other" }],
      table: null,
      activeBoard: world.board,
      viewer: world.viewer,
      viewVersion: 0,
    }),
    setView: async () => undefined,
    watchObjects: async () => undefined,
  };
}

const committed = (over: Partial<CommittedWrite> = {}): CommittedWrite => ({
  status: "committed",
  revision: 9,
  index: 3,
  created: [],
  copies: [],
  bindings: {},
  ...over,
});

const staleRejection: WriteOutcome = {
  status: "rejected",
  rejection: {
    type: "stale_write",
    base_revision: 5,
    revision: 6,
    floor: 0,
    truncated: false,
    conflicts: [],
  },
};

// ---------------------------------------------------------------------------
// Scripted tools

type Log = (
  | { tool: ToolId; kind: "event"; event: InteractionEvent; interactionId: string }
  | { tool: ToolId; kind: "cancel"; reason: CancelReason }
)[];

interface Phase {
  /** The interaction in progress (pointer down → up), if any. */
  stamp: InteractionStamp | null;
  shift: boolean;
  start: Point | null;
}

const IDLE: Phase = { stamp: null, shift: false, start: null };

const createOp = (board: BoardId, at: Point, idBase: string): WireOp => ({
  type: "create_object",
  id_base: idBase,
  to: { type: "board", board, position: at },
});

/** The creation policy of vtt-3l6.8: select the created object, then select unless Shift. */
const creationContinuations = (shift: boolean): Continuation[] =>
  shift
    ? [{ type: "select_created", opIndex: 0 }]
    : [
        { type: "select_created", opIndex: 0 },
        { type: "set_tool", tool: "select" },
      ];

/**
 * A tool that, on pointer down, captures a stamp and, on pointer up, emits
 * `respond(stamp, ...)`; on `file_drop` uploads the first file and on
 * `uploaded` creates an image on the stamped board. Logs everything.
 */
function scriptedTool(
  id: ToolId,
  log: Log,
  respond: (stamp: InteractionStamp, phase: Phase, at: Point) => Effect[] = (stamp, phase, at) => [
    {
      type: "write",
      stamp,
      ops: [createOp(stamp.board, at, "token")],
      label: "Create token",
      continuations: creationContinuations(phase.shift),
    },
  ],
): Tool<Phase> {
  return {
    id,
    init: (options) => ({ tool: id, options, phase: IDLE }) as ToolState<Phase>,
    cursor: () => "default",
    reduce(state, event, input) {
      log.push({ tool: id, kind: "event", event, interactionId: input.interactionId });
      switch (event.type) {
        case "pointer_down": {
          const stamp = captureStamp(input);
          return {
            state: {
              ...state,
              phase: { stamp, shift: event.modifiers.shift, start: event.board },
            },
            effects: [],
          };
        }
        case "pointer_move": {
          const { stamp, start } = state.phase;
          if (stamp === null || start === null) return { state, effects: [] };
          return {
            state,
            effects: [
              { type: "previews", previews: new Map([["tok", { position: event.board }]]) },
            ],
          };
        }
        case "pointer_up": {
          const { stamp } = state.phase;
          if (stamp === null) return { state, effects: [] };
          return {
            state: { ...state, phase: IDLE },
            effects: respond(stamp, state.phase, event.board),
          };
        }
        case "file_drop": {
          const stamp = captureStamp(input);
          const file = event.files[0];
          if (stamp === null || file === undefined) return { state, effects: [] };
          uploadStamps.set(stamp.interactionId, stamp);
          return { state, effects: [{ type: "upload", stamp, file }] };
        }
        case "settled": {
          const outcome = event.outcome;
          if (outcome.type !== "uploaded") return { state, effects: [] };
          const stamp = uploadStamps.get(event.interactionId);
          if (stamp === undefined) return { state, effects: [] };
          return {
            state,
            effects: [
              {
                type: "write",
                stamp,
                ops: [createOp(stamp.board, [0, 0], "image")],
                label: `Create ${outcome.path}`,
                continuations: creationContinuations(false),
              },
            ],
          };
        }
        default:
          return { state, effects: [] };
      }
    },
    cancel(state, reason) {
      log.push({ tool: id, kind: "cancel", reason });
      const effects: Effect[] =
        state.phase.stamp === null ? [] : [{ type: "previews", previews: new Map() }];
      return { state: { ...state, phase: IDLE }, effects };
    },
  };
}

/** Upload stamps by interaction id (the scripted tools' memory of their uploads). */
const uploadStamps = new Map<string, InteractionStamp>();

// ---------------------------------------------------------------------------
// Harness

interface WriteCall {
  ops: WireOp[];
  opts: WriteOptions;
  result: Deferred<WriteOutcome>;
}

function setup(options: { tool?: ToolId; tools?: (log: Log) => Tool<Phase>[] } = {}) {
  const world: World = { board: "main", viewer: GM, revision: 5 };
  const inputs = fakeInputs(world);
  const ui = createUiStore({ session: fakeUiSession(world) });
  const log: Log = [];
  const notices: { level: NoticeLevel; text: string }[] = [];
  const writes: WriteCall[] = [];
  const uploads: { file: File; result: Deferred<UploadedAsset> }[] = [];
  const picks: { accept: string; result: Deferred<File | null> }[] = [];
  const revisions: { revision: number; reached: Deferred<void> }[] = [];
  const opened: EditorOpenRequest[] = [];
  let closed = 0;

  const toolContext: ToolContext = {
    activeBoard: () => world.board,
    viewer: () => world.viewer,
    revision: () => world.revision,
    camera: ui.cameraPort(),
    write: {
      write(ops, opts) {
        const result = deferred<WriteOutcome>();
        writes.push({ ops, opts, result });
        // Like vtt-3l6.21's port: a non-committed outcome is a notice.
        return result.promise.then((outcome) => {
          if (outcome.status !== "committed") {
            notices.push({ level: "error", text: `port: ${outcome.status}` });
          }
          return outcome;
        });
      },
    },
    notify: (level, text) => notices.push({ level, text }),
    pickFile(accept) {
      const result = deferred<File | null>();
      picks.push({ accept, result });
      return result.promise;
    },
    upload(file) {
      const result = deferred<UploadedAsset>();
      uploads.push({ file, result });
      return result.promise;
    },
  };
  const editor: EditorPort = {
    open: (request) => opened.push(request),
    close: () => {
      closed++;
    },
  };

  const registry = new ToolRegistry();
  const tools = options.tools?.(log) ?? [
    scriptedTool("select", log),
    scriptedTool("token", log),
    scriptedTool("image", log),
  ];
  for (const tool of tools) registry.register(tool);
  ui.setTool(options.tool ?? "token");

  const runtime = createInteractionRuntime({
    registry,
    inputs,
    toolContext,
    ui,
    editor,
    whenRevision(revision) {
      const reached = deferred<void>();
      revisions.push({ revision, reached });
      return reached.promise;
    },
  });

  const lastWrite = (): WriteCall => {
    const w = writes.at(-1);
    if (w === undefined) throw new Error("no write");
    return w;
  };

  return {
    world,
    inputs,
    ui,
    log,
    notices,
    writes,
    uploads,
    picks,
    revisions,
    opened,
    closedCount: () => closed,
    runtime,
    registry,
    lastWrite,
    /** Changes the world and fires `onChange`, as the session would. */
    change(patch: Partial<World>) {
      Object.assign(world, patch);
      inputs.fire();
    },
    settledOf(tool: ToolId): SettledOutcome[] {
      return log.flatMap((entry) =>
        entry.tool === tool && entry.kind === "event" && entry.event.type === "settled"
          ? [entry.event.outcome]
          : [],
      );
    },
    cancelsOf(tool: ToolId): CancelReason[] {
      return log.flatMap((e) => (e.tool === tool && e.kind === "cancel" ? [e.reason] : []));
    },
  };
}

function pointer(
  type: "pointer_down" | "pointer_move" | "pointer_up",
  board: Point,
  modifiers: Modifiers = NO_MODS,
): InteractionEvent {
  return {
    type,
    pointerId: 1,
    screen: [board[0] * 64 + 400, board[1] * 64 + 300],
    board,
    button: type === "pointer_move" ? -1 : 0,
    buttons: type === "pointer_up" ? 0 : 1,
    modifiers,
  };
}

const keyDown = (key: string, code = key): InteractionEvent => ({
  type: "key_down",
  key,
  code,
  modifiers: NO_MODS,
  inTextField: false,
});

function click(
  h: ReturnType<typeof setup>,
  at: Point = [1, 2],
  modifiers: Modifiers = NO_MODS,
): void {
  h.runtime.dispatch(pointer("pointer_down", at, modifiers));
  h.runtime.dispatch(pointer("pointer_up", at, modifiers));
}

/** Drops a file on the canvas. */
function dropFile(h: ReturnType<typeof setup>, name = "map.png"): void {
  h.runtime.dispatch({
    type: "file_drop",
    files: [new File(["png"], name, { type: "image/png" })],
    screen: [400, 300],
    board: [0, 0],
  });
}

// ---------------------------------------------------------------------------

describe("writes", () => {
  test("a write uses its stamp's baseRevision although the revision advanced", async () => {
    const h = setup();
    h.runtime.dispatch(pointer("pointer_down", [1, 2]));
    h.change({ revision: 7 });
    h.runtime.dispatch(pointer("pointer_up", [1, 2]));
    expect(h.writes).toHaveLength(1);
    expect(h.lastWrite().opts).toEqual({ baseRevision: 5, label: "Create token" });
    expect(h.lastWrite().ops).toEqual([createOp("main", [1, 2], "token")]);
  });

  test("on committed the continuations run in order: select the created object, then set_tool select", async () => {
    const h = setup();
    const seen: [readonly ObjectId[], ToolId][] = [];
    h.ui.subscribe(() => seen.push([h.ui.getState().selection, h.ui.getState().tool.id]));
    click(h);
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "token_1" }] }));
    await flush();
    expect(h.ui.getState().selection).toEqual(["token_1"]);
    expect(h.ui.getState().tool.id).toBe("select");
    expect(h.runtime.machine().tool).toBe("select");
    // The selection changed first, then the tool.
    expect(seen).toEqual([
      [["token_1"], "token"],
      [["token_1"], "select"],
    ]);
    expect(h.cancelsOf("token")).toEqual(["tool_switch"]);
    // The settled result reached the token tool before the switch.
    expect(h.settledOf("token")).toEqual([
      { type: "write", result: committed({ created: [{ op_index: 0, id: "token_1" }] }) },
    ]);
  });

  test("with the Shift decision recorded at the click the tool stays", async () => {
    const h = setup();
    click(h, [1, 2], SHIFT);
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "token_1" }] }));
    await flush();
    expect(h.ui.getState().selection).toEqual(["token_1"]);
    expect(h.ui.getState().tool.id).toBe("token");
    expect(h.runtime.machine().tool).toBe("token");
    expect(h.cancelsOf("token")).toEqual([]);
  });

  test.each([
    [0, ["before"]],
    [1, ["token_9"]],
    [2, ["copy_root"]],
  ] as const)(
    "select_created %i in a mixed transaction selects the record with that op_index",
    async (opIndex, expected) => {
      const h = setup({
        tools: (log) => [
          scriptedTool("select", log),
          scriptedTool("token", log, (stamp) => [
            {
              type: "write",
              stamp,
              ops: [
                {
                  type: "set_value",
                  object: "goblin",
                  cell: "hp",
                  value: { type: "number", value: 3 },
                },
                createOp(stamp.board, [0, 0], "token"),
                {
                  type: "spawn",
                  template: "orc",
                  to: { type: "board", board: stamp.board, position: [1, 1] },
                },
              ],
              label: "Mixed",
              continuations: [{ type: "select_created", opIndex }],
            },
          ]),
        ],
      });
      h.ui.select(["before"]);
      click(h);
      // Records in an order unlike the ops', so array position would pick wrongly.
      h.lastWrite().result.resolve(
        committed({
          created: [{ op_index: 1, id: "token_9" }],
          copies: [
            { op_index: 2, root: "copy_root", copies: { orc: "copy_root", orc_eye: "copy_eye" } },
          ],
        }),
      );
      await flush();
      expect(h.ui.getState().selection).toEqual(expected);
    },
  );

  test.each([
    ["rejected", staleRejection],
    ["uncertain", { status: "uncertain", reason: "lost" } as WriteOutcome],
    ["failed", { status: "failed", error: { code: "internal", message: "boom" } } as WriteOutcome],
  ])("a %s write runs no continuation and settles back to its tool", async (_n, outcome) => {
    const h = setup();
    click(h);
    h.lastWrite().result.resolve(outcome);
    await flush();
    expect(h.ui.getState().selection).toEqual([]);
    expect(h.ui.getState().tool.id).toBe("token");
    expect(h.settledOf("token")).toEqual([{ type: "write", result: outcome }]);
    // The port's notice only; the runtime adds none.
    expect(h.notices).toHaveLength(1);
  });

  test("two effects sharing a stamp each settle back to the tool and run their continuations", async () => {
    const h = setup({
      tools: (log) => [
        scriptedTool("select", log),
        scriptedTool("token", log, (stamp) => [
          {
            type: "write",
            stamp,
            ops: [createOp(stamp.board, [0, 0], "a")],
            label: "A",
            continuations: [{ type: "select", ids: ["picked_a"] }],
          },
          {
            type: "write",
            stamp,
            ops: [createOp(stamp.board, [1, 0], "b")],
            label: "B",
            continuations: [{ type: "select_created", opIndex: 0 }],
          },
        ]),
      ],
    });
    click(h);
    expect(h.writes.map((w) => w.opts.label)).toEqual(["A", "B"]);
    const id = h.runtime.machine().pending;
    expect(Object.values(id)).toEqual([{ tool: "token", outstanding: 2 }]);
    h.writes[1]?.result.resolve(committed({ created: [{ op_index: 0, id: "b_1" }] }));
    await flush();
    expect(h.ui.getState().selection).toEqual(["b_1"]);
    h.writes[0]?.result.resolve(committed({ revision: 10 }));
    await flush();
    expect(h.ui.getState().selection).toEqual(["picked_a"]);
    expect(h.settledOf("token")).toHaveLength(2);
    const ids = h.log.flatMap((e) =>
      e.kind === "event" && e.event.type === "settled" ? [e.event.interactionId] : [],
    );
    expect(new Set(ids).size).toBe(1);
    expect(h.runtime.machine().pending).toEqual({});
  });
});

describe("lifecycle", () => {
  test("a board switch during a pending upload creates the object on the stamped board and changes neither selection nor tool", async () => {
    const h = setup({ tool: "image" });
    h.ui.select(["kept"]);
    dropFile(h);
    expect(h.uploads).toHaveLength(1);
    h.change({ board: "other" });
    expect(h.cancelsOf("image")).toEqual(["board_change"]);
    h.uploads[0]?.result.resolve({ path: "t.assets/map.png", width: 200, height: 100 });
    await flush();
    expect(h.settledOf("image")).toEqual([
      { type: "uploaded", path: "t.assets/map.png", width: 200, height: 100 },
    ]);
    expect(h.writes).toHaveLength(1);
    expect(h.lastWrite().ops).toEqual([createOp("main", [0, 0], "image")]);
    expect(h.lastWrite().opts.baseRevision).toBe(5);
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "image_1" }] }));
    await flush();
    expect(h.ui.getState().selection).toEqual(["kept"]);
    expect(h.ui.getState().tool.id).toBe("image");
    expect(h.runtime.machine().tool).toBe("image");
  });

  test("returning to the stamped board before the result still runs no continuation", async () => {
    const h = setup({ tool: "image" });
    dropFile(h);
    h.change({ board: "other" });
    h.change({ board: "main" });
    h.uploads[0]?.result.resolve({ path: "t.assets/map.png", width: 200, height: 100 });
    await flush();
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "image_1" }] }));
    await flush();
    expect(h.ui.getState().selection).toEqual([]);
    expect(h.ui.getState().tool.id).toBe("image");
  });

  test("a tool switch during a pending upload creates the object and keeps the new tool", async () => {
    const h = setup({ tool: "image" });
    dropFile(h);
    h.ui.setTool("token");
    expect(h.runtime.machine().tool).toBe("token");
    expect(h.cancelsOf("image")).toEqual(["tool_switch"]);
    h.uploads[0]?.result.resolve({ path: "t.assets/map.png", width: 200, height: 100 });
    await flush();
    // The inactive image tool received its result and wrote.
    expect(h.settledOf("image")).toHaveLength(1);
    expect(h.lastWrite().ops).toEqual([createOp("main", [0, 0], "image")]);
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "image_1" }] }));
    await flush();
    expect(h.settledOf("image")).toHaveLength(2);
    expect(h.ui.getState().tool.id).toBe("token");
    expect(h.runtime.machine().tool).toBe("token");
    expect(h.ui.getState().selection).toEqual([]);
  });

  test("a failed upload settles as upload_failed", async () => {
    const h = setup({ tool: "image" });
    dropFile(h);
    h.uploads[0]?.result.reject(new Error("too large"));
    await flush();
    expect(h.settledOf("image")).toEqual([{ type: "upload_failed", message: "too large" }]);
  });

  test("a tool switch during a pending write runs no continuation and the rejection notice still shows", async () => {
    const h = setup();
    click(h);
    h.ui.setTool("image");
    h.lastWrite().result.resolve(staleRejection);
    await flush();
    expect(h.settledOf("token")).toEqual([{ type: "write", result: staleRejection }]);
    expect(h.notices).toEqual([{ level: "error", text: "port: rejected" }]);
    expect(h.ui.getState().tool.id).toBe("image");
  });

  test("a tool switch during a pending write drops its continuations when it commits", async () => {
    const h = setup();
    click(h);
    h.ui.setTool("image");
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "token_1" }] }));
    await flush();
    expect(h.ui.getState().selection).toEqual([]);
    expect(h.ui.getState().tool.id).toBe("image");
  });

  test("a board switch during a pending write: it is awaited, settles and runs no continuation", async () => {
    const h = setup();
    click(h);
    h.change({ board: "other" });
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "token_1" }] }));
    await flush();
    expect(h.settledOf("token")).toHaveLength(1);
    expect(h.ui.getState().selection).toEqual([]);
    expect(h.ui.getState().tool.id).toBe("token");
  });

  test("Escape during a pending write drops its continuations", async () => {
    const h = setup();
    click(h);
    h.runtime.dispatch(keyDown("Escape"));
    expect(h.cancelsOf("token")).toEqual(["escape"]);
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "token_1" }] }));
    await flush();
    expect(h.ui.getState().selection).toEqual([]);
    expect(h.ui.getState().tool.id).toBe("token");
  });

  test("a viewer change via onChange cancels a drag: no write", async () => {
    const h = setup({ tool: "select" });
    h.runtime.dispatch(pointer("pointer_down", [1, 1]));
    h.runtime.dispatch(pointer("pointer_move", [2, 1]));
    h.change({ viewer: ALDRIC });
    // Cancelled by onChange itself, before any further event.
    expect(h.cancelsOf("select")).toEqual(["viewer_change"]);
    expect(h.runtime.getView().previews.size).toBe(0);
    h.runtime.dispatch(pointer("pointer_up", [2, 1]));
    expect(h.writes).toEqual([]);
  });

  test("a revision-only change cancels nothing", () => {
    const h = setup({ tool: "select" });
    h.runtime.dispatch(pointer("pointer_down", [1, 1]));
    h.change({ revision: 6 });
    expect(h.cancelsOf("select")).toEqual([]);
  });
});

describe("previews", () => {
  /** A select-like drag: previews while moving, a write with held previews on drop. */
  function dragTool(log: Log): Tool<Phase> {
    return scriptedTool("select", log, (stamp, _phase, at) => [
      {
        type: "write",
        stamp,
        ops: [
          { type: "move", object: "tok", to: { type: "board", board: stamp.board, position: at } },
        ],
        label: "Move tok",
        continuations: [],
      },
      { type: "previews", previews: new Map([["tok", { position: at }]]), hold: { stamp } },
    ]);
  }
  const setupDrag = () =>
    setup({ tool: "select", tools: (log) => [dragTool(log), scriptedTool("token", log)] });

  function drag(h: ReturnType<typeof setup>): void {
    h.runtime.dispatch(pointer("pointer_down", [1, 1]));
    h.runtime.dispatch(pointer("pointer_move", [3, 1]));
    h.runtime.dispatch(pointer("pointer_up", [3, 1]));
  }

  const held = (h: ReturnType<typeof setup>): Previews => h.runtime.getView().previews;

  test("a held preview stays until whenRevision resolves", async () => {
    const h = setupDrag();
    drag(h);
    expect(held(h).get("tok")).toEqual({ position: [3, 1] });
    h.lastWrite().result.resolve(committed({ revision: 12 }));
    await flush();
    expect(h.revisions.map((r) => r.revision)).toEqual([12]);
    expect(held(h).get("tok")).toEqual({ position: [3, 1] });
    h.revisions[0]?.reached.resolve();
    await flush();
    expect(held(h).size).toBe(0);
  });

  test("a held preview clears at once on rejection", async () => {
    const h = setupDrag();
    drag(h);
    h.lastWrite().result.resolve(staleRejection);
    await flush();
    expect(held(h).size).toBe(0);
    expect(h.revisions).toEqual([]);
  });

  test("a held preview clears at once on cancel", async () => {
    const h = setupDrag();
    drag(h);
    h.runtime.dispatch(keyDown("Escape"));
    expect(held(h).size).toBe(0);
    // The write still settles; nothing comes back.
    h.lastWrite().result.resolve(committed({ revision: 12 }));
    await flush();
    expect(held(h).size).toBe(0);
  });

  test("a later gesture's previews survive an earlier write becoming visible", async () => {
    const h = setupDrag();
    drag(h);
    h.runtime.dispatch(pointer("pointer_down", [5, 5]));
    h.runtime.dispatch(pointer("pointer_move", [6, 5]));
    h.lastWrite().result.resolve(committed({ revision: 12 }));
    await flush();
    h.revisions[0]?.reached.resolve();
    await flush();
    expect(held(h).get("tok")).toEqual({ position: [6, 5] });
  });

  test("subscribers hear preview and overlay changes; the view is stable between changes", () => {
    const h = setupDrag();
    let calls = 0;
    h.runtime.subscribe(() => calls++);
    const before = h.runtime.getView();
    expect(h.runtime.getView()).toBe(before);
    h.runtime.dispatch(pointer("pointer_down", [1, 1]));
    h.runtime.dispatch(pointer("pointer_move", [3, 1]));
    expect(calls).toBe(1);
    expect(h.runtime.getView()).not.toBe(before);
  });
});

describe("other effects", () => {
  function emitter(effects: (input: { stamp: InteractionStamp }) => Effect[]) {
    return setup({
      tools: (log) => [
        scriptedTool("select", log),
        scriptedTool("token", log, (stamp) => effects({ stamp })),
        scriptedTool("zone-rect", log),
      ],
    });
  }

  test("camera, select, hover, notice and overlays reach their ports", () => {
    const h = emitter(() => [
      { type: "camera", camera: { x: 3, y: 4, zoom: 2 } },
      { type: "select", ids: ["a", "b"] },
      { type: "hover", id: "a", zone: "room" },
      { type: "notice", level: "warning", text: "careful" },
      { type: "overlays", overlays: [{ kind: "crosshair", at: [1, 1] }] },
    ]);
    click(h);
    const state = h.ui.getState();
    expect(state.camera).toEqual({ x: 3, y: 4, zoom: 2 });
    expect(state.selection).toEqual(["a", "b"]);
    expect(state.hover).toBe("a");
    expect(state.hoveredZone).toBe("room");
    expect(h.notices).toEqual([{ level: "warning", text: "careful" }]);
    expect(h.runtime.getView().overlays).toEqual([{ kind: "crosshair", at: [1, 1] }]);
  });

  test("a set_tool effect switches the machine and the store, with options", () => {
    const h = emitter(() => [{ type: "set_tool", tool: "zone-rect", options: { fog: true } }]);
    click(h);
    expect(h.runtime.machine().tool).toBe("zone-rect");
    expect(h.runtime.machine().tools["zone-rect"]?.options).toEqual({ fog: true });
    expect(h.ui.getState().tool).toEqual({ id: "zone-rect", options: { fog: true } });
    expect(h.cancelsOf("token")).toEqual(["tool_switch"]);
  });

  test("UiStore.setTool with new options for the active tool updates them without a cancel", () => {
    const h = setup({
      tool: "zone-rect",
      tools: (log) => [scriptedTool("select", log), scriptedTool("zone-rect", log)],
    });
    h.ui.setTool("zone-rect", { fog: true });
    expect(h.runtime.machine().tools["zone-rect"]?.options).toEqual({ fog: true });
    expect(h.cancelsOf("zone-rect")).toEqual([]);
  });

  test("open_editor and close_editor reach the EditorPort, with cell and rect", () => {
    const h = emitter((x) => [
      {
        type: "open_editor",
        stamp: x.stamp,
        object: "note",
        cell: "text",
        rect: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
      },
      { type: "open_editor", stamp: x.stamp, object: "token" },
      { type: "close_editor" },
    ]);
    click(h);
    const stamp = { interactionId: expect.any(String), board: "main", viewer: GM, baseRevision: 5 };
    expect(h.opened).toEqual([
      { stamp, object: "note", cell: "text", rect: { minX: 0, minY: 0, maxX: 2, maxY: 1 } },
      { stamp, object: "token" },
    ]);
    expect(h.closedCount()).toBe(1);
  });

  test("pick_file settles file_picked with the file, or null when dismissed or failed", async () => {
    const h = emitter((x) => [{ type: "pick_file", stamp: x.stamp, accept: "image/png" }]);
    click(h);
    click(h);
    click(h);
    expect(h.picks.map((p) => p.accept)).toEqual(["image/png", "image/png", "image/png"]);
    const file = new File(["png"], "a.png", { type: "image/png" });
    h.picks[0]?.result.resolve(file);
    h.picks[1]?.result.resolve(null);
    h.picks[2]?.result.reject(new Error("no dialog"));
    await flush();
    expect(h.settledOf("token")).toEqual([
      { type: "file_picked", file },
      { type: "file_picked", file: null },
      { type: "file_picked", file: null },
    ]);
  });

  test("an unknown continuation extension pushes one warning and the rest still run", async () => {
    const h = emitter((x) => [
      {
        type: "write",
        stamp: x.stamp,
        ops: [createOp("main", [0, 0], "token")],
        label: "Create",
        continuations: [
          { type: "extension", name: "nope", opIndex: 0 },
          { type: "select_created", opIndex: 0 },
        ],
      },
    ]);
    click(h);
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "token_1" }] }));
    await flush();
    expect(h.notices.filter((n) => n.level === "warning")).toHaveLength(1);
    expect(h.ui.getState().selection).toEqual(["token_1"]);
  });

  test("after dispose nothing reaches the tools or the stores", async () => {
    const h = setup();
    click(h);
    h.runtime.dispose();
    h.change({ board: "other" });
    expect(h.cancelsOf("token")).toEqual([]);
    h.lastWrite().result.resolve(committed({ created: [{ op_index: 0, id: "token_1" }] }));
    await flush();
    expect(h.settledOf("token")).toEqual([]);
    expect(h.ui.getState().selection).toEqual([]);
    h.ui.setTool("image");
    expect(h.runtime.machine().tool).toBe("token");
  });
});
