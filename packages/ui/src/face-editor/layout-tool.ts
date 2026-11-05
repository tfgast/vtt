/**
 * The layout tool (vtt-1xv.27; DESIGN.md §4.6 The inspector: "A layout mode
 * lets the GM drag cells onto the face", Face layouts; §7 Undo; PROTOCOL.md
 * §5 `set_face`, §6; M5 plan Q1 A1, Q8). A pure vtt-3l6.22 `Tool`
 * registered under id `layout` (by vtt-1xv.23).
 *
 * - With exactly one selected board object in the GM view, it outlines the
 *   elements of the object's full face list (dashed `drag_ghost` polygons in
 *   the object's frame, placed by the face scene's item transform) and draws
 *   the four corner handles of the selected element (`handles`).
 * - A press on a handle of the selected element resizes it (the dragged
 *   corner snapped to `LAYOUT_SNAP`, the opposite corner kept, each side at
 *   least `LAYOUT_MIN_SIZE`); a press on an element (the topmost, the later
 *   in the list, where they overlap) selects it and drags it (its top-left
 *   snapped to `LAYOUT_SNAP`, its size kept); a press elsewhere clears the
 *   element selection.
 * - Delete (or Backspace) removes the selected element.
 * - Each gesture is one `set_face` write of the whole new layout
 *   (vtt-1xv.18's ops) with the stamp captured at the pointer down (or the
 *   key press). A release where nothing changed writes nothing.
 * - Escape ends any gesture and returns to `select`; a tool switch, a board
 *   or viewer change and `pointer_cancel` end an unfinished gesture with no
 *   write.
 *
 * Pointer deltas are taken in the object's frame (the inverse of its item
 * transform), so a rotated object's elements follow the pointer. After a
 * write the outlines show the written layout until the client has seen the
 * write's revision (or the write did not commit). Only the full list of a
 * board object is edited here (handles on contained entries: vtt-qf5.30).
 */
import type { ObjectView } from "@vtt/protocol";
import type { FaceLayout, ObjectId, Point, Rect } from "@vtt/schema";
import type { FaceScene } from "../face/face-scene";
import { type Affine, apply, invert, itemTransform } from "../face/face-transform";
import type { InteractionStamp } from "../interaction/contracts";
import { MAX_LABEL_LENGTH } from "../interaction/create-tools";
import type { Effect } from "../interaction/effects";
import type { InteractionEvent } from "../interaction/events";
import { HANDLE_HIT_PX } from "../interaction/handles";
import { PRIMARY_BUTTON } from "../interaction/machine";
import type { HandleMark, ToolOverlay } from "../interaction/overlays";
import {
  type CancelReason,
  captureStamp,
  type ReducerInput,
  type Tool,
  type ToolInput,
  type ToolResult,
  type ToolState,
} from "../interaction/tool";
import { toScreen } from "../scene/camera";
import {
  type FaceOpResult,
  layoutOfView,
  moveElement,
  removeElement,
  resizeElement,
  setFaceOps,
} from "./face-ops";

/** Element positions and corners snap to multiples of this many board units. */
export const LAYOUT_SNAP = 0.05;
/** The smallest element width or height a resize produces (board units). */
export const LAYOUT_MIN_SIZE = 0.1;

export type LayoutCorner = "nw" | "ne" | "se" | "sw";

const CORNERS: readonly LayoutCorner[] = ["nw", "ne", "se", "sw"];

/** Rounds away binary noise (1e-9 board units). */
function tidy(n: number): number {
  return Math.round(n * 1e9) / 1e9 + 0;
}

/** `v` rounded to the nearest multiple of `LAYOUT_SNAP`. */
export function snapToGrid(v: number): number {
  return tidy(Math.round(v / LAYOUT_SNAP) * LAYOUT_SNAP);
}

