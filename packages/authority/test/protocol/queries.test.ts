/**
 * Query methods (vtt-5su.8; PROTOCOL.md §4, §6, §9): list_objects,
 * get_objects, evaluate, zones, at_position, changes_since, log, document.
 * Every result is checked against its `@vtt/protocol` result schema.
 */
import {
  atPosition,
  changesSince,
  compactLog,
  documentDump,
  evaluateAdhoc,
  getObjects,
  listObjects,
  logPage,
  move,
  remove,
  Table,
  writeValue,
  zonesOnBoard,
} from "@vtt/authority";
import {
  AtPositionResultSchema,
  ChangesSinceResultSchema,
  DocumentResultSchema,
  EvaluateResultSchema,
  GetObjectsResultSchema,
  LIMITS,
  ListObjectsResultSchema,
  LogResultSchema,
  ProtocolFailure,
  ZonesResultSchema,
} from "@vtt/protocol";
import {
  list,
  num,
  ref,
  type Shape,
  type TableObject,
  text,
  type ViewersValue,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, commit, f, obj, placed, snapshot, zone } from "../engine/helpers";
import { loadScenarioFile } from "../runner/load";
import { documentFromSetup } from "../runner/setup";

const ALDRIC = { type: "character", id: "aldric" } as const;
const GM_ONLY: ViewersValue = { type: "viewers", viewers: ["gm"] };
const RECT4: Shape = { type: "rect", width: 4, height: 4 };

async function fixtureTable(file: string): Promise<Table> {
  const scenario = await loadScenarioFile(file);
  return Table.fromSnapshot(documentFromSetup(scenario.setup));
}

function failure(fn: () => unknown): ProtocolFailure {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolFailure);
    return err as ProtocolFailure;
  }
  throw new Error("expected a ProtocolFailure");
}

/** A character standing on board `table` at (x, -50), outside every test zone. */
const character = (id: string, x: number, rest: Partial<TableObject> = {}): TableObject =>
  placed(id, x, -50, { is_character: true, ...rest, cells: { name: c(text(id)), ...rest.cells } });

/**
 * The #LIMIT construction (FORMULAS.md §7: 20,000 units per evaluation, one
 * per cell read). `objects(...)` evaluates its predicate once per object in
 * the document; the predicate is a 2,500-item list of `this.w` reads (5,000
 * AST nodes, under the 10,000-node limit), so each object costs 2,500 reads.
 * The predicate is always false, so `objects` never reads anyone's `z` (no
 * cycle) and the formula's value, when it fits, is a plain number. With at
 * least nine objects in the document one evaluation exceeds 20,000 units.
 * The holder needs a literal `w`.
 */
const EXPENSIVE = `len(objects(sum([${Array(2500).fill("this.w").join(", ")}]) < 0))`;

/** Twelve plain objects off-board, so `EXPENSIVE` exceeds the budget. */
const filler = (): TableObject[] =>
  Array.from({ length: 12 }, (_, i) => obj(`filler${String(i).padStart(2, "0")}`));

