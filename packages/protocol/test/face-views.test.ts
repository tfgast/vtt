/**
 * Live faces and action state in object views (vtt-1xv.12; PROTOCOL.md §7.2,
 * §12; M5-D8, M5-D23; review r1 findings 5, 7; review r3 finding 6):
 * `ActionStateView`, `FaceElementView`, `FaceView`, and `ObjectView`'s
 * `action_states` and `face`, round-tripped through the result schemas of
 * the live-view methods. Effects and snapshots never carry live state.
 */
import {
  type ActionStateView,
  ActionStateViewSchema,
  type FaceElementView,
  FaceElementViewSchema,
  type FaceView,
  FaceViewSchema,
  ObjectSnapshotViewSchema,
  type ObjectView,
  ObjectViewSchema,
  parseResult,
} from "@vtt/protocol";
import { describe, expect, expectTypeOf, test } from "vitest";

const states: ActionStateView[] = [
  { name: "Roll", enabled: true },
  { name: "Roll damage", enabled: false, reason: "when_false" },
  { name: "Apply", enabled: false, reason: "when_error" },
];

/** A GM face: hidden elements retained with a reason, `show_when` kept. */
const gmFace: FaceView = {
  elements: [
    {
      type: "value",
      cell: "name",
      rect: [-1, -1, 2, 0.4],
      style: { size: "large" },
      index: 0,
      shown: true,
    },
    {
      type: "button",
      action: "Roll",
      rect: [-1, 0.5, 1, 0.45],
      show_when: "roll = empty",
      index: 1,
      shown: false,
      reason: "show_when_false",
    },
    {
      type: "editor",
      cell: "target",
      rect: [0, 0, 1, 1],
      show_when: "1 / 0",
      index: 2,
      shown: false,
      reason: "show_when_error",
      error: "#DIV0",
    },
    {
      type: "button",
      action: "Nope",
      rect: [0, 1, 1, 1],
      index: 3,
      shown: false,
      reason: "no_action",
    },
    { type: "contents", rect: [-1, 2, 2, 1], entries: "collapsed", index: 4, shown: true },
  ],
  collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6], index: 0, shown: true }],
  default_action: "Roll",
};

/** The same face for a character: only shown elements, no `show_when`, indices kept. */
const characterFace: FaceView = {
  elements: [
    {
      type: "value",
      cell: "name",
      rect: [-1, -1, 2, 0.4],
      style: { size: "large" },
      index: 0,
      shown: true,
    },
    { type: "contents", rect: [-1, 2, 2, 1], entries: "collapsed", index: 4, shown: true },
  ],
  default_action: "Roll",
};

const view = (extra: Partial<ObjectView> = {}): ObjectView => ({
  id: "card",
  is_template: false,
  is_character: false,
  cells: { name: { value: { type: "text", value: "Attack" }, kind: "literal" } },
  actions: [{ name: "Roll", when: "roll = empty", steps: ["roll(1d20) -> roll"] }],
  action_states: [{ name: "Roll", enabled: true }],
  ...extra,
});

describe("ActionStateView", () => {
  test("name, enabled and an optional reason", () => {
    for (const s of states) expect(ActionStateViewSchema.parse(s)).toEqual(s);
    expectTypeOf<ActionStateView["reason"]>().toEqualTypeOf<
      "when_false" | "when_error" | undefined
    >();
  });

  test("rejects unknown reasons and missing fields; strips unknown keys", () => {
    expect(
      ActionStateViewSchema.safeParse({ name: "a", enabled: false, reason: "x" }).success,
    ).toBe(false);
    expect(ActionStateViewSchema.safeParse({ name: "a" }).success).toBe(false);
    expect(ActionStateViewSchema.parse({ name: "a", enabled: true, extra: 1 })).toEqual({
      name: "a",
      enabled: true,
    });
  });
});

describe("FaceElementView and FaceView", () => {
  test("the element plus index and shown, with reason and error when hidden", () => {
    expectTypeOf<FaceElementView>().toMatchTypeOf<{ index: number; shown: boolean }>();
    for (const e of gmFace.elements) expect(FaceElementViewSchema.parse(e)).toEqual(e);
    expect(FaceViewSchema.parse(gmFace)).toEqual(gmFace);
    expect(FaceViewSchema.parse(characterFace)).toEqual(characterFace);
  });

  test("an element without index or shown, or with an unknown reason, is invalid", () => {
    const base = { type: "value", cell: "hp", rect: [0, 0, 1, 1] };
    expect(FaceElementViewSchema.safeParse({ ...base, index: 0 }).success).toBe(false);
    expect(FaceElementViewSchema.safeParse({ ...base, shown: true }).success).toBe(false);
    expect(
      FaceElementViewSchema.safeParse({ ...base, index: 0, shown: false, reason: "hidden" })
        .success,
    ).toBe(false);
    expect(
      FaceElementViewSchema.safeParse({ ...base, index: 0, shown: false, error: "#NOPE" }).success,
    ).toBe(false);
  });
});

describe("ObjectView", () => {
  test("carries action_states and face", () => {
    const v = view({ face: gmFace });
    expect(ObjectViewSchema.parse(v)).toEqual(v);
    expectTypeOf<ObjectView["face"]>().toEqualTypeOf<FaceView | undefined>();
  });

  test("both round-trip through every live-view method's result schema", () => {
    const v = view({ face: characterFace, action_states: states.slice(0, 1) });
    const subscribe = { subscription: "s1", revision: 3, objects: [v], covers: [] };
    expect(parseResult("subscribe", subscribe)).toEqual(subscribe);
    const got = { revision: 3, objects: [v], missing: [] };
    expect(parseResult("get_objects", got)).toEqual(got);
    const listed = { revision: 3, objects: [v], next_cursor: null };
    expect(parseResult("list_objects", listed)).toEqual(listed);
  });

  test("a view without face (no layout, or cells not all) parses", () => {
    const v = view();
    expect(ObjectViewSchema.parse(v)).toEqual(v);
    expect("face" in ObjectViewSchema.parse(v)).toBe(false);
  });

  test("unknown keys inside action states and face elements are stripped", () => {
    const raw = {
      ...view(),
      action_states: [{ name: "Roll", enabled: true, guard: "x" }],
      face: {
        elements: [{ type: "contents", rect: [0, 0, 1, 1], index: 0, shown: true, future: 1 }],
        future: true,
      },
    };
    expect(ObjectViewSchema.parse(raw)).toEqual({
      ...view(),
      face: { elements: [{ type: "contents", rect: [0, 0, 1, 1], index: 0, shown: true }] },
    });
  });
});

describe("snapshots never carry live state", () => {
  test("action_states on a snapshot is stripped; its face has no shown", () => {
    const snap = {
      id: "card",
      is_template: false,
      is_zone: false,
      is_character: false,
      cells: {},
      actions: [{ name: "Roll" }],
      action_states: states,
      face: { elements: [{ type: "contents", rect: [0, 0, 1, 1], index: 0, shown: true }] },
    };
    const parsed = ObjectSnapshotViewSchema.parse(snap);
    expect("action_states" in parsed).toBe(false);
    expect(parsed.face?.elements[0]).toEqual({ type: "contents", rect: [0, 0, 1, 1], index: 0 });
  });
});
