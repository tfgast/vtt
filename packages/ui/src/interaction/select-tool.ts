/**
 * The select tool (vtt-3l6.7; DESIGN.md §3.3, §4.1, §4.6 On the canvas, §4.7,
 * §8.1; FORMULAS.md §3.1 landing rule, §8.3; docs/PROTOCOL.md §5, §6; M4-D8,
 * M4-D9; M4 plan Q10–Q12, review r1 findings 1, 5, 6, 15, r2 findings 8, 10,
 * r3 findings 2, 7; M5 plan Q1 A4 as amended in review r1 finding 9). A pure
 * reducer on vtt-3l6.22's `Tool` contract, registered under id `select`.
 * Navigation (wheel zoom, pan) is the machine's.
 *
 * - Click: selects the first entry of `hitsAt` (Shift toggles it); a click on
 *   empty clears. Alt+click without movement cycles through `hitsAt` on
 *   repeated clicks within `ALT_CYCLE_RADIUS_PX` of the first (the cycle
 *   resets when the point or the hit list changes); the cycled target is the
 *   hover target until the pointer leaves its footprint.
 * - Drag on empty: a marquee (`marqueeHit`; Shift adds to the selection).
 * - Drag on a selected object (any entry of `hitsAt` that is selected) drags
 *   the selection drawn on the active board; on an unselected hit it drags
 *   that object (with Shift: the selection plus it) and selects what it drags.
 *   The stamp and the intent are captured at pointer down: `spawn` for
 *   exactly one template without Alt, otherwise `move` (M4-D8). Beyond
 *   `SELECT_DRAG_THRESHOLD_PX` it shows a `drag_ghost` and, for a move,
 *   previews. The drop is one write with that stamp and previews held by it:
 *   a `dropOverride` result when there is one; else a spawn at the moved
 *   anchor (selecting the copy); else, with Alt held at the drop over
 *   another non-zone object, one `move` per object into its `contents`
 *   (M4-D9); else one `move` per object onto the active board, back to front
 *   so the landing rule keeps their stacking order.
 * - Alt-hover (DESIGN.md §4.6 Only when selected, M6-D12): during a drag,
 *   each pointer move (and an Alt key release) recomputes `altHoverAt`, kept
 *   in the drag gesture and emitted as an `alt_hover` effect when it
 *   changes; the drop recomputes it at the release point and passes it to
 *   the `dropOverride`; the drop and any cancel clear it.
 * - Double-click on an object: `open_editor`.
 * - Keys: `selectKeyEffects` (keys.ts), when no gesture is in progress.
 * - Cancel (Escape, board or viewer change, tool switch, `pointer_cancel`)
 *   ends a gesture with no write; Escape with no gesture clears the selection.
 */
import type { ObjectView, WireOp } from "@vtt/protocol";
import type { Bounds, ObjectId, Point, Shape } from "@vtt/schema";
import { altHoverAt } from "../face/face-scene";
import { hitsAt, marqueeHit } from "../scene/hit-test";
import type { DrawItem, Scene, ScenePreview } from "../scene/scene";
import type { InteractionStamp, Previews } from "./contracts";
import type { Continuation, Effect } from "./effects";
import type { InteractionEvent, Modifiers, PointerInteractionEvent } from "./events";
import { selectKeyEffects } from "./keys";
import { PRIMARY_BUTTON } from "./machine";
import type { ToolOverlay } from "./overlays";
import {
  type CancelReason,
  captureStamp,
  type NoToolOptions,
  type ReducerInput,
  type Tool,
  type ToolInput,
  type ToolResult,
  type ToolState,
} from "./tool";

/** A press becomes a drag (or a marquee) beyond this many screen pixels. */
export const SELECT_DRAG_THRESHOLD_PX = 4;
/** Alt+clicks within this many screen pixels of the cycle's point continue the cycle. */
export const ALT_CYCLE_RADIUS_PX = 4;

/** A drag's intent, fixed at pointer down (M4-D8): `copy` exactly when it would spawn. */
export interface DropIntent {
  copy: boolean;
  /** Alt at pointer down. */
  alt: boolean;
}

/** What a `dropOverride` returns to replace a drop's write. */
export interface DropOverrideResult {
  ops: WireOp[];
  label: string;
  /** Default: none. */
  continuations?: Continuation[];
}

/** What the select tool knows at the drop beyond the intent. */
export interface DropContext {
  /** The drag's Alt-hover at the release (`altHoverAt`; M6-D12). */
  altHover: ObjectId | null;
}

