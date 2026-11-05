// @vitest-environment node
import type { ActionStateView, ObjectView } from "@vtt/protocol";
import type { Bounds, ObjectId } from "@vtt/schema";
import type {
  Affine,
  DropTarget,
  Effect,
  FaceGesture,
  FaceHandler,
  FaceHit,
  FaceHitTarget,
  FaceList,
  FacePathEntry,
  FacePolicy,
  FacePolicyContext,
  FaceStateStore,
  InteractionEvent,
  InteractionStamp,
  ReducerInput,
  ToolInput,
  ToolOverlay,
  WithFacesOptions,
} from "@vtt/ui";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("face contracts (types only)", () => {
  test("FaceList", () => {
    expectTypeOf<FaceList>().toEqualTypeOf<"full" | "collapsed">();
  });

  test("FaceHit and its path", () => {
    expectTypeOf<FacePathEntry>().toEqualTypeOf<{
      container: ObjectId;
      element: number;
      list: FaceList;
      transform: Affine;
    }>();
    expectTypeOf<FaceHit>().toEqualTypeOf<{
      object: ObjectId;
      path: FacePathEntry[];
      toLocal: Affine;
      rect: Bounds;
      target: FaceHitTarget;
    }>();
    expectTypeOf<FaceHitTarget>().toEqualTypeOf<
      | {
          type: "button";
          action: string;
          enabled: boolean;
          reason?: ActionStateView["reason"];
          template: boolean;
        }
      | { type: "editor" | "value"; cell: string }
      | { type: "entry"; id: ObjectId; container: ObjectId; element: number }
      | { type: "chevron" | "gear"; id: ObjectId }
      | { type: "contents"; container: ObjectId; element: number; index: number }
      | { type: "body" }
    >();
  });

  test("DropTarget", () => {
    expectTypeOf<DropTarget>().toEqualTypeOf<
      | { kind: "editor"; object: ObjectId; element: number }
      | { kind: "contents"; container: ObjectId; element: number; index: number }
      | { kind: "board" }
    >();
  });

  test("FacePolicy and its context", () => {
    expectTypeOf<FacePolicyContext>().toEqualTypeOf<{
      input: ReducerInput;
      stamp: InteractionStamp;
      faceState: FaceStateStore;
    }>();
    expectTypeOf<FaceHandler>().toEqualTypeOf<
      (hit: FaceHit, ctx: FacePolicyContext) => Effect[] | null
    >();
    expectTypeOf<FacePolicy["canInvoke"]>().toEqualTypeOf<
      (view: ObjectView) => { ok: true } | { ok: false; reason: string }
    >();
    expectTypeOf<FacePolicy["onButton"]>().toEqualTypeOf<FaceHandler | undefined>();
    expectTypeOf<FacePolicy["onToggle"]>().toEqualTypeOf<FaceHandler | undefined>();
    expectTypeOf<FacePolicy["onGear"]>().toEqualTypeOf<FaceHandler | undefined>();
  });

  test("FaceGesture", () => {
    type G = FaceGesture<{ n: number }>;
    expectTypeOf<G["id"]>().toEqualTypeOf<string>();
    expectTypeOf<G["start"]>().toEqualTypeOf<
      (
        hit: FaceHit,
        event: InteractionEvent,
        input: ToolInput,
        stamp: InteractionStamp,
      ) => { n: number } | null
    >();
    expectTypeOf<G["reduce"]>().toEqualTypeOf<
      (
        state: { n: number },
        event: InteractionEvent,
        input: ToolInput,
      ) => { state: { n: number } | null; effects: Effect[] }
    >();
    expectTypeOf<G["cancel"]>().toEqualTypeOf<(state: { n: number }) => Effect[]>();
    expectTypeOf<G["overlays"]>().toEqualTypeOf<(state: { n: number }) => ToolOverlay[]>();
  });

  test("WithFacesOptions accepts gestures of any state", () => {
    expectTypeOf<WithFacesOptions>().toEqualTypeOf<{
      faceState: FaceStateStore;
      policy: FacePolicy;
      gestures?: FaceGesture<unknown>[];
    }>();
    const gesture: FaceGesture<{ n: number }> = {
      id: "count",
      start: () => ({ n: 0 }),
      reduce: (state) => ({ state: { n: state.n + 1 }, effects: [] }),
      cancel: () => [],
      overlays: () => [],
    };
    const gestures: FaceGesture<unknown>[] = [gesture];
    expect(gestures).toHaveLength(1);
  });
});
