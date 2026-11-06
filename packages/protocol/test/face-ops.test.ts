/**
 * Faces on the wire (vtt-1xv.7; PROTOCOL.md §5, §7.6, §12; M5-D7, M5-D23):
 * the `set_face` op and `ObjectInit.face`, and `FaceLayoutView`, the wire
 * type of historical faces in `field: "face"` effects and snapshots.
 */
import {
  EFFECT_VIEW_TYPES,
  FaceElementViewSchema,
  type FaceLayoutView,
  FaceLayoutViewSchema,
  FIELD_EFFECT_FIELDS,
  ObjectInitSchema,
  ObjectSnapshotViewSchema,
  parseResult,
  unknownEffectVariant,
  WIRE_OP_TYPES,
  type WireOp,
  WireOpSchema,
} from "@vtt/protocol";
import type { FaceLayout } from "@vtt/schema";
import { describe, expect, expectTypeOf, test } from "vitest";

const badge: FaceLayout = {
  elements: [
    {
      type: "value",
      cell: "hp",
      rect: [-0.5, -0.5, 1, 0.4],
      show_when: "hp > 0",
      min_size: 8,
      style: { size: "large", align: "center", caption: true },
    },
    { type: "editor", cell: "notes", rect: [-0.5, 0, 1, 0.4] },
    { type: "button", action: "Roll", rect: [-0.5, 0.5, 1, 0.4], label: "Roll!" },
    { type: "contents", rect: [-0.5, 1, 1, 1], entries: "collapsed" },
  ],
  collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6] }],
  default_action: "Roll",
};

/** `badge` with every element's index: the GM's lossless view. */
const gmView: FaceLayoutView = {
  elements: badge.elements.map((e, index) => ({ ...e, index })),
  collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6], index: 0 }],
  default_action: "Roll",
};

/** A character's view: no `show_when`, `notes` (unreadable) omitted, indices kept. */
const characterView: FaceLayoutView = {
  elements: [
    {
      type: "value",
      cell: "hp",
      rect: [-0.5, -0.5, 1, 0.4],
      min_size: 8,
      style: { size: "large", align: "center", caption: true },
      index: 0,
    },
    { type: "button", action: "Roll", rect: [-0.5, 0.5, 1, 0.4], label: "Roll!", index: 2 },
    { type: "contents", rect: [-0.5, 1, 1, 1], entries: "collapsed", index: 3 },
  ],
  collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6], index: 0 }],
  default_action: "Roll",
};

describe("the set_face op", () => {
  test("there are 20 op kinds, set_face after set_actions (PROTOCOL.md §5 table order)", () => {
    expect(WIRE_OP_TYPES).toHaveLength(20);
    expect(WIRE_OP_TYPES.indexOf("set_face")).toBe(WIRE_OP_TYPES.indexOf("set_actions") + 1);
  });

  test("set_face with a layout or null validates", () => {
    const ops: WireOp[] = [
      { type: "set_face", object: "goblin1", face: badge },
      { type: "set_face", object: "$die", face: null },
      { type: "set_face", object: "goblin1", face: { elements: [] } },
    ];
    for (const op of ops) expect(WireOpSchema.parse(op)).toEqual(op);
  });

  test("set_face is strict all the way down", () => {
    const bad: unknown[] = [
      { type: "set_face", object: "goblin1" },
      { type: "set_face", object: "goblin1", face: badge, extra: 1 },
      { type: "set_face", object: "goblin1", face: { ...badge, extra: 1 } },
      {
        type: "set_face",
        object: "goblin1",
        face: { elements: [{ type: "value", cell: "hp", rect: [0, 0, 1, 1], index: 0 }] },
      },
      {
        type: "set_face",
        object: "goblin1",
        face: { elements: [{ type: "value", cell: "hp", rect: [0, 0, 1, 1], shown: true }] },
      },
      { type: "set_face", object: "goblin1", face: { elements: [{ type: "value", cell: "hp" }] } },
      { type: "set_face", object: "not an id", face: null },
    ];
    for (const op of bad)
      expect(WireOpSchema.safeParse(op).success, JSON.stringify(op)).toBe(false);
  });

  test("limits are the authority's: 201 elements and two contents parse (rejected invalid later)", () => {
    const value = {
      type: "value" as const,
      cell: "hp",
      rect: [0, 0, 1, 1] as [number, number, number, number],
    };
    const many: WireOp = {
      type: "set_face",
      object: "goblin1",
      face: { elements: Array.from({ length: 201 }, () => value) },
    };
    expect(WireOpSchema.safeParse(many).success).toBe(true);
    const contents: WireOp = {
      type: "set_face",
      object: "goblin1",
      face: {
        elements: [
          { type: "contents", rect: [0, 0, 1, 1] },
          { type: "contents", rect: [0, 0, 1, 1] },
        ],
      },
    };
    expect(WireOpSchema.safeParse(contents).success).toBe(true);
  });

  test("ObjectInit takes an optional face", () => {
    expect(ObjectInitSchema.parse({ face: badge })).toEqual({ face: badge });
    expect(ObjectInitSchema.parse({})).toEqual({});
    expect(ObjectInitSchema.safeParse({ face: null }).success).toBe(false);
    expect(ObjectInitSchema.safeParse({ face: { elements: [{}] } }).success).toBe(false);
  });
});

