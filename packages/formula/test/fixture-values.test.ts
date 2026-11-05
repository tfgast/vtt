import type { CellContent as FixtureContent, Value as FixtureValue, Scenario } from "@vtt/fixtures";
import { FORMULAS_FIXTURES } from "@vtt/fixtures";
import { isCellContent, isValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { fromFixtureContent, fromFixtureValue } from "./support/fixture-values";
import { loadScenarios } from "./support/scenarios";

const scenarios = await loadScenarios();

/** Every literal value and cell content in a scenario, labelled by where it sits. */
function collect(s: Scenario): {
  values: [string, FixtureValue][];
  contents: [string, FixtureContent][];
} {
  const values: [string, FixtureValue][] = [];
  const contents: [string, FixtureContent][] = [];

  for (const o of s.setup.objects) {
    for (const [cell, c] of Object.entries(o.cells ?? {})) contents.push([`${o.id}.${cell}`, c]);
    for (const [cell, v] of Object.entries(o.cell_visibility ?? {}))
      values.push([`${o.id} cell_visibility ${cell}`, v]);
    const position = o.placement?.position;
    if (position !== undefined && !Array.isArray(position))
      contents.push([`${o.id} placement`, position]);
  }

  s.dice.forEach((d, i) => {
    if (d.type === "roll") values.push([`dice[${i}]`, d]);
  });

  const expectations = (where: string, list: Scenario["expect"]) => {
    (list ?? []).forEach((e, i) => {
      if (e.type === "cell") values.push([`${where}[${i}]`, e.value]);
      if (e.type === "log_includes") values.push([`${where}[${i}] effect`, e.effect.value]);
    });
  };
  expectations("expect", s.expect);

  s.steps.forEach((step, i) => {
    const d = step.do;
    if (d.type === "set" || d.type === "override") values.push([`steps[${i}] ${d.type}`, d.value]);
    if (d.type === "spawn")
      for (const [cell, c] of Object.entries(d.cells ?? {}))
        contents.push([`steps[${i}] spawn ${cell}`, c]);
    if (d.type === "bind" && d.where) values.push([`steps[${i}] bind where`, d.where.value]);
    expectations(`steps[${i}].expect`, step.expect);
  });

  return { values, contents };
}

test("loadScenarios returns all ten scenarios", () => {
  expect(scenarios).toHaveLength(10);
  expect(scenarios.map((s) => s.title).every((t) => t.length > 0)).toBe(true);
  expect(new Set(scenarios.map((s) => s.source))).toEqual(new Set(FORMULAS_FIXTURES));
});

describe.each(scenarios.map((s) => [s.title, s] as const))("%s", (_, s) => {
  const { values, contents } = collect(s);

  test("has literal values to check", () => {
    expect(values.length + contents.length).toBeGreaterThan(0);
  });

  test("every literal value passes isValue through fromFixtureValue", () => {
    for (const [where, v] of values) {
      const converted = fromFixtureValue(v);
      expect(isValue(converted), where).toBe(true);
      expect(converted, where).toEqual(v);
    }
  });

  test("every cell content passes isCellContent through fromFixtureContent", () => {
    for (const [where, c] of contents) {
      const converted = fromFixtureContent(c);
      expect(isCellContent(converted), where).toBe(true);
      expect(converted, where).toEqual(c);
      if (c.type !== "formula") expect(isValue(fromFixtureValue(c)), where).toBe(true);
    }
  });
});

describe("malformed values throw", () => {
  const bad: [string, unknown][] = [
    ["an unknown tag", { type: "record", fields: {} }],
    ["an extra key", { type: "number", value: 1, unit: "ft" }],
    ["a non-finite number", { type: "number", value: Number.POSITIVE_INFINITY }],
    ["an empty viewer set", { type: "viewers", viewers: [] }],
    ["a bad list item", { type: "list", items: [{ type: "text" }] }],
    ["an error", { type: "error", code: "#REF" }],
  ];

  test.each(bad)("fromFixtureValue rejects %s", (_, v) => {
    expect(() => fromFixtureValue(v as FixtureValue)).toThrow();
  });

  test("fromFixtureValue rejects a formula", () => {
    expect(() =>
      fromFixtureValue({ type: "formula", source: "1" } as unknown as FixtureValue),
    ).toThrow();
  });

  test("fromFixtureContent rejects a blank formula and malformed values", () => {
    expect(() => fromFixtureContent({ type: "formula", source: " " } as FixtureContent)).toThrow();
    for (const [, v] of bad) expect(() => fromFixtureContent(v as FixtureContent)).toThrow();
  });
});
