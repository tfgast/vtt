// @vitest-environment node
/**
 * The bitmap cache benchmark (vtt-qf5.10, M6-D37; DESIGN.md §7 Benchmark).
 * Skipped in `pnpm test`; run with `pnpm bench:render`. Builds a stocked GM
 * board of 3,000 spawned tokens (name, hp and face), turns it into a face
 * scene, and times frames of the app's renderer over a `RecordingContext`
 * with the cache off and on (surfaces are recording contexts too). Frame
 * times are JavaScript only: issuing and recording draw calls, keys, hashes
 * and blits; no pixels are rasterized, so a browser's numbers differ.
 */
import { spawn, stockedTableSnapshot, Table, ViewBuilder, writeValue } from "@vtt/authority";
import type { ObjectView } from "@vtt/protocol";
import {
  buildFaceScene,
  type Camera,
  createCanvas2DRenderer,
  createFaceStateStore,
  drawFaceItem,
  type FaceScene,
  faceCacheKey,
  faceCullBounds,
  ImageCache,
  RecordingContext,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const RUN = process.env.VTT_BENCH_RENDER === "1";
const COLUMNS = 60;
const ROWS = 50;
const SPACING = 1.5;
const VIEWPORT: Viewport = { width: 1600, height: 1000, dpr: 2 };
const WARMUP = 5;
const FRAMES = 30;

function board(): FaceScene[] {
  const table = Table.fromSnapshot(stockedTableSnapshot());
  const result = table.store.transact({ type: "gm" }, { kind: "edit", label: "bench" }, (tx) => {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLUMNS; c++) {
        const at = {
          type: "board" as const,
          board: "gm_board",
          position: [c * SPACING, r * SPACING] as [number, number],
        };
        const id = spawn(tx, "tpl_token", at).root;
        writeValue(tx, id, "name", { type: "text", value: `Goblin ${r * COLUMNS + c}` });
        writeValue(tx, id, "max_hp", { type: "number", value: 7 + (c % 5) });
      }
    }
  });
  expect(result.ok, JSON.stringify(result).slice(0, 500)).toBe(true);
  const builder = new ViewBuilder(table, { type: "gm" });
  const views = Object.keys(table.store.toSnapshot().objects)
    .map((id) => builder.objectView(id, "all"))
    .filter((v): v is ObjectView => v !== null);
  const make = () =>
    buildFaceScene(
      { views, covers: [], board: "gm_board", viewer: { type: "gm" } },
      { faceState: createFaceStateStore() },
    );
  return [make(), make()];
}

interface Run {
  label: string;
  first: number;
  median: number;
  mean: number;
}

function time(
  label: string,
  cache: boolean,
  scenes: FaceScene[],
  camera: (frame: number) => Camera,
): Run {
  const main = new RecordingContext({ width: 1, height: 1 });
  const renderer = createCanvas2DRenderer<FaceScene>(main, {
    images: new ImageCache({ resolve: (p) => p }),
    drawItem: drawFaceItem,
    cullBounds: faceCullBounds,
    cacheKey: faceCacheKey,
    renderCache: cache
      ? {
          createSurface(width, height) {
            const ctx = new RecordingContext({ width, height });
            return { ctx, image: ctx as unknown as CanvasImageSource };
          },
        }
      : false,
  });
  const samples: number[] = [];
  let first = 0;
  for (let f = 0; f < WARMUP + FRAMES; f++) {
    main.calls.length = 0;
    const scene = scenes[f % scenes.length] as FaceScene;
    const t0 = performance.now();
    renderer.render(scene, [], camera(f), VIEWPORT);
    const dt = performance.now() - t0;
    if (f === 0) first = dt;
    if (f >= WARMUP) samples.push(dt);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] as number;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { label, first, median, mean };
}

describe.skipIf(!RUN)("bitmap cache benchmark (3,000 faces)", () => {
  test("frame time with the cache off and on", { timeout: 600_000 }, () => {
    const scenes = board();
    const [same] = scenes as [FaceScene, FaceScene];
    expect(same.items.length).toBeGreaterThanOrEqual(COLUMNS * ROWS);
    const cx = ((COLUMNS - 1) * SPACING) / 2;
    const cy = ((ROWS - 1) * SPACING) / 2;
    // Whole board in view (zoom ≈ 0.27), panning a little each frame.
    const whole = (f: number): Camera => ({ x: cx + (f % 3) * 0.01, y: cy, zoom: 0.27 });
    // Zoom 1: about a tenth of the board in view, panning.
    const near = (f: number): Camera => ({ x: cx + (f % 3) * 0.05, y: cy, zoom: 1 });
    const runs = [
      time("whole board, cache off", false, [same], whole),
      time("whole board, cache on, same scene", true, [same], whole),
      time("whole board, cache on, rebuilt scene each frame", true, scenes, whole),
      time("zoom 1, cache off", false, [same], near),
      time("zoom 1, cache on, same scene", true, [same], near),
      time("zoom 1, cache on, rebuilt scene each frame", true, scenes, near),
    ];
    const lines = runs.map(
      (r) =>
        `${r.label.padEnd(50)} first ${r.first.toFixed(1)} ms, median ${r.median.toFixed(2)} ms, mean ${r.mean.toFixed(2)} ms`,
    );
    console.log(
      `\n${same.items.length} items, ${VIEWPORT.width}×${VIEWPORT.height} @${VIEWPORT.dpr}x\n${lines.join("\n")}`,
    );
  });
});
