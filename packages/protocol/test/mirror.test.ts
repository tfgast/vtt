import { type SubscribeResult, ViewMirror } from "@vtt/protocol";
import { describe, expect, test } from "vitest";
import { cover, delta, group, obj } from "./support/fake-server";

const initial: SubscribeResult = {
  subscription: "s1",
  revision: 10,
  objects: [obj("a", 1), obj("b", 2), obj("c")],
  covers: [cover("k1"), cover("k2")],
};

describe("ViewMirror", () => {
  test("an initial view and three deltas give the expected maps", () => {
    const mirror = new ViewMirror();
    expect(mirror.revision).toBe(0);
    mirror.reset(initial);
    expect(mirror.revision).toBe(10);
    expect([...mirror.objects.keys()]).toEqual(["a", "b", "c"]);
    expect([...mirror.covers.keys()]).toEqual(["k1", "k2"]);

    mirror.apply(delta("s1", { objects: [obj("a", 5), obj("d")] }), 11);
    mirror.apply(delta("s1", { removed: ["b"], covers: { upsert: [], removed: ["k1"] } }), 12);
    mirror.apply(
      delta("s1", {
        objects: [obj("c", 9)],
        covers: { upsert: [cover("k2", "cave"), cover("k3")], removed: [] },
      }),
      13,
    );

    expect(mirror.revision).toBe(13);
    expect(mirror.objects).toEqual(
      new Map([
        ["a", obj("a", 5)],
        ["c", obj("c", 9)],
        ["d", obj("d")],
      ]),
    );
    expect(mirror.covers).toEqual(
      new Map([
        ["k2", cover("k2", "cave")],
        ["k3", cover("k3")],
      ]),
    );
    expect(mirror.groups.size).toBe(0);
  });

  test("a log-scope mirror keeps the window from groups_upserted and groups_removed", () => {
    const mirror = new ViewMirror({
      subscription: "log",
      revision: 3,
      objects: [],
      covers: [],
      groups: [group(2), group(1), group(0)],
    });
    expect(mirror.groupsNewestFirst().map((g) => g.index)).toEqual([2, 1, 0]);

    // An undo (group 3) re-sends the undone group 2 with undone: true.
    mirror.apply(delta("log", { groups_upserted: [group(3), group(2, true)] }), 4);
    // Group 0 leaves the window as group 4 arrives.
    mirror.apply(delta("log", { groups_upserted: [group(4)], groups_removed: [0] }), 5);

    expect(mirror.revision).toBe(5);
    expect(mirror.groupsNewestFirst()).toEqual([group(4), group(3), group(2, true), group(1)]);
    expect(mirror.objects.size).toBe(0);
  });

  test("reset replaces, clear empties, advance moves only the revision", () => {
    const mirror = new ViewMirror(initial);
    mirror.advance(15);
    expect(mirror.revision).toBe(15);
    expect(mirror.objects.size).toBe(3);
    mirror.reset({ subscription: "s2", revision: 20, objects: [obj("z")], covers: [] });
    expect([...mirror.objects.keys()]).toEqual(["z"]);
    expect(mirror.covers.size).toBe(0);
    mirror.clear(21);
    expect(mirror.revision).toBe(21);
    expect(mirror.objects.size + mirror.covers.size + mirror.groups.size).toBe(0);
  });
});

describe("ViewMirror cell patches (vtt-qf5.4)", () => {
  const cell = (n: number) => ({
    value: { type: "number" as const, value: n },
    kind: "literal" as const,
  });

  test("a patch sets and deletes only the named cells of the stored view", () => {
    const a = { ...obj("a", 1), cells: { hp: cell(1), ac: cell(12), note: cell(3) } };
    const mirror = new ViewMirror({ ...initial, objects: [a, obj("b", 2)] });
    const before = mirror.objects.get("a");
    mirror.apply(
      delta("s1", { patches: [{ object: "a", cells: { hp: cell(9), note: null, xp: cell(5) } }] }),
      11,
    );
    expect(mirror.revision).toBe(11);
    expect(mirror.objects.get("a")).toEqual({
      ...a,
      cells: { hp: cell(9), ac: cell(12), xp: cell(5) },
    });
    // The stored view is replaced, not mutated.
    expect(before).toEqual(a);
    expect(mirror.objects.get("a")).not.toBe(before);
    expect(mirror.objects.get("b")).toEqual(obj("b", 2));
  });

  test("a patch for an object the mirror does not hold is ignored", () => {
    const mirror = new ViewMirror(initial);
    mirror.apply(delta("s1", { patches: [{ object: "zz", cells: { hp: cell(1) } }] }), 11);
    expect(mirror.objects.has("zz")).toBe(false);
    expect(mirror.revision).toBe(11);
  });
});
