/**
 * M5 action contracts on the wire (PROTOCOL.md §2, §7.2, §7.6, §10, §12):
 * the action refusal variants in results, the advertised action limits, and
 * `ActionDefinitionView` in views, effects and snapshots.
 */
import {
  type ActionDefinitionView,
  ActionDefinitionViewSchema,
  type ActionView,
  LIMITS,
  type MethodName,
  ObjectViewSchema,
  type ProtocolRejection,
  ProtocolRejectionSchema,
  parseResult,
  parseServerMessage,
  type Welcome,
} from "@vtt/protocol";
import { MAX_ACTION_WRITES, MAX_EACH_ITEMS, MAX_FACE_ELEMENTS } from "@vtt/schema";
import { describe, expect, expectTypeOf, test } from "vitest";

/** Runs both client stages on a success response: envelope, then `parseResult`. */
function twoStage(method: MethodName, result: unknown) {
  const env = parseServerMessage(JSON.stringify({ type: "response", id: "r1", ok: true, result }));
  if (env.ok !== true) throw new Error(`envelope failed: ${JSON.stringify(env)}`);
  expect(env.warnings).toEqual([]);
  const message = env.message;
  if (message.type !== "response" || !message.ok) throw new Error("not a success response");
  return parseResult(method, message.result);
}

const refusals: [string, ProtocolRejection][] = [
  ["when_false", { type: "when_false", object: "goblin1", action: "Attack" }],
  [
    "when_error with a message",
    { type: "when_error", object: "goblin1", action: "Attack", code: "#REF", message: "no hp" },
  ],
  [
    "when_error without a message",
    { type: "when_error", object: "goblin1", action: "Attack", code: "#SYNTAX" },
  ],
  [
    "step_error with a code",
    {
      type: "step_error",
      object: "fb1",
      action: "Apply",
      step: 1,
      code: "#LIMIT",
      message: "more than 1000 items",
    },
  ],
  [
    "step_error without a code",
    { type: "step_error", object: "fb1", action: "Apply", step: 0, message: "no object goblin9" },
  ],
];

describe("action refusals in a rejected TransactResult", () => {
  test.each(refusals)("%s", (_, rejection) => {
    const result = { status: "rejected", rejection, op_index: 0 };
    expect(twoStage("transact", result)).toEqual({ ok: true, value: result, warnings: [] });
  });

  test.each(refusals)("%s strips an unknown key (forward compatible)", (_, rejection) => {
    const parsed = ProtocolRejectionSchema.safeParse({ ...rejection, future: 1 });
    expect(parsed.success && parsed.data).toEqual(rejection);
  });

  test("a malformed refusal fails the result", () => {
    const bad: unknown[] = [
      { type: "when_false", object: "goblin1" },
      { type: "when_error", object: "goblin1", action: "Attack" },
      { type: "when_error", object: "goblin1", action: "Attack", code: "#NOPE" },
      { type: "step_error", object: "fb1", action: "Apply", message: "x" },
      { type: "step_error", object: "fb1", action: "Apply", step: -1, message: "x" },
      { type: "step_error", object: "fb1", action: "Apply", step: 0 },
    ];
    for (const rejection of bad) {
      const parsed = twoStage("transact", { status: "rejected", rejection });
      expect(parsed.ok, JSON.stringify(rejection)).toBe(false);
    }
  });
});