/** `start` moved by the local `delta`, its new top-left snapped; the size is kept. */
export function movedRect(start: Rect, delta: Point): Rect {
  return [snapToGrid(start[0] + delta[0]), snapToGrid(start[1] + delta[1]), start[2], start[3]];
}

/**
 * `start` with its `corner` moved by the local `delta` and snapped; the
 * opposite corner stays, and each side is at least `LAYOUT_MIN_SIZE`.
 */
export function resizedRect(start: Rect, corner: LayoutCorner, delta: Point): Rect {
  let left = start[0];
  let top = start[1];
  let right = start[0] + start[2];
  let bottom = start[1] + start[3];
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  if (west) left = Math.min(snapToGrid(left + delta[0]), right - LAYOUT_MIN_SIZE);
  else right = Math.max(snapToGrid(right + delta[0]), left + LAYOUT_MIN_SIZE);
  if (north) top = Math.min(snapToGrid(top + delta[1]), bottom - LAYOUT_MIN_SIZE);
  else bottom = Math.max(snapToGrid(bottom + delta[1]), top + LAYOUT_MIN_SIZE);
  return [tidy(left), tidy(top), tidy(right - left), tidy(bottom - top)];
}

/** `full` shortened with an ellipsis (whole code points) to fit `MAX_LABEL_LENGTH`. */
export function layoutLabel(full: string): string {
  if (full.length <= MAX_LABEL_LENGTH) return full;
  let label = "";
  for (const ch of full) {
    if (label.length + ch.length + 1 > MAX_LABEL_LENGTH) break;
    label += ch;
  }
  return `${label}…`;
}

/** The object's name for labels: its `name` text, else its id. */
export function objectLabel(view: ObjectView | null, id: ObjectId): string {
  const name = view?.cells.name?.value;
  return name?.type === "text" && name.value.trim() !== "" ? name.value : id;
}

/** The object the layout tool edits, as it is in one snapshot. */
export interface LayoutTarget {
  object: ObjectId;
  name: string;
  /** The stored layout (an empty one when the object has none). */
  face: FaceLayout;
  anchor: Point;
  /** Degrees clockwise. */
  rotation: number;
  /** The object's frame → the board. */
  toBoard: Affine;
}

/**
 * The single selected object on the active board, in the GM view, with its
 * stored layout (vtt-1xv.18's `layoutOfView`) and frame transform (the face
 * scene's, else `itemTransform`); null otherwise.
 */
export function layoutTargetOf(input: ReducerInput): LayoutTarget | null {
  if (input.viewer.type !== "gm" || input.activeBoard === null) return null;
  if (input.selection.length !== 1) return null;
  const id = input.selection[0] as ObjectId;
  const item = input.scene.items.find((i) => i.id === id);
  const view = input.views(id);
  if (item === undefined || view === null) return null;
  const transforms = (input.scene as Partial<FaceScene>).transforms;
  return {
    object: id,
    name: objectLabel(view, id),
    face: layoutOfView(view) ?? { elements: [] },
    anchor: [item.anchor[0], item.anchor[1]],
    rotation: item.rotation,
    toBoard: transforms?.get(id) ?? itemTransform(item),
  };
}

/** The selected element: an index into the object's full list. */
export interface LayoutSelection {
  object: ObjectId;
  index: number;
}

/** A move or resize in progress, as decided at pointer down. */
export interface LayoutGesture {
  kind: "move" | "resize";
  /** The resize handle's corner. */
  corner?: LayoutCorner;
  pointerId: number;
  stamp: InteractionStamp;
  target: LayoutTarget;
  index: number;
  /** The element's rect at pointer down. */
  start: Rect;
  /** The pressed point in the object's frame. */
  grab: Point;
  /** The rect the gesture would write now. */
  rect: Rect;
}

/** A written layout not yet seen by the client. */
export interface PendingLayout {
  stamp: InteractionStamp;
  object: ObjectId;
  face: FaceLayout;
  /** The committed revision, once settled. */
  revision: number | null;
}

