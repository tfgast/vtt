import { isReserved, type Snapshot, SnapshotSchema } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { fireballSnapshot, obj, snapshot } from "./helpers";

const roundTrip = (s: Snapshot) => SnapshotSchema.parse(JSON.parse(JSON.stringify(s)));

describe("SnapshotSchema", () => {
  test("parses the hand-written fireball setup unchanged", () => {
    const s = fireballSnapshot();
    expect(roundTrip(s)).toEqual(s);
  });

  test("round-trips cell_visibility on field-backed cells that are not stored", () => {
    const s = snapshot([
      obj("bag", {
        board: "map",
        tag: ["bag"],
        contents: ["coin"],
        cells: {
          position: {
            content: {
              type: "list",
              items: [
                { type: "number", value: 0 },
                { type: "number", value: 0 },
              ],
            },
          },
        },
        cell_visibility: {
          contents: { type: "viewers", viewers: ["gm"] },
          tag: { type: "viewers", viewers: ["owner", { type: "ref", object: "aldric" }] },
        },
      }),
      obj("coin", { cell_visibility: { tag: { type: "viewers", viewers: ["all"] } } }),
    ]);
    expect(roundTrip(s)).toEqual(s);
  });

  test("rejects unknown keys at every level", () => {
    const s = JSON.parse(JSON.stringify(fireballSnapshot()));
    expect(SnapshotSchema.safeParse({ ...s, version: 1 }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...s, boards: [{ id: "map", colour: "red" }] }).success).toBe(
      false,
    );
    s.objects.aldric.container = null;
    expect(SnapshotSchema.safeParse(s).success).toBe(false);
  });

  test("rejects __proto__ in cells, cell_visibility and the object map", () => {
    const base = JSON.stringify(snapshot([obj("coin", { board: "map" })]));
    const cells = JSON.parse(base);
    cells.objects.coin.cells = JSON.parse('{"__proto__": {"content": {"type": "empty"}}}');
    expect(SnapshotSchema.safeParse(cells).success).toBe(false);
    const vis = JSON.parse(base);
    vis.objects.coin.cell_visibility = JSON.parse(
      '{"__proto__": {"type": "viewers", "viewers": ["gm"]}}',
    );
    expect(SnapshotSchema.safeParse(vis).success).toBe(false);
    const objects = JSON.parse(base.replace('"objects":{', '"objects":{"__proto__":{},'));
    expect(SnapshotSchema.safeParse(objects).success).toBe(false);
  });
});

describe("isReserved", () => {
  const s = snapshot([obj("coin", { board: "map" })], { retired_ids: ["goblin_3"] });

  test("live boards, live objects and retired ids are reserved", () => {
    expect(isReserved(s, "map")).toBe(true);
    expect(isReserved(s, "coin")).toBe(true);
    expect(isReserved(s, "goblin_3")).toBe(true);
  });

  test("anything else is available", () => {
    expect(isReserved(s, "goblin_4")).toBe(false);
    expect(isReserved(s, "constructor")).toBe(false);
    expect(isReserved(s, "toString")).toBe(false);
  });
});
