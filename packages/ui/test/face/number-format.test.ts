// @vitest-environment node
/**
 * Number formatting on faces (vtt-qf5.29; FORMULAS.md §11; DESIGN.md §4.6):
 * a value or editor element's `style.format` rewrites a number's face text.
 */
import type { FaceElementView, ObjectView, WireValue } from "@vtt/protocol";
import type { FaceNumberFormat } from "@vtt/schema";
import {
  createFaceStateStore,
  type FaceDrawing,
  formatFaceNumber,
  resolveFace,
  type TextPrimitive,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const num = (value: number): WireValue => ({ type: "number", value });

/** An object whose face shows each of `cells` as a value element with `format`. */
function faceOf(
  cells: Record<string, WireValue>,
  format: FaceNumberFormat | undefined,
  type: "value" | "editor" = "value",
): FaceDrawing {
  const elements = Object.keys(cells).map(
    (cell, index) =>
      ({
        type,
        cell,
        rect: [-1, -0.5 + index * 0.1, 2, 0.1],
        index,
        shown: true,
        ...(format === undefined ? {} : { style: { format } }),
      }) as FaceElementView,
  );
  const view: ObjectView = {
    id: "card",
    is_template: false,
    is_character: false,
    cells: Object.fromEntries(
      Object.entries(cells).map(([name, value]) => [name, { value, kind: "literal" as const }]),
    ),
    actions: [],
    action_states: [],
    face: { elements },
  };
  return resolveFace(view, {
    views: (id) => (id === "card" ? view : null),
    faceState: createFaceStateStore(),
    list: "full",
    gm: true,
    revealed: () => true,
  });
}

const texts = (d: FaceDrawing) => d.primitives.map((p) => (p as TextPrimitive).text);

describe("resolveFace applies style.format to number values", () => {
  test("sign always: +3, -1, and zero stays 0", () => {
    const d = faceOf({ a: num(3), b: num(-1), c: num(0) }, { sign: "always" });
    expect(texts(d)).toEqual(["+3", "-1", "0"]);
  });

  test("decimals 2: 2.5 is 2.50", () => {
    expect(texts(faceOf({ w: num(2.5) }, { decimals: 2 }))).toEqual(["2.50"]);
  });

  test("sign and decimals together", () => {
    const d = faceOf({ a: num(2.5), b: num(-0.25), c: num(0) }, { sign: "always", decimals: 1 });
    expect(texts(d)).toEqual(["+2.5", "-0.3", "0.0"]);
  });

  test("a non-number value is unchanged", () => {
    const d = faceOf(
      {
        t: { type: "text", value: "3" },
        b: { type: "boolean", value: true },
        r: { type: "roll", expr: "1d20", dice: [7], dropped: [], total: 7 },
        e: { type: "empty" },
      },
      { sign: "always", decimals: 2 },
    );
    expect(texts(d)).toEqual(["3", "true", "7", ""]);
  });

  test("no format: the compact text", () => {
    expect(texts(faceOf({ a: num(3), b: num(2.5), c: num(1 / 3) }, undefined))).toEqual([
      "3",
      "2.5",
      "0.3333",
    ]);
    expect(texts(faceOf({ a: num(3) }, {}))).toEqual(["3"]);
  });

  test("an editor element's resting text is formatted too", () => {
    const d = faceOf({ hp: num(3) }, { sign: "always" }, "editor");
    expect(d.primitives[0]).toMatchObject({ kind: "editor", cell: "hp", text: "+3" });
  });
});

describe("formatFaceNumber", () => {
  test("decimals round half away from zero", () => {
    expect(formatFaceNumber(2.125, "2.13", { decimals: 2 })).toBe("2.13");
    expect(formatFaceNumber(-2.5, "-2.5", { decimals: 0 })).toBe("-3");
    expect(formatFaceNumber(2.5, "2.5", { decimals: 0 })).toBe("3");
    expect(formatFaceNumber(1 / 3, "0.3333", { decimals: 2 })).toBe("0.33");
  });

  test("a value rounding to zero has no sign", () => {
    expect(formatFaceNumber(-0.004, "0", { decimals: 2 })).toBe("0.00");
    expect(formatFaceNumber(0.004, "0", { sign: "always", decimals: 2 })).toBe("0.00");
    expect(formatFaceNumber(0.001, "0", { sign: "always" })).toBe("0");
  });

  test("sign auto writes only the minus; a non-finite number is left alone", () => {
    expect(formatFaceNumber(3, "3", { sign: "auto" })).toBe("3");
    expect(formatFaceNumber(-3, "-3", { sign: "auto" })).toBe("-3");
    expect(formatFaceNumber(Number.POSITIVE_INFINITY, "Infinity", { sign: "always" })).toBe(
      "Infinity",
    );
  });

  test("decimals write fixed point at and above 1e21, where toFixed turns exponential", () => {
    expect(formatFaceNumber(1e21, "1e+21", { decimals: 0 })).toBe("1000000000000000000000");
    expect(formatFaceNumber(1e21, "1e+21", { decimals: 2 })).toBe("1000000000000000000000.00");
    expect(formatFaceNumber(-1e21, "-1e+21", { decimals: 0 })).toBe("-1000000000000000000000");
    expect(formatFaceNumber(-1e21, "-1e+21", { decimals: 2 })).toBe("-1000000000000000000000.00");
    expect(formatFaceNumber(1.5e21, "1.5e+21", { decimals: 0 })).toBe("1500000000000000000000");
    expect(formatFaceNumber(1.5e21, "1.5e+21", { decimals: 2 })).toBe("1500000000000000000000.00");
    expect(formatFaceNumber(-1.5e21, "-1.5e+21", { decimals: 2 })).toBe(
      "-1500000000000000000000.00",
    );
    expect(formatFaceNumber(1e21, "1e+21", { sign: "always", decimals: 2 })).toBe(
      "+1000000000000000000000.00",
    );
    expect(formatFaceNumber(-1e21, "-1e+21", { sign: "always", decimals: 0 })).toBe(
      "-1000000000000000000000",
    );
  });

  test("just below 1e21 the toFixed path stands", () => {
    const below = Number(999999999999999868928n); // the largest double under 1e21
    expect(below).toBeLessThan(1e21);
    expect(formatFaceNumber(below, "1e+21", { decimals: 2 })).toBe("999999999999999868928.00");
    expect(formatFaceNumber(-below, "-1e+21", { decimals: 0 })).toBe("-999999999999999868928");
  });
});
