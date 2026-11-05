// @vitest-environment node
import type { WireResult } from "@vtt/protocol";
import { type Formatted, formatValue } from "@vtt/ui";
import { describe, expect, test } from "vitest";

const LABELS: Record<string, string> = { aldric: "Aldric", goblin1: "Goblin" };
const refLabel = (id: string): string | null => LABELS[id] ?? null;

const compact = (v: WireResult): Formatted => formatValue(v, { mode: "compact", refLabel });
const full = (v: WireResult): Formatted => formatValue(v, { mode: "full", refLabel });

const long = "a".repeat(45);

type Row = [name: string, value: WireResult, compact: Formatted, full: Formatted];

const n = (text: string): Formatted => ({ text, tone: "normal" });

const rows: Row[] = [
  ["integer", { type: "number", value: 12 }, n("12"), n("12")],
  ["negative", { type: "number", value: -2 }, n("-2"), n("-2")],
  ["decimal trimmed", { type: "number", value: 3.5 }, n("3.5"), n("3.5")],
  ["four decimals", { type: "number", value: 1 / 3 }, n("0.3333"), n(String(1 / 3))],
  ["rounds away trailing zeros", { type: "number", value: 2.00001 }, n("2"), n("2.00001")],
  ["tiny negative", { type: "number", value: -0.00001 }, n("0"), n("-0.00001")],
  ["large", { type: "number", value: 1e21 }, n("1e+21"), n("1e+21")],
  ["text", { type: "text", value: "goblin" }, n("goblin"), n("goblin")],
  ["multi-line text", { type: "text", value: "one\ntwo" }, n("one…"), n("one\ntwo")],
  ["long text", { type: "text", value: long }, n(`${"a".repeat(39)}…`), n(long)],
  ["text of 40", { type: "text", value: "b".repeat(40) }, n("b".repeat(40)), n("b".repeat(40))],
  ["empty text", { type: "text", value: "" }, n(""), n("")],
  [
    "40-character line then more lines",
    { type: "text", value: `${"c".repeat(40)}\nmore` },
    n(`${"c".repeat(39)}…`),
    n(`${"c".repeat(40)}\nmore`),
  ],
  [
    "39-character line then more lines",
    { type: "text", value: `${"d".repeat(39)}\nmore` },
    n(`${"d".repeat(39)}…`),
    n(`${"d".repeat(39)}\nmore`),
  ],
  ["true", { type: "boolean", value: true }, n("true"), n("true")],
  ["false", { type: "boolean", value: false }, n("false"), n("false")],
  ["empty", { type: "empty" }, { text: "", tone: "muted" }, { text: "empty", tone: "muted" }],
  [
    "list",
    {
      type: "list",
      items: [
        { type: "number", value: 1 },
        { type: "text", value: "x" },
      ],
    },
    n("[1, x]"),
    n("[1, x]"),
  ],
  ["empty list", { type: "list", items: [] }, n("[]"), n("[]")],
  [
    "long list",
    {
      type: "list",
      items: [1, 2, 3, 4, 5].map((value) => ({ type: "number" as const, value })),
    },
    n("[1, 2, 3, … +2]"),
    n("[1, 2, 3, 4, 5]"),
  ],
  [
    "list with empty item",
    { type: "list", items: [{ type: "empty" }] },
    n("[empty]"),
    n("[empty]"),
  ],
  [
    "nested list with a redacted ref",
    {
      type: "list",
      items: [
        { type: "ref", object: "aldric" },
        {
          type: "list",
          items: [{ type: "redacted" }, { type: "number", value: 2 }],
        },
      ],
    },
    n("[Aldric, [hidden, 2]]"),
    n("[Aldric (aldric), [hidden, 2]]"),
  ],
  ["labelled ref", { type: "ref", object: "goblin1" }, n("Goblin"), n("Goblin (goblin1)")],
  ["unlabelled ref", { type: "ref", object: "door7" }, n("door7"), n("door7")],
  ["dice", { type: "dice", expr: "2d6+3" }, n("2d6+3"), n("2d6+3")],
  [
    "roll with dropped dice",
    { type: "roll", expr: "4d6dl1", dice: [6, 4, 3], dropped: [1], total: 13 },
    n("13"),
    n("13 (4d6dl1: 6, 4, 3; dropped 1)"),
  ],
  [
    "roll without dropped dice",
    { type: "roll", expr: "2d6+1", dice: [5, 2], dropped: [], total: 8 },
    n("8"),
    n("8 (2d6+1: 5, 2)"),
  ],
  [
    "viewers",
    {
      type: "viewers",
      viewers: ["gm", "owner", { type: "ref", object: "aldric" }, { type: "ref", object: "x9" }],
    },
    n("gm, owner, Aldric, x9"),
    n("gm, owner, Aldric (aldric), x9"),
  ],
  ["viewers all", { type: "viewers", viewers: ["all"] }, n("all"), n("all")],
  [
    "viewers with a redacted entry",
    { type: "viewers", viewers: ["gm", { type: "redacted" }] },
    n("gm, hidden"),
    n("gm, hidden"),
  ],
  [
    "ink",
    {
      type: "ink",
      strokes: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    n("(ink)"),
    n("(ink)"),
  ],
  [
    "rect",
    { type: "shape", shape: { type: "rect", width: 2, height: 1 } },
    n("rect 2×1"),
    n("rect 2×1"),
  ],
  [
    "circle",
    { type: "shape", shape: { type: "circle", radius: 4 } },
    n("circle r 4"),
    n("circle r 4"),
  ],
  [
    "polygon",
    {
      type: "shape",
      shape: {
        type: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [2, 1],
          [1, 2],
          [0, 1],
        ],
      },
    },
    n("polygon, 5 points"),
    n("polygon, 5 points"),
  ],
  [
    "error with origin",
    {
      type: "error",
      code: "#REF",
      message: "goblin9 was deleted",
      origin: { object: "goblin1", cell: "target" },
    },
    { text: "#REF", tone: "error" },
    { text: "#REF: goblin9 was deleted (from goblin1.target)", tone: "error" },
  ],
  [
    "error without origin",
    { type: "error", code: "#DIV0", message: "division by zero" },
    { text: "#DIV0", tone: "error" },
    { text: "#DIV0: division by zero", tone: "error" },
  ],
  [
    "error without message",
    { type: "error", code: "#CYCLE", origin: { object: "a", cell: "b" } },
    { text: "#CYCLE", tone: "error" },
    { text: "#CYCLE (from a.b)", tone: "error" },
  ],
  [
    "bare error",
    { type: "error", code: "#TYPE" },
    { text: "#TYPE", tone: "error" },
    {
      text: "#TYPE",
      tone: "error",
    },
  ],
  [
    "redacted",
    { type: "redacted" },
    { text: "hidden", tone: "redacted" },
    { text: "hidden", tone: "redacted" },
  ],
];

describe("formatValue", () => {
  test.each(rows)("%s", (_name, value, c, f) => {
    expect(compact(value)).toEqual(c);
    expect(full(value)).toEqual(f);
  });
});
