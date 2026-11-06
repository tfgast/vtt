/**
 * The ink tool (DESIGN.md §4.1 ink is a cell value, §4.6 Ink and text, §8.1,
 * §8.4 step 6; PROTOCOL.md §5 `set_value`, `create_object` with `id_base`;
 * M5 plan Q19, M5-D20, M6-D28): freehand strokes drawn with the pen of its
 * options (`InkToolOptions`), or erased. A pure vtt-3l6.22 `Tool`
 * registered under id `ink`.
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
 *   its bounding-box centre. The tool stays active. The stroke carries the
 *   options' colour and width where they differ from the default pen
 *   (`penStroke`). Stored points are rounded to 0.001 board units
 *   (`roundInkPoint`) after thinning; the preview keeps full precision.
 * - With `eraser` set, pointer down captures the stamp, the eraser's reach
 *   (`ERASER_RADIUS_PX` at the current zoom) and every drawn, face-up board
 *   object whose `ink` cell holds ink, as in that snapshot; the drag's board
 *   path is tested as it arrives: every raw segment (from the previous raw
 *   point; the pointer-down point alone as a tap) is checked against each
 *   object's captured strokes in its frame (`crossedStrokes`) and the hit
 *   strokes accumulate, unthinned and uncapped (thinning is for the preview
 *   only). Pointer up drops the hit strokes from each object and writes one `set_value` of each changed `ink` cell (`empty`
 *   when no stroke is left) in one write against the stamp's base revision,
 *   so one undo restores them all. A path crossing nothing writes nothing.
 * - Escape, a tool switch, a board or viewer change and `pointer_cancel`
 *   end an unfinished stroke with no write.
 */
import type { InputValue, ObjectInit, ObjectView, WireOp, WireResult } from "@vtt/protocol";
import type { ObjectId, Point, Stroke } from "@vtt/schema";
import { cameraScale } from "../scene/camera";
import { hitsAt } from "../scene/hit-test";
import type { InteractionStamp } from "./contracts";
import { MAX_LABEL_LENGTH } from "./create-tools";
import type { Effect } from "./effects";
import type { InteractionEvent } from "./events";
import { crossedStrokes, ERASER_RADIUS_PX, penStroke, roundInkPoint } from "./ink-pen";
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
export type InkBase = Stroke[] | null;

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

/** An object whose ink an eraser drag may cut, as it was at pointer down. */
export interface EraseTarget {
  id: ObjectId;
  anchor: Point;
  /** Degrees clockwise. */
  rotation: number;
  name: string;
  strokes: Stroke[];
}

/** An eraser drag in progress. */
export interface InkErase {
  stamp: InteractionStamp;
  pointerId: number;
  /** The eraser's reach in board units, `ERASER_RADIUS_PX` at pointer down's zoom. */
  radius: number;
  targets: EraseTarget[];
  /** The last raw board point seen; each new point sweeps the segment from it. */
  last: Point;
  /** Per target (same order), the indices of the strokes swept so far, ascending. */
  hits: number[][];
  /** Board points for the preview only, thinned and capped like a stroke's. */
  points: Point[];
}

export interface InkPhase {
  stroke: InkStroke | null;
  /** An eraser drag; absent or null when none. */
  erase?: InkErase | null;
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
  if (value.type === "ink") return value.strokes.map(copyStroke);
  return null;
}

const copyPoints = (points: readonly Point[]): Point[] => points.map((p) => [p[0], p[1]]);

/** A copy of `s`, keeping only the known pen fields. */
function copyStroke(s: Stroke): Stroke {
  if (Array.isArray(s)) return copyPoints(s);
  return {
    points: copyPoints(s.points),
    ...(s.color === undefined ? {} : { color: s.color }),
    ...(s.width === undefined ? {} : { width: s.width }),
  };
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
  return prefixedLabel("Draw ink on ", name);
}

