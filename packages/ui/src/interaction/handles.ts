/**
 * Resize, vertex and rotate handles (vtt-3l6.9; DESIGN.md §4.1, §4.3, §8.1;
 * FORMULAS.md §3.1; docs/PROTOCOL.md §5 `set_shape`, `set_value`, §6
 * `base_revision`; M4 plan review r1 findings 1, 4, 6, r2 findings 8, 11).
 *
 * `withHandles(tool)` decorates a tool (vtt-3l6.17 composes
 * `withHandles(selectTool)`) without changing it. For exactly one selected
 * object with a shape, in the GM view, it shows a `handles` tool overlay:
 *
 * - rect: eight resize handles. A corner drag keeps the opposite corner's
 *   world position, an edge drag changes one dimension and keeps the
 *   opposite edge; both write `set_shape` and `set_value position` as one
 *   write. Sizes are clamped to `HANDLE_MIN_SIZE`.
 * - circle: one radius handle (`set_shape`; the anchor stays).
 * - polygon: one handle per vertex, moving that vertex and keeping the anchor
 *   (`set_shape`). A result `polygonProblem` (vtt-3l6.5) refuses gets a
 *   notice and no write.
 * - every shape: a rotate handle `ROTATE_HANDLE_PX` above the top edge →
 *   `set_value rotation` (degrees clockwise; Shift snaps to
 *   `ROTATE_SNAP_DEG`).
 *
 * Handles live in object-local coordinates (the object's rotation applies).
 * The stamp is captured at the pointer down on a handle; the drag emits
 * `previews`, and the release one write with that stamp and previews held by
 * it. Escape, a board, viewer or tool change and `pointer_cancel` end a
 * handle drag with no write. Every event that hits no handle while no handle
 * drag is in progress goes to the wrapped tool unchanged.
 *
 * Overlays: the wrapped tool's `overlays` effects are replaced by its
 * overlays plus the handles overlay, so neither erases the other. Handles
 * hide while the wrapped tool shows overlays of its own (a drag ghost, a
 * marquee). A tool only runs on events, so handles follow a selection or
 * geometry change from elsewhere (the inspector, another client) at the next
 * event, typically the next pointer move. After a handle write the handles
 * follow the written geometry until the client has seen the write's revision.
 */
import type { InputValue, ObjectView, WireOp } from "@vtt/protocol";
import type { ObjectId, Point, Shape } from "@vtt/schema";
import { type Camera, cameraScale, toScreen, type ViewportSize } from "../scene/camera";
import { polygonProblem } from "../scene/polygon";
import type { DrawItem, ScenePreview } from "../scene/scene";
import type { InteractionStamp, Previews } from "./contracts";
import type { Effect } from "./effects";
import type { InteractionEvent, PointerInteractionEvent } from "./events";
import { PRIMARY_BUTTON } from "./machine";
import type { HandleMark, ToolOverlay } from "./overlays";
import {
  type CancelReason,
  captureStamp,
  type Tool,
  type ToolId,
  type ToolInput,
  type ToolResult,
  type ToolState,
} from "./tool";

/** A press within this many screen pixels of a handle's center grabs it. */
export const HANDLE_HIT_PX = 6;
/** The rotate handle's distance above the top edge, in screen pixels. */
export const ROTATE_HANDLE_PX = 24;
/** Shift snaps a rotation to multiples of this many degrees. */
export const ROTATE_SNAP_DEG = 15;
/** The smallest rect width or height, or circle radius, a handle drag produces (board units). */
export const HANDLE_MIN_SIZE = 0.25;

/** What dragging a handle changes. `sx`, `sy`: the handle's side of the rect (-1, 0 or 1). */
export type HandleGrip =
  | { type: "resize"; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }
  | { type: "radius" }
  | { type: "vertex"; index: number }
  | { type: "rotate" };

/** A handle: its mark (board units), its screen point and what it does. */
export interface Handle extends HandleMark {
  object: ObjectId;
  screen: Point;
  grip: HandleGrip;
}

/** The geometry handles are computed from and act on. */
export type HandleTarget = Pick<DrawItem, "id" | "anchor" | "rotation" | "shape">;

