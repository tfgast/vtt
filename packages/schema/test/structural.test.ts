import {
  bool,
  EMPTY,
  isStructuralLiteral,
  list,
  num,
  ref,
  STRUCTURAL_CELLS,
  shape,
  structuralCell,
  structuralDefault,
  type TableObject,
  text,
  type Value,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";

const viewersAll: Value = { type: "viewers", viewers: ["all"] };

/** The default table of the bead, which is FORMULAS §3.1's Default column. */
const DEFAULTS: Record<string, Value | "allocated"> = {
  id: "allocated",
  name: EMPTY,
  tag: list([]),
  visible_to: viewersAll,
  owner: EMPTY,
  template: EMPTY,
  contents: list([]),
  container: EMPTY,
  board: EMPTY,
  position: EMPTY,
  rotation: EMPTY,
  z: EMPTY,
  face_up: bool(true),
  opaque: bool(false),
  is_zone: bool(false),
  shape: EMPTY,
};

const bare: TableObject = {
  id: "thing",
  is_template: false,
  is_zone: false,
  is_character: false,
  tag: [],
  shape: null,
  board: null,
  contents: [],
  cells: {},
  cell_visibility: {},
  actions: [],
};

describe("STRUCTURAL_CELLS", () => {
  test("has one entry per FORMULAS §3.1 cell, with the default table", () => {
    expect(STRUCTURAL_CELLS.map((s) => s.name).sort()).toEqual(Object.keys(DEFAULTS).sort());
    for (const spec of STRUCTURAL_CELLS) {
      const want = DEFAULTS[spec.name];
      if (want === "allocated") {
        expect(spec.default, spec.name).toBeUndefined();
      } else {
        expect(spec.default, spec.name).toEqual(want);
        expect(structuralDefault(spec.name, bare), spec.name).toEqual(want);
      }
    }
  });

  test("storage", () => {
    const by = (storage: string) =>
      STRUCTURAL_CELLS.filter((s) => s.storage === storage)
        .map((s) => s.name)
        .sort();
    expect(by("field")).toEqual(["board", "contents", "id", "is_zone", "shape", "tag"]);
    expect(by("derived")).toEqual(["container"]);
    expect(by("cell")).toEqual(
      [
        "face_up",
        "name",
        "opaque",
        "owner",
        "position",
        "rotation",
        "template",
        "visible_to",
        "z",
      ].sort(),
    );
  });

  test("protection", () => {
    const prot = Object.fromEntries(STRUCTURAL_CELLS.map((s) => [s.name, s.protection]));
    expect(prot).toEqual({
      id: "full",
      board: "full",
      is_zone: "full",
      contents: "membership",
      container: "derived",
      shape: "edit_only",
      name: "none",
      tag: "none",
      visible_to: "none",
      owner: "none",
      template: "none",
      position: "none",
      rotation: "none",
      z: "none",
      face_up: "none",
      opaque: "none",
    });
  });

  test("formulas allowed on every cell-stored structural cell except template and name", () => {
    const allowed = STRUCTURAL_CELLS.filter((s) => s.formula)
      .map((s) => s.name)
      .sort();
    expect(allowed).toEqual(
      ["face_up", "opaque", "owner", "position", "rotation", "visible_to", "z"].sort(),
    );
    for (const name of ["template", "tag", "name", "shape", "id", "container"]) {
      expect(structuralCell(name)?.formula, name).toBe(false);
    }
  });

  test("shape reads as a shape value; everything else as its literal", () => {
    for (const spec of STRUCTURAL_CELLS) {
      expect(spec.reads, spec.name).toBe(spec.name === "shape" ? "shape" : "value");
    }
  });

  test("structuralCell looks up by name and ignores prototype names", () => {
    expect(structuralCell("position")?.name).toBe("position");
    expect(structuralCell("hp")).toBeUndefined();
    expect(structuralCell("constructor")).toBeUndefined();
    expect(structuralCell("__proto__")).toBeUndefined();
  });
});

describe("isStructuralLiteral", () => {
  const ok = (name: string, v: Value) => {
    const spec = structuralCell(name);
    if (!spec) throw new Error(name);
    return isStructuralLiteral(spec, v);
  };

  test("type-checks each cell", () => {
    expect(ok("name", text("Goblin"))).toBe(true);
    expect(ok("name", num(1))).toBe(false);
    expect(ok("visible_to", viewersAll)).toBe(true);
    expect(ok("visible_to", list([]))).toBe(false);
    expect(ok("owner", ref("aldric"))).toBe(true);
    expect(ok("owner", EMPTY)).toBe(true);
    expect(ok("owner", text("aldric"))).toBe(false);
    expect(ok("template", ref("goblin"))).toBe(true);
    expect(ok("face_up", bool(false))).toBe(true);
    expect(ok("face_up", num(1))).toBe(false);
    expect(ok("opaque", bool(true))).toBe(true);
    expect(ok("rotation", num(90))).toBe(true);
    expect(ok("rotation", EMPTY)).toBe(true);
    expect(ok("z", text("1"))).toBe(false);
    expect(ok("position", list([num(1), num(2)]))).toBe(true);
    expect(ok("position", list([num(1)]))).toBe(false);
    expect(ok("position", list([num(1), text("2")]))).toBe(false);
    expect(ok("position", list([num(1), num(2), num(3)]))).toBe(false);
    expect(ok("tag", list([text("a")]))).toBe(true);
    expect(ok("tag", list([num(1)]))).toBe(false);
    expect(ok("contents", list([ref("a")]))).toBe(true);
    expect(ok("shape", shape({ type: "circle", radius: 1 }))).toBe(true);
    expect(ok("shape", EMPTY)).toBe(true);
    expect(ok("is_zone", bool(true))).toBe(true);
    expect(ok("id", text("goblin"))).toBe(true);
  });
});

describe("structuralDefault", () => {
  test("reads field-backed cells from the object", () => {
    const zone: TableObject = {
      ...bare,
      id: "fb_zone",
      is_zone: true,
      tag: ["zone"],
      shape: { type: "circle", radius: 4 },
      board: "map",
      contents: ["a", "b"],
    };
    expect(structuralDefault("id", zone)).toEqual(text("fb_zone"));
    expect(structuralDefault("tag", zone)).toEqual(list([text("zone")]));
    expect(structuralDefault("shape", zone)).toEqual(shape({ type: "circle", radius: 4 }));
    expect(structuralDefault("is_zone", zone)).toEqual(bool(true));
    expect(structuralDefault("board", zone)).toEqual(ref("map"));
    expect(structuralDefault("contents", zone)).toEqual(list([ref("a"), ref("b")]));
  });

  test("returns a fresh value each time", () => {
    const a = structuralDefault("visible_to", bare);
    const b = structuralDefault("visible_to", bare);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
