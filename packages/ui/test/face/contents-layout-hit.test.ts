// @vitest-environment node
/**
 * Grid and fan contents layouts (vtt-qf5.28; DESIGN.md §4.6 contents
 * `layout`, §4.7; M6-D30) through the face model, hit testing and drop
 * resolution: each tile and card hit-tests as its entry (the topmost card
 * where fan cards overlap), drops insert at the slot under the pointer or
 * append, expanded entries stay in their slots, and the default stays the
 * M5 list.
 */
import type {
  ActionStateView,
  Cover,
  FaceElementView,
  FaceView,
  ObjectView,
  Viewer,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import type { ObjectId, Point, Rect, Shape } from "@vtt/schema";
import {
  type Affine,
  apply,
  buildFaceScene,
  type Camera,
  type ContentsPrimitive,
  compose,
  createFaceStateStore,
  dropTargetAt,
  entrySlotTransform,
  entryTransform,
  type FaceDrawing,
  type FaceEntry,
  type FaceScene,
  type FaceStateStore,
  faceFocusTargets,
  faceHitAt,
  fanSlots,
  gridSlots,
  IDENTITY,
  invert as invertAffine,
  stepFaceFocus,
  tileParts,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const BOARD = "main";
const GM: Viewer = { type: "gm" };
const CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });

interface Spec {
  shape?: Shape | null;
  cells?: Record<string, WireResult>;
  actions?: string[];
  states?: ActionStateView[];
  face?: FaceView;
  template?: boolean;
  contents?: string[];
  at?: [number, number];
  rotation?: number;
  z?: number;
  container?: string;
  faceUp?: boolean;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {};
  cells.name = { value: text(id), kind: "literal" };
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: "literal" };
  }
  cells.face_up = { value: bool(s.faceUp ?? true), kind: "literal" };
  if (s.shape) cells.shape = { value: { type: "shape", shape: s.shape }, kind: "literal" };
  if (s.contents) {
    cells.contents = { value: { type: "list", items: s.contents.map(ref) }, kind: "structural" };
  }
  if (s.at) {
    cells.board = { value: ref(BOARD), kind: "literal" };
    cells.position = {
      value: { type: "list", items: [num(s.at[0]), num(s.at[1])] },
      kind: "literal",
    };
    cells.container = { value: EMPTY, kind: "structural" };
  }
  if (s.container) cells.container = { value: ref(s.container), kind: "structural" };
  if (s.rotation !== undefined) cells.rotation = { value: num(s.rotation), kind: "literal" };
  if (s.z !== undefined) cells.z = { value: num(s.z), kind: "literal" };
  const view: ObjectView = {
    id,
    is_template: s.template ?? false,
    is_character: false,
    cells,
    actions: (s.actions ?? []).map((name) => ({ name })),
    action_states:
      s.states ?? (s.actions ?? []).map((name) => ({ name, enabled: true }) as ActionStateView),
  };
  if (s.face) view.face = s.face;
  return view;
}

type ElementExtra = Partial<FaceElementView> & Record<string, unknown>;
const value = (cell: string, r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "value", cell, rect: r, index, shown: true, ...extra }) as FaceElementView;
const button = (action: string, r: Rect, index: number) =>
  ({ type: "button", action, rect: r, index, shown: true }) as FaceElementView;
const contents = (r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "contents", rect: r, index, shown: true, ...extra }) as FaceElementView;

/**
 * The face scene with `selection` selected: a faceless container's default
 * list shows only while it is selected (M6-D12).
 */
function scene(
  views: ObjectView[],
  faceState: FaceStateStore = createFaceStateStore(),
  covers: Cover[] = [],
  selection: ObjectId[] = [],
): FaceScene {
  return buildFaceScene({ views, covers, board: BOARD, viewer: GM, selection }, { faceState });
}

function contentsOf(d: FaceDrawing | null | undefined): ContentsPrimitive {
  const c = d?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
  if (!c) throw new Error("no contents primitive");
  return c;
}

/** Board → the frame of the board object `id`. */
const boardOf = (s: FaceScene, id: string): Affine => {
  const t = s.transforms.get(id);
  if (!t) throw new Error(`no transform ${id}`);
  return t;
};

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];