/** `prefix` then `name`, `name` shortened with an ellipsis to fit MAX_LABEL_LENGTH. */
function prefixedLabel(prefix: string, name: string): string {
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

/** The effects ending a stroke of at least two points, drawn with `pen`. */
function finish(stroke: InkStroke, pen: { color: string; width: number }): Effect[] {
  const { stamp, target, points } = stroke;
  // Stored points are rounded after thinning and the frame change (vtt-qf5.44).
  const drawn = (pts: Point[]): Stroke => penStroke(pts.map(roundInkPoint), pen.color, pen.width);
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
    const value: InputValue = { type: "ink", strokes: [...target.ink, drawn(local)] };
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
      ink: { type: "ink", strokes: [drawn(points.map((p) => toObjectLocal(p, centre, 0)))] },
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

/**
 * The objects an eraser may cut: each drawn, face-up board object whose
 * `ink` cell holds ink, front to back.
 */
function captureEraseTargets(input: ToolInput): EraseTarget[] {
  const out: EraseTarget[] = [];
  for (const item of [...input.scene.items].reverse()) {
    if (item.faceDown) continue;
    const view = input.views(item.id);
    const ink = view?.cells.ink?.value;
    if (ink?.type !== "ink") continue;
    out.push({
      id: item.id,
      anchor: item.anchor,
      rotation: item.rotation,
      name: nameOf(view, item.id),
      strokes: ink.strokes.map(copyStroke),
    });
  }
  return out;
}

/**
 * The label of an erase: "Erase ink on <name>" for one object (shortened as
 * `inkLabel` does), "Erase ink" for several.
 */
export function eraseLabel(names: readonly string[]): string {
  const [only] = names;
  if (names.length !== 1 || only === undefined) return "Erase ink";
  return prefixedLabel("Erase ink on ", only);
}

/**
 * `erase` with the strokes the board segment `from`–`to` sweeps added to
 * its hits (a tap when the two are equal), and `to` as its last point.
 */
export function sweepErase(erase: InkErase, from: Point, to: Point): InkErase {
  const hits = erase.targets.map((target, t) => {
    const before = erase.hits[t] ?? [];
    const path = [from, to].map((p) => toObjectLocal(p, target.anchor, target.rotation));
    const found = crossedStrokes(path, target.strokes, erase.radius).filter(
      (i) => !before.includes(i),
    );
    return found.length === 0 ? before : [...before, ...found].sort((a, b) => a - b);
  });
  return { ...erase, hits, last: [to[0], to[1]] };
}

/**
 * The effects ending an eraser drag: one write of a `set_value` per object
 * with swept strokes (`erase.hits`), or nothing when none was swept.
 */
export function finishErase(erase: InkErase): Effect[] {
  const ops: WireOp[] = [];
  const names: string[] = [];
  for (const [t, target] of erase.targets.entries()) {
    const hit = new Set(erase.hits[t] ?? []);
    if (hit.size === 0) continue;
    const kept = target.strokes.filter((_, i) => !hit.has(i));
    const value: InputValue =
      kept.length === 0 ? { type: "empty" } : { type: "ink", strokes: kept };
    ops.push({ type: "set_value", object: target.id, cell: "ink", value });
    names.push(target.name);
  }
  if (ops.length === 0) return [];
  return [{ type: "write", stamp: erase.stamp, ops, label: eraseLabel(names), continuations: [] }];
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
  const withStroke = (state: S, stroke: InkStroke | null): S => ({
    ...state,
    phase: { stroke, erase: null },
  });
  const withErase = (state: S, erase: InkErase | null): S => ({
    ...state,
    phase: { stroke: null, erase },
  });
  const idle = (state: S): R => ({
    state: withStroke(state, null),
    effects: state.phase.stroke === null && (state.phase.erase ?? null) === null ? [] : [CLEAR],
  });
  const reduceErase = (state: S, event: InteractionEvent, erase: InkErase): R => {
    if (!("pointerId" in event) || event.pointerId !== erase.pointerId) {
      return { state, effects: [] };
    }
    switch (event.type) {
      case "pointer_move": {
        const swept = sweepErase(erase, erase.last, event.board);
        const points = thinStroke(erase.points, event.board);
        if (points === erase.points) return { state: withErase(state, swept), effects: [] };
        return { state: withErase(state, { ...swept, points }), effects: [preview(points)] };
      }
      case "pointer_up": {
        const effects = finishErase(sweepErase(erase, erase.last, event.board));
        return { state: withErase(state, null), effects: [CLEAR, ...effects] };
      }
      case "pointer_cancel":
        return idle(state);
      default:
        return { state, effects: [] };
    }
  };
  return {
    id: "ink",
    init: (options) => ({ tool: "ink", options, phase: { stroke: null, erase: null } }),
    cursor: () => "crosshair",
    reduce(state, event: InteractionEvent, input) {
      const stroke = state.phase.stroke;
      const erase = state.phase.erase ?? null;
      if (erase !== null) return reduceErase(state, event, erase);
      if (event.type === "pointer_down" && event.button === PRIMARY_BUTTON && stroke === null) {
        const stamp = captureStamp(input);
        if (stamp === null) return { state, effects: [] };
        if (state.options.eraser) {
          const at: Point = [event.board[0], event.board[1]];
          const targets = captureEraseTargets(input);
          const next: InkErase = sweepErase(
            {
              stamp,
              pointerId: event.pointerId,
              radius: ERASER_RADIUS_PX / cameraScale(input.camera),
              targets,
              last: at,
              hits: targets.map(() => []),
              points: [at],
            },
            at,
            at,
          );
          return { state: withErase(state, next), effects: [preview(next.points)] };
        }
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
          const effects = points.length >= 2 ? finish({ ...stroke, points }, state.options) : [];
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
