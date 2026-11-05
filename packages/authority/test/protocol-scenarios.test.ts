/**
 * Every production scenario over the protocol (vtt-5su.12, vtt-1xv.13;
 * FIXTURES.md §1–§8, §11; DESIGN.md §5.2): `runScenarioOverProtocol` drives
 * a real server on port 0 through a `ProtocolClient` and must report what
 * the direct runner reports (every scenario complete, nothing skipped), with
 * the same stored state after setup and after every step and the same log
 * at the end.
 */
import { canonicalJson, ScenarioError, storedStateEqual } from "@vtt/authority";
import type { Expectation, Scenario, Step } from "@vtt/fixtures";
import type { DocumentResult, ProtocolClient } from "@vtt/protocol";
import type { Snapshot } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import {
  closeAllSessions,
  openSession,
  type ProtocolSession,
  runScenarioOverProtocol,
} from "./protocol-runner/run";
import { base, n, r, raw, valid } from "./runner/helpers";
import { loadScenarioFile, scenarioFiles } from "./runner/load";
import { type RunReport, runScenario, ScenarioFailure, type StepReport } from "./runner/run";
import { applyStep, newRunState } from "./runner/steps";

afterEach(closeAllSessions, 60_000);

type Expected = Omit<RunReport, "title">;

const complete = (k: number): Expected => ({
  complete: true,
  stepsRun: k,
  stepsTotal: k,
  skipped: {},
});
/**
 * The coverage table (vtt-75c.13's, as vtt-1xv.10 left the direct runner):
 * since vtt-1xv.13 the protocol runner runs `invoke` and checks `action`
 * and `face_element`, so every scenario is complete over the protocol too.
 */
const EXPECTED: Record<string, Expected> = {
  "hit-points.json": complete(5),
  "difficult-terrain.json": complete(4),
  "re-hiding-room.json": complete(6),
  "goblin-hit.json": complete(6),
  "attack-card.json": complete(7),
  "fireball.json": complete(12),
  "die-with-modifier.json": complete(7),
  "dice-tray.json": complete(10),
  "drawing-a-card.json": complete(4),
  "shuffling.json": complete(2),
};

/** The direct runner's log at the end of `scenario`: its steps applied without expectations. */
function directLog(scenario: Scenario): unknown {
  const state = newRunState(scenario);
  for (const step of scenario.steps) applyStep(state, step);
  return state.table.store.history.toLog();
}

test("the table names every scenario file", async () => {
  expect((await scenarioFiles()).sort()).toEqual(Object.keys(EXPECTED).sort());
});

describe("parity with the in-process runner", () => {
  test.each(Object.entries(EXPECTED))(
    "%s",
    async (file, expected) => {
      const scenario = await loadScenarioFile(file);
      const direct: StepReport[] = [];
      const wire: StepReport[] = [];
      let wireLog: unknown;
      const directReport = runScenario(scenario, { onStep: (s) => direct.push(s) });
      const wireReport = await runScenarioOverProtocol(scenario, {
        onStep: (s) => wire.push(s),
        onEnd: (doc) => {
          wireLog = doc.log;
        },
      });
      expect(wireReport).toEqual({ title: scenario.title, ...expected });
      expect(wireReport).toEqual(directReport);
      expect(wire.map((s) => s.step)).toEqual(direct.map((s) => s.step));
      expect(wire).toHaveLength(directReport.stepsRun + 1);
      expect(canonicalJson(wireLog), `${file}: the log`).toBe(canonicalJson(directLog(scenario)));
      direct.forEach((d, i) => {
        const w = wire[i] as StepReport;
        const equal = storedStateEqual(d.snapshot, w.snapshot, {
          ignoreRevision: false,
          ignoreIdentity: false,
        });
        expect(equal, `${file}: snapshot after step ${d.step}`).toBe(true);
      });
    },
    60_000,
  );
});

