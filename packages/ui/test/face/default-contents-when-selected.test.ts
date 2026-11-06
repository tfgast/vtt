// @vitest-environment node
/**
 * Only when selected for objects without a face (vtt-nb8.36; DESIGN.md §4.6
 * Default face and Only when selected, M6-D12 amending M5-D10): the default
 * face's contents list below a faceless object is in the face scene only
 * while the object, or something in it, is selected, or while an Alt-held
 * drag hovers it; otherwise a count badge of its readable contents stands at
 * the lower right of the list's first row. Empty, all-redacted contents and a
 * face-down object show neither.
 */
import type { ObjectView, WireResult, WireValue } from "@vtt/protocol";
import type { ObjectId, Point, Rect } from "@vtt/schema";
import {
  altHoverAt,
  buildFaceScene,
  buildScene,
  type Camera,
  type ContentsPrimitive,
  createFaceStateStore,
  DEFAULT_CONTENTS_ELEMENT,
  defaultContentsRect,
  dropTargetAt,
  type FaceDrawing,
  type FacePrimitive,
  type FaceScene,
  faceHitAt,
  type TextPrimitive,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };

interface Spec {
  /** Null: a redacted entry. */
  contents?: (string | null)[];
  at?: Point;
  container?: string;
  faceUp?: boolean;
}

/** A faceless 2 × 2 rect object. */
function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {
    name: { value: text(id), kind: "literal" },
    face_up: { value: bool(s.faceUp ?? true), kind: "literal" },
    shape: {
      value: { type: "shape", shape: { type: "rect", width: 2, height: 2 } },
      kind: "literal",
    },
  };
  if (s.contents) {
    cells.contents = {
      value: {
        type: "list",
        items: s.contents.map((c) => (c === null ? { type: "redacted" } : ref(c))),
      },
      kind: "structural",
    };
  }
  if (s.at) {
    cells.board = { value: ref(BOARD), kind: "literal" };
    cells.position = {
      value: { type: "list", items: [num(s.at[0]), num(s.at[1])] },
      kind: "literal",
    };
    cells.container = { value: EMPTY, kind: "structural" };
  }
  if (s.container) cells.container = { value: ref(s.container), kind: "structural" };
  return { id, is_template: false, is_character: false, cells, actions: [], action_states: [] };
}

const crate = mk("crate", { at: [0, 0], contents: ["gem1", "gem2"] });
const VIEWS = [crate, mk("gem1", { container: "crate" }), mk("gem2", { container: "crate" })];
/** Two rows of a 6-wide list below the 2 × 2 frame: [-3, 1.15, 6, 1.2]. */
const LIST = defaultContentsRect(crate) as Rect;
const IN_LIST: Point = [-2.5, 1.5];

function scene(
  views: ObjectView[],
  selection: ObjectId[] = [],
  altHover: ObjectId | null = null,
): FaceScene {
  return buildFaceScene(
    { views, covers: [], board: BOARD, viewer: { type: "gm" }, selection },
    { faceState: createFaceStateStore(), altHover },
  );
}

const drawing = (s: FaceScene, id = "crate"): FaceDrawing | undefined => s.faces.get(id);
const listOf = (d: FaceDrawing | undefined) =>
  (d?.primitives ?? []).filter((p): p is ContentsPrimitive => p.kind === "contents");
const badgeOf = (d: FaceDrawing | undefined) =>
  (d?.primitives ?? []).find(
    (p: FacePrimitive): p is TextPrimitive =>
      p.kind === "text" && p.element === DEFAULT_CONTENTS_ELEMENT,
  );

describe("a faceless object's default contents list", () => {
  test("the list's place: below the frame, 6 wide, one row per entry", () => {
    expect(LIST[0]).toBeCloseTo(-3);
    expect(LIST[1]).toBeCloseTo(1.15);
    expect(LIST[2]).toBeCloseTo(6);
    expect(LIST[3]).toBeCloseTo(1.2);
  });

  test("unselected: no list, a badge with the readable count at the lower right of the list's first row, at any zoom", () => {
    const d = drawing(scene(VIEWS));
    expect(listOf(d)).toEqual([]);
    const badge = badgeOf(d);
    expect(badge).toMatchObject({ text: "2", minSize: 0, target: { type: "body" } });
    const r = (badge as TextPrimitive).rect;
    expect(r[0] + r[2]).toBeCloseTo(LIST[0] + LIST[2]);
    // The first row is 0.6 high (a 6-wide list's row), not the whole 1.2-high list.
    expect(r[1] + r[3]).toBeCloseTo(LIST[1] + 0.6);
  });

  test("selected, or something inside it selected: the list, and no badge", () => {
    for (const sel of [["crate"], ["gem1"]]) {
      const d = drawing(scene(VIEWS, sel));
      expect(listOf(d), sel.join()).toHaveLength(1);
      expect(listOf(d)[0]?.element).toBe(DEFAULT_CONTENTS_ELEMENT);
      expect(badgeOf(d), sel.join()).toBeUndefined();
    }
  });

  test("an Alt-held drag hovering it: the list", () => {
    const d = drawing(scene(VIEWS, [], "crate"));
    expect(listOf(d)).toHaveLength(1);
    expect(badgeOf(d)).toBeUndefined();
  });

  test("empty, all-redacted or face down: neither list nor badge", () => {
    const gem1 = mk("gem1", { container: "crate" });
    const none = (v: ObjectView, sel: ObjectId[]) => {
      const d = drawing(scene([v, gem1], sel));
      return listOf(d).length === 0 && badgeOf(d) === undefined;
    };
    // Nothing to list: no badge unselected, no list selected.
    for (const v of [mk("crate", { at: [0, 0], contents: [] }), mk("crate", { at: [0, 0] })]) {
      expect(none(v, [])).toBe(true);
      expect(none(v, ["crate"])).toBe(true);
    }
    // Only redacted entries: nothing readable to count.
    expect(none(mk("crate", { at: [0, 0], contents: [null, null] }), [])).toBe(true);
    // Face down: no face content, selected or not.
    const down = mk("crate", { at: [0, 0], contents: ["gem1"], faceUp: false });
    expect(none(down, [])).toBe(true);
    expect(none(down, ["crate"])).toBe(true);
  });

  test("unselected, a point in the list's place is not hit and drops on the board; selected, it takes the drop", () => {
    const hidden = scene(VIEWS);
    expect(faceHitAt(hidden, IN_LIST, CAMERA)).toBeNull();
    expect(dropTargetAt(hidden, IN_LIST, CAMERA, [])).toEqual({ kind: "board" });
    const shown = scene(VIEWS, ["crate"]);
    expect(dropTargetAt(shown, IN_LIST, CAMERA, [])).toMatchObject({
      kind: "contents",
      container: "crate",
    });
  });

  test("altHoverAt starts on the object's footprint and continues over its list's place", () => {
    const empty = mk("box", { at: [10, 0] });
    const views = [...VIEWS, empty];
    const byId = new Map(views.map((v) => [v.id, v]));
    const base = buildScene({ views, covers: [], board: BOARD, viewer: { type: "gm" } });
    const at = (point: Point, previous: ObjectId | null) =>
      altHoverAt({
        scene: base,
        views: (id) => byId.get(id) ?? null,
        previous,
        point,
        camera: CAMERA,
        alt: true,
        dragged: [],
      });
    expect(at([0, 0], null)).toBe("crate");
    expect(at(IN_LIST, null)).toBeNull();
    expect(at(IN_LIST, "crate")).toBe("crate");
    // A faceless object without contents has no list to reveal.
    expect(at([10, 0], null)).toBeNull();
  });
});