/**
 * Consulted first at the drop of every drag (M5 Q1 A4): the input at the
 * drop, the drop's board point, the dragged ids (back to front), the
 * intent captured at pointer down and the drop context. A non-null result
 * replaces the drop's ops, label and continuations (same stamp, same held
 * previews).
 */
export type DropOverride = (
  input: ReducerInput,
  point: Point,
  draggedIds: ObjectId[],
  intent: DropIntent,
  context?: DropContext,
) => DropOverrideResult | null;

export interface SelectToolOptions {
  dropOverride?: DropOverride;
}

/** One dragged object: where it was when the drag began. */
export interface DraggedItem {
  id: ObjectId;
  anchor: Point;
  rotation: number;
  shape: Shape | null;
}

/** A drag as decided at pointer down. */
export interface DragPlan {
  stamp: InteractionStamp;
  /** Back to front. */
  items: DraggedItem[];
  spawn: boolean;
  /** Alt at pointer down. */
  alt: boolean;
  /** The selection to set when the drag starts, or null to keep it. */
  select: ObjectId[] | null;
}

/** An Alt+click cycle: its first point (screen), the hit list there, the index selected. */
export interface AltCycle {
  screen: Point;
  hits: ObjectId[];
  index: number;
}

export interface HoverTarget {
  id: ObjectId | null;
  zone: ObjectId | null;
}

export type SelectGesture =
  | { kind: "idle" }
  /** A pointer is down and has not passed the threshold. `plan` is null on empty space. */
  | {
      kind: "press";
      pointerId: number;
      screen: Point;
      board: Point;
      hits: ObjectId[];
      modifiers: Modifiers;
      plan: DragPlan | null;
    }
  | {
      kind: "drag";
      pointerId: number;
      grab: Point;
      plan: DragPlan;
      /** The object an Alt-held drag hovers (M6-D12), or null. */
      altHover: ObjectId | null;
    }
  | { kind: "marquee"; pointerId: number; start: Point; shift: boolean };

export interface SelectPhase {
  gesture: SelectGesture;
  cycle: AltCycle | null;
  /** The Alt+click target that stays the hover target while the pointer is in its footprint. */
  hoverLock: ObjectId | null;
  /** The last hover emitted. */
  hover: HoverTarget;
}

export type SelectToolState = ToolState<SelectPhase, "select">;

const IDLE: SelectGesture = { kind: "idle" };
const NO_HOVER: HoverTarget = { id: null, zone: null };
const EMPTY_PREVIEWS: Previews = new Map();

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const sameIds = (a: readonly ObjectId[], b: readonly ObjectId[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function itemOf(scene: Scene, id: ObjectId): DrawItem | undefined {
  return scene.items.find((item) => item.id === id);
}

function isZone(scene: Scene, id: ObjectId): boolean {
  return itemOf(scene, id)?.isZone ?? false;
}

function hoverFor(scene: Scene, id: ObjectId | null): HoverTarget {
  return { id, zone: id !== null && isZone(scene, id) ? id : null };
}

function nameOf(view: ObjectView | null, id: ObjectId): string {
  const name = view?.cells.name?.value;
  return name?.type === "text" && name.value !== "" ? name.value : id;
}

function countLabel(ids: readonly ObjectId[], input: ReducerInput): string {
  return ids.length === 1
    ? nameOf(input.views(ids[0] as ObjectId), ids[0] as ObjectId)
    : `${ids.length} objects`;
}

function moved(item: DraggedItem, delta: Point): Point {
  return [item.anchor[0] + delta[0], item.anchor[1] + delta[1]];
}

function normalized(a: Point, b: Point): Bounds {
  return {
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1]),
  };
}

/** The previews of a drag at `delta`: positions for a move, none for a spawn. */
function dragPreviews(plan: DragPlan, delta: Point): Previews {
  if (plan.spawn) return EMPTY_PREVIEWS;
  return new Map<ObjectId, ScenePreview>(
    plan.items.map((item) => [item.id, { position: moved(item, delta) }]),
  );
}

function ghost(plan: DragPlan, delta: Point): ToolOverlay {
  return {
    kind: "drag_ghost",
    items: plan.items.map((item) => ({
      id: item.id,
      anchor: moved(item, delta),
      rotation: item.rotation,
      shape: item.shape,
    })),
  };
}

