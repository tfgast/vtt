/**
 * The creation tools (DESIGN.md §4.3 zones, §4.4 opaque zones, §4.6
 * Appearance cells, §7 assets, §8.1, §8.4 step 3; FORMULAS.md §3.1;
 * FIXTURES.md §3; PROTOCOL.md §4, §5 `create_object`; M4 plan Q15, Q21,
 * Q22, review r2 findings 4, 8, 11, r3 finding 1): `token`, `card`, `note`,
 * `zone-rect`, `zone-circle`, `zone-polygon` and `image`, each a pure
 * vtt-3l6.22 `Tool`.
 *
 * Every creation is one `create_object` write (op 0) on the board stamped at
 * the event that starts it (the press, the first polygon click, the image
 * click or drop), anchored at the shape's bounding-box center, with an
 * `id_base` by kind (`token`, `card`, `note`, `zone`, `image`). Its
 * continuations select the created object and, unless Shift was held at the
 * starting event, switch to the select tool; the decision is taken then and
 * recorded in the list (review r2 finding 4). The runtime runs them only when
 * the interaction was not cancelled and its board is still active.
 *
 * A cancel (Escape, a tool, board or viewer switch) ends unfinished gestures
 * only: a press, a drag, a polygon draft, a file picker not yet answered. A
 * started upload always finishes on its stamped board (review r3 finding 1).
 * No `z` is written: the authority puts a created object on top.
 */
import type { ObjectInit, WireOp } from "@vtt/protocol";
import type { Point, Shape } from "@vtt/schema";
import { cameraScale } from "../scene/camera";
import { HIT_SLOP_PX } from "../scene/hit-test";
import { normalizePolygon, polygonProblem } from "../scene/polygon";
import type { InteractionStamp } from "./contracts";
import type { Continuation, Effect } from "./effects";
import type { InteractionEvent } from "./events";
import { PRIMARY_BUTTON } from "./machine";
import type { ToolOverlay } from "./overlays";
import type { ToolRegistry } from "./registry";
import {
  captureStamp,
  type Tool,
  type ToolId,
  type ToolInput,
  type ToolResult,
  type ToolState,
  type ZoneToolOptions,
} from "./tool";

/** What the image tool's file picker accepts (the authority's image types; no SVG). */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
/** Imported images are 100 px per board unit (M4 plan Q21). */
export const IMAGE_PX_PER_UNIT = 100;
/** The smallest dragged zone, per dimension or radius, in board units. */
export const MIN_ZONE_SIZE = 0.25;
/** A press that moves less than this many screen pixels is a click. */
export const CLICK_SLOP_PX = 4;
/** A polygon click this close (screen pixels) to the first vertex closes the draft. */
export const POLYGON_CLOSE_PX = HIT_SLOP_PX;

/** The creation tools' ids, in toolbar order. */
export const CREATION_TOOL_IDS = [
  "token",
  "card",
  "note",
  "zone-rect",
  "zone-circle",
  "zone-polygon",
  "image",
] as const satisfies readonly ToolId[];
export type CreationToolId = (typeof CREATION_TOOL_IDS)[number];

const CURSOR = "crosshair";

/** The `id_base` of a created object, by kind (vtt-3l6.19). */
type IdBase = "token" | "card" | "note" | "zone" | "image";

// ---------------------------------------------------------------------------
// Shared

/** An interaction started by a creation tool: its stamp and whether Shift was held then. */
export interface CreationStart {
  stamp: InteractionStamp;
  shift: boolean;
}

/**
 * A creation's continuations: select the object created by op 0, then
 * switch to the select tool unless Shift was held at the starting event.
 */
export function creationContinuations(shift: boolean): Continuation[] {
  const select: Continuation = { type: "select_created", opIndex: 0 };
  return shift ? [select] : [select, { type: "set_tool", tool: "select" }];
}

/** A file name without its last extension; "Image" when nothing is left. */
export function fileStem(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.trim() === "" ? "Image" : stem;
}

/** The longest transaction label the protocol accepts (PROTOCOL.md §4, `transact`). */
export const MAX_LABEL_LENGTH = 200;

