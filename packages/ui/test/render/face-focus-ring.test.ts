// @vitest-environment node
/**
 * The keyboard face focus ring (vtt-qf5.26): a `face_focus` tool overlay is
 * drawn by the Canvas2D renderer as a solid `HIGHLIGHT_STROKE` rect around
 * the target, in the object's frame, before covers, and only while the
 * object is drawn and outlined as selected.
 */
import type { Point } from "@vtt/schema";
import {
  type Camera,
  COVER_FILL,
  type CoverItem,
  createCanvas2DRenderer,
  type DrawItem,
  HIGHLIGHT_STROKE,
  ImageCache,
  type RecordedCall,
  RecordingContext,
  type Scene,
  type ToolOverlay,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };

function card(anchor: Point, rotation: number): DrawItem {
  return {
    id: "card",
    anchor,
    rotation,
    z: 0,
    shape: { type: "rect", width: 2, height: 3 },
    bounds: {
      minX: anchor[0] - 1.5,
      minY: anchor[1] - 1.5,
      maxX: anchor[0] + 1.5,
      maxY: anchor[1] + 1.5,
    },
    isZone: false,
    fill: "#c9c4b8",
    faceDown: false,
    faceDownGlyph: false,
    opaqueGm: false,
    hiddenBadge: false,
    outline: true,
    alpha: 1,
  };
}

function sceneOf(item: DrawItem, selected: boolean, covers: CoverItem[] = []): Scene {
  return {
    items: [item],
    covers,
    objectOverlays: selected ? [{ kind: "selection", id: item.id, bounds: item.bounds }] : [],
    skipped: [],
  };
}

const FOCUS: ToolOverlay = { kind: "face_focus", object: "card", rect: [-1.2, 0.5, 1.1, 0.45] };

function draw(scene: Scene, overlays: ToolOverlay[]): RecordingContext {
  const ctx = new RecordingContext();
  createCanvas2DRenderer(ctx, { images: new ImageCache({ resolve: (p) => p }) }).render(
    scene,
    overlays,
    CAMERA,
    VIEWPORT,
  );
  return ctx;
}

const rings = (ctx: RecordingContext): RecordedCall[] =>
  ctx.calls.filter((c) => c.name === "stroke" && c.style?.strokeStyle === HIGHLIGHT_STROKE);

describe("the face focus ring", () => {
  test("a solid 2 px highlight rect around the target, padded, in the selected object's frame", () => {
    const ctx = draw(sceneOf(card([10, 5], 90), true), [FOCUS]);
    const [ring, ...rest] = rings(ctx);
    expect(rest).toEqual([]);
    expect(ring).toBeDefined();
    if (ring === undefined) return;
    // One board unit is 64 CSS px at zoom 1: 2 px wide, solid.
    expect(ring.style?.lineWidth).toBeCloseTo(2 / 64, 12);
    expect(ring.style?.lineDash).toEqual([]);
    // Camera, then the card's anchor and its quarter turn.
    const expected = [0, 64, -64, 0, 400 + 10 * 64, 300 + 5 * 64];
    for (const [i, v] of ring.transform.entries()) {
      expect(v).toBeCloseTo(expected[i] as number, 9);
    }
    // The rect padded by 3 CSS px each side, turned: x from -(0.95 + pad) to -(0.5 - pad), and so on.
    const pad = 3 / 64;
    const box = ring.extent;
    expect(box).toBeDefined();
    const half = 1 / 64; // half the line width, in device px per unit
    expect(box?.minX).toBeCloseTo(1040 + (-0.95 - pad) * 64 - half * 64, 6);
    expect(box?.maxX).toBeCloseTo(1040 + (-0.5 + pad) * 64 + half * 64, 6);
    expect(box?.minY).toBeCloseTo(620 + (-1.2 - pad) * 64 - half * 64, 6);
    expect(box?.maxY).toBeCloseTo(620 + (-0.1 + pad) * 64 + half * 64, 6);
  });

  test("nothing when the object is not selected or not drawn", () => {
    expect(rings(draw(sceneOf(card([0, 0], 0), false), [FOCUS]))).toEqual([]);
    const other: ToolOverlay = { ...FOCUS, object: "gone" } as ToolOverlay;
    expect(rings(draw(sceneOf(card([0, 0], 0), true), [other]))).toEqual([]);
  });

  test("drawn before covers, like every object-related overlay", () => {
    const cover: CoverItem = {
      key: "fog",
      wholeBoard: false,
      anchor: [0, 0],
      rotation: 0,
      shape: { type: "rect", width: 8, height: 8 },
      bounds: { minX: -4, minY: -4, maxX: 4, maxY: 4 },
    };
    const ctx = draw(sceneOf(card([0, 0], 0), true, [cover]), [FOCUS]);
    const ring = ctx.calls.findIndex((c) => rings(ctx).includes(c));
    const firstCover = ctx.calls.findIndex(
      (c) => (c.name === "fill" || c.name === "fillRect") && c.style?.fillStyle === COVER_FILL,
    );
    expect(ring).toBeGreaterThanOrEqual(0);
    expect(firstCover).toBeGreaterThan(ring);
  });
});