/** Decides at pointer down what a drag from here would drag, and how. */
function planDrag(input: ToolInput, hits: ObjectId[], modifiers: Modifiers): DragPlan | null {
  const first = hits[0];
  if (first === undefined) return null;
  const stamp = captureStamp(input);
  if (stamp === null) return null;
  const selected = new Set(input.selection);
  let ids: Set<ObjectId>;
  let select: ObjectId[] | null = null;
  if (hits.some((id) => selected.has(id))) {
    ids = selected;
  } else if (modifiers.shift) {
    ids = new Set([...input.selection, first]);
    select = [...input.selection, first];
  } else {
    ids = new Set([first]);
    select = [first];
  }
  // Only objects drawn on the active board are dragged, back to front.
  const items: DraggedItem[] = input.scene.items
    .filter((item) => ids.has(item.id))
    .map((item) => ({
      id: item.id,
      anchor: [item.anchor[0], item.anchor[1]],
      rotation: item.rotation,
      shape: item.shape,
    }));
  if (items.length === 0) return null;
  const only = items.length === 1 ? input.views((items[0] as DraggedItem).id) : null;
  const spawn = only?.is_template === true && !modifiers.alt;
  return { stamp, items, spawn, alt: modifiers.alt, select };
}

export function createSelectTool(options: SelectToolOptions = {}): Tool<SelectPhase, "select"> {
  const { dropOverride } = options;

  type State = SelectToolState;
  type Result = ToolResult<SelectPhase, "select">;

  const withPhase = (state: State, patch: Partial<SelectPhase>): State => ({
    ...state,
    phase: { ...state.phase, ...patch },
  });

  /** A hover effect when `next` differs from the last one emitted. */
  const hoverEffects = (state: State, next: HoverTarget): Effect[] =>
    state.phase.hover.id === next.id && state.phase.hover.zone === next.zone
      ? []
      : [{ type: "hover", id: next.id, zone: next.zone }];

  /** The drag's Alt-hover after `event` (`altHoverAt`). */
  const nextAltHover = (
    g: Extract<SelectGesture, { kind: "drag" }>,
    event: PointerInteractionEvent,
    input: ToolInput,
  ): ObjectId | null =>
    altHoverAt({
      scene: input.scene,
      views: input.views,
      previous: g.altHover,
      point: event.board,
      camera: input.camera,
      alt: event.modifiers.alt,
      dragged: g.plan.items.map((item) => item.id),
    });

  /** The drop's ops, label and continuations. */
  function dropWrite(
    plan: DragPlan,
    delta: Point,
    event: PointerInteractionEvent,
    input: ToolInput,
    altHover: ObjectId | null,
  ): { ops: WireOp[]; label: string; continuations: Continuation[] } {
    const ids = plan.items.map((item) => item.id);
    const override = dropOverride?.(
      input,
      event.board,
      ids,
      { copy: plan.spawn, alt: plan.alt },
      { altHover },
    );
    if (override != null) {
      return {
        ops: override.ops,
        label: override.label,
        continuations: override.continuations ?? [],
      };
    }
    const board = plan.stamp.board;
    if (plan.spawn) {
      const item = plan.items[0] as DraggedItem;
      return {
        ops: [
          {
            type: "spawn",
            template: item.id,
            to: { type: "board", board, position: moved(item, delta) },
          },
        ],
        label: `Copy ${nameOf(input.views(item.id), item.id)}`,
        continuations: [{ type: "select_created", opIndex: 0 }],
      };
    }
    if (event.modifiers.alt) {
      const dragged = new Set(ids);
      const target = hitsAt(input.scene, event.board, input.camera).find((id) => !dragged.has(id));
      if (target !== undefined && !isZone(input.scene, target)) {
        return {
          ops: ids.map((object) => ({
            type: "move",
            object,
            to: { type: "container", container: target },
          })),
          label: `Put ${countLabel(ids, input)} into ${nameOf(input.views(target), target)}`,
          continuations: [],
        };
      }
    }
    return {
      ops: plan.items.map((item) => ({
        type: "move",
        object: item.id,
        to: { type: "board", board, position: moved(item, delta) },
      })),
      label: `Move ${countLabel(ids, input)}`,
      continuations: [],
    };
  }

  function pointerDown(state: State, event: PointerInteractionEvent, input: ToolInput): Result {
    if (state.phase.gesture.kind !== "idle" || event.button !== PRIMARY_BUTTON) {
      return { state, effects: [] };
    }
    const hits = hitsAt(input.scene, event.board, input.camera);
    const plan = planDrag(input, hits, event.modifiers);
    return {
      state: withPhase(state, {
        gesture: {
          kind: "press",
          pointerId: event.pointerId,
          screen: event.screen,
          board: event.board,
          hits,
          modifiers: event.modifiers,
          plan,
        },
      }),
      effects: [],
    };
  }

  /** Hover while no gesture is in progress. */
  function hoverMove(state: State, event: PointerInteractionEvent, input: ToolInput): Result {
    const hits = hitsAt(input.scene, event.board, input.camera);
    const lock = state.phase.hoverLock;
    if (lock !== null && hits.includes(lock)) {
      const next = hoverFor(input.scene, lock);
      return { state: withPhase(state, { hover: next }), effects: hoverEffects(state, next) };
    }
    const next = hoverFor(input.scene, hits[0] ?? null);
    return {
      state: withPhase(state, { hover: next, hoverLock: null }),
      effects: hoverEffects(state, next),
    };
  }

  function pointerMove(state: State, event: PointerInteractionEvent, input: ToolInput): Result {
    const g = state.phase.gesture;
    if (g.kind === "idle") return hoverMove(state, event, input);
    if (g.pointerId !== event.pointerId) return { state, effects: [] };
    // The Alt+click hover lock ends when the pointer leaves its footprint, gesture or not.
    const lock = state.phase.hoverLock;
    if (lock !== null && !hitsAt(input.scene, event.board, input.camera).includes(lock)) {
      return pointerMove(withPhase(state, { hoverLock: null }), event, input);
    }
    if (g.kind === "press") {
      if (distance(g.screen, event.screen) <= SELECT_DRAG_THRESHOLD_PX) {
        return { state, effects: [] };
      }
      if (g.plan === null) {
        const next = withPhase(state, {
          gesture: {
            kind: "marquee",
            pointerId: g.pointerId,
            start: g.board,
            shift: g.modifiers.shift,
          },
        });
        return pointerMove(next, event, input);
      }
      const plan = g.plan;
      const next = withPhase(state, {
        gesture: { kind: "drag", pointerId: g.pointerId, grab: g.board, plan, altHover: null },
      });
      const out = pointerMove(next, event, input);
      const select: Effect[] = plan.select === null ? [] : [{ type: "select", ids: plan.select }];
      return { state: out.state, effects: [...select, ...out.effects] };
    }
    if (g.kind === "marquee") {
      return {
        state,
        effects: [
          {
            type: "overlays",
            overlays: [{ kind: "marquee", rect: normalized(g.start, event.board) }],
          },
        ],
      };
    }
    const delta: Point = [event.board[0] - g.grab[0], event.board[1] - g.grab[1]];
    const altHover = nextAltHover(g, event, input);
    const hoverChange: Effect[] =
      altHover === g.altHover ? [] : [{ type: "alt_hover", id: altHover }];
    return {
      state: altHover === g.altHover ? state : withPhase(state, { gesture: { ...g, altHover } }),
      effects: [
        { type: "previews", previews: dragPreviews(g.plan, delta) },
        { type: "overlays", overlays: [ghost(g.plan, delta)] },
        ...hoverChange,
      ],
    };
  }

  /** A press released without passing the threshold. */
  function click(
    state: State,
    g: Extract<SelectGesture, { kind: "press" }>,
    input: ToolInput,
  ): Result {
    const idle = withPhase(state, { gesture: IDLE });
    const { hits, modifiers } = g;
    if (modifiers.alt && hits.length > 0) {
      const cycle = state.phase.cycle;
      const continues =
        cycle !== null &&
        distance(cycle.screen, g.screen) <= ALT_CYCLE_RADIUS_PX &&
        sameIds(cycle.hits, hits);
      const nextCycle: AltCycle = continues
        ? { ...cycle, index: (cycle.index + 1) % hits.length }
        : { screen: g.screen, hits, index: 0 };
      const target = hits[nextCycle.index] as ObjectId;
      const hover = hoverFor(input.scene, target);
      return {
        state: withPhase(idle, { cycle: nextCycle, hoverLock: target, hover }),
        effects: [{ type: "select", ids: [target] }, ...hoverEffects(state, hover)],
      };
    }
    const first = hits[0];
    const hover = hoverFor(input.scene, first ?? null);
    const reset = withPhase(idle, { cycle: null, hoverLock: null, hover });
    const hoverOut = hoverEffects(state, hover);
    if (first === undefined) {
      return { state: reset, effects: [{ type: "select", ids: [] }, ...hoverOut] };
    }
    if (modifiers.shift) {
      const ids = input.selection.includes(first)
        ? input.selection.filter((id) => id !== first)
        : [...input.selection, first];
      return { state: reset, effects: [{ type: "select", ids }, ...hoverOut] };
    }
    return { state: reset, effects: [{ type: "select", ids: [first] }, ...hoverOut] };
  }

  function pointerUp(state: State, event: PointerInteractionEvent, input: ToolInput): Result {
    const g = state.phase.gesture;
    if (g.kind === "idle" || g.pointerId !== event.pointerId) return { state, effects: [] };
    if (g.kind === "press") return click(state, g, input);
    // A drop or marquee ends here: the hover is recomputed at the pointer.
    const ended = hoverMove(withPhase(state, { gesture: IDLE, cycle: null }), event, input);
    if (g.kind === "marquee") {
      const inside = marqueeHit(input.scene, normalized(g.start, event.board));
      const ids = g.shift ? [...new Set([...input.selection, ...inside])] : inside;
      return {
        state: ended.state,
        effects: [{ type: "overlays", overlays: [] }, { type: "select", ids }, ...ended.effects],
      };
    }
    const { plan } = g;
    const delta: Point = [event.board[0] - g.grab[0], event.board[1] - g.grab[1]];
    const altHover = nextAltHover(g, event, input);
    const { ops, label, continuations } = dropWrite(plan, delta, event, input, altHover);
    return {
      state: ended.state,
      effects: [
        { type: "write", stamp: plan.stamp, ops, label, continuations },
        { type: "previews", previews: dragPreviews(plan, delta), hold: { stamp: plan.stamp } },
        { type: "overlays", overlays: [] },
        ...(g.altHover === null ? [] : [{ type: "alt_hover", id: null } as const]),
        ...ended.effects,
      ],
    };
  }

  /** Ends a gesture with no write. */
  function endGesture(state: State): Result {
    const g = state.phase.gesture;
    const idle = withPhase(state, { gesture: IDLE });
    switch (g.kind) {
      case "idle":
      case "press":
        return { state: idle, effects: [] };
      case "marquee":
        return { state: idle, effects: [{ type: "overlays", overlays: [] }] };
      case "drag":
        return {
          state: idle,
          effects: [
            { type: "previews", previews: EMPTY_PREVIEWS },
            { type: "overlays", overlays: [] },
            ...(g.altHover === null ? [] : [{ type: "alt_hover", id: null } as const]),
          ],
        };
    }
  }

  return {
    id: "select",
    init: (toolOptions: NoToolOptions): State => ({
      tool: "select",
      options: toolOptions,
      phase: { gesture: IDLE, cycle: null, hoverLock: null, hover: NO_HOVER },
    }),
    cursor(state) {
      const g = state.phase.gesture;
      if (g.kind === "marquee") return "crosshair";
      if (g.kind === "drag") return g.plan.spawn ? "copy" : "grabbing";
      return "default";
    },
    reduce(state, event: InteractionEvent, input): Result {
      switch (event.type) {
        case "pointer_down":
          return pointerDown(state, event, input);
        case "pointer_move":
          return pointerMove(state, event, input);
        case "pointer_up":
          return pointerUp(state, event, input);
        case "pointer_cancel": {
          const g = state.phase.gesture;
          if (g.kind === "idle" || g.pointerId !== event.pointerId) return { state, effects: [] };
          return endGesture(state);
        }
        case "double_click": {
          const hit = hitsAt(input.scene, event.board, input.camera)[0];
          const stamp = captureStamp(input);
          if (hit === undefined || stamp === null) return { state, effects: [] };
          return { state, effects: [{ type: "open_editor", stamp, object: hit }] };
        }
        case "key_down": {
          if (state.phase.gesture.kind !== "idle") return { state, effects: [] };
          return { state, effects: selectKeyEffects(event, input) ?? [] };
        }
        case "key_up": {
          // Releasing Alt ends a drag's Alt-hover (M6-D12).
          const g = state.phase.gesture;
          if (g.kind !== "drag" || g.altHover === null || event.modifiers.alt) {
            return { state, effects: [] };
          }
          return {
            state: withPhase(state, { gesture: { ...g, altHover: null } }),
            effects: [{ type: "alt_hover", id: null }],
          };
        }
        default:
          return { state, effects: [] };
      }
    },
    cancel(state, reason: CancelReason): Result {
      // Escape with nothing in progress is the user's "deselect" (tool contract).
      if (reason === "escape" && state.phase.gesture.kind === "idle") {
        return { state, effects: [{ type: "select", ids: [] }] };
      }
      return endGesture(state);
    },
  };
}

/** The select tool without a drop override. */
export const selectTool: Tool<SelectPhase, "select"> = createSelectTool();
