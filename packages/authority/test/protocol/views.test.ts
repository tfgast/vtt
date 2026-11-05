/**
 * ViewBuilder (vtt-5su.6; PROTOCOL.md §7): object views, redaction, covers,
 * effect and group views, for the GM and for character viewers.
 */
import {
  createObject,
  FACE_DOWN_EXEMPT,
  remove,
  STRUCTURAL_VIEW_CELLS,
  setActions,
  setCellVisibility,
  setFormula,
  Table,
  type Transaction,
  undo,
  ViewBuilder,
  type Viewer,
  writeValue,
} from "@vtt/authority";
import {
  type Cover,
  CoverSchema,
  EffectViewSchema,
  type GroupView,
  GroupViewSchema,
  ObjectViewSchema,
  WireResultSchema,
} from "@vtt/protocol";
import {
  type Actor,
  bool,
  type Cell,
  type Effect,
  list,
  num,
  type OpGroup,
  type Point,
  pointInRegion,
  ref,
  type Shape,
  STRUCTURAL_CELLS,
  type TableObject,
  text,
  type ViewerEntry,
  type ViewersValue,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, c, f, obj, placed, snapshot, zone } from "../engine/helpers";
import { loadScenarioFile } from "../runner/load";
import { documentFromSetup } from "../runner/setup";

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const BRYN: Viewer = { type: "character", id: "bryn" };
const GM_ACTOR: Actor = { type: "gm" };

const viewers = (...entries: ViewerEntry[]): ViewersValue => ({
  type: "viewers",
  viewers: entries,
});
const GM_ONLY = viewers("gm");
const REDACTED = { type: "redacted" };
const RECT10: Shape = { type: "rect", width: 10, height: 10 };

/** A character standing on board `table` at (x, -50), outside every test zone. */
const character = (id: string, x: number, rest: Partial<TableObject> = {}): TableObject =>
  placed(id, x, -50, { is_character: true, ...rest, cells: { name: c(text(id)), ...rest.cells } });

const sortedKeys = (r: object | undefined) => Object.keys(r ?? {}).sort();

async function fixtureTable(file: string): Promise<Table> {
  const scenario = await loadScenarioFile(file);
  return Table.fromSnapshot(documentFromSetup(scenario.setup));
}

/** Commits `fn` as one GM edit group labelled `label`; returns the group. */
function group(table: Table, label: string, fn: (tx: Transaction) => void) {
  const result = table.store.transact(GM_ACTOR, { kind: "edit", label }, fn);
  if (!result.ok) throw new Error(JSON.stringify(result.rejection));
  return result.group;
}

const ALL_VIEW_CELLS = (user: string[]) => [...STRUCTURAL_VIEW_CELLS, ...user].sort();

describe("STRUCTURAL_VIEW_CELLS", () => {
  test("is every structural cell except id", () => {
    expect([...STRUCTURAL_VIEW_CELLS]).toEqual(
      STRUCTURAL_CELLS.map((s) => s.name).filter((n) => n !== "id"),
    );
  });
});

