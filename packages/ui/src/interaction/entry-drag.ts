/**
 * Entry drags (vtt-1xv.25; DESIGN.md §4.6 Gestures: clicking a row or an
 * expanded child's empty area selects it, drops; §4.7 drag out of a binder,
 * copy to a binder; §7 Undo: a write carries the revision its interaction
 * began on; M4-D8; M5 plan Q1, Q11, Q14, review r3 findings 2, 4).
 *
 * `entryDragGesture()` is a vtt-1xv.14 `FaceGesture` for vtt-1xv.16's
 * `withFaces` (`gestures`). It claims a primary pointer down on a contents
 * row (an `entry` hit) and on the body of a contained object drawn in an
 * expanded row (a `body` hit with a non-empty `path`); the dragged object is
 * that entry or child, and its container the row's.
 *
 * A press anywhere else in a row that is not a control of its own (its
 * drawn object's value elements, editor elements the viewer may not type
 * into, the empty space of its nested lists, its chevron or gear) stays `withFaces`'s until it moves beyond
 * `FACE_CLICK_PX`; `withFaces` then offers it to `start` with that
 * `pointer_move` (vtt-nb8.30), and the gesture claims it as that row's
 * object, already dragging, the intent captured at that move. So a click
 * or double-click there behaves as before, and a drag from the drawn face
 * drags the entry out. A nested list's entries stay the nested objects'.
 *
 * - Released within `ENTRY_DRAG_THRESHOLD_PX` of the pointer down: a click,
 *   selecting the object (`select [id]`, no write).
 * - Beyond it: a drag showing a `drag_ghost` at the pointer. The intent is
 *   captured at pointer down: a template without Alt is copied, anything
 *   else moved; modifiers later change nothing. The drop is one write with
 *   the stamp captured at pointer down, resolved by `dropTargetAt` alone
 *   (drop-targets.ts): an editor element → a reference; the own container's
 *   contents → nothing; another contents element → give a template, spawn
 *   or move there; the board → a spawn (selected) or a move to the pointer
 *   on `stamp.board`, the dropped anchor snapped to the nearest half-unit
 *   point with `input.snap` at the release (`snapPoint`, M6-D13; Alt
 *   changes nothing). Drops onto lists and editor elements are not snapped.
 * - Alt-hover (DESIGN.md §4.6 Only when selected, M6-D12), as the select
 *   tool keeps it: each drag move recomputes `altHoverAt` (an Alt key
 *   release clears it), emitted as `alt_hover` when it changes; the drop
 *   recomputes it at the release and resolves with that object's
 *   `when_selected` lists shown; the drop and any cancel clear it.
 * - Wheel events while active are claimed and ignored; `pointer_cancel`,
 *   Escape, a board or viewer change and a tool switch end it with no write
 *   (`withFaces` calls `cancel`). Late results follow the runtime's policy
 *   (vtt-3l6.23): continuations run only on the stamp's board and viewer.
 */
import type { ObjectView, WireResult } from "@vtt/protocol";
import type { ObjectId, Point, Shape } from "@vtt/schema";
import type { FaceGesture, FaceHit } from "../face/face-contracts";
import { dropTargetAt } from "../face/face-hit";
import { altHoverAt, type FaceSceneState } from "../face/face-scene";
import type { InteractionStamp } from "./contracts";
import { faceSceneFor, objectName, resolveFaceDrop } from "./drop-targets";
import { type Effect, snapPoint } from "./effects";
import type { InteractionEvent, PointerInteractionEvent } from "./events";
import type { ToolOverlay } from "./overlays";
import type { DropIntent } from "./select-tool";
import type { ToolInput } from "./tool";

/** The gesture's id. */
export const ENTRY_DRAG_GESTURE = "entry-drag";
/** A press becomes a drag beyond this many screen pixels (vtt-1xv.16's `FACE_CLICK_PX`). */
export const ENTRY_DRAG_THRESHOLD_PX = 4;

export interface EntryDragOptions {
  /**
   * The session's face state, so drops resolve on the expansion and scroll
   * drawn (vtt-1xv.14's `FaceStateStore`). Without it, `faceSceneFor`'s
   * fallback.
   */
  faceState?: FaceSceneState;
}

export interface EntryDragState {
  pointerId: number;
  /** The pointer down's screen point. */
  screen: Point;
  /** The pointer's latest board point. */
  board: Point;
  dragged: ObjectId;
  /** The container whose row was pressed. */
  from: ObjectId;
  intent: DropIntent;
  stamp: InteractionStamp;
  /** Beyond the threshold. */
  dragging: boolean;
  shape: Shape | null;
  rotation: number;
  /** The object an Alt-held drag hovers (M6-D12), or null. */
  altHover: ObjectId | null;
}

/** The drag's Alt-hover after a pointer event at `point` with Alt `alt`. */
function nextAltHover(state: EntryDragState, point: Point, alt: boolean, input: ToolInput) {
  return altHoverAt({
    scene: input.scene,
    views: input.views,
    previous: state.altHover,
    point,
    camera: input.camera,
    alt,
    dragged: [state.dragged],
  });
}

const CLEAR_ALT_HOVER: Effect = { type: "alt_hover", id: null };

/** The effect clearing `state`'s Alt-hover, when it has one. */
function clearAltHover(state: EntryDragState): Effect[] {
  return state.altHover === null ? [] : [CLEAR_ALT_HOVER];
}

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function shapeOf(view: ObjectView | null): Shape | null {
  const v = view?.cells.shape?.value;
  return v?.type === "shape" ? v.shape : null;
}

function rotationOf(view: ObjectView | null): number {
  const v: WireResult | undefined = view?.cells.rotation?.value;
  return v?.type === "number" && Number.isFinite(v.value) ? v.value : 0;
}