describe("FaceLayoutView", () => {
  test("is the stored layout with each element's index", () => {
    expectTypeOf<FaceLayoutView["elements"][number]>().toMatchTypeOf<{ index: number }>();
    expect(FaceLayoutViewSchema.parse(gmView)).toEqual(gmView);
    expect(FaceLayoutViewSchema.parse(characterView)).toEqual(characterView);
  });

  test("every element needs an index; live `shown` and unknown keys are stripped", () => {
    const { index: _, ...noIndex } = gmView.elements[0] ?? { index: 0 };
    expect(FaceLayoutViewSchema.safeParse({ elements: [noIndex] }).success).toBe(false);
    const withLive = {
      ...gmView,
      future: 1,
      elements: gmView.elements.map((e) => ({ ...e, shown: true, reason: "show_when_false" })),
    };
    const parsed = FaceLayoutViewSchema.parse(withLive);
    expect(parsed).toEqual(gmView);
    for (const e of parsed.elements) expect("shown" in e).toBe(false);
  });

  test("a malformed element fails", () => {
    const bad: unknown[] = [
      { elements: [{ type: "value", rect: [0, 0, 1, 1], index: 0 }] },
      { elements: [{ type: "button", rect: [0, 0, 1, 1], index: 0 }] },
      { elements: [{ type: "value", cell: "hp", rect: [0, 0, 1], index: 0 }] },
      { elements: [{ type: "value", cell: "hp", rect: [0, 0, 1, 1], index: -1 }] },
      { elements: [{ type: "sticker", rect: [0, 0, 1, 1], index: 0 }] },
    ];
    for (const face of bad) expect(FaceLayoutViewSchema.safeParse(face).success).toBe(false);
  });

  test("face is a known field effect, not dropped as an unknown variant", () => {
    expect(FIELD_EFFECT_FIELDS).toContain("face");
    expect(EFFECT_VIEW_TYPES).toContain("field");
    expect(
      unknownEffectVariant({
        type: "field",
        object: "x",
        field: "face",
        before: null,
        after: null,
      }),
    ).toBeNull();
  });

  test("snapshots take a face, null, or none", () => {
    const snap = {
      id: "card1",
      is_template: false,
      is_zone: false,
      is_character: false,
      cells: {},
      actions: [],
    };
    expect(ObjectSnapshotViewSchema.parse({ ...snap, face: gmView })).toEqual({
      ...snap,
      face: gmView,
    });
    expect(ObjectSnapshotViewSchema.parse({ ...snap, face: null })).toEqual({
      ...snap,
      face: null,
    });
    expect(ObjectSnapshotViewSchema.parse(snap)).toEqual(snap);
  });
});

