// @vitest-environment node
/**
 * The when_selected count badge on the canvas (vtt-nb8.35; DESIGN.md §4.6
 * Only when selected, M6-D12, M6-D16): the real renderer with
 * `drawFaceItem` over a `RecordingContext`. The badge is a plain text
 * primitive without `min_size`, so it is painted at map zoom (0.3), where
 * the list's own `min_size` would hide the list even when selected.
 */
import type { FaceElementView, ObjectView, WireValue } from "@vtt/protocol";
import type { ObjectId, Rect } from "@vtt/schema";
import {
  buildFaceScene,
  type Camera,
  createCanvas2DRenderer,
  createFaceStateStore,
  drawFaceItem,
  type FaceScene,
  faceCullBounds,
  ImageCache,
  RecordingContext,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const LIST: Rect = [-1.5, 0.9, 3, 1.2];

function view(id: string, cells: ObjectView["cells"], face?: FaceElementView[]): ObjectView {
  const v: ObjectView = {
    id,
    is_template: false,
    is_character: false,
    cells: {
      name: { value: text(id), kind: "literal" },
      face_up: { value: { type: "boolean", value: true }, kind: "literal" },
      ...cells,
    },
    actions: [],
    action_states: [],
  };
  if (face) v.face = { elements: face };
  return v;
}

const goblin = view(
  "goblin",
  {
    shape: { value: { type: "shape", shape: { type: "circle", radius: 0.9 } }, kind: "literal" },
    board: { value: ref(BOARD), kind: "literal" },
    position: { value: { type: "list", items: [num(0), num(0)] }, kind: "literal" },
    container: { value: { type: "empty" }, kind: "structural" },
    contents: {
      value: { type: "list", items: [ref("a"), ref("b"), ref("c")] },
      kind: "structural",
    },
  },
  [
    {
      type: "contents",
      rect: LIST,
      index: 0,
      shown: true,
      min_size: 24,
      when_selected: true,
    } as FaceElementView,
  ],
);
const entries = ["a", "b", "c"].map((id) =>
  view(id, { container: { value: ref("goblin"), kind: "structural" } }),
);

function render(zoom: number, selection: ObjectId[]): RecordingContext {
  const ctx = new RecordingContext();
  const scene = buildFaceScene(
    { views: [goblin, ...entries], covers: [], board: BOARD, viewer: { type: "gm" }, selection },
    { faceState: createFaceStateStore() },
  );
  const renderer = createCanvas2DRenderer<FaceScene>(ctx, {
    images: new ImageCache({ resolve: (p) => p }),
    drawItem: drawFaceItem,
    cullBounds: faceCullBounds,
  });
  const camera: Camera = { x: 0, y: 0, zoom };
  renderer.render(scene, [], camera, VIEWPORT);
  return ctx;
}

const texts = (ctx: RecordingContext) =>
  ctx.paints.filter((c) => c.name === "fillText").map((c) => c.args[0] as string);

describe("the count badge", () => {
  test("is painted at zoom 0.3 for an unselected object, below its frame's centre", () => {
    const ctx = render(0.3, []);
    const badge = ctx.paints.find((c) => c.name === "fillText" && c.args[0] === "3");
    expect(badge, texts(ctx).join(", ")).toBeDefined();
    // The badge sits right of the anchor and below the token (screen centre 400, 300).
    expect(badge?.extent?.minX ?? 0).toBeGreaterThan(400);
    expect(badge?.extent?.minY ?? 0).toBeGreaterThan(300);
  });

  test("is painted at zoom 1 too, and not once the object is selected", () => {
    expect(texts(render(1, []))).toContain("3");
    const selected = render(1, ["goblin"]);
    expect(texts(selected)).not.toContain("3");
    // The list's rows are drawn instead (each entry's collapsed name).
    expect(texts(selected)).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });
});
