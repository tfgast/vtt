/**
 * The tool contract (M4 plan review r1 finding 2, r2 findings 3 and 8, r3
 * finding 2; M5 plan Q1 A1). A tool is a pure reducer over its own typed
 * state: `(state, event, input) → {state, effects}`. It reads the world only
 * through the `ToolInput` snapshot, never calls ports, and asks for
 * everything else (writes, camera changes, selection) with effects.
 */
import type { ObjectView, Viewer } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import type { Camera } from "../scene/camera";
import type { Scene } from "../scene/scene";
import type { InteractionStamp, Viewport } from "./contracts";
import type { Effect } from "./effects";
import type { InteractionEvent } from "./events";

/** Tool ids: M4's tools, then M5's `layout`, `ink` and `text` (M5 Q1 A1). */
export const TOOL_IDS = [
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
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Options of a tool that has none. */
export type NoToolOptions = Record<never, never>;

/** Zone tools: with `fog`, the zone is created opaque and visible to the GM only (vtt-3l6.8). */
export interface ZoneToolOptions {
  fog: boolean;
}

/** Each tool's options, by id. */
export interface ToolOptionsMap {
  select: NoToolOptions;
  token: NoToolOptions;
  card: NoToolOptions;
  note: NoToolOptions;
  "zone-rect": ZoneToolOptions;
  "zone-circle": ZoneToolOptions;
  "zone-polygon": ZoneToolOptions;
  image: NoToolOptions;
  layout: NoToolOptions;
  ink: NoToolOptions;
  text: NoToolOptions;
}

/** The options of tool `K`. */
export type ToolOptions<K extends ToolId = ToolId> = ToolOptionsMap[K];

export const DEFAULT_TOOL_OPTIONS: { readonly [K in ToolId]: ToolOptionsMap[K] } = {
  select: {},
  token: {},
  card: {},
  note: {},
  "zone-rect": { fog: false },
  "zone-circle": { fog: false },
  "zone-polygon": { fog: false },
  image: {},
  layout: {},
  ink: {},
  text: {},
};

/** A tool id with its options, tagged by `tool`; options default to the tool's last or defaults. */
export type SetToolRequest = {
  [K in ToolId]: { tool: K; options?: ToolOptionsMap[K] };
}[ToolId];

/** A tool's state, tagged by `tool` so narrowing on it types `options`. */
export type ToolState<TPhase = unknown, K extends ToolId = ToolId> = {
  [I in K]: { tool: I; options: ToolOptionsMap[I]; phase: TPhase };
}[K];

/**
 * A snapshot taken by the runtime for each event, from `RuntimeInputs`
 * (scene, views, viewport, board, viewer, revision) and `UiStore` (camera,
 * selection). The scene is built without previews.
 */
export interface ReducerInput {
  scene: Scene;
  viewport: Viewport;
  activeBoard: BoardId | null;
  viewer: Viewer;
  revision: number;
  camera: Camera;
  selection: ObjectId[];
  views: (id: ObjectId) => ObjectView | null;
}

/**
 * What a tool receives: the snapshot plus an `interactionId` unique to this
 * event (assigned by the machine), which a tool starting an interaction on
 * this event puts in its stamp (`captureStamp`).
 */
export type ToolInput = ReducerInput & { interactionId: string };

/**
 * Why a tool is cancelled: Escape, a switch to another tool, or a change of
 * the active board or viewer (review r3 finding 1). A cancel ends unfinished
 * gestures only (drags, marquees, drafts); pending async results still
 * settle back to the tool. Only `escape` is a user command a tool may answer
 * beyond that (the select tool clears the selection when nothing was
 * in progress, vtt-3l6.7).
 */
export type CancelReason = "escape" | "tool_switch" | "board_change" | "viewer_change";

/** A `wheel` event, which a tool may claim before the camera zooms (`Tool.wheel`). */
export type WheelInteractionEvent = Extract<InteractionEvent, { type: "wheel" }>;

export interface ToolResult<TPhase = unknown, K extends ToolId = ToolId> {
  state: ToolState<TPhase, K>;
  effects: Effect[];
}

export interface Tool<TPhase = unknown, K extends ToolId = ToolId> {
  readonly id: K;
  /** The state the tool starts in with the given options. */
  init(options: ToolOptionsMap[K]): ToolState<TPhase, K>;
  /** A CSS cursor. */
  cursor(state: ToolState<TPhase, K>): string;
  reduce(
    state: ToolState<TPhase, K>,
    event: InteractionEvent,
    input: ToolInput,
  ): ToolResult<TPhase, K>;
  cancel(state: ToolState<TPhase, K>, reason: CancelReason): ToolResult<TPhase, K>;
  /**
   * Offered every `wheel` event before the camera zooms (vtt-1xv.16; M5 plan
   * review r2 finding 1): a result claims the event (the camera does not
   * zoom), null leaves it to the zoom. A tool without it never sees wheels.
   */
  wheel?(
    state: ToolState<TPhase, K>,
    event: WheelInteractionEvent,
    input: ToolInput,
  ): ToolResult<TPhase, K> | null;
}

/**
 * The stamp of an interaction starting on this event: the active board, the
 * viewer, the revision of the snapshot as `baseRevision` and the event's
 * interaction id; null when there is no active board.
 */
export function captureStamp(input: ToolInput): InteractionStamp | null {
  if (input.activeBoard === null) return null;
  return {
    interactionId: input.interactionId,
    board: input.activeBoard,
    viewer: input.viewer,
    baseRevision: input.revision,
  };
}