export interface LayoutPhase {
  selected: LayoutSelection | null;
  gesture: LayoutGesture | null;
  pending: PendingLayout | null;
  /** The key of the overlays last emitted (null: none shown). */
  shown: string | null;
}

type S = ToolState<LayoutPhase, "layout">;
type R = ToolResult<LayoutPhase, "layout">;

const INITIAL: LayoutPhase = { selected: null, gesture: null, pending: null, shown: null };

/** `target` with the pending layout shown in place of its stored one while it is unseen. */
function withPending(target: LayoutTarget, phase: LayoutPhase, revision: number): LayoutTarget {
  const p = phase.pending;
  if (p === null || p.object !== target.object) return target;
  if (p.revision !== null && revision >= p.revision) return target;
  return { ...target, face: p.face };
}

/** The pending layout, dropped once the client has seen its revision. */
function prunePending(phase: LayoutPhase, revision: number): PendingLayout | null {
  const p = phase.pending;
  if (p === null || p.revision === null || revision < p.revision) return p;
  return null;
}

function corners([x, y, w, h]: Rect): Record<LayoutCorner, Point> {
  return { nw: [x, y], ne: [x + w, y], se: [x + w, y + h], sw: [x, y + h] };
}

/** The overlays for `target` with `face`, `rect` in place of element `index`'s while dragging. */
function overlaysFor(
  target: LayoutTarget,
  selected: number | null,
  gesture: LayoutGesture | null,
): ToolOverlay[] {
  const rects = target.face.elements.map((e, i) =>
    gesture !== null && gesture.index === i ? gesture.rect : e.rect,
  );
  if (rects.length === 0) return [];
  const out: ToolOverlay[] = [
    {
      kind: "drag_ghost",
      items: rects.map((r) => {
        const c = corners(r);
        return {
          id: target.object,
          anchor: target.anchor,
          rotation: target.rotation,
          shape: { type: "polygon", points: [c.nw, c.ne, c.se, c.sw] },
        };
      }),
    },
  ];
  const r = selected === null ? undefined : rects[selected];
  if (r !== undefined) {
    const c = corners(r);
    const handles: HandleMark[] = CORNERS.map((key) => ({
      key,
      role: "resize",
      at: apply(target.toBoard, c[key]),
    }));
    out.push({ kind: "handles", object: target.object, handles });
  }
  return out;
}

/** The selected element's index on `target`, or null. */
function selectedOn(phase: LayoutPhase, target: LayoutTarget | null): number | null {
  const s = phase.selected;
  if (s === null || target === null || s.object !== target.object) return null;
  return s.index < target.face.elements.length ? s.index : null;
}

/** The phase's overlays for `input`, with an `overlays` effect when they changed. */
function show(phase: LayoutPhase, input: ReducerInput): { phase: LayoutPhase; effects: Effect[] } {
  const pending = prunePending(phase, input.revision);
  const base = { ...phase, pending };
  const raw = phase.gesture?.target ?? layoutTargetOf(input);
  const target = raw === null ? null : withPending(raw, base, input.revision);
  const overlays =
    target === null ? [] : overlaysFor(target, selectedOn(base, target), phase.gesture);
  const key = overlays.length === 0 ? null : JSON.stringify(overlays);
  if (key === phase.shown) return { phase: base, effects: [] };
  return { phase: { ...base, shown: key }, effects: [{ type: "overlays", overlays }] };
}

/** The corner handle of element `index` within `HANDLE_HIT_PX` of `screen`, or null. */
function hitCorner(
  target: LayoutTarget,
  rect: Rect,
  screen: Point,
  input: ReducerInput,
): LayoutCorner | null {
  const c = corners(rect);
  let best: LayoutCorner | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of CORNERS) {
    const at = toScreen(input.camera, apply(target.toBoard, c[key]), input.viewport);
    const d = Math.hypot(at[0] - screen[0], at[1] - screen[1]);
    if (d <= HANDLE_HIT_PX && d < bestDistance) {
      best = key;
      bestDistance = d;
    }
  }
  return best;
}