describe("objectView", () => {
  test("goblin-hit: the GM sees ac and hit's source; Aldric sees hit's value only", async () => {
    const table = await fixtureTable("goblin-hit.json");
    const gm = new ViewBuilder(table, GM).objectView("goblin1", "all");
    expect(sortedKeys(gm?.cells)).toEqual(ALL_VIEW_CELLS(["ac", "hit"]));
    expect(gm?.cells.ac).toEqual({ value: num(13), kind: "literal", visibility: GM_ONLY });
    expect(gm?.cells.hit).toEqual({
      value: bool(false),
      kind: "formula",
      source: 'any(on(this).where(tag has "d20").total >= ac)',
      overridden: false,
    });
    expect(gm?.is_template).toBe(false);
    expect(gm?.is_character).toBe(false);

    const aldric = new ViewBuilder(table, ALDRIC).objectView("goblin1", "all");
    expect(aldric?.cells.ac).toBeUndefined();
    expect(aldric?.cells.hit).toEqual({ value: bool(false), kind: "formula", overridden: false });
    expect(aldric?.cells.name).toEqual({ value: text("Goblin"), kind: "literal" });
    expect(sortedKeys(aldric?.cells)).toEqual(ALL_VIEW_CELLS(["hit"]));
  });

  test("actions: the GM gets when and steps, a character names only", async () => {
    const table = await fixtureTable("goblin-hit.json");
    expect(new ViewBuilder(table, GM).objectView("die1", "all")?.actions).toEqual([
      { name: "Roll", steps: ["roll(1d20) -> value"] },
    ]);
    expect(new ViewBuilder(table, ALDRIC).objectView("die1", "all")?.actions).toEqual([
      { name: "Roll" },
    ]);
  });

  test("a face-down card shows only FACE_DOWN_EXEMPT cells to a non-owner, all to its owner", () => {
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        character("bryn", 2),
        placed("card", 5, 5, {
          shape: { type: "rect", width: 1, height: 1 },
          cells: {
            name: c(text("Ace")),
            face_up: c(bool(false)),
            owner: c(ref("aldric")),
            power: c(num(7)),
          },
        }),
      ]),
    );
    const bryn = new ViewBuilder(table, BRYN).objectView("card", "all");
    expect(sortedKeys(bryn?.cells)).toEqual([...FACE_DOWN_EXEMPT].sort());
    const aldric = new ViewBuilder(table, ALDRIC).objectView("card", "all");
    expect(sortedKeys(aldric?.cells)).toEqual(ALL_VIEW_CELLS(["power"]));
    expect(aldric?.cells.power?.value).toEqual(num(7));
  });

  test("a card in Aldric's hand is invisible to Bryn; a public hand's contents keep their count", () => {
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        character("bryn", 2),
        placed("hand1", 0, 10, {
          contents: ["card1"],
          cells: { visible_to: c(viewers(ref("aldric"))) },
        }),
        obj("card1", { cells: { visible_to: c(viewers("all")) } }),
        placed("hand2", 3, 10, { contents: ["card2"] }),
        obj("card2", { cells: { visible_to: c(viewers(ref("aldric"))) } }),
      ]),
    );
    const bryn = new ViewBuilder(table, BRYN);
    expect(bryn.objectView("card1", "all")).toBeNull();
    expect(bryn.objectView("hand1", "all")).toBeNull();
    expect(bryn.objectView("hand2", "all")?.cells.contents?.value).toEqual({
      type: "list",
      items: [REDACTED],
    });
    const aldric = new ViewBuilder(table, ALDRIC);
    expect(aldric.objectView("card1", "all")).not.toBeNull();
    expect(aldric.objectView("hand2", "all")?.cells.contents?.value).toEqual(list([ref("card2")]));
  });

  test("kind: formula with an override, literal, defaulted and field-backed structural", () => {
    const overridden: Cell = {
      content: { type: "formula", source: "[1, 2]" },
      override: list([num(4), num(4)]),
    };
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("tok", 0, 0, { tag: ["pc"], cells: { position: overridden, name: c(text("Tok")) } }),
      ]),
    );
    for (const viewer of [GM, ALDRIC]) {
      const view = new ViewBuilder(table, viewer).objectView("tok", "all");
      expect(view?.cells.position?.kind).toBe("formula");
      expect(view?.cells.position?.overridden).toBe(true);
      expect(view?.cells.position?.value).toEqual(list([num(4), num(4)]));
      expect(view?.cells.name?.kind).toBe("literal");
      expect(view?.cells.rotation).toEqual({ value: { type: "empty" }, kind: "structural" });
      expect(view?.cells.tag).toEqual({ value: list([text("pc")]), kind: "structural" });
    }
    expect(new ViewBuilder(table, GM).objectView("tok", "all")?.cells.position?.source).toBe(
      "[1, 2]",
    );
    expect(
      new ViewBuilder(table, ALDRIC).objectView("tok", "all")?.cells.position?.source,
    ).toBeUndefined();
  });

  test('cells: "structural" is exactly STRUCTURAL_VIEW_CELLS; a list restricts to those names', () => {
    const table = Table.fromSnapshot(
      snapshot([character("aldric", 0), placed("tok", 0, 0, { cells: { hp: c(num(3)) } })]),
    );
    const gm = new ViewBuilder(table, GM);
    expect(sortedKeys(gm.objectView("tok", "structural")?.cells)).toEqual(
      [...STRUCTURAL_VIEW_CELLS].sort(),
    );
    expect(sortedKeys(gm.objectView("tok", ["hp", "name", "nope", "id"])?.cells)).toEqual([
      "hp",
      "name",
    ]);
    expect(gm.objectView("nobody", "all")).toBeNull();
  });
});