// ---------------------------------------------------------------------------
// Geometry

interface Rotation {
  cos: number;
  sin: number;
}

/** Degrees clockwise on screen; quarter turns exact (as `@vtt/schema`'s geometry). */
function rotationOf(deg: number): Rotation {
  const turned = ((deg % 360) + 360) % 360;
  if (turned === 0) return { cos: 1, sin: 0 };
  if (turned === 90) return { cos: 0, sin: 1 };
  if (turned === 180) return { cos: -1, sin: 0 };
  if (turned === 270) return { cos: 0, sin: -1 };
  const rad = (turned * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

/** A local vector (unrotated) as a board vector. */
function turn(v: Point, r: Rotation): Point {
  return [v[0] * r.cos - v[1] * r.sin + 0, v[0] * r.sin + v[1] * r.cos + 0];
}

/** A board vector as a local one. */
function unturn(v: Point, r: Rotation): Point {
  return [v[0] * r.cos + v[1] * r.sin + 0, -v[0] * r.sin + v[1] * r.cos + 0];
}

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];

/** Rounds away binary noise (1e-9 board units or degrees). */
function tidy(n: number): number {
  return Math.round(n * 1e9) / 1e9 + 0;
}

const tidyPoint = (p: Point): Point => [tidy(p[0]), tidy(p[1])];

/** The angle of `p` about `center`, in degrees clockwise on screen from +x. */
function angleAbout(center: Point, p: Point): number {
  return (Math.atan2(p[1] - center[1], p[0] - center[0]) * 180) / Math.PI;
}

/** `deg` in [0, 360). */
function normalizeDeg(deg: number): number {
  const n = ((deg % 360) + 360) % 360;
  return n === 360 ? 0 : n;
}

const RESIZE_KEYS: { key: string; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }[] = [
  { key: "nw", sx: -1, sy: -1 },
  { key: "n", sx: 0, sy: -1 },
  { key: "ne", sx: 1, sy: -1 },
  { key: "e", sx: 1, sy: 0 },
  { key: "se", sx: 1, sy: 1 },
  { key: "s", sx: 0, sy: 1 },
  { key: "sw", sx: -1, sy: 1 },
  { key: "w", sx: -1, sy: 0 },
];

/**
 * The handles of `item` (none for a shapeless one): the shape's handles,
 * then the rotate handle, each with its board point (`at`, in the object's
 * rotated local frame), its screen point under `camera` and `viewport`, and
 * its grip. The rotate handle sits `ROTATE_HANDLE_PX` above the middle of
 * the top of the local bounding box, with a stem (`from`) to it.
 */
export function handlesFor(item: HandleTarget, camera: Camera, viewport: ViewportSize): Handle[] {
  const { shape, anchor } = item;
  if (shape === null) return [];
  const r = rotationOf(item.rotation);
  const place = (local: Point): Point => add(anchor, turn(local, r));
  const handle = (
    key: string,
    role: HandleMark["role"],
    local: Point,
    grip: HandleGrip,
    from?: Point,
  ): Handle => {
    const at = place(local);
    const h: Handle = {
      key,
      role,
      at,
      object: item.id,
      screen: toScreen(camera, at, viewport),
      grip,
    };
    if (from !== undefined) h.from = place(from);
    return h;
  };

  const handles: Handle[] = [];
  let top: number;
  let midX = 0;
  switch (shape.type) {
    case "rect": {
      const w = shape.width / 2;
      const h = shape.height / 2;
      for (const { key, sx, sy } of RESIZE_KEYS) {
        handles.push(handle(key, "resize", [sx * w, sy * h], { type: "resize", sx, sy }));
      }
      top = -h;
      break;
    }
    case "circle":
      handles.push(handle("radius", "radius", [shape.radius, 0], { type: "radius" }));
      top = -shape.radius;
      break;
    case "polygon": {
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      top = Number.POSITIVE_INFINITY;
      shape.points.forEach((p, index) => {
        handles.push(handle(`v${index}`, "vertex", p, { type: "vertex", index }));
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        top = Math.min(top, p[1]);
      });
      if (shape.points.length === 0) top = 0;
      else midX = (minX + maxX) / 2;
      break;
    }
  }
  const offset = ROTATE_HANDLE_PX / cameraScale(camera);
  handles.push(handle("rotate", "rotate", [midX, top - offset], { type: "rotate" }, [midX, top]));
  return handles;
}

/** The handle nearest `screenPoint` within `HANDLE_HIT_PX` (the first on a tie), or null. */
export function hitHandle(handles: readonly Handle[], screenPoint: Point): Handle | null {
  let best: Handle | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const h of handles) {
    const d = Math.hypot(h.screen[0] - screenPoint[0], h.screen[1] - screenPoint[1]);
    if (d <= HANDLE_HIT_PX && d < bestDistance) {
      best = h;
      bestDistance = d;
    }
  }
  return best;
}

