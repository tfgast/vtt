/**
 * Dependency-tracked guards and show-whens (vtt-qf5.25; FORMULAS.md §7
 * Propagation; DESIGN.md §4.6; PROTOCOL.md §8; M6-D38): the hub registers
 * every `when` and `show_when` it evaluates for a view as a tracked engine
 * expression, so a commit re-views an object for presentation only when
 * something one of its guards or show-whens read may have changed. Counts
 * object views built per commit; every delta-applied mirror equals a fresh
 * `subscribe`.
 */
import {
  move,
  remove,
  SubscriptionHub,
  setActions,
  setFace,
  Table,
  type Transaction,
  undo,
  writeValue,
} from "@vtt/authority";
import type { CommitEvent, ObjectView, SubscribeParams } from "@vtt/protocol";
import { type Actor, bool, num, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, placed, snapshot } from "../engine/helpers";

const GM_ACTOR: Actor = { type: "gm" };

const canon = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/**
 * `guarded`'s Strike reads the target's hp; `faced`'s Lever button shows
 * while the switch is on; `self` guards on its own cell; `target`, `switch`
 * and `bystander` hold the cells, and nothing reads `bystander.n`.
 */
function world(): Table {
  return Table.fromSnapshot(
    snapshot(
      [
        placed("guarded", 0, 0, {
          actions: [{ name: "Strike", when: 'obj("target").hp > 0', steps: ['set(name, "x")'] }],
        }),
        placed("faced", 1, 0, {
          actions: [{ name: "Lever", steps: ['set(name, "y")'] }],
          face: {
            elements: [
              {
                type: "button",
                action: "Lever",
                rect: [0, 0, 1, 1],
                show_when: 'obj("switch").on',
              },
            ],
          },
        }),
        placed("self", 2, 0, {
          cells: { ready: c(bool(true)) },
          actions: [{ name: "Go", when: "ready", steps: ['set(name, "z")'] }],
        }),
        placed("target", 3, 0, { cells: { hp: c(num(5)) } }),
        placed("switch", 4, 0, { cells: { on: c(bool(false)) } }),
        placed("bystander", 5, 0, { cells: { n: c(num(0)) } }),
        placed("away", 0, 0, { board: "side", cells: { name: c(text("Away")) } }),
      ],
      ["table", "side"],
    ),
  );
}

class Harness {
  readonly table = world();
  readonly hub = new SubscriptionHub(this.table);
  readonly mirrors = new Map<string, { params: SubscribeParams; objects: Map<string, string> }>();
  last: CommitEvent | undefined;

  constructor() {
    this.hub.onCommitEvent((_conn, event) => {
      this.last = event;
      for (const d of event.deltas) {
        const m = this.mirrors.get(d.subscription);
        if (m === undefined) continue;
        for (const id of d.removed) m.objects.delete(id);
        for (const o of d.objects) m.objects.set(o.id, canon(o));
      }
    });
  }

  subscribe(params: SubscribeParams): string {
    const r = this.hub.subscribe("c1", params);
    this.mirrors.set(r.subscription, {
      params,
      objects: new Map(r.objects.map((o) => [o.id, canon(o)])),
    });
    return r.subscription;
  }

  /** Commits `fn`; returns the number of object views the hub built for it. */
  commit(fn: (tx: Transaction) => void): number {
    const before = this.hub.stats().viewsBuilt;
    const r = this.table.store.transact(GM_ACTOR, { kind: "edit", label: "edit" }, fn);
    if (!r.ok) throw new Error(JSON.stringify(r.rejection));
    expect(r.listenerErrors).toEqual([]);
    const built = this.hub.stats().viewsBuilt - before;
    this.check();
    return built;
  }

  undo(): number {
    const before = this.hub.stats().viewsBuilt;
    const r = undo(this.table.store, GM_ACTOR);
    if (!r.ok) throw new Error(JSON.stringify(r.rejection));
    const built = this.hub.stats().viewsBuilt - before;
    this.check();
    return built;
  }

  /** The ids of the whole views the last commit event carried. */
  sent(): string[] {
    return (this.last?.deltas ?? []).flatMap((d) => d.objects.map((o) => o.id)).sort();
  }

  view(id: string): ObjectView | undefined {
    for (const d of this.last?.deltas ?? []) {
      const o = d.objects.find((x) => x.id === id);
      if (o !== undefined) return o;
    }
    return undefined;
  }

  /** Every mirror equals a fresh subscribe (on a second hub, so this one's state is untouched). */
  check(): void {
    const other = new SubscriptionHub(this.table);
    for (const m of this.mirrors.values()) {
      const r = other.subscribe("check", m.params);
      expect(new Map(r.objects.map((o) => [o.id, canon(o)]))).toEqual(m.objects);
    }
    other.close();
  }
}