/**
 * The label of an image import: "Import <name>", shortened with an ellipsis
 * (whole code points, never half a surrogate pair) to fit MAX_LABEL_LENGTH.
 * The object's `name` keeps the full stem.
 */
export function importLabel(name: string): string {
  const full = `Import ${name}`;
  if (full.length <= MAX_LABEL_LENGTH) return full;
  let label = "Import ";
  for (const ch of name) {
    if (label.length + ch.length + 1 > MAX_LABEL_LENGTH) break;
    label += ch;
  }
  return `${label}…`;
}

const text = (value: string) => ({ type: "text" as const, value });

/** The fog cells of a zone: opaque and visible to the GM only (DESIGN.md §4.4, §8.4 step 3). */
const FOG_CELLS: NonNullable<ObjectInit["cells"]> = {
  opaque: { type: "boolean", value: true },
  visible_to: { type: "viewers", viewers: ["gm"] },
};

/** The one write of a creation. */
function createWrite(
  start: CreationStart,
  idBase: IdBase,
  anchor: Point,
  init: ObjectInit,
  label: string,
): Effect {
  const op: WireOp = {
    type: "create_object",
    id_base: idBase,
    to: { type: "board", board: start.stamp.board, position: anchor },
    init,
  };
  return {
    type: "write",
    stamp: start.stamp,
    ops: [op],
    label,
    continuations: creationContinuations(start.shift),
  };
}

function zoneInit(shape: Shape, fog: boolean): ObjectInit {
  return {
    is_zone: true,
    shape,
    cells: { name: text("Zone"), ...(fog ? FOG_CELLS : {}) },
  };
}

const overlays = (list: ToolOverlay[]): Effect => ({ type: "overlays", overlays: list });
const CLEAR: Effect = overlays([]);

