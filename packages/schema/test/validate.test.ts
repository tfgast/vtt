import {
  bool,
  EMPTY,
  list,
  num,
  ref,
  type Snapshot,
  text,
  type Value,
  type ViewerEntry,
  type ViewersValue,
  type ViolationKind,
  validateSnapshot,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, fireballSnapshot, formula, get, lit, obj, snapshot } from "./helpers";

const kinds = (s: Snapshot): ViolationKind[] => validateSnapshot(s).map((v) => v.kind);

/** A token on the map: the smallest valid object. */
const token = (id: string, cells: Snapshot["objects"][string]["cells"] = {}) =>
  obj(id, { board: "map", cells: { position: at(0, 0), ...cells } });

const viewers = (...v: ViewerEntry[]): ViewersValue => ({ type: "viewers", viewers: v });

describe("valid snapshots", () => {
  test("an empty document", () => {
    expect(validateSnapshot(snapshot([]))).toEqual([]);
  });

  test("the fireball setup", () => {
    expect(validateSnapshot(fireballSnapshot())).toEqual([]);
  });

  test("live objects and boards whose ids are retired (restored by undo)", () => {
    const s = snapshot([token("coin")], { retired_ids: ["coin", "map", "goblin_2"], next_seq: 3 });
    expect(validateSnapshot(s)).toEqual([]);
  });

  test("dangling references inside values", () => {
    const s = snapshot([
      token("coin", {
        owner: lit(ref("gone")),
        target: lit(list([ref("gone2")])),
        visible_to: lit(viewers({ type: "ref", object: "gone3" })),
      }),
    ]);
    get(s, "coin").cell_visibility = { hp: viewers({ type: "ref", object: "gone4" }) };
    expect(validateSnapshot(s)).toEqual([]);
  });

  test("structural cells with formulas, overrides and empty values", () => {
    const s = snapshot([
      obj("room", {
        is_zone: true,
        board: "map",
        shape: { type: "rect", width: 2, height: 3 },
        cells: {
          position: {
            content: { type: "formula", source: "leader.position" },
            override: list([num(1), num(2)]),
          },
          visible_to: { content: { type: "formula", source: "owner" }, override: viewers("gm") },
          face_up: { content: { type: "formula", source: "x" }, override: bool(false) },
          opaque: lit(bool(true)),
          rotation: lit(EMPTY),
          z: formula("1"),
          owner: lit(EMPTY),
          template: lit(ref("room_t")),
          hp: { content: { type: "formula", source: "x" }, override: text("anything") },
        },
        cell_visibility: {
          contents: viewers("gm"),
          tag: viewers("all"),
          whatever: viewers("owner"),
        },
      }),
    ]);
    expect(validateSnapshot(s)).toEqual([]);
  });

  test("cell names that are prototype properties or not identifiers", () => {
    const s = snapshot([token("coin", { constructor: lit(num(1)), "Max HP": lit(num(2)) })]);
    expect(validateSnapshot(s)).toEqual([]);
  });
});

