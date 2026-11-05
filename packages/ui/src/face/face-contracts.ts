/**
 * The shared face gesture contracts (DESIGN.md §4.6 Gestures; M5 plan
 * review r1 finding 16, review r3 findings 2, 3). Types only: hit testing
 * and drop resolution are vtt-1xv.26's (`faceHitAt`, `dropTargetAt`),
 * `withFaces` and the default policy vtt-1xv.16's, the entry gesture
 * vtt-1xv.25's, the binder policy vtt-1xv.17's.
 */
import type { ActionStateView, ObjectView } from "@vtt/protocol";
import type { Bounds, ObjectId } from "@vtt/schema";
import type { InteractionStamp } from "../interaction/contracts";
import type { Effect } from "../interaction/effects";
import type { InteractionEvent } from "../interaction/events";
import type { ToolOverlay } from "../interaction/overlays";
import type { ReducerInput, ToolInput } from "../interaction/tool";
import type { FaceStateStore } from "./face-state";
import type { Affine } from "./face-transform";

/** Which of an object's element lists is drawn: `elements` or `collapsed`. */
export type FaceList = "full" | "collapsed";

/** One enclosing contents element of a hit, from the board object inward. */
export interface FacePathEntry {
  container: ObjectId;
  /** The contents element's `index` (`DEFAULT_CONTENTS_ELEMENT` for a default face's list). */
  element: number;
  /** The list of `container` that holds the element. */
  list: FaceList;
  /** That container's frame → board. */
  transform: Affine;
}

/** What a face hit landed on. */
export type FaceHitTarget =
  | {
      type: "button";
      action: string;
      enabled: boolean;
      reason?: ActionStateView["reason"];
      /** The button's object is a template (FacePolicy.canInvoke refuses it). */
      template: boolean;
    }
  | { type: "editor" | "value"; cell: string }
  /** A row of a contents element, outside any target of its drawing. */
  | { type: "entry"; id: ObjectId; container: ObjectId; element: number }
  | { type: "chevron" | "gear"; id: ObjectId }
  /** A contents element where no row is: `index` is the insertion index under the point. */
  | { type: "contents"; container: ObjectId; element: number; index: number }
  /** The object's footprint, outside every other target. */
  | { type: "body" };

export interface FaceHit {
  /** The innermost object under the point (a contained child for a hit inside an expanded entry). */
  object: ObjectId;
  /** The enclosing contents elements, from the board object inward; empty on a board object's own face. */
  path: FacePathEntry[];
  /** Board → the hit object's frame. */
  toLocal: Affine;
  /** The board-space axis-aligned box of the target. */
  rect: Bounds;
  target: FaceHitTarget;
}

/** Where a drop lands (DESIGN.md §4.6 Gestures): editor, else innermost contents, else board. */
export type DropTarget =
  | { kind: "editor"; object: ObjectId; element: number }
  | { kind: "contents"; container: ObjectId; element: number; index: number }
  | { kind: "board" };

export interface FacePolicyContext {
  input: ReducerInput;
  stamp: InteractionStamp;
  faceState: FaceStateStore;
}

/** A policy override for a face hit: its effects, or null for the default behaviour. */
export type FaceHandler = (hit: FaceHit, ctx: FacePolicyContext) => Effect[] | null;

export interface FacePolicy {
  /** Whether `view`'s actions may be invoked from the UI at all, and why not. */
  canInvoke(view: ObjectView): { ok: true } | { ok: false; reason: string };
  onButton?: FaceHandler;
  onToggle?: FaceHandler;
  onGear?: FaceHandler;
}

/**
 * A gesture `withFaces` offers each pointer down's hit to, in order: `start`
 * claims it (non-null state), after which every event goes to `reduce`
 * until it returns a null state; `cancel` ends it unfinished.
 */
export interface FaceGesture<S> {
  id: string;
  start(hit: FaceHit, event: InteractionEvent, input: ToolInput, stamp: InteractionStamp): S | null;
  reduce(
    state: S,
    event: InteractionEvent,
    input: ToolInput,
  ): { state: S | null; effects: Effect[] };
  cancel(state: S): Effect[];
  overlays(state: S): ToolOverlay[];
}

export interface WithFacesOptions {
  faceState: FaceStateStore;
  policy: FacePolicy;
  gestures?: FaceGesture<unknown>[];
}