function isPrimaryDown(
  event: InteractionEvent,
): event is Extract<InteractionEvent, { type: "pointer_down" }> {
  return event.type === "pointer_down" && event.button === PRIMARY_BUTTON;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** The distance between two board points in screen pixels under the input's camera. */
function boardPx(input: ToolInput, a: Point, b: Point): number {
  return distance(a, b) * cameraScale(input.camera);
}

// ---------------------------------------------------------------------------
// token, card, note

/** A press in progress: created at its point on release. */
export interface PressPhase {
  press: (CreationStart & { pointerId: number; at: Point }) | null;
}

interface PlaceSpec<K extends "token" | "card" | "note"> {
  id: K;
  idBase: IdBase;
  shape: Shape;
  cells: NonNullable<ObjectInit["cells"]>;
  label: string;
}

function placeTool<K extends "token" | "card" | "note">(spec: PlaceSpec<K>): Tool<PressPhase, K> {
  const idle = (state: ToolState<PressPhase, K>): ToolResult<PressPhase, K> => ({
    state: { ...state, phase: { press: null } },
    effects: state.phase.press === null ? [] : [CLEAR],
  });
  return {
    id: spec.id,
    init: (options) =>
      ({ tool: spec.id, options, phase: { press: null } }) as ToolState<PressPhase, K>,
    cursor: () => CURSOR,
    reduce(state, event, input) {
      const press = state.phase.press;
      if (isPrimaryDown(event) && press === null) {
        const stamp = captureStamp(input);
        if (stamp === null) return { state, effects: [] };
        const at = event.board;
        return {
          state: {
            ...state,
            phase: {
              press: { stamp, shift: event.modifiers.shift, pointerId: event.pointerId, at },
            },
          },
          effects: [
            overlays([{ kind: "creation_preview", anchor: at, shape: spec.shape, zone: false }]),
          ],
        };
      }
      if (press === null || !("pointerId" in event) || event.pointerId !== press.pointerId) {
        return { state, effects: [] };
      }
      if (event.type === "pointer_cancel") return idle(state);
      if (event.type !== "pointer_up") return { state, effects: [] };
      return {
        state: { ...state, phase: { press: null } },
        effects: [
          CLEAR,
          createWrite(
            press,
            spec.idBase,
            press.at,
            { shape: spec.shape, cells: spec.cells },
            spec.label,
          ),
        ],
      };
    },
    cancel: (state) => idle(state),
  };
}

/** `token`: a click makes a circle r 0.5 named "Token" (M4 plan Q21). */
export function createTokenTool(): Tool<PressPhase, "token"> {
  return placeTool({
    id: "token",
    idBase: "token",
    shape: { type: "circle", radius: 0.5 },
    cells: { name: text("Token") },
    label: "Create token",
  });
}

/** `card`: a click makes a rect 2.5 × 3.5 named "Card". */
export function createCardTool(): Tool<PressPhase, "card"> {
  return placeTool({
    id: "card",
    idBase: "card",
    shape: { type: "rect", width: 2.5, height: 3.5 },
    cells: { name: text("Card") },
    label: "Create card",
  });
}

/** `note`: a click makes a rect 2 × 2 named "Note", `color` "#fff3a0" and empty `text` (DESIGN.md §4.7 `tpl_note`). */
export function createNoteTool(): Tool<PressPhase, "note"> {
  return placeTool({
    id: "note",
    idBase: "note",
    shape: { type: "rect", width: 2, height: 2 },
    cells: { name: text("Note"), color: text("#fff3a0"), text: text("") },
    label: "Create note",
  });
}

// ---------------------------------------------------------------------------
// zone-rect, zone-circle

/** A zone drag: from `origin` to `current`; `dragged` once it left the click slop. */
export interface ZoneDragPhase {
  drag:
    | (CreationStart & { pointerId: number; origin: Point; current: Point; dragged: boolean })
    | null;
}

type ZoneDrag = NonNullable<ZoneDragPhase["drag"]>;

/** One side of a dragged rect: from `from` toward `to`, at least the minimum long. */
function span(from: number, to: number): [number, number] {
  const length = Math.max(Math.abs(to - from), MIN_ZONE_SIZE);
  const end = to < from ? from - length : from + length;
  return [Math.min(from, end), Math.max(from, end)];
}

function rectGeometry(drag: ZoneDrag): { anchor: Point; shape: Shape } {
  if (!drag.dragged) return { anchor: drag.origin, shape: { type: "rect", width: 2, height: 2 } };
  const [minX, maxX] = span(drag.origin[0], drag.current[0]);
  const [minY, maxY] = span(drag.origin[1], drag.current[1]);
  return {
    anchor: [(minX + maxX) / 2, (minY + maxY) / 2],
    shape: { type: "rect", width: maxX - minX, height: maxY - minY },
  };
}

function circleGeometry(drag: ZoneDrag): { anchor: Point; shape: Shape } {
  if (!drag.dragged) return { anchor: drag.origin, shape: { type: "circle", radius: 1 } };
  const radius = Math.max(distance(drag.origin, drag.current), MIN_ZONE_SIZE);
  return { anchor: drag.origin, shape: { type: "circle", radius } };
}

function zoneDragTool<K extends "zone-rect" | "zone-circle">(
  id: K,
  geometry: (drag: ZoneDrag) => { anchor: Point; shape: Shape },
): Tool<ZoneDragPhase, K> {
  const preview = (drag: ZoneDrag): Effect => {
    const { anchor, shape } = geometry(drag);
    return overlays([{ kind: "creation_preview", anchor, shape, zone: true }]);
  };
  const idle = (state: ToolState<ZoneDragPhase, K>): ToolResult<ZoneDragPhase, K> => ({
    state: { ...state, phase: { drag: null } },
    effects: state.phase.drag === null ? [] : [CLEAR],
  });
  /** The drag moved to `point`. */
  const moved = (drag: ZoneDrag, point: Point, input: ToolInput): ZoneDrag => ({
    ...drag,
    current: point,
    dragged: drag.dragged || boardPx(input, drag.origin, point) >= CLICK_SLOP_PX,
  });
  return {
    id,
    init: (options) =>
      ({ tool: id, options, phase: { drag: null } }) as ToolState<ZoneDragPhase, K>,
    cursor: () => CURSOR,
    reduce(state, event, input) {
      const drag = state.phase.drag;
      if (isPrimaryDown(event) && drag === null) {
        const stamp = captureStamp(input);
        if (stamp === null) return { state, effects: [] };
        const next: ZoneDrag = {
          stamp,
          shift: event.modifiers.shift,
          pointerId: event.pointerId,
          origin: event.board,
          current: event.board,
          dragged: false,
        };
        return { state: { ...state, phase: { drag: next } }, effects: [preview(next)] };
      }
      if (drag === null || !("pointerId" in event) || event.pointerId !== drag.pointerId) {
        return { state, effects: [] };
      }
      switch (event.type) {
        case "pointer_move": {
          const next = moved(drag, event.board, input);
          return { state: { ...state, phase: { drag: next } }, effects: [preview(next)] };
        }
        case "pointer_up": {
          const final = moved(drag, event.board, input);
          const { anchor, shape } = geometry(final);
          const options = state.options as ZoneToolOptions;
          return {
            state: { ...state, phase: { drag: null } },
            effects: [
              CLEAR,
              createWrite(final, "zone", anchor, zoneInit(shape, options.fog), "Create zone"),
            ],
          };
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

/** `zone-rect`: a drag from one corner to the other; a click makes a 2 × 2 zone centered on it. */
export function createZoneRectTool(): Tool<ZoneDragPhase, "zone-rect"> {
  return zoneDragTool("zone-rect", rectGeometry);
}

/** `zone-circle`: a drag from the center sets the radius; a click makes an r 1 zone. */
export function createZoneCircleTool(): Tool<ZoneDragPhase, "zone-circle"> {
  return zoneDragTool("zone-circle", circleGeometry);
}

// ---------------------------------------------------------------------------
// zone-polygon

/** A polygon draft: world vertices so far and the cursor's board point. */
export interface PolygonPhase {
  draft: (CreationStart & { points: Point[]; cursor: Point | null }) | null;
}

type PolygonDraft = NonNullable<PolygonPhase["draft"]>;

/** Whether `point` would close `draft` on its first vertex. */
function closesOn(draft: PolygonDraft, point: Point, input: ToolInput): boolean {
  const first = draft.points[0];
  return (
    draft.points.length >= 3 &&
    first !== undefined &&
    boardPx(input, first, point) <= POLYGON_CLOSE_PX
  );
}

/** `zone-polygon`: click vertices; a click on the first vertex, a double-click or Enter closes. */
export function createZonePolygonTool(): Tool<PolygonPhase, "zone-polygon"> {
  type S = ToolState<PolygonPhase, "zone-polygon">;
  const draftOverlay = (draft: PolygonDraft, input: ToolInput): Effect =>
    overlays([
      {
        kind: "polygon_draft",
        points: draft.points,
        cursor: draft.cursor,
        closing: draft.cursor !== null && closesOn(draft, draft.cursor, input),
      },
    ]);
  const idle = (state: S): ToolResult<PolygonPhase, "zone-polygon"> => ({
    state: { ...state, phase: { draft: null } },
    effects: state.phase.draft === null ? [] : [CLEAR],
  });
  /** Ends the draft: a write, or a notice when the polygon has a problem. */
  const close = (state: S, draft: PolygonDraft): ToolResult<PolygonPhase, "zone-polygon"> => {
    const ended = { ...state, phase: { draft: null } };
    const { anchor, points } = normalizePolygon(draft.points);
    const problem = polygonProblem(points);
    if (problem !== undefined) {
      return {
        state: ended,
        effects: [
          CLEAR,
          { type: "notice", level: "warning", text: `The zone was not created: ${problem}.` },
        ],
      };
    }
    return {
      state: ended,
      effects: [
        CLEAR,
        createWrite(
          draft,
          "zone",
          anchor,
          zoneInit({ type: "polygon", points }, state.options.fog),
          "Create zone",
        ),
      ],
    };
  };
  return {
    id: "zone-polygon",
    init: (options) => ({ tool: "zone-polygon", options, phase: { draft: null } }),
    cursor: () => CURSOR,
    reduce(state, event, input) {
      const draft = state.phase.draft;
      switch (event.type) {
        case "pointer_down": {
          if (event.button !== PRIMARY_BUTTON) return { state, effects: [] };
          const point = event.board;
          if (draft === null) {
            const stamp = captureStamp(input);
            if (stamp === null) return { state, effects: [] };
            const next: PolygonDraft = {
              stamp,
              shift: event.modifiers.shift,
              points: [point],
              cursor: point,
            };
            return {
              state: { ...state, phase: { draft: next } },
              effects: [draftOverlay(next, input)],
            };
          }
          if (closesOn(draft, point, input)) return close(state, draft);
          const first = draft.points[0] as Point;
          const last = draft.points.at(-1) as Point;
          // A click on the last vertex (a double-click's second click) or on
          // the first one before there are three adds nothing.
          if (
            boardPx(input, last, point) <= CLICK_SLOP_PX ||
            boardPx(input, first, point) <= POLYGON_CLOSE_PX
          ) {
            return { state, effects: [] };
          }
          const next = { ...draft, points: [...draft.points, point], cursor: point };
          return {
            state: { ...state, phase: { draft: next } },
            effects: [draftOverlay(next, input)],
          };
        }
        case "pointer_move": {
          if (draft === null) return { state, effects: [] };
          const next = { ...draft, cursor: event.board };
          return {
            state: { ...state, phase: { draft: next } },
            effects: [draftOverlay(next, input)],
          };
        }
        case "double_click":
          return draft === null ? { state, effects: [] } : close(state, draft);
        case "key_down":
          return draft !== null && event.key === "Enter"
            ? close(state, draft)
            : { state, effects: [] };
        default:
          return { state, effects: [] };
      }
    },
    cancel: (state) => idle(state),
  };
}

// ---------------------------------------------------------------------------
// image

/** An image interaction past its starting event, by interaction id. */
export interface PendingImage extends CreationStart {
  /** Where the image goes: the click or drop point. */
  at: Point;
  /** `picking`: the picker is open; `uploading`: the upload has started. */
  step: "picking" | "uploading";
  /** The object's name: the file's stem (once known). */
  name: string;
  /** A picker cancelled before it answered: its file is discarded. */
  cancelled: boolean;
}

export interface ImagePhase {
  press: (CreationStart & { pointerId: number; at: Point }) | null;
  pending: Readonly<Record<string, PendingImage>>;
}

const ACCEPTED = new Set(IMAGE_ACCEPT.split(","));

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/**
 * `image`: a click opens the file picker; a picked or dropped image is
 * uploaded, then created as a rect `width / 100 × height / 100` units at
 * the click or drop point, named by the file's stem (M4 plan Q21; DESIGN.md
 * §7 assets). A drop carries no modifiers, so it never keeps the tool.
 */
export function createImageTool(): Tool<ImagePhase, "image"> {
  type S = ToolState<ImagePhase, "image">;
  type R = ToolResult<ImagePhase, "image">;
  const withPhase = (state: S, phase: Partial<ImagePhase>): S => ({
    ...state,
    phase: { ...state.phase, ...phase },
  });

  const onSettled = (state: S, event: Extract<InteractionEvent, { type: "settled" }>): R => {
    const id = event.interactionId;
    const entry = state.phase.pending[id];
    if (entry === undefined) return { state, effects: [] };
    const rest = without(state.phase.pending, id);
    const outcome = event.outcome;
    switch (outcome.type) {
      case "file_picked": {
        if (entry.step !== "picking") return { state, effects: [] };
        if (outcome.file === null || entry.cancelled) {
          return { state: withPhase(state, { pending: rest }), effects: [] };
        }
        const next: PendingImage = {
          ...entry,
          step: "uploading",
          name: fileStem(outcome.file.name),
        };
        return {
          state: withPhase(state, { pending: { ...rest, [id]: next } }),
          effects: [{ type: "upload", stamp: entry.stamp, file: outcome.file }],
        };
      }
      case "uploaded": {
        const { width, height } = outcome;
        const ended = withPhase(state, { pending: rest });
        if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
          return {
            state: ended,
            effects: [
              { type: "notice", level: "error", text: `The image "${entry.name}" has no size.` },
            ],
          };
        }
        const shape: Shape = {
          type: "rect",
          width: width / IMAGE_PX_PER_UNIT,
          height: height / IMAGE_PX_PER_UNIT,
        };
        const init: ObjectInit = {
          shape,
          cells: { name: text(entry.name), image: text(outcome.path) },
        };
        return {
          state: ended,
          effects: [createWrite(entry, "image", entry.at, init, importLabel(entry.name))],
        };
      }
      case "upload_failed":
        return {
          state: withPhase(state, { pending: rest }),
          effects: [
            {
              type: "notice",
              level: "error",
              text: `The image "${entry.name}" was not imported: ${outcome.message}`,
            },
          ],
        };
      default:
        return { state, effects: [] };
    }
  };

  return {
    id: "image",
    init: (options) => ({ tool: "image", options, phase: { press: null, pending: {} } }),
    cursor: () => CURSOR,
    reduce(state, event, input) {
      const press = state.phase.press;
      switch (event.type) {
        case "pointer_down": {
          if (event.button !== PRIMARY_BUTTON || press !== null) return { state, effects: [] };
          const stamp = captureStamp(input);
          if (stamp === null) return { state, effects: [] };
          return {
            state: withPhase(state, {
              press: {
                stamp,
                shift: event.modifiers.shift,
                pointerId: event.pointerId,
                at: event.board,
              },
            }),
            effects: [],
          };
        }
        case "pointer_up": {
          if (press === null || event.pointerId !== press.pointerId) return { state, effects: [] };
          const entry: PendingImage = {
            stamp: press.stamp,
            shift: press.shift,
            at: press.at,
            step: "picking",
            name: "Image",
            cancelled: false,
          };
          return {
            state: withPhase(state, {
              press: null,
              pending: { ...state.phase.pending, [press.stamp.interactionId]: entry },
            }),
            effects: [{ type: "pick_file", stamp: press.stamp, accept: IMAGE_ACCEPT }],
          };
        }
        case "pointer_cancel":
          return press !== null && event.pointerId === press.pointerId
            ? { state: withPhase(state, { press: null }), effects: [] }
            : { state, effects: [] };
        case "file_drop": {
          const file = event.files.find((f) => ACCEPTED.has(f.type));
          if (file === undefined) {
            return {
              state,
              effects: [
                { type: "notice", level: "warning", text: "Drop a PNG, JPEG, WebP or GIF image." },
              ],
            };
          }
          const stamp = captureStamp(input);
          if (stamp === null) return { state, effects: [] };
          const entry: PendingImage = {
            stamp,
            shift: false,
            at: event.board,
            step: "uploading",
            name: fileStem(file.name),
            cancelled: false,
          };
          return {
            state: withPhase(state, {
              pending: { ...state.phase.pending, [stamp.interactionId]: entry },
            }),
            effects: [{ type: "upload", stamp, file }],
          };
        }
        case "settled":
          return onSettled(state, event);
        default:
          return { state, effects: [] };
      }
    },
    cancel(state) {
      // Pickers not yet answered are unfinished gestures; started uploads are not.
      const pending: Record<string, PendingImage> = {};
      for (const [id, entry] of Object.entries(state.phase.pending)) {
        pending[id] = entry.step === "picking" ? { ...entry, cancelled: true } : entry;
      }
      return { state: withPhase(state, { press: null, pending }), effects: [] };
    },
  };
}

// ---------------------------------------------------------------------------

/** Registers the seven creation tools in `registry`, in `CREATION_TOOL_IDS` order. */
export function registerCreationTools(registry: ToolRegistry): void {
  registry.register(createTokenTool());
  registry.register(createCardTool());
  registry.register(createNoteTool());
  registry.register(createZoneRectTool());
  registry.register(createZoneCircleTool());
  registry.register(createZonePolygonTool());
  registry.register(createImageTool());
}