describe("redact", () => {
  const redactionTable = () =>
    Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        character("bryn", 2, { cells: { visible_to: c(viewers(ref("bryn"))) } }),
        placed("ghost", 20, 20, { cells: { visible_to: c(GM_ONLY) } }),
        placed("note", 21, 21, {
          cells: {
            target: c(ref("ghost")),
            via: f("target"),
            gone: c(ref("nobody")),
            where: c(ref("table")),
            nested: c(list([list([ref("ghost"), num(1)]), ref("aldric")])),
            party: c(viewers("owner", ref("bryn"), ref("aldric"))),
          },
        }),
      ]),
    );

  test("refs to invisible or dead objects become redacted at any depth; board refs stay", () => {
    const table = redactionTable();
    const cells = new ViewBuilder(table, ALDRIC).objectView("note", "all")?.cells;
    expect(cells?.target?.value).toEqual(REDACTED);
    expect(cells?.via?.value).toEqual(REDACTED);
    expect(cells?.gone?.value).toEqual(REDACTED);
    expect(cells?.where?.value).toEqual(ref("table"));
    expect(cells?.board?.value).toEqual(ref("table"));
    expect(cells?.nested?.value).toEqual({
      type: "list",
      items: [{ type: "list", items: [REDACTED, num(1)] }, ref("aldric")],
    });
    expect(cells?.party?.value).toEqual({
      type: "viewers",
      viewers: ["owner", REDACTED, ref("aldric")],
    });
  });

  test("the GM's conversion is the identity", () => {
    const table = redactionTable();
    const gm = new ViewBuilder(table, GM);
    const cells = gm.objectView("note", "all")?.cells;
    expect(cells?.target?.value).toEqual(ref("ghost"));
    expect(cells?.gone?.value).toEqual(ref("nobody"));
    expect(cells?.party?.value).toEqual(viewers("owner", ref("bryn"), ref("aldric")));
    expect(gm.redact(list([ref("ghost")]))).toEqual(list([ref("ghost")]));
  });

  test("an error whose origin the viewer cannot see keeps only its code", () => {
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("goblin", 5, 5, {
          cells: { ac: f("1 / 0"), shown: f("ac + 1"), bad: f("1 / 0") },
          cell_visibility: { ac: GM_ONLY },
        }),
      ]),
    );
    const raw = table.value("goblin", "shown");
    expect(raw).toMatchObject({
      type: "error",
      code: "#DIV0",
      origin: { object: "goblin", cell: "ac" },
    });
    expect(new ViewBuilder(table, GM).objectView("goblin", "all")?.cells.shown?.value).toEqual(raw);
    const aldric = new ViewBuilder(table, ALDRIC);
    expect(aldric.objectView("goblin", "all")?.cells.shown?.value).toEqual({
      type: "error",
      code: "#DIV0",
    });
    // An origin the viewer can see is kept, with the message.
    expect(aldric.objectView("goblin", "all")?.cells.bad?.value).toEqual(
      table.value("goblin", "bad"),
    );
  });
});

