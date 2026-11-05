/**
 * Dice and spawn through the runner's building blocks (vtt-75c.13): a
 * scripted source fed through `rollInto`, a scripted-dice mismatch inside a
 * step, and a spawn whose initial cell is a formula.
 */
import { rollInto, ScenarioError, ScriptedDiceSource, Table } from "@vtt/authority";
import type { Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { n, r, valid } from "./helpers";
import { runScenario, type StepReport } from "./run";
import { documentFromSetup } from "./setup";
import { newRunState, transactStep } from "./steps";

const roll = (expr: string, dice: number[], total: number) => ({
  type: "roll" as const,
  expr,
  dice,
  dropped: [],
  total,
});

describe("a scripted dice source through rollInto", () => {
  test("each roll consumes the next entry, and remaining() counts down", () => {
    const state = newRunState(valid({ dice: [roll("1d20", [14], 14), roll("2d6", [3, 4], 7)] }));
    expect(state.dice.remaining()).toBe(2);
    const first = transactStep(state, { type: "gm" }, "roll", (tx) => {
      rollInto(tx, state.dice, "aldric", "attack", "1d20");
    });
    expect(first.ok).toBe(true);
    expect(state.dice.remaining()).toBe(1);
    expect(state.table.value("aldric", "attack")).toEqual(roll("1d20", [14], 14));
    const group = state.table.store.history.groups().at(-1);
    expect(group?.effects).toContainEqual(
      expect.objectContaining({ cause: "roll", cell: "attack" }),
    );

    transactStep(state, { type: "gm" }, "roll", (tx) => {
      rollInto(tx, state.dice, "aldric", "damage", "2d6");
    });
    expect(state.dice.remaining()).toBe(0);
    expect(state.table.value("aldric", "damage")).toEqual(roll("2d6", [3, 4], 7));
  });

  test("a refused step consumes nothing", () => {
    const state = newRunState(valid({ dice: [roll("1d20", [14], 14), roll("1d20", [3], 3)] }));
    const result = transactStep(state, { type: "gm" }, "roll", (tx) => {
      rollInto(tx, state.dice, "aldric", "attack", "1d20");
      rollInto(tx, state.dice, "aldric", "id", "1d20");
    });
    expect(result.ok).toBe(false);
    expect(state.dice.remaining()).toBe(2);
  });

  test("a scripted-dice mismatch inside a step is a scenario error, not a rejection", () => {
    const state = newRunState(valid({ dice: [roll("1d20", [14], 14)] }));
    const before = state.table.store.toSnapshot();
    expect(() =>
      transactStep(state, { type: "gm" }, "roll", (tx) => {
        rollInto(tx, state.dice, "aldric", "damage", "2d6");
      }),
    ).toThrow(ScenarioError);
    expect(state.dice.remaining()).toBe(1);
    expect(state.table.store.toSnapshot()).toEqual(before);
    expect(state.table.store.history.groups()).toHaveLength(0);
  });

  test("a direct ScriptedDiceSource is the one transactStep uses", () => {
    const state = newRunState(valid({ dice: [] }));
    expect(state.dice).toBeInstanceOf(ScriptedDiceSource);
    expect(state.table).toBeInstanceOf(Table);
  });
});

describe("a spawn whose initial cell is a formula", () => {
  const scenario = valid({
    setup: {
      boards: [{ id: "table" }],
      characters: ["aldric"],
      objects: [
        {
          id: "aldric",
          placement: { board: "table", position: [0, 0] },
          cells: { attack_bonus: n(3) },
        },
        { id: "binder", placement: { board: "table", position: [5, 5] }, contents: ["d20"] },
        {
          id: "d20",
          is_template: true,
          tag: ["d20"],
          cells: {
            modifier: { type: "empty" },
            value: { type: "empty" },
            total: { type: "formula", source: "value + modifier" },
          },
        },
      ],
    },
    steps: [
      {
        actor: "gm",
        do: {
          type: "spawn",
          template: "d20",
          to: { type: "board", board: "table", position: [1, 1] },
          cells: {
            owner: r("aldric"),
            modifier: { type: "formula", source: "owner.attack_bonus" },
          },
          as: "die",
        },
        expect: [
          { type: "cell", object: "die", cell: "modifier", value: n(3) },
          { type: "cell", object: "die", cell: "total", value: n(3) },
          { type: "cell", object: "die", cell: "owner", value: r("aldric") },
          { type: "override", object: "die", cell: "modifier", overridden: false },
        ],
      },
      {
        actor: "gm",
        do: { type: "set", object: "aldric", cell: "attack_bonus", value: n(5) },
        expect: [
          { type: "cell", object: "die", cell: "modifier", value: n(5) },
          { type: "cell", object: "die", cell: "total", value: n(5) },
          { type: "replay" },
        ],
      },
    ],
  });

  test.each([false, true])("stores the formula and recomputes it (round trip %s)", (roundTrip) => {
    const snapshots: Snapshot[] = [];
    const report = runScenario(scenario, {
      roundTrip,
      onStep: ({ snapshot }: StepReport) => snapshots.push(snapshot),
    });
    expect(report.complete).toBe(true);
    const after = snapshots[1] as Snapshot;
    const copies = Object.values(after.objects).filter(
      (o) => o.cells.template?.content.type === "ref" && o.cells.template.content.object === "d20",
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.cells.modifier).toEqual({
      content: { type: "formula", source: "owner.attack_bonus" },
    });
  });

  test("documentFromSetup keeps the template's formula as source", () => {
    const doc = documentFromSetup(scenario.setup);
    expect(doc.objects.d20?.cells.total).toEqual({
      content: { type: "formula", source: "value + modifier" },
    });
  });
});
