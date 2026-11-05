/**
 * `faceElementVisible` (vtt-1xv.12; PROTOCOL.md §7.2; FIXTURES.md §7
 * `face_element`; review r2 finding 11, review r3 finding 6): true exactly
 * when the viewer's live object view of the object has a face element in
 * that list with that stored index and `shown === true`. Every case is
 * asserted equal to that reading of the live view.
 */
import { faceElementVisible, Table, ViewBuilder, type Viewer, writeValue } from "@vtt/authority";
import { bool, type FaceLayout, num, text, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, c, placed, snapshot, zone } from "../engine/helpers";

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const gmOnly: ViewersValue = { type: "viewers", viewers: ["gm"] };

type List = "full" | "collapsed";

/**
 * 0: GM-only `ac`; 1: `show_when` false; 2: a button naming no action; 3:
 * `name`; 4: the Roll button, shown; 5: a `show_when` error. Collapsed: 0
 * `name`.
 */
const face: FaceLayout = {
  elements: [
    { type: "value", cell: "ac", rect: [-1, -1, 1, 0.4] },
    { type: "value", cell: "hp", rect: [0, -1, 1, 0.4], show_when: "hp > 100" },
    { type: "button", action: "Nope", rect: [-1, 0, 1, 0.4] },
    { type: "value", cell: "name", rect: [0, 0, 1, 0.4] },
    { type: "button", action: "Roll", rect: [-1, 0.5, 2, 0.4], show_when: "hp > 0" },
    { type: "value", cell: "hp", rect: [-1, 1, 2, 0.4], show_when: "hp / 0 > 1" },
  ],
  collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6] }],
};

const faced = (name: string) => ({
  cells: { name: c(text(name)), hp: c(num(7)), ac: c(num(13)) },
  cell_visibility: { ac: gmOnly },
  actions: [{ name: "Roll", when: "hp > 0", steps: ["roll(1d20) -> hp"] }],
  face: structuredClone(face),
});

/** Aldric; a visible goblin; a GM-only secret; a goblin under an opaque room hidden from Aldric. */
function world(): Table {
  return Table.fromSnapshot(
    snapshot([
      placed("aldric", 0, -50, { is_character: true, cells: { name: c(text("Aldric")) } }),
      placed("goblin", 0, 0, faced("Goblin")),
      placed("secret", 5, 0, {
        ...faced("Secret"),
        cells: { ...faced("Secret").cells, visible_to: c(gmOnly) },
      }),
      zone("room", 20, 20, 6, {
        cells: { position: at(20, 20), opaque: c(bool(true)), visible_to: c(gmOnly) },
      }),
      placed("lurker", 20, 20, faced("Lurker")),
    ]),
  );
}

/** "Present with `shown === true` in the viewer's live face view." */
function presentShown(t: Table, viewer: Viewer, id: string, list: List, index: number): boolean {
  const view = new ViewBuilder(t, viewer).objectView(id, "all");
  const elements = list === "full" ? view?.face?.elements : view?.face?.collapsed;
  return elements?.some((e) => e.index === index && e.shown === true) ?? false;
}

/** Asserts `faceElementVisible` equals the live-view reading, and returns it. */
function visible(t: Table, viewer: Viewer, id: string, index: number, list: List = "full") {
  const got = faceElementVisible(t, viewer, id, { list, index });
  expect(got).toBe(presentShown(t, viewer, id, list, index));
  return got;
}

const element = (t: Table, viewer: Viewer, id: string, index: number) =>
  new ViewBuilder(t, viewer).objectView(id, "all")?.face?.elements.find((e) => e.index === index);

describe("faceElementVisible for the GM", () => {
  test("an element whose show_when is false is retained with shown false, and not visible", () => {
    const t = world();
    expect(element(t, GM, "goblin", 1)).toMatchObject({
      show_when: "hp > 100",
      shown: false,
      reason: "show_when_false",
    });
    expect(visible(t, GM, "goblin", 1)).toBe(false);
  });

  test("a button naming no action is retained with reason no_action, and not visible", () => {
    const t = world();
    expect(element(t, GM, "goblin", 2)).toMatchObject({ shown: false, reason: "no_action" });
    expect(visible(t, GM, "goblin", 2)).toBe(false);
  });

  test("a show_when error is retained with its code, and not visible", () => {
    const t = world();
    expect(element(t, GM, "goblin", 5)).toMatchObject({
      shown: false,
      reason: "show_when_error",
      error: "#DIV0",
    });
    expect(visible(t, GM, "goblin", 5)).toBe(false);
  });

  test("shown elements are visible, the GM-only cell included; every object is the GM's", () => {
    const t = world();
    for (const index of [0, 3, 4]) expect(visible(t, GM, "goblin", index)).toBe(true);
    expect(visible(t, GM, "goblin", 0, "collapsed")).toBe(true);
    expect(visible(t, GM, "secret", 3)).toBe(true);
    expect(visible(t, GM, "lurker", 3)).toBe(true);
  });
});

describe("faceElementVisible for Aldric", () => {
  test("the elements hidden for the GM are omitted from his view, and not visible", () => {
    const t = world();
    for (const index of [1, 2, 5]) {
      expect(element(t, ALDRIC, "goblin", index)).toBeUndefined();
      expect(visible(t, ALDRIC, "goblin", index)).toBe(false);
    }
  });

  test("an element naming a cell he cannot read is omitted, and not visible", () => {
    const t = world();
    expect(element(t, ALDRIC, "goblin", 0)).toBeUndefined();
    expect(visible(t, ALDRIC, "goblin", 0)).toBe(false);
  });

  test("a visible element is present with shown true and its stored index", () => {
    const t = world();
    expect(element(t, ALDRIC, "goblin", 3)).toEqual({
      type: "value",
      cell: "name",
      rect: [0, 0, 1, 0.4],
      index: 3,
      shown: true,
    });
    expect(visible(t, ALDRIC, "goblin", 3)).toBe(true);
    expect(visible(t, ALDRIC, "goblin", 4)).toBe(true);
    expect(visible(t, ALDRIC, "goblin", 0, "collapsed")).toBe(true);
  });

  test("an invisible object and an object under a cover: no element is visible", () => {
    const t = world();
    for (const id of ["secret", "lurker"]) {
      expect(new ViewBuilder(t, ALDRIC).objectView(id, "all")).toBeNull();
      for (const index of [3, 4]) expect(visible(t, ALDRIC, id, index)).toBe(false);
    }
  });

  test("a nonexistent object, a missing index and a missing collapsed list are not visible", () => {
    const t = world();
    expect(visible(t, GM, "nobody", 0)).toBe(false);
    expect(visible(t, GM, "goblin", 6)).toBe(false);
    expect(visible(t, GM, "goblin", 1, "collapsed")).toBe(false);
    expect(visible(t, GM, "aldric", 0)).toBe(false);
  });

  test("it follows the object: when hp drops to 0 the Roll button hides", () => {
    const t = world();
    const r = t.store.transact({ type: "gm" }, { kind: "edit", label: "edit" }, (tx) =>
      writeValue(tx, "goblin", "hp", num(0)),
    );
    expect(r.ok).toBe(true);
    expect(visible(t, ALDRIC, "goblin", 4)).toBe(false);
    expect(visible(t, GM, "goblin", 4)).toBe(false);
  });
});
