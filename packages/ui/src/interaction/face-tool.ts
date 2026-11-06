/**
 * Face gestures (vtt-1xv.16; DESIGN.md §4.5 Pressing buttons in the UI,
 * §4.6 Edit in place, Gestures, View as in the UI; §7 Undo; M5 plan Q1, Q11,
 * Q12, Q13, review r1 findings 14, 16, r2 findings 1, 4, 7, r3 findings 3,
 * 4, 8).
 *
 * `withFaces(tool, {faceState, policy, gestures})` wraps a tool (the select
 * tool after vtt-3l6.9's `withHandles`) without changing it. Each event's
 * scene gets its faces (vtt-1xv.26's `attachFaces`, memoized per scene and
 * face-state change), and a primary pointer down is hit-tested with
 * `faceHitAt`. The hit is offered to `gestures` in order first: one that
 * starts receives every event until it ends (wheel events included: they
 * are claimed, so the camera does not zoom mid-gesture), and its overlays
 * follow the wrapped tool's. Otherwise:
 *
 * - a button: pressed when the pointer comes up within `FACE_CLICK_PX` →
 *   `policy.onButton`, else `requestInvoke` (invoke.ts), with the stamp
 *   captured at pointer down;
 * - an editor element (the GM, a cell `cellCapabilities` lets them type
 *   into): a click opens the in-place editor over the element's rect; a
 *   formula cell focuses the formula bar there (vtt-3l6.13's rule). A value
 *   element likewise on a double-click. A double-click's effects carry the
 *   stamp of its first pointer down;
 * - a chevron click → `policy.onToggle`, else the entry toggles and, when it
 *   expands, the list holding it (the last entry of the hit's `path`) is
 *   scrolled to reveal it (`revealOffset` on the re-resolved drawing); a
 *   gear click → `policy.onGear`, else nothing;
 * - a double-click elsewhere on an object (its body or its contents
 *   element's empty area) whose face has an enabled `default_action` →
 *   `requestInvoke` (so a template refuses); otherwise the wrapped tool's
 *   (M4's in-place editor) for a board object, and the in-place editor over
 *   a contained object's drawing for the GM;
 * - the wheel (`Tool.wheel`): without Ctrl or Meta, the innermost
 *   overflowing list among the hit's `path` and its own `contents` target
 *   scrolls by `deltaY / 100` units, clamped, and the event is claimed;
 *   when none overflows, or with Ctrl or Meta held (a pinch, M6-D11), the
 *   wrapped tool's `wheel`, else null (the machine pans or zooms);
 * - anything else (entry rows and contained bodies no gesture claims, a
 *   press that moved beyond `FACE_CLICK_PX`'s release, keys) → the wrapped tool.
 *
 * Cancel (Escape, tool switch, board or viewer change) ends a press or a
 * gesture with no effect but the gesture's `cancel`; Escape then stops
 * there, anything else also cancels the wrapped tool. Results of the
 * effects emitted here are the runtime's: an invocation's notice is shown
 * whatever changed meanwhile, and its settled result changes nothing here.
 */
import type { ObjectView } from "@vtt/protocol";
import type { ObjectId, Point } from "@vtt/schema";
import { defaultFacePolicy, requestInvoke } from "../actions/invoke";
import type {
  FaceGesture,
  FaceHit,
  FacePolicyContext,
  WithFacesOptions,
} from "../face/face-contracts";
import { faceHitAt, pathContents } from "../face/face-hit";
import { revealOffset } from "../face/face-model";
import { attachFaces, type FaceScene } from "../face/face-scene";
import type { Scene } from "../scene/scene";
import { cellCapabilities } from "../values/input";
import type { InteractionStamp } from "./contracts";
import type { Effect } from "./effects";
import type { InteractionEvent, PointerInteractionEvent } from "./events";
import { PRIMARY_BUTTON } from "./machine";
import type { ToolOverlay } from "./overlays";
import {
  type CancelReason,
  captureStamp,
  type ReducerInput,
  type Tool,
  type ToolId,
  type ToolInput,
  type ToolResult,
  type ToolState,
  type WheelInteractionEvent,
} from "./tool";