describe("group views with faces round-trip through parseResult", () => {
  const snapshot = (face: FaceLayoutView) => ({
    id: "card1",
    is_template: false,
    is_zone: false,
    is_character: false,
    cells: {},
    actions: [{ name: "Roll" }],
    face,
  });

  const group = (index: number, face: FaceLayoutView, label: string | null) => ({
    index,
    revision: index + 1,
    actor: { type: "gm" },
    kind: "edit",
    label,
    base_revision: index,
    undone: false,
    names: {},
    effects: [
      { type: "field", object: "card1", field: "face", before: null, after: face },
      { type: "field", object: "card1", field: "face", before: face, after: null },
      { type: "create", location: { type: "board", board: "map" }, objects: [snapshot(face)] },
      { type: "remove", location: { type: "board", board: "map" }, objects: [snapshot(face)] },
    ],
  });

  const cases: [string, FaceLayoutView, string | null][] = [
    ["GM", gmView, "set_face card1"],
    ["character", characterView, null],
  ];

  test.each(cases)("%s: changes_since and log, indices preserved, no shown", (_, face, label) => {
    const changes = {
      revision: 9,
      floor: 0,
      groups: [group(3, face, label), group(4, face, label)],
      truncated: false,
      more: false,
      next_revision: 9,
    };
    expect(parseResult("changes_since", changes)).toEqual({
      ok: true,
      value: changes,
      warnings: [],
    });
    const log = { first_index: 0, next_index: 5, undo_barrier: 0, groups: [group(4, face, label)] };
    expect(parseResult("log", log)).toEqual({ ok: true, value: log, warnings: [] });

    // Live state added by a careless server is stripped, indices kept.
    const live = structuredClone(log);
    const effects = live.groups[0]?.effects ?? [];
    const after = (effects[0] as { after: FaceLayoutView }).after;
    for (const e of after.elements) Object.assign(e, { shown: true });
    const parsed = parseResult("log", live);
    expect(parsed.ok && parsed.value).toEqual(log);
  });

  test("a face effect with an element missing its index fails the result", () => {
    const bad = structuredClone(group(3, gmView, "x"));
    const after = (bad.effects[0] as { after: { elements: Record<string, unknown>[] } }).after;
    delete after.elements[1]?.index;
    const result = { first_index: 0, next_index: 4, undo_barrier: 0, groups: [bad] };
    expect(parseResult("log", result).ok).toBe(false);
  });
});

describe("when_selected on contents elements (M6-D12)", () => {
  const listed: FaceLayout = {
    elements: [
      { type: "value", cell: "name", rect: [-1, -1, 2, 0.4] },
      { type: "contents", rect: [-1.5, 0.9, 3, 1.2], min_size: 24, when_selected: true },
    ],
    collapsed: [{ type: "contents", rect: [0, 0, 1, 0.6], when_selected: false }],
  };
  const live = {
    elements: listed.elements.map((e, index) => ({ ...e, index, shown: true })),
    collapsed: [
      { type: "contents", rect: [0, 0, 1, 0.6], when_selected: false, index: 0, shown: true },
    ],
  };

  test("set_face and ObjectInit carry it unchanged; a non-boolean is refused", () => {
    const op: WireOp = { type: "set_face", object: "tok", face: listed };
    expect(WireOpSchema.parse(op)).toEqual(op);
    expect(ObjectInitSchema.parse({ face: listed })).toEqual({ face: listed });
    for (const bad of ["true", 1, null]) {
      const face = { elements: [{ type: "contents", rect: [0, 0, 1, 1], when_selected: bad }] };
      expect(WireOpSchema.safeParse({ type: "set_face", object: "tok", face }).success).toBe(false);
    }
    const onValue = {
      elements: [{ type: "value", cell: "hp", rect: [0, 0, 1, 1], when_selected: true }],
    };
    expect(WireOpSchema.safeParse({ type: "set_face", object: "tok", face: onValue }).success).toBe(
      false,
    );
  });

  test("live object views keep it: FaceElementView and every live-view result", () => {
    for (const e of [...live.elements, ...live.collapsed]) {
      expect(FaceElementViewSchema.parse(e)).toEqual(e);
    }
    const v = {
      id: "tok",
      is_template: false,
      is_character: false,
      cells: {},
      actions: [],
      action_states: [],
      face: live,
    };
    const subscribe = { subscription: "s1", revision: 3, objects: [v], covers: [] };
    expect(parseResult("subscribe", subscribe)).toEqual({
      ok: true,
      value: subscribe,
      warnings: [],
    });
    const got = { revision: 3, objects: [v], missing: [] };
    expect(parseResult("get_objects", got)).toEqual({ ok: true, value: got, warnings: [] });
  });

  test("historical faces keep it: FaceLayoutView and a face field effect", () => {
    const history: FaceLayoutView = {
      elements: listed.elements.map((e, index) => ({ ...e, index })),
      collapsed: [{ type: "contents", rect: [0, 0, 1, 0.6], when_selected: false, index: 0 }],
    };
    expect(FaceLayoutViewSchema.parse(history)).toEqual(history);
    const log = {
      first_index: 0,
      next_index: 1,
      undo_barrier: 0,
      groups: [
        {
          index: 0,
          revision: 1,
          actor: { type: "gm" },
          kind: "edit",
          label: "set_face tok",
          base_revision: 0,
          undone: false,
          names: {},
          effects: [{ type: "field", object: "tok", field: "face", before: null, after: history }],
        },
      ],
    };
    expect(parseResult("log", log)).toEqual({ ok: true, value: log, warnings: [] });
  });
});
