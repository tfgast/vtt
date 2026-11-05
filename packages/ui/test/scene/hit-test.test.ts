// @vitest-environment node
import type { CellView, Cover, ObjectView, Viewer, WireResult, WireValue } from "@vtt/protocol";
import type { Point, Shape } from "@vtt/schema";
import {
  buildScene,
  type Camera,
  hitsAt,
  hitTest,
  isCovered,
  marqueeHit,
  type Scene,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

const num = (value: number): WireValue => ({ type: "number", value });

function obj(
  id: string,
  at: Point,
  z: number,
  shape: Shape | null,
  extra: { zone?: boolean; rotation?: number; image?: string } = {},
): ObjectView {
  const values: Record<string, WireResult> = {
    board: { type: "ref", object: BOARD },
    container: { type: "empty" },
    position: { type: "list", items: [num(at[0]), num(at[1])] },
    rotation: num(extra.rotation ?? 0),
    z: num(z),
    shape: shape ? { type: "shape", shape } : { type: "empty" },
    is_zone: { type: "boolean", value: extra.zone ?? false },
    face_up: { type: "boolean", value: true },
  };
  if (extra.image) values.image = { type: "text", value: extra.image };
  const cells: Record<string, CellView> = {};
  for (const [name, value] of Object.entries(values)) cells[name] = { value, kind: "literal" };
  return { id, is_template: false, is_character: false, cells, actions: [] };
}

const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });

// A room zone (z 10, above the map in z), a map image over part of it, tokens on the map.
const room = obj("room", [0, 0], 10, rect(10, 10), { zone: true });
const map = obj("map", [0, 0], 1, rect(6, 6), { image: "t.assets/map-00000000.png" });
const token = obj("token", [1, 1], 5, circle(0.5));
const higher = obj("higher", [1.2, 1], 6, circle(0.5));
const twinA = obj("twin_a", [-1, -1], 3, circle(0.5));
const twinB = obj("twin_b", [-1, -1], 3, circle(0.5));
const bar = obj("bar", [20, 0], 0, rect(4, 1), { rotation: 90 });
const pin = obj("pin", [30, 0], 0, null);

const covers: Cover[] = [
  { key: "c1", board: BOARD, region: { position: [-2, 2], rotation: 0, shape: rect(1, 1) } },
];

function build(views: ObjectView[], viewer: Viewer = GM, withCovers: Cover[] = []): Scene {
  return buildScene({ views, covers: withCovers, board: BOARD, viewer });
}

const all = build([room, map, token, higher, twinA, twinB, bar, pin]);

describe("hitsAt", () => {
  test("token above a map image above a room zone: token, image, zone", () => {
    const s = build([room, map, token]);
    expect(hitsAt(s, [1, 1], CAMERA)).toEqual(["token", "map", "room"]);
  });

  test.each<[string, Point, string[]]>([
    ["overlapping tokens: higher z first", [1.1, 1], ["higher", "token", "map", "room"]],
    ["equal z: later in draw order first", [-1, -1], ["twin_b", "twin_a", "map", "room"]],
    ["map area with no token", [2.5, -2.5], ["map", "room"]],
    ["inside the zone, outside the image", [4, 4], ["room"]],
    ["outside everything", [50, 50], []],
    ["rotated rect, inside its rotated footprint", [20, 1.8], ["bar"]],
    ["rotated rect, inside its unrotated footprint only", [21.5, 0], []],
    ["rotated rect, boundary", [20.5, 2], ["bar"]],
    ["shapeless, within 6 px", [30.09, 0], ["pin"]],
    ["shapeless, beyond 6 px", [30.1, 0], []],
  ])("%s", (_name, point, expected) => {
    expect(hitsAt(all, point, CAMERA)).toEqual(expected);
  });

  test("the shapeless slop is in screen pixels", () => {
    expect(hitsAt(all, [30.09, 0], { x: 0, y: 0, zoom: 2 })).toEqual([]);
    expect(hitsAt(all, [30.04, 0.02], { x: 0, y: 0, zoom: 2 })).toEqual(["pin"]);
  });

  test("nothing inside a cover", () => {
    const s = build([room, map, token], ALDRIC, covers);
    expect(hitsAt(s, [-2, 2], CAMERA)).toEqual([]);
    expect(hitsAt(s, [-2.5, 2.5], CAMERA)).toEqual([]);
    expect(hitsAt(s, [2, 2], CAMERA)).toEqual(["map", "room"]);
  });

  test("nothing anywhere under a whole_board cover", () => {
    const s = build([room, map, token], ALDRIC, [
      { key: "w", board: BOARD, region: { whole_board: true } },
    ]);
    expect(hitsAt(s, [1, 1], CAMERA)).toEqual([]);
  });
});

