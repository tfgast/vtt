/**
 * The navigation reducer (DESIGN.md §7 Platform; M4 plan review r1 finding 2,
 * r2 findings 3 and 8, r3 findings 1 and 2): one pure function from
 * `(state, event, input)` to `{state, effects}` in front of the tools.
 *
 * - Wheel → first the active tool's `wheel`, when it has one (with a fresh
 *   interaction id; a list that scrolls claims a plain wheel, vtt-1xv.16); when that
 *   returns null or the tool has none, a `camera` effect (M6-D11): with
 *   Ctrl or Meta held (how browsers deliver a trackpad pinch) from `zoomAt`
 *   about the cursor, factor `1.1^(-deltaY/100)`; otherwise from `panBy`,
 *   moving the view by `(deltaX, deltaY)` screen pixels.
 * - Middle-button drag, or a primary drag started while Space is held →
 *   `camera` effects from `panBy` (the grabbed board point follows the
 *   pointer) until that pointer is up; none of its events reach the tool.
 * - Touch (`pointerType` "touch", M6-D40; mouse and pen are unaffected): a
 *   lone touch reaches the tool as any pointer does, and is the long-press
 *   candidate until it moves more than `LONG_PRESS_SLOP_PX` from where it
 *   went down; its moves until then do not reach the tool. A second touch cancels the tool as Escape does and starts a
 *   two-finger gesture: each move of either finger is a `camera` effect from
 *   `pinchCamera` (the midpoint's movement pans, the distance's change zooms
 *   about the midpoint, clamped like any zoom). When one lifts, the other
 *   does nothing until it lifts too (or a finger joins it, resuming the
 *   gesture). A `long_press` for the candidate (the runtime's timer, after
 *   `LONG_PRESS_MS`) cancels the tool as Escape does and delivers a
 *   `double_click` with `longPress` at the press's point (a face field opens
 *   its editor); the rest of that touch does nothing. A selection the
 *   touch's press changed is put back when it becomes a two-finger gesture
 *   or a long press. Escape during a lone touch also ends it: no long press,
 *   its moves and release consumed.
 *   A result that cancelled the tool this way says `cancelled`.
 * - Escape → the active tool's `cancel(state, "escape")`. Space and Escape
 *   keys are the machine's, except that a Space key_down with focus on the
 *   canvas (`canvasFocused`) that starts a held Space also reaches the
 *   active tool, which may activate a focused face target with it
 *   (vtt-qf5.26); Space is held either way.
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
import type { BoardId, ObjectId, Point } from "@vtt/schema";
import { type Camera, panBy, type ViewportSize, zoomAt } from "../scene/camera";
import { type Effect, settlingInteraction } from "./effects";
import type { InteractionEvent, Modifiers, PointerInteractionEvent } from "./events";
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
  type WheelInteractionEvent,
} from "./tool";

/** DOM `PointerEvent.button` values. */
export const PRIMARY_BUTTON = 0;
export const MIDDLE_BUTTON = 1;

/** The zoom factor of one wheel event: `1.1` per 100 px of `deltaY`, up is in. */
export function wheelZoomFactor(deltaY: number): number {
  return 1.1 ** (-deltaY / 100);
}

/** How long a still touch is held before it is a long press (M6-D40). */
export const LONG_PRESS_MS = 500;

/** How far, in screen pixels, a long-press candidate may move and stay one. */
export const LONG_PRESS_SLOP_PX = 8;

/** A touch pointer down and its last screen point. */
export interface TouchPoint {
  pointerId: number;
  screen: Point;
}

/** A lone touch that may become a long press: where it went down. */
export interface LongPressCandidate {
  pointerId: number;
  screen: Point;
  board: Point;
  modifiers: Modifiers;
}

/**
 * The touch pointers down (M6-D40). `mode` is "tool" while one touch
 * reaches the tool, "pinch" while the first two of `points` drive the
 * camera, "spent" while the touches left after a pinch or a long press do
 * nothing, and "none" with no touch down.
 */
export interface TouchState {
  readonly points: readonly TouchPoint[];
  readonly mode: "none" | "tool" | "pinch" | "spent";
  readonly press: LongPressCandidate | null;
  /**
   * The selection when the first touch went down, restored if the touch's
   * press changed it and then became a two-finger gesture or a long press.
   */
  readonly selectionBefore: readonly ObjectId[] | null;
}

const NO_TOUCH: TouchState = { points: [], mode: "none", press: null, selectionBefore: null };