describe("ids", () => {
  test("an invalid or reserved object id", () => {
    expect(kinds(snapshot([token("1coin")]))).toEqual(["invalid_id"]);
    expect(kinds(snapshot([token("gm")]))).toEqual(["invalid_id"]);
  });

  test("an invalid board id", () => {
    expect(kinds(snapshot([], { boards: [{ id: "all" }] }))).toEqual(["invalid_id"]);
  });

  test("an invalid retired id", () => {
    expect(kinds(snapshot([], { retired_ids: ["owner"] }))).toEqual(["invalid_id"]);
  });

  test("two boards share an id", () => {
    expect(kinds(snapshot([], { boards: [{ id: "map" }, { id: "map" }] }))).toEqual([
      "duplicate_id",
    ]);
  });

  test("a board and an object share an id", () => {
    const s = snapshot([
      token("coin"),
      obj("map", { board: "map", cells: { position: at(1, 1) } }),
    ]);
    expect(kinds(s)).toEqual(["duplicate_id"]);
  });

  test("an object-map key differs from the object's id", () => {
    const s = snapshot([token("coin")]);
    s.objects = { penny: get(s, "coin") };
    expect(kinds(s)).toEqual(["object_key_mismatch"]);
  });

  test("two map entries hold objects with the same id", () => {
    const s = snapshot([token("coin")]);
    s.objects = { coin: get(s, "coin"), penny: token("coin") };
    expect(kinds(s).sort()).toEqual(["duplicate_id", "object_key_mismatch"]);
  });

  test("a duplicate retired id", () => {
    expect(kinds(snapshot([], { retired_ids: ["goblin_1", "goblin_1"] }))).toEqual([
      "duplicate_retired_id",
    ]);
  });

  test("next_seq is a non-negative integer", () => {
    for (const next_seq of [-1, 1.5, Number.NaN, Infinity]) {
      expect(kinds(snapshot([], { next_seq })), String(next_seq)).toEqual(["invalid_next_seq"]);
    }
  });
});

describe("stored cells", () => {
  for (const name of [
    "id",
    "tag",
    "contents",
    "container",
    "board",
    "shape",
    "is_zone",
    "is_template",
    "is_character",
  ]) {
    test(`a stored cell named ${name}`, () => {
      expect(kinds(snapshot([token("coin", { [name]: lit(EMPTY) })]))).toEqual(["field_cell"]);
    });
  }

  test("__proto__ or the empty string as a cell name", () => {
    const s = snapshot([token("coin")]);
    get(s, "coin").cells = JSON.parse(
      '{"position": {"content": {"type": "list", "items": [{"type": "number", "value": 0}, {"type": "number", "value": 0}]}}, "__proto__": {"content": {"type": "empty"}}, "": {"content": {"type": "empty"}}}',
    );
    expect(kinds(s)).toEqual(["invalid_cell_name", "invalid_cell_name"]);
  });

  test("an override on a literal cell", () => {
    expect(kinds(snapshot([token("coin", { hp: { content: num(3), override: num(4) } })]))).toEqual(
      ["override_on_literal"],
    );
  });

  test("a position override that is not two finite numbers", () => {
    for (const override of [list([num(1)]), list([num(1), text("2")]), num(3), EMPTY]) {
      const s = snapshot([
        obj("coin", {
          board: "map",
          cells: { position: { content: { type: "formula", source: "x" }, override } },
        }),
      ]);
      expect(kinds(s)).toEqual(["structural_type"]);
    }
  });

  test("a face_up override that is not a boolean", () => {
    const s = snapshot([
      token("coin", { face_up: { content: { type: "formula", source: "x" }, override: num(1) } }),
    ]);
    expect(kinds(s)).toEqual(["structural_type"]);
  });

  test("a visible_to override that is not a viewers value", () => {
    const s = snapshot([
      token("coin", {
        visible_to: { content: { type: "formula", source: "x" }, override: ref("a") },
      }),
    ]);
    expect(kinds(s)).toEqual(["structural_type"]);
  });

  test("literal structural cells type-check", () => {
    const bad: Record<string, Value> = {
      name: num(1),
      visible_to: text("all"),
      owner: text("aldric"),
      template: list([]),
      face_up: text("yes"),
      opaque: num(0),
      rotation: text("90"),
      z: bool(true),
      position: list([num(0), num(0), num(0)]),
    };
    for (const [name, value] of Object.entries(bad)) {
      const cells = { [name]: lit(value) };
      const o =
        name === "position"
          ? obj("coin", { board: "map", is_zone: true, cells })
          : obj("coin", { board: "map", is_zone: true, cells: { position: at(0, 0), ...cells } });
      expect(kinds(snapshot([o])), name).toEqual(["structural_type"]);
    }
  });

  test("a formula name", () => {
    expect(kinds(snapshot([token("coin", { name: formula('"Coin"') })]))).toEqual([
      "formula_not_allowed",
    ]);
  });

  test("a formula template", () => {
    expect(kinds(snapshot([token("coin", { template: formula('obj("coin_t")') })]))).toEqual([
      "formula_not_allowed",
    ]);
  });

  test("opaque on an object that is not a zone", () => {
    expect(kinds(snapshot([token("coin", { opaque: lit(bool(true)) })]))).toEqual([
      "opaque_not_zone",
    ]);
    expect(kinds(snapshot([token("coin", { opaque: formula("true") })]))).toEqual([
      "opaque_not_zone",
    ]);
  });
});

