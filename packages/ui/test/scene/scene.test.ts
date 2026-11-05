// @vitest-environment node
import type { CellView, Cover, ObjectView, Viewer, WireResult, WireValue } from "@vtt/protocol";
import type { Shape } from "@vtt/schema";
import {
  buildScene,
  type DrawItem,
  labelVisible,
  NEUTRAL_FILL,
  type Scene,
  type SceneInput,
  type ScenePreviews,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// View builders

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };

const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const ERROR: WireResult = { type: "error", code: "#TYPE" };
const viewers = (...v: ("all" | "gm")[]): WireResult => ({ type: "viewers", viewers: v });
const pos = (x: number, y: number): WireValue => ({ type: "list", items: [num(x), num(y)] });

interface Spec {
  at?: [number, number];
  position?: WireResult;
  z?: WireResult | number;
  rotation?: WireResult | number;
  shape?: Shape | null;
  zone?: boolean;
  board?: string;
  container?: string;
  cells?: Record<string, WireResult>;
}

function obj(id: string, spec: Spec = {}): ObjectView {
  const contained = spec.container !== undefined;
  const asResult = (v: WireResult | number | undefined): WireResult =>
    v === undefined ? num(0) : typeof v === "number" ? num(v) : v;
  const values: Record<string, WireResult> = {
    board: contained ? EMPTY : ref(spec.board ?? BOARD),
    container: contained ? ref(spec.container as string) : EMPTY,
    position: contained ? EMPTY : (spec.position ?? pos(...(spec.at ?? [0, 0]))),
    rotation: contained ? EMPTY : asResult(spec.rotation),
    z: contained ? EMPTY : asResult(spec.z),
    shape: spec.shape ? { type: "shape", shape: spec.shape } : EMPTY,
    is_zone: bool(spec.zone ?? false),
    face_up: bool(true),
    opaque: bool(false),
    visible_to: viewers("all"),
    ...spec.cells,
  };
  const cells: Record<string, CellView> = {};
  for (const [name, value] of Object.entries(values)) cells[name] = { value, kind: "literal" };
  return { id, is_template: false, is_character: false, cells, actions: [] };
}

const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });

function scene(views: ObjectView[], input: Partial<SceneInput> = {}): Scene {
  return buildScene({ views, covers: [], board: BOARD, viewer: GM, ...input });
}