const CARDS = ["c0", "c1", "c2", "c3", "c4"];
/** A hand at the origin: a 10 × 4 rect with a contents element over its lower part. */
function hand(layout: string | undefined, faceState?: FaceStateStore, ids = CARDS): FaceScene {
  const extra = layout === undefined ? {} : { layout };
  const views = [
    mk("hand", {
      shape: rect(10, 4),
      at: [0, 0],
      contents: ids,
      face: { elements: [contents([-5, -1, 10, 3], 0, extra)] },
    }),
    ...ids.map((id) =>
      mk(id, {
        shape: rect(2.5, 3.5),
        container: "hand",
        face: { elements: [value("name", [-1, -1.5, 2, 0.5], 0)] },
      }),
    ),
  ];
  return scene(views, faceState);
}
/** Element-local (slot frame) point `q` of entry `e` → board. */
const boardPoint = (s: FaceScene, c: ContentsPrimitive, e: FaceEntry, q: Point): Point =>
  apply(compose(boardOf(s, "hand"), entrySlotTransform(c, e)), q);

describe("the default stays the M5 list", () => {
  test("no layout and layout list draw the same rows", () => {
    const plain = contentsOf(hand(undefined).faces.get("hand"));
    const list = contentsOf(hand("list").faces.get("hand"));
    expect(plain.layout).toBe("list");
    expect(list).toEqual(plain);
    // Rows the element's width, stacked.
    expect(plain.entries.map((e) => e.row)).toEqual(CARDS.map((_, i) => [0, i * 1, 10, 1] as Rect));
    expect(plain.entries.every((e) => e.slot === undefined)).toBe(true);
  });
});

describe("grid", () => {
  test("tiles on gridSlots, in rows within the element's rect, not scrolled", () => {
    const c = contentsOf(hand("grid").faces.get("hand"));
    expect(c.layout).toBe("grid");
    expect(c.maxOffset).toBe(0);
    const slots = gridSlots([-5, -1, 10, 3], CARDS.length);
    expect(c.entries.map((e) => e.row)).toEqual(slots.map((s) => s.rect));
    expect(c.entries.map((e) => e.chevron)).toEqual(slots.map((s) => tileParts(s.rect).chevron));
    expect(c.entries.every((e) => e.slot === undefined)).toBe(true);
    // Four to a row in a 10-wide element: the fifth starts the second row.
    expect(c.entries.map((e) => e.row[1] > 0)).toEqual([false, false, false, false, true]);
  });

  test("each tile hit-tests as its entry, its chevron as the chevron", () => {
    const s = hand("grid");
    const c = contentsOf(s.faces.get("hand"));
    for (const e of c.entries.slice(0, 4)) {
      const body = tileParts(e.row).body;
      const hit = faceHitAt(s, boardPoint(s, c, e, centre(body)), CAMERA);
      expect(hit?.target).toEqual({ type: "entry", id: e.id, container: "hand", element: 0 });
      expect(hit?.object).toBe(e.id);
      const chev = faceHitAt(s, boardPoint(s, c, e, centre(e.chevron)), CAMERA);
      expect(chev?.target).toEqual({ type: "chevron", id: e.id });
    }
  });

  test("a gap between tiles is the list, and a drop there appends; on a tile it inserts there", () => {
    const s = hand("grid");
    const c = contentsOf(s.faces.get("hand"));
    const [a, b] = c.entries as [FaceEntry, FaceEntry];
    const gap: Point = [(a.row[0] + a.row[2] + b.row[0]) / 2, centre(a.row)[1]];
    expect(faceHitAt(s, boardPoint(s, c, a, gap), CAMERA)?.target).toEqual({
      type: "contents",
      container: "hand",
      element: 0,
      index: 5,
    });
    expect(dropTargetAt(s, boardPoint(s, c, a, gap), CAMERA, ["x"])).toEqual({
      kind: "contents",
      container: "hand",
      element: 0,
      index: 5,
    });
    const third = c.entries[2] as FaceEntry;
    expect(dropTargetAt(s, boardPoint(s, c, third, centre(third.row)), CAMERA, ["x"])).toEqual({
      kind: "contents",
      container: "hand",
      element: 0,
      index: 2,
    });
  });

  test("an expanded entry stays in its tile: its full drawing fitted in the body, hit there", () => {
    const fs = createFaceStateStore();
    fs.expand("c1");
    const s = hand("grid", fs);
    const c = contentsOf(s.faces.get("hand"));
    const before = contentsOf(hand("grid").faces.get("hand"));
    const e = c.entries[1] as FaceEntry;
    expect(e.expanded).toBe(true);
    expect(c.entries.map((x) => x.row)).toEqual(before.entries.map((x) => x.row));
    // The child's frame (its 2.5 × 3.5 card) lies inside the tile's body.
    const body = tileParts(e.row).body;
    const toElement = compose([1, 0, 0, 1, 5, 1], entryTransform(c, e));
    const [x0, y0] = apply(toElement, [-1.25, -1.75]);
    const [x1, y1] = apply(toElement, [1.25, 1.75]);
    expect(x0).toBeGreaterThanOrEqual(body[0] - 1e-9);
    expect(y0).toBeGreaterThanOrEqual(body[1] - 1e-9);
    expect(x1).toBeLessThanOrEqual(body[0] + body[2] + 1e-9);
    expect(y1).toBeLessThanOrEqual(body[1] + body[3] + 1e-9);
    // Its value element is hit on the child.
    const p = apply(compose(boardOf(s, "hand"), entryTransform(c, e)), [0, -1.25]);
    expect(faceHitAt(s, p, CAMERA)).toMatchObject({
      object: "c1",
      target: { type: "value", cell: "name" },
    });
  });
});

