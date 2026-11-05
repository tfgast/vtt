/**
 * The action refusals of FORMULAS.md §8.1 (M5-D6) and the action limits of
 * PROTOCOL.md §10 (M5-D5).
 */
import {
  MAX_ACTION_WRITES,
  MAX_EACH_ITEMS,
  MAX_FACE_ELEMENTS,
  type Rejection,
  RejectionSchema,
  toFixtureReason,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";

/** Parse a JSON copy, so the input shares nothing with the expectation. */
const roundTrip = (r: Rejection): Rejection => RejectionSchema.parse(JSON.parse(JSON.stringify(r)));

const whenFalse: Rejection = { type: "when_false", object: "goblin1", action: "Attack" };
const whenError: Rejection = {
  type: "when_error",
  object: "goblin1",
  action: "Attack",
  code: "#REF",
  message: "no cell hp",
};
const whenErrorBare: Rejection = {
  type: "when_error",
  object: "goblin1",
  action: "Attack",
  code: "#SYNTAX",
};
const stepError: Rejection = {
  type: "step_error",
  object: "fb1",
  action: "Apply",
  step: 2,
  code: "#LIMIT",
  message: "more than 1000 each items",
};
const stepErrorBare: Rejection = {
  type: "step_error",
  object: "fb1",
  action: "Apply",
  step: 0,
  message: "no object goblin9",
};

const variants: [string, Rejection][] = [
  ["when_false", whenFalse],
  ["when_error with a message", whenError],
  ["when_error without a message", whenErrorBare],
  ["step_error with a code", stepError],
  ["step_error without a code", stepErrorBare],
];

describe("RejectionSchema: action refusals", () => {
  test.each(variants)("round-trips %s", (_, r) => {
    expect(roundTrip(r)).toEqual(r);
  });

  test.each(variants)("rejects an unknown key on %s", (_, r) => {
    expect(RejectionSchema.safeParse({ ...r, extra: 1 }).success).toBe(false);
  });

  test("when_false needs object and action", () => {
    expect(RejectionSchema.safeParse({ type: "when_false" }).success).toBe(false);
    expect(RejectionSchema.safeParse({ type: "when_false", object: "a" }).success).toBe(false);
    expect(RejectionSchema.safeParse({ type: "when_false", action: "x" }).success).toBe(false);
  });

  test("when_error needs a known error code", () => {
    const { code: _, ...noCode } = whenErrorBare as Extract<Rejection, { type: "when_error" }>;
    expect(RejectionSchema.safeParse(noCode).success).toBe(false);
    expect(RejectionSchema.safeParse({ ...whenErrorBare, code: "#NOPE" }).success).toBe(false);
  });

  test("step_error needs a non-negative integer step and a message", () => {
    expect(RejectionSchema.safeParse({ ...stepError, step: -1 }).success).toBe(false);
    expect(RejectionSchema.safeParse({ ...stepError, step: 1.5 }).success).toBe(false);
    const { message: _, ...noMessage } = stepError as Extract<Rejection, { type: "step_error" }>;
    expect(RejectionSchema.safeParse(noMessage).success).toBe(false);
    const { step: _s, ...noStep } = stepError as Extract<Rejection, { type: "step_error" }>;
    expect(RejectionSchema.safeParse(noStep).success).toBe(false);
    expect(RejectionSchema.safeParse({ ...stepError, code: "#NOPE" }).success).toBe(false);
  });
});

describe("toFixtureReason: action refusals (FIXTURES.md §6)", () => {
  test.each<[string, Rejection, ReturnType<typeof toFixtureReason>]>([
    ["when_false", whenFalse, { type: "when_false" }],
    ["when_error", whenError, { type: "when_error", code: "#REF" }],
    ["when_error #SYNTAX", whenErrorBare, { type: "when_error", code: "#SYNTAX" }],
    ["step_error with a code", stepError, { type: "step_error", code: "#LIMIT" }],
    ["step_error without a code", stepErrorBare, { type: "step_error" }],
  ])("%s", (_, r, reason) => {
    expect(toFixtureReason(r)).toEqual(reason);
  });

  test("a step_error without a code maps to a reason with no code key", () => {
    expect(Object.keys(toFixtureReason(stepErrorBare) ?? {})).toEqual(["type"]);
  });
});

describe("action limits (PROTOCOL.md §10, M5-D5)", () => {
  test("values", () => {
    expect(MAX_EACH_ITEMS).toBe(1000);
    expect(MAX_ACTION_WRITES).toBe(10000);
    expect(MAX_FACE_ELEMENTS).toBe(200);
  });
});
