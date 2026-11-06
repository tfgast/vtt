// @vitest-environment node
/**
 * Only when selected (vtt-nb8.35; DESIGN.md §4.6 Only when selected, M6-D12):
 * a contents element with `when_selected: true` is in the face scene (drawn,
 * hit and offered as a drop target) only while its object, or an object
 * contained in it at any depth, is selected, or while an Alt-held drag
 * hovers the object; otherwise the object shows a count badge of its
 * readable contents in the element's place. Authored test faces only.
 */
import type { FaceElementView, FaceView, ObjectView, WireResult, WireValue } from "@vtt/protocol";
import type { ObjectId, Point, Rect, Shape } from "@vtt/schema";
import {
  altHoverAt,
  attachFaces,
  buildFaceScene,
  buildScene,
  type Camera,
  COUNT_BADGE_SIZE,
  type ContentsPrimitive,
  createFaceStateStore,
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
const circle = (radius: number): Shape => ({ type: "circle", radius });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

interface Spec {
  shape?: Shape;
  face?: FaceView;
  /** Null: a redacted entry. */
  contents?: (string | null)[];
  at?: Point;
  container?: string;
  faceUp?: boolean;
  zone?: boolean;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {};
  cells.name = { value: text(id), kind: "literal" };
  cells.face_up = { value: bool(s.faceUp ?? true), kind: "literal" };
  if (s.zone) cells.is_zone = { value: bool(true), kind: "structural" };
  if (s.shape) cells.shape = { value: { type: "shape", shape: s.shape }, kind: "literal" };
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
  const view: ObjectView = {
    id,
    is_template: false,
    is_character: false,
    cells,
    actions: [],
    action_states: [],
  };
  if (s.face) view.face = s.face;
  return view;
}

const value = (cell: string, r: Rect, index: number) =>
  ({ type: "value", cell, rect: r, index, shown: true }) as FaceElementView;
const list = (r: Rect, index: number, extra: Record<string, unknown> = {}) =>
  ({ type: "contents", rect: r, index, shown: true, ...extra }) as FaceElementView;

/** The token list's rect: below a radius-0.9 token, as the stocked token face places it. */
const LIST: Rect = [-1.5, 0.9, 3, 1.2];

/** A token at `at` whose face is a name and a when-selected contents list. */
const token = (id: string, at: Point, contents: (string | null)[], s: Spec = {}) =>
  mk(id, {
    shape: circle(0.9),
    at,
    contents,
    face: {
      elements: [
        value("name", [-0.9, -0.3, 1.8, 0.6], 0),
        list(LIST, 1, { when_selected: true, min_size: 24 }),
      ],
    },
    ...s,
  });

const gem = (id: string, container: string, s: Spec = {}) =>
  mk(id, { shape: rect(1, 1), container, ...s });

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

const drawingOf = (s: FaceScene, id: string): FaceDrawing => {
  const d = s.faces.get(id);
  if (d === undefined) throw new Error(`no face for ${id}`);
  return d;
};
const contentsOf = (d: FaceDrawing | undefined) =>
  (d?.primitives ?? []).filter((p): p is ContentsPrimitive => p.kind === "contents");
/** The count badge: a text primitive standing in for element `index`. */
const badgeOf = (d: FaceDrawing | undefined, index = 1) =>
  (d?.primitives ?? []).find(
    (p: FacePrimitive): p is TextPrimitive => p.kind === "text" && p.element === index,
  );

// Three entries, one of them redacted: two readable.
const goblin = token("goblin", [0, 0], ["sword", null, "pouch"]);
const sword = gem("sword", "goblin");
const pouch = mk("pouch", {
  shape: rect(1, 1),
  container: "goblin",
  contents: ["coin"],
  face: { elements: [list([-0.5, -0.5, 1, 1], 0)] },
});
const coin = gem("coin", "pouch");
const VIEWS = [goblin, sword, pouch, coin];

describe("a when_selected contents element", () => {
  test("unselected: no contents element, a badge with the readable count at the element's lower right, no min_size", () => {
    const d = drawingOf(scene(VIEWS), "goblin");
    expect(contentsOf(d)).toEqual([]);
    const badge = badgeOf(d);
    expect(badge).toBeDefined();
    const b = badge as TextPrimitive;
    expect(b.text).toBe("2");
    expect(b.minSize).toBe(0);
    expect(b.target).toEqual({ type: "body" });
    const [x, y, w, h] = b.rect;
    expect(h).toBe(COUNT_BADGE_SIZE);
    expect(x + w).toBeCloseTo(LIST[0] + LIST[2]);
    expect(y + h).toBeCloseTo(LIST[1] + LIST[3]);
    expect(x).toBeGreaterThanOrEqual(LIST[0]);
    expect(y).toBeGreaterThanOrEqual(LIST[1]);
  });

  test("selected: the list, and no badge", () => {
    const d = drawingOf(scene(VIEWS, ["goblin"]), "goblin");
    const [c] = contentsOf(d);
    expect(c?.element).toBe(1);
    expect(c?.rect).toEqual(LIST);
    expect(c?.minSize).toBe(24);
    expect(c?.entries.map((e) => e.id)).toEqual(["sword", null, "pouch"]);
    expect(badgeOf(d)).toBeUndefined();
  });

  test("a selected descendant at any depth keeps the parent's list", () => {
    for (const selected of ["sword", "pouch", "coin"]) {
      const d = drawingOf(scene(VIEWS, [selected]), "goblin");
      expect(contentsOf(d), selected).toHaveLength(1);
      expect(badgeOf(d), selected).toBeUndefined();
    }
    // Another object's selection does not.
    const other = token("orc", [10, 0], []);
    const d = drawingOf(scene([...VIEWS, other], ["orc"]), "goblin");
    expect(contentsOf(d)).toEqual([]);
  });

  test("an Alt-held drag hovering the object reveals its list", () => {
    const d = drawingOf(scene(VIEWS, [], "goblin"), "goblin");
    expect(contentsOf(d)).toHaveLength(1);
    expect(badgeOf(d)).toBeUndefined();
  });

  test("an element whose show_when is false: neither list nor badge, selected or not", () => {
    const hidden = token("goblin", [0, 0], ["sword"], {
      face: {
        elements: [
          value("name", [-0.9, -0.3, 1.8, 0.6], 0),
          list(LIST, 1, { when_selected: true, shown: false, reason: "show_when_false" }),
        ],
      },
    });
    for (const selection of [[], ["goblin"]]) {
      const d = drawingOf(scene([hidden, sword], selection), "goblin");
      expect(contentsOf(d)).toEqual([]);
      expect(badgeOf(d)).toBeUndefined();
    }
  });

  test("a face-down object: neither list nor badge", () => {
    const down = token("goblin", [0, 0], ["sword"], { faceUp: false });
    for (const selection of [[], ["goblin"]]) {
      const s = scene([down, sword], selection);
      const d = s.faces.get("goblin");
      expect(contentsOf(d)).toEqual([]);
      expect(badgeOf(d)).toBeUndefined();
    }
  });

  test("no readable contents: no badge (empty, all redacted, or an unreadable contents cell)", () => {
    const empty = token("a", [0, 0], []);
    const redacted = token("b", [10, 0], [null, null]);
    const unreadable = token("c", [20, 0], []);
    delete unreadable.cells.contents;
    const s = scene([empty, redacted, unreadable]);
    for (const id of ["a", "b", "c"]) {
      expect(contentsOf(s.faces.get(id)), id).toEqual([]);
      expect(badgeOf(s.faces.get(id)), id).toBeUndefined();
    }
  });

  test("a face without the field is unchanged: its list is drawn unselected", () => {
    const plain = token("goblin", [0, 0], ["sword"], {
      face: { elements: [list(LIST, 0)] },
    });
    const d = drawingOf(scene([plain, sword]), "goblin");
    expect(contentsOf(d)).toHaveLength(1);
    expect(badgeOf(d, 0)).toBeUndefined();
    const off = token("goblin", [0, 0], ["sword"], {
      face: { elements: [list(LIST, 0, { when_selected: false })] },
    });
    expect(contentsOf(drawingOf(scene([off, sword]), "goblin"))).toHaveLength(1);
  });

  test("a nested object's when_selected list follows its own selection", () => {
    // The goblin's own list is a plain one here; the pouch inside is expanded with a when_selected list.
    const bag = token("goblin", [0, 0], ["pouch"], { face: { elements: [list(LIST, 0)] } });
    const nested = mk("pouch", {
      shape: rect(1, 1),
      container: "goblin",
      contents: ["coin"],
      face: { elements: [list([-0.5, -0.5, 1, 1], 0, { when_selected: true })] },
    });
    const faceState = createFaceStateStore();
    faceState.expand("pouch");
    const build = (selection: ObjectId[]) =>
      buildFaceScene(
        { views: [bag, nested, coin], covers: [], board: BOARD, viewer: { type: "gm" }, selection },
        { faceState },
      );
    const pouchDrawing = (s: FaceScene) =>
      contentsOf(s.faces.get("goblin"))[0]?.entries[0]?.drawing;
    expect(contentsOf(pouchDrawing(build([])) ?? undefined)).toEqual([]);
    expect(badgeOf(pouchDrawing(build([])) ?? undefined, 0)?.text).toBe("1");
    expect(contentsOf(pouchDrawing(build(["coin"])) ?? undefined)).toHaveLength(1);
  });

  test("presentation bounds cover the badge, not the hidden list", () => {
    const s = scene(VIEWS);
    const p = s.presentation.get("goblin");
    expect(p?.maxY).toBeCloseTo(LIST[1] + LIST[3]);
    expect(p?.minX).toBeCloseTo(-0.9);
  });
});

describe("hit testing and drops", () => {
  // A point in the list's rect below its rows, left of the badge and below the token's footprint.
  const IN_LIST: Point = [-1.2, 1.95];

  test("unselected: the hidden list is never hit and a drop there is the board", () => {
    const s = scene(VIEWS);
    expect(faceHitAt(s, IN_LIST, CAMERA)).toBeNull();
    expect(dropTargetAt(s, IN_LIST, CAMERA, ["die"])).toEqual({ kind: "board" });
  });

  test("selected: the list is hit and takes the drop", () => {
    const s = scene(VIEWS, ["goblin"]);
    expect(faceHitAt(s, IN_LIST, CAMERA)?.object).toBe("goblin");
    expect(dropTargetAt(s, IN_LIST, CAMERA, ["die"])).toMatchObject({
      kind: "contents",
      container: "goblin",
      element: 1,
    });
  });

  test("attachFaces without a selection option reads the scene's selection outlines", () => {
    const views = new Map(VIEWS.map((v) => [v.id, v]));
    const lookup = (id: string) => views.get(id) ?? null;
    const base = (selection: ObjectId[]) =>
      buildScene({ views: VIEWS, covers: [], board: BOARD, viewer: { type: "gm" }, selection });
    const faceState = createFaceStateStore();
    const off = attachFaces(base([]), lookup, faceState, { gm: true });
    expect(contentsOf(off.faces.get("goblin"))).toEqual([]);
    const on = attachFaces(base(["goblin"]), lookup, faceState, { gm: true });
    expect(contentsOf(on.faces.get("goblin"))).toHaveLength(1);
    // An explicit selection wins, and reaches descendants.
    const explicit = attachFaces(base([]), lookup, faceState, { gm: true, selection: ["coin"] });
    expect(contentsOf(explicit.faces.get("goblin"))).toHaveLength(1);
  });
});

describe("altHoverAt: the Alt-hover region", () => {
  const die = mk("die", { shape: rect(1, 1), at: [5, 0] });
  const views = [...VIEWS, die];
  const byId = new Map(views.map((v) => [v.id, v]));
  const lookup = (id: string) => byId.get(id) ?? null;
  const base = buildScene({ views, covers: [], board: BOARD, viewer: { type: "gm" } });
  const at = (point: Point, previous: ObjectId | null, alt = true) =>
    altHoverAt({
      scene: base,
      views: lookup,
      previous,
      point,
      camera: CAMERA,
      alt,
      dragged: ["die"],
    });

  test("starts when the pointer enters the footprint with Alt held", () => {
    expect(at([0, 0], null)).toBe("goblin");
    expect(at([0, 0], null, false)).toBeNull();
  });

  test("the revealed list's rect alone does not start it", () => {
    expect(at([-1.2, 1.8], null)).toBeNull();
  });

  test("continues over the revealed list's rect, so the drag can reach the list", () => {
    expect(at([-1.2, 1.8], "goblin")).toBe("goblin");
    expect(at([0, 0.5], "goblin")).toBe("goblin");
  });

  test("ends when the pointer leaves both rects or Alt is released", () => {
    expect(at([3, 3], "goblin")).toBeNull();
    expect(at([-1.2, 1.8], "goblin", false)).toBeNull();
  });

  test("objects without a when_selected list, zones and the dragged objects never start it", () => {
    const zone = mk("room", { shape: rect(4, 4), at: [20, 0], zone: true });
    const plain = mk("crate", { shape: rect(1, 1), at: [30, 0] });
    const all = [...views, zone, plain];
    const m = new Map(all.map((v) => [v.id, v]));
    const s = buildScene({ views: all, covers: [], board: BOARD, viewer: { type: "gm" } });
    const hover = (point: Point, dragged: ObjectId[]) =>
      altHoverAt({
        scene: s,
        views: (id) => m.get(id) ?? null,
        previous: null,
        point,
        camera: CAMERA,
        alt: true,
        dragged,
      });
    expect(hover([20, 0], ["die"])).toBeNull();
    expect(hover([30, 0], ["die"])).toBeNull();
    expect(hover([0, 0], ["goblin"])).toBeNull();
  });
});