describe("list_objects", () => {
  test("120 objects at limit 50: three pages, ascending ids, no duplicates", () => {
    const objects = Array.from({ length: 120 }, (_, i) =>
      placed(`o${String(i).padStart(3, "0")}`, i, 0),
    );
    const table = Table.fromSnapshot(snapshot(objects));
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = listObjects(table, { limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      expect(ListObjectsResultSchema.parse(r)).toEqual(r);
      expect(r.revision).toBe(0);
      sizes.push(r.objects.length);
      seen.push(...r.objects.map((o) => o.id));
      if (r.next_cursor === null) break;
      expect(r.next_cursor).toBe(r.objects.at(-1)?.id);
      cursor = r.next_cursor;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual([...seen].sort());
    expect(seen).toEqual(objects.map((o) => o.id));
  });

  test("the default limit is 50 and the default cells are structural", () => {
    const objects = Array.from({ length: 60 }, (_, i) =>
      placed(`o${String(i).padStart(2, "0")}`, i, 0, { cells: { hp: c(num(i)) } }),
    );
    const table = Table.fromSnapshot(snapshot(objects));
    const r = listObjects(table, {});
    expect(r.objects).toHaveLength(50);
    expect(r.next_cursor).toBe("o49");
    expect(r.objects[0]?.cells.hp).toBeUndefined();
    expect(r.objects[0]?.cells.position).toBeDefined();
    const all = listObjects(table, { cells: "all", limit: 1 });
    expect(all.objects[0]?.cells.hp).toEqual({ value: num(0), kind: "literal" });
  });

  test("ids order by code point", () => {
    // "\u{1F600}" (a surrogate pair) sorts after "�" by code point, before it by UTF-16 unit.
    const table = Table.fromSnapshot(
      snapshot([placed("a\u{1F600}", 0, 0), placed("a�", 1, 0), placed("a", 2, 0)]),
    );
    expect(listObjects(table, {}).objects.map((o) => o.id)).toEqual([
      "a",
      "a�",
      "a\u{1F600}",
    ]);
  });

  test("a tag filter over fireball.json returns its creatures", async () => {
    const table = await fixtureTable("fireball.json");
    const r = listObjects(table, { filter: { tag: "creature" } });
    expect(ListObjectsResultSchema.parse(r)).toEqual(r);
    expect(r.objects.map((o) => o.id)).toEqual(["aldric", "goblin1", "goblin2", "goblin3"]);
    expect(r.next_cursor).toBeNull();
  });

  test("filters: board, container, name, flags, combined", async () => {
    const table = await fixtureTable("fireball.json");
    const ids = (filter: Parameters<typeof listObjects>[1]["filter"]) =>
      listObjects(table, { filter }).objects.map((o) => o.id);
    expect(ids({ board: "shelf" })).toEqual(["aldric_binder"]);
    expect(ids({ container: "aldric_binder" })).toEqual(["fireball", "save_row_t"]);
    expect(ids({ container: "fireball" })).toEqual(["fireball_zone"]);
    expect(ids({ name: "Goblin 2" })).toEqual(["goblin2"]);
    expect(ids({ is_template: true })).toContain("fireball");
    expect(ids({ is_zone: true })).toEqual(["fireball_zone"]);
    expect(ids({ is_character: true })).toEqual(["aldric", "goblin1", "goblin2", "goblin3"]);
    expect(ids({ board: "map", tag: "goblin", is_character: true })).toEqual([
      "goblin1",
      "goblin2",
      "goblin3",
    ]);
    // Unknown filter ids match nothing (they are not query targets).
    expect(ids({ board: "nowhere" })).toEqual([]);
    expect(ids({ container: "nothing" })).toEqual([]);
  });

  test("name matches only a literal name", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("lit", 0, 0, { cells: { name: c(text("Bob")) } }),
        placed("formula", 1, 0, { cells: { name: f('"Bob"') } }),
      ]),
    );
    expect(listObjects(table, { filter: { name: "Bob" } }).objects.map((o) => o.id)).toEqual([
      "lit",
    ]);
  });

  test("a cursor starts after that id even if it is not an object", () => {
    const table = Table.fromSnapshot(snapshot([placed("a", 0, 0), placed("c", 1, 0)]));
    expect(listObjects(table, { cursor: "b" }).objects.map((o) => o.id)).toEqual(["c"]);
    expect(listObjects(table, { cursor: "c" })).toEqual({
      revision: 0,
      objects: [],
      next_cursor: null,
    });
  });
});

