// @vitest-environment node
import type { CellView, ObjectView, WireResult } from "@vtt/protocol";
import { type Appearance, readAppearance } from "@vtt/ui";
import { describe, expect, test } from "vitest";

const text = (value: string): WireResult => ({ type: "text", value });
const num = (value: number): WireResult => ({ type: "number", value });
const bool = (value: boolean): WireResult => ({ type: "boolean", value });
const error: WireResult = { type: "error", code: "#TYPE" };

function view(cells: Record<string, WireResult>): ObjectView {
  const out: Record<string, CellView> = {};
  for (const [name, value] of Object.entries(cells)) out[name] = { value, kind: "literal" };
  return { id: "thing", is_template: false, is_character: false, cells: out, actions: [] };
}

const NONE: Appearance = {
  image: null,
  color: null,
  pattern: null,
  text: null,
  name: null,
  faceUp: "absent",
  opaque: "absent",
  visibleTo: "absent",
};

const gmOnly: WireResult = { type: "viewers", viewers: ["gm"] };

type Row = [name: string, cells: Record<string, WireResult>, expected: Partial<Appearance>];

const rows: Row[] = [
  ["no cells", {}, {}],
  [
    "every cell of the right kind",
    {
      image: text("table.assets/map-0a1b2c3d.png"),
      color: text("#ff0000"),
      pattern: text("hatch"),
      text: num(12),
      name: text("Goblin"),
      face_up: bool(false),
      opaque: bool(true),
      visible_to: gmOnly,
    },
    {
      image: "table.assets/map-0a1b2c3d.png",
      color: "#ff0000",
      pattern: "hatch",
      text: num(12),
      name: "Goblin",
      faceUp: false,
      opaque: true,
      visibleTo: gmOnly,
    },
  ],
  ["a numeric color is no color", { color: num(3) }, {}],
  ["an error color is no color", { color: error }, {}],
  ["an empty color is no color", { color: text("") }, {}],
  ["a numeric image is no image", { image: num(1) }, {}],
  ["an empty image is no image", { image: text("") }, {}],
  ["a pattern other than hatch is ignored", { pattern: text("dots") }, {}],
  ["a non-text pattern is ignored", { pattern: bool(true) }, {}],
  ["an error text is not drawn", { text: error }, {}],
  ["an empty text value is no text", { text: { type: "empty" } }, {}],
  ["any other text value is kept", { text: bool(true) }, { text: bool(true) }],
  ["a redacted text is kept", { text: { type: "redacted" } }, { text: { type: "redacted" } }],
  ["an empty name is no label", { name: { type: "empty" } }, {}],
  ["an empty-string name is no label", { name: text("") }, {}],
  ["face_up true", { face_up: bool(true) }, { faceUp: true }],
  ["face_up error", { face_up: error }, { faceUp: "invalid" }],
  ["face_up not a boolean", { face_up: num(1) }, { faceUp: "invalid" }],
  ["opaque false", { opaque: bool(false) }, { opaque: false }],
  ["opaque error", { opaque: error }, { opaque: "invalid" }],
  ["opaque text", { opaque: text("yes") }, { opaque: "invalid" }],
  ["visible_to error", { visible_to: error }, { visibleTo: "invalid" }],
  ["visible_to not viewers", { visible_to: text("all") }, { visibleTo: "invalid" }],
];

describe("readAppearance", () => {
  test.each(rows)("%s", (_name, cells, expected) => {
    expect(readAppearance(view(cells))).toEqual({ ...NONE, ...expected });
  });
});
