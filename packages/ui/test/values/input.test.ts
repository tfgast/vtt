// @vitest-environment node
import type { CellView, InputCellContent, WireResult } from "@vtt/protocol";
import {
  cellCapabilities,
  isUnchangedInput,
  parseCellInput,
  toInputText,
  valueToInputText,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const num = (value: number) => ({ type: "number" as const, value });
const text = (value: string) => ({ type: "text" as const, value });
const ref = (object: string) => ({ type: "ref" as const, object });
const list = (...items: InputCellContent[]) =>
  ({ type: "list" as const, items }) as InputCellContent;
const formula = (source: string) => ({ type: "formula" as const, source });

describe("parseCellInput", () => {
  const ok: [input: string, cell: string, content: InputCellContent][] = [
    ["12", "hp", num(12)],
    ["-2", "hp", num(-2)],
    ["3.5", "hp", num(3.5)],
    [" 1 ", "hp", num(1)],
    ["1e5", "hp", text("1e5")],
    ["true", "hp", { type: "boolean", value: true }],
    ["false", "hp", { type: "boolean", value: false }],
    ["empty", "hp", { type: "empty" }],
    ["", "hp", { type: "empty" }],
    ['""', "hp", text("")],
    ['"12"', "hp", text("12")],
    ['"say \\"hi\\" \\\\ ok"', "hp", text('say "hi" \\ ok')],
    ["2d6+3", "dmg", { type: "dice", expr: "2d6+3" }],
    ["d20", "dmg", { type: "dice", expr: "1d20" }],
    ["2 + 1d6 + 1", "dmg", { type: "dice", expr: "1d6+3" }],
    ["1d6+1d20", "dmg", { type: "dice", expr: "1d6+1d20" }],
    ["1d6kh1!", "dmg", { type: "dice", expr: "1d6!kh1" }],
    ["0d6", "dmg", text("0d6")],
    ["1d6kh2", "dmg", text("1d6kh2")],
    ["(1d6)", "dmg", text("(1d6)")],
    ["1+2", "hp", text("1+2")],
    ["(12)", "hp", text("(12)")],
    ["--2", "hp", text("--2")],
    ["[1, 2]", "xs", list(num(1), num(2))],
    ["[]", "xs", list()],
    [
      '[@goblin1, "x", [3, @aldric]]',
      "xs",
      list(ref("goblin1"), text("x"), list(num(3), ref("aldric"))),
    ],
    ['["a, b", "c]"]', "xs", list(text("a, b"), text("c]"))],
    [
      "[2d6, empty, true, -1]",
      "xs",
      list(
        { type: "dice", expr: "2d6" },
        { type: "empty" },
        { type: "boolean", value: true },
        num(-1),
      ),
    ],
    ["[@gm]", "xs", text("[@gm]")],
    ["[1, ", "xs", text("[1, ")],
    ["[1,]", "xs", text("[1,]")],
    ["[hello]", "xs", text("[hello]")],
    ["[1] x", "xs", text("[1] x")],
    ["hello world", "note", text("hello world")],
    ["a + b", "note", text("a + b")],
    [" padded ", "note", text(" padded ")],
    ["   ", "note", text("   ")],
    ["gm", "note", text("gm")],
    ["@goblin1", "target", ref("goblin1")],
    ["@gm", "target", text("@gm")],
    ["@owner", "target", text("@owner")],
    ["@1x", "target", text("@1x")],
    ["=max_hp - damage_taken", "hp", formula("max_hp - damage_taken")],
    ["= a+b ", "hp", formula(" a+b ")],
    ["=x", "name", text("=x")],
    ["12", "name", text("12")],
    ["", "name", { type: "empty" }],
    ["   ", "name", text("   ")],
    [" padded ", "name", text(" padded ")],
    ["gm", "visible_to", { type: "viewers", viewers: ["gm"] }],
    ["all", "visible_to", { type: "viewers", viewers: ["all"] }],
    ["owner, @aldric", "visible_to", { type: "viewers", viewers: ["owner", ref("aldric")] }],
    ["@aldric", "visible_to", { type: "viewers", viewers: [ref("aldric")] }],
    ["gm,@aldric", "visible_to", { type: "viewers", viewers: ["gm", ref("aldric")] }],
    ["=owner", "visible_to", formula("owner")],
    ["gm, nobody", "visible_to", text("gm, nobody")],
    ["owner", "hp", text("owner")],
  ];

  test.each(ok)("%j in %s", (input, cell, content) => {
    expect(parseCellInput(input, { cell })).toEqual({ ok: true, content });
  });

  test.each([
    ["=max_hp -", "hp"],
    ["=", "hp"],
    ["=1e5", "hp"],
    ["=(", "visible_to"],
  ])("%j in %s is refused with the parser message", (input, cell) => {
    const result = parseCellInput(input, { cell });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("valueToInputText", () => {
  const roundTrip: [cell: string, value: WireResult, text: string][] = [
    ["hp", num(12), "12"],
    ["hp", num(-2), "-2"],
    ["hp", num(3.5), "3.5"],
    ["hp", num(0.1), "0.1"],
    ["hp", num(-0.5), "-0.5"],
    ["hp", num(123456789.125), "123456789.125"],
    ["hp", num(1e21), "1000000000000000000000"],
    ["hp", num(1e-7), "0.0000001"],
    ["note", text("hello"), "hello"],
    ["note", text(" padded "), " padded "],
    ["note", text("12"), '"12"'],
    ["note", text(""), '""'],
    ["note", text("true"), '"true"'],
    ["note", text("=x"), '"=x"'],
    ["note", text("@goblin1"), '"@goblin1"'],
    ["note", text("[1]"), '"[1]"'],
    ["note", text("2d6"), '"2d6"'],
    ["note", text('say "hi"'), 'say "hi"'],
    ["note", text('"quoted"'), '"\\"quoted\\""'],
    ["note", text("gm"), "gm"],
    ["visible_to", text("gm"), '"gm"'],
    ["flag", { type: "boolean", value: true }, "true"],
    ["flag", { type: "empty" }, "empty"],
    ["dmg", { type: "dice", expr: "2d6+3" }, "2d6+3"],
    ["dmg", { type: "dice", expr: "d20" }, "1d20"],
    ["target", ref("goblin1"), "@goblin1"],
    ["name", text("12"), "12"],
    ["name", text("=x"), "=x"],
    ["name", text(" padded "), " padded "],
    ["name", text("   "), "   "],
    ["name", { type: "empty" }, ""],
    ["visible_to", { type: "viewers", viewers: ["gm", ref("aldric")] }, "gm, @aldric"],
    ["visible_to", { type: "viewers", viewers: ["all"] }, "all"],
    [
      "xs",
      {
        type: "list",
        items: [ref("a"), text("x, y"), { type: "list", items: [ref("b"), text('q"')] }],
      },
      '[@a, "x, y", [@b, "q\\""]]',
    ],
    [
      "xs",
      {
        type: "list",
        items: [
          ref("a"),
          text("x"),
          num(3),
          { type: "list", items: [{ type: "boolean", value: true }] },
        ],
      },
      '[@a, "x", 3, [true]]',
    ],
    ["xs", { type: "list", items: [] }, "[]"],
  ];

  test.each(roundTrip)("%s: %j → %j and back", (cell, value, expected) => {
    const result = valueToInputText(value, cell);
    expect(result).toEqual({ kind: "literal", text: expected });
    const parsed = parseCellInput(expected, { cell });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const content = parsed.content;
    if (value.type === "dice" && content.type === "dice") {
      expect(content.expr).toBe(expected);
    } else {
      expect(content).toEqual(value);
    }
  });

  test("an empty name is an empty input that reads back as empty", () => {
    expect(valueToInputText({ type: "empty" }, "name")).toEqual({ kind: "literal", text: "" });
    expect(parseCellInput("", { cell: "name" })).toEqual({
      ok: true,
      content: { type: "empty" },
    });
  });

  test.each([
    0.1, 1e21, 1e-7, 123456789.125, -0.5, 5e-324, 1.7976931348623157e308, 0.30000000000000004,
  ])("number %d is never exponent notation", (value) => {
    const result = valueToInputText(num(value), "hp");
    if (result.kind === "literal") {
      expect(result.text).not.toMatch(/e/i);
      const parsed = parseCellInput(result.text, { cell: "hp" });
      expect(parsed).toEqual({ ok: true, content: num(value) });
    } else {
      expect(result.kind).toBe("unsupported");
    }
  });

  const unsupported: [string, string, WireResult][] = [
    ["roll", "hp", { type: "roll", expr: "1d20", dice: [13], dropped: [], total: 13 }],
    ["#REF error", "target", { type: "error", code: "#REF", message: "deleted" }],
    ["shape", "outline", { type: "shape", shape: { type: "rect", width: 1, height: 1 } }],
    ["ink", "notes", { type: "ink", strokes: [] }],
    ["redacted", "secret", { type: "redacted" }],
    ["viewers outside visible_to", "who", { type: "viewers", viewers: ["gm"] }],
    [
      "viewers with a redacted entry",
      "visible_to",
      { type: "viewers", viewers: ["gm", { type: "redacted" }] },
    ],
    ["list with a redacted ref", "xs", { type: "list", items: [ref("a"), { type: "redacted" }] }],
    [
      "list with a roll",
      "xs",
      { type: "list", items: [{ type: "roll", expr: "1d6", dice: [1], dropped: [], total: 1 }] },
    ],
    ["non-text name", "name", num(3)],
    ["name of empty text", "name", text("")],
    ["plain ref in visible_to", "visible_to", ref("aldric")],
  ];

  test.each(unsupported)("%s is unsupported with a reason", (_n, cell, value) => {
    const result = valueToInputText(value, cell);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.reason.length).toBeGreaterThan(0);
  });

  test("unsupported values: a user cell allows replacing them, shape and contents do not", () => {
    const shapeView: CellView = {
      kind: "structural",
      value: { type: "shape", shape: { type: "circle", radius: 1 } },
    };
    const contentsView: CellView = {
      kind: "structural",
      value: { type: "list", items: [{ type: "redacted" }] },
    };
    expect(valueToInputText(shapeView.value, "shape").kind).toBe("unsupported");
    expect(cellCapabilities("shape", shapeView).literal).toBe(false);
    expect(valueToInputText(contentsView.value, "contents").kind).toBe("unsupported");
    expect(cellCapabilities("contents", contentsView).literal).toBe(false);
    for (const [, cell, value] of unsupported.slice(0, 5)) {
      expect(cellCapabilities(cell, { kind: "literal", value }).literal).toBe(true);
    }
  });
});

describe("toInputText", () => {
  const overridden: CellView = {
    kind: "formula",
    source: "max_hp - damage_taken",
    overridden: true,
    value: num(7),
  };

  test("an overridden formula cell: the source, while its value is the override", () => {
    expect(toInputText(overridden, "hp")).toEqual({
      kind: "formula",
      source: "max_hp - damage_taken",
    });
    expect(valueToInputText(overridden.value, "hp")).toEqual({ kind: "literal", text: "7" });
  });

  test("a formula cell without source (character view) shows its value", () => {
    expect(toInputText({ kind: "formula", value: num(3) }, "hp")).toEqual({
      kind: "literal",
      text: "3",
    });
  });

  test("a literal cell", () => {
    expect(toInputText({ kind: "literal", value: text("hi") }, "note")).toEqual({
      kind: "literal",
      text: "hi",
    });
  });

  test("a formula cell holding an error still shows its source", () => {
    expect(
      toInputText({ kind: "formula", source: "1/0", value: { type: "error", code: "#DIV0" } }, "x"),
    ).toEqual({ kind: "formula", source: "1/0" });
  });
});

describe("isUnchangedInput", () => {
  const cases: [before: string, after: string, cell: string, unchanged: boolean][] = [
    ["hello", "hello", "note", true],
    ["hello", " hello ", "note", false],
    ["hello", "hello\n", "note", false],
    ["Bob", "Bob ", "name", false],
    ["Bob", "Bob", "name", true],
    ["1", " 1 ", "hp", true],
    ["1", "1.0", "hp", true],
    ["1", "2", "hp", false],
    ["1", '"1"', "hp", false],
    ["=a+b", "= a+b ", "hp", true],
    ["=a+b", "=a + b", "hp", false],
    ["=a+b", "a+b", "hp", false],
    ["d20", "1d20", "dmg", true],
    ["[1, 2]", "[1,2]", "xs", true],
    ["[1, 2]", "[2, 1]", "xs", false],
    ["gm, @aldric", "gm,@aldric", "visible_to", true],
    ["", "empty", "hp", true],
    ["=a+", "=a+", "hp", true],
    ["=a+", "=a+ ", "hp", false],
  ];

  test.each(cases)("%j vs %j in %s → %s", (before, after, cell, unchanged) => {
    expect(isUnchangedInput(before, after, cell)).toBe(unchanged);
  });
});

describe("cellCapabilities", () => {
  const literal: CellView = { kind: "literal", value: num(1) };
  const formulaView: CellView = {
    kind: "formula",
    source: "gm",
    value: { type: "viewers", viewers: ["gm"] },
  };
  const structural: CellView = { kind: "structural", value: { type: "empty" } };

  const none = { literal: false, formula: false, replace: false };
  const value = { literal: true, formula: true, replace: false };

  const cases: [cell: string, view: CellView | undefined, expected: object][] = [
    ["id", structural, none],
    ["template", structural, none],
    ["is_zone", structural, none],
    ["name", literal, { literal: true, formula: false, replace: false }],
    ["name", undefined, { literal: true, formula: false, replace: false }],
    ["tag", structural, { ...none, control: "tag" }],
    ["contents", structural, { ...none, control: "contents" }],
    ["shape", structural, { ...none, control: "shape" }],
    ["board", structural, { ...none, control: "placement" }],
    ["container", structural, { ...none, control: "placement" }],
    ["position", literal, { ...value, control: "placement" }],
    ["rotation", undefined, { ...value, control: "placement" }],
    ["z", formulaView, { literal: true, formula: true, replace: true, control: "placement" }],
    ["is_template", structural, { ...none, control: "flags" }],
    ["is_character", structural, { ...none, control: "flags" }],
    ["owner", structural, value],
    ["face_up", literal, value],
    ["opaque", literal, value],
    ["visible_to", structural, value],
    ["visible_to", formulaView, { literal: true, formula: true, replace: true }],
    ["hp", literal, value],
    ["hp", formulaView, { literal: true, formula: true, replace: true }],
    ["hp", undefined, value],
  ];

  test.each(cases)("%s", (cell, view, expected) => {
    expect(cellCapabilities(cell, view)).toEqual(expected);
  });

  test.each(["hp", "visible_to", "name", "position", "tag", "shape"])(
    "%s: everything false when read-only",
    (cell) => {
      expect(cellCapabilities(cell, formulaView, { readOnly: true })).toEqual(none);
    },
  );
});