describe("get_objects and visibility", () => {
  function table(): Table {
    return Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("secret", 5, 5, { cells: { visible_to: c(GM_ONLY), name: c(text("Trap")) } }),
        placed("doomed", 6, 6, { cells: { name: c(text("Doomed")) } }),
        placed("public", 7, 7, { cells: { name: c(text("Rock")) } }),
      ]),
    );
  }

  test("Aldric's list_objects excludes a GM-only object; the GM's includes it", () => {
    const t = table();
    const aldric = listObjects(t, { viewer: ALDRIC });
    expect(ListObjectsResultSchema.parse(aldric)).toEqual(aldric);
    expect(aldric.objects.map((o) => o.id)).toEqual(["aldric", "doomed", "public"]);
    expect(listObjects(t, {}).objects.map((o) => o.id)).toEqual([
      "aldric",
      "doomed",
      "public",
      "secret",
    ]);
  });

  test("a hidden id goes to missing exactly like a removed one", () => {
    const t = table();
    commit(t, (tx) => remove(tx, "doomed"));
    const hidden = getObjects(t, { ids: ["secret"], viewer: ALDRIC });
    const removed = getObjects(t, { ids: ["doomed"], viewer: ALDRIC });
    expect(GetObjectsResultSchema.parse(hidden)).toEqual(hidden);
    expect(hidden).toEqual({ revision: 1, objects: [], missing: ["secret"] });
    expect(removed).toEqual({ revision: 1, objects: [], missing: ["doomed"] });
    // Mixed, in request order; an unknown id is missing, never not_found.
    const mixed = getObjects(t, { ids: ["public", "secret", "never", "aldric"], viewer: ALDRIC });
    expect(mixed.objects.map((o) => o.id)).toEqual(["public", "aldric"]);
    expect(mixed.missing).toEqual(["secret", "never"]);
    // The GM sees it, with every cell by default.
    const gm = getObjects(t, { ids: ["secret"] });
    expect(gm.missing).toEqual([]);
    expect(gm.objects[0]?.cells.name).toEqual({ value: text("Trap"), kind: "literal" });
    expect(gm.objects[0]?.cells.visible_to?.kind).toBe("literal");
  });

  test("cells selects structural or named cells", () => {
    const t = table();
    const named = getObjects(t, { ids: ["public"], cells: ["name"] });
    expect(Object.keys(named.objects[0]?.cells ?? {})).toEqual(["name"]);
  });
});

describe("evaluate", () => {
  function table(): Table {
    return Table.fromSnapshot(
      snapshot([
        placed("goblin1", 0, 0, {
          cells: {
            name: c(text("Goblin")),
            max_hp: c(num(27)),
            damage_taken: c(num(0)),
            visible_to: c(GM_ONLY),
          },
        }),
      ]),
    );
  }

  test("max_hp - damage_taken on goblin1 gives 27, then 22 after a write", () => {
    const t = table();
    const r = evaluateAdhoc(t, { source: "max_hp - damage_taken", this: "goblin1" });
    expect(EvaluateResultSchema.parse(r)).toEqual(r);
    expect(r).toEqual({ revision: 0, value: num(27) });
    commit(t, (tx) => writeValue(tx, "goblin1", "damage_taken", num(5)));
    expect(evaluateAdhoc(t, { source: "max_hp - damage_taken", this: "goblin1" })).toEqual({
      revision: 1,
      value: num(22),
    });
  });

  test("results are unredacted: refs and error origins pass through", () => {
    const t = table();
    expect(evaluateAdhoc(t, { source: "this", this: "goblin1" }).value).toEqual(ref("goblin1"));
    const e = evaluateAdhoc(t, { source: "max_hp / 0", this: "goblin1" }).value;
    expect(e).toMatchObject({ type: "error", code: "#DIV0" });
  });

  test("a source over max_source_length is bad_request; exactly the limit is fine", () => {
    const t = table();
    expect(LIMITS.max_source_length).toBe(10_000);
    const long = `1${" ".repeat(10_000)}`;
    expect(long.length).toBe(10_001);
    expect(failure(() => evaluateAdhoc(t, { source: long })).error.code).toBe("bad_request");
    const atLimit = `1${" ".repeat(9_999)}`;
    expect(evaluateAdhoc(t, { source: atLimit, this: "goblin1" }).value).toEqual(num(1));
  });

  test("an unknown this is not_found", () => {
    const err = failure(() => evaluateAdhoc(table(), { source: "1", this: "nobody" }));
    expect(err.error.code).toBe("not_found");
  });

  test("without this: object-free formulas evaluate; bare names are #NAME", () => {
    const t = table();
    expect(evaluateAdhoc(t, { source: "1 + 2" }).value).toEqual(num(3));
    expect(evaluateAdhoc(t, { source: 'obj("Goblin").max_hp' }).value).toEqual(num(27));
    expect(evaluateAdhoc(t, { source: "max_hp" }).value).toMatchObject({ code: "#NAME" });
  });

  test("a syntax error is a #SYNTAX value, not a failure", () => {
    expect(evaluateAdhoc(table(), { source: "1 +", this: "goblin1" }).value).toMatchObject({
      type: "error",
      code: "#SYNTAX",
    });
  });
});