/** The marks of `handles`, as the `handles` overlay carries them. */
export function handleMarks(handles: readonly Handle[]): HandleMark[] {
  return handles.map(({ key, role, at, from }) =>
    from === undefined ? { key, role, at } : { key, role, at, from },
  );
}

/**
 * The geometry after dragging `handle` of `target` from board point `grab`
 * to `point` (`snap`: Shift held, for the rotate handle). Only what changes
 * is set: `shape` and `position` for a rect, `shape` for a circle or a
 * polygon (not validated here), `rotation` for the rotate handle.
 */
export function dragHandle(
  target: HandleTarget,
  handle: Handle,
  grab: Point,
  point: Point,
  snap: boolean,
): ScenePreview {
  const { shape, anchor } = target;
  const r = rotationOf(target.rotation);
  const grip = handle.grip;
  if (grip.type === "rotate") {
    const turned = target.rotation + angleAbout(anchor, point) - angleAbout(anchor, grab);
    const deg = snap ? Math.round(turned / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG : turned;
    return { rotation: tidy(normalizeDeg(deg)) };
  }
  if (shape === null) return {};
  if (grip.type === "resize" && shape.type === "rect") {
    const { sx, sy } = grip;
    // The fixed point: the opposite corner, or the middle of the opposite edge.
    const fixed = add(anchor, turn([(-sx * shape.width) / 2, (-sy * shape.height) / 2], r));
    const d = unturn(sub(point, fixed), r);
    const width = sx === 0 ? shape.width : Math.max(HANDLE_MIN_SIZE, tidy(sx * d[0]));
    const height = sy === 0 ? shape.height : Math.max(HANDLE_MIN_SIZE, tidy(sy * d[1]));
    const position = add(fixed, turn([(sx * width) / 2, (sy * height) / 2], r));
    return { shape: { type: "rect", width, height }, position: tidyPoint(position) };
  }
  if (grip.type === "radius" && shape.type === "circle") {
    const radius = Math.max(
      HANDLE_MIN_SIZE,
      tidy(Math.hypot(point[0] - anchor[0], point[1] - anchor[1])),
    );
    return { shape: { type: "circle", radius } };
  }
  if (grip.type === "vertex" && shape.type === "polygon") {
    const local = tidyPoint(unturn(sub(point, anchor), r));
    const points = shape.points.map((p, i): Point => (i === grip.index ? local : [p[0], p[1]]));
    return { shape: { type: "polygon", points } };
  }
  return {};
}

// ---------------------------------------------------------------------------
// The decorator

/** A handle drag, as decided at pointer down. */
export interface HandleDrag {
  pointerId: number;
  stamp: InteractionStamp;
  handle: Handle;
  /** The object's geometry at pointer down. */
  target: HandleTarget;
  /** The board point pressed. */
  grab: Point;
  /** The object's label, for the write's label and notices. */
  name: string;
  /** The current preview, or null before the first move. */
  preview: ScenePreview | null;
  /** The camera and viewport of the last event, to restore the handles on a cancel. */
  camera: Camera;
  viewport: ViewportSize;
}

/** A handle write's geometry, shown until the client has seen the write. */
export interface HeldHandles {
  stamp: InteractionStamp;
  object: ObjectId;
  preview: ScenePreview;
  /** The committed revision, once settled. */
  revision: number | null;
}

/** The handles overlay last emitted. */
export interface ShownHandles {
  object: ObjectId;
  handles: HandleMark[];
}

export interface HandlesPhase<TPhase> {
  /** The wrapped tool's phase. */
  inner: TPhase;
  drag: HandleDrag | null;
  held: HeldHandles | null;
  /** The primary pointer down that went to the wrapped tool and is not up yet. */
  innerPointer: number | null;
  /** The wrapped tool's overlays, as last emitted. */
  innerOverlays: ToolOverlay[];
  shown: ShownHandles | null;
  /** The cursor of the handle under the pointer, while nothing is in progress. */
  hoverCursor: string | null;
}

/** A tool state as plain data (the decorator is generic over the tool id). */
interface PlainState<P> {
  tool: ToolId;
  options: unknown;
  phase: P;
}

const EMPTY_PREVIEWS: Previews = new Map();

const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/** A resize cursor for a board direction (y down). */
function resizeCursor(direction: Point): string {
  const deg = normalizeDeg((Math.atan2(direction[1], direction[0]) * 180) / Math.PI) % 180;
  return RESIZE_CURSORS[Math.round(deg / 45) % 4] as string;
}

function handleCursor(handle: Handle, rotation: number, dragging: boolean): string {
  const r = rotationOf(rotation);
  switch (handle.grip.type) {
    case "resize":
      return resizeCursor(turn([handle.grip.sx, handle.grip.sy], r));
    case "radius":
      return resizeCursor(turn([1, 0], r));
    case "vertex":
      return "move";
    case "rotate":
      return dragging ? "grabbing" : "grab";
  }
}

function nameOf(view: ObjectView | null, id: ObjectId): string {
  const name = view?.cells.name?.value;
  return name?.type === "text" && name.value !== "" ? name.value : id;
}

function sameMarks(a: readonly HandleMark[], b: readonly HandleMark[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const n = b[i] as HandleMark;
      return (
        m.key === n.key &&
        m.role === n.role &&
        m.at[0] === n.at[0] &&
        m.at[1] === n.at[1] &&
        m.from?.[0] === n.from?.[0] &&
        m.from?.[1] === n.from?.[1]
      );
    })
  );
}

