/** documentFromSetup (vtt-75c.13; FIXTURES.md §3). */
import { canonicalJson, parseTable, serializeTable, Table } from "@vtt/authority";
import { describe, expect, test } from "vitest";
import { n, r, valid } from "./helpers";
import { runScenario } from "./run";
import { documentFromSetup } from "./setup";

const gmOnly = { type: "viewers" as const, viewers: ["gm" as const] };
const all = { type: "viewers" as const, viewers: ["all" as const] };

describe("documentFromSetup", () => {
  test("converts every setup field", () => {
    const s = valid({
      setup: {
        boards: [{ id: "table", name: "Table" }, { id: "side" }],
        characters: ["aldric"],
        objects: [
          {
            id: "aldric",
            tag: ["pc"],
            shape: { type: "circle", radius: 0.5 },
            placement: { board: "table", position: [3, 4] },
            cells: { name: { type: "text", value: "Aldric" }, hp: n(7) },
          },
          {
            id: "follower",
            placement: { board: "table", position: { type: "formula", source: "aldric.position" } },
          },
          {
            id: "room",
            is_zone: true,
            shape: { type: "rect", width: 2, height: 1 },
            placement: { board: "side", position: [0, 0] },
            contents: ["tpl"],
            cells: { opaque: { type: "boolean", value: true } },
          },
          {
            id: "tpl",
            is_template: true,
            cells: { owner: r("aldric"), total: { type: "formula", source: "1 + 1" } },
            actions: [{ name: "Roll", when: "true", steps: ["roll(1d20) -> value"] }],
          },
        ],
      },
    });
    const doc = documentFromSetup(s.setup);
    expect(doc.revision).toBe(0);
    expect(doc.next_seq).toBe(0);
    expect(doc.retired_ids).toEqual([]);
    expect(doc.boards).toEqual([{ id: "table", name: "Table" }, { id: "side" }]);
    expect(doc.objects.aldric).toEqual({
      id: "aldric",
      is_template: false,
      is_zone: false,
      is_character: true,
      tag: ["pc"],
      shape: { type: "circle", radius: 0.5 },
      board: "table",
      contents: [],
      cells: {
        name: { content: { type: "text", value: "Aldric" } },
        hp: { content: n(7) },
        position: { content: { type: "list", items: [n(3), n(4)] } },
      },
      cell_visibility: {},
      actions: [],
    });
    expect(doc.objects.follower?.cells.position).toEqual({
      content: { type: "formula", source: "aldric.position" },
    });
    expect(doc.objects.room).toMatchObject({ is_zone: true, board: "side", contents: ["tpl"] });
    expect(doc.objects.tpl).toMatchObject({
      is_template: true,
      board: null,
      is_character: false,
      cells: { owner: { content: r("aldric") } },
      actions: [{ name: "Roll", when: "true", steps: ["roll(1d20) -> value"] }],
    });
    const table = Table.fromSnapshot(doc);
    expect(table.value("follower", "position")).toEqual({ type: "list", items: [n(3), n(4)] });
  });

  const withVisibility = valid({
    setup: {
      boards: [{ id: "table" }],
      characters: ["aldric"],
      objects: [
        { id: "aldric", placement: { board: "table", position: [0, 0] } },
        {
          id: "chest",
          tag: ["loot"],
          placement: { board: "table", position: [1, 1] },
          cells: { visible_to: all },
          cell_visibility: { contents: gmOnly, tag: all, secret: gmOnly },
        },
      ],
    },
    expect: [
      { type: "object_visible", object: "chest", viewer: "aldric", visible: true },
      { type: "cell_visible", object: "chest", cell: "contents", viewer: "aldric", visible: false },
      { type: "cell_visible", object: "chest", cell: "tag", viewer: "aldric", visible: true },
      { type: "cell_visible", object: "chest", cell: "secret", viewer: "aldric", visible: false },
      { type: "cell_visible", object: "chest", cell: "contents", viewer: "gm", visible: true },
    ],
    steps: [],
  });

  test("cell_visibility on cells that are not stored converts verbatim", () => {
    const doc = documentFromSetup(withVisibility.setup);
    expect(doc.objects.chest?.cell_visibility).toEqual({
      contents: gmOnly,
      tag: all,
      secret: gmOnly,
    });
    expect(Object.keys(doc.objects.chest?.cells ?? {}).sort()).toEqual(["position", "visible_to"]);
  });

  test("it survives a round-trip hop unchanged", () => {
    const table = Table.fromSnapshot(documentFromSetup(withVisibility.setup));
    const loaded = parseTable(canonicalJson(serializeTable(table.store, []))).store;
    expect(loaded.toSnapshot()).toEqual(table.store.toSnapshot());
    expect(loaded.getCellVisibility("chest", "contents")).toEqual(gmOnly);
    expect(loaded.getCellVisibility("chest", "tag")).toEqual(all);
  });

  test.each([false, true])("cell_visible honours it (round trip %s)", (roundTrip) => {
    expect(runScenario(withVisibility, { roundTrip }).complete).toBe(true);
  });

  test("a wrong cell_visible expectation on it fails", () => {
    const wrong = valid({
      ...withVisibility,
      expect: [
        { type: "cell_visible", object: "chest", cell: "contents", viewer: "aldric", visible: true },
      ],
    });
    expect(() => runScenario(wrong)).toThrow(/setup, expect #0 \(cell_visible\)/);
  });
});