/** Aldric with `position` a formula (placement `[3, 4]` written as a formula). */
function formulaPosition(steps: Scenario["steps"]): Scenario {
  const b = base();
  const [aldric] = b.setup.objects;
  return valid({
    setup: {
      ...b.setup,
      objects: [
        {
          ...aldric,
          id: "aldric",
          placement: { board: "table", position: { type: "formula", source: "[3, 4]" } },
        },
      ],
    },
    steps,
  });
}

const point = (x: number, y: number) => ({ type: "list" as const, items: [n(x), n(y)] });

describe("kind decides set and override", () => {
  test("set on a structural cell holding a formula (position) is a scenario error in both runners", async () => {
    const s = formulaPosition([
      {
        actor: "gm",
        do: { type: "set", object: "aldric", cell: "position", value: point(5, 6) },
      },
    ]);
    expect(() => runScenario(s)).toThrow(ScenarioError);
    expect(() => runScenario(s)).toThrow(/step 0.*holds a formula/);
    await expect(runScenarioOverProtocol(s)).rejects.toThrow(ScenarioError);
    await expect(runScenarioOverProtocol(s)).rejects.toThrow(/step 0.*holds a formula/);
  });

  test("override on it is accepted in both runners", async () => {
    const s = formulaPosition([
      {
        actor: "gm",
        do: { type: "override", object: "aldric", cell: "position", value: point(5, 6) },
        expect: [
          { type: "placement", object: "aldric", board: "table", position: [5, 6] },
          { type: "override", object: "aldric", cell: "position", overridden: true },
          { type: "log_groups", count: 1 },
        ],
      },
    ]);
    const report = { title: "Synthetic", ...complete(1) };
    expect(runScenario(s)).toEqual(report);
    expect(await runScenarioOverProtocol(s)).toEqual(report);
  });

  test("override on a literal cell and clear_override without an override are scenario errors", async () => {
    const lit = valid({
      steps: [
        { actor: "gm", do: { type: "override", object: "aldric", cell: "max_hp", value: n(3) } },
      ],
    });
    expect(() => runScenario(lit)).toThrow(ScenarioError);
    await expect(runScenarioOverProtocol(lit)).rejects.toThrow(/step 0.*does not hold a formula/);
    const clear = valid({
      steps: [{ actor: "gm", do: { type: "clear_override", object: "aldric", cell: "hp" } }],
    });
    expect(() => runScenario(clear)).toThrow(ScenarioError);
    await expect(runScenarioOverProtocol(clear)).rejects.toThrow(/step 0.*has none/);
  });
});