/** A press released within this many screen pixels of its pointer down is a click. */
export const FACE_CLICK_PX = 4;
/** Wheel pixels per unit of contents scroll: a list scrolls by `deltaY / 100` units. */
export const FACE_WHEEL_PX_PER_UNIT = 100;

/** A press on a face target, decided at pointer down. */
export interface FacePress {
  pointerId: number;
  screen: Point;
  hit: FaceHit;
  stamp: InteractionStamp;
  /** It moved beyond `FACE_CLICK_PX`: its release does nothing. */
  moved: boolean;
}

/** A gesture of `WithFacesOptions.gestures` in progress, with its state. */
export interface ActiveFaceGesture {
  gesture: FaceGesture<unknown>;
  state: unknown;
}

export interface FacesPhase<TPhase> {
  /** The wrapped tool's phase. */
  inner: TPhase;
  press: FacePress | null;
  gesture: ActiveFaceGesture | null;
  /** The primary pointer down that went to the wrapped tool and is not up yet. */
  innerPointer: number | null;
  /** The wrapped tool's overlays, as last emitted. */
  innerOverlays: ToolOverlay[];
  /** The active gesture's overlays, as last emitted. */
  gestureOverlays: ToolOverlay[];
  /**
   * The stamps of the last two primary pointer downs, oldest first: a
   * `double_click` uses the first of them (its first press), so its write
   * carries the revision the double click began on.
   */
  recentDowns: InteractionStamp[];
}

/** A tool state as plain data (the decorator is generic over the tool id). */
interface PlainState<P> {
  tool: ToolId;
  options: unknown;
  phase: P;
}

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const sameOverlays = (a: readonly ToolOverlay[], b: readonly ToolOverlay[]) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether `viewer`'s click may edit `cell` of `view` in place (the GM, a typeable cell). */
function editable(input: ReducerInput, view: ObjectView | null, cell: string): boolean {
  if (input.viewer.type !== "gm" || view === null) return false;
  return cellCapabilities(cell, view.cells[cell]).literal;
}

/** Whether `view`'s action `name` is enabled (`action_states`, read as `?? []`). */
function enabledAction(view: ObjectView, name: string): boolean {
  return (view.action_states ?? []).some((s) => s.name === name && s.enabled);
}

/**
 * `tool` with face buttons, in-place editing, chevrons, gears, the default
 * action and contents scrolling (see the module comment). The decorated tool
 * keeps `tool`'s id and options; its phase wraps `tool`'s.
 */