describe("not_found on unknown query targets", () => {
  test("zones and at_position on an unknown board, evaluate with an unknown this", () => {
    const t = Table.fromSnapshot(snapshot([placed("a", 0, 0)]));
    const codes = [
      failure(() => zonesOnBoard(t, { board: "nowhere" })),
      failure(() => atPosition(t, { board: "nowhere", position: [0, 0] })),
      failure(() => evaluateAdhoc(t, { source: "1", this: "nobody" })),
    ].map((e) => e.error.code);
    expect(codes).toEqual(["not_found", "not_found", "not_found"]);
    expect(getObjects(t, { ids: ["nobody"] })).toEqual({
      revision: 0,
      objects: [],
      missing: ["nobody"],
    });
  });
});

describe("zones", () => {
  test("difficult-terrain: the swamp lists the token after a move in, not after a move out", async () => {
    const t = await fixtureTable("difficult-terrain.json");
    const before = zonesOnBoard(t, { board: "table" });
    expect(ZonesResultSchema.parse(before)).toEqual(before);
    expect(before.zones.map((z) => z.id)).toEqual(["road", "rubble", "swamp"]);
    expect(before.zones.find((z) => z.id === "swamp")?.contents).toEqual([]);

    commit(t, (tx) => move(tx, "aldric", { type: "board", board: "table", position: [10, 10] }));
    const inside = zonesOnBoard(t, { board: "table" });
    expect(inside.revision).toBe(1);
    const swamp = inside.zones.find((z) => z.id === "swamp");
    expect(swamp?.contents).toEqual(["aldric"]);
    expect(swamp?.error).toBeUndefined();
    expect(swamp?.view.id).toBe("swamp");
    expect(swamp?.view.cells.name).toBeDefined();

    commit(t, (tx) => move(tx, "aldric", { type: "board", board: "table", position: [30, 30] }));
    const outside = zonesOnBoard(t, { board: "table" });
    expect(outside.zones.find((z) => z.id === "swamp")?.contents).toEqual([]);
  });

  test("view is structural; contents is in query order and filtered by visibility", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        zone("pit", 0, 0, 10, { cells: { name: c(text("Pit")), depth: c(num(3)) } }),
        zone("vault", 50, 0, 4, { cells: { visible_to: c(GM_ONLY) } }),
        placed("high", 1, 1, { cells: { z: c(num(2)) } }),
        placed("low", 2, 2, { cells: { z: c(num(1)) } }),
        placed("hidden", 0, 0, { cells: { visible_to: c(GM_ONLY) } }),
      ]),
    );
    const gm = zonesOnBoard(t, { board: "table" });
    expect(gm.zones.map((z) => z.id)).toEqual(["pit", "vault"]);
    const pit = gm.zones[0];
    expect(pit?.contents).toEqual(["hidden", "low", "high"]);
    expect(pit?.view.cells.depth).toBeUndefined();
    expect(pit?.view.cells.name).toBeDefined();

    const aldric = zonesOnBoard(t, { board: "table", viewer: ALDRIC });
    expect(ZonesResultSchema.parse(aldric)).toEqual(aldric);
    expect(aldric.zones.map((z) => z.id)).toEqual(["pit"]);
    expect(aldric.zones[0]?.contents).toEqual(["low", "high"]);
  });

  test("a zone whose contents(zone) is #TYPE is listed with contents [] and error #TYPE", () => {
    // `position = "here"` (text, as a formula) leaves the zone unplaced, and
    // FORMULAS §6 excludes it: contents is [] without an error. A position
    // formula whose evaluation fails on text is #TYPE, which contents
    // propagates.
    const t = Table.fromSnapshot(
      snapshot([
        zone("bad", 0, 0, 4, { cells: { position: f('"here" + 1') } }),
        zone("unplaced", 0, 0, 4, { cells: { position: f('"here"') } }),
        zone("good", 0, 0, 4),
        placed("token", 1, 1),
      ]),
    );
    expect(t.value("bad", "position")).toMatchObject({ type: "error", code: "#TYPE" });
    expect(t.engine.evaluate("contents(this)", { thisId: "bad" })).toMatchObject({
      type: "error",
      code: "#TYPE",
    });
    expect(t.value("unplaced", "position")).toEqual(text("here"));
    expect(t.engine.evaluate("contents(this)", { thisId: "unplaced" })).toEqual(list([]));

    const r = zonesOnBoard(t, { board: "table" });
    expect(ZonesResultSchema.parse(r)).toEqual(r);
    expect(r.zones.map((z) => [z.id, z.contents, z.error])).toEqual([
      ["bad", [], "#TYPE"],
      ["good", ["token"], undefined],
      ["unplaced", [], undefined],
    ]);
    expect(r.zones[0]?.view.id).toBe("bad");
  });

  test("a zone whose position is #LIMIT: contents [] and error #LIMIT", () => {
    const t = Table.fromSnapshot(
      snapshot([
        ...filler(),
        zone("costly", 0, 0, 4, {
          cells: { w: c(num(1)), position: f(`[${EXPENSIVE}, 0]`) },
        }),
        zone("plain", 0, 0, 4),
        placed("token", 1, 1),
      ]),
    );
    expect(t.value("costly", "position")).toMatchObject({ type: "error", code: "#LIMIT" });
    const r = zonesOnBoard(t, { board: "table" });
    expect(ZonesResultSchema.parse(r)).toEqual(r);
    expect(r.zones.map((z) => [z.id, z.contents, z.error])).toEqual([
      ["costly", [], "#LIMIT"],
      ["plain", ["token"], undefined],
    ]);
  });
});

