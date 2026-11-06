// @vitest-environment node
import type {
  ObjectView,
  ProtocolError,
  ProtocolRejection,
  TransactResult,
  Viewer,
  WireOp,
} from "@vtt/protocol";
import type { BoardId, Bounds, ObjectId, Point, Shape } from "@vtt/schema";
import {
  type Camera,
  type CameraPort,
  type CancelReason,
  CHROME_OVERLAY_KINDS,
  type ChromeToolOverlay,
  type CommittedWrite,
  type Continuation,
  captureStamp,
  createdIdAt,
  DEFAULT_TOOL_OPTIONS,
  type Effect,
  type InteractionEvent,
  type InteractionStamp,
  isChromeOverlay,
  isObjectOverlay,
  type Modifiers,
  type NoticeLevel,
  OBJECT_OVERLAY_KINDS,
  type ObjectToolOverlay,
  type Previews,
  type ReducerInput,
  type RuntimeInputs,
  type Scene,
  type ScenePreviews,
  type SetToolRequest,
  type SettledOutcome,
  splitOverlays,
  TOOL_IDS,
  type Tool,
  type ToolContext,
  type ToolId,
  type ToolInput,
  type ToolOptions,
  type ToolOverlay,
  type ToolResult,
  type ToolState,
  type UploadedAsset,
  type Viewport,
  type ViewportSize,
  type WriteOptions,
  type WriteOutcome,
  type WritePort,
} from "@vtt/ui";
import { describe, expect, expectTypeOf, test } from "vitest";

type Variant<U, T> = Extract<U, { type: T }>;

describe("ports (review r2 finding 3)", () => {
  test("WriteOutcome is the four statuses", () => {
    expectTypeOf<WriteOutcome["status"]>().toEqualTypeOf<
      "committed" | "rejected" | "uncertain" | "failed"
    >();
    expectTypeOf<CommittedWrite>().toEqualTypeOf<{
      status: "committed";
      revision: number;
      index: number;
      created: { op_index: number; id: ObjectId }[];
      copies: { op_index: number; root: ObjectId; copies: Record<ObjectId, ObjectId> }[];
      bindings: Record<string, ObjectId>;
    }>();
    expectTypeOf<Extract<WriteOutcome, { status: "committed" }>>().toEqualTypeOf<CommittedWrite>();
    expectTypeOf<Extract<WriteOutcome, { status: "rejected" }>>().toEqualTypeOf<{
      status: "rejected";
      rejection: ProtocolRejection;
      op_index?: number;
    }>();
    expectTypeOf<Extract<WriteOutcome, { status: "uncertain" }>>().toEqualTypeOf<{
      status: "uncertain";
      reason: string;
    }>();
    expectTypeOf<Extract<WriteOutcome, { status: "failed" }>>().toEqualTypeOf<{
      status: "failed";
      error: ProtocolError;
    }>();
  });

  test("a transact result is a WriteOutcome as it stands (no mapping needed)", () => {
    expectTypeOf<TransactResult>().toExtend<WriteOutcome>();
  });

  test("WritePort.write takes ops and a required base revision", () => {
    expectTypeOf<WriteOptions>().toEqualTypeOf<{ baseRevision: number; label?: string }>();
    expectTypeOf<WritePort["write"]>().toEqualTypeOf<
      (ops: WireOp[], opts: WriteOptions) => Promise<WriteOutcome>
    >();
    // @ts-expect-error baseRevision is required (review r1 finding 1)
    const _missing: WriteOptions = { label: "x" };
    void _missing;
  });

  test("CameraPort reads and sets a Camera", () => {
    expectTypeOf<CameraPort>().toEqualTypeOf<{ get(): Camera; set(camera: Camera): void }>();
  });

  test("ToolContext", () => {
    expectTypeOf<NoticeLevel>().toEqualTypeOf<"info" | "success" | "warning" | "error">();
    expectTypeOf<UploadedAsset>().toEqualTypeOf<{ path: string; width: number; height: number }>();
    expectTypeOf<ToolContext>().toEqualTypeOf<{
      activeBoard(): BoardId | null;
      viewer(): Viewer;
      revision(): number;
      camera: CameraPort;
      write: WritePort;
      notify(level: NoticeLevel, text: string): void;
      pickFile(accept: string): Promise<File | null>;
      upload(file: File): Promise<UploadedAsset>;
    }>();
  });

  test("Viewport is CSS pixels plus the device pixel ratio, and is a ViewportSize", () => {
    expectTypeOf<Viewport>().toEqualTypeOf<{ width: number; height: number; dpr: number }>();
    expectTypeOf<Viewport>().toExtend<ViewportSize>();
  });

  test("RuntimeInputs (review r3 finding 2)", () => {
    expectTypeOf<RuntimeInputs>().toEqualTypeOf<{
      views(id: ObjectId): ObjectView | null;
      directory?(id: ObjectId): ObjectView | null;
      scene(): Scene;
      viewport(): Viewport;
      activeBoard(): BoardId | null;
      viewer(): Viewer;
      revision(): number;
      onChange(fn: () => void): () => void;
    }>();
  });

  test("Previews is the scene's ScenePreviews", () => {
    expectTypeOf<Previews>().toEqualTypeOf<ScenePreviews>();
  });

  test("InteractionStamp (review r2 finding 8)", () => {
    expectTypeOf<InteractionStamp>().toEqualTypeOf<{
      interactionId: string;
      board: BoardId;
      viewer: Viewer;
      baseRevision: number;
    }>();
  });
});

