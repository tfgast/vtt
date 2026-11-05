/** Synthetic scenarios for the runner self-tests. */
import { parseScenario, type Scenario, type Step } from "@vtt/fixtures";

export const n = (value: number) => ({ type: "number" as const, value });
export const r = (object: string) => ({ type: "ref" as const, object });

/** A board with Aldric (a character): max_hp 27, damage_taken 0, hp = max_hp - damage_taken. */
export function base(): Scenario {
  return {
    title: "Synthetic",
    source: "Hit points",
    setup: {
      boards: [{ id: "table" }],
      characters: ["aldric"],
      objects: [
        {
          id: "aldric",
          tag: ["pc"],
          shape: { type: "circle", radius: 0.5 },
          placement: { board: "table", position: [3, 4] },
          cells: {
            name: { type: "text", value: "Aldric" },
            max_hp: n(27),
            damage_taken: n(0),
            hp: { type: "formula", source: "max_hp - damage_taken" },
          },
        },
      ],
    },
    dice: [],
    steps: [],
  };
}

/** `base()` with `patch` applied, validated by the fixtures loader. */
export function valid(patch: Partial<Scenario>): Scenario {
  return parseScenario({ ...base(), ...patch }, "synthetic");
}

/** `base()` with `patch` applied and no validation: for scenarios the loader would refuse. */
export function raw(patch: Partial<Scenario>): Scenario {
  return { ...base(), ...patch };
}

export const setDamage = (value: number, expect: Step["expect"] = []): Step => ({
  actor: "gm",
  do: { type: "set", object: "aldric", cell: "damage_taken", value: n(value) },
  expect,
});
