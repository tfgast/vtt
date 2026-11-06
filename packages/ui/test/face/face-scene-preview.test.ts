// @vitest-environment node
import type { FaceElementView, FaceView, ObjectView, WireValue } from "@vtt/protocol";
import type { FaceLayout, Rect } from "@vtt/schema";
import { buildFaceScene, createFaceStateStore, type SceneInput } from "@vtt/ui";
import { describe, expect, test } from "vitest";

// A handle resize previews the scaled face during the drag (vtt-qf5.67, M6-D14).

const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });

const nameRow = (r: Rect): FaceElementView =>
  ({ type: "value", cell: "name", rect: r, index: 0, shown: true }) as FaceElementView;

const FACE: FaceView = { elements: [nameRow([-3, -4, 6, 1])] };

const binder: ObjectView = {
  id: "b",
  is_template: false,
  is_character: false,
  cells: {
    name: { value: text("Binder"), kind: "literal" },
    face_up: { value: { type: "boolean", value: true }, kind: "literal" },
    shape: {
      value: { type: "shape", shape: { type: "rect", width: 6, height: 8 } },
      kind: "literal",
    },
    board: { value: { type: "ref", object: "main" }, kind: "literal" },
    position: { value: { type: "list", items: [num(0), num(0)] }, kind: "literal" },
    container: { value: { type: "empty" }, kind: "structural" },
  },
  actions: [],
  action_states: [],
  face: FACE,
};

function input(previews?: SceneInput["previews"]): SceneInput {
  return {
    views: [binder],
    covers: [],
    board: "main",
    viewer: { type: "gm" },
    ...(previews === undefined ? {} : { previews }),
  };
}

const rectsOf = (previews?: SceneInput["previews"]) =>
  buildFaceScene(input(previews), { faceState: createFaceStateStore() })
    .faces.get("b")
    ?.primitives.map((p) => p.rect);

describe("buildFaceScene with a preview face", () => {
  test("without a preview face the drawing uses the view's layout", () => {
    expect(rectsOf()).toEqual([[-3, -4, 6, 1]]);
    expect(rectsOf(new Map([["b", { shape: { type: "rect", width: 6, height: 16 } }]]))).toEqual([
      [-3, -4, 6, 1],
    ]);
  });

  test("the preview's face replaces the stored layout's rects in the drawing", () => {
    const scaled: FaceLayout = {
      elements: [{ type: "value", cell: "name", rect: [-3, -8, 6, 2] }],
    };
    const previews = new Map([
      ["b", { shape: { type: "rect" as const, width: 6, height: 16 }, face: scaled }],
    ]);
    expect(rectsOf(previews)).toEqual([[-3, -8, 6, 2]]);
  });
});