export function withFaces<TPhase, K extends ToolId>(
  tool: Tool<TPhase, K>,
  options: WithFacesOptions,
): Tool<FacesPhase<TPhase>, K> {
  type Phase = FacesPhase<TPhase>;
  type State = ToolState<Phase, K>;
  type Result = ToolResult<Phase, K>;
  type InnerState = ToolState<TPhase, K>;

  const { faceState } = options;
  const policy = options.policy ?? defaultFacePolicy;
  const gestures = options.gestures ?? [];

  // The face scene, memoized per scene, viewer kind and face-state change.
  let faceVersion = 0;
  faceState.subscribe(() => {
    faceVersion++;
  });
  let memo: { scene: Scene; gm: boolean; version: number; faces: FaceScene } | null = null;
  const facesOf = (input: ReducerInput): FaceScene => {
    const gm = input.viewer.type === "gm";
    if (
      memo !== null &&
      memo.scene === input.scene &&
      memo.gm === gm &&
      memo.version === faceVersion
    ) {
      return memo.faces;
    }
    const faces = attachFaces(input.scene, input.views, faceState, { gm });
    memo = { scene: input.scene, gm, version: faceVersion, faces };
    return faces;
  };

  const plain = (state: State) => state as unknown as PlainState<Phase>;
  const phaseOf = (state: State): Phase => plain(state).phase;
  const innerOf = (state: State): InnerState => {
    const s = plain(state);
    return { ...s, phase: s.phase.inner } as unknown as InnerState;
  };
  const withPhase = (state: State, patch: Partial<Phase>): State => {
    const s = plain(state);
    return { ...s, phase: { ...s.phase, ...patch } } as unknown as State;
  };
  const withInner = (state: State, inner: InnerState): State => {
    const i = inner as unknown as PlainState<TPhase>;
    const s = plain(state);
    return { ...i, phase: { ...s.phase, inner: i.phase } } as unknown as State;
  };

  /**
   * Finishes a reduction: the wrapped tool's `overlays` effects become its
   * overlays plus the gesture's; a change of the gesture's overlays alone
   * adds one such effect.
   */
  function present(
    state: State,
    effects: readonly Effect[],
    gestureOverlays: ToolOverlay[],
  ): Result {
    const phase = phaseOf(state);
    let innerOverlays = phase.innerOverlays;
    let emitted = false;
    const out: Effect[] = [];
    for (const e of effects) {
      if (e.type === "overlays") {
        innerOverlays = [...e.overlays];
        out.push({ type: "overlays", overlays: [...innerOverlays, ...gestureOverlays] });
        emitted = true;
      } else {
        out.push(e);
      }
    }
    if (!emitted && !sameOverlays(gestureOverlays, phase.gestureOverlays)) {
      out.push({ type: "overlays", overlays: [...innerOverlays, ...gestureOverlays] });
    }
    return { state: withPhase(state, { innerOverlays, gestureOverlays }), effects: out };
  }

  /** Passes `event` to the wrapped tool. */
  function delegate(state: State, event: InteractionEvent, input: ToolInput): Result {
    let next = state;
    const { innerPointer } = phaseOf(state);
    if (event.type === "pointer_down" && event.button === PRIMARY_BUTTON && innerPointer === null) {
      next = withPhase(state, { innerPointer: event.pointerId });
    } else if (
      (event.type === "pointer_up" || event.type === "pointer_cancel") &&
      innerPointer === event.pointerId
    ) {
      next = withPhase(state, { innerPointer: null });
    }
    const out = tool.reduce(innerOf(next), event, input);
    return present(withInner(next, out.state), out.effects, phaseOf(next).gestureOverlays);
  }

  /** A gesture's step: its effects (its own overlays effects dropped) and, while active, its overlays. */
  function gestureStep(
    state: State,
    active: ActiveFaceGesture | null,
    effects: readonly Effect[],
  ): Result {
    const kept = effects.filter((e) => e.type !== "overlays");
    const overlays = active === null ? [] : active.gesture.overlays(active.state);
    return present(withPhase(state, { gesture: active }), kept, overlays);
  }

  function policyContext(input: ToolInput, stamp: InteractionStamp): FacePolicyContext {
    return { input, stamp, faceState };
  }

  /** The default chevron: toggle, and reveal the entry in its list when it expands. */
  function toggle(hit: FaceHit, id: ObjectId, input: ToolInput): Effect[] {
    faceState.toggle(id);
    const last = hit.path[hit.path.length - 1];
    if (last === undefined) return [];
    const lists = pathContents(facesOf(input), hit.path);
    const list = lists[hit.path.length - 1];
    if (list === undefined) return [];
    if (list.entries.find((e) => e.id === id)?.expanded !== true) return [];
    faceState.setScroll(last.container, last.element, revealOffset(list, id), list.maxOffset);
    return [];
  }

  /** What a click on a pressed target does. */
  function clicked(press: FacePress, input: ToolInput): Effect[] {
    const { hit, stamp } = press;
    const t = hit.target;
    switch (t.type) {
      case "button": {
        const custom = policy.onButton?.(hit, policyContext(input, stamp));
        if (custom != null) return custom;
        const view = input.views(hit.object);
        return view === null ? [] : requestInvoke(policy, view, t.action, stamp, input);
      }
      case "editor":
        return [{ type: "open_editor", stamp, object: hit.object, cell: t.cell, rect: hit.rect }];
      case "chevron":
        return policy.onToggle?.(hit, policyContext(input, stamp)) ?? toggle(hit, t.id, input);
      case "gear":
        return policy.onGear?.(hit, policyContext(input, stamp)) ?? [];
      default:
        return [];
    }
  }

  function pointerDown(state: State, event: PointerInteractionEvent, input: ToolInput): Result {
    const phase = phaseOf(state);
    if (phase.press !== null) return { state, effects: [] };
    if (phase.innerPointer !== null || event.button !== PRIMARY_BUTTON) {
      return delegate(state, event, input);
    }
    const stamp = captureStamp(input);
    const hit = stamp === null ? null : faceHitAt(facesOf(input), event.board, input.camera);
    if (stamp === null || hit === null) return delegate(state, event, input);
    for (const gesture of gestures) {
      const started = gesture.start(hit, event, input, stamp);
      if (started !== null) return gestureStep(state, { gesture, state: started }, []);
    }
    const t = hit.target;
    const pressed =
      t.type === "button" ||
      t.type === "chevron" ||
      t.type === "gear" ||
      (t.type === "editor" && editable(input, input.views(hit.object), t.cell));
    if (!pressed) return delegate(state, event, input);
    const press: FacePress = {
      pointerId: event.pointerId,
      screen: event.screen,
      hit,
      stamp,
      moved: false,
    };
    return { state: withPhase(state, { press }), effects: [] };
  }

  function pressEvent(
    state: State,
    press: FacePress,
    event: InteractionEvent,
    input: ToolInput,
  ): Result {
    switch (event.type) {
      case "pointer_move": {
        if (event.pointerId !== press.pointerId || press.moved) return { state, effects: [] };
        if (distance(press.screen, event.screen) <= FACE_CLICK_PX) return { state, effects: [] };
        return { state: withPhase(state, { press: { ...press, moved: true } }), effects: [] };
      }
      case "pointer_up": {
        if (event.pointerId !== press.pointerId) return { state, effects: [] };
        const ended = withPhase(state, { press: null });
        if (press.moved || distance(press.screen, event.screen) > FACE_CLICK_PX) {
          return { state: ended, effects: [] };
        }
        return { state: ended, effects: clicked(press, input) };
      }
      case "pointer_cancel":
        if (event.pointerId !== press.pointerId) return { state, effects: [] };
        return { state: withPhase(state, { press: null }), effects: [] };
      case "settled":
        return delegate(state, event, input);
      default:
        // Other pointers, keys and clicks wait for the press to end.
        return { state, effects: [] };
    }
  }

  /** Records the stamp of a primary pointer down (the last two are kept). */
  function recordDown(state: State, event: InteractionEvent, input: ToolInput): State {
    if (event.type !== "pointer_down" || event.button !== PRIMARY_BUTTON) return state;
    const stamp = captureStamp(input);
    if (stamp === null) return state;
    return withPhase(state, { recentDowns: [...phaseOf(state).recentDowns, stamp].slice(-2) });
  }

  function doubleClick(
    state: State,
    event: Extract<InteractionEvent, { type: "double_click" }>,
    input: ToolInput,
  ): Result {
    // The stamp of the double click's first pointer down, else one taken now.
    const stamp = phaseOf(state).recentDowns[0] ?? captureStamp(input);
    const hit = stamp === null ? null : faceHitAt(facesOf(input), event.board, input.camera);
    if (stamp === null || hit === null) return delegate(state, event, input);
    const done = (effects: Effect[]): Result => ({ state, effects });
    const t = hit.target;
    const view = input.views(hit.object);
    switch (t.type) {
      case "value":
        if (!editable(input, view, t.cell)) return delegate(state, event, input);
        return done([
          { type: "open_editor", stamp, object: hit.object, cell: t.cell, rect: hit.rect },
        ]);
      case "editor":
        // Its click opened the editor already.
        return editable(input, view, t.cell) ? done([]) : delegate(state, event, input);
      case "button":
      case "chevron":
      case "gear":
      case "entry":
        return done([]);
      case "body":
      case "contents": {
        const action = view?.face?.default_action;
        if (view !== null && action !== undefined && enabledAction(view, action)) {
          return done(requestInvoke(policy, view, action, stamp, input));
        }
        if (hit.path.length === 0) return delegate(state, event, input);
        // A contained object: M4's edit in place, over its drawing.
        if (input.viewer.type !== "gm") return done([]);
        return done([{ type: "open_editor", stamp, object: hit.object, rect: hit.rect }]);
      }
    }
  }

  /** Scrolls the innermost overflowing list under `event`; null when there is none. */
  function scrollAt(event: WheelInteractionEvent, input: ToolInput): boolean {
    const scene = facesOf(input);
    const hit = faceHitAt(scene, event.board, input.camera);
    if (hit === null) return false;
    const steps: { container: ObjectId; element: number }[] = hit.path.map((p) => ({
      container: p.container,
      element: p.element,
    }));
    if (hit.target.type === "contents") {
      steps.push({ container: hit.target.container, element: hit.target.element });
    }
    const lists = pathContents(scene, steps);
    for (let i = lists.length - 1; i >= 0; i--) {
      const list = lists[i];
      const step = steps[i];
      if (list === undefined || step === undefined || !(list.maxOffset > 0)) continue;
      faceState.scrollBy(
        step.container,
        step.element,
        event.deltaY / FACE_WHEEL_PX_PER_UNIT,
        list.maxOffset,
      );
      return true;
    }
    return false;
  }

  const decorated: Tool<Phase, K> = {
    id: tool.id,
    init(toolOptions) {
      const inner = tool.init(toolOptions) as unknown as PlainState<TPhase>;
      const phase: Phase = {
        inner: inner.phase,
        press: null,
        gesture: null,
        innerPointer: null,
        innerOverlays: [],
        gestureOverlays: [],
        recentDowns: [],
      };
      return { ...inner, phase } as unknown as State;
    },
    cursor(state) {
      const { press, gesture } = phaseOf(state);
      if (press !== null) return "pointer";
      if (gesture !== null) return "grabbing";
      return tool.cursor(innerOf(state));
    },
    reduce(state0, event: InteractionEvent, input: ToolInput): Result {
      const state = recordDown(state0, event, input);
      const { gesture, press } = phaseOf(state);
      if (gesture !== null) {
        const out = gesture.gesture.reduce(gesture.state, event, input);
        const next = out.state === null ? null : { gesture: gesture.gesture, state: out.state };
        return gestureStep(state, next, out.effects);
      }
      if (press !== null) return pressEvent(state, press, event, input);
      switch (event.type) {
        case "pointer_down":
          return pointerDown(state, event, input);
        case "double_click":
          return doubleClick(state, event, input);
        default:
          return delegate(state, event, input);
      }
    },
    cancel(state, reason: CancelReason): Result {
      const { gesture, press } = phaseOf(state);
      let next = withPhase(state, { press: null, gesture: null });
      const effects: Effect[] = [];
      if (gesture !== null) {
        effects.push(...gesture.gesture.cancel(gesture.state).filter((e) => e.type !== "overlays"));
      }
      // Escape ends what was in progress here and nothing else.
      if (reason === "escape" && (gesture !== null || press !== null)) {
        return present(next, effects, []);
      }
      next = withPhase(next, { innerPointer: null });
      const out = tool.cancel(innerOf(next), reason);
      return present(withInner(next, out.state), [...effects, ...out.effects], []);
    },
    wheel(state, event, input) {
      // An active gesture receives every event until it ends, wheels included.
      const { gesture } = phaseOf(state);
      if (gesture !== null) {
        const out = gesture.gesture.reduce(gesture.state, event, input);
        const next = out.state === null ? null : { gesture: gesture.gesture, state: out.state };
        return gestureStep(state, next, out.effects);
      }
      // Ctrl or Meta (a trackpad pinch) is a zoom, never a list scroll (M6-D11).
      const zoom = event.modifiers.ctrl || event.modifiers.meta;
      if (!zoom && scrollAt(event, input)) return { state, effects: [] };
      const out = tool.wheel?.(innerOf(state), event, input) ?? null;
      if (out === null) return null;
      return present(withInner(state, out.state), out.effects, phaseOf(state).gestureOverlays);
    },
  };
  return decorated;
}