describe("expectations over the wire", () => {
  test("the structural id cell reads as the object's id, in expectations and in bind.where", async () => {
    const b = base();
    const s = valid({
      setup: {
        ...b.setup,
        objects: [
          ...b.setup.objects,
          { id: "bob", tag: ["pc"], placement: { board: "table", position: [1, 1] } },
        ],
      },
      expect: [
        { type: "cell", object: "aldric", cell: "id", value: { type: "text", value: "aldric" } },
      ],
      steps: [
        {
          do: {
            type: "bind",
            as: "who",
            tag: "pc",
            where: { cell: "id", value: { type: "text", value: "bob" } },
          },
          expect: [
            { type: "cell", object: "who", cell: "id", value: { type: "text", value: "bob" } },
          ],
        },
      ],
    });
    const report = { title: "Synthetic", ...complete(1) };
    expect(runScenario(s)).toEqual(report);
    expect(await runScenarioOverProtocol(s)).toEqual(report);
  });

  /** Aldric, a goblin hidden from him, and a note everyone sees whose `target` names the goblin. */
  function redactedRef(): Scenario {
    const b = base();
    return valid({
      setup: {
        ...b.setup,
        objects: [
          ...b.setup.objects,
          {
            id: "goblin",
            placement: { board: "table", position: [9, 9] },
            cells: { visible_to: { type: "viewers", viewers: ["gm"] } },
          },
          {
            id: "note",
            placement: { board: "table", position: [1, 1] },
            cells: { target: r("goblin") },
          },
        ],
      },
      expect: [
        { type: "object_visible", object: "goblin", viewer: "aldric", visible: false },
        { type: "cell_visible", object: "note", cell: "target", viewer: "aldric", visible: true },
        { type: "cell_visible", object: "goblin", cell: "name", viewer: "aldric", visible: false },
      ],
    });
  }

  test("cell_visible holds for a cell whose value is redacted in the viewer's view", async () => {
    const s = redactedRef();
    const session = await openSession(s);
    const seen = await session.client.request("get_objects", {
      ids: ["note"],
      viewer: { type: "character", id: "aldric" },
    });
    expect(seen.objects[0]?.cells.target?.value).toEqual({ type: "redacted" });
    await session.close();
    const report = { title: "Synthetic", ...complete(0) };
    expect(runScenario(s)).toEqual(report);
    expect(await runScenarioOverProtocol(s)).toEqual(report);
  });

  test("a predicted rejection passes in both runners; an unpredicted one fails in both", async () => {
    const protectedSet = (expect: Scenario["steps"][number]["expect"]) =>
      valid({
        steps: [
          {
            actor: "gm",
            do: {
              type: "set",
              object: "aldric",
              cell: "contents",
              value: { type: "list", items: [] },
            },
            expect,
          },
        ],
      });
    const ok = protectedSet([
      { type: "rejected", reason: { type: "protected_cell" } },
      { type: "log_groups", count: 0 },
    ]);
    const report = { title: "Synthetic", ...complete(1) };
    expect(runScenario(ok)).toEqual(report);
    expect(await runScenarioOverProtocol(ok)).toEqual(report);
    const bad = protectedSet([]);
    expect(() => runScenario(bad)).toThrow(ScenarioFailure);
    await expect(runScenarioOverProtocol(bad)).rejects.toThrow(ScenarioFailure);
    await expect(runScenarioOverProtocol(bad)).rejects.toThrow(
      /step 0, expect rejected \(absent\)/,
    );
  });

  test("a wrong expected value fails naming the scenario, the step and the expectation", async () => {
    const s = await loadScenarioFile("hit-points.json");
    const step = s.steps[0];
    if (step === undefined) throw new Error("hit-points has steps");
    step.expect = [{ type: "cell", object: "aldric", cell: "hp", value: n(999) }];
    const run = runScenarioOverProtocol(s);
    await expect(run).rejects.toThrow(ScenarioFailure);
    await expect(runScenarioOverProtocol(s)).rejects.toThrow(
      `"${s.title}": step 0, expect #0 (cell): aldric.hp: expected {"type":"number","value":999}, got {"type":"number","value":22}`,
    );
  });

  test("the server and the client are closed after each scenario, passing or failing", async () => {
    const seen: ProtocolSession[] = [];
    const s = await loadScenarioFile("hit-points.json");
    await runScenarioOverProtocol(s, { onSession: (x) => seen.push(x) });
    const failing = structuredClone(s);
    (failing.steps[0] as Scenario["steps"][number]).expect = [
      { type: "cell", object: "aldric", cell: "hp", value: n(1) },
    ];
    await expect(
      runScenarioOverProtocol(failing, { onSession: (x) => seen.push(x) }),
    ).rejects.toThrow(ScenarioFailure);
    expect(seen).toHaveLength(2);
    for (const x of seen) {
      expect(x.closed).toBe(true);
      expect((x.client as ProtocolClient).state).toBe("closed");
      await expect(refused(x.server.url)).resolves.toBe(true);
    }
  });

  test("onStep observes copies: mutating them does not change the run", async () => {
    const s = await loadScenarioFile("hit-points.json");
    const plain: Snapshot[] = [];
    await runScenarioOverProtocol(s, { onStep: (x) => plain.push(structuredClone(x.snapshot)) });
    const copies: Snapshot[] = [];
    const report = await runScenarioOverProtocol(s, {
      onStep: (x) => {
        copies.push(structuredClone(x.snapshot));
        x.snapshot.objects = {};
      },
    });
    expect(report).toEqual({ title: s.title, ...complete(5) });
    expect(copies).toEqual(plain);
  });
});

