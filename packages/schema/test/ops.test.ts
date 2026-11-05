import {
  type Actor,
  ActorSchema,
  type Effect,
  EffectSchema,
  type Location,
  LocationSchema,
  num,
  type OpGroup,
  OpGroupSchema,
  type Rejection,
  RejectionSchema,
  type RollValue,
  ref,
  text,
  toFixtureReason,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { at, formula, lit, obj } from "./helpers";

/** Parse a JSON copy, so the input shares nothing with the expectation. */
const roundTrip = <T>(schema: z.ZodType<T>, x: T): T => schema.parse(JSON.parse(JSON.stringify(x)));

const onMap: Location = { type: "board", board: "map" };
const inBag: Location = { type: "container", container: "bag", index: 2 };

const roll: RollValue = {
  type: "roll",
  expr: "8d6",
  dice: [3, 5, 2, 6, 4, 1, 6, 1],
  dropped: [],
  total: 28,
};

/** One hand-written example of every effect kind (and every field variant). */
const effects: Record<string, Effect> = {
  cell_edit: {
    type: "cell",
    object: "goblin1",
    cell: "damage_taken",
    before: lit(num(0)),
    after: lit(num(14)),
    cause: "edit",
  },
  cell_create: {
    type: "cell",
    object: "goblin1",
    cell: "notes",
    before: null,
    after: lit(text("bloodied")),
    cause: "edit",
  },
  cell_override: {
    type: "cell",
    object: "goblin1",
    cell: "hp",
    before: formula("max_hp - damage_taken"),
    after: { content: { type: "formula", source: "max_hp - damage_taken" }, override: num(4) },
    cause: "edit",
  },
  cell_roll: {
    type: "cell",
    object: "fb1",
    cell: "damage",
    before: lit({ type: "empty" }),
    after: lit(roll),
    cause: "roll",
  },
  cell_delete: {
    type: "cell",
    object: "goblin1",
    cell: "notes",
    before: lit(text("bloodied")),
    after: null,
    cause: "edit",
  },
  cell_visibility: {
    type: "cell_visibility",
    object: "goblin1",
    cell: "ac",
    before: null,
    after: { type: "viewers", viewers: ["gm", ref("aldric")] },
  },
  field_tag: {
    type: "field",
    object: "goblin1",
    field: "tag",
    before: ["creature"],
    after: ["creature", "goblin"],
  },
  field_shape: {
    type: "field",
    object: "goblin1",
    field: "shape",
    before: null,
    after: { type: "circle", radius: 0.5 },
  },
  field_is_template: {
    type: "field",
    object: "goblin1",
    field: "is_template",
    before: false,
    after: true,
  },
  field_is_character: {
    type: "field",
    object: "goblin1",
    field: "is_character",
    before: true,
    after: false,
  },
  place: { type: "place", object: "coin", before: inBag, after: onMap },
  create: {
    type: "create",
    objects: [
      obj("fireball_7", {
        tag: ["card"],
        contents: ["fireball_zone_8"],
        cells: { template: lit(ref("fireball")), caster: lit(ref("aldric")) },
      }),
      obj("fireball_zone_8", {
        is_zone: true,
        shape: { type: "circle", radius: 4 },
        cell_visibility: { name: { type: "viewers", viewers: ["owner"] } },
      }),
    ],
    location: inBag,
  },
  remove: {
    type: "remove",
    objects: [obj("goblin3", { board: "map", cells: { position: at(16, 10) } })],
    location: onMap,
  },
  reorder: {
    type: "reorder",
    container: "deck",
    before: ["c1", "c2", "c3"],
    after: ["c3", "c1", "c2"],
  },
  board_create: { type: "board", before: null, after: { id: "cellar", name: "Cellar" } },
  board_rename: { type: "board", before: { id: "map" }, after: { id: "map", name: "Map" } },
  board_remove: { type: "board", before: { id: "cellar" }, after: null },
  allocate: {
    type: "allocate",
    ids: ["fireball_7", "fireball_zone_8"],
    seq_before: 7,
    seq_after: 9,
  },
  retire: { type: "retire", ids: ["fireball_7", "fireball_zone_8"] },
};

describe("EffectSchema", () => {
  test.each(Object.entries(effects))("round-trips %s", (_, e) => {
    expect(roundTrip(EffectSchema, e)).toEqual(e);
  });

  test("covers every effect kind", () => {
    const kinds = new Set(Object.values(effects).map((e) => e.type));
    expect([...kinds].sort()).toEqual(
      [
        "allocate",
        "board",
        "cell",
        "cell_visibility",
        "create",
        "field",
        "place",
        "remove",
        "reorder",
        "retire",
      ].sort(),
    );
  });

  test.each(Object.entries(effects))("rejects an unknown key on %s", (_, e) => {
    expect(EffectSchema.safeParse({ ...e, extra: 1 }).success).toBe(false);
  });

  test("rejects unknown keys in nested locations, objects and boards", () => {
    const place = { ...effects.place, after: { ...onMap, position: [0, 0] } };
    expect(EffectSchema.safeParse(place).success).toBe(false);
    const create = JSON.parse(JSON.stringify(effects.create));
    create.objects[0].container = null;
    expect(EffectSchema.safeParse(create).success).toBe(false);
    const board = { ...effects.board_create, after: { id: "cellar", colour: "grey" } };
    expect(EffectSchema.safeParse(board).success).toBe(false);
    const cell = { ...effects.cell_edit, after: { content: num(1), stale: true } };
    expect(EffectSchema.safeParse(cell).success).toBe(false);
  });

  test("rejects an unknown type, cause or field", () => {
    expect(EffectSchema.safeParse({ type: "rename", object: "a" }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...effects.cell_edit, cause: "undo" }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...effects.field_tag, field: "board" }).success).toBe(false);
  });

  test("field values must match the field", () => {
    expect(EffectSchema.safeParse({ ...effects.field_tag, after: "goblin" }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...effects.field_is_template, after: 1 }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...effects.field_shape, after: ["creature"] }).success).toBe(
      false,
    );
  });

  test("cell states hold a cell or null, never undefined", () => {
    const { before: _, ...missing } = effects.cell_create as Record<string, unknown>;
    expect(EffectSchema.safeParse(missing).success).toBe(false);
    expect(
      EffectSchema.safeParse({ ...effects.cell_edit, after: { content: { type: "error" } } })
        .success,
    ).toBe(false);
  });

  test("cell visibility holds a viewers value or null", () => {
    const e = { ...effects.cell_visibility, after: text("gm") };
    expect(EffectSchema.safeParse(e).success).toBe(false);
  });

  test("rejects a __proto__ cell inside a created object", () => {
    const json = JSON.stringify(effects.create).replace('"cells":{', '"cells":{"__proto__":{},');
    expect(EffectSchema.safeParse(JSON.parse(json)).success).toBe(false);
  });
});

