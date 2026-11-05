/**
 * Every production scenario over the protocol (vtt-5su.12; FIXTURES.md
 * §1–§8, §11; DESIGN.md §5.2): `runScenarioOverProtocol` drives a real
 * server on port 0 through a `ProtocolClient` and must report what the
 * in-process M2 runner reports, with the same stored state after setup and
 * after every executed step.
 */
import { ScenarioError, storedStateEqual } from "@vtt/authority";
import type { Expectation, Scenario, Step } from "@vtt/fixtures";
import type { ProtocolClient } from "@vtt/protocol";
import type { Snapshot } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import {
  closeAllSessions,
  openSession,
  type ProtocolSession,
  runScenarioOverProtocol,
} from "./protocol-runner/run";
import { base, n, r, valid } from "./runner/helpers";
import { loadScenarioFile, scenarioFiles } from "./runner/load";
import { type RunReport, runScenario, ScenarioFailure, type StepReport } from "./runner/run";

afterEach(closeAllSessions, 60_000);

type Expected = Omit<RunReport, "title">;

const complete = (k: number): Expected => ({
  complete: true,
  stepsRun: k,
  stepsTotal: k,
  skipped: {},
});
const partial = (run: number, total: number, skipped: Record<string, number> = {}): Expected => ({
  complete: false,
  stepsRun: run,
  stepsTotal: total,
  skipped,
});

/** The coverage table of scenarios.test.ts (vtt-75c.13), restated. */
const EXPECTED: Record<string, Expected> = {
  "hit-points.json": complete(5),
  "difficult-terrain.json": complete(4),
  "re-hiding-room.json": complete(6),
  "goblin-hit.json": partial(4, 6),
  "attack-card.json": partial(2, 7, { action: 6 }),
  "fireball.json": partial(2, 12, { action: 2 }),
  "die-with-modifier.json": partial(1, 7),
  "dice-tray.json": partial(0, 10),
  "drawing-a-card.json": partial(0, 4, { action: 1 }),
  "shuffling.json": partial(0, 2, { action: 1 }),
};

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
      const directReport = runScenario(scenario, { onStep: (s) => direct.push(s) });
      const wireReport = await runScenarioOverProtocol(scenario, { onStep: (s) => wire.push(s) });
      expect(wireReport).toEqual({ title: scenario.title, ...expected });
      expect(wireReport).toEqual(directReport);
      expect(wire.map((s) => s.step)).toEqual(direct.map((s) => s.step));
      expect(wire).toHaveLength(directReport.stepsRun + 1);
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
