// @vitest-environment node
/**
 * The bitmap cache with faces (vtt-qf5.10, M6-D37): a stocked goblin drawn by
 * `drawFaceItem` keyed by `faceCacheKey` is drawn into its surface once,
 * blitted while nothing changes (across rebuilt scenes), and drawn again once
 * a cell its face shows changes. A thick ink stroke on a face's edge is
 * held whole by its surface (`faceCacheBounds`). (Selecting the goblin changes its drawing:
 * its `when_selected` list shows, M6-D12, so that redraws by design.)
 */
import { spawn, stockedTableSnapshot, Table, ViewBuilder, writeValue } from "@vtt/authority";
import type { ObjectView } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import {
  buildFaceScene,
  createCanvas2DRenderer,
  createFaceStateStore,
  type DrawItem,
  drawFaceItem,
  type FaceDrawing,
  type FaceScene,
  faceCacheBounds,
  faceCacheKey,
  faceCullBounds,
  ImageCache,
  type RecordedCall,
  RecordingContext,
} from "@vtt/ui";
import { expect, test } from "vitest";

function goblinTable(): { table: Table; goblin: ObjectId } {
  const table = Table.fromSnapshot(stockedTableSnapshot());
  let goblin = "";
  const result = table.store.transact({ type: "gm" }, { kind: "edit", label: "prep" }, (tx) => {
    goblin = spawn(tx, "tpl_token", { type: "board", board: "gm_board", position: [0, 0] }).root;
    writeValue(tx, goblin, "name", { type: "text", value: "Goblin" });
    writeValue(tx, goblin, "max_hp", { type: "number", value: 7 });
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return { table, goblin };
}

function faceScene(table: Table): FaceScene {
  const builder = new ViewBuilder(table, { type: "gm" });
  const views = Object.keys(table.store.toSnapshot().objects)
    .map((id) => builder.objectView(id, "all"))
    .filter((v): v is ObjectView => v !== null);
  return buildFaceScene(
    { views, covers: [], board: "gm_board", viewer: { type: "gm" } },
    { faceState: createFaceStateStore() },
  );
}

const texts = (calls: RecordedCall[]) =>
  calls.filter((c) => c.name === "fillText").map((c) => String(c.args[0]));

test("a face is drawn into its bitmap once and again after a cell it shows changes", () => {
  const { table, goblin } = goblinTable();
  const main = new RecordingContext();
  const surfaces: RecordingContext[] = [];
  const renderer = createCanvas2DRenderer<FaceScene>(main, {
    images: new ImageCache({ resolve: (p) => p }),
    drawItem: drawFaceItem,
    cullBounds: faceCullBounds,
    cacheKey: faceCacheKey,
    renderCache: {
      createSurface(width, height) {
        const ctx = new RecordingContext({ width, height });
        surfaces.push(ctx);
        return { ctx, image: ctx as unknown as CanvasImageSource };
      },
    },
  });
  const camera = { x: 0, y: 0, zoom: 1 };
  const viewport = { width: 800, height: 600, dpr: 1 };
  const frame = (scene: FaceScene) => {
    const from = main.calls.length;
    renderer.render(scene, [], camera, viewport);
    return main.calls.slice(from);
  };
  const drawn = () => surfaces.flatMap((s) => texts(s.calls));

  const first = frame(faceScene(table));
  expect(drawn()).toContain("Goblin");
  expect(drawn()).toContain("7");
  expect(texts(first)).not.toContain("Goblin");
  const once = drawn().length;

  frame(faceScene(table));
  frame(faceScene(table));
  expect(drawn().length, JSON.stringify(drawn())).toBe(once);

  const result = table.store.transact({ type: "gm" }, { kind: "edit", label: "hurt" }, (tx) =>
    writeValue(tx, goblin, "max_hp", { type: "number", value: 9 }),
  );
  expect(result.ok).toBe(true);
  const after = frame(faceScene(table));
  expect(drawn().length).toBeGreaterThan(once);
  expect(drawn().slice(once)).toContain("9");
  expect(texts(after)).not.toContain("9");
});

test("a thick ink stroke on the face's edge is held whole by the surface", () => {
  const item: DrawItem = {
    id: "note",
    anchor: [0, 0],
    rotation: 0,
    z: 0,
    shape: { type: "rect", width: 2, height: 2 },
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    isZone: false,
    fill: "#ffffff",
    faceDown: false,
    faceDownGlyph: false,
    opaqueGm: false,
    hiddenBadge: false,
    outline: true,
    alpha: 1,
  };
  // A 0.6-unit stroke along the right edge: 0.3 units past the 2 × 2 face, round caps past the ends.
  const drawing: FaceDrawing = {
    frame: [-1, -1, 2, 2],
    bounds: [-1, -1, 2, 2],
    base: null,
    primitives: [
      {
        kind: "ink",
        rect: [-1, -1, 2, 2],
        minSize: 0,
        element: 0,
        strokes: [
          {
            points: [
              [1, -1],
              [1, 1],
            ],
            width: 0.6,
          },
        ],
        target: { type: "body" },
      },
    ],
  };
  const scene: FaceScene = {
    items: [item],
    covers: [],
    objectOverlays: [],
    skipped: [],
    faces: new Map([["note", drawing]]),
    presentation: new Map([["note", item.bounds]]),
    transforms: new Map(),
  };
  const camera = { x: 0, y: 0, zoom: 1 };
  expect(faceCacheBounds(item, scene, camera)).toEqual({
    minX: 0.7,
    minY: -1.3,
    maxX: 1.3,
    maxY: 1.3,
  });

  const draw = (renderCache: boolean) => {
    const main = new RecordingContext();
    const surfaces: RecordingContext[] = [];
    createCanvas2DRenderer<FaceScene>(main, {
      images: new ImageCache({ resolve: (p) => p }),
      drawItem: drawFaceItem,
      cullBounds: faceCullBounds,
      cacheKey: faceCacheKey,
      cacheBounds: faceCacheBounds,
      renderCache: renderCache
        ? {
            createSurface(width, height) {
              const ctx = new RecordingContext({ width, height });
              surfaces.push(ctx);
              return { ctx, image: ctx as unknown as CanvasImageSource };
            },
          }
        : false,
    }).render(scene, [], camera, { width: 800, height: 600, dpr: 1 });
    return { main, surfaces };
  };
  const live = draw(false).main.calls.find(
    (c) => c.name === "stroke" && c.style?.lineWidth === 0.6,
  );
  expect(live?.extent?.maxX).toBeCloseTo(400 + 1.3 * 64, 6);

  const { surfaces } = draw(true);
  expect(surfaces).toHaveLength(1);
  const surface = surfaces[0] as RecordingContext;
  const ink = surface.calls.find((c) => c.name === "stroke" && c.style?.lineWidth === 0.6);
  const e = ink?.extent as NonNullable<RecordedCall["extent"]>;
  expect(e).toBeTruthy();
  // The stroke's whole box lies inside the surface.
  expect(e.minX).toBeGreaterThanOrEqual(0);
  expect(e.minY).toBeGreaterThanOrEqual(0);
  expect(e.maxX).toBeLessThanOrEqual(surface.canvas.width);
  expect(e.maxY).toBeLessThanOrEqual(surface.canvas.height);
});
