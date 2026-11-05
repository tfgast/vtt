/**
 * The navigation reducer (DESIGN.md §7 Platform; M4 plan review r1 finding 2,
 * r2 findings 3 and 8, r3 findings 1 and 2): one pure function from
 * `(state, event, input)` to `{state, effects}` in front of the tools.
 *
 * - Wheel → first the active tool's `wheel`, when it has one (with a fresh
 *   interaction id); when that returns null or the tool has none, a `camera`
 *   effect from `zoomAt` about the cursor, factor `1.1^(-deltaY/100)`
 *   (vtt-1xv.16).
 * - Middle-button drag, or a primary drag started while Space is held →
 *   `camera` effects from `panBy` (the grabbed board point follows the
 *   pointer) until that pointer is up; none of its events reach the tool.
 * - Escape → the active tool's `cancel(state, "escape")`. Space and Escape
 *   keys are the machine's and never reach a tool.
 * - Key events from text fields are dropped.
 * - A change of the active board or viewer (`syncInput`, also run first by
 *   `reduce`) and a tool switch (`setTool`) cancel the active tool first.
 * - `settled` goes to the tool whose effect carried that interaction id,
 *   active or not.
 * - Everything else goes to the active tool, with a fresh interaction id.
 *
 * The machine emits `camera` effects and never mutates camera state;
 * `set_tool` effects pass through for the runtime, which applies them with
 * `setTool`.
 */
import type { Viewer } from "@vtt/protocol";
import type { BoardId, Point } from "@vtt/schema";
import { panBy, zoomAt } from "../scene/camera";
import { type Effect, settlingInteraction } from "./effects";
import type { InteractionEvent } from "./events";
import type { ToolRegistry } from "./registry";
import {
  type CancelReason,
  DEFAULT_TOOL_OPTIONS,
  type ReducerInput,
  type SetToolRequest,
  type Tool,
  type ToolId,
  type ToolOptions,
  type ToolResult,
  type ToolState,
} from "./tool";

/** DOM `PointerEvent.button` values. */
export const PRIMARY_BUTTON = 0;
export const MIDDLE_BUTTON = 1;

/** The zoom factor of one wheel event: `1.1` per 100 px of `deltaY`, up is in. */
export function wheelZoomFactor(deltaY: number): number {
  return 1.1 ** (-deltaY / 100);
}

/** A pan in progress: the pointer driving it and its last screen point. */
export interface PanGesture {
  pointerId: number;
  last: Point;
}

/** Stamped effects of one interaction still awaiting `settled`. */
export interface PendingInteraction {
  tool: ToolId;
  outstanding: number;
}

export interface MachineState {
  /** The active tool. */
  readonly tool: ToolId;
  /** Every tool's state once started; inactive tools keep theirs for late results. */
  readonly tools: Readonly<Partial<Record<ToolId, ToolState>>>;
  /** The active board and viewer last seen, to detect changes. */
  readonly board: BoardId | null;
  readonly viewer: Viewer;
  /** Space is held (outside text fields). */
  readonly space: boolean;
  readonly pan: PanGesture | null;
  /**
   * Per interaction id with stamped effects not yet settled: the tool that
   * emitted them and how many are outstanding. Each `settled` result
   * decrements the count; the entry goes when it reaches zero. A cancel
   * keeps entries, since a started write or upload still settles back to its
   * tool (review r3 finding 1).
   */
  readonly pending: Readonly<Record<string, PendingInteraction>>;
  /** The counter behind fresh interaction ids. */
  readonly nextInteraction: number;
}

export interface MachineResult {
  state: MachineState;
  effects: Effect[];
}

function toolOf(registry: ToolRegistry, id: ToolId): Tool {
  const tool = registry.get(id);
  if (tool === undefined) throw new Error(`tool "${id}" is not registered`);
  return tool;
}

function stateOf(state: MachineState, id: ToolId, registry: ToolRegistry): ToolState {
  return state.tools[id] ?? toolOf(registry, id).init(DEFAULT_TOOL_OPTIONS[id]);
}