describe("advertised action limits (M5-D5)", () => {
  test("LIMITS carries the three M5 limits from @vtt/schema", () => {
    expect(LIMITS.max_each_items).toBe(1000);
    expect(LIMITS.max_action_writes).toBe(10000);
    expect(LIMITS.max_face_elements).toBe(200);
    expect(LIMITS.max_each_items).toBe(MAX_EACH_ITEMS);
    expect(LIMITS.max_action_writes).toBe(MAX_ACTION_WRITES);
    expect(LIMITS.max_face_elements).toBe(MAX_FACE_ELEMENTS);
  });

  const welcome: Welcome = {
    type: "welcome",
    protocol: 1,
    session: "s-1",
    actor: { type: "gm" },
    revision: 0,
    boards: [{ id: "map" }],
    table: { name: "game.json", path: null, id: null },
    limits: { ...LIMITS },
  };

  test("a welcome carrying LIMITS round-trips through parseServerMessage", () => {
    const parsed = parseServerMessage(JSON.stringify(welcome));
    expect(parsed).toEqual({ ok: true, message: welcome, warnings: [] });
    if (!parsed.ok || parsed.message.type !== "welcome") throw new Error("not a welcome");
    expect(parsed.message.limits.max_each_items).toBe(1000);
    expect(parsed.message.limits.max_action_writes).toBe(10000);
    expect(parsed.message.limits.max_face_elements).toBe(200);
  });

  test.each(["max_each_items", "max_action_writes", "max_face_elements"] as const)(
    "the welcome declares %s",
    (key) => {
      const { [key]: _, ...without } = LIMITS;
      expect(parseServerMessage(JSON.stringify({ ...welcome, limits: without })).ok).toBe(false);
      const wrong = { ...LIMITS, [key]: LIMITS[key] + 1 };
      expect(parseServerMessage(JSON.stringify({ ...welcome, limits: wrong })).ok).toBe(false);
    },
  );
});

describe("ActionDefinitionView (M5-D23)", () => {
  const gm: ActionDefinitionView = { name: "Attack", when: "hp > 0", steps: ["roll(1d20)"] };
  const character: ActionDefinitionView = { name: "Attack" };
  /** Live state a definition never carries (vtt-1xv.12's `ActionStateView`). */
  const live = { enabled: false, reason: "when_false" };

  test("ActionView is the same type", () => {
    expectTypeOf<ActionView>().toEqualTypeOf<ActionDefinitionView>();
  });

  test("GM and character shapes; live fields are stripped", () => {
    expect(ActionDefinitionViewSchema.parse(gm)).toEqual(gm);
    expect(ActionDefinitionViewSchema.parse(character)).toEqual(character);
    expect(ActionDefinitionViewSchema.parse({ ...gm, ...live })).toEqual(gm);
    expect(ActionDefinitionViewSchema.safeParse({ when: "true" }).success).toBe(false);
  });

  test("object views' actions are definitions", () => {
    const view = {
      id: "goblin1",
      is_template: false,
      is_character: false,
      cells: {},
      actions: [{ ...gm, ...live }],
    };
    expect(ObjectViewSchema.parse(view).actions).toEqual([gm]);
  });

  test("field actions effects and snapshots validate with definitions and no live fields", () => {
    const snapshot = {
      id: "goblin1",
      is_template: false,
      is_zone: false,
      is_character: false,
      cells: {},
      actions: [gm],
    };
    const group = {
      index: 3,
      revision: 4,
      actor: { type: "gm" },
      kind: "edit",
      label: "set actions",
      base_revision: 3,
      undone: false,
      names: { goblin1: "Goblin" },
      effects: [
        {
          type: "field",
          object: "goblin1",
          field: "actions",
          before: [character],
          after: [gm],
        },
        {
          type: "create",
          location: { type: "board", board: "map" },
          objects: [snapshot],
        },
      ],
    };
    const result = {
      revision: 4,
      floor: 0,
      groups: [group],
      truncated: false,
      more: false,
      next_revision: 4,
    };
    expect(twoStage("changes_since", result)).toEqual({ ok: true, value: result, warnings: [] });

    // Live fields on a definition are not part of the shape: stripped.
    const withLive = structuredClone(result);
    const effects = withLive.groups[0]?.effects ?? [];
    Object.assign((effects[0] as { after: object[] }).after[0] as object, live);
    Object.assign(
      (effects[1] as { objects: { actions: object[] }[] }).objects[0]?.actions[0] as object,
      live,
    );
    expect(twoStage("changes_since", withLive)).toEqual({ ok: true, value: result, warnings: [] });
  });
});