/** Whether a WebSocket to `url` fails to open. */
function refused(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      ws.close();
      resolve(false);
    });
    ws.addEventListener("error", () => resolve(true));
  });
}

/** `e` changed so that it no longer holds, or undefined for a type left alone. */
function falsify(e: Expectation): Expectation | undefined {
  switch (e.type) {
    case "cell":
      return {
        ...e,
        value:
          e.value.type === "number"
            ? n(e.value.value + 1)
            : e.value.type === "boolean"
              ? { type: "boolean", value: !e.value.value }
              : n(12345),
      };
    case "cell_error":
      return { ...e, code: e.code === "#REF" ? "#TYPE" : "#REF" };
    case "override":
      return { ...e, overridden: !e.overridden };
    case "exists":
      return { ...e, exists: !e.exists };
    case "container":
      return { ...e, index: e.index + 1 };
    case "placement":
      return { ...e, position: [e.position[0] + 1, e.position[1]] };
    case "contents":
      return {
        ...e,
        contents: e.contents.length < 2 ? [...e.contents, e.object] : [...e.contents].reverse(),
      };
    case "cell_visible":
    case "object_visible":
      return { ...e, visible: !e.visible };
    case "log_groups":
      return { ...e, count: e.count + 1 };
    case "log_includes":
      return { ...e, effect: { ...e.effect, cell: "no_such_cell" } };
    case "action":
      return { ...e, enabled: !e.enabled };
    case "face_element":
      return { ...e, shown: !e.shown };
    default:
      return undefined;
  }
}

/** How a run ended: "ok", or the error's class and message (a log_includes message without its effect dump, whose encoding differs). */
async function ending(run: () => unknown): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return `${err.name}: ${err.message.replace(/; its cell effects: .*$/, "")}`;
  }
}

test("every falsified expectation fails the same way in both runners", async () => {
  let count = 0;
  for (const file of Object.keys(EXPECTED)) {
    const s = await loadScenarioFile(file);
    const lists = [s.expect ?? [], ...s.steps.map((step) => step.expect ?? [])];
    for (const [li, list] of lists.entries()) {
      for (const [ei, e] of list.entries()) {
        const wrong = falsify(e);
        if (wrong === undefined) continue;
        const m = structuredClone(s);
        const owner: { expect?: Expectation[] } = li === 0 ? m : (m.steps[li - 1] as Step);
        const target = [...(owner.expect ?? [])];
        target[ei] = wrong;
        owner.expect = target;
        const direct = await ending(() => runScenario(m));
        const wire = await ending(() => runScenarioOverProtocol(m));
        expect(wire, `${file}, list ${li}, expect #${ei}`).toBe(direct);
        count++;
      }
    }
  }
  expect(count).toBeGreaterThan(200);
}, 60_000);