describe("cell visibility", () => {
  test("an empty viewers value", () => {
    const s = snapshot([token("coin")]);
    get(s, "coin").cell_visibility = { hp: { type: "viewers", viewers: [] } };
    expect(kinds(s)).toEqual(["invalid_cell_visibility"]);
  });

  test("a value that is not a viewers value", () => {
    const s = snapshot([token("coin")]);
    get(s, "coin").cell_visibility = { hp: text("gm") as never };
    expect(kinds(s)).toEqual(["invalid_cell_visibility"]);
  });

  test("__proto__ as a key", () => {
    const s = snapshot([token("coin")]);
    const vis = JSON.parse('{"__proto__": {"type": "viewers", "viewers": ["gm"]}}');
    get(s, "coin").cell_visibility = vis;
    expect(kinds(s)).toEqual(["invalid_cell_name"]);
  });
});

describe("placement and containment", () => {
  test("an object neither on a board nor in a container", () => {
    expect(kinds(snapshot([obj("coin")]))).toEqual(["placement"]);
  });

  test("an object on a board and in a container", () => {
    const s = snapshot([token("bag"), token("coin")]);
    get(s, "bag").contents = ["coin"];
    expect(kinds(s)).toEqual(["placement"]);
  });

  test("an object in two containers", () => {
    const s = snapshot([
      obj("bag", { board: "map", contents: ["coin"], cells: { position: at(0, 0) } }),
      obj("box", { board: "map", contents: ["coin"], cells: { position: at(1, 0) } }),
      obj("coin"),
    ]);
    expect(kinds(s)).toEqual(["placement"]);
  });

  test("an object listed twice in one contents", () => {
    const s = snapshot([
      obj("bag", { board: "map", contents: ["coin", "coin"], cells: { position: at(0, 0) } }),
      obj("coin"),
    ]);
    expect(kinds(s)).toEqual(["placement"]);
  });

  test("a containment cycle", () => {
    const s = snapshot([obj("a", { contents: ["b"] }), obj("b", { contents: ["a"] })]);
    expect(kinds(s)).toEqual(["containment_cycle"]);
  });

  test("an object containing itself", () => {
    expect(kinds(snapshot([obj("a", { contents: ["a"] })]))).toEqual(["containment_cycle"]);
  });

  test("contents naming a missing object", () => {
    const s = snapshot([
      obj("bag", { board: "map", contents: ["ghost"], cells: { position: at(0, 0) } }),
    ]);
    expect(kinds(s)).toEqual(["unknown_object"]);
  });

  test("contents naming a board", () => {
    const s = snapshot([
      obj("bag", { board: "map", contents: ["map"], cells: { position: at(0, 0) } }),
    ]);
    expect(kinds(s)).toEqual(["unknown_object"]);
  });

  test("a board that does not exist", () => {
    const s = snapshot([
      token("coin"),
      obj("bag", { board: "coin", cells: { position: at(0, 0) } }),
    ]);
    expect(kinds(s)).toEqual(["unknown_board"]);
  });

  test("an object on a board without a position", () => {
    expect(kinds(snapshot([obj("coin", { board: "map" })]))).toEqual(["placement_cell"]);
  });

  for (const name of ["position", "rotation", "z"]) {
    test(`${name} on an object in a container`, () => {
      const s = snapshot([
        obj("bag", { board: "map", contents: ["coin"], cells: { position: at(0, 0) } }),
        obj("coin", { cells: { [name]: name === "position" ? at(0, 0) : lit(num(0)) } }),
      ]);
      expect(kinds(s)).toEqual(["placement_cell"]);
    });
  }
});