describe("fan", () => {
  test("cards on fanSlots: one upright rect each turned about the common pivot", () => {
    const c = contentsOf(hand("fan").faces.get("hand"));
    expect(c.layout).toBe("fan");
    expect(c.maxOffset).toBe(0);
    const slots = fanSlots([-5, -1, 10, 3], CARDS.length);
    expect(c.entries.map((e) => e.row)).toEqual(slots.map((s) => s.rect));
    expect(c.entries.map((e) => e.slot)).toEqual(slots.map((s) => s.turn));
    expect(c.entries[2]?.slot).toEqual(IDENTITY);
  });

  test("a hand drawn as a fan hit-tests each card, the topmost where they overlap", () => {
    const s = hand("fan");
    const c = contentsOf(s.faces.get("hand"));
    for (const e of c.entries) {
      // Its left edge strip shows past the card below; the cards to its right cover the rest.
      const [x, y, w, h] = e.row;
      const visible: Point = [x + w * 0.1, y + h * 0.6];
      expect(faceHitAt(s, boardPoint(s, c, e, visible), CAMERA)?.target).toEqual({
        type: "entry",
        id: e.id,
        container: "hand",
        element: 0,
      });
    }
    // Card 1's right part, mid-height, lies under card 2 (to its right, on top): it is card 2's.
    const [one, two] = [c.entries[1] as FaceEntry, c.entries[2] as FaceEntry];
    const p = boardPoint(s, c, one, [one.row[0] + one.row[2] * 0.9, centre(one.row)[1]]);
    const inTwo = apply(invertAffine(compose(boardOf(s, "hand"), entrySlotTransform(c, two))), p);
    expect(inTwo[0]).toBeGreaterThan(two.row[0]);
    expect(faceHitAt(s, p, CAMERA)?.target).toMatchObject({ type: "entry", id: "c2" });
    // The last card is wholly on top: its centre is its own.
    const last = c.entries[4] as FaceEntry;
    expect(faceHitAt(s, boardPoint(s, c, last, centre(last.row)), CAMERA)?.target).toMatchObject({
      id: "c4",
    });
  });

  test("a card's chevron hits through its turn; its hit rect is the turned box", () => {
    const s = hand("fan");
    const c = contentsOf(s.faces.get("hand"));
    const first = c.entries[0] as FaceEntry;
    const hit = faceHitAt(s, boardPoint(s, c, first, centre(first.chevron)), CAMERA);
    expect(hit?.target).toEqual({ type: "chevron", id: "c0" });
    const [cx, cy] = boardPoint(s, c, first, centre(first.chevron));
    expect(hit?.rect.minX).toBeLessThan(cx);
    expect(hit?.rect.maxX).toBeGreaterThan(cx);
    expect(hit?.rect.minY).toBeLessThan(cy);
    expect(hit?.rect.maxY).toBeGreaterThan(cy);
  });

  test("a drop on a card inserts at its index (the topmost card); off the cards it appends", () => {
    const s = hand("fan");
    const c = contentsOf(s.faces.get("hand"));
    const one = c.entries[1] as FaceEntry;
    const under = boardPoint(s, c, one, [one.row[0] + one.row[2] * 0.9, centre(one.row)[1]]);
    expect(dropTargetAt(s, under, CAMERA, ["x"])).toMatchObject({
      kind: "contents",
      index: 2,
    });
    const first = c.entries[0] as FaceEntry;
    const [x, y, , h] = first.row;
    expect(
      dropTargetAt(s, boardPoint(s, c, first, [x + 0.02, y + h / 2]), CAMERA, ["x"]),
    ).toMatchObject({
      index: 0,
    });
    // The element's top-left corner holds no card.
    expect(dropTargetAt(s, [-4.99, -0.99], CAMERA, ["x"])).toEqual({
      kind: "contents",
      container: "hand",
      element: 0,
      index: 5,
    });
  });

  test("an expanded card keeps its slot; its drawing turns with it", () => {
    const fs = createFaceStateStore();
    fs.expand("c0");
    const s = hand("fan", fs);
    const c = contentsOf(s.faces.get("hand"));
    const e = c.entries[0] as FaceEntry;
    expect(e.expanded).toBe(true);
    expect(e.slot).toEqual(contentsOf(hand("fan").faces.get("hand")).entries[0]?.slot);
    // The transform carries the card's rotation.
    expect(entryTransform(c, e)[1]).toBeLessThan(0);
  });

  test("keyboard focus visits each card's chevron at its turned place", () => {
    const s = hand("fan");
    const targets = faceFocusTargets(s, "hand", CAMERA).filter(
      (t) => t.hit.target.type === "chevron",
    );
    expect(targets.map((t) => (t.hit.target as { id: string }).id)).toEqual(CARDS);
    const c = contentsOf(s.faces.get("hand"));
    const first = c.entries[0] as FaceEntry;
    const [cx, cy] = boardPoint(s, c, first, centre(first.chevron));
    const r = targets[0]?.hit.rect;
    expect(r && r.minX <= cx && cx <= r.maxX && r.minY <= cy && cy <= r.maxY).toBe(true);
  });
});

