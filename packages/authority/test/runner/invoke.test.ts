/**
 * The runner's M5 steps and expectations (FIXTURES.md §5–§8, §11; vtt-1xv.10):
 * `invoke` through the executor with the run's scripted dice, the action
 * rejections (`when_false`, `when_error`, `step_error`) under the rejection
 * protocol, `action` expectations, and `face_element` with the predicate live
 * face views use. Every failure names the scenario, the step and the
 * expectation; misuse is a ScenarioError.
 */
import { ScenarioError } from "@vtt/authority";
import * as testRunner from "@vtt/authority/test-runner";
import type { Expectation, Scenario, Step } from "@vtt/fixtures";
import { describe, expect, test } from "vitest";
import { fixtureValueEquals } from "./expect";
import { base, n, raw, valid } from "./helpers";
import { runScenario, ScenarioFailure } from "./run";
import { documentFromSetup } from "./setup";

const roll14 = { type: "roll" as const, expr: "1d20", dice: [14], dropped: [], total: 14 };
const roll3d6 = { type: "roll" as const, expr: "1d6", dice: [3], dropped: [], total: 3 };

/** Aldric of `base()` with actions and a face. Buttons: 0 Hurt (shown while unhurt), 1 Roll. */
function setup(): Scenario["setup"] {
  const b = base().setup;
  const [aldric] = b.objects;
  return {
    ...b,
    objects: [
      {
        ...aldric,
        id: "aldric",
        cells: {
          ...aldric?.cells,
          value: { type: "empty" },
          secret: n(7),
        },
        cell_visibility: { secret: { type: "viewers", viewers: ["gm"] } },
        actions: [
          { name: "Hurt", when: "hp > 0", steps: ["add(damage_taken, 5)"] },
          { name: "Roll", when: "value = empty", steps: ["roll(1d20) -> value"] },
          { name: "Broken", when: "1 / 0", steps: ["set(damage_taken, 1)"] },
          { name: "Divide", steps: ["set(damage_taken, 1)", "set(damage_taken, 1 / 0)"] },
          { name: "Retag", steps: ["set(contents, [])"] },
          { name: "Typo", steps: ["add(name, 1)"] },
        ],
        face: {
          elements: [
            {
              type: "button",
              action: "Hurt",
              rect: [-1, 0, 2, 0.5],
              show_when: "damage_taken = 0",
            },
            { type: "button", action: "Roll", rect: [-1, 0.5, 2, 0.5] },
            { type: "value", cell: "secret", rect: [-1, 1, 2, 0.5] },
          ],
          collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6], show_when: "hp < 27" }],
          default_action: "Hurt",
        },
      },
    ],
  };
}

const invoke = (action: string, expect: Expectation[] = [], actor = "aldric"): Step => ({
  actor,
  do: { type: "invoke", object: "aldric", action },
  expect,
});
const setDamage = (value: number, expect: Expectation[] = []): Step => ({
  actor: "gm",
  do: { type: "set", object: "aldric", cell: "damage_taken", value: n(value) },
  expect,
});
const action = (name: string, enabled: boolean): Expectation => ({
  type: "action",
  object: "aldric",
  action: name,
  enabled,
});
const face = (
  element: number,
  shown: boolean,
  more: { list?: "full" | "collapsed"; viewer?: string } = {},
): Expectation => ({ type: "face_element", object: "aldric", element, shown, ...more });

function scenario(steps: Step[], patch: Partial<Scenario> = {}): Scenario {
  return valid({ setup: setup(), steps, ...patch });
}