/** Stores a tool's new state and records the interactions its effects will settle. */
function applyTool(state: MachineState, id: ToolId, result: ToolResult): MachineResult {
  let pending = state.pending;
  for (const effect of result.effects) {
    const interactionId = settlingInteraction(effect);
    if (interactionId === null) continue;
    const outstanding = (pending[interactionId]?.outstanding ?? 0) + 1;
    pending = { ...pending, [interactionId]: { tool: id, outstanding } };
  }
  return {
    state: { ...state, tools: { ...state.tools, [id]: result.state }, pending },
    effects: result.effects,
  };
}

function sameViewer(a: Viewer, b: Viewer): boolean {
  if (a.type === "gm" || b.type === "gm") return a.type === b.type;
  return a.id === b.id;
}

function isKey(
  event: InteractionEvent,
): event is Extract<InteractionEvent, { type: "key_down" | "key_up" }> {
  return event.type === "key_down" || event.type === "key_up";
}

function isSpace(event: { key: string; code: string }): boolean {
  return event.code === "Space" || event.key === " ";
}

/** The first machine state: `tool` active with `options` (else its defaults). */
export function initMachine(
  registry: ToolRegistry,
  init: SetToolRequest & { board: BoardId | null; viewer: Viewer },
): MachineState {
  const tool = toolOf(registry, init.tool);
  const options: ToolOptions = init.options ?? DEFAULT_TOOL_OPTIONS[init.tool];
  return {
    tool: init.tool,
    tools: { [init.tool]: tool.init(options as never) },
    board: init.board,
    viewer: init.viewer,
    space: false,
    pan: null,
    pending: {},
    nextInteraction: 1,
  };
}

/** Calls the active tool's `cancel`. */
export function cancelActive(
  state: MachineState,
  reason: CancelReason,
  registry: ToolRegistry,
): MachineResult {
  const tool = toolOf(registry, state.tool);
  return applyTool(state, state.tool, tool.cancel(stateOf(state, state.tool, registry), reason));
}

/**
 * Cancels the active tool when the active board or viewer of `input`
 * differs from the last seen (a board change wins when both changed), and
 * ends a pan. Unchanged input returns `state` itself. The runtime calls it
 * from `RuntimeInputs.onChange`; `reduce` calls it first.
 */
export function syncInput(
  state: MachineState,
  input: Pick<ReducerInput, "activeBoard" | "viewer">,
  registry: ToolRegistry,
): MachineResult {
  const boardChanged = input.activeBoard !== state.board;
  if (!boardChanged && sameViewer(input.viewer, state.viewer)) return { state, effects: [] };
  const out = cancelActive(state, boardChanged ? "board_change" : "viewer_change", registry);
  return {
    state: { ...out.state, board: input.activeBoard, viewer: input.viewer, pan: null },
    effects: out.effects,
  };
}

/**
 * Activates a tool. Selecting the active tool again only replaces its
 * options (no cancel). Otherwise the active tool is cancelled first; the new
 * tool resumes its kept state (with `options` when given) or starts from
 * `init` with `options` or its defaults. An unregistered tool throws.
 */
export function setTool(
  state: MachineState,
  request: SetToolRequest,
  registry: ToolRegistry,
): MachineResult {
  const tool = toolOf(registry, request.tool);
  const replaceOptions = (s: ToolState): ToolState =>
    request.options === undefined ? s : ({ ...s, options: request.options } as ToolState);
  if (request.tool === state.tool) {
    const current = state.tools[request.tool];
    if (request.options === undefined || current === undefined) return { state, effects: [] };
    return {
      state: { ...state, tools: { ...state.tools, [request.tool]: replaceOptions(current) } },
      effects: [],
    };
  }
  const out = cancelActive(state, "tool_switch", registry);
  const kept = out.state.tools[request.tool];
  const next =
    kept === undefined
      ? tool.init((request.options ?? DEFAULT_TOOL_OPTIONS[request.tool]) as never)
      : replaceOptions(kept);
  return {
    state: {
      ...out.state,
      tool: request.tool,
      tools: { ...out.state.tools, [request.tool]: next },
    },
    effects: out.effects,
  };
}

/** Delivers `event` to tool `id` with a fresh interaction id. */
function deliver(
  state: MachineState,
  id: ToolId,
  event: InteractionEvent,
  input: ReducerInput,
  registry: ToolRegistry,
): MachineResult {
  const tool = toolOf(registry, id);
  const interactionId = `i${state.nextInteraction}`;
  const next = { ...state, nextInteraction: state.nextInteraction + 1 };
  return applyTool(
    next,
    id,
    tool.reduce(stateOf(next, id, registry), event, { ...input, interactionId }),
  );
}