describe("at_position", () => {
  test("three covering tokens: #CYCLE position and #LIMIT z are omitted, the third returned", () => {
    const t = Table.fromSnapshot(
      snapshot([
        ...filler(),
        placed("cyclic", 0, 0, { shape: RECT4, cells: { position: f("this.position") } }),
        placed("costly", 0, 0, { shape: RECT4, cells: { w: c(num(1)), z: f(EXPENSIVE) } }),
        placed("plain", 0, 0, { shape: RECT4 }),
      ]),
    );
    expect(t.value("cyclic", "position")).toMatchObject({ type: "error", code: "#CYCLE" });
    expect(t.value("costly", "z")).toMatchObject({ type: "error", code: "#LIMIT" });
    const r = atPosition(t, { board: "table", position: [0.5, 0.5] });
    expect(AtPositionResultSchema.parse(r)).toEqual(r);
    expect(r).toEqual({ revision: 0, objects: ["plain"], zones: [] });
  });

  test("a zone whose position is #LIMIT is omitted", () => {
    const t = Table.fromSnapshot(
      snapshot([
        ...filler(),
        zone("costly", 0, 0, 4, { cells: { w: c(num(1)), position: f(`[${EXPENSIVE}, 0]`) } }),
        zone("plain", 0, 0, 4),
      ]),
    );
    expect(atPosition(t, { board: "table", position: [0, 0] })).toEqual({
      revision: 0,
      objects: [],
      zones: ["plain"],
    });
  });

  test("two stacked tokens come back in ascending z, then id", () => {
    const t = Table.fromSnapshot(
      snapshot([
        placed("top", 0, 0, { shape: RECT4, cells: { z: c(num(5)) } }),
        placed("bottom", 1, 0, { shape: RECT4, cells: { z: c(num(-1)) } }),
        placed("b_mid", 0, 1, { shape: RECT4 }),
        placed("a_mid", 0, 1, { shape: RECT4, cells: { z: f("0") } }),
        placed("away", 20, 20, { shape: RECT4 }),
      ]),
    );
    const r = atPosition(t, { board: "table", position: [0.5, 0.5] });
    expect(r.objects).toEqual(["bottom", "a_mid", "b_mid", "top"]);
  });

  test("inside a rotated rect zone returns the zone; outside its rotated region does not", () => {
    // A 10×2 rect anchored at the origin, rotated 90°: it spans y in [-5, 5], x in [-1, 1].
    const t = Table.fromSnapshot(
      snapshot([
        placed("lane", 0, 0, {
          is_zone: true,
          shape: { type: "rect", width: 10, height: 2 },
          cells: { rotation: c(num(90)) },
        }),
      ]),
    );
    expect(atPosition(t, { board: "table", position: [0, 4] }).zones).toEqual(["lane"]);
    expect(atPosition(t, { board: "table", position: [4, 0] }).zones).toEqual([]);
  });

  test("boundary inclusive; shapeless matches only at its anchor; contained objects excluded", () => {
    const t = Table.fromSnapshot(
      snapshot([
        placed("square", 0, 0, { shape: RECT4 }),
        placed("pin", 2, 2),
        placed("bag", 2, 2, { shape: RECT4, contents: ["coin"] }),
        obj("coin"),
      ]),
    );
    expect(atPosition(t, { board: "table", position: [2, 2] }).objects).toEqual([
      "bag",
      "pin",
      "square",
    ]);
    expect(atPosition(t, { board: "table", position: [2, 2.0001] }).objects).toEqual(["bag"]);
  });

  test("filtered by the viewer's visibility", () => {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("trap", 0, 0, { shape: RECT4, cells: { visible_to: c(GM_ONLY) } }),
        placed("rock", 0, 0, { shape: RECT4 }),
      ]),
    );
    expect(atPosition(t, { board: "table", position: [0, 0], viewer: ALDRIC }).objects).toEqual([
      "rock",
    ]);
    expect(atPosition(t, { board: "table", position: [0, 0] }).objects).toEqual(["rock", "trap"]);
  });
});

