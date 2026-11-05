/**
 * `explain_action`'s parse status (vtt-1xv.11; PROTOCOL.md §9; FORMULAS.md
 * §8.4): for the GM, `when_parses` and `when_syntax_error` from the formula
 * parser (present when the action has a `when`) and one `step_status` entry
 * per step from the step parser, with the failing step's message and offset.
 * Character results are unchanged.
 */
import { explainAction, Table } from "@vtt/authority";
import { parse, parseStep } from "@vtt/formula";
import { type ExplainActionResult, ExplainActionResultSchema } from "@vtt/protocol";
import { text, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, placed, snapshot } from "../engine/helpers";

const ALDRIC = { type: "character", id: "aldric" } as const;
const ALL: ViewersValue = { type: "viewers", viewers: ["all"] };

function explain(table: Table, params: Parameters<typeof explainAction>[1]): ExplainActionResult {
  const r = explainAction(table, params);
  expect(ExplainActionResultSchema.parse(r)).toEqual(r);
  return r;
}

function table(actions: { name: string; when?: string; steps: string[] }[]): Table {
  return Table.fromSnapshot(
    snapshot([
      placed("aldric", 0, 0, { is_character: true, cells: { name: c(text("Aldric")) } }),
      placed("card", 2, 0, {
        actions,
        cells: { visible_to: c(ALL), n: c({ type: "number", value: 1 }) },
      }),
    ]),
  );
}

describe("explain_action parse status", () => {
  test("a bad step reports its message and offset; good steps are ok", () => {
    const bad = "set(1, 2)";
    const t = table([{ name: "Go", steps: ["set(n, n + 1)", bad, "roll(1d6) -> n"] }]);
    const r = explain(t, { object: "card", action: "Go" });
    const parsed = parseStep(bad);
    if (parsed.ok) throw new Error("the step should not parse");
    expect(r.step_status).toEqual([
      { ok: true },
      { ok: false, message: parsed.message, offset: parsed.offset },
      { ok: true },
    ]);
    expect(r.step_status?.[1]).toMatchObject({ offset: 4 });
    expect(r).not.toHaveProperty("when_parses");
    expect(r).not.toHaveProperty("when_syntax_error");
    expect(r.enabled).toBe(true);
  });

  test("an unparsable when: when_parses false with the parser's message, when_error #SYNTAX", () => {
    const t = table([{ name: "Go", when: "1 +", steps: ["set(n, 2)"] }]);
    const r = explain(t, { object: "card", action: "Go" });
    const parsed = parse("1 +");
    if (parsed.ok) throw new Error("the guard should not parse");
    expect(r).toMatchObject({
      enabled: false,
      reason: "when_error",
      when_parses: false,
      when_syntax_error: parsed.message,
      step_status: [{ ok: true }],
    });
    expect(r.guard?.value).toMatchObject({ type: "error", code: "#SYNTAX" });
  });

  test("a parsable when: when_parses true, no syntax error", () => {
    const t = table([{ name: "Go", when: "n > 5", steps: [] }]);
    const r = explain(t, { object: "card", action: "Go" });
    expect(r).toEqual({
      object: "card",
      action: "Go",
      enabled: false,
      reason: "when_false",
      guard: { source: "n > 5", value: { type: "boolean", value: false } },
      steps: [],
      when_parses: true,
      step_status: [],
    });
  });

  test("character results carry none of the parse fields", () => {
    const t = table([{ name: "Go", when: "1 +", steps: ["set(1, 2)"] }]);
    const r = explain(t, { object: "card", action: "Go", viewer: ALDRIC });
    expect(r).toEqual({
      object: "card",
      action: "Go",
      enabled: false,
      reason: "when_error",
      guard: { value: { type: "error", code: "#SYNTAX", message: expect.any(String) } },
    });
  });
});