describe("tracked guards and show-whens", () => {
  test("a commit writing a cell no guard reads re-views only that object", () => {
    const h = new Harness();
    h.subscribe({ scope: { type: "all" } });
    expect(h.commit((tx) => writeValue(tx, "bystander", "n", num(1)))).toBe(1);
    expect(h.sent()).toEqual(["bystander"]);
  });

  test("a commit writing a cell one guard reads re-views exactly that guard's object too", () => {
    const h = new Harness();
    h.subscribe({ scope: { type: "all" } });
    // hp 5 -> 4: Strike stays enabled, so guarded's view is unchanged and not sent.
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(4)))).toBe(2);
    expect(h.sent()).toEqual(["target"]);
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(0)))).toBe(2);
    expect(h.sent()).toEqual(["guarded", "target"]);
    expect(h.view("guarded")?.action_states).toEqual([
      { name: "Strike", enabled: false, reason: "when_false" },
    ]);
    // A show-when read: the switch turns the Lever button on.
    expect(h.commit((tx) => writeValue(tx, "switch", "on", bool(true)))).toBe(2);
    expect(h.sent()).toEqual(["faced", "switch"]);
    expect(h.view("faced")?.face?.elements[0]).toMatchObject({ shown: true });
    // A guard on its own cell: the object is re-viewed once.
    expect(h.commit((tx) => writeValue(tx, "self", "ready", bool(false)))).toBe(1);
    expect(h.sent()).toEqual(["self"]);
  });

  test("a guard whose source is edited is re-tracked on its new dependencies", () => {
    const h = new Harness();
    h.subscribe({ scope: { type: "all" } });
    expect(
      h.commit((tx) =>
        setActions(tx, "guarded", [
          { name: "Strike", when: 'obj("bystander").n > 0', steps: ['set(name, "x")'] },
        ]),
      ),
    ).toBe(1);
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(0)))).toBe(1);
    expect(h.sent()).toEqual(["target"]);
    expect(h.commit((tx) => writeValue(tx, "bystander", "n", num(1)))).toBe(2);
    expect(h.sent()).toEqual(["bystander", "guarded"]);
    expect(h.view("guarded")?.action_states).toEqual([{ name: "Strike", enabled: true }]);
    // Undoing the edits restores the old guard and its old dependencies.
    h.undo();
    h.undo();
    h.undo();
    expect(h.commit((tx) => writeValue(tx, "bystander", "n", num(2)))).toBe(1);
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(0)))).toBe(2);
    expect(h.sent()).toEqual(["guarded", "target"]);
  });

  test("a face edit re-tracks show-whens; removing the face stops them", () => {
    const h = new Harness();
    h.subscribe({ scope: { type: "all" } });
    h.commit((tx) =>
      setFace(tx, "faced", {
        elements: [
          {
            type: "button",
            action: "Lever",
            rect: [0, 0, 1, 1],
            show_when: 'obj("bystander").n = 0',
          },
        ],
      }),
    );
    expect(h.commit((tx) => writeValue(tx, "switch", "on", bool(true)))).toBe(1);
    expect(h.commit((tx) => writeValue(tx, "bystander", "n", num(3)))).toBe(2);
    expect(h.sent()).toEqual(["bystander", "faced"]);
    h.commit((tx) => setFace(tx, "faced", null));
    expect(h.commit((tx) => writeValue(tx, "bystander", "n", num(0)))).toBe(1);
  });

  test("only guards of objects in some subscription's scope are tracked", () => {
    const h = new Harness();
    h.subscribe({ scope: { type: "board", board: "side" } });
    // guarded is on another board: its guard is not evaluated or re-viewed.
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(0)))).toBe(0);
    // It enters the scope: viewed whole, and its guard is tracked from then on.
    expect(
      h.commit((tx) => move(tx, "guarded", { type: "board", board: "side", position: [1, 1] })),
    ).toBe(1);
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(3)))).toBe(1);
    expect(h.sent()).toEqual(["guarded"]);
    // It leaves again: no longer re-viewed.
    h.commit((tx) => move(tx, "guarded", { type: "board", board: "table", position: [0, 0] }));
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(0)))).toBe(0);
  });

  test("removing a guarded object and undoing the removal keeps its guard current", () => {
    const h = new Harness();
    h.subscribe({ scope: { type: "all" } });
    h.commit((tx) => remove(tx, "guarded"));
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(0)))).toBe(1);
    // Undo the hp write, then the removal: guarded is back and tracked again.
    h.undo();
    h.undo();
    expect(h.commit((tx) => writeValue(tx, "target", "hp", num(0)))).toBe(2);
    expect(h.sent()).toEqual(["guarded", "target"]);
  });

  test("a guard reading another object follows that object's removal", () => {
    const h = new Harness();
    h.subscribe({ scope: { type: "all" } });
    h.commit((tx) => remove(tx, "target"));
    expect(h.sent()).toEqual(["guarded"]);
    expect(h.view("guarded")?.action_states).toEqual([
      { name: "Strike", enabled: false, reason: "when_error" },
    ]);
  });
});
