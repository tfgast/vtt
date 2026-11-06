// @vitest-environment node
/**
 * The stocked faces at map zoom (vtt-nb8.24, M6-D16; DESIGN.md §4.6 Zoom as
 * level of detail, §4.7 Example templates; §8.4 steps 2, 4, 10, 11).
 *
 * A real stocked table spawns a goblin (`tpl_token`, `hit` true) and a
 * character (`tpl_character`) onto the GM board; the GM's object views are
 * built with `ViewBuilder`, turned into a scene by `buildFaceScene`, and drawn
 * by the Canvas2D renderer with `drawFaceItem` over a `RecordingContext` at
 * camera zoom 0.5, the zoom a GM looking at the whole map sits at. No
 * element is brought into view. At the renderer's minimum zoom the badge
 * still draws, at the persistent-text floor (vtt-qf5.61).
 */
import {
  move,
  spawn,
  stockedTableSnapshot,
  Table,
  type Transaction,
  ViewBuilder,
  writeValue,
} from "@vtt/authority";
import type { ObjectView } from "@vtt/protocol";
import type { ObjectId, Rect, Value } from "@vtt/schema";
import {
  buildFaceScene,
  type Camera,
  createCanvas2DRenderer,
  createFaceStateStore,
  drawFaceItem,
  type FaceScene,
  faceCullBounds,
  ImageCache,
  MIN_ZOOM,
  PERSISTENT_TEXT_MIN_PX,
  type RecordedCall,
  RecordingContext,
  type Viewport,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };
/** Board units to CSS px at zoom 1 (the renderer's base scale). */
const UNIT_PX = 64;
const ZOOM = 0.5;

const text = (value: string): Value => ({ type: "text", value });
const num = (value: number): Value => ({ type: "number", value });
const TRUE: Value = { type: "boolean", value: true };

interface Placed {
  table: Table;
  goblin: ObjectId;
  aldric: ObjectId;
  binder: ObjectId;
}

