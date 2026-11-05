/**
 * The ink tool (DESIGN.md §4.1 ink is a cell value, §4.6 Ink and text, §8.1,
 * §8.4 step 6; PROTOCOL.md §5 `set_value`, `create_object` with `id_base`;
 * M5 plan Q19, M5-D20): freehand strokes, one fixed pen. A pure vtt-3l6.22
 * `Tool` registered under id `ink`.
 *
 * - Pointer down (primary) captures the stamp and the target: the topmost
 *   non-zone object under the point (`hitsAt`; none under a cover), with its
 *   anchor, rotation and `ink` cell as they are in that snapshot.
 * - Points are collected in board units, dropping a point closer than
 *   `INK_MIN_STEP` to the previous kept one, at most `INK_MAX_POINTS` per
 *   stroke, and previewed as a `polygon_draft` overlay.
 * - Pointer up with at least two points: on a target, the stroke in its
 *   object-local frame (origin at the anchor, unrotated) is appended to its
 *   `ink` cell with one `set_value` of the whole new ink value; an `ink`
 *   cell holding a non-ink, non-empty value is a notice and no write. With
 *   no target, one `create_object` of an `ink_<n>` object: a transparent
 *   rect around the stroke (at least `INK_MIN_SIZE` per side) anchored at
 *   its bounding-box centre. The tool stays active.
 * - Escape, a tool switch, a board or viewer change and `pointer_cancel`
 *   end an unfinished stroke with no write.
 */
import type { InputValue, ObjectInit, ObjectView, WireOp, WireResult } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import { hitsAt } from "../scene/hit-test";
import type { InteractionStamp } from "./contracts";
import { MAX_LABEL_LENGTH } from "./create-tools";
import type { Effect } from "./effects";
import type { InteractionEvent } from "./events";
import { PRIMARY_BUTTON } from "./machine";
import {
  captureStamp,
  type ReducerInput,
  type Tool,
  type ToolInput,
  type ToolResult,
  type ToolState,
} from "./tool";

/** A point closer than this (board units) to the previous kept point is dropped. */
export const INK_MIN_STEP = 0.05;
/** The most points one stroke keeps; later points are dropped. */
export const INK_MAX_POINTS = 2000;
/** The smallest side of a created ink object's rect, in board units. */
export const INK_MIN_SIZE = 0.25;

/**
 * What the target's `ink` cell held at pointer down: its strokes (none when
 * absent or empty), or null when it holds something that is not ink.
 */
export type InkBase = Point[][] | null;

/** The object a stroke is drawn onto, as it was at pointer down. */
export interface InkTarget {
  id: ObjectId;
  anchor: Point;
  /** Degrees clockwise. */
  rotation: number;
  name: string;
  ink: InkBase;
}

/** A stroke in progress. */
export interface InkStroke {
  stamp: InteractionStamp;
  pointerId: number;
  target: InkTarget | null;
  /** Board points, thinned and capped. */
  points: Point[];
}

export interface InkPhase {
  stroke: InkStroke | null;
}

/**
 * `points` with `point` appended, unless it is closer than `INK_MIN_STEP`
 * to the last point or the stroke already holds `INK_MAX_POINTS`; the same
 * array when nothing is added.
 */
export function thinStroke(points: readonly Point[], point: Point): Point[] {
  const last = points.at(-1);
  if (points.length >= INK_MAX_POINTS) return points as Point[];
  if (last !== undefined && Math.hypot(point[0] - last[0], point[1] - last[1]) < INK_MIN_STEP) {
    return points as Point[];
  }
  return [...points, [point[0], point[1]]];
}

/**
 * Board point `point` in the frame of an object anchored at `anchor` and
 * rotated `rotation` degrees clockwise: relative to the anchor, rotation
 * undone (the inverse of the schema's `toWorld`).
 */
export function toObjectLocal(point: Point, anchor: Point, rotation: number): Point {
  const dx = point[0] - anchor[0];
  const dy = point[1] - anchor[1];
  const turned = ((rotation % 360) + 360) % 360;
  // Quarter turns are exact, as in the schema's geometry.
  const [cos, sin] =
    turned === 0
      ? [1, 0]
      : turned === 90
        ? [0, 1]
        : turned === 180
          ? [-1, 0]
          : turned === 270
            ? [0, -1]
            : [Math.cos((turned * Math.PI) / 180), Math.sin((turned * Math.PI) / 180)];
  return [dx * cos + dy * sin + 0, -dx * sin + dy * cos + 0];
}

/** The topmost non-zone object under board point `point` (none in a cover), or null. */
export function inkTarget(
  input: Pick<ReducerInput, "scene" | "camera">,
  point: Point,
): ObjectId | null {
  const zones = new Set(input.scene.items.filter((i) => i.isZone).map((i) => i.id));
  return hitsAt(input.scene, point, input.camera).find((id) => !zones.has(id)) ?? null;
}

/** The strokes an `ink` cell value holds, [] for absent or empty, null for anything else. */
function inkBase(value: WireResult | undefined): InkBase {
  if (value === undefined || value.type === "empty") return [];
  if (value.type === "ink") return value.strokes.map((s) => s.map((p) => [p[0], p[1]] as Point));
  return null;
}

