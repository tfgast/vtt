/**
 * The observation hook (vtt-75c.13): called after setup and after every
 * executed step with a copy of the stored state, and it only observes.
 */
import {
  clearOverride,
  type DocumentStore,
  storedStateEqual,
  Table,
  type Transaction,
  undo,
  writeValue,
} from "@vtt/authority";
import type { Scenario } from "@vtt/fixtures";
import { num, type Snapshot } from "@vtt/schema";
import { beforeAll, describe, expect, test } from "vitest";
import { loadScenarioFile } from "./load";
import { runScenario, type StepReport } from "./run";
import { documentFromSetup } from "./setup";

let hitPoints: Scenario;
beforeAll(async () => {
  hitPoints = await loadScenarioFile("hit-points.json");
});

/** hit-points.json by hand on the store primitives: the snapshot after setup and after each step. */
function byHand(s: Scenario): Snapshot[] {
  const table = Table.fromSnapshot(documentFromSetup(s.setup));
  const store: DocumentStore = table.store;
  const out = [store.toSnapshot()];
  const edit = (fn: (tx: Transaction) => void) => {
    const result = store.transact({ type: "gm" }, { kind: "edit", label: "edit" }, fn);
    expect(result.ok).toBe(true);
    out.push(store.toSnapshot());
  };
  edit((tx) => writeValue(tx, "aldric", "damage_taken", num(5)));
  edit((tx) => writeValue(tx, "aldric", "hp", num(30)));
  edit((tx) => writeValue(tx, "aldric", "damage_taken", num(10)));
  edit((tx) => clearOverride(tx, "aldric", "hp"));
  expect(undo(store, { type: "gm" }, { type: "latest" }).ok).toBe(true);
  out.push(store.toSnapshot());
  return out;
}

describe.each([false, true])("onStep on hit-points.json (round trip %s)", (roundTrip) => {
  test("is called stepsRun + 1 times, with steps -1, 0, 1, …, and the state after each", () => {
    const seen: StepReport[] = [];
    const report = runScenario(hitPoints, { roundTrip, onStep: (r) => seen.push(r) });
    expect(seen).toHaveLength(report.stepsRun + 1);
    expect(seen.map((r) => r.step)).toEqual([-1, 0, 1, 2, 3, 4]);
    const expected = byHand(hitPoints);
    seen.forEach((r, i) => {
      expect(storedStateEqual(r.snapshot, expected[i] as Snapshot)).toBe(true);
      expect(r.snapshot.revision).toBe(i);
    });
  });

  test("a hook that mutates its argument does not change the run", () => {
    const plain: Snapshot[] = [];
    const reference = runScenario(hitPoints, {
      roundTrip,
      onStep: (r) => plain.push(structuredClone(r.snapshot)),
    });
    const copies: Snapshot[] = [];
    const mutated = runScenario(hitPoints, {
      roundTrip,
      onStep: (r) => {
        copies.push(structuredClone(r.snapshot));
        r.snapshot.objects = {};
        r.snapshot.revision = 99;
        r.step = 1000;
        return "ignored";
      },
    });
    expect(mutated).toEqual(reference);
    expect(copies).toEqual(plain);
  });
});

test("onStep is not called for skipped invoke steps", async () => {
  const fireball = await loadScenarioFile("fireball.json");
  const steps: number[] = [];
  const report = runScenario(fireball, { onStep: (r) => steps.push(r.step) });
  expect(report.stepsRun).toBe(2);
  expect(steps).toEqual([-1, 0, 1]);
});