function item(s: Scene, id: string): DrawItem {
  const found = s.items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

const ids = (s: Scene) => s.items.map((i) => i.id);

// ---------------------------------------------------------------------------

describe("buildScene: placement and order", () => {
  test("orders by ascending z, then id by code point", () => {
    const s = scene([
      obj("a", { z: 2 }),
      obj("c", { z: 1 }),
      obj("b", { z: 1 }),
      obj("B", { z: 1 }),
      obj("d", { z: -1 }),
    ]);
    expect(ids(s)).toEqual(["d", "B", "b", "c", "a"]);
  });

  test("skips objects not drawn on this board, and an error or malformed position", () => {
    const s = scene([
      obj("token", { at: [1, 2] }),
      obj("die", { container: "token" }),
      obj("broken", { position: ERROR }),
      obj("short", { position: { type: "list", items: [num(1)] } }),
      obj("infinite", { position: { type: "list", items: [num(1), num(Infinity)] } }),
      obj("texty", { position: { type: "list", items: [num(1), text("2")] } }),
      obj("elsewhere", { board: "gm_board" }),
    ]);
    expect(ids(s)).toEqual(["token"]);
    expect(s.skipped).toEqual(["broken", "die", "elsewhere", "infinite", "short", "texty"]);
  });

  test("an object with both a board and a container is not drawn", () => {
    const v = obj("odd", { at: [0, 0] });
    (v.cells.container as CellView).value = ref("bag");
    expect(scene([v]).skipped).toEqual(["odd"]);
  });

  test("rotation and z that are not numbers read as 0; a roll reads as its total", () => {
    const s = scene([
      obj("r_text", { rotation: text("north"), z: ERROR }),
      obj("r_roll", {
        rotation: { type: "roll", expr: "1d4", dice: [3], dropped: [], total: 3 },
        z: { type: "roll", expr: "1d6", dice: [5], dropped: [], total: 5 },
      }),
      obj("r_empty", { rotation: EMPTY, z: EMPTY }),
      obj("r_nan", { rotation: num(Number.NaN), z: num(1) }),
    ]);
    expect(item(s, "r_text")).toMatchObject({ rotation: 0, z: 0 });
    expect(item(s, "r_empty")).toMatchObject({ rotation: 0, z: 0 });
    expect(item(s, "r_nan")).toMatchObject({ rotation: 0, z: 1 });
    expect(item(s, "r_roll")).toMatchObject({ rotation: 3, z: 5 });
    expect(ids(s)).toEqual(["r_empty", "r_text", "r_nan", "r_roll"]);
  });

  test("geometry: anchor, rotation, shape and rotated bounds", () => {
    const s = scene([obj("card", { at: [10, 5], rotation: 90, shape: rect(4, 2) })]);
    expect(item(s, "card")).toMatchObject({
      anchor: [10, 5],
      rotation: 90,
      shape: rect(4, 2),
      bounds: { minX: 9, minY: 3, maxX: 11, maxY: 7 },
      isZone: false,
    });
  });

  test("a shapeless object has no shape and point bounds", () => {
    const s = scene([obj("pin", { at: [3, 4] })]);
    expect(item(s, "pin")).toMatchObject({
      shape: null,
      bounds: { minX: 3, minY: 4, maxX: 3, maxY: 4 },
    });
  });

  test("previews override position, rotation and shape", () => {
    const previews: ScenePreviews = new Map([
      ["token", { position: [7, 8] as [number, number] }],
      ["card", { rotation: 90, shape: rect(2, 6) }],
      ["broken", { position: [1, 1] as [number, number] }],
    ]);
    const s = scene(
      [
        obj("token", { at: [1, 1], shape: circle(0.5) }),
        obj("card", { at: [0, 0], shape: rect(4, 2) }),
        obj("broken", { position: ERROR }),
        obj("plain", { at: [2, 2] }),
      ],
      { previews },
    );
    expect(item(s, "token")).toMatchObject({
      anchor: [7, 8],
      bounds: { minX: 6.5, minY: 7.5, maxX: 7.5, maxY: 8.5 },
    });
    expect(item(s, "card")).toMatchObject({
      anchor: [0, 0],
      rotation: 90,
      shape: rect(2, 6),
      bounds: { minX: -3, minY: -1, maxX: 3, maxY: 1 },
    });
    expect(item(s, "broken").anchor).toEqual([1, 1]);
    expect(item(s, "plain").anchor).toEqual([2, 2]);
    expect(s.skipped).toEqual([]);
  });
});

describe("buildScene: appearance", () => {
  test("reads image, color, hatch, text and the name label", () => {
    const s = scene([
      obj("map", {
        shape: rect(6, 6),
        cells: { image: text("t.assets/map-1234abcd.png"), name: text("Dungeon") },
      }),
      obj("note", { shape: rect(2, 2), cells: { color: text("#fff3a0"), text: num(1 / 3) } }),
      obj("room", { shape: rect(4, 4), zone: true, cells: { pattern: text("hatch") } }),
    ]);
    expect(item(s, "map")).toMatchObject({
      image: "t.assets/map-1234abcd.png",
      label: "Dungeon",
      fill: NEUTRAL_FILL,
    });
    expect(item(s, "note")).toMatchObject({ fill: "#fff3a0", text: "0.3333" });
    expect(item(s, "room")).toMatchObject({ pattern: "hatch", fill: null, isZone: true });
    expect(item(s, "note").image).toBeUndefined();
    expect(item(s, "note").label).toBeUndefined();
    expect(item(s, "map").text).toBeUndefined();
    expect(item(s, "map").pattern).toBeUndefined();
  });

  test("a numeric color is ignored: neutral fill for a non-zone, none for a zone", () => {
    const s = scene([
      obj("token", { shape: circle(0.5), cells: { color: num(5) } }),
      obj("room", { shape: rect(4, 4), zone: true, cells: { color: num(5) } }),
      obj("lake", { shape: rect(4, 4), zone: true, cells: { color: text("blue") } }),
    ]);
    expect(item(s, "token").fill).toBe(NEUTRAL_FILL);
    expect(item(s, "room").fill).toBeNull();
    expect(item(s, "lake").fill).toBe("blue");
  });

  test("text is compact; a ref shows the referenced object's name by default", () => {
    const s = scene([
      obj("a", { cells: { text: text(`first line\nsecond`) } }),
      obj("b", { cells: { text: ref("a"), name: text("") } }),
      obj("c", { cells: { text: ref("a") } }),
    ]);
    expect(item(s, "a").text).toBe("first line…");
    expect(item(s, "b").text).toBe("a");
    const named = scene([
      obj("a", { cells: { name: text("Alpha") } }),
      obj("c", { cells: { text: ref("a") } }),
    ]);
    expect(item(named, "c").text).toBe("Alpha");
  });

  test("formatText, when given, formats text", () => {
    const s = scene([obj("a", { cells: { text: num(2) } })], {
      formatText: (v) => `<${v.type}>`,
    });
    expect(item(s, "a").text).toBe("<number>");
  });

  test("items are opaque by default", () => {
    const s = scene([obj("a")]);
    expect(item(s, "a")).toMatchObject({
      alpha: 1,
      faceDown: false,
      faceDownGlyph: false,
      opaqueGm: false,
      hiddenBadge: false,
      outline: true,
    });
  });
});

describe("buildScene: GM and character scenes", () => {
  const views = [
    obj("room1", {
      shape: rect(4, 4),
      zone: true,
      cells: { opaque: bool(true), visible_to: viewers("gm") },
    }),
    obj("room_err", { shape: rect(4, 4), zone: true, cells: { opaque: ERROR } }),
    obj("lake", { shape: rect(4, 4), zone: true }),
    obj("secret", { shape: circle(0.5), cells: { visible_to: viewers("gm") } }),
    obj("mixed", { shape: circle(0.5), cells: { visible_to: viewers("all", "gm") } }),
    obj("vis_err", { shape: circle(0.5), cells: { visible_to: ERROR } }),
    obj("public", { shape: circle(0.5) }),
  ];
  const absent = obj("absent", { shape: circle(0.5) });
  delete absent.cells.visible_to;

  test("GM: an opaque zone is opaqueGm; a non-`all` object gets the hidden badge", () => {
    const s = scene([...views, absent], { viewer: GM });
    expect(item(s, "room1")).toMatchObject({ opaqueGm: true, outline: true, fill: null });
    expect(item(s, "room_err").opaqueGm).toBe(true);
    expect(item(s, "lake").opaqueGm).toBe(false);
    expect(item(s, "secret").hiddenBadge).toBe(true);
    expect(item(s, "mixed").hiddenBadge).toBe(true);
    expect(item(s, "vis_err").hiddenBadge).toBe(true);
    expect(item(s, "public").hiddenBadge).toBe(false);
    expect(item(s, "absent").hiddenBadge).toBe(false);
    expect(item(s, "room1").hiddenBadge).toBe(true);
  });

  test("character: a visible opaque zone draws only its color and pattern; no badges", () => {
    const revealed = obj("room2", {
      shape: rect(4, 4),
      zone: true,
      cells: { opaque: bool(true), color: text("#336") },
    });
    const s = scene([revealed, ...views], { viewer: ALDRIC });
    expect(item(s, "room2")).toMatchObject({
      opaqueGm: false,
      outline: false,
      fill: "#336",
      hiddenBadge: false,
    });
    expect(item(s, "room_err")).toMatchObject({ opaqueGm: false, outline: false });
    expect(item(s, "lake")).toMatchObject({ outline: true, fill: null });
    for (const i of s.items) expect(i.hiddenBadge).toBe(false);
  });

  test("character: a whole_board cover and a region cover make two cover items", () => {
    const covers: Cover[] = [
      { key: "k1", board: BOARD, region: { whole_board: true } },
      { key: "k2", board: BOARD, region: { position: [5, 5], rotation: 90, shape: rect(4, 2) } },
      { key: "k3", board: "other", region: { whole_board: true } },
    ];
    const s = scene([], { viewer: ALDRIC, covers });
    expect(s.covers).toEqual([
      { key: "k1", wholeBoard: true },
      {
        key: "k2",
        wholeBoard: false,
        anchor: [5, 5],
        rotation: 90,
        shape: rect(4, 2),
        bounds: { minX: 4, minY: 3, maxX: 6, maxY: 7 },
      },
    ]);
  });
});

describe("buildScene: face-down", () => {
  const card = (faceUp: WireResult) =>
    obj("card", {
      shape: rect(2.5, 3.5),
      cells: {
        face_up: faceUp,
        name: text("Fireball"),
        image: text("t.assets/fireball-00000000.png"),
        color: text("red"),
        pattern: text("hatch"),
        text: text("8d6"),
      },
    });

  test.each<[string, Viewer, WireResult, boolean]>([
    ["character, face_up false", ALDRIC, bool(false), true],
    ["character, face_up error", ALDRIC, ERROR, true],
    ["character, face_up not a boolean", ALDRIC, num(1), true],
    ["character, face_up true", ALDRIC, bool(true), false],
    ["GM, face_up false", GM, bool(false), true],
    ["GM, face_up error", GM, ERROR, false],
    ["GM, face_up true", GM, bool(true), false],
  ])("%s", (_name, viewer, faceUp, down) => {
    const i = item(scene([card(faceUp)], { viewer }), "card");
    expect(i.faceDown).toBe(down);
    expect(i.label).toBe("Fireball");
    if (down) {
      expect(i).toMatchObject({ fill: null, faceDownGlyph: viewer.type === "gm" });
      expect(i.image).toBeUndefined();
      expect(i.pattern).toBeUndefined();
      expect(i.text).toBeUndefined();
    } else {
      expect(i).toMatchObject({
        fill: "red",
        image: "t.assets/fireball-00000000.png",
        pattern: "hatch",
        text: "8d6",
        faceDownGlyph: false,
      });
    }
  });

  test("character: an absent face_up is face down (fail closed)", () => {
    const v = card(bool(true));
    delete v.cells.face_up;
    expect(item(scene([v], { viewer: ALDRIC }), "card").faceDown).toBe(true);
    expect(item(scene([v], { viewer: GM }), "card").faceDown).toBe(false);
  });
});

describe("buildScene: object overlays", () => {
  const views = [
    obj("token", { at: [1, 1], shape: circle(0.5) }),
    obj("room", { shape: rect(4, 4), zone: true }),
    obj("pin", { at: [3, 3] }),
  ];

  test("selection and highlight outlines, per item bounds", () => {
    const s = scene(views, {
      selection: ["token", "missing"],
      highlight: ["room", "pin"],
    });
    expect(s.objectOverlays).toEqual(
      expect.arrayContaining([
        {
          kind: "selection",
          id: "token",
          bounds: { minX: 0.5, minY: 0.5, maxX: 1.5, maxY: 1.5 },
        },
        { kind: "highlight", id: "room", bounds: { minX: -2, minY: -2, maxX: 2, maxY: 2 } },
        { kind: "highlight", id: "pin", bounds: { minX: 3, minY: 3, maxX: 3, maxY: 3 } },
      ]),
    );
    expect(s.objectOverlays).toHaveLength(3);
  });

  test("the hovered item gets a hover outline", () => {
    const s = scene(views, { hover: "token" });
    expect(s.objectOverlays).toEqual([
      { kind: "hover", id: "token", bounds: { minX: 0.5, minY: 0.5, maxX: 1.5, maxY: 1.5 } },
    ]);
    expect(scene(views, { hover: "gone" }).objectOverlays).toEqual([]);
  });

  test("no overlays without selection, highlight or hover", () => {
    expect(scene(views).objectOverlays).toEqual([]);
  });

  test("overlays follow previews", () => {
    const s = scene(views, {
      selection: ["token"],
      previews: new Map([["token", { position: [10, 10] as [number, number] }]]),
    });
    expect(s.objectOverlays[0]?.bounds).toEqual({ minX: 9.5, minY: 9.5, maxX: 10.5, maxY: 10.5 });
  });
});

describe("labelVisible", () => {
  const s = scene([
    obj("wide", { shape: rect(1, 0.25), cells: { name: text("W") } }),
    obj("pin", { at: [3, 3], cells: { name: text("P") } }),
    obj("nameless", { shape: rect(4, 4) }),
  ]);
  test.each<[string, number, boolean]>([
    ["wide", 1, true],
    ["wide", 0.375, true],
    ["wide", 0.37, false],
    ["wide", 0.25, false],
    ["pin", 8, false],
    ["nameless", 1, false],
  ])("%s at zoom %s: %s", (id, zoom, visible) => {
    expect(labelVisible(item(s, id), { x: 0, y: 0, zoom })).toBe(visible);
  });
});
