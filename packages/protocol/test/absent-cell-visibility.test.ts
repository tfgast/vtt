/**
 * `ObjectView.absent_cell_visibility` (vtt-3l6.19; PROTOCOL.md §7.2 M4-D12,
 * §12): optional, loose like the rest of the view, `__proto__`-safe.
 */
import { type ObjectView, ObjectViewSchema, type WireViewers } from "@vtt/protocol";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const gmOnly: WireViewers = { type: "viewers", viewers: ["gm"] };

const view: ObjectView = {
  id: "chest",
  is_template: false,
  is_character: false,
  cells: { name: { value: { type: "text", value: "Chest" }, kind: "literal" } },
  actions: [],
};

describe("ObjectView.absent_cell_visibility", () => {
  test("a view with the field round-trips", () => {
    const v: ObjectView = {
      ...view,
      absent_cell_visibility: { secret: gmOnly, "Max HP": { type: "viewers", viewers: ["all"] } },
    };
    expect(ObjectViewSchema.parse(v)).toEqual(v);
  });

  test("a view without it is accepted (older servers)", () => {
    const parsed = ObjectViewSchema.parse(view);
    expect(parsed).toEqual(view);
    expect("absent_cell_visibility" in parsed).toBe(false);
  });

  test("entries are viewers values; unknown keys inside them are stripped", () => {
    expect(
      ObjectViewSchema.safeParse({
        ...view,
        absent_cell_visibility: { secret: { type: "number", value: 1 } },
      }).success,
    ).toBe(false);
    expect(ObjectViewSchema.safeParse({ ...view, absent_cell_visibility: [gmOnly] }).success).toBe(
      false,
    );
    const parsed = ObjectViewSchema.parse({
      ...view,
      absent_cell_visibility: { secret: { ...gmOnly, extra: 1 } },
    });
    expect(parsed.absent_cell_visibility).toEqual({ secret: gmOnly });
  });

  test("an own __proto__ key is rejected", () => {
    const text = `{"id":"chest","is_template":false,"is_character":false,"cells":{},"actions":[],"absent_cell_visibility":{"__proto__":{"type":"viewers","viewers":["gm"]}}}`;
    expect(ObjectViewSchema.safeParse(JSON.parse(text)).success).toBe(false);
  });

  test("exports to JSON Schema", () => {
    expect(JSON.stringify(z.toJSONSchema(ObjectViewSchema))).toContain('"absent_cell_visibility"');
  });
});