describe("covers", () => {
  test("a hidden opaque room: Aldric gets its region and sees neither it nor the token under it", () => {
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 30),
        zone("room", 0, 0, 10, { cells: { opaque: c(bool(true)), visible_to: c(GM_ONLY) } }),
        placed("orc", 1, 1),
      ]),
    );
    const aldric = new ViewBuilder(table, ALDRIC);
    expect(aldric.covers("table")).toEqual([
      {
        key: expect.any(String),
        board: "table",
        region: { position: [0, 0], rotation: 0, shape: RECT10 },
      },
    ]);
    expect(aldric.objectView("room", "all")).toBeNull();
    expect(aldric.objectView("orc", "all")).toBeNull();
    expect(aldric.objectView("aldric", "all")).not.toBeNull();
    expect(new ViewBuilder(table, GM).covers("table")).toEqual([]);
  });

  test("an otherwise empty board with one hidden opaque zone gives one cover", () => {
    const table = Table.fromSnapshot(
      snapshot(
        [
          character("aldric", 0),
          zone("vault", 0, 0, 10, {
            board: "crypt",
            cells: { opaque: c(bool(true)), visible_to: c(GM_ONLY) },
          }),
        ],
        ["table", "crypt"],
      ),
    );
    const covers = new ViewBuilder(table, ALDRIC).covers("crypt");
    expect(covers).toHaveLength(1);
    expect(covers[0]?.board).toBe("crypt");
    expect(new ViewBuilder(table, ALDRIC).covers("table")).toEqual([]);
  });

  /** A hidden zone at the origin with `cells`, a public token inside and one outside. */
  function parity(cells: Record<string, Cell>, shape: Shape | null = RECT10) {
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        zone("z", 0, 0, 10, { shape, cells: { visible_to: c(GM_ONLY), ...cells } }),
        placed("inside", 1, 1),
        placed("outside", 30, 30),
      ]),
    );
    return {
      table,
      covers: new ViewBuilder(table, ALDRIC).covers("table"),
      inside: table.visibility.canSeeObject(ALDRIC, "inside"),
      outside: table.visibility.canSeeObject(ALDRIC, "outside"),
    };
  }
  const regionCover = { position: [0, 0], rotation: 0, shape: RECT10 };

  test("(a) unreadable geometry covers the whole board whatever opaque is", () => {
    for (const opaque of [true, false]) {
      const r = parity({ position: f("1 / 0"), opaque: c(bool(opaque)) });
      expect(r.table.value("z", "position").type).toBe("error");
      expect(r.covers.map((x) => x.region)).toEqual([{ whole_board: true }]);
      expect([r.inside, r.outside]).toEqual([false, false]);
    }
  });

  test("(b) valid geometry without a shape covers nothing", () => {
    const r = parity({ opaque: c(bool(true)) }, null);
    expect(r.covers).toEqual([]);
    expect([r.inside, r.outside]).toEqual([true, true]);
  });

  test("(c) valid geometry with a shape and opaque true, an error or a non-boolean covers its region", () => {
    const cases: Record<string, Cell> = {
      ref_error: f('obj("Nobody")'),
      text: f('"yes"'),
      literal_true: c(bool(true)),
    };
    for (const [label, opaque] of Object.entries(cases)) {
      const r = parity({ opaque });
      if (label === "ref_error") {
        expect(r.table.value("z", "opaque")).toMatchObject({ type: "error", code: "#REF" });
      }
      if (label === "text") expect(r.table.value("z", "opaque")).toEqual(text("yes"));
      expect(
        r.covers.map((x) => x.region),
        label,
      ).toEqual([regionCover]);
      expect([r.inside, r.outside], label).toEqual([false, true]);
    }
  });

  test("(d) valid geometry with opaque false covers nothing", () => {
    const r = parity({ opaque: c(bool(false)) });
    expect(r.covers).toEqual([]);
    expect([r.inside, r.outside]).toEqual([true, true]);
  });

  test("overlapping hidden opaque zones: covers are the zones not effectively visible and agree with canSeeObject", () => {
    const hidden = { opaque: c(bool(true)), visible_to: c(GM_ONLY) };
    const tokens: TableObject[] = [];
    for (let x = -40; x <= 20; x += 2.5) {
      for (let y = -12; y <= 16; y += 2) {
        tokens.push(placed(`t${tokens.length}`, x, y));
      }
    }
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        zone("hall", 0, 0, 20, { cells: hidden }),
        zone("den", 8, 8, 10, { cells: hidden }),
        // Seen by Aldric, but under the hall: no cover of its own.
        zone("nook", -5, -5, 4, {
          cells: { opaque: c(bool(true)), visible_to: c(viewers(ref("aldric"))) },
        }),
        zone("lit", -30, 0, 10, { cells: { opaque: c(bool(true)) } }),
        ...tokens,
      ]),
    );
    const covers = new ViewBuilder(table, ALDRIC).covers("table");
    const notEffectivelyVisible = ["hall", "den", "nook", "lit"].filter(
      (z) => !table.visibility.isEffectivelyVisible(ALDRIC, z),
    );
    expect(notEffectivelyVisible).toEqual(["hall", "den"]);
    expect(covers.map((x) => x.region)).toEqual([
      { position: [0, 0], rotation: 0, shape: { type: "rect", width: 20, height: 20 } },
      { position: [8, 8], rotation: 0, shape: RECT10 },
    ]);
    let hiddenCount = 0;
    for (const t of tokens) {
      const anchor = (t.cells.position?.content as { items: { value: number }[] }).items.map(
        (i) => i.value,
      ) as Point;
      const covered = covers.some(
        (cv) =>
          "position" in cv.region &&
          pointInRegion(anchor, cv.region.shape, cv.region.position, cv.region.rotation),
      );
      if (covered) hiddenCount++;
      expect(table.visibility.canSeeObject(ALDRIC, t.id), t.id).toBe(!covered);
    }
    expect(hiddenCount).toBeGreaterThan(0);
    expect(hiddenCount).toBeLessThan(tokens.length);
  });

  test("cover keys are stable across builders and do not contain the zone id", () => {
    const table = Table.fromSnapshot(
      snapshot([
        character("aldric", 30),
        zone("secret_room", 0, 0, 10, {
          cells: { opaque: c(bool(true)), visible_to: c(GM_ONLY) },
        }),
        zone("other_room", 40, 0, 10, {
          cells: { opaque: c(bool(true)), visible_to: c(GM_ONLY) },
        }),
      ]),
    );
    const a = new ViewBuilder(table, ALDRIC).covers("table");
    const b = new ViewBuilder(table, ALDRIC).covers("table");
    expect(a).toHaveLength(2);
    expect(b).toEqual(a);
    expect(new Set(a.map((x) => x.key)).size).toBe(2);
    for (const cover of a) {
      expect(cover.key).not.toContain("secret_room");
      expect(cover.key).not.toContain("other_room");
    }
  });

  test("coverBoards maps a contained object to its outermost container's board", () => {
    const table = Table.fromSnapshot(
      snapshot(
        [
          character("aldric", 0),
          placed("hand", 0, 0, { board: "crypt", contents: ["card"] }),
          obj("card"),
        ],
        ["table", "crypt"],
      ),
    );
    const b = new ViewBuilder(table, ALDRIC);
    expect(b.coverBoards(["card"])).toEqual(["crypt"]);
    expect(b.coverBoards(["card", "hand", "aldric", "nobody"])).toEqual(["crypt", "table"]);
  });
});

