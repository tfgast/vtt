// @vitest-environment node
import {
  PROTOCOL_ERROR_CODES,
  type ProtocolError,
  type ProtocolRejection,
  ProtocolRejectionSchema,
} from "@vtt/protocol";
import { describeError, describeRejection } from "@vtt/ui";
import { describe, expect, test } from "vitest";

const LABELS: Record<string, string> = { aldric: "Aldric", goblin1: "Goblin", bag: "Bag" };
const refLabel = (id: string): string | null => LABELS[id] ?? null;

const cases: [ProtocolRejection, string][] = [
  [
    { type: "protected_cell", object: "goblin1", cell: "contents" },
    "Goblin.contents is protected and cannot be written.",
  ],
  [
    { type: "containment_cycle", object: "bag", container: "goblin1" },
    "Bag cannot go into Goblin: an object cannot contain itself.",
  ],
  [
    { type: "undo_conflict", target: 7, conflicting: [8, 9], message: "hp changed since" },
    "Cannot undo #7: later edits #8, #9 conflict (hp changed since).",
  ],
  [{ type: "nothing_to_undo" }, "There is nothing to undo."],
  [
    { type: "type_error", object: "door3", cell: "visible_to", expected: "viewers" },
    "door3.visible_to expects viewers.",
  ],
  [{ type: "invalid", message: "unknown board b9" }, "The edit is invalid: unknown board b9."],
  [{ type: "invalid", message: "unknown board b9." }, "The edit is invalid: unknown board b9."],
  [
    {
      type: "stale_write",
      base_revision: 3,
      revision: 6,
      floor: 0,
      truncated: false,
      conflicts: [
        { index: 0, revision: 4, actor: { type: "gm" }, label: "move goblin1", keys: [] },
        {
          index: 0,
          revision: 5,
          actor: { type: "character", id: "aldric" },
          label: "set_value goblin1.hp",
          keys: [],
        },
        {
          index: 1,
          revision: 6,
          actor: { type: "agent", name: "Scribe" },
          label: "2 edits",
          keys: [],
        },
        { index: 1, revision: 6, actor: { type: "agent" }, label: "spawn", keys: [] },
      ],
    },
    'Not applied: the table changed first ("move goblin1" by the GM, "set_value goblin1.hp" by Aldric, "2 edits" by agent Scribe, "spawn" by an agent).',
  ],
  [
    {
      type: "stale_write",
      base_revision: 3,
      revision: 900,
      floor: 600,
      truncated: true,
      conflicts: [],
    },
    "Not applied: the table changed first (and earlier changes are no longer listed).",
  ],
  [
    {
      type: "stale_write",
      base_revision: 3,
      revision: 9,
      floor: 0,
      truncated: true,
      conflicts: [
        { index: 0, revision: 4, actor: { type: "gm" }, label: "move goblin1", keys: [] },
      ],
    },
    'Not applied: the table changed first ("move goblin1" by the GM, and more).',
  ],
  [
    { type: "undo_target_changed", expected: 7, actual: 8 },
    "Not undone: the latest edit is now #8, not #7.",
  ],
  [
    { type: "undo_target_changed", expected: 7, actual: null },
    "Not undone: there is no edit left to undo, not #7.",
  ],
  [{ type: "when_false", object: "goblin1", action: "Attack" }, "Attack: its condition is false."],
  [
    { type: "when_error", object: "goblin1", action: "Attack", code: "#REF" },
    "Attack: its condition is an error (#REF).",
  ],
  [
    { type: "when_error", object: "goblin1", action: "Attack", code: "#REF", message: "no hp." },
    "Attack: its condition is an error (#REF: no hp).",
  ],
  [
    {
      type: "step_error",
      object: "fb1",
      action: "Apply",
      step: 1,
      code: "#TYPE",
      message: "add needs a number",
    },
    "Apply: step 2 failed (#TYPE: add needs a number).",
  ],
  [
    { type: "step_error", object: "fb1", action: "Apply", step: 0, message: "no object goblin9." },
    "Apply: step 1 failed (no object goblin9).",
  ],
];

describe("describeRejection", () => {
  test.each(cases)("%j", (rejection, message) => {
    expect(ProtocolRejectionSchema.safeParse(rejection).success).toBe(true);
    expect(describeRejection(rejection, refLabel)).toBe(message);
  });

  test("covers every variant of the union", () => {
    const variants = new Set(cases.map(([r]) => r.type));
    // A Record keyed by the union's tags: a new variant fails typecheck here.
    const tags: Record<ProtocolRejection["type"], true> = {
      protected_cell: true,
      containment_cycle: true,
      undo_conflict: true,
      nothing_to_undo: true,
      type_error: true,
      invalid: true,
      stale_write: true,
      undo_target_changed: true,
      when_false: true,
      when_error: true,
      step_error: true,
    };
    const all = Object.keys(tags);
    expect([...variants].sort()).toEqual([...all].sort());
  });
});

describe("describeError", () => {
  test.each(PROTOCOL_ERROR_CODES.map((code) => [code]))("%s is one sentence", (code) => {
    const error: ProtocolError = { code, message: "detail" };
    const text = describeError(error);
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toBe("");
  });

  test("keeps the server's message", () => {
    expect(describeError({ code: "bad_request", message: "missing ops" })).toBe(
      "The request was malformed (missing ops).",
    );
  });

  test("an empty message is not shown", () => {
    expect(describeError({ code: "busy", message: "" })).toBe(
      "The table is busy; try again in a moment.",
    );
  });
});