describe("LocationSchema", () => {
  test("round-trips both kinds", () => {
    expect(roundTrip(LocationSchema, onMap)).toEqual(onMap);
    expect(roundTrip(LocationSchema, inBag)).toEqual(inBag);
  });

  test("a container index is a non-negative integer", () => {
    expect(LocationSchema.safeParse({ ...inBag, index: -1 }).success).toBe(false);
    expect(LocationSchema.safeParse({ ...inBag, index: 0.5 }).success).toBe(false);
    expect(LocationSchema.safeParse({ type: "container", container: "bag" }).success).toBe(false);
  });
});

describe("ActorSchema", () => {
  const actors: Actor[] = [
    { type: "gm" },
    { type: "character", id: "aldric" },
    { type: "agent" },
    { type: "agent", name: "claude" },
  ];

  test.each(actors)("round-trips %o", (a) => {
    expect(roundTrip(ActorSchema, a)).toEqual(a);
  });

  test("rejects unknown keys and kinds", () => {
    expect(ActorSchema.safeParse({ type: "gm", name: "Theo" }).success).toBe(false);
    expect(ActorSchema.safeParse({ type: "character" }).success).toBe(false);
    expect(ActorSchema.safeParse({ type: "player", id: "theo" }).success).toBe(false);
  });
});