function sameIds(a: readonly ObjectId[], b: readonly ObjectId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** A `select` effect putting back `touch.selectionBefore` when `input`'s selection differs. */
function restoreSelection(touch: TouchState, input: ReducerInput): Effect[] {
  const before = touch.selectionBefore;
  if (before === null || sameIds(before, input.selection)) return [];
  return [{ type: "select", ids: [...before] }];
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
  /** Touch pointers and their gesture (M6-D40). */
  readonly touch: TouchState;
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
  /**
   * The event cancelled the active tool as Escape does (a second touch or a
   * long press, M6-D40), so the runtime treats the tool's started
   * interactions as it does on Escape.
   */
  cancelled?: true;
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
    touch: NO_TOUCH,
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
    state: {
      ...out.state,
      board: input.activeBoard,
      viewer: input.viewer,
      pan: null,
      touch: detachedTouch(out.state.touch),
    },
    effects: out.effects,
  };
}

/** After a cancel from outside: a touch reaching the tool does nothing more. */
function detachedTouch(touch: TouchState): TouchState {
  if (touch.mode !== "tool") return touch;
  return { ...touch, mode: "spent", press: null };
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
  const cancelled = cancelActive(state, "tool_switch", registry);
  const out = {
    ...cancelled,
    state: { ...cancelled.state, touch: detachedTouch(cancelled.state.touch) },
  };
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

/**
 * The camera effect of a wheel no tool claimed (M6-D11): Ctrl or Meta zooms
 * about the cursor; a plain wheel pans by its deltas (none for a zero wheel).
 */
function wheelCamera(event: WheelInteractionEvent, input: ReducerInput): Effect[] {
  if (event.modifiers.ctrl || event.modifiers.meta) {
    const factor = wheelZoomFactor(event.deltaY);
    return [{ type: "camera", camera: zoomAt(input.camera, event.screen, factor, input.viewport) }];
  }
  if (event.deltaX === 0 && event.deltaY === 0) return [];
  return [{ type: "camera", camera: panBy(input.camera, [-event.deltaX, -event.deltaY]) }];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * The camera after two fingers move from `before` to `after` (M6-D40): the
 * board point under the old midpoint follows the midpoint, and the zoom
 * changes by the ratio of the distances, about the new midpoint (clamped by
 * `zoomAt`). Fingers on one spot leave the zoom alone.
 */
export function pinchCamera(
  camera: Camera,
  before: readonly [Point, Point],
  after: readonly [Point, Point],
  viewport: ViewportSize,
): Camera {
  const m0 = midpoint(before[0], before[1]);
  const m1 = midpoint(after[0], after[1]);
  const panned = panBy(camera, [m1[0] - m0[0], m1[1] - m0[1]]);
  const d0 = distance(before[0], before[1]);
  const d1 = distance(after[0], after[1]);
  if (d0 === 0 || d1 === 0 || d0 === d1) return panned;
  return zoomAt(panned, m1, d1 / d0, viewport);
}

function isTouch(event: PointerInteractionEvent): boolean {
  return event.pointerType === "touch";
}

/** `touch` with pointer `id` at `screen` (added when new). */
function withPoint(touch: TouchState, id: number, screen: Point): TouchState {
  const known = touch.points.some((p) => p.pointerId === id);
  const points = known
    ? touch.points.map((p) => (p.pointerId === id ? { pointerId: id, screen } : p))
    : [...touch.points, { pointerId: id, screen }];
  return { ...touch, points };
}

/** `touch` without pointer `id`; its mode follows how many touches are left. */
function withoutPoint(touch: TouchState, id: number): TouchState {
  const points = touch.points.filter((p) => p.pointerId !== id);
  const press = touch.press?.pointerId === id ? null : touch.press;
  if (points.length === 0) return NO_TOUCH;
  if (touch.mode === "pinch" && points.length === 1)
    return { ...touch, points, mode: "spent", press };
  return { ...touch, points, press };
}

/** The touch branch of `route`, for a pointer event with `pointerType` "touch". */
function routeTouch(
  state: MachineState,
  event: PointerInteractionEvent,
  input: ReducerInput,
  registry: ToolRegistry,
): MachineResult {
  const touch = state.touch;
  const id = event.pointerId;
  const tracked = touch.points.some((p) => p.pointerId === id);
  const swallow = (next: TouchState): MachineResult => ({
    state: { ...state, touch: next },
    effects: [],
  });
  switch (event.type) {
    case "pointer_down": {
      if (tracked) return { state, effects: [] };
      if (touch.mode === "none") {
        const press: LongPressCandidate = {
          pointerId: id,
          screen: event.screen,
          board: event.board,
          modifiers: event.modifiers,
        };
        const next: TouchState = {
          selectionBefore: [...input.selection],
          points: [{ pointerId: id, screen: event.screen }],
          mode: "tool",
          press,
        };
        return deliver({ ...state, touch: next }, state.tool, event, input, registry);
      }
      const added = withPoint(touch, id, event.screen);
      if (touch.mode === "tool") {
        // A second finger: the first touch's gesture ends with no write, as on Escape,
        // and a selection its press made is undone.
        const out = cancelActive(state, "escape", registry);
        return {
          state: { ...out.state, touch: { ...added, mode: "pinch", press: null } },
          effects: [...out.effects, ...restoreSelection(touch, input)],
          cancelled: true,
        };
      }
      // A finger joining a pinch is tracked; one joining a spent touch resumes the pinch.
      return swallow(added.points.length >= 2 ? { ...added, mode: "pinch" } : added);
    }
    case "pointer_move": {
      if (!tracked) return deliver(state, state.tool, event, input, registry);
      const moved = withPoint(touch, id, event.screen);
      if (touch.mode === "tool") {
        const press =
          touch.press !== null && distance(touch.press.screen, event.screen) > LONG_PRESS_SLOP_PX
            ? null
            : touch.press;
        // Jitter within the slop stays off the tool, so a long press never starts a drag.
        if (press !== null) return swallow({ ...moved, press });
        return deliver(
          { ...state, touch: { ...moved, press } },
          state.tool,
          event,
          input,
          registry,
        );
      }
      if (touch.mode === "pinch") {
        const [a0, b0] = touch.points;
        const [a1, b1] = moved.points;
        if (a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined) {
          return swallow(moved);
        }
        if (a0.pointerId !== id && b0.pointerId !== id) return swallow(moved);
        const camera = pinchCamera(
          input.camera,
          [a0.screen, b0.screen],
          [a1.screen, b1.screen],
          input.viewport,
        );
        const same =
          camera.x === input.camera.x &&
          camera.y === input.camera.y &&
          camera.zoom === input.camera.zoom;
        return {
          state: { ...state, touch: moved },
          effects: same ? [] : [{ type: "camera", camera }],
        };
      }
      return swallow(moved);
    }
    case "pointer_up":
    case "pointer_cancel": {
      if (!tracked) return deliver(state, state.tool, event, input, registry);
      const next = withoutPoint(touch, id);
      if (touch.mode === "tool") {
        return deliver({ ...state, touch: next }, state.tool, event, input, registry);
      }
      return swallow(next);
    }
  }
}

/** A `long_press` from the runtime's timer (M6-D40). */
function longPress(
  state: MachineState,
  pointerId: number,
  input: ReducerInput,
  registry: ToolRegistry,
): MachineResult {
  const press = state.touch.press;
  if (state.touch.mode !== "tool" || press === null || press.pointerId !== pointerId) {
    return { state, effects: [] };
  }
  const cancelled = cancelActive(state, "escape", registry);
  const spent: MachineState = {
    ...cancelled.state,
    touch: { ...state.touch, mode: "spent", press: null },
  };
  const restore = restoreSelection(state.touch, input);
  const out = deliver(
    spent,
    state.tool,
    {
      type: "double_click",
      screen: press.screen,
      board: press.board,
      modifiers: press.modifiers,
      longPress: true,
    },
    restore.length === 0
      ? input
      : { ...input, selection: [...(state.touch.selectionBefore ?? [])] },
    registry,
  );
  return {
    state: out.state,
    effects: [...cancelled.effects, ...restore, ...out.effects],
    cancelled: true,
  };
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
      return { state, effects: wheelCamera(event, input) };
    }
    case "key_down":
    case "key_up":
      if (isSpace(event)) {
        const held = { ...state, space: event.type === "key_down" };
        if (event.type === "key_down" && !state.space && event.canvasFocused === true) {
          return deliver(held, state.tool, event, input, registry);
        }
        return { state: held, effects: [] };
      }
      if (event.key === "Escape") {
        if (event.type !== "key_down") return { state, effects: [] };
        // A touch reaching the tool stops there: no long press, its moves and release consumed.
        const out = cancelActive(state, "escape", registry);
        return { ...out, state: { ...out.state, touch: detachedTouch(out.state.touch) } };
      }
      return deliver(state, state.tool, event, input, registry);
    case "long_press":
      return longPress(state, event.pointerId, input, registry);
    case "pointer_down":
      if (pan !== null && event.pointerId === pan.pointerId) return { state, effects: [] };
      if (isTouch(event)) return routeTouch(state, event, input, registry);
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
      if (isTouch(event)) return routeTouch(state, event, input, registry);
      return deliver(state, state.tool, event, input, registry);
    case "pointer_cancel":
      if (pan !== null && event.pointerId === pan.pointerId) {
        return { state: { ...state, pan: null }, effects: [] };
      }
      if (isTouch(event)) return routeTouch(state, event, input, registry);
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
  return {
    state: out.state,
    effects: [...synced.effects, ...out.effects],
    ...(out.cancelled === true ? { cancelled: true as const } : {}),
  };
}

/** The canvas cursor: grabbing while panning, grab while Space is held, else the active tool's. */
export function machineCursor(state: MachineState, registry: ToolRegistry): string {
  if (state.pan !== null) return "grabbing";
  if (state.space) return "grab";
  return toolOf(registry, state.tool).cursor(stateOf(state, state.tool, registry));
}
