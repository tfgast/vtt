// @vitest-environment node
import { type CellView, WireOpSchema } from "@vtt/protocol";
import { cellInputToOps, parseCellInput, replaceFormulaOps } from "@vtt/ui";
import { describe, expect, test } from "vitest";

const formulaCell: CellView = {
  kind: "formula",
  source: "max_hp - damage_taken",
  value: { type: "number", value: 7 },
};

function parsed(text: string, cell: string) {
  const result = parseCellInput(text, { cell });
  if (!result.ok) throw new Error(result.message);
  return result.content;
}

describe("cellInputToOps", () => {
  test("a literal on a formula cell is a set_value (an override)", () => {
    const ops = cellInputToOps("goblin1", "hp", parsed("3", "hp"), formulaCell);
    expect(ops).toEqual([
      { type: "set_value", object: "goblin1", cell: "hp", value: { type: "number", value: 3 } },
    ]);
  });

  test("a leading = is a set_formula", () => {
    const ops = cellInputToOps("goblin1", "hp", parsed("=max_hp - 2", "hp"), formulaCell);
    expect(ops).toEqual([
      { type: "set_formula", object: "goblin1", cell: "hp", source: "max_hp - 2" },
    ]);
  });

  test("a literal on a literal cell or no cell is a set_value", () => {
    expect(cellInputToOps("a", "note", parsed("hi", "note"))).toEqual([
      { type: "set_value", object: "a", cell: "note", value: { type: "text", value: "hi" } },
    ]);
  });

  test("a viewers value on visible_to", () => {
    expect(cellInputToOps("a", "visible_to", parsed("gm, @aldric", "visible_to"))).toEqual([
      {
        type: "set_value",
        object: "a",
        cell: "visible_to",
        value: { type: "viewers", viewers: ["gm", { type: "ref", object: "aldric" }] },
      },
    ]);
  });

  test.each([
    ["12", "hp"],
    ["=a + b", "hp"],
    ['[@goblin1, "x", [3]]', "xs"],
    ["owner, @aldric", "visible_to"],
    ["2d6+3", "dmg"],
    ["", "hp"],
  ])("%j yields ops that satisfy the wire schema", (text, cell) => {
    for (const op of cellInputToOps("goblin1", cell, parsed(text, cell))) {
      expect(WireOpSchema.safeParse(op).success).toBe(true);
    }
  });
});

describe("replaceFormulaOps", () => {
  test("one set_value with replace: true", () => {
    const ops = replaceFormulaOps("goblin1", "hp", { type: "number", value: 5 });
    expect(ops).toEqual([
      {
        type: "set_value",
        object: "goblin1",
        cell: "hp",
        value: { type: "number", value: 5 },
        replace: true,
      },
    ]);
    expect(WireOpSchema.safeParse(ops[0]).success).toBe(true);
  });

  test("also on structural cells such as visible_to", () => {
    expect(replaceFormulaOps("zone1", "visible_to", { type: "viewers", viewers: ["gm"] })).toEqual([
      {
        type: "set_value",
        object: "zone1",
        cell: "visible_to",
        value: { type: "viewers", viewers: ["gm"] },
        replace: true,
      },
    ]);
  });
});