describe("group views", () => {
  const groupTable = () =>
    Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        placed("goblin", 5, 5, {
          cells: { name: c(text("Goblin")), hp: c(num(7)), ac: c(num(13)) },
          cell_visibility: { ac: GM_ONLY },
        }),
        placed("goblin2", 8, 5, { cells: { name: c(text("Other goblin")) } }),
        placed("masked", 9, 5, {
          cells: { name: c(text("Masked stranger")), hp: c(num(4)) },
          cell_visibility: { name: GM_ONLY },
        }),
        placed("ghost", 20, 20, { cells: { visible_to: c(GM_ONLY), name: c(text("Ghost")) } }),
      ]),
    );

  test("a creation snapshot hides GM-only cells and formula sources from Aldric", () => {
    const table = groupTable();
    const g = group(table, "Spawn a chest", (tx) => {
      createObject(
        tx,
        {
          cells: { name: c(text("Chest")), secret: c(num(1)), lock: f("secret + 1") },
          cell_visibility: { secret: GM_ONLY },
        },
        { type: "board", board: "table", position: [3, 3] },
        "chest",
      );
    });
    const create = (v: GroupView | null) => v?.effects?.find((e) => e.type === "create");

    const aldric = new ViewBuilder(table, ALDRIC).groupView(g, { effects: true });
    const ac = create(aldric);
    if (ac?.type !== "create") throw new Error("no create effect");
    const snap = ac.objects[0];
    expect(snap?.id).toBe("chest");
    expect(snap?.cells.secret).toBeUndefined();
    expect(snap?.cells.lock).toEqual({ kind: "formula" });
    expect(snap?.cells.name).toEqual({ kind: "literal", value: text("Chest") });
    expect(snap?.cell_visibility).toBeUndefined();
    expect(aldric?.label).toBeNull();
    expect(aldric?.names).toEqual({ chest: "Chest" });

    const gm = new ViewBuilder(table, GM).groupView(g, { effects: true });
    const gc = create(gm);
    if (gc?.type !== "create") throw new Error("no create effect");
    expect(gc.objects[0]?.cells.secret).toEqual({ kind: "literal", value: num(1) });
    expect(gc.objects[0]?.cells.lock).toEqual({ kind: "formula", source: "secret + 1" });
    expect(gc.objects[0]?.cell_visibility).toEqual({ secret: GM_ONLY });
    expect(gm?.label).toBe("Spawn a chest");
  });

  test("a formula set and then overridden shows the override without the source", () => {
    const table = groupTable();
    const g = group(table, "Fix hp", (tx) => {
      setFormula(tx, "goblin", "hp", "3 + 4");
      writeValue(tx, "goblin", "hp", num(2));
    });
    const aldric = new ViewBuilder(table, ALDRIC).groupView(g, { effects: true });
    expect(aldric?.effects).toEqual([
      {
        type: "cell",
        object: "goblin",
        cell: "hp",
        before: { kind: "literal", value: num(7) },
        after: { kind: "formula" },
        cause: "edit",
      },
      {
        type: "cell",
        object: "goblin",
        cell: "hp",
        before: { kind: "formula" },
        after: { kind: "formula", override: num(2) },
        cause: "edit",
      },
    ]);
    // Leaving out formula source is how every character sees cells, not a reduction.
    expect(aldric?.label).toBe("Fix hp");
    const gm = new ViewBuilder(table, GM).groupView(g, { effects: true });
    expect(gm?.effects?.[1]).toMatchObject({
      after: { kind: "formula", source: "3 + 4", override: num(2) },
    });
  });

  test("setActions: Aldric sees names only, the GM when and steps", () => {
    const table = groupTable();
    const g = group(table, "Teach bite", (tx) => {
      setActions(tx, "goblin", [{ name: "Bite", when: "hp > 0", steps: ["1 -> hp"] }]);
    });
    expect(new ViewBuilder(table, ALDRIC).groupView(g, { effects: true })?.effects).toEqual([
      { type: "field", object: "goblin", field: "actions", before: [], after: [{ name: "Bite" }] },
    ]);
    expect(new ViewBuilder(table, GM).groupView(g, { effects: true })?.effects).toEqual([
      {
        type: "field",
        object: "goblin",
        field: "actions",
        before: [],
        after: [{ name: "Bite", when: "hp > 0", steps: ["1 -> hp"] }],
      },
    ]);
  });

  test("hidden writes and cell_visibility effects are dropped; the header stays; label is null", () => {
    const table = groupTable();
    const g = group(table, "Wound the goblin", (tx) => {
      writeValue(tx, "goblin", "ac", num(15));
      setCellVisibility(tx, "goblin", "notes", viewers("all"));
      writeValue(tx, "goblin", "hp", num(5));
    });
    const aldric = new ViewBuilder(table, ALDRIC).groupView(g, { effects: true });
    expect(aldric).toMatchObject({
      index: g.index,
      revision: g.revision,
      base_revision: g.base_revision,
      actor: GM_ACTOR,
      kind: "edit",
      label: null,
      undone: false,
      names: { goblin: "Goblin" },
    });
    expect(aldric?.effects).toEqual([
      {
        type: "cell",
        object: "goblin",
        cell: "hp",
        before: { kind: "literal", value: num(7) },
        after: { kind: "literal", value: num(5) },
        cause: "edit",
      },
    ]);
    const gm = new ViewBuilder(table, GM).groupView(g, { effects: true });
    expect(gm?.label).toBe("Wound the goblin");
    expect(gm?.effects).toHaveLength(3);
  });

  test("a group touching only invisible objects is null for Aldric, with or without effects", () => {
    const table = groupTable();
    const g = group(table, "Haunt", (tx) => writeValue(tx, "ghost", "rage", num(9)));
    const aldric = new ViewBuilder(table, ALDRIC);
    expect(aldric.groupView(g, { effects: true })).toBeNull();
    expect(aldric.groupView(g, { effects: false })).toBeNull();
    expect(new ViewBuilder(table, GM).groupView(g, { effects: false })).not.toBeNull();
  });

  test("a remove is dropped while the object is gone and shown again after undo re-creates it", () => {
    const table = groupTable();
    const g = group(table, "Slay", (tx) => remove(tx, "goblin2"));
    expect(new ViewBuilder(table, ALDRIC).groupView(g, { effects: true })).toBeNull();
    expect(new ViewBuilder(table, GM).groupView(g, { effects: true })?.undone).toBe(false);

    const result = undo(table.store, GM_ACTOR);
    expect(result.ok).toBe(true);
    const aldric = new ViewBuilder(table, ALDRIC).groupView(g, { effects: true });
    expect(aldric?.effects?.map((e) => e.type)).toEqual(["remove"]);
    const removed = aldric?.effects?.[0];
    if (removed?.type !== "remove") throw new Error("no remove effect");
    expect(removed.objects.map((o) => o.id)).toEqual(["goblin2"]);
    expect(aldric?.names).toEqual({ goblin2: "Other goblin" });
    expect(aldric?.undone).toBe(true);
  });

  test("names: an object whose name cell is GM-only is not named for Aldric", () => {
    const table = groupTable();
    const g = group(table, "Hurt the stranger", (tx) => writeValue(tx, "masked", "hp", num(1)));
    const aldric = new ViewBuilder(table, ALDRIC).groupView(g, { effects: true });
    expect(aldric?.names).toEqual({});
    expect(aldric?.effects).toHaveLength(1);
    expect(new ViewBuilder(table, GM).groupView(g, { effects: true })?.names).toEqual({
      masked: "Masked stranger",
    });
  });

  test("label: null for a partly hidden group, kept for a wholly visible one", () => {
    const table = groupTable();
    const mixed = group(table, "Mixed", (tx) => {
      writeValue(tx, "goblin", "hp", num(6));
      writeValue(tx, "goblin", "ac", num(14));
    });
    expect(new ViewBuilder(table, ALDRIC).groupView(mixed, { effects: false })?.label).toBeNull();
    expect(new ViewBuilder(table, GM).groupView(mixed, { effects: false })?.label).toBe("Mixed");
    const open = group(table, "Open", (tx) => writeValue(tx, "goblin", "hp", num(5)));
    const view = new ViewBuilder(table, ALDRIC).groupView(open, { effects: false });
    expect(view?.label).toBe("Open");
    expect(view?.effects).toBeUndefined();
  });

  test("the GM view is the raw group plus undone, every effect variant converted losslessly", () => {
    const table = groupTable();
    const full: TableObject = obj("box", {
      is_zone: true,
      tag: ["crate"],
      shape: RECT10,
      board: "table",
      contents: ["gem"],
      cells: {
        name: c(text("Box")),
        position: at(1, 2),
        weight: { content: { type: "formula", source: "2 * 3" }, override: num(5) },
      },
      cell_visibility: { weight: GM_ONLY },
      actions: [
        { name: "Open", when: "true", steps: ["1 -> x"] },
        { name: "Kick", steps: [] },
      ],
    });
    const gem = obj("gem");
    const effects: Effect[] = [
      { type: "cell", object: "box", cell: "hp", before: null, after: c(num(3)), cause: "edit" },
      {
        type: "cell",
        object: "box",
        cell: "w",
        before: f("1"),
        after: { content: { type: "formula", source: "1" }, override: num(2) },
        cause: "roll",
      },
      { type: "cell_visibility", object: "box", cell: "hp", before: null, after: GM_ONLY },
      { type: "field", object: "box", field: "tag", before: [], after: ["crate"] },
      { type: "field", object: "box", field: "shape", before: null, after: RECT10 },
      { type: "field", object: "box", field: "is_template", before: false, after: true },
      { type: "field", object: "box", field: "is_character", before: true, after: false },
      {
        type: "field",
        object: "box",
        field: "actions",
        before: [],
        after: [{ name: "Open", when: "true", steps: ["1 -> x"] }],
      },
      {
        type: "place",
        object: "gem",
        before: { type: "board", board: "table" },
        after: { type: "container", container: "box", index: 0 },
      },
      { type: "create", objects: [full, gem], location: { type: "board", board: "table" } },
      {
        type: "remove",
        objects: [gem],
        location: { type: "container", container: "box", index: 0 },
      },
      { type: "reorder", container: "box", before: ["a", "b"], after: ["b", "a"] },
      { type: "board", before: null, after: { id: "attic", name: "Attic" } },
      { type: "board", before: { id: "attic" }, after: null },
      { type: "allocate", ids: ["box", "gem"], seq_before: 1, seq_after: 1 },
      { type: "retire", ids: ["gem"] },
    ];
    const raw: OpGroup = {
      index: 99,
      base_revision: 4,
      revision: 5,
      actor: { type: "agent", name: "helper" },
      kind: "action",
      label: "Everything",
      origin: { object: "box", action: "Open" },
      names: { box: "Box" },
      effects,
    };
    const snap = {
      id: "box",
      is_template: false,
      is_zone: true,
      is_character: false,
      tag: ["crate"],
      shape: RECT10,
      contents: ["gem"],
      cells: {
        name: { kind: "literal", value: text("Box") },
        position: { kind: "literal", value: list([num(1), num(2)]) },
        weight: { kind: "formula", source: "2 * 3", override: num(5) },
      },
      cell_visibility: { weight: GM_ONLY },
      actions: [
        { name: "Open", when: "true", steps: ["1 -> x"] },
        { name: "Kick", steps: [] },
      ],
    };
    const gemSnap = {
      id: "gem",
      is_template: false,
      is_zone: false,
      is_character: false,
      tag: [],
      shape: null,
      contents: [],
      cells: {},
      cell_visibility: {},
      actions: [],
    };
    const expected: GroupView = {
      index: 99,
      base_revision: 4,
      revision: 5,
      actor: { type: "agent", name: "helper" },
      kind: "action",
      label: "Everything",
      origin: { object: "box", action: "Open" },
      undone: false,
      names: { box: "Box" },
      effects: [
        {
          type: "cell",
          object: "box",
          cell: "hp",
          before: null,
          after: { kind: "literal", value: num(3) },
          cause: "edit",
        },
        {
          type: "cell",
          object: "box",
          cell: "w",
          before: { kind: "formula", source: "1" },
          after: { kind: "formula", source: "1", override: num(2) },
          cause: "roll",
        },
        { type: "cell_visibility", object: "box", cell: "hp", before: null, after: GM_ONLY },
        { type: "field", object: "box", field: "tag", before: [], after: ["crate"] },
        { type: "field", object: "box", field: "shape", before: null, after: RECT10 },
        { type: "field", object: "box", field: "is_template", before: false, after: true },
        { type: "field", object: "box", field: "is_character", before: true, after: false },
        {
          type: "field",
          object: "box",
          field: "actions",
          before: [],
          after: [{ name: "Open", when: "true", steps: ["1 -> x"] }],
        },
        {
          type: "place",
          object: "gem",
          before: { type: "board", board: "table" },
          after: { type: "container", container: "box", index: 0 },
        },
        { type: "create", location: { type: "board", board: "table" }, objects: [snap, gemSnap] },
        {
          type: "remove",
          location: { type: "container", container: "box", index: 0 },
          objects: [gemSnap],
        },
        { type: "reorder", container: "box", before: ["a", "b"], after: ["b", "a"] },
        { type: "board", before: null, after: { id: "attic", name: "Attic" } },
        { type: "board", before: { id: "attic" }, after: null },
        { type: "allocate", ids: ["box", "gem"], seq_before: 1, seq_after: 1 },
        { type: "retire", ids: ["gem"] },
      ],
    };
    const gm = new ViewBuilder(table, GM);
    expect(gm.groupView(raw, { effects: true })).toEqual(expected);
    const { effects: _, ...header } = expected;
    expect(gm.groupView(raw, { effects: false })).toEqual(header);
    for (const e of effects) expect(gm.filterEffect(e).reduced).toBe(false);

    // A committed group: the raw fields plus undone.
    const g = group(table, "Wound", (tx) => writeValue(tx, "goblin", "hp", num(1)));
    const { effects: rawEffects, ...rawHeader } = g;
    expect(rawEffects).toHaveLength(1);
    expect(gm.groupView(g, { effects: false })).toEqual({ ...rawHeader, undone: false });
  });
});