describe("OpGroupSchema", () => {
  const action: OpGroup = {
    index: 12,
    base_revision: 30,
    revision: 31,
    actor: { type: "character", id: "aldric" },
    kind: "action",
    label: "Roll damage",
    origin: { object: "fb1", action: "Roll damage" },
    names: { fb1: "Fireball" },
    effects: [effects.cell_roll as Effect],
  };
  const spawn: OpGroup = {
    index: 13,
    base_revision: 31,
    revision: 32,
    actor: { type: "gm" },
    kind: "edit",
    label: "Spawn Fireball",
    names: { fireball_7: "Fireball", fireball_zone_8: "Fireball area", bag: "Bag" },
    effects: [effects.allocate as Effect, effects.create as Effect],
  };
  const undo: OpGroup = {
    index: 14,
    base_revision: 32,
    revision: 33,
    actor: { type: "agent", name: "claude" },
    kind: "undo",
    label: "Undo Spawn Fireball",
    undoes: 13,
    names: { fireball_7: "Fireball", fireball_zone_8: "Fireball area", bag: "Bag" },
    effects: [
      { ...(effects.create as Extract<Effect, { type: "create" }>), type: "remove" },
      effects.retire as Effect,
    ],
  };
  const empty: OpGroup = {
    index: 15,
    base_revision: 33,
    revision: 34,
    actor: { type: "gm" },
    kind: "edit",
    label: "Nothing",
    names: {},
    effects: [],
  };

  test.each([action, spawn, undo, empty])("round-trips group $index", (g) => {
    expect(roundTrip(OpGroupSchema, g)).toEqual(g);
  });

  test("rejects unknown keys on the group and its origin", () => {
    expect(OpGroupSchema.safeParse({ ...action, timestamp: 1 }).success).toBe(false);
    const origin = { ...action, origin: { ...action.origin, step: 0 } };
    expect(OpGroupSchema.safeParse(origin).success).toBe(false);
  });

  test("rejects a bad kind, a negative index and a fractional revision", () => {
    expect(OpGroupSchema.safeParse({ ...action, kind: "redo" }).success).toBe(false);
    expect(OpGroupSchema.safeParse({ ...action, index: -1 }).success).toBe(false);
    expect(OpGroupSchema.safeParse({ ...action, revision: 31.5 }).success).toBe(false);
  });

  test("rejects a __proto__ key in names", () => {
    const json = JSON.stringify(action).replace('"names":{', '"names":{"__proto__":"x",');
    expect(OpGroupSchema.safeParse(JSON.parse(json)).success).toBe(false);
  });
});

/** One hand-written example of every rejection kind. */
const rejections: Record<string, Rejection> = {
  protected_cell: { type: "protected_cell", object: "goblin1", cell: "container" },
  containment_cycle: { type: "containment_cycle", object: "bag", container: "pouch" },
  undo_conflict: {
    type: "undo_conflict",
    target: 3,
    conflicting: [5, 7],
    message: "goblin1.damage_taken was changed later by Apply all",
  },
  nothing_to_undo: { type: "nothing_to_undo" },
  type_error: { type: "type_error", object: "goblin1", cell: "position", expected: "point" },
  invalid: { type: "invalid", message: "no object goblin9" },
};

describe("RejectionSchema", () => {
  test.each(Object.entries(rejections))("round-trips %s", (_, r) => {
    expect(roundTrip(RejectionSchema, r)).toEqual(r);
  });

  test.each(Object.entries(rejections))("rejects an unknown key on %s", (_, r) => {
    expect(RejectionSchema.safeParse({ ...r, extra: 1 }).success).toBe(false);
  });

  test("rejects an unknown type", () => {
    expect(RejectionSchema.safeParse({ type: "not_a_rejection" }).success).toBe(false);
  });
});

describe("toFixtureReason", () => {
  // The mapping onto FIXTURES.md §6 rejection reasons. `type_error` is the
  // M5 step error `#TYPE`; `invalid` (unknown object, bad index, retired id)
  // is a scenario error in the fixture format, not a rejection, so it has no
  // reason.
  test.each<[string, ReturnType<typeof toFixtureReason>]>([
    ["protected_cell", { type: "protected_cell" }],
    ["containment_cycle", { type: "containment_cycle" }],
    ["undo_conflict", { type: "undo_conflict" }],
    ["nothing_to_undo", { type: "nothing_to_undo" }],
    ["type_error", { type: "step_error", code: "#TYPE" }],
    ["invalid", null],
  ])("%s maps to %o", (kind, reason) => {
    expect(toFixtureReason(rejections[kind] as Rejection)).toEqual(reason);
  });
});
