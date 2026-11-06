/**
 * `when_selected` in fixture faces (vtt-nb8.26; FIXTURES.md §3 Face;
 * DESIGN.md §4.6; M6-D12): an optional boolean on contents elements only.
 */
import { FaceLayoutSchema } from "@vtt/fixtures";
import { describe, expect, test } from "vitest";

const contents = { type: "contents", rect: [-1.5, 0.9, 3, 1.2] };
const value = { type: "value", cell: "hp", rect: [0, 0, 1, 1] };

describe("a fixture face's when_selected (M6-D12)", () => {
  test("a contents element takes true or false, in either list", () => {
    for (const when_selected of [true, false]) {
      const face = {
        elements: [value, { ...contents, min_size: 24, when_selected }],
        collapsed: [{ ...contents, when_selected }],
      };
      expect(FaceLayoutSchema.parse(face)).toEqual(face);
    }
  });

  test.each<[string, unknown]>([
    ["on a value element", { ...value, when_selected: true }],
    ["on a button", { type: "button", action: "Roll", rect: [0, 0, 1, 1], when_selected: true }],
    ["as a string", { ...contents, when_selected: "true" }],
    ["as a number", { ...contents, when_selected: 1 }],
    ["as null", { ...contents, when_selected: null }],
  ])("is refused %s", (_, element) => {
    expect(FaceLayoutSchema.safeParse({ elements: [element] }).success).toBe(false);
  });
});