describe("actions", () => {
  const withActions = (...names: string[]) =>
    kinds(
      snapshot([
        obj("coin", {
          board: "map",
          cells: { position: at(0, 0) },
          actions: names.map((name) => ({ name, steps: ["set(x, 1)"] })),
        }),
      ]),
    );

  test("distinct action names are valid", () => {
    expect(withActions("Roll", "Discard", "roll")).toEqual([]);
  });

  test("a duplicate action name", () => {
    expect(withActions("Roll", "Discard", "Roll")).toEqual(["duplicate_action"]);
  });
});

describe("shapes", () => {
  const withShape = (shape: unknown) =>
    kinds(
      snapshot([
        obj("coin", { board: "map", shape: shape as never, cells: { position: at(0, 0) } }),
      ]),
    );

  test("valid shapes", () => {
    expect(withShape({ type: "circle", radius: 0.5 })).toEqual([]);
    expect(withShape({ type: "rect", width: 1, height: 2 })).toEqual([]);
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ],
      }),
    ).toEqual([]);
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [4, 0],
          [4, 4],
          [2, 1],
          [0, 4],
        ],
      }),
    ).toEqual([]);
  });

  test("circle radius > 0", () => {
    expect(withShape({ type: "circle", radius: 0 })).toEqual(["invalid_shape"]);
    expect(withShape({ type: "circle", radius: -1 })).toEqual(["invalid_shape"]);
  });

  test("rect width and height > 0", () => {
    expect(withShape({ type: "rect", width: 0, height: 1 })).toEqual(["invalid_shape"]);
    expect(withShape({ type: "rect", width: 1, height: -2 })).toEqual(["invalid_shape"]);
  });

  test("polygon has at least three points", () => {
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toEqual(["invalid_shape"]);
  });

  test("polygon is simple", () => {
    // A bow tie crosses itself.
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [2, 2],
          [2, 0],
          [0, 2],
        ],
      }),
    ).toEqual(["invalid_shape"]);
    // All points on one line: adjacent edges overlap.
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      }),
    ).toEqual(["invalid_shape"]);
    // A repeated vertex.
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [1, 0],
          [0, 1],
        ],
      }),
    ).toEqual(["invalid_shape"]);
    // A vertex touching a non-adjacent edge.
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [4, 0],
          [4, 4],
          [2, 0],
          [0, 4],
        ],
      }),
    ).toEqual(["invalid_shape"]);
    // Doubling back along an edge.
    expect(
      withShape({
        type: "polygon",
        points: [
          [0, 0],
          [2, 0],
          [1, 0],
          [1, 1],
        ],
      }),
    ).toEqual(["invalid_shape"]);
  });
});

describe("reporting", () => {
  test("every violation is reported, with a path and a message", () => {
    const s = snapshot([obj("1x"), token("coin", { name: formula("x"), tag: lit(EMPTY) })], {
      next_seq: -1,
      retired_ids: ["a", "a"],
    });
    const vs = validateSnapshot(s);
    expect(vs.map((v) => v.kind).sort()).toEqual(
      [
        "duplicate_retired_id",
        "field_cell",
        "formula_not_allowed",
        "invalid_id",
        "invalid_next_seq",
        "placement",
      ].sort(),
    );
    for (const v of vs) {
      expect(Array.isArray(v.path)).toBe(true);
      expect(v.message.length).toBeGreaterThan(0);
    }
    expect(vs.find((v) => v.kind === "formula_not_allowed")?.path).toEqual([
      "objects",
      "coin",
      "cells",
      "name",
    ]);
  });
});
