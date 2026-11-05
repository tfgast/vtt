/** Visibility (DESIGN.md §4.4; FIXTURES.md §7) over a literal reader and a stub cover. */
import {
  type CoverOracle,
  type CoverResult,
  DocumentStore,
  FACE_DOWN_EXEMPT,
  type Viewer,
  Visibility,
  type VisibilityReader,
} from "@vtt/authority";
import {
  bool,
  type Cell,
  EMPTY,
  err,
  list,
  num,
  type ObjectId,
  type Result,
  ref,
  type Snapshot,
  type TableObject,
  text,
  type ViewerEntry,
  type ViewersValue,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";

const viewers = (...entries: ViewerEntry[]): ViewersValue => ({ type: "viewers", viewers: entries });
const c = (content: Cell["content"]): Cell => ({ content });
const ALL = viewers("all");
const GM_ONLY = viewers("gm");

function obj(id: string, rest: Partial<TableObject> = {}): TableObject {
  return {
    id,
    is_template: false,
    is_zone: false,
    is_character: false,
    tag: [],
    shape: null,
    board: null,
    contents: [],
    cells: {},
    cell_visibility: {},
    actions: [],
    ...rest,
  };
}

const at = (x: number, y: number): Cell => c(list([num(x), num(y)]));
const character = (id: string, x: number): TableObject =>
  obj(id, {
    is_character: true,
    board: "table",
    shape: { type: "circle", radius: 0.5 },
    cells: { name: c(text(id)), position: at(x, 0) },
  });

function snapshot(objects: TableObject[]): Snapshot {
  return {
    revision: 0,
    next_seq: 1,
    boards: [{ id: "table", name: "Table" }],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

/**
 * A world: characters aldric, bryn, cara; a non-character `statue`; plus the
 * objects given. The reader returns `values[obj][cell]` when set, else the
 * stored literal or structural default; the cover returns `cover[obj]`.
 */
function world(
  objects: TableObject[],
  values: Record<ObjectId, Record<string, Result>> = {},
  cover: Record<ObjectId, Partial<CoverResult>> = {},
) {
  const store = DocumentStore.fromSnapshot(
    snapshot([
      character("aldric", 0),
      character("bryn", 2),
      character("cara", 4),
      obj("statue", { board: "table", cells: { position: at(8, 8) } }),
      ...objects,
    ]),
  );
  const reader: VisibilityReader = {
    value(o, cell) {
      const v = values[o]?.[cell];
      if (v !== undefined) return v;
      const stored = store.getCell(o, cell);
      if (stored === undefined) return EMPTY;
      if (stored.content.type === "formula") throw new Error(`no value for ${o}.${cell}`);
      return stored.content as Result;
    },
  };
  const oracle: CoverOracle = {
    opaqueZonesCovering(o) {
      return { covering: cover[o]?.covering ?? [], undetermined: cover[o]?.undetermined ?? [] };
    },
  };
  return new Visibility(store, reader, oracle);
}

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const BRYN: Viewer = { type: "character", id: "bryn" };
const CARA: Viewer = { type: "character", id: "cara" };
const STATUE: Viewer = { type: "character", id: "statue" };

describe("drawing a card: container visibility", () => {
  const hand = obj("aldric_hand", {
    board: "table",
    contents: ["card_ace"],
    cells: {
      position: at(0, -4),
      owner: c(ref("aldric")),
      visible_to: c(viewers(ref("aldric"))),
    },
  });
  const ace = obj("card_ace", { cells: { name: c(text("Ace")), visible_to: c(ALL) } });

  test("a card `all` in Aldric's hand is visible to Aldric and not to Bryn", () => {
    const v = world([hand, ace]);
    expect(v.canSeeObject(ALDRIC, "card_ace")).toBe(true);
    expect(v.canSeeObject(BRYN, "card_ace")).toBe(false);
    expect(v.canSeeCell(BRYN, "card_ace", "name")).toBe(false);
    expect(v.canSeeObject(GM, "card_ace")).toBe(true);
  });

  test("visible to both once the card is on the board", () => {
    const v = world([
      { ...hand, contents: [] },
      { ...ace, board: "table", cells: { ...ace.cells, position: at(1, 1) } },
    ]);
    expect(v.canSeeObject(ALDRIC, "card_ace")).toBe(true);
    expect(v.canSeeObject(BRYN, "card_ace")).toBe(true);
  });

  test("`owner` in a container's visible_to resolves against the container's owner", () => {
    const v = world([
      { ...hand, cells: { ...hand.cells, visible_to: c(viewers("owner")) } },
      // The card's own owner is Bryn; it must not matter.
      { ...ace, cells: { ...ace.cells, owner: c(ref("bryn")) } },
    ]);
    expect(v.canSeeObject(ALDRIC, "card_ace")).toBe(true);
    expect(v.canSeeObject(BRYN, "card_ace")).toBe(false);
  });

  test("`owner` whose owner cell is not a ref to a character admits nobody", () => {
    const owned = (owner: Cell) =>
      world([
        obj("box", { board: "table", cells: { visible_to: c(viewers("owner")), owner } }),
      ]);
    expect(owned(c(EMPTY)).canSeeObject(ALDRIC, "box")).toBe(false);
    expect(owned(c(ref("statue"))).canSeeObject(ALDRIC, "box")).toBe(false);
    expect(owned(c(num(1))).canSeeObject(ALDRIC, "box")).toBe(false);
    expect(owned(c(ref("aldric"))).canSeeObject(ALDRIC, "box")).toBe(true);
  });
});

describe("goblin hit: per-cell visibility", () => {
  const goblin = obj("goblin", {
    board: "table",
    cells: {
      name: c(text("Goblin")),
      position: at(3, 3),
      visible_to: c(ALL),
      ac: c(num(13)),
      hit: c(bool(true)),
    },
    cell_visibility: { ac: GM_ONLY, contents: GM_ONLY, tag: GM_ONLY },
  });

  test("a GM-only `ac` is hidden from Aldric while `hit` is visible", () => {
    const v = world([goblin]);
    expect(v.canSeeObject(ALDRIC, "goblin")).toBe(true);
    expect(v.canSeeCell(ALDRIC, "goblin", "ac")).toBe(false);
    expect(v.canSeeCell(ALDRIC, "goblin", "hit")).toBe(true);
    expect(v.canSeeCell(GM, "goblin", "ac")).toBe(true);
  });

  test("cell_visibility on field-backed `contents` and `tag` hides them", () => {
    const v = world([goblin]);
    expect(v.canSeeCell(ALDRIC, "goblin", "contents")).toBe(false);
    expect(v.canSeeCell(ALDRIC, "goblin", "tag")).toBe(false);
    expect(v.canSeeCell(GM, "goblin", "contents")).toBe(true);
    expect(v.canSeeObject(ALDRIC, "goblin")).toBe(true);
  });

  test("a cell with no entry and no stored content adds no restriction", () => {
    expect(world([goblin]).canSeeCell(ALDRIC, "goblin", "nonesuch")).toBe(true);
  });
});

describe("face down", () => {
  const card = (cells: Record<string, Cell> = {}, cellVisibility = {}) =>
    obj("card", {
      board: "table",
      shape: { type: "rect", width: 2, height: 3 },
      cells: {
        name: c(text("Ace")),
        position: at(1, 1),
        rotation: c(num(0)),
        z: c(num(1)),
        visible_to: c(ALL),
        owner: c(ref("aldric")),
        face_up: c(bool(false)),
        rank: c(text("A")),
        ...cells,
      },
      cell_visibility: cellVisibility,
    });
  const expected = [
    "name",
    "board",
    "position",
    "rotation",
    "z",
    "container",
    "face_up",
    "shape",
  ] as const;

  test("FACE_DOWN_EXEMPT is exactly the placement, back, and name cells", () => {
    expect([...FACE_DOWN_EXEMPT].sort()).toEqual([...expected].sort());
  });

  test("Bryn sees exactly the exempt cells of Aldric's face-down card", () => {
    const v = world([card()]);
    expect(v.canSeeObject(BRYN, "card")).toBe(true);
    for (const cell of FACE_DOWN_EXEMPT) expect(v.canSeeCell(BRYN, "card", cell)).toBe(true);
    for (const cell of ["rank", "visible_to", "owner", "tag", "contents", "id", "nonesuch"])
      expect(v.canSeeCell(BRYN, "card", cell)).toBe(false);
    for (const cell of ["rank", "owner", "name"]) expect(v.canSeeCell(ALDRIC, "card", cell)).toBe(true);
    expect(v.canSeeCell(GM, "card", "rank")).toBe(true);
  });

  test("face up, Bryn sees every cell", () => {
    expect(world([card({ face_up: c(bool(true)) })]).canSeeCell(BRYN, "card", "rank")).toBe(true);
  });

  test("a GM-only cell on a face-down card shows to nobody but the GM", () => {
    const v = world([card({}, { rank: GM_ONLY, name: GM_ONLY })]);
    expect(v.canSeeCell(ALDRIC, "card", "rank")).toBe(false);
    expect(v.canSeeCell(BRYN, "card", "rank")).toBe(false);
    expect(v.canSeeCell(GM, "card", "rank")).toBe(true);
    // Per-cell entries still apply to exempt cells.
    expect(v.canSeeCell(BRYN, "card", "name")).toBe(false);
    expect(v.canSeeCell(ALDRIC, "card", "name")).toBe(false);
  });

  test("face_up evaluating to an error or a number behaves as face down", () => {
    for (const faceUp of [err("#REF"), num(1)]) {
      const v = world([card()], { card: { face_up: faceUp } });
      expect(v.canSeeCell(BRYN, "card", "rank")).toBe(false);
      expect(v.canSeeCell(BRYN, "card", "name")).toBe(true);
      expect(v.canSeeCell(ALDRIC, "card", "rank")).toBe(true);
      expect(v.canSeeCell(GM, "card", "rank")).toBe(true);
    }
  });

  test("a face-down card whose owner is not a ref shows its other cells to no character", () => {
    const v = world([card({ owner: c(EMPTY) })]);
    expect(v.canSeeCell(ALDRIC, "card", "rank")).toBe(false);
    expect(v.canSeeCell(ALDRIC, "card", "name")).toBe(true);
  });
});

describe("opaque cover", () => {
  const zone = (visibleTo: ViewersValue) =>
    obj("room", {
      board: "table",
      is_zone: true,
      shape: { type: "rect", width: 10, height: 10 },
      cells: { position: at(10, 10), z: c(num(0)), opaque: c(bool(true)), visible_to: c(visibleTo) },
    });
  const goblin = obj("goblin", {
    board: "table",
    cells: { position: at(12, 12), z: c(num(5)), visible_to: c(ALL), hp: c(num(7)) },
  });
  const chest = obj("chest", {
    board: "table",
    contents: ["coin"],
    cells: { position: at(14, 14), visible_to: c(ALL) },
  });
  const coin = obj("coin", { cells: { visible_to: c(ALL) } });
  const covered = { goblin: { covering: ["room"] }, chest: { covering: ["room"] } };

  test("an object `all` under a hidden opaque zone is not visible, nor its public cell", () => {
    const v = world([zone(GM_ONLY), goblin], {}, covered);
    expect(v.isCovered(ALDRIC, "goblin")).toBe(true);
    expect(v.canSeeObject(ALDRIC, "goblin")).toBe(false);
    expect(v.canSeeCell(ALDRIC, "goblin", "hp")).toBe(false);
    expect(v.canSeeObject(GM, "goblin")).toBe(true);
    expect(v.canSeeCell(GM, "goblin", "hp")).toBe(true);
  });

  test("a goblin with higher z than the zone is still covered", () => {
    const v = world([zone(GM_ONLY), goblin], {}, covered);
    expect(v.canSeeObject(BRYN, "goblin")).toBe(false);
  });

  test("visible once the zone is visible to all", () => {
    const v = world([zone(ALL), goblin], {}, covered);
    expect(v.isCovered(ALDRIC, "goblin")).toBe(false);
    expect(v.canSeeObject(ALDRIC, "goblin")).toBe(true);
    expect(v.canSeeCell(ALDRIC, "goblin", "hp")).toBe(true);
  });

  test("a zone visible to Aldric only covers for Bryn", () => {
    const v = world([zone(viewers(ref("aldric"))), goblin], {}, covered);
    expect(v.canSeeObject(ALDRIC, "goblin")).toBe(true);
    expect(v.canSeeObject(BRYN, "goblin")).toBe(false);
  });

  test("a card in a container under the zone is covered too", () => {
    const v = world([zone(GM_ONLY), chest, coin], {}, covered);
    expect(v.isEffectivelyVisible(ALDRIC, "coin")).toBe(true);
    expect(v.isCovered(ALDRIC, "coin")).toBe(true);
    expect(v.canSeeObject(ALDRIC, "coin")).toBe(false);
    const open = world([zone(ALL), chest, coin], {}, covered);
    expect(open.canSeeObject(ALDRIC, "coin")).toBe(true);
  });

  test("a hidden zone listed as undetermined covers", () => {
    // opaque evaluating to an error, or geometry unreadable: the cover stub reports it.
    const v = world([zone(GM_ONLY), goblin], { room: { opaque: err("#TYPE") } }, {
      goblin: { undetermined: ["room"] },
    });
    expect(v.canSeeObject(ALDRIC, "goblin")).toBe(false);
    expect(v.canSeeObject(GM, "goblin")).toBe(true);
    const shown = world([zone(ALL), goblin], {}, { goblin: { undetermined: ["room"] } });
    expect(shown.canSeeObject(ALDRIC, "goblin")).toBe(true);
  });

  test("a zone never covers itself", () => {
    const v = world([zone(viewers(ref("aldric")))], {}, { room: { covering: ["room"], undetermined: ["room"] } });
    expect(v.isCovered(BRYN, "room")).toBe(false);
    expect(v.canSeeObject(ALDRIC, "room")).toBe(true);
    expect(v.canSeeObject(BRYN, "room")).toBe(false);
  });
});

describe("visible_to values", () => {
  const thing = (cells: Record<string, Cell> = {}) =>
    obj("thing", { board: "table", cells: { position: at(1, 1), secret: c(num(3)), ...cells } });
  const withValue = (value: Result) => world([thing()], { thing: { visible_to: value } });

  test("absent visible_to is visible to every character", () => {
    const v = world([thing()]);
    for (const who of [ALDRIC, BRYN, CARA]) {
      expect(v.canSeeObject(who, "thing")).toBe(true);
      expect(v.canSeeCell(who, "thing", "secret")).toBe(true);
    }
  });

  test("a ref to Aldric (the `visible_to = owner` shape) admits Aldric only", () => {
    const v = withValue(ref("aldric"));
    expect(v.canSeeObject(ALDRIC, "thing")).toBe(true);
    expect(v.canSeeObject(BRYN, "thing")).toBe(false);
  });

  test("a list of refs to Aldric and Bryn admits both and not Cara", () => {
    const v = withValue(list([ref("aldric"), ref("bryn")]));
    expect(v.canSeeObject(ALDRIC, "thing")).toBe(true);
    expect(v.canSeeObject(BRYN, "thing")).toBe(true);
    expect(v.canSeeObject(CARA, "thing")).toBe(false);
  });

  test("a list mixing a ref and a viewers value admits their union", () => {
    const v = withValue(list([ref("aldric"), viewers(ref("cara"))]));
    expect(v.canSeeObject(ALDRIC, "thing")).toBe(true);
    expect(v.canSeeObject(BRYN, "thing")).toBe(false);
    expect(v.canSeeObject(CARA, "thing")).toBe(true);
  });

  test("a ref to a non-character admits nobody", () => {
    const v = withValue(ref("statue"));
    for (const who of [ALDRIC, BRYN, CARA]) expect(v.canSeeObject(who, "thing")).toBe(false);
    expect(v.canSeeObject(GM, "thing")).toBe(true);
  });

  test("`gm` admits only the GM", () => {
    const v = withValue(GM_ONLY);
    expect(v.canSeeObject(ALDRIC, "thing")).toBe(false);
    expect(v.canSeeObject(GM, "thing")).toBe(true);
  });

  test("empty, [], an error, and a number are hidden from every character but not the GM", () => {
    for (const value of [EMPTY, list([]), err("#REF"), num(3), text("all")]) {
      const v = withValue(value);
      for (const who of [ALDRIC, BRYN, CARA]) {
        expect(v.canSeeObject(who, "thing")).toBe(false);
        expect(v.canSeeCell(who, "thing", "secret")).toBe(false);
      }
      expect(v.canSeeObject(GM, "thing")).toBe(true);
      expect(v.canSeeCell(GM, "thing", "secret")).toBe(true);
    }
  });

  test("viewerSetAdmits converts with toViewers and resolves owner against the holder", () => {
    const v = world([thing({ owner: c(ref("bryn")) })]);
    expect(v.viewerSetAdmits(viewers("owner"), BRYN, "thing")).toBe(true);
    expect(v.viewerSetAdmits(viewers("owner"), ALDRIC, "thing")).toBe(false);
    expect(v.viewerSetAdmits(list([]), GM, "thing")).toBe(true);
    expect(v.viewerSetAdmits(list([]), ALDRIC, "thing")).toBe(false);
  });
});

describe("non-character viewers", () => {
  test("a viewer that is not a character sees nothing", () => {
    const v = world([obj("thing", { board: "table", cells: { position: at(1, 1), visible_to: c(ALL) } })]);
    expect(v.canSeeObject(STATUE, "thing")).toBe(false);
    expect(v.canSeeCell(STATUE, "thing", "name")).toBe(false);
    expect(v.isEffectivelyVisible(STATUE, "thing")).toBe(false);
    expect(v.viewerSetAdmits(ALL, STATUE, "thing")).toBe(false);
    expect(v.canSeeObject({ type: "character", id: "nobody" }, "thing")).toBe(false);
    expect(v.canSeeObject(ALDRIC, "thing")).toBe(true);
  });

  test("an unknown object is seen by no character", () => {
    const v = world([]);
    expect(v.canSeeObject(ALDRIC, "ghost")).toBe(false);
    expect(v.canSeeCell(ALDRIC, "ghost", "name")).toBe(false);
  });
});