/**
 * The dragged object and its container for a hit the gesture claims, else
 * null. At pointer down: an `entry` hit, or a `body` hit with a path. On a
 * press handed off after it moved (`moved`, vtt-nb8.30): also the row's own
 * `value`, `editor`, `chevron` and `gear` hits with a path, and the empty
 * space of its own nested list (a `contents` hit with a path), each the
 * row's object (`hit.object`) in the path's last container.
 */
function claimed(hit: FaceHit, moved: boolean): { dragged: ObjectId; from: ObjectId } | null {
  const t = hit.target;
  if (t.type === "entry") return { dragged: t.id, from: t.container };
  const last = hit.path[hit.path.length - 1];
  if (last === undefined) return null;
  const row = { dragged: hit.object, from: last.container };
  switch (t.type) {
    case "body":
      return row;
    case "value":
    case "editor":
    case "chevron":
    case "gear":
    case "contents":
      return moved ? row : null;
    default:
      return null;
  }
}

/** The drop's effects: one write with the pointer-down stamp, or none. */
function drop(
  state: EntryDragState,
  point: Point,
  input: ToolInput,
  altHover: ObjectId | null,
  faceState?: FaceSceneState,
): Effect[] {
  const faces = faceSceneFor(input, faceState, { altHover });
  const target = dropTargetAt(faces, point, input.camera, [state.dragged]);
  const request = { dragged: state.dragged, intent: state.intent, from: state.from };
  const out = resolveFaceDrop(input, faces, target, request);
  const { stamp } = state;
  if (out.kind === "nothing") return [];
  if (out.kind === "write") return [{ type: "write" as const, stamp, ...out.write }];
  const name = objectName(input.views(state.dragged), state.dragged);
  const position = snapPoint(point, input.snap === true);
  const to = { type: "board" as const, board: stamp.board, position };
  const effect: Effect = state.intent.copy
    ? {
        type: "write",
        stamp,
        ops: [{ type: "spawn", template: state.dragged, to }],
        label: `Copy ${name}`,
        continuations: [{ type: "select_created", opIndex: 0 }],
      }
    : {
        type: "write",
        stamp,
        ops: [{ type: "move", object: state.dragged, to }],
        label: `Move ${name}`,
        continuations: [],
      };
  return [effect];
}

/** The entry drag gesture (see the module comment). */
export function entryDragGesture(options: EntryDragOptions = {}): FaceGesture<unknown> {
  const { faceState } = options;
  type Step = { state: EntryDragState | null; effects: Effect[] };

  function pointerEvent(state: EntryDragState, event: PointerInteractionEvent, input: ToolInput) {
    const keep: Step = { state, effects: [] };
    if (event.pointerId !== state.pointerId) return keep;
    const beyond = distance(state.screen, event.screen) > ENTRY_DRAG_THRESHOLD_PX;
    switch (event.type) {
      case "pointer_move": {
        if (!state.dragging && !beyond) return keep;
        const altHover = nextAltHover(state, event.board, event.modifiers.alt, input);
        const effects: Effect[] =
          altHover === state.altHover ? [] : [{ type: "alt_hover", id: altHover }];
        return { state: { ...state, dragging: true, board: event.board, altHover }, effects };
      }
      case "pointer_up": {
        if (!state.dragging && !beyond) {
          return { state: null, effects: [{ type: "select", ids: [state.dragged] }] } as Step;
        }
        const altHover = nextAltHover(state, event.board, event.modifiers.alt, input);
        const effects = drop(state, event.board, input, altHover, faceState);
        return { state: null, effects: [...effects, ...clearAltHover(state)] } as Step;
      }
      case "pointer_cancel":
        return { state: null, effects: clearAltHover(state) } as Step;
      default:
        return keep;
    }
  }

  const gesture: FaceGesture<EntryDragState> = {
    id: ENTRY_DRAG_GESTURE,
    start(hit, event, input, stamp) {
      // A pointer down, or a press `withFaces` hands off once it moved (vtt-nb8.30).
      if (event.type !== "pointer_down" && event.type !== "pointer_move") return null;
      const moved = event.type === "pointer_move";
      const claim = claimed(hit, moved);
      if (claim === null) return null;
      const view = input.views(claim.dragged);
      if (view === null) return null;
      const alt = event.modifiers.alt;
      return {
        pointerId: event.pointerId,
        screen: event.screen,
        board: event.board,
        dragged: claim.dragged,
        from: claim.from,
        intent: { copy: view.is_template && !alt, alt },
        stamp,
        dragging: moved,
        shape: shapeOf(view),
        rotation: rotationOf(view),
        altHover: null,
      };
    },
    reduce(state, event: InteractionEvent, input) {
      switch (event.type) {
        case "pointer_down":
        case "pointer_move":
        case "pointer_up":
        case "pointer_cancel":
          return pointerEvent(state, event, input);
        case "key_up":
          // Releasing Alt ends the Alt-hover (M6-D12).
          if (state.altHover === null || event.modifiers.alt) return { state, effects: [] };
          return { state: { ...state, altHover: null }, effects: [CLEAR_ALT_HOVER] };
        default:
          // Wheels, keys, clicks and settled results change nothing while dragging.
          return { state, effects: [] };
      }
    },
    cancel: (state) => clearAltHover(state),
    overlays(state): ToolOverlay[] {
      if (!state.dragging) return [];
      const items = [
        { id: state.dragged, anchor: state.board, rotation: state.rotation, shape: state.shape },
      ];
      return [{ kind: "drag_ghost", items }];
    },
  };
  return gesture as FaceGesture<unknown>;
}