describe("keyboard focus in an overflowing grid", () => {
  test("Tab rings only the tiles inside the rect; a clipped tile's chevron and buttons are skipped", () => {
    const fs = createFaceStateStore();
    // The fifth tile (below the 10 × 3 rect) and the first are expanded, each showing a button.
    fs.expand("c0");
    fs.expand("c4");
    const views = [
      mk("hand", {
        shape: rect(10, 4),
        at: [0, 0],
        contents: CARDS,
        face: { elements: [contents([-5, -1, 10, 3], 0, { layout: "grid" })] },
      }),
      ...CARDS.map((id) =>
        mk(id, {
          shape: rect(2.5, 3.5),
          container: "hand",
          actions: ["Play"],
          face: { elements: [button("Play", [-1, 0, 2, 0.6], 0)] },
        }),
      ),
    ];
    const s = scene(views, fs);
    const c = contentsOf(s.faces.get("hand"));
    expect((c.entries[4] as FaceEntry).row[1]).toBeGreaterThan(3);
    const targets = faceFocusTargets(s, "hand", CAMERA);
    const named = targets.map((t) => `${t.hit.target.type}:${t.hit.object}`);
    expect(named).toEqual(["chevron:c0", "button:c0", "chevron:c1", "chevron:c2", "chevron:c3"]);
    // Tab from the last wraps to the first, never reaching c4.
    let focus = stepFaceFocus(targets, "hand", null, false);
    const seen: string[] = [];
    for (let i = 0; i < targets.length + 1; i++) {
      const t = targets.find((x) => x.key === focus?.key);
      seen.push(`${t?.hit.target.type}:${t?.hit.object}`);
      focus = stepFaceFocus(targets, "hand", focus, false);
    }
    expect(seen).toEqual([...named, "chevron:c0"]);
  });

  test("a list still offers rows below its rect (it scrolls to reveal them)", () => {
    const s = hand(undefined);
    const chevrons = faceFocusTargets(s, "hand", CAMERA).filter(
      (t) => t.hit.target.type === "chevron",
    );
    expect(chevrons).toHaveLength(5);
    expect(chevrons[4]?.reveal[0]?.offset).toBeGreaterThan(0);
  });
});