describe("invoke, action and face_element over the wire (vtt-1xv.13)", () => {
  const roll14 = { type: "roll" as const, expr: "1d20", dice: [14], dropped: [], total: 14 };
  const roll3d6 = { type: "roll" as const, expr: "1d6", dice: [3], dropped: [], total: 3 };

  /** Aldric with actions and a face (test/runner/invoke.test.ts's): buttons 0 Hurt, 1 Roll; 2 a GM-only value. */
  function setup(): Scenario["setup"] {
    const b = base().setup;
    const [aldric] = b.objects;
    return {
      ...b,
      objects: [
        {
          ...aldric,
          id: "aldric",
          cells: { ...aldric?.cells, value: { type: "empty" }, secret: n(7) },
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
            collapsed: [
              { type: "value", cell: "name", rect: [0, 0, 6, 0.6], show_when: "hp < 27" },
            ],
            default_action: "Hurt",
          },
        },
        {
          id: "goblin",
          placement: { board: "table", position: [9, 9] },
          cells: { visible_to: { type: "viewers", viewers: ["gm"] } },
          face: { elements: [{ type: "value", cell: "name", rect: [0, 0, 1, 1] }] },
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
    more: { list?: "full" | "collapsed"; viewer?: string; object?: string } = {},
  ): Expectation => ({ type: "face_element", object: "aldric", element, shown, ...more });
  const scenario = (steps: Step[], patch: Partial<Scenario> = {}): Scenario =>
    valid({ setup: setup(), steps, ...patch });

  /** Both runners end the same way; returns that ending. */
  async function agree(s: Scenario): Promise<string> {
    const direct = await ending(() => runScenario(s));
    const wire = await ending(() => runScenarioOverProtocol(s));
    expect(wire).toBe(direct);
    return wire;
  }

  test("an invoke by a character runs as one group with the same snapshot, log and roll", async () => {
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
        invoke("Hurt", [{ type: "cell", object: "aldric", cell: "hp", value: n(22) }], "gm"),
      ],
      { dice: [roll14] },
    );
    let log: DocumentResult["log"] | undefined;
    const wire: StepReport[] = [];
    const direct: StepReport[] = [];
    expect(runScenario(s, { onStep: (x) => direct.push(x) })).toEqual({
      title: "Synthetic",
      ...complete(2),
    });
    expect(
      await runScenarioOverProtocol(s, {
        onStep: (x) => wire.push(x),
        onEnd: (doc) => {
          log = doc.log;
        },
      }),
    ).toEqual({ title: "Synthetic", ...complete(2) });
    expect(wire.map((x) => x.step)).toEqual([-1, 0, 1]);
    wire.forEach((w, i) => {
      expect(storedStateEqual((direct[i] as StepReport).snapshot, w.snapshot)).toBe(true);
    });
    expect(canonicalJson(log)).toBe(canonicalJson(directLog(s)));
    expect(log?.groups.map((g) => [g.kind, g.label, g.actor])).toEqual([
      ["action", "Roll", { type: "character", id: "aldric" }],
      ["action", "Hurt", { type: "gm" }],
    ]);
  });

  test("the action refusals map through toFixtureReason as in the direct runner", async () => {
    const ok = scenario(
      [
        invoke("Roll"),
        invoke("Roll", [
          { type: "rejected", reason: { type: "when_false" } },
          { type: "log_groups", count: 1 },
        ]),
        invoke("Broken", [{ type: "rejected", reason: { type: "when_error", code: "#DIV0" } }]),
        invoke("Divide", [
          { type: "rejected", reason: { type: "step_error", code: "#DIV0" } },
          { type: "cell", object: "aldric", cell: "damage_taken", value: n(0) },
        ]),
        invoke("Divide", [{ type: "rejected", reason: { type: "step_error" } }]),
        invoke("Retag", [{ type: "rejected", reason: { type: "protected_cell" } }]),
        invoke("Typo", [{ type: "rejected", reason: { type: "step_error", code: "#TYPE" } }]),
      ],
      { dice: [roll14] },
    );
    expect(await agree(ok)).toBe("ok");
    expect(await agree(scenario([setDamage(27), invoke("Hurt")]))).toBe(
      'ScenarioFailure: "Synthetic": step 1, expect rejected (absent): the step was refused: when_false',
    );
    expect(
      await agree(
        scenario([
          invoke("Broken", [{ type: "rejected", reason: { type: "when_error", code: "#REF" } }]),
        ]),
      ),
    ).toMatch(/^ScenarioFailure: .*expected \{"type":"when_error","code":"#REF"\}, got when_error/);
    expect(
      await agree(
        scenario([invoke("Hurt", [{ type: "rejected", reason: { type: "when_false" } }])]),
      ),
    ).toMatch(/^ScenarioFailure: .*but the step was not refused$/);
    expect(await agree(raw({ setup: setup(), steps: [invoke("Fly")] }))).toMatch(
      /^ScenarioError: "Synthetic": step 0: the table refused the step as invalid/,
    );
  });

  test("dice: a mismatch is a scenario error in both; an unused entry names the last step", async () => {
    const wire = await ending(() =>
      runScenarioOverProtocol(scenario([invoke("Roll")], { dice: [roll3d6] })),
    );
    expect(wire).toMatch(/^(ScenarioError|Error): "Synthetic": step 0 \(invoke\): /);
    expect(await agree(scenario([invoke("Roll")], { dice: [roll14, roll14] }))).toBe(
      'ScenarioError: "Synthetic": after step 0, expect dice script exhausted: 1 scripted dice entry unused',
    );
  });

  test("action expectations read explain_action's enabled", async () => {
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
    expect(await agree(s)).toBe("ok");
    expect(
      await agree(scenario([setDamage(27, [action("Roll", true), action("Hurt", true)])])),
    ).toBe(
      'ScenarioFailure: "Synthetic": step 0, expect #1 (action): aldric[Hurt]: expected enabled true, got false (guard hp > 0 is {"type":"boolean","value":false})',
    );
    expect(await agree(scenario([], { expect: [action("Broken", true)] }))).toMatch(
      /^ScenarioFailure: .*aldric\[Broken\]: expected enabled true, got false \(guard 1 \/ 0 is /,
    );
    expect(await agree(scenario([], { expect: [action("Divide", false)] }))).toMatch(
      /got true \(no guard\)$/,
    );
    expect(await agree(raw({ setup: setup(), expect: [action("Fly", true)] }))).toMatch(
      /^ScenarioError: "Synthetic": setup, expect #0 \(action\): aldric has no action "Fly"$/,
    );
  });

  test("face_element reads the viewer's face view by index", async () => {
    const s = scenario(
      [
        invoke("Hurt", [
          face(0, false),
          face(0, false, { viewer: "aldric" }),
          face(1, true),
          face(0, true, { list: "collapsed" }),
          face(0, true, { list: "collapsed", viewer: "aldric" }),
        ]),
      ],
      {
        expect: [
          face(0, true),
          face(0, true, { viewer: "aldric" }),
          face(1, true, { viewer: "aldric" }),
          face(2, true),
          // A cell the viewer cannot read: the element is absent from its view.
          face(2, false, { viewer: "aldric" }),
          face(0, false, { list: "collapsed" }),
          // An object the viewer cannot see: not shown.
          face(0, true, { object: "goblin" }),
          face(0, false, { object: "goblin", viewer: "aldric" }),
        ],
      },
    );
    expect(await agree(s)).toBe("ok");
    expect(await agree(scenario([invoke("Hurt", [face(1, true), face(0, true)])]))).toBe(
      'ScenarioFailure: "Synthetic": step 0, expect #1 (face_element): aldric face full[0] for gm: expected shown true, got false',
    );
    expect(await agree(scenario([], { expect: [face(2, true, { viewer: "aldric" })] }))).toBe(
      'ScenarioFailure: "Synthetic": setup, expect #0 (face_element): aldric face full[2] for aldric: expected shown true, got false',
    );
    expect(await agree(scenario([], { expect: [face(3, false)] }))).toMatch(
      /^ScenarioError: "Synthetic": setup, expect #0 \(face_element\): aldric face full\[3\]: the stored list has 3 elements$/,
    );
    expect(await agree(scenario([], { expect: [face(1, false, { list: "collapsed" })] }))).toMatch(
      /^ScenarioError: .*collapsed\[1\]: the stored list has 1 elements$/,
    );
    const faceless = base();
    expect(await agree(valid({ ...faceless, expect: [face(0, false)] }))).toBe(
      'ScenarioError: "Synthetic": setup, expect #0 (face_element): aldric has no face layout',
    );
  });
});
