// @vitest-environment node
/**
 * Face culling keeps the screen-size padding (vtt-qf5.41; DESIGN.md §4.6
 * Zoom as level of detail): with `cullBounds: faceCullBounds`, the label
 * strip below an item, the shapeless marker and the hidden-contents badge
 * still keep an item drawn whose bounds lie just off the view, exactly as
 * the default culling does; an item outside even with that padding is culled.
 */
import type { Bounds, Point, Shape } from "@vtt/schema";
import {
  type Camera,
  cameraScale,
  createCanvas2DRenderer,
  type DrawItem,
  type FaceScene,
  faceCullBounds,
  ImageCache,
  MARKER_PX,
  RecordingContext,
  type Viewport,
  visibleBounds,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };

function item(id: string, anchor: Point, shape: Shape | null, over: Partial<DrawItem> = {}) {
  const [x, y] = anchor;
  const bounds: Bounds =
    shape === null
      ? { minX: x, minY: y, maxX: x, maxY: y }
      : shape.type === "rect"
        ? {
            minX: x - shape.width / 2,
            minY: y - shape.height / 2,
            maxX: x + shape.width / 2,
            maxY: y + shape.height / 2,
          }
        : (() => {
            throw new Error("rect or null only");
          })();
  const it: DrawItem = {
    id,
    anchor,
    rotation: 0,
    z: 0,
    shape,
    bounds,
    isZone: false,
    fill: "#c9c4b8",
    faceDown: false,
    faceDownGlyph: false,
    opaqueGm: false,
    hiddenBadge: false,
    outline: true,
    alpha: 1,
    ...over,
  };
  return it;
}

const unit: Shape = { type: "rect", width: 1, height: 1 };

/** Renders `items` as a face scene (presentation = own bounds) culled by `faceCullBounds`. */
function drawn(items: DrawItem[], camera: Camera): string[] {
  const scene: FaceScene = {
    items,
    covers: [],
    objectOverlays: [],
    skipped: [],
    faces: new Map(),
    presentation: new Map(items.map((it) => [it.id, it.bounds])),
    transforms: new Map(),
  };
  const out: string[] = [];
  const renderer = createCanvas2DRenderer<FaceScene>(new RecordingContext(), {
    images: new ImageCache({ resolve: (p) => `/assets/${p}` }),
    cullBounds: faceCullBounds,
    drawItem: (_c, it) => out.push(it.id),
  });
  renderer.render(scene, [], camera, VIEWPORT);
  return out;
}

describe.each([1, 0.5, 2])("faceCullBounds pads like the default at zoom %s", (zoom) => {
  const camera: Camera = { x: 0, y: 0, zoom };
  const view = visibleBounds(camera, VIEWPORT);
  const px = 1 / cameraScale(camera);
  // Label strip: 4 px gap + 12 px font + 2 px background = 18 px below the bounds.
  const strip = 18 * px;
  const marker = (MARKER_PX / 2) * px;
  const badge = 6 * px;
  // Big enough that its label shows at every zoom tested (≥ 24 px on screen).
  const card: Shape = { type: "rect", width: 1, height: 1 };

  test("a label strip reaching into the top edge keeps an item above the view drawn", () => {
    // Bounds end half a strip above the view; the strip reaches into it.
    const maxY = view.minY - strip / 2;
    const it = item("labelled", [0, maxY - 0.5], card, { label: "Goblin" });
    expect(it.bounds.maxY).toBeLessThan(view.minY);
    expect(drawn([it], camera)).toEqual(["labelled"]);
  });

  test("a shapeless marker reaching in from just off the left edge is drawn", () => {
    const it = item("dot", [view.minX - marker / 2, 0], null);
    expect(drawn([it], camera)).toEqual(["dot"]);
  });

  test("a hidden badge reaching in from just off the left edge is drawn", () => {
    const it = item("secret", [view.minX - 0.5 - badge / 2, 0], unit, { hiddenBadge: true });
    expect(it.bounds.maxX).toBeLessThan(view.minX);
    expect(drawn([it], camera)).toEqual(["secret"]);
  });

  test("items outside the view even with their padding are culled", () => {
    const labelled = item("labelled", [0, view.minY - strip * 1.5 - 0.5], card, {
      label: "Goblin",
    });
    const dot = item("dot", [view.minX - marker * 1.5, 0], null);
    const secret = item("secret", [view.minX - 0.5 - badge * 1.5, 0], unit, {
      hiddenBadge: true,
    });
    expect(drawn([labelled, dot, secret], camera)).toEqual([]);
  });
});