describe("changes_since", () => {
  function table(): Table {
    return Table.fromSnapshot(
      snapshot([
        character("aldric", 0, { cells: { hp: c(num(10)) } }),
        placed("secret", 5, 5, { cells: { visible_to: c(GM_ONLY), hp: c(num(1)) } }),
      ]),
    );
  }
  const write = (t: Table, id: string, hp: number) =>
    commit(t, (tx) => writeValue(tx, id, "hp", num(hp)));

  test("after three commits: three groups oldest first, next_revision the third's", () => {
    const t = table();
    write(t, "aldric", 9);
    write(t, "aldric", 8);
    write(t, "secret", 7);
    const r = changesSince(t, { revision: 0 });
    expect(ChangesSinceResultSchema.parse(r)).toEqual(r);
    expect(r.groups.map((g) => g.revision)).toEqual([1, 2, 3]);
    expect(r.groups.every((g) => Array.isArray(g.effects))).toBe(true);
    expect(r).toMatchObject({ revision: 3, floor: 0, truncated: false, more: false });
    expect(r.next_revision).toBe(3);
    expect(changesSince(t, { revision: 1 }).groups.map((g) => g.revision)).toEqual([2, 3]);
    expect(changesSince(t, { revision: 3 })).toEqual({
      revision: 3,
      floor: 0,
      groups: [],
      truncated: false,
      more: false,
      next_revision: 3,
    });
  });

  test("Aldric, limit 2: invisible pages advance, then the visible group", () => {
    const t = table();
    for (let i = 0; i < 5; i++) write(t, "secret", i);
    write(t, "aldric", 3);
    const pages = [];
    let revision = 0;
    for (let i = 0; i < 5; i++) {
      const r = changesSince(t, { revision, viewer: ALDRIC, limit: 2 });
      expect(ChangesSinceResultSchema.parse(r)).toEqual(r);
      pages.push(r);
      revision = r.next_revision;
      if (!r.more) break;
    }
    expect(pages.map((p) => [p.groups.length, p.more, p.next_revision])).toEqual([
      [0, true, 2],
      [0, true, 4],
      [1, false, 6],
    ]);
    expect(pages[2]?.groups[0]?.revision).toBe(6);
    expect(pages[2]?.groups[0]?.label).toBe("edit");
  });

  test("after compactLog: a too-old revision is truncated; with no groups floor is current", () => {
    const t = table();
    write(t, "aldric", 9);
    write(t, "aldric", 8);
    write(t, "aldric", 7);
    compactLog(t.store, 1);
    const old = changesSince(t, { revision: 0 });
    expect(old).toMatchObject({ revision: 3, floor: 2, truncated: true, more: false });
    expect(old.groups.map((g) => g.revision)).toEqual([3]);
    expect(changesSince(t, { revision: 2 }).truncated).toBe(false);

    compactLog(t.store, 0);
    const none = changesSince(t, { revision: 1 });
    expect(ChangesSinceResultSchema.parse(none)).toEqual(none);
    expect(none).toEqual({
      revision: 3,
      floor: 3,
      groups: [],
      truncated: true,
      more: false,
      next_revision: 3,
    });
    expect(changesSince(t, { revision: 3 }).truncated).toBe(false);
  });

  test("a revision above the current one is bad_request", () => {
    const t = table();
    expect(failure(() => changesSince(t, { revision: 1 })).error.code).toBe("bad_request");
  });
});