function panTo(pan: PanGesture, screen: Point, input: ReducerInput): Effect[] {
  const dx = screen[0] - pan.last[0];
  const dy = screen[1] - pan.last[1];
  if (dx === 0 && dy === 0) return [];
  return [{ type: "camera", camera: panBy(input.camera, [dx, dy]) }];
}

function route(
  state: MachineState,
  event: InteractionEvent,
  input: ReducerInput,
  registry: ToolRegistry,
): MachineResult {
  const pan = state.pan;
  switch (event.type) {
    case "wheel": {
      const tool = toolOf(registry, state.tool);
      if (tool.wheel !== undefined) {
        const interactionId = `i${state.nextInteraction}`;
        const out = tool.wheel(stateOf(state, state.tool, registry), event, {
          ...input,
          interactionId,
        });
        if (out !== null) {
          return applyTool(
            { ...state, nextInteraction: state.nextInteraction + 1 },
            state.tool,
            out,
          );
        }
      }
      return {
        state,
        effects: [
          {
            type: "camera",
            camera: zoomAt(
              input.camera,
              event.screen,
              wheelZoomFactor(event.deltaY),
              input.viewport,
            ),
          },
        ],
      };
    }
    case "key_down":
    case "key_up":
      if (isSpace(event))
        return { state: { ...state, space: event.type === "key_down" }, effects: [] };
      if (event.key === "Escape") {
        return event.type === "key_down"
          ? cancelActive(state, "escape", registry)
          : { state, effects: [] };
      }
      return deliver(state, state.tool, event, input, registry);
    case "pointer_down":
      if (pan !== null && event.pointerId === pan.pointerId) return { state, effects: [] };
      if (
        pan === null &&
        (event.button === MIDDLE_BUTTON || (state.space && event.button === PRIMARY_BUTTON))
      ) {
        return {
          state: { ...state, pan: { pointerId: event.pointerId, last: event.screen } },
          effects: [],
        };
      }
      return deliver(state, state.tool, event, input, registry);
    case "pointer_move":
    case "pointer_up":
      if (pan !== null && event.pointerId === pan.pointerId) {
        const effects = panTo(pan, event.screen, input);
        const next: PanGesture | null =
          event.type === "pointer_up" ? null : { pointerId: pan.pointerId, last: event.screen };
        return { state: { ...state, pan: next }, effects };
      }
      return deliver(state, state.tool, event, input, registry);
    case "pointer_cancel":
      if (pan !== null && event.pointerId === pan.pointerId) {
        return { state: { ...state, pan: null }, effects: [] };
      }
      return deliver(state, state.tool, event, input, registry);
    case "settled": {
      const entry = state.pending[event.interactionId];
      if (entry === undefined || registry.get(entry.tool) === undefined) {
        return { state, effects: [] };
      }
      const { [event.interactionId]: _settled, ...rest } = state.pending;
      const pending =
        entry.outstanding > 1
          ? {
              ...rest,
              [event.interactionId]: { tool: entry.tool, outstanding: entry.outstanding - 1 },
            }
          : rest;
      return deliver({ ...state, pending }, entry.tool, event, input, registry);
    }
    default:
      return deliver(state, state.tool, event, input, registry);
  }
}

/**
 * The machine's reducer: syncs board and viewer (`syncInput`), drops key
 * events from text fields, then handles navigation or routes the event to a
 * tool. Effects of a sync come before the event's.
 */
export function reduce(
  state: MachineState,
  event: InteractionEvent,
  input: ReducerInput,
  registry: ToolRegistry,
): MachineResult {
  const synced = syncInput(state, input, registry);
  if (isKey(event) && event.inTextField) return synced;
  const out = route(synced.state, event, input, registry);
  return { state: out.state, effects: [...synced.effects, ...out.effects] };
}

/** The canvas cursor: grabbing while panning, grab while Space is held, else the active tool's. */
export function machineCursor(state: MachineState, registry: ToolRegistry): string {
  if (state.pan !== null) return "grabbing";
  if (state.space) return "grab";
  return toolOf(registry, state.tool).cursor(stateOf(state, state.tool, registry));
}