describe("events", () => {
  test("the event union's tags", () => {
    expectTypeOf<InteractionEvent["type"]>().toEqualTypeOf<
      | "pointer_down"
      | "pointer_move"
      | "pointer_up"
      | "pointer_cancel"
      | "double_click"
      | "wheel"
      | "key_down"
      | "key_up"
      | "file_drop"
      | "data_drop"
      | "settled"
    >();
  });

  test("pointer events", () => {
    expectTypeOf<Modifiers>().toEqualTypeOf<{
      shift: boolean;
      alt: boolean;
      ctrl: boolean;
      meta: boolean;
    }>();
    expectTypeOf<Variant<InteractionEvent, "pointer_down">>().toEqualTypeOf<{
      type: "pointer_down";
      pointerId: number;
      screen: Point;
      board: Point;
      button: number;
      buttons: number;
      modifiers: Modifiers;
    }>();
    expectTypeOf<Omit<Variant<InteractionEvent, "pointer_move">, "type">>().toEqualTypeOf<
      Omit<Variant<InteractionEvent, "pointer_down">, "type">
    >();
    expectTypeOf<Omit<Variant<InteractionEvent, "pointer_up">, "type">>().toEqualTypeOf<
      Omit<Variant<InteractionEvent, "pointer_down">, "type">
    >();
    expectTypeOf<Omit<Variant<InteractionEvent, "pointer_cancel">, "type">>().toEqualTypeOf<
      Omit<Variant<InteractionEvent, "pointer_down">, "type">
    >();
  });

  test("double click, wheel, keys, drops", () => {
    expectTypeOf<Variant<InteractionEvent, "double_click">>().toEqualTypeOf<{
      type: "double_click";
      screen: Point;
      board: Point;
      modifiers: Modifiers;
    }>();
    expectTypeOf<Variant<InteractionEvent, "wheel">>().toEqualTypeOf<{
      type: "wheel";
      screen: Point;
      board: Point;
      deltaX: number;
      deltaY: number;
      modifiers: Modifiers;
    }>();
    expectTypeOf<Variant<InteractionEvent, "key_down">>().toEqualTypeOf<{
      type: "key_down";
      key: string;
      code: string;
      modifiers: Modifiers;
      inTextField: boolean;
      canvasFocused?: boolean;
    }>();
    expectTypeOf<Omit<Variant<InteractionEvent, "key_up">, "type">>().toEqualTypeOf<
      Omit<Variant<InteractionEvent, "key_down">, "type">
    >();
    expectTypeOf<Variant<InteractionEvent, "file_drop">>().toEqualTypeOf<{
      type: "file_drop";
      files: File[];
      screen: Point;
      board: Point;
    }>();
  });

  test("data_drop (M5 Q1 A1)", () => {
    expectTypeOf<Variant<InteractionEvent, "data_drop">>().toEqualTypeOf<{
      type: "data_drop";
      mime: string;
      data: string;
      screen: Point;
      board: Point;
    }>();
  });

  test("every positional event carries screen and board points", () => {
    type Positional = Exclude<InteractionEvent, { type: "key_down" | "key_up" | "settled" }>;
    expectTypeOf<Positional>().toExtend<{ screen: Point; board: Point }>();
  });

  test("settled and its outcomes", () => {
    expectTypeOf<Variant<InteractionEvent, "settled">>().toEqualTypeOf<{
      type: "settled";
      interactionId: string;
      outcome: SettledOutcome;
    }>();
    expectTypeOf<SettledOutcome>().toEqualTypeOf<
      | { type: "write"; result: WriteOutcome }
      | { type: "file_picked"; file: File | null }
      | { type: "uploaded"; path: string; width: number; height: number }
      | { type: "upload_failed"; message: string }
      | { type: "extension"; name: string; result: unknown }
    >();
  });
});

