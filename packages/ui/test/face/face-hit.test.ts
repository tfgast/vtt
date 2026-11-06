// @vitest-environment node
import type { ObjectView, Viewer, WireResult, WireValue } from "@vtt/protocol";
import type { Point, Shape } from "@vtt/schema";
import { buildFaceScene, type Camera, createFaceStateStore, faceHitAt } from "@vtt/ui";
import { describe, expect, test } from "vitest";

// The face hit path takes its candidates in `hitOrder` (DESIGN.md §4.6 On the canvas, M6-D10).

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const num = (value: number): WireValue => ({ type: "number", value });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });

function obj(id: string, at: Point, z: number, shape: Shape, zone = false): ObjectView {
  const values: Record<string, WireResult> = {
    board: { type: "ref", object: BOARD },
    container: { type: "empty" },
    position: { type: "list", items: [num(at[0]), num(at[1])] },
    rotation: num(0),
    z: num(z),
    shape: { type: "shape", shape },
    is_zone: { type: "boolean", value: zone },
    face_up: { type: "boolean", value: true },
  };
  const cells: ObjectView["cells"] = {};
  for (const [name, value] of Object.entries(values)) cells[name] = { value, kind: "literal" };
  return { id, is_template: false, is_character: false, cells, actions: [], action_states: [] };
}

function hitAt(views: ObjectView[], point: Point): string | null {
  const scene = buildFaceScene(
    { views, covers: [], board: BOARD, viewer: GM },
    { faceState: createFaceStateStore() },
  );
  return faceHitAt(scene, point, CAMERA)?.object ?? null;
}

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length === 0
    ? [[]]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
      );

describe("faceHitAt: hit order", () => {
  const map = (z: number) => obj("map", [0, 0], z, rect(20, 20));
  const room = (z: number) => obj("room", [2, 2], z, rect(8, 8), true);
  const goblin = (z: number) => obj("goblin", [3, 3], z, circle(0.5));

  const cases = [...permutations([1, 2, 3]), [0, 0, 0]].flatMap((z) =>
    permutations([0, 1, 2]).map((order) => ({ z, order })),
  );

  test.each(cases)("goblin, then room, then map (z $z, insertion $order)", ({ z, order }) => {
    const [mapZ, roomZ, goblinZ] = z as [number, number, number];
    const all = [map(mapZ), room(roomZ), goblin(goblinZ)];
    const views = order.map((i) => all[i] as ObjectView);
    expect(hitAt(views, [3, 3])).toBe("goblin");
    expect(hitAt(views, [5, 5])).toBe("room");
    expect(hitAt(views, [-5, -5])).toBe("map");
  });

  test("a non-zone that overlaps but does not contain the zone stays before it", () => {
    const zone = obj("zone", [0, 0], 9, rect(6, 6), true);
    const slab = obj("slab", [5, 0], 0, rect(6, 6));
    expect(hitAt([zone, slab], [2.5, 0])).toBe("slab");
  });

  test("of two overlapping zones of equal size, the higher z", () => {
    const low = obj("low", [0, 0], 2, rect(4, 4), true);
    const high = obj("high", [1, 0], 5, rect(4, 4), true);
    expect(hitAt([high, low], [0.5, 0])).toBe("high");
  });

  test("a token over a zone it lies in, and the zone elsewhere (unchanged)", () => {
    const zone = obj("zone", [0, 0], 10, rect(10, 10), true);
    const token = obj("token", [1, 1], 5, circle(0.5));
    expect(hitAt([zone, token], [1, 1])).toBe("token");
    expect(hitAt([zone, token], [3, 3])).toBe("zone");
  });
});