describe("wire schemas", () => {
  test("every view parses unchanged with the @vtt/protocol schemas", async () => {
    const table = await fixtureTable("goblin-hit.json");
    const builders = [new ViewBuilder(table, GM), new ViewBuilder(table, ALDRIC)];
    const g = group(table, "Mixed", (tx) => {
      writeValue(tx, "goblin1", "ac", num(14));
      setFormula(tx, "goblin1", "hp", "3");
      writeValue(tx, "goblin1", "hp", num(2));
      setCellVisibility(tx, "goblin1", "hp", viewers("all", ref("aldric")));
      createObject(
        tx,
        { cells: { name: c(text("Chest")), lock: f("1") } },
        { type: "container", container: "dice_bag" },
        "chest",
      );
    });
    for (const b of [new ViewBuilder(table, GM), new ViewBuilder(table, ALDRIC), ...builders]) {
      for (const id of table.store.objectIds()) {
        const view = b.objectView(id, "all");
        if (view !== null) expect(ObjectViewSchema.parse(view)).toEqual(view);
      }
      const gv = b.groupView(g, { effects: true });
      expect(gv).not.toBeNull();
      expect(GroupViewSchema.parse(gv)).toEqual(gv);
      for (const e of g.effects) {
        const ev = b.effectView(e);
        if (ev !== null) expect(EffectViewSchema.parse(ev)).toEqual(ev);
      }
      expect(WireResultSchema.parse(b.redact(table.value("goblin1", "hit")))).toBeTruthy();
    }
    const zoned = Table.fromSnapshot(
      snapshot([
        character("aldric", 0),
        zone("room", 0, 0, 10, { cells: { opaque: c(bool(true)), visible_to: c(GM_ONLY) } }),
        zone("bad", 30, 0, 10, { cells: { position: f("1 / 0"), visible_to: c(GM_ONLY) } }),
      ]),
    );
    const covers: Cover[] = new ViewBuilder(zoned, ALDRIC).covers("table");
    expect(covers).toHaveLength(2);
    for (const cover of covers) expect(CoverSchema.parse(cover)).toEqual(cover);
  });
});