describe("hitTest", () => {
  test.each<[string, Point, string | null]>([
    ["picks the higher-z of two overlapping tokens", [1.1, 1], "higher"],
    ["picks a token over the zone that contains it", [-1, -1], "twin_b"],
    ["picks the zone on empty area inside it", [4, 4], "room"],
    ["picks nothing outside", [50, 50], null],
  ])("%s", (_name, point, expected) => {
    expect(hitTest(all, point, CAMERA)).toBe(expected);
  });

  test("a token alone over a zone", () => {
    const s = build([room, token]);
    expect(hitTest(s, [1, 1], CAMERA)).toBe("token");
    expect(hitTest(s, [3, 3], CAMERA)).toBe("room");
  });

  test("returns null inside a cover", () => {
    expect(hitTest(build([room, map], ALDRIC, covers), [-2, 2], CAMERA)).toBeNull();
  });
});

describe("isCovered", () => {
  const s = build([], ALDRIC, [
    ...covers,
    { key: "c2", board: BOARD, region: { position: [10, 10], rotation: 45, shape: rect(2, 2) } },
  ]);
  test.each<[string, Point, boolean]>([
    ["inside a region cover", [-2, 2], true],
    ["on its boundary", [-1.5, 2.5], true],
    ["outside it", [-1, 2], false],
    ["inside a rotated cover's diamond", [10, 11.4], true],
    ["inside its unrotated square only", [10.95, 10.95], false],
  ])("%s", (_name, point, covered) => {
    expect(isCovered(s, point)).toBe(covered);
  });

  test("anywhere with whole_board", () => {
    const w = build([], ALDRIC, [{ key: "w", board: BOARD, region: { whole_board: true } }]);
    expect(isCovered(w, [0, 0])).toBe(true);
    expect(isCovered(w, [1e6, -1e6])).toBe(true);
  });

  test("never in a scene without covers", () => {
    expect(isCovered(build([room]), [0, 0])).toBe(false);
  });
});

describe("marqueeHit", () => {
  test("selects only fully enclosed items, non-zones before zones", () => {
    const s = build([room, map, token, higher, pin]);
    expect(marqueeHit(s, { minX: -4, minY: -4, maxX: 4, maxY: 4 })).toEqual([
      "higher",
      "token",
      "map",
    ]);
    expect(marqueeHit(s, { minX: -5, minY: -5, maxX: 5, maxY: 5 })).toEqual([
      "higher",
      "token",
      "map",
      "room",
    ]);
    expect(marqueeHit(s, { minX: 0, minY: 0, maxX: 2, maxY: 2 })).toEqual(["higher", "token"]);
    expect(marqueeHit(s, { minX: 1, minY: 0, maxX: 2, maxY: 2 })).toEqual([]);
    expect(marqueeHit(s, { minX: 29, minY: -1, maxX: 31, maxY: 1 })).toEqual(["pin"]);
  });

  test("a rectangle dragged in any direction", () => {
    const s = build([token]);
    expect(marqueeHit(s, { minX: 2, minY: 2, maxX: 0, maxY: 0 })).toEqual(["token"]);
  });
});