function nameOf(view: ObjectView | null, id: ObjectId): string {
  const name = view?.cells.name?.value;
  return name?.type === "text" && name.value.trim() !== "" ? name.value : id;
}

function captureTarget(input: ToolInput, point: Point): InkTarget | null {
  const id = inkTarget(input, point);
  if (id === null) return null;
  const item = input.scene.items.find((i) => i.id === id);
  if (item === undefined) return null;
  const view = input.views(id);
  return {
    id,
    anchor: item.anchor,
    rotation: item.rotation,
    name: nameOf(view, id),
    ink: inkBase(view?.cells.ink?.value),
  };
}

/**
 * The label of a stroke on an object: "Draw ink on <name>", shortened with
 * an ellipsis (whole code points, never half a surrogate pair) to fit
 * MAX_LABEL_LENGTH (PROTOCOL.md §4), as vtt-3l6.8's `importLabel` does.
 */
export function inkLabel(name: string): string {
  const prefix = "Draw ink on ";
  const full = `${prefix}${name}`;
  if (full.length <= MAX_LABEL_LENGTH) return full;
  let label = prefix;
  for (const ch of name) {
    if (label.length + ch.length + 1 > MAX_LABEL_LENGTH) break;
    label += ch;
  }
  return `${label}…`;
}

const text = (value: string) => ({ type: "text" as const, value });

/** The effects ending a stroke of at least two points. */
function finish(stroke: InkStroke): Effect[] {
  const { stamp, target, points } = stroke;
  if (target !== null) {
    if (target.ink === null) {
      return [
        {
          type: "notice",
          level: "warning",
          text: `The ink was not drawn: the ink cell of ${target.name} holds something other than ink.`,
        },
      ];
    }
    const local = points.map((p) => toObjectLocal(p, target.anchor, target.rotation));
    const value: InputValue = { type: "ink", strokes: [...target.ink, local] };
    const op: WireOp = { type: "set_value", object: target.id, cell: "ink", value };
    return [{ type: "write", stamp, ops: [op], label: inkLabel(target.name), continuations: [] }];
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const centre: Point = [(minX + maxX) / 2, (minY + maxY) / 2];
  const init: ObjectInit = {
    shape: {
      type: "rect",
      width: Math.max(maxX - minX, INK_MIN_SIZE),
      height: Math.max(maxY - minY, INK_MIN_SIZE),
    },
    cells: {
      ink: { type: "ink", strokes: [points.map((p) => toObjectLocal(p, centre, 0))] },
      color: text("transparent"),
      name: text("Ink"),
    },
  };
  const op: WireOp = {
    type: "create_object",
    id_base: "ink",
    to: { type: "board", board: stamp.board, position: centre },
    init,
  };
  return [{ type: "write", stamp, ops: [op], label: "Draw ink", continuations: [] }];
}

const preview = (points: Point[]): Effect => ({
  type: "overlays",
  overlays: [{ kind: "polygon_draft", points, cursor: null, closing: false }],
});
const CLEAR: Effect = { type: "overlays", overlays: [] };

/** `ink`: draws a freehand stroke onto the object under the pointer, or as a new ink object. */
export function createInkTool(): Tool<InkPhase, "ink"> {
  type S = ToolState<InkPhase, "ink">;
  type R = ToolResult<InkPhase, "ink">;
  const withStroke = (state: S, stroke: InkStroke | null): S => ({ ...state, phase: { stroke } });
  const idle = (state: S): R => ({
    state: withStroke(state, null),
    effects: state.phase.stroke === null ? [] : [CLEAR],
  });
  return {
    id: "ink",
    init: (options) => ({ tool: "ink", options, phase: { stroke: null } }),
    cursor: () => "crosshair",
    reduce(state, event: InteractionEvent, input) {
      const stroke = state.phase.stroke;
      if (event.type === "pointer_down" && event.button === PRIMARY_BUTTON && stroke === null) {
        const stamp = captureStamp(input);
        if (stamp === null) return { state, effects: [] };
        const next: InkStroke = {
          stamp,
          pointerId: event.pointerId,
          target: captureTarget(input, event.board),
          points: [[event.board[0], event.board[1]]],
        };
        return { state: withStroke(state, next), effects: [preview(next.points)] };
      }
      if (stroke === null || !("pointerId" in event) || event.pointerId !== stroke.pointerId) {
        return { state, effects: [] };
      }
      switch (event.type) {
        case "pointer_move": {
          const points = thinStroke(stroke.points, event.board);
          if (points === stroke.points) return { state, effects: [] };
          return { state: withStroke(state, { ...stroke, points }), effects: [preview(points)] };
        }
        case "pointer_up": {
          const points = thinStroke(stroke.points, event.board);
          const effects = points.length >= 2 ? finish({ ...stroke, points }) : [];
          return { state: withStroke(state, null), effects: [CLEAR, ...effects] };
        }
        case "pointer_cancel":
          return idle(state);
        default:
          return { state, effects: [] };
      }
    },
    cancel: (state) => idle(state),
  };
}
