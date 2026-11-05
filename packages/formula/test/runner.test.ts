import type { Expectation, RollValue, Scenario, Value } from "@vtt/fixtures";
import { describe, expect, test } from "vitest";
import { fixtureValueEquals, runFormulaScenario } from "./support/runner";
import { loadScenarios } from "./support/scenarios";

const scenarios = await loadScenarios();
const hitPoints = scenarios.find((s) => s.source === "Hit points") as Scenario;

const num = (value: number) => ({ type: "number", value }) as const;

describe("runFormulaScenario", () => {
  test("a wrong expected value fails, naming the location", () => {
    const copy = structuredClone(hitPoints);
    const step1 = copy.steps[1]?.expect ?? [];
    const i = step1.findIndex((e) => e.type === "cell");
    const e = step1[i] as Expectation & { type: "cell" };
    const actual = e.value;
    e.value = num(-999);
    const report = runFormulaScenario(copy);
    expect(report.failures).toEqual([{ location: `step 1#${i}`, expected: num(-999), actual }]);
    expect(report.checked).toContain(`step 1#${i}`);
  });

  test("an unknown expectation type is skipped, not failed", () => {
    const copy = structuredClone(hitPoints);
    (copy.expect as unknown[]).push({ type: "future_thing" });
    const report = runFormulaScenario(copy);
    const location = `setup#${(copy.expect ?? []).length - 1}`;
    expect(report.failures).toEqual([]);
    expect(report.skipped).toContainEqual({ location, reason: "type future_thing" });
  });

  test("known but unsupported types are skipped by type", () => {
    const report = runFormulaScenario(hitPoints);
    expect(report.skipped).toContainEqual({ location: "setup#1", reason: "type override" });
    expect(report.skipped).toContainEqual({ location: "setup#2", reason: "type log_groups" });
  });

  test("the first unsupported step and everything after are skipped", () => {
    const report = runFormulaScenario(hitPoints);
    const after = report.skipped.filter((s) => s.reason === "after unsupported step 4 (undo)");
    expect(after.map((s) => s.location)).toEqual(
      (hitPoints.steps[4]?.expect ?? []).map((_, i) => `step 4#${i}`),
    );
  });

  test("a cell_error expectation checks the code", () => {
    const base: Scenario = {
      title: "errors",
      source: "Hit points",
      setup: {
        boards: [{ id: "table" }],
        characters: [],
        objects: [
          {
            id: "a",
            placement: { board: "table", position: [0, 0] },
            cells: { x: { type: "formula", source: "1 / d" }, d: num(0) },
          },
        ],
      },
      dice: [],
      expect: [
        { type: "cell_error", object: "a", cell: "x", code: "#DIV0" },
        { type: "cell_error", object: "a", cell: "x", code: "#TYPE" },
      ],
      steps: [
        {
          do: { type: "set", object: "a", cell: "d", value: num(2) },
          expect: [
            { type: "cell", object: "a", cell: "x", value: num(0.5) },
            { type: "cell_error", object: "a", cell: "x", code: "#DIV0" },
          ],
        },
      ],
    };
    const report = runFormulaScenario(base);
    expect(report.checked).toEqual(["setup#0", "setup#1", "step 0#0", "step 0#1"]);
    expect(report.failures.map((f) => f.location)).toEqual(["setup#1", "step 0#1"]);
    expect(report.failures[0]?.actual).toMatchObject({ type: "error", code: "#DIV0" });
    expect(report.failures[1]?.actual).toEqual(num(0.5));
  });
});

describe("fixtureValueEquals (FIXTURES §7)", () => {
  const roll: RollValue = { type: "roll", expr: "1d20", dice: [7], dropped: [], total: 7 };
  test("numbers exact, and never equal to a roll", () => {
    expect(fixtureValueEquals(num(3), num(3))).toBe(true);
    expect(fixtureValueEquals(num(3), num(3.0000001))).toBe(false);
    expect(fixtureValueEquals(num(7), roll)).toBe(false);
  });
  test("roll results compare all fields", () => {
    expect(fixtureValueEquals(roll, { ...roll })).toBe(true);
    expect(fixtureValueEquals(roll, { ...roll, dice: [8] })).toBe(false);
    expect(fixtureValueEquals(roll, { ...roll, dropped: [1] })).toBe(false);
    expect(fixtureValueEquals(roll, { ...roll, expr: "d20" })).toBe(false);
  });
  test("lists elementwise and recursive, refs by object, viewers as sets", () => {
    const l: Value = { type: "list", items: [num(1), { type: "list", items: [num(2)] }] };
    expect(fixtureValueEquals(l, structuredClone(l))).toBe(true);
    expect(
      fixtureValueEquals(l, { type: "list", items: [num(1), { type: "list", items: [num(3)] }] }),
    ).toBe(false);
    expect(fixtureValueEquals({ type: "ref", object: "a" }, { type: "ref", object: "a" })).toBe(
      true,
    );
    expect(fixtureValueEquals({ type: "ref", object: "a" }, { type: "ref", object: "b" })).toBe(
      false,
    );
    const v = (...viewers: ("gm" | "all" | { type: "ref"; object: string })[]) =>
      ({ type: "viewers", viewers }) as const;
    expect(
      fixtureValueEquals(
        v("gm", { type: "ref", object: "x" }),
        v({ type: "ref", object: "x" }, "gm"),
      ),
    ).toBe(true);
    expect(fixtureValueEquals(v("gm"), v("gm", "all"))).toBe(false);
  });
  test("an error never equals a value", () => {
    expect(fixtureValueEquals(num(1), { type: "error", code: "#REF" })).toBe(false);
  });
});