function sameShown(a: ShownHandles | null, b: ShownHandles | null): boolean {
  if (a === null || b === null) return a === b;
  return a.object === b.object && sameMarks(a.handles, b.handles);
}

function sameShape(a: Shape, b: Shape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether `preview` changes nothing of `target`. */
function unchanged(target: HandleTarget, preview: ScenePreview): boolean {
  if (preview.rotation !== undefined && preview.rotation !== normalizeDeg(target.rotation)) {
    return false;
  }
  if (
    preview.position !== undefined &&
    (preview.position[0] !== target.anchor[0] || preview.position[1] !== target.anchor[1])
  ) {
    return false;
  }
  if (
    preview.shape !== undefined &&
    (target.shape === null || !sameShape(preview.shape, target.shape))
  ) {
    return false;
  }
  return true;
}

function withPreview(target: HandleTarget, preview: ScenePreview): HandleTarget {
  return {
    id: target.id,
    anchor: preview.position ?? target.anchor,
    rotation: preview.rotation ?? target.rotation,
    shape: preview.shape ?? target.shape,
  };
}

/** The ops writing `preview` to `object`. */
function opsFor(object: ObjectId, preview: ScenePreview): WireOp[] {
  const ops: WireOp[] = [];
  if (preview.shape !== undefined) ops.push({ type: "set_shape", object, shape: preview.shape });
  if (preview.position !== undefined) {
    const value: InputValue = {
      type: "list",
      items: [
        { type: "number", value: preview.position[0] },
        { type: "number", value: preview.position[1] },
      ],
    };
    ops.push({ type: "set_value", object, cell: "position", value });
  }
  if (preview.rotation !== undefined) {
    ops.push({
      type: "set_value",
      object,
      cell: "rotation",
      value: { type: "number", value: preview.rotation },
    });
  }
  return ops;
}

function labelFor(handle: Handle, name: string): string {
  switch (handle.grip.type) {
    case "rotate":
      return `Rotate ${name}`;
    case "vertex":
      return `Reshape ${name}`;
    default:
      return `Resize ${name}`;
  }
}

/**
 * `tool` with resize, vertex and rotate handles on the single selected
 * object (see the module comment). The decorated tool keeps `tool`'s id and
 * options; its phase wraps `tool`'s.
 */
export function withHandles<TPhase, K extends ToolId>(
  tool: Tool<TPhase, K>,
): Tool<HandlesPhase<TPhase>, K> {
  type Phase = HandlesPhase<TPhase>;
  type State = ToolState<Phase, K>;
  type Result = ToolResult<Phase, K>;
  type InnerState = ToolState<TPhase, K>;

  const plain = (state: State) => state as unknown as PlainState<Phase>;
  const innerOf = (state: State): InnerState => {
    const s = plain(state);
    return { ...s, phase: s.phase.inner } as unknown as InnerState;
  };
  const withPhase = (state: State, patch: Partial<Phase>): State => {
    const s = plain(state);
    return { ...s, phase: { ...s.phase, ...patch } } as unknown as State;
  };
  /** `state` with the wrapped tool's new state. */
  const withInner = (state: State, inner: InnerState): State => {
    const i = inner as unknown as PlainState<TPhase>;
    const s = plain(state);
    return { ...i, phase: { ...s.phase, inner: i.phase } } as unknown as State;
  };

  /** The handles to show for `input`, `selection` and the phase's drag and held geometry. */
  function currentHandles(
    phase: Phase,
    input: ToolInput,
    selection: readonly ObjectId[],
  ): Handle[] {
    if (input.viewer.type !== "gm") return [];
    const { drag, held } = phase;
    if (drag !== null) {
      const target = drag.preview === null ? drag.target : withPreview(drag.target, drag.preview);
      return handlesFor(target, input.camera, input.viewport);
    }
    if (phase.innerOverlays.length > 0 || selection.length !== 1) return [];
    const id = selection[0] as ObjectId;
    const item = input.scene.items.find((i) => i.id === id);
    if (item === undefined) return [];
    const target = held !== null && held.object === id ? withPreview(item, held.preview) : item;
    return handlesFor(target, input.camera, input.viewport);
  }

  /** The phase with a held geometry dropped once the client has seen its write. */
  function expireHeld(phase: Phase, input: ToolInput): Phase {
    const { held } = phase;
    if (held === null || held.revision === null || input.revision < held.revision) return phase;
    return { ...phase, held: null };
  }

  /**
   * Finishes a reduction: replaces the wrapped tool's `overlays` effects by
   * one with its overlays plus the handles, emitted when either changed.
   */
  function present(
    state: State,
    effects: Effect[],
    input: ToolInput | null,
    fixed?: ShownHandles | null,
  ): Result {
    let phase = plain(state).phase;
    let innerChanged = false;
    const rest: Effect[] = [];
    let at = -1;
    let selection: readonly ObjectId[] | null = null;
    for (const e of effects) {
      if (e.type === "overlays") {
        phase = { ...phase, innerOverlays: [...e.overlays] };
        innerChanged = true;
        if (at < 0) at = rest.length;
        continue;
      }
      if (e.type === "select") selection = e.ids;
      rest.push(e);
    }
    let shown: ShownHandles | null;
    if (input === null) {
      // A cancel has no input: the given handles, else the shown ones unless the selection changed.
      shown = fixed !== undefined ? fixed : selection === null ? phase.shown : null;
    } else {
      phase = expireHeld(phase, input);
      const handles = currentHandles(phase, input, selection ?? input.selection);
      shown =
        handles.length === 0
          ? null
          : { object: (handles[0] as Handle).object, handles: handleMarks(handles) };
    }
    if (!innerChanged && sameShown(shown, phase.shown)) {
      return { state: withPhase(state, phase), effects: rest };
    }
    const overlays: ToolOverlay[] = [...phase.innerOverlays];
    if (shown !== null)
      overlays.push({ kind: "handles", object: shown.object, handles: shown.handles });
    const effect: Effect = { type: "overlays", overlays };
    if (at < 0) rest.push(effect);
    else rest.splice(at, 0, effect);
    return { state: withPhase(state, { ...phase, shown }), effects: rest };
  }

  /** Passes `event` to the wrapped tool and presents the result. */
  function delegate(state: State, event: InteractionEvent, input: ToolInput): Result {
    let next = state;
    if (event.type === "pointer_down" && event.button === PRIMARY_BUTTON) {
      if (plain(state).phase.innerPointer === null) {
        next = withPhase(state, { innerPointer: event.pointerId });
      }
    } else if (
      (event.type === "pointer_up" || event.type === "pointer_cancel") &&
      plain(state).phase.innerPointer === event.pointerId
    ) {
      next = withPhase(state, { innerPointer: null });
    }
    const out = tool.reduce(innerOf(next), event, input);
    return present(withInner(next, out.state), out.effects, input);
  }

  function startDrag(
    state: State,
    event: PointerInteractionEvent,
    input: ToolInput,
  ): Result | null {
    const phase = expireHeld(plain(state).phase, input);
    if (phase.innerPointer !== null || event.button !== PRIMARY_BUTTON) return null;
    const handles = currentHandles(phase, input, input.selection);
    const handle = hitHandle(handles, event.screen);
    if (handle === null) return null;
    const item = input.scene.items.find((i) => i.id === handle.object);
    const stamp = captureStamp(input);
    if (item === undefined || stamp === null) return null;
    const held = phase.held;
    const target: HandleTarget =
      held !== null && held.object === item.id ? withPreview(item, held.preview) : item;
    const drag: HandleDrag = {
      pointerId: event.pointerId,
      stamp,
      handle,
      target: {
        id: target.id,
        anchor: target.anchor,
        rotation: target.rotation,
        shape: target.shape,
      },
      grab: event.board,
      name: nameOf(input.views(item.id), item.id),
      preview: null,
      camera: input.camera,
      viewport: input.viewport,
    };
    return present(withPhase(state, { ...phase, drag, hoverCursor: null }), [], input);
  }

  function dragEvent(
    state0: State,
    drag0: HandleDrag,
    event: InteractionEvent,
    input: ToolInput,
  ): Result {
    const drag: HandleDrag = { ...drag0, camera: input.camera, viewport: input.viewport };
    const state = withPhase(state0, { drag });
    switch (event.type) {
      case "pointer_move": {
        if (event.pointerId !== drag.pointerId) return present(state, [], input);
        const preview = dragHandle(
          drag.target,
          drag.handle,
          drag.grab,
          event.board,
          event.modifiers.shift,
        );
        const next = withPhase(state, { drag: { ...drag, preview } });
        return present(
          next,
          [{ type: "previews", previews: new Map([[drag.target.id, preview]]) }],
          input,
        );
      }
      case "pointer_up": {
        if (event.pointerId !== drag.pointerId) return present(state, [], input);
        const preview = dragHandle(
          drag.target,
          drag.handle,
          drag.grab,
          event.board,
          event.modifiers.shift,
        );
        const ended = withPhase(state, { drag: null });
        const clear: Effect[] =
          drag.preview === null ? [] : [{ type: "previews", previews: EMPTY_PREVIEWS }];
        if (unchanged(drag.target, preview)) return present(ended, clear, input);
        const shape = preview.shape;
        const problem = shape?.type === "polygon" ? polygonProblem(shape.points) : undefined;
        if (problem !== undefined) {
          return present(
            ended,
            [
              { type: "previews", previews: EMPTY_PREVIEWS },
              {
                type: "notice",
                level: "warning",
                text: `Cannot reshape ${drag.name}: ${problem}.`,
              },
            ],
            input,
          );
        }
        const held: HeldHandles = {
          stamp: drag.stamp,
          object: drag.target.id,
          preview,
          revision: null,
        };
        return present(
          withPhase(ended, { held }),
          [
            {
              type: "write",
              stamp: drag.stamp,
              ops: opsFor(drag.target.id, preview),
              label: labelFor(drag.handle, drag.name),
              continuations: [],
            },
            {
              type: "previews",
              previews: new Map([[drag.target.id, preview]]),
              hold: { stamp: drag.stamp },
            },
          ],
          input,
        );
      }
      case "pointer_cancel":
        if (event.pointerId !== drag.pointerId) return present(state, [], input);
        return present(
          withPhase(state, { drag: null }),
          [{ type: "previews", previews: EMPTY_PREVIEWS }],
          input,
        );
      case "settled":
        return settled(state, event, input);
      default:
        // Keys, wheel, clicks and other pointers wait for the handle drag to end.
        return present(state, [], input);
    }
  }

  /** A settled result: a handle write's own, else the wrapped tool's. */
  function settled(
    state: State,
    event: Extract<InteractionEvent, { type: "settled" }>,
    input: ToolInput,
  ): Result {
    const { held } = plain(state).phase;
    if (held === null || held.stamp.interactionId !== event.interactionId) {
      return delegate(state, event, input);
    }
    const outcome = event.outcome;
    const next =
      outcome.type === "write" && outcome.result.status === "committed"
        ? withPhase(state, { held: { ...held, revision: outcome.result.revision } })
        : withPhase(state, { held: null });
    return present(next, [], input);
  }

  return {
    id: tool.id,
    init(options) {
      const inner = tool.init(options) as unknown as PlainState<TPhase>;
      const phase: Phase = {
        inner: inner.phase,
        drag: null,
        held: null,
        innerPointer: null,
        innerOverlays: [],
        shown: null,
        hoverCursor: null,
      };
      return { ...inner, phase } as unknown as State;
    },
    cursor(state) {
      const { drag, hoverCursor, innerPointer } = plain(state).phase;
      if (drag !== null) return handleCursor(drag.handle, drag.target.rotation, true);
      if (hoverCursor !== null && innerPointer === null) return hoverCursor;
      return tool.cursor(innerOf(state));
    },
    reduce(state, event: InteractionEvent, input: ToolInput): Result {
      const { drag } = plain(state).phase;
      if (drag !== null) return dragEvent(state, drag, event, input);
      if (event.type === "settled") return settled(state, event, input);
      if (event.type === "pointer_down") {
        const started = startDrag(state, event, input);
        if (started !== null) return started;
      }
      const out = delegate(state, event, input);
      if (event.type !== "pointer_move") return out;
      // The cursor of a handle under the pointer, while nothing is in progress.
      const phase = plain(out.state).phase;
      let hoverCursor: string | null = null;
      if (phase.innerPointer === null && phase.shown !== null) {
        const handles = currentHandles(phase, input, input.selection);
        const hit = hitHandle(handles, event.screen);
        const item = hit === null ? undefined : input.scene.items.find((i) => i.id === hit.object);
        if (hit !== null && item !== undefined)
          hoverCursor = handleCursor(hit, item.rotation, false);
      }
      return { state: withPhase(out.state, { hoverCursor }), effects: out.effects };
    },
    cancel(state, reason: CancelReason): Result {
      const { drag } = plain(state).phase;
      const reset: Partial<Phase> = {
        drag: null,
        held: null,
        innerPointer: null,
        hoverCursor: null,
      };
      if (drag !== null) {
        // The handle drag ends with no write; Escape does not also clear the selection.
        const ended = withPhase(state, reset);
        const effects: Effect[] = [{ type: "previews", previews: EMPTY_PREVIEWS }];
        if (reason !== "escape") return present(ended, effects, null, null);
        const handles = handlesFor(drag.target, drag.camera, drag.viewport);
        return present(ended, effects, null, {
          object: drag.target.id,
          handles: handleMarks(handles),
        });
      }
      const out = tool.cancel(innerOf(state), reason);
      const next = withPhase(withInner(state, out.state), reset);
      // A board, viewer or tool change drops the handles until the next event.
      return present(next, out.effects, null, reason === "escape" ? undefined : null);
    },
  };
}