describe("log", () => {
  function table(): Table {
    const t = Table.fromSnapshot(
      snapshot([
        character("aldric", 0, { cells: { hp: c(num(10)) } }),
        placed("secret", 5, 5, { cells: { visible_to: c(GM_ONLY), hp: c(num(1)) } }),
      ]),
    );
    for (const [id, hp] of [
      ["aldric", 1],
      ["secret", 2],
      ["aldric", 3],
      ["aldric", 4],
    ] as const) {
      commit(t, (tx) => writeValue(tx, id, "hp", num(hp)));
    }
    return t;
  }

  test("newest first, before exclusive, effects only when asked", () => {
    const t = table();
    const r = logPage(t, {});
    expect(LogResultSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({ first_index: 0, next_index: 4, undo_barrier: 0 });
    expect(r.groups.map((g) => g.index)).toEqual([3, 2, 1, 0]);
    expect(r.groups[0]?.effects).toBeUndefined();
    expect(logPage(t, { effects: true }).groups[0]?.effects).toHaveLength(1);
    expect(logPage(t, { before: 2 }).groups.map((g) => g.index)).toEqual([1, 0]);
    expect(logPage(t, { limit: 2 }).groups.map((g) => g.index)).toEqual([3, 2]);
  });

  test("a character's log omits groups null for it", () => {
    const t = table();
    const r = logPage(t, { viewer: ALDRIC });
    expect(LogResultSchema.parse(r)).toEqual(r);
    expect(r.groups.map((g) => g.index)).toEqual([3, 2, 0]);
    expect(logPage(t, { viewer: ALDRIC, limit: 2, before: 3 }).groups.map((g) => g.index)).toEqual(
      [2, 0],
    );
  });

  test("first_index and undo_barrier follow compaction", () => {
    const t = table();
    compactLog(t.store, 2);
    const r = logPage(t, {});
    expect(r).toMatchObject({ first_index: 2, next_index: 4, undo_barrier: 2 });
    expect(r.groups.map((g) => g.index)).toEqual([3, 2]);
    expect(logPage(t, { before: 1 }).groups).toEqual([]);
  });
});

describe("document", () => {
  test("the canonical snapshot and the retained log, unfiltered", () => {
    const t = Table.fromSnapshot(
      snapshot([
        placed("zeta", 0, 0, { cells: { visible_to: c(GM_ONLY), b: c(num(2)), a: c(num(1)) } }),
        placed("alpha", 1, 0),
      ]),
    );
    commit(t, (tx) => writeValue(tx, "zeta", "a", num(3)));
    commit(t, (tx) => writeValue(tx, "alpha", "a", num(4)));
    compactLog(t.store, 1);
    const r = documentDump(t, {});
    expect(DocumentResultSchema.parse(r)).toEqual(r);
    expect(r.snapshot).toEqual(t.store.toSnapshot());
    expect(Object.keys(r.snapshot.objects)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(r.snapshot.objects.zeta?.cells ?? {})).toEqual([
      "a",
      "b",
      "position",
      "visible_to",
    ]);
    expect(r.log.first_index).toBe(1);
    expect(r.log.undo_barrier).toBe(1);
    expect(r.log.groups.map((g) => g.index)).toEqual([1]);
    expect(r.log.groups[0]).toEqual(t.store.history.get(1));
    // A copy: changing the result changes nothing in the store.
    expect(Object.isFrozen(r.log.groups[0])).toBe(false);
  });
});