/** Runs `fn` and returns what it threw. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

const complete = (k: number) => ({
  title: "Synthetic",
  complete: true,
  stepsRun: k,
  stepsTotal: k,
  skipped: {},
});

describe.each([
  ["direct", false],
  ["round-trip", true],
])("%s", (_mode, roundTrip) => {
  const run = (s: Scenario) => runScenario(s, { roundTrip });

  describe("invoke", () => {
    test("runs the action as one group by the step's actor; every expectation holds", () => {
      const s = scenario([
        invoke("Hurt", [
          { type: "cell", object: "aldric", cell: "damage_taken", value: n(5) },
          { type: "cell", object: "aldric", cell: "hp", value: n(22) },
          { type: "log_groups", count: 1 },
          {
            type: "log_includes",
            group: -1,
            effect: { type: "write", object: "aldric", cell: "damage_taken", value: n(5) },
          },
          { type: "replay" },
        ]),
      ]);
      expect(run(s)).toEqual(complete(1));
    });

    test("consumes the scripted roll, which the log records", () => {
      const s = scenario(
        [
          invoke("Roll", [
            { type: "cell", object: "aldric", cell: "value", value: roll14 },
            {
              type: "log_includes",
              group: 0,
              effect: { type: "roll", object: "aldric", cell: "value", value: roll14 },
            },
            { type: "replay" },
          ]),
        ],
        { dice: [roll14] },
      );
      expect(run(s)).toEqual(complete(1));
    });

    test("a predicted when_false passes, consumes no dice and changes nothing", () => {
      const s = scenario(
        [
          invoke("Roll"),
          invoke("Roll", [
            { type: "rejected", reason: { type: "when_false" } },
            { type: "cell", object: "aldric", cell: "value", value: roll14 },
            { type: "log_groups", count: 1 },
          ]),
        ],
        { dice: [roll14] },
      );
      expect(run(s)).toEqual(complete(2));
    });

    test("an unpredicted when_false fails, naming scenario, step and the missing expectation", () => {
      const s = scenario([setDamage(27), invoke("Hurt")]);
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioFailure);
      expect(err.message).toBe(
        '"Synthetic": step 1, expect rejected (absent): the step was refused: when_false',
      );
    });

    test("a predicted refusal that does not happen fails, naming scenario, step and expectation", () => {
      const s = scenario([
        invoke("Hurt", [
          { type: "cell", object: "aldric", cell: "hp", value: n(22) },
          { type: "rejected", reason: { type: "when_false" } },
        ]),
      ]);
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioFailure);
      expect(err.message).toBe(
        '"Synthetic": step 0, expect #1 (rejected): expected {"type":"when_false"}, but the step was not refused',
      );
    });

    test("when_error carries the guard's code; a wrong code fails", () => {
      const ok = scenario([
        invoke("Broken", [{ type: "rejected", reason: { type: "when_error", code: "#DIV0" } }]),
      ]);
      expect(run(ok)).toEqual(complete(1));
      const bad = scenario([
        invoke("Broken", [{ type: "rejected", reason: { type: "when_error", code: "#REF" } }]),
      ]);
      const err = thrown(() => run(bad));
      expect(err).toBeInstanceOf(ScenarioFailure);
      expect(err.message).toMatch(
        /^"Synthetic": step 0, expect #0 \(rejected\): expected \{"type":"when_error","code":"#REF"\}, got when_error/,
      );
    });

    test("a step error aborts the whole action: nothing of its earlier steps stands", () => {
      const s = scenario([
        invoke("Divide", [
          { type: "rejected", reason: { type: "step_error", code: "#DIV0" } },
          { type: "cell", object: "aldric", cell: "damage_taken", value: n(0) },
          { type: "log_groups", count: 0 },
        ]),
        invoke("Divide", [{ type: "rejected", reason: { type: "step_error" } }]),
      ]);
      expect(run(s)).toEqual(complete(2));
      const wrong = scenario([
        invoke("Divide", [{ type: "rejected", reason: { type: "step_error", code: "#TYPE" } }]),
      ]);
      expect(thrown(() => run(wrong))).toBeInstanceOf(ScenarioFailure);
    });

    test("a primitive's refusal inside a step keeps its reason; a type error is step_error #TYPE", () => {
      const s = scenario([
        invoke("Retag", [{ type: "rejected", reason: { type: "protected_cell" } }]),
        invoke("Typo", [{ type: "rejected", reason: { type: "step_error", code: "#TYPE" } }]),
      ]);
      expect(run(s)).toEqual(complete(2));
    });

    test("an unknown action is refused as invalid, which is a scenario error", () => {
      const s = raw({ setup: setup(), steps: [invoke("Fly")] });
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioError);
      expect(err.message).toMatch(/^"Synthetic": step 0: the table refused the step as invalid/);
    });

    test("a dice script mismatch inside an action is a scenario error, not a rejection", () => {
      const s = scenario([invoke("Roll")], { dice: [roll3d6] });
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioError);
      expect(err.message).toMatch(/^"Synthetic": step 0 \(invoke\): /);
    });

    test("an unused script entry fails the complete run, naming the scenario and the last step", () => {
      const s = scenario([invoke("Roll")], { dice: [roll14, roll14] });
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioError);
      expect(err.message).toBe('"Synthetic": after step 0: 1 scripted dice entry unused');
    });
  });

  describe("action expectations", () => {
    test("enabled iff the guard is absent or true; a guard error is disabled", () => {
      const s = scenario(
        [
          setDamage(27, [action("Hurt", false), action("Roll", true)]),
          setDamage(0, [action("Hurt", true)]),
        ],
        {
          expect: [
            action("Hurt", true),
            action("Roll", true),
            action("Divide", true),
            action("Broken", false),
          ],
        },
      );
      expect(run(s)).toEqual(complete(2));
    });

    test("a wrong action expectation fails, naming scenario, step and expectation", () => {
      const s = scenario([setDamage(27, [action("Roll", true), action("Hurt", true)])]);
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioFailure);
      expect(err.message).toBe(
        '"Synthetic": step 0, expect #1 (action): aldric[Hurt]: expected enabled true, got false (guard hp > 0 is {"type":"boolean","value":false})',
      );
    });

    test("an action the object does not have is a scenario error", () => {
      const s = raw({ setup: setup(), expect: [action("Fly", true)] });
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioError);
      expect(err.message).toMatch(/^"Synthetic": setup, expect #0 \(action\): /);
    });
  });

  describe("face_element", () => {
    test("follows show_when, for the GM by default and for a character", () => {
      const s = scenario(
        [
          invoke("Hurt", [
            face(0, false),
            face(0, false, { viewer: "aldric" }),
            face(1, true),
            face(0, true, { list: "collapsed" }),
          ]),
        ],
        {
          expect: [
            face(0, true),
            face(0, true, { list: "full", viewer: "aldric" }),
            face(1, true, { viewer: "aldric" }),
            face(2, true),
            face(2, false, { viewer: "aldric" }),
            face(0, false, { list: "collapsed" }),
          ],
        },
      );
      expect(run(s)).toEqual(complete(1));
    });

    test("a wrong face_element fails, naming scenario, step and expectation", () => {
      const s = scenario([invoke("Hurt", [face(1, true), face(0, true)])]);
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioFailure);
      expect(err.message).toBe(
        '"Synthetic": step 0, expect #1 (face_element): aldric face full[0] for gm: expected shown true, got false',
      );
    });

    test("an element index outside the stored list is a scenario error", () => {
      const s = scenario([], { expect: [face(3, false)] });
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioError);
      expect(err.message).toMatch(/^"Synthetic": setup, expect #0 \(face_element\): .*full\[3\]/);
      const collapsed = scenario([], { expect: [face(1, false, { list: "collapsed" })] });
      expect(thrown(() => run(collapsed))).toBeInstanceOf(ScenarioError);
    });

    test("an object without a face layout is a scenario error", () => {
      const s = valid({ expect: [face(0, false)] });
      const err = thrown(() => run(s));
      expect(err).toBeInstanceOf(ScenarioError);
      expect(err.message).toMatch(/aldric has no face layout/);
    });
  });
});

describe("setup", () => {
  test("documentFromSetup copies a setup face verbatim", () => {
    const s = setup();
    const doc = documentFromSetup(s);
    expect(doc.objects.aldric?.face).toEqual(s.objects[0]?.face);
    expect(doc.objects.aldric?.face).not.toBe(s.objects[0]?.face);
  });

  test("an object without face has no layout", () => {
    expect("face" in (documentFromSetup(base().setup).objects.aldric ?? {})).toBe(false);
  });
});

test("@vtt/authority/test-runner re-exports the runner for other packages (M5-D22)", () => {
  expect(testRunner.documentFromSetup).toBe(documentFromSetup);
  expect(testRunner.runScenario).toBe(runScenario);
  expect(testRunner.fixtureValueEquals).toBe(fixtureValueEquals);
  const report: testRunner.RunReport = testRunner.runScenario(valid({}));
  expect(report.complete).toBe(true);
});