describe("tools", () => {
  test("ToolId includes the M4 tools and the M5 ones (Q1 A1)", () => {
    expectTypeOf<ToolId>().toEqualTypeOf<
      | "select"
      | "token"
      | "card"
      | "note"
      | "zone-rect"
      | "zone-circle"
      | "zone-polygon"
      | "image"
      | "layout"
      | "ink"
      | "text"
    >();
    expect([...TOOL_IDS].sort()).toEqual(
      [
        "select",
        "token",
        "card",
        "note",
        "zone-rect",
        "zone-circle",
        "zone-polygon",
        "image",
        "layout",
        "ink",
        "text",
      ].sort(),
    );
  });

  test("options are tagged per tool: zone tools carry fog", () => {
    expectTypeOf<ToolOptions<"zone-rect">>().toEqualTypeOf<{ fog: boolean }>();
    expectTypeOf<ToolOptions<"zone-circle">>().toEqualTypeOf<{ fog: boolean }>();
    expectTypeOf<ToolOptions<"zone-polygon">>().toEqualTypeOf<{ fog: boolean }>();
    expectTypeOf<keyof ToolOptions<"select">>().toEqualTypeOf<never>();
    expectTypeOf<keyof ToolOptions<"image">>().toEqualTypeOf<never>();
    expect(DEFAULT_TOOL_OPTIONS["zone-rect"]).toEqual({ fog: false });
    expect(DEFAULT_TOOL_OPTIONS.select).toEqual({});
    expect(Object.keys(DEFAULT_TOOL_OPTIONS).sort()).toEqual([...TOOL_IDS].sort());
  });

  test("ToolState is tagged by tool, so narrowing on tool types the options", () => {
    expectTypeOf<ToolState<"idle", "zone-rect">>().toEqualTypeOf<{
      tool: "zone-rect";
      options: { fog: boolean };
      phase: "idle";
    }>();
    const narrow = (s: ToolState<number>) => {
      if (s.tool === "zone-polygon") expectTypeOf(s.options).toEqualTypeOf<{ fog: boolean }>();
      expectTypeOf(s.phase).toEqualTypeOf<number>();
    };
    void narrow;
    // @ts-expect-error a zone tool's state requires fog
    const _bad: ToolState<null> = { tool: "zone-rect", options: {}, phase: null };
    void _bad;
  });

  test("ReducerInput is a snapshot; ToolInput adds the event's interaction id", () => {
    expectTypeOf<ReducerInput>().toEqualTypeOf<{
      scene: Scene;
      viewport: Viewport;
      activeBoard: BoardId | null;
      viewer: Viewer;
      revision: number;
      camera: Camera;
      selection: ObjectId[];
      views: (id: ObjectId) => ObjectView | null;
      directory?: (id: ObjectId) => ObjectView | null;
      snap?: boolean;
    }>();
    expectTypeOf<ToolInput>().toEqualTypeOf<ReducerInput & { interactionId: string }>();
  });

  test("the Tool interface", () => {
    type P = { n: number };
    type T = Tool<P, "token">;
    expectTypeOf<T["id"]>().toEqualTypeOf<"token">();
    expectTypeOf<CancelReason>().toEqualTypeOf<
      "escape" | "tool_switch" | "board_change" | "viewer_change"
    >();
    expectTypeOf<ToolResult<P, "token">>().toEqualTypeOf<{
      state: ToolState<P, "token">;
      effects: Effect[];
    }>();
    expectTypeOf<T["init"]>().toEqualTypeOf<
      (options: ToolOptions<"token">) => ToolState<P, "token">
    >();
    expectTypeOf<T["cursor"]>().toEqualTypeOf<(state: ToolState<P, "token">) => string>();
    expectTypeOf<T["reduce"]>().toEqualTypeOf<
      (
        state: ToolState<P, "token">,
        event: InteractionEvent,
        input: ToolInput,
      ) => ToolResult<P, "token">
    >();
    expectTypeOf<T["cancel"]>().toEqualTypeOf<
      (state: ToolState<P, "token">, reason: CancelReason) => ToolResult<P, "token">
    >();
    // A concrete tool is a registrable Tool.
    expectTypeOf<T>().toExtend<Tool>();
  });

  test("a tool written against ReducerInput and a one-argument cancel still satisfies Tool", () => {
    const tool = {
      id: "card" as const,
      init: (options: ToolOptions<"card">) => ({ tool: "card" as const, options, phase: 0 }),
      cursor: () => "crosshair",
      reduce: (state: ToolState<number, "card">, _e: InteractionEvent, _i: ReducerInput) => ({
        state,
        effects: [] as Effect[],
      }),
      cancel: (state: ToolState<number, "card">) => ({ state, effects: [] as Effect[] }),
    };
    expectTypeOf(tool).toExtend<Tool<number, "card">>();
  });
});

