/**
 * The runner's own failure modes (vtt-75c.13): each wrong scenario fails
 * with a message naming the scenario, the step and the expectation; misuse
 * is a ScenarioError, a broken expectation a ScenarioFailure.
 */
import { ScenarioError } from "@vtt/authority";
import { describe, expect, test } from "vitest";
import { n, raw, setDamage, valid } from "./helpers";
import { runScenario, ScenarioFailure } from "./run";

const roll14 = { type: "roll" as const, expr: "1d20", dice: [14], dropped: [], total: 14 };

/** Runs `fn` and returns what it threw. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

describe.each([
  ["direct", false],
  ["round-trip", true],
])("%s", (_mode, roundTrip) => {
  const run = (s: Parameters<typeof runScenario>[0]) => runScenario(s, { roundTrip });

  test("a scenario whose expectations hold passes", () => {
    const report = run(
      valid({
        steps: [
          setDamage(5, [
            { type: "cell", object: "aldric", cell: "hp", value: n(22) },
            { type: "log_groups", count: 1 },
            {
              type: "log_includes",
              group: -1,
              effect: { type: "write", object: "aldric", cell: "damage_taken", value: n(5) },
            },
            { type: "replay" },
          ]),
        ],
      }),
    );
    expect(report).toEqual({
      title: "Synthetic",
      complete: true,
      stepsRun: 1,
      stepsTotal: 1,
      skipped: {},
    });
  });

  test("a wrong cell value fails, naming scenario, step and expectation", () => {
    const err = thrown(() =>
      run(
        valid({
          steps: [
            setDamage(5, [
              { type: "log_groups", count: 1 },
              { type: "cell", object: "aldric", cell: "hp", value: n(99) },
            ]),
          ],
        }),
      ),
    );
    expect(err).toBeInstanceOf(ScenarioFailure);
    expect(err.message).toMatch(/^"Synthetic": step 0, expect #1 \(cell\): /);
    expect(err.message).toContain("99");
    expect(err.message).toContain("22");
  });

  test("a wrong top-level expectation fails, naming setup", () => {
    const err = thrown(() =>
      run(valid({ expect: [{ type: "cell", object: "aldric", cell: "hp", value: n(1) }] })),
    );
    expect(err).toBeInstanceOf(ScenarioFailure);
    expect(err.message).toMatch(/^"Synthetic": setup, expect #0 \(cell\): /);
  });

  test("a predicted rejection that does not happen fails", () => {
    const err = thrown(() =>
      run(
        valid({ steps: [setDamage(5, [{ type: "rejected", reason: { type: "protected_cell" } }])] }),
      ),
    );
    expect(err).toBeInstanceOf(ScenarioFailure);
    expect(err.message).toMatch(/^"Synthetic": step 0, expect #0 \(rejected\): /);
  });

  const cycle = {
    setup: {
      boards: [{ id: "table" }],
      characters: [],
      objects: [
        { id: "bag", placement: { board: "table", position: [0, 0] as [number, number] } },
      ],
    },
  };
  const bagIntoItself = {
    actor: "gm",
    do: {
      type: "move" as const,
      object: "bag",
      to: { type: "container" as const, container: "bag", index: 0 },
    },
  };

  test("an unpredicted rejection fails, naming the step and the missing expectation", () => {
    const err = thrown(() => run(valid({ ...cycle, steps: [bagIntoItself] })));
    expect(err).toBeInstanceOf(ScenarioFailure);
    expect(err.message).toMatch(/^"Synthetic": step 0, expect rejected \(absent\): /);
    expect(err.message).toContain("containment_cycle");
  });

  test("a predicted rejection with the right reason passes, and nothing changed", () => {
    const report = run(
      valid({
        ...cycle,
        steps: [
          {
            ...bagIntoItself,
            expect: [
              { type: "rejected", reason: { type: "containment_cycle" } },
              { type: "log_groups", count: 0 },
              { type: "placement", object: "bag", board: "table", position: [0, 0] },
            ],
          },
        ],
      }),
    );
    expect(report.complete).toBe(true);
  });

  test("a rejection with the wrong reason fails", () => {
    const err = thrown(() =>
      run(
        valid({
          ...cycle,
          steps: [
            {
              ...bagIntoItself,
              expect: [{ type: "rejected", reason: { type: "protected_cell" } }],
            },
          ],
        }),
      ),
    );
    expect(err).toBeInstanceOf(ScenarioFailure);
    expect(err.message).toMatch(/^"Synthetic": step 0, expect #0 \(rejected\): /);
  });

  test("an unknown binding is a scenario error", () => {
    const err = thrown(() =>
      run(
        raw({
          steps: [
            {
              actor: "gm",
              do: { type: "set", object: "ghost", cell: "hp", value: n(1) },
            },
          ],
        }),
      ),
    );
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 0 \(set\): /);
    expect(err.message).toContain("ghost");
  });

  test("an unknown binding in an expectation is a scenario error", () => {
    const err = thrown(() =>
      run(raw({ steps: [setDamage(1, [{ type: "exists", object: "ghost", exists: true }])] })),
    );
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 0, expect #0 \(exists\): /);
  });

  test("a set on a formula cell is a scenario error, not a rejection", () => {
    const err = thrown(() =>
      run(
        valid({
          steps: [
            {
              actor: "gm",
              do: { type: "set", object: "aldric", cell: "hp", value: n(1) },
              expect: [{ type: "rejected", reason: { type: "protected_cell" } }],
            },
          ],
        }),
      ),
    );
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 0 \(set\): /);
    expect(err.message).toContain("formula");
  });

  test("an override on a literal cell is a scenario error", () => {
    const err = thrown(() =>
      run(
        valid({
          steps: [
            {
              actor: "gm",
              do: { type: "override", object: "aldric", cell: "max_hp", value: n(1) },
            },
          ],
        }),
      ),
    );
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 0 \(override\): /);
  });

  test("a clear_override without an override is a scenario error", () => {
    const err = thrown(() =>
      run(
        valid({
          steps: [{ actor: "gm", do: { type: "clear_override", object: "aldric", cell: "hp" } }],
        }),
      ),
    );
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 0 \(clear_override\): /);
  });

  test("a leftover dice entry in a complete run is a scenario error", () => {
    const err = thrown(() => run(valid({ dice: [roll14], steps: [setDamage(5)] })));
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": end: /);
    expect(err.message).toContain("1 dice script entry left");
  });

  test("a leftover dice entry in a partial run is not judged", () => {
    const s = valid({
      dice: [roll14],
      setup: {
        ...valid({}).setup,
        objects: [
          {
            ...(valid({}).setup.objects[0] as object),
            id: "aldric",
            actions: [{ name: "Roll", steps: ["roll(1d20) -> value"] }],
          },
        ],
      },
      steps: [setDamage(5), { actor: "gm", do: { type: "invoke", object: "aldric", action: "Roll" } }],
    });
    expect(run(s)).toEqual({
      title: "Synthetic",
      complete: false,
      stepsRun: 1,
      stepsTotal: 2,
      skipped: {},
    });
  });

  test("action expectations are skipped and counted; other expectations still hold", () => {
    const s = valid({
      setup: {
        ...valid({}).setup,
        objects: [
          {
            ...(valid({}).setup.objects[0] as object),
            id: "aldric",
            actions: [{ name: "Heal", steps: ["set(damage_taken, 0)"] }],
          },
        ],
      },
      expect: [{ type: "action", object: "aldric", action: "Heal", enabled: true }],
      steps: [
        setDamage(5, [
          { type: "action", object: "aldric", action: "Heal", enabled: true },
          { type: "cell", object: "aldric", cell: "hp", value: n(22) },
        ]),
      ],
    });
    expect(run(s).skipped).toEqual({ action: 2 });
  });

  test("acting on a removed object is a scenario error", () => {
    const s = valid({
      setup: {
        boards: [{ id: "table" }],
        characters: [],
        objects: [
          { id: "binder", placement: { board: "table", position: [0, 0] }, contents: ["tpl"] },
          { id: "tpl", is_template: true, cells: { hp: n(1) } },
        ],
      },
      steps: [
        {
          actor: "gm",
          do: {
            type: "spawn",
            template: "tpl",
            to: { type: "board", board: "table", position: [1, 1] },
            as: "copy",
          },
        },
        { actor: "gm", do: { type: "undo" } },
        {
          actor: "gm",
          do: { type: "set", object: "copy", cell: "hp", value: n(2) },
        },
      ],
    });
    const err = thrown(() => run(s));
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 2 \(set\): /);
    expect(err.message).toContain("removed");
  });

  test("an expectation other than exists on a removed object is a scenario error", () => {
    const s = valid({
      setup: {
        boards: [{ id: "table" }],
        characters: [],
        objects: [
          { id: "binder", placement: { board: "table", position: [0, 0] }, contents: ["tpl"] },
          { id: "tpl", is_template: true, cells: { hp: n(1) } },
        ],
      },
      steps: [
        {
          actor: "gm",
          do: {
            type: "spawn",
            template: "tpl",
            to: { type: "board", board: "table", position: [1, 1] },
            as: "copy",
          },
        },
        {
          actor: "gm",
          do: { type: "undo" },
          expect: [
            { type: "exists", object: "copy", exists: false },
            { type: "cell", object: "copy", cell: "hp", value: n(1) },
          ],
        },
      ],
    });
    const err = thrown(() => run(s));
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 1, expect #1 \(cell\): /);
  });

  test("bind names exactly one object; zero matches is a scenario error", () => {
    const setup = {
      boards: [{ id: "table" }],
      characters: [],
      objects: [
        {
          id: "bag",
          placement: { board: "table", position: [0, 0] as [number, number] },
          contents: ["a", "b"],
        },
        { id: "a", tag: ["coin"], cells: { value: n(1) } },
        { id: "b", tag: ["coin"], cells: { value: n(5) } },
      ],
    };
    const ok = valid({
      setup,
      steps: [
        {
          do: { type: "bind", as: "five", tag: "coin", where: { cell: "value", value: n(5) }, in: "bag" },
          expect: [
            { type: "container", object: "five", container: "bag", index: 1 },
            { type: "log_groups", count: 0 },
          ],
        },
      ],
    });
    expect(run(ok).complete).toBe(true);
    const none = valid({
      setup,
      steps: [{ do: { type: "bind", as: "x", tag: "coin", where: { cell: "value", value: n(7) } } }],
    });
    expect(thrown(() => run(none))).toBeInstanceOf(ScenarioError);
    const two = valid({ setup, steps: [{ do: { type: "bind", as: "x", tag: "coin" } }] });
    const err = thrown(() => run(two));
    expect(err).toBeInstanceOf(ScenarioError);
    expect(err.message).toMatch(/^"Synthetic": step 0 \(bind\): /);
  });
});