/** A stocked table with a hit goblin at [0, 0] and Aldric at [20, 0]. */
function placed(): Placed {
  const table = Table.fromSnapshot(stockedTableSnapshot());
  let out: Omit<Placed, "table"> | undefined;
  const result = table.store.transact({ type: "gm" }, { kind: "edit", label: "prep" }, (tx) => {
    out = prep(tx);
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return { table, ...(out as Omit<Placed, "table">) };
}

function prep(tx: Transaction): Omit<Placed, "table"> {
  const at = (x: number) => ({
    type: "board" as const,
    board: "gm_board",
    position: [x, 0] as [number, number],
  });
  const goblin = spawn(tx, "tpl_token", at(0)).root;
  writeValue(tx, goblin, "name", text("Goblin"));
  writeValue(tx, goblin, "max_hp", num(7));
  writeValue(tx, goblin, "hit", TRUE);
  const character = spawn(tx, "tpl_character", at(20));
  const aldric = character.root;
  writeValue(tx, aldric, "name", text("Aldric"));
  const sheet = character.copies.get("tpl_character_sheet") as ObjectId;
  writeValue(tx, sheet, "max_hp", num(9));
  const binder = character.copies.get("tpl_character_binder") as ObjectId;
  return { goblin, aldric, binder };
}

function views(table: Table): ObjectView[] {
  const builder = new ViewBuilder(table, { type: "gm" });
  return Object.keys(table.store.toSnapshot().objects)
    .map((id) => builder.objectView(id, "all"))
    .filter((v): v is ObjectView => v !== null);
}

/** Draws the GM board centred on `[x, y]` at `zoom`, with `selection` selected. */
function render(
  table: Table,
  x: number,
  y: number,
  zoom = ZOOM,
  selection: ObjectId[] = [],
): RecordingContext {
  const ctx = new RecordingContext();
  const renderer = createCanvas2DRenderer<FaceScene>(ctx, {
    images: new ImageCache({ resolve: (p) => `/assets/${p}` }),
    drawItem: drawFaceItem,
    cullBounds: faceCullBounds,
  });
  const scene = buildFaceScene(
    { views: views(table), covers: [], board: "gm_board", viewer: { type: "gm" }, selection },
    { faceState: createFaceStateStore() },
  );
  const camera: Camera = { x, y, zoom };
  renderer.render(scene, [], camera, VIEWPORT);
  return ctx;
}

const texts = (ctx: RecordingContext) =>
  ctx.paints.filter((c) => c.name === "fillText").map((c) => c.args[0] as string);

/** The on-screen box of a face rect of an object anchored at `anchor`, camera at `center`. */
function screenBox(rect: Rect, anchor: [number, number], center: [number, number], zoom = ZOOM) {
  const s = UNIT_PX * zoom;
  const left = VIEWPORT.width / 2 + (anchor[0] + rect[0] - center[0]) * s;
  const top = VIEWPORT.height / 2 + (anchor[1] + rect[1] - center[1]) * s;
  return { minX: left, minY: top, maxX: left + rect[2] * s, maxY: top + rect[3] * s };
}

/** The fillText calls whose painted box sits inside `box` (1 px slack). */
function textsIn(ctx: RecordingContext, box: ReturnType<typeof screenBox>): RecordedCall[] {
  return ctx.paints.filter((c) => {
    const e = c.extent;
    if (c.name !== "fillText" || !e) return false;
    const cx = (e.minX + e.maxX) / 2;
    const cy = (e.minY + e.maxY) / 2;
    return cx >= box.minX - 1 && cx <= box.maxX + 1 && cy >= box.minY - 1 && cy <= box.maxY + 1;
  });
}

const faceRect = (table: Table, id: ObjectId, cell: string): Rect => {
  const e = table.store
    .getObject(id)
    ?.face?.elements.find((el) => el.type === "value" && el.cell === cell);
  if (!e) throw new Error(`${id} has no value ${cell}`);
  return [...e.rect] as Rect;
};

describe("stocked faces at zoom 0.5 (M6-D16)", () => {
  test("a spawned goblin with hit true draws its HIT badge, name and hp", () => {
    const { table, goblin } = placed();
    const ctx = render(table, 0, 0);
    const drawn = texts(ctx);
    expect(drawn).toContain("Goblin");
    expect(drawn).toContain("7");
    // The badge's text, however the 0.5 × 0.3 rect fits it, is painted inside the rect.
    const badge = textsIn(ctx, screenBox(faceRect(table, goblin, "hit"), [0, 0], [0, 0]));
    expect(badge.length).toBe(1);
    const badgeText = String(badge[0]?.args[0] ?? "");
    expect(badgeText).not.toBe("");
    expect("true".startsWith(badgeText.replace(/…$/, ""))).toBe(true);
  });

  test("the badge is the only goblin text that disappears when hit is false", () => {
    const { table, goblin } = placed();
    const result = table.store.transact({ type: "gm" }, { kind: "edit", label: "miss" }, (tx) =>
      writeValue(tx, goblin, "hit", { type: "boolean", value: false }),
    );
    expect(result.ok).toBe(true);
    const ctx = render(table, 0, 0);
    expect(textsIn(ctx, screenBox(faceRect(table, goblin, "hit"), [0, 0], [0, 0]))).toEqual([]);
    expect(texts(ctx)).toContain("Goblin");
  });

  test("a spawned character draws its name and hp", () => {
    const { table, aldric } = placed();
    const drawn = texts(render(table, 20, 0, ZOOM, [aldric]));
    expect(drawn).toContain("Aldric");
    expect(drawn).toContain("9");
    // The binder's collapsed row in Aldric's list (shown while he is selected, M6-D12)
    // still reads its literal name.
    expect(drawn).toContain("Binder");
  });

  test("a spawned character's binder header draws the character's name", () => {
    const { table, binder } = placed();
    // Drag the binder out of Aldric's list onto the board at [40, 0]: its full face draws.
    const result = table.store.transact({ type: "gm" }, { kind: "edit", label: "out" }, (tx) =>
      move(tx, binder, { type: "board", board: "gm_board", position: [40, 0] }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const ctx = render(table, 40, 0);
    const header = textsIn(ctx, screenBox(faceRect(table, binder, "owner"), [40, 0], [40, 0])).map(
      (c) => c.args[0],
    );
    expect(header).toEqual(["Aldric"]);
    expect(texts(ctx)).not.toContain("Binder");
  });

  test("at the minimum zoom the HIT badge draws at the persistent-text floor (vtt-qf5.61)", () => {
    const { table, goblin } = placed();
    const ctx = render(table, 0, 0, MIN_ZOOM);
    const box = screenBox(faceRect(table, goblin, "hit"), [0, 0], [0, 0], MIN_ZOOM);
    // The rect is 1 × 0.6 px on screen here; the badge is magnified about its centre.
    const badge = textsIn(ctx, box).filter((c) => {
      const t = String(c.args[0]).replace(/…$/, "");
      return t !== "" && "true".startsWith(t);
    });
    expect(badge.length, texts(ctx).join(", ")).toBe(1);
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(badge[0]?.style?.font ?? "")?.[1]);
    expect(px).toBeGreaterThanOrEqual(PERSISTENT_TEXT_MIN_PX);
    // Magnified, not cut: the whole word fits, as it does at any zoom.
    expect(badge[0]?.args[0]).toBe("true");
  });
});