describe("overlays", () => {
  test("kinds and their split (DESIGN §4.6, M4-D16)", () => {
    expectTypeOf<ToolOverlay["kind"]>().toEqualTypeOf<
      | "drag_ghost"
      | "handles"
      | "creation_preview"
      | "polygon_draft"
      | "face_focus"
      | "marquee"
      | "crosshair"
    >();
    expectTypeOf<ObjectToolOverlay["kind"]>().toEqualTypeOf<
      "drag_ghost" | "handles" | "creation_preview" | "polygon_draft" | "face_focus"
    >();
    expectTypeOf<ChromeToolOverlay["kind"]>().toEqualTypeOf<"marquee" | "crosshair">();
    expect([...OBJECT_OVERLAY_KINDS]).toEqual([
      "drag_ghost",
      "handles",
      "creation_preview",
      "polygon_draft",
      "face_focus",
    ]);
    expect([...CHROME_OVERLAY_KINDS]).toEqual(["marquee", "crosshair"]);
  });

  test("overlay shapes, in board coordinates", () => {
    expectTypeOf<Extract<ToolOverlay, { kind: "drag_ghost" }>>().toEqualTypeOf<{
      kind: "drag_ghost";
      items: { id: ObjectId; anchor: Point; rotation: number; shape: Shape | null }[];
    }>();
    expectTypeOf<Extract<ToolOverlay, { kind: "handles" }>>().toEqualTypeOf<{
      kind: "handles";
      object: ObjectId;
      handles: {
        key: string;
        role: "resize" | "radius" | "vertex" | "rotate";
        at: Point;
        from?: Point;
      }[];
    }>();
    expectTypeOf<Extract<ToolOverlay, { kind: "creation_preview" }>>().toEqualTypeOf<{
      kind: "creation_preview";
      anchor: Point;
      shape: Shape;
      zone: boolean;
    }>();
    expectTypeOf<Extract<ToolOverlay, { kind: "polygon_draft" }>>().toEqualTypeOf<{
      kind: "polygon_draft";
      points: Point[];
      cursor: Point | null;
      closing: boolean;
    }>();
    expectTypeOf<Extract<ToolOverlay, { kind: "marquee" }>>().toEqualTypeOf<{
      kind: "marquee";
      rect: Bounds;
    }>();
    expectTypeOf<Extract<ToolOverlay, { kind: "crosshair" }>>().toEqualTypeOf<{
      kind: "crosshair";
      at: Point;
    }>();
  });

  test("splitOverlays keeps order within each group", () => {
    const overlays: ToolOverlay[] = [
      { kind: "marquee", rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
      {
        kind: "creation_preview",
        anchor: [0, 0],
        shape: { type: "circle", radius: 1 },
        zone: false,
      },
      { kind: "crosshair", at: [1, 1] },
      { kind: "polygon_draft", points: [[0, 0]], cursor: null, closing: false },
    ];
    const { object, chrome } = splitOverlays(overlays);
    expect(object.map((o) => o.kind)).toEqual(["creation_preview", "polygon_draft"]);
    expect(chrome.map((o) => o.kind)).toEqual(["marquee", "crosshair"]);
    expect(overlays.filter(isObjectOverlay)).toEqual(object);
    expect(overlays.filter(isChromeOverlay)).toEqual(chrome);
    expectTypeOf(object).toEqualTypeOf<ObjectToolOverlay[]>();
    expectTypeOf(chrome).toEqualTypeOf<ChromeToolOverlay[]>();
  });
});

describe("effects and continuations", () => {
  test("the effect union's tags", () => {
    expectTypeOf<Effect["type"]>().toEqualTypeOf<
      | "write"
      | "select"
      | "camera"
      | "previews"
      | "overlays"
      | "hover"
      | "alt_hover"
      | "notice"
      | "set_tool"
      | "pick_file"
      | "upload"
      | "open_editor"
      | "close_editor"
      | "key_handled"
      | "extension"
    >();
  });

  test("each effect's fields", () => {
    expectTypeOf<Variant<Effect, "write">>().toEqualTypeOf<{
      type: "write";
      stamp: InteractionStamp;
      ops: WireOp[];
      label: string;
      continuations: Continuation[];
    }>();
    expectTypeOf<Variant<Effect, "select">>().toEqualTypeOf<{ type: "select"; ids: ObjectId[] }>();
    expectTypeOf<Variant<Effect, "camera">>().toEqualTypeOf<{ type: "camera"; camera: Camera }>();
    expectTypeOf<Variant<Effect, "previews">>().toEqualTypeOf<{
      type: "previews";
      previews: Previews;
      hold?: { stamp: InteractionStamp };
    }>();
    expectTypeOf<Variant<Effect, "overlays">>().toEqualTypeOf<{
      type: "overlays";
      overlays: ToolOverlay[];
    }>();
    expectTypeOf<Variant<Effect, "hover">>().toEqualTypeOf<{
      type: "hover";
      id: ObjectId | null;
      zone: ObjectId | null;
    }>();
    expectTypeOf<Variant<Effect, "alt_hover">>().toEqualTypeOf<{
      type: "alt_hover";
      id: ObjectId | null;
    }>();
    expectTypeOf<Variant<Effect, "notice">>().toEqualTypeOf<{
      type: "notice";
      level: NoticeLevel;
      text: string;
    }>();
    expectTypeOf<Variant<Effect, "set_tool">>().toEqualTypeOf<
      { type: "set_tool" } & SetToolRequest
    >();
    expectTypeOf<Variant<Effect, "pick_file">>().toEqualTypeOf<{
      type: "pick_file";
      stamp: InteractionStamp;
      accept: string;
    }>();
    expectTypeOf<Variant<Effect, "upload">>().toEqualTypeOf<{
      type: "upload";
      stamp: InteractionStamp;
      file: File;
    }>();
    expectTypeOf<Variant<Effect, "close_editor">>().toEqualTypeOf<{ type: "close_editor" }>();
  });

  test("open_editor with an optional board-space rect (M5 Q1 A5)", () => {
    expectTypeOf<Variant<Effect, "open_editor">>().toEqualTypeOf<{
      type: "open_editor";
      stamp: InteractionStamp;
      object: ObjectId;
      cell?: string;
      rect?: Bounds;
    }>();
  });

  test("the extension effect (M5 Q1 A1)", () => {
    expectTypeOf<Variant<Effect, "extension">>().toEqualTypeOf<{
      type: "extension";
      name: string;
      stamp?: InteractionStamp;
      payload: unknown;
    }>();
  });

  test("set_tool options are tagged by tool", () => {
    const ok: SetToolRequest[] = [
      { tool: "select" },
      { tool: "zone-rect", options: { fog: true } },
      { tool: "zone-polygon" },
    ];
    void ok;
    // @ts-expect-error a zone tool's options need fog
    const _bad: SetToolRequest = { tool: "zone-circle", options: {} };
    void _bad;
  });

  test("continuations, including the extension variant (M5 Q1 A1)", () => {
    expectTypeOf<Continuation>().toEqualTypeOf<
      | { type: "select_created"; opIndex: number }
      | { type: "select"; ids: ObjectId[] }
      | ({ type: "set_tool" } & SetToolRequest)
      | { type: "extension"; name: string; opIndex?: number; payload?: unknown }
    >();
  });

  test("createdIdAt matches op_index in created, then the root of copies; never position", () => {
    const result: CommittedWrite = {
      status: "committed",
      revision: 9,
      index: 4,
      created: [{ op_index: 1, id: "token_3" }],
      copies: [{ op_index: 2, root: "goblin2", copies: { goblin: "goblin2", sword: "sword2" } }],
      bindings: {},
    };
    expect(createdIdAt(result, 1)).toBe("token_3");
    expect(createdIdAt(result, 2)).toBe("goblin2");
    // op 0 is a set_value: it created nothing, though created[0] exists.
    expect(createdIdAt(result, 0)).toBeNull();
    expect(createdIdAt(result, 3)).toBeNull();
  });

  test("captureStamp takes board, viewer and revision from the input, id from the event", () => {
    const input = {
      activeBoard: "main",
      viewer: { type: "gm" },
      revision: 12,
      interactionId: "i7",
    } as ToolInput;
    expect(captureStamp(input)).toEqual({
      interactionId: "i7",
      board: "main",
      viewer: { type: "gm" },
      baseRevision: 12,
    });
    expect(captureStamp({ ...input, activeBoard: null })).toBeNull();
    expectTypeOf(captureStamp).returns.toEqualTypeOf<InteractionStamp | null>();
  });
});
