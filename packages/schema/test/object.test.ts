import { type ActionDef, ActionDefSchema, type TableObject, TableObjectSchema } from "@vtt/schema";
import { describe, expect, test } from "vitest";

const goblin: TableObject = {
  id: "goblin1",
  is_template: false,
  is_zone: false,
  is_character: true,
  tag: ["creature", "goblin"],
  shape: { type: "circle", radius: 0.5 },
  board: "table",
  contents: ["goblin_die"],
  cells: {
    name: { content: { type: "text", value: "Goblin" } },
    position: {
      content: {
        type: "list",
        items: [
          { type: "number", value: 3 },
          { type: "number", value: 4 },
        ],
      },
    },
    hp: {
      content: { type: "formula", source: "max_hp - damage" },
      override: { type: "number", value: 2 },
    },
  },
  cell_visibility: { ac: { type: "viewers", viewers: ["gm"] } },
  actions: [{ name: "Roll", when: "value = empty", steps: ["roll(1d20) -> value"] }],
};

const parse = (x: unknown) => TableObjectSchema.safeParse(x);

describe("TableObjectSchema", () => {
  test("accepts a full object and round-trips through JSON", () => {
    expect(TableObjectSchema.parse(JSON.parse(JSON.stringify(goblin)))).toEqual(goblin);
  });

  test("rejects unknown keys and missing fields", () => {
    expect(parse({ ...goblin, note: "x" }).success).toBe(false);
    expect(parse({ ...goblin, container: "bag" }).success).toBe(false);
    const { tag: _tag, ...noTag } = goblin;
    expect(parse(noTag).success).toBe(false);
  });

  test("rejects __proto__ as a key in cells and cell_visibility", () => {
    const json = JSON.stringify(goblin);
    const withProtoCell = JSON.parse(json);
    withProtoCell.cells = JSON.parse('{"__proto__": {"content": {"type": "empty"}}}');
    expect(parse(withProtoCell).success).toBe(false);
    const withProtoVis = JSON.parse(json);
    withProtoVis.cell_visibility = JSON.parse(
      '{"__proto__": {"type": "viewers", "viewers": ["gm"]}}',
    );
    expect(parse(withProtoVis).success).toBe(false);
  });

  test("accepts prototype-like and non-identifier cell names", () => {
    const o = {
      ...goblin,
      cells: {
        constructor: { content: { type: "empty" } },
        "Max HP": { content: { type: "number", value: 7 } },
      },
    };
    expect(TableObjectSchema.parse(o)).toEqual(o);
  });

  test("rejects a bad cell or a non-viewers visibility", () => {
    expect(
      parse({ ...goblin, cells: { x: { content: { type: "error", code: "#REF" } } } }).success,
    ).toBe(false);
    expect(
      parse({ ...goblin, cell_visibility: { ac: { type: "text", value: "gm" } } }).success,
    ).toBe(false);
  });
});

describe("ActionDefSchema", () => {
  test("accepts name, optional when, source steps", () => {
    const a: ActionDef = { name: "Discard", steps: ["remove(zone)", "remove(this)"] };
    expect(ActionDefSchema.parse(a)).toEqual(a);
  });

  test("rejects blank source, an empty name and unknown keys", () => {
    expect(ActionDefSchema.safeParse({ name: "", steps: ["x"] }).success).toBe(false);
    expect(ActionDefSchema.safeParse({ name: "A", when: " ", steps: ["x"] }).success).toBe(false);
    expect(ActionDefSchema.safeParse({ name: "A", steps: [""] }).success).toBe(false);
    expect(ActionDefSchema.safeParse({ name: "A", steps: ["x"], label: "y" }).success).toBe(false);
  });

  test("keeps source text verbatim", () => {
    const a = { name: "A", when: " not locked ", steps: ["  set(x, 1)"] };
    expect(ActionDefSchema.parse(a)).toEqual(a);
  });
});