/** The topmost element of `target` containing the local point, or -1. */
function elementAt(target: LayoutTarget, local: Point): number {
  const elements = target.face.elements;
  for (let i = elements.length - 1; i >= 0; i--) {
    const [x, y, w, h] = (elements[i] as { rect: Rect }).rect;
    if (local[0] >= x && local[0] <= x + w && local[1] >= y && local[1] <= y + h) return i;
  }
  return -1;
}

/** One `set_face` write of `result`'s layout, or a notice for its problem. */
function writeOf(
  result: FaceOpResult,
  stamp: InteractionStamp,
  object: ObjectId,
  label: string,
): { effects: Effect[]; face: FaceLayout | null } {
  if (!result.ok) {
    return {
      effects: [
        {
          type: "notice",
          level: "warning",
          text: `The face was not changed: ${result.message}`,
        },
      ],
      face: null,
    };
  }
  return {
    effects: [
      {
        type: "write",
        stamp,
        ops: setFaceOps(object, result.face),
        label: layoutLabel(label),
        continuations: [],
      },
    ],
    face: result.face,
  };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.every((v, i) => v === b[i]);
}

/** `layout`: moves, resizes and removes the elements of the selected object's face. */
export function createLayoutTool(): Tool<LayoutPhase, "layout"> {
  const result = (state: S, phase: LayoutPhase, effects: Effect[], input: ReducerInput): R => {
    const shown = show(phase, input);
    return { state: { ...state, phase: shown.phase }, effects: [...effects, ...shown.effects] };
  };

  const pointerDown = (
    state: S,
    event: Extract<InteractionEvent, { type: "pointer_down" }>,
    input: ToolInput,
  ): R => {
    const phase = state.phase;
    const raw = layoutTargetOf(input);
    const stamp = captureStamp(input);
    if (raw === null || stamp === null) return result(state, phase, [], input);
    const target = withPending(
      raw,
      { ...phase, pending: prunePending(phase, input.revision) },
      input.revision,
    );
    const local = apply(invert(target.toBoard), event.board);
    const selected = selectedOn(phase, target);
    const begin = (kind: LayoutGesture["kind"], index: number, corner?: LayoutCorner): R => {
      const start = (target.face.elements[index] as { rect: Rect }).rect;
      const gesture: LayoutGesture = {
        kind,
        ...(corner === undefined ? {} : { corner }),
        pointerId: event.pointerId,
        stamp,
        target,
        index,
        start,
        grab: local,
        rect: start,
      };
      return result(
        state,
        { ...phase, selected: { object: target.object, index }, gesture },
        [],
        input,
      );
    };
    if (selected !== null) {
      const rect = (target.face.elements[selected] as { rect: Rect }).rect;
      const corner = hitCorner(target, rect, event.screen, input);
      if (corner !== null) return begin("resize", selected, corner);
    }
    const index = elementAt(target, local);
    if (index >= 0) return begin("move", index);
    return result(state, { ...phase, selected: null }, [], input);
  };

  const drag = (gesture: LayoutGesture, board: Point): LayoutGesture => {
    const local = apply(invert(gesture.target.toBoard), board);
    const delta: Point = [local[0] - gesture.grab[0], local[1] - gesture.grab[1]];
    const rect =
      gesture.kind === "move"
        ? movedRect(gesture.start, delta)
        : resizedRect(gesture.start, gesture.corner ?? "se", delta);
    return { ...gesture, rect };
  };

  const release = (state: S, gesture: LayoutGesture, input: ReducerInput): R => {
    const phase = { ...state.phase, gesture: null };
    if (sameRect(gesture.rect, gesture.start)) return result(state, phase, [], input);
    const { target, index, stamp } = gesture;
    const ref = { list: "full" as const, index };
    const op =
      gesture.kind === "move"
        ? moveElement(target.face, ref, [gesture.rect[0], gesture.rect[1]])
        : resizeElement(target.face, ref, gesture.rect);
    const verb = gesture.kind === "move" ? "Move" : "Resize";
    const out = writeOf(op, stamp, target.object, `${verb} a face element of ${target.name}`);
    const pending: PendingLayout | null =
      out.face === null
        ? phase.pending
        : { stamp, object: target.object, face: out.face, revision: null };
    return result(state, { ...phase, pending }, out.effects, input);
  };

  const remove = (state: S, input: ToolInput): R => {
    const phase = state.phase;
    const raw = layoutTargetOf(input);
    const stamp = captureStamp(input);
    if (raw === null || stamp === null || phase.gesture !== null) {
      return result(state, phase, [], input);
    }
    const target = withPending(
      raw,
      { ...phase, pending: prunePending(phase, input.revision) },
      input.revision,
    );
    const index = selectedOn(phase, target);
    if (index === null) return result(state, phase, [], input);
    const out = writeOf(
      removeElement(target.face, { list: "full", index }),
      stamp,
      target.object,
      `Remove a face element of ${target.name}`,
    );
    const pending: PendingLayout | null =
      out.face === null
        ? phase.pending
        : { stamp, object: target.object, face: out.face, revision: null };
    return result(state, { ...phase, selected: null, pending }, out.effects, input);
  };

  const settled = (
    state: S,
    event: Extract<InteractionEvent, { type: "settled" }>,
    input: ReducerInput,
  ): R => {
    const p = state.phase.pending;
    if (
      p === null ||
      p.stamp.interactionId !== event.interactionId ||
      event.outcome.type !== "write"
    ) {
      return result(state, state.phase, [], input);
    }
    const outcome = event.outcome.result;
    const pending = outcome.status === "committed" ? { ...p, revision: outcome.revision } : null;
    return result(state, { ...state.phase, pending }, [], input);
  };

  const end = (state: S, reason: CancelReason): R => {
    const phase: LayoutPhase = {
      ...state.phase,
      gesture: null,
      shown: null,
      ...(reason === "board_change" || reason === "viewer_change" ? { selected: null } : {}),
    };
    const effects: Effect[] =
      state.phase.shown === null ? [] : [{ type: "overlays", overlays: [] }];
    if (reason === "escape") effects.push({ type: "set_tool", tool: "select" });
    return { state: { ...state, phase }, effects };
  };

  return {
    id: "layout",
    init: (options) => ({ tool: "layout", options, phase: INITIAL }),
    cursor: (state) => (state.phase.gesture === null ? "default" : "move"),
    reduce(state, event, input) {
      const gesture = state.phase.gesture;
      switch (event.type) {
        case "pointer_down":
          if (event.button !== PRIMARY_BUTTON || gesture !== null) {
            return { state, effects: [] };
          }
          return pointerDown(state, event, input);
        case "pointer_move":
          if (gesture === null) return result(state, state.phase, [], input);
          if (event.pointerId !== gesture.pointerId) return { state, effects: [] };
          return result(state, { ...state.phase, gesture: drag(gesture, event.board) }, [], input);
        case "pointer_up":
          if (gesture === null || event.pointerId !== gesture.pointerId) {
            return { state, effects: [] };
          }
          return release(state, drag(gesture, event.board), input);
        case "pointer_cancel":
          if (gesture === null || event.pointerId !== gesture.pointerId) {
            return { state, effects: [] };
          }
          return result(state, { ...state.phase, gesture: null }, [], input);
        case "key_down":
          if (event.key === "Delete" || event.key === "Backspace") return remove(state, input);
          return { state, effects: [] };
        case "settled":
          return settled(state, event, input);
        default:
          return { state, effects: [] };
      }
    },
    cancel: end,
  };
}

/** The layout tool (vtt-1xv.23 registers it). */
export const layoutTool: Tool<LayoutPhase, "layout"> = createLayoutTool();
