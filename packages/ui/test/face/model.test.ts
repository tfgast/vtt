// @vitest-environment node
import { stockedTableSnapshot, Table, ViewBuilder } from "@vtt/authority";
import type {
  ActionStateView,
  FaceElementView,
  FaceView,
  ObjectView,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import { type Bounds, COLLAPSED_FRAME, type Point, type Rect, type Shape } from "@vtt/schema";
import {
  aabb,
  apply,
  type ButtonPrimitive,
  buildScene,
  type ContentsPrimitive,
  compose,
  contentsRect,
  createFaceStateStore,
  DEFAULT_CONTENTS_ELEMENT,
  drawItemFor,
  entryTransform,
  type FaceDrawing,
  type FacePrimitive,
  type FaceStateStore,
  faceBaseItem,
  type InkPrimitive,
  itemTransform,
  presentationBounds,
  resolveFace,
  revealOffset,
  screenHeight,
  type TextPrimitive,
  translate,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// View builders

const BOARD = "main";
const text = (value: string): WireValue => ({ type: "text", value });
const num = (value: number): WireValue => ({ type: "number", value });
const bool = (value: boolean): WireValue => ({ type: "boolean", value });
const ref = (object: string): WireValue => ({ type: "ref", object });
const EMPTY: WireResult = { type: "empty" };
const ink = (...strokes: Point[][]): WireValue => ({ type: "ink", strokes });
const rect = (width: number, height: number): Shape => ({ type: "rect", width, height });
const circle = (radius: number): Shape => ({ type: "circle", radius });

interface Spec {
  shape?: Shape | null;
  cells?: Record<string, WireResult>;
  actions?: string[];
  states?: ActionStateView[];
  face?: FaceView;
  template?: boolean;
  contents?: (string | null)[];
  at?: [number, number];
  rotation?: number;
  container?: string;
}

function mk(id: string, s: Spec = {}): ObjectView {
  const cells: ObjectView["cells"] = {};
  for (const [name, value] of Object.entries(s.cells ?? {})) {
    cells[name] = { value, kind: "literal" };
  }
  if (s.shape) cells.shape = { value: { type: "shape", shape: s.shape }, kind: "literal" };
  if (s.contents) {
    cells.contents = {
      value: {
        type: "list",
        items: s.contents.map((c) => (c === null ? { type: "redacted" } : ref(c))),
      },
      kind: "structural",
    };
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
const editor = (cell: string, r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "editor", cell, rect: r, index, shown: true, ...extra }) as FaceElementView;
const button = (action: string, r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "button", action, rect: r, index, shown: true, ...extra }) as FaceElementView;
const contents = (r: Rect, index: number, extra: ElementExtra = {}) =>
  ({ type: "contents", rect: r, index, shown: true, ...extra }) as FaceElementView;

function lookup(...views: ObjectView[]) {
  const map = new Map(views.map((v) => [v.id, v]));
  return (id: string) => map.get(id) ?? null;
}

/**
 * `view`'s face with every object revealed, as if selected: a faceless
 * object's default list shows only then (M6-D12).
 */
function resolve(
  view: ObjectView,
  others: ObjectView[] = [],
  faceState: FaceStateStore = createFaceStateStore(),
  list: "full" | "collapsed" = "full",
  gm = true,
): FaceDrawing {
  return resolveFace(view, {
    views: lookup(view, ...others),
    faceState,
    list,
    gm,
    revealed: () => true,
  });
}

const kinds = (d: FaceDrawing) => d.primitives.map((p) => p.kind);
const only = <K extends FacePrimitive["kind"]>(d: FaceDrawing, kind: K) =>
  d.primitives.filter((p): p is Extract<FacePrimitive, { kind: K }> => p.kind === kind);
const contentsOf = (d: FaceDrawing): ContentsPrimitive => {
  const c = only(d, "contents")[0];
  if (!c) throw new Error("no contents primitive");
  return c;
};
const closeAll = (a: readonly number[], b: readonly number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => {
    expect(x).toBeCloseTo(b[i] as number, 9);
  });
};
const inside = (inner: Bounds, outer: Bounds) => {
  const eps = 1e-9;
  expect(inner.minX).toBeGreaterThanOrEqual(outer.minX - eps);
  expect(inner.minY).toBeGreaterThanOrEqual(outer.minY - eps);
  expect(inner.maxX).toBeLessThanOrEqual(outer.maxX + eps);
  expect(inner.maxY).toBeLessThanOrEqual(outer.maxY + eps);
};

// ---------------------------------------------------------------------------
// The Attack card (DESIGN.md §4.6 Face layouts), after Roll: `roll` is set.

const attackFace: FaceView = {
  elements: [
    value("name", [-1.2, -1.7, 2.4, 0.4], 0, { style: { size: "large" } }),
    editor("target", [-1.2, -1.2, 2.4, 0.4], 1, { style: { caption: true } }),
    value("total", [-1.2, -0.7, 1.1, 0.5], 2, { style: { caption: true } }),
    value("hit", [0.1, -0.7, 1.1, 0.5], 3, { style: { caption: true } }),
    value("dmg", [-1.2, -0.1, 2.4, 0.4], 4, { style: { caption: true } }),
    button("Roll", [-1.2, 0.5, 1.1, 0.45], 5, {
      show_when: "roll = empty",
      shown: false,
      reason: "show_when_false",
    }),
    button("Roll damage", [0.1, 0.5, 1.1, 0.45], 6, { show_when: "hit and dmg = empty" }),
    button("Apply", [-1.2, 1.1, 2.4, 0.45], 7, { show_when: "not applied" }),
  ],
  default_action: "Roll",
};

const goblin = mk("goblin", { cells: { name: text("Goblin") }, at: [4, 4], shape: circle(0.5) });
const attack = mk("attack", {
  shape: rect(2.5, 3.5),
  at: [0, 0],
  cells: {
    name: text("Attack"),
    target: ref("goblin"),
    roll: num(15),
    total: num(19),
    hit: bool(true),
    dmg: EMPTY,
    applied: bool(false),
  },
  actions: ["Roll", "Roll damage", "Apply"],
  states: [
    { name: "Roll", enabled: false, reason: "when_false" },
    { name: "Roll damage", enabled: true },
    { name: "Apply", enabled: false, reason: "when_false" },
  ],
  face: attackFace,
});

describe("resolveFace: a layout", () => {
  test("the Attack card: elements in order by index, hidden ones absent, buttons from action_states", () => {
    const d = resolve(attack, [goblin]);
    expect(d.base).toBeNull();
    expect(d.frame).toEqual([-1.25, -1.75, 2.5, 3.5]);
    expect(d.primitives.map((p) => p.element)).toEqual([0, 1, 2, 3, 4, 6, 7]);
    expect(kinds(d)).toEqual(["text", "editor", "text", "text", "text", "button", "button"]);

    const [rollDamage, apply] = only(d, "button");
    expect(rollDamage).toMatchObject({
      action: "Roll damage",
      label: "Roll damage",
      enabled: true,
      template: false,
      rect: [0.1, 0.5, 1.1, 0.45],
      target: { type: "button", action: "Roll damage", enabled: true, template: false },
    });
    expect(rollDamage?.reason).toBeUndefined();
    expect(apply).toMatchObject({ action: "Apply", enabled: false, reason: "when_false" });
    expect(apply?.target).toEqual({
      type: "button",
      action: "Apply",
      enabled: false,
      reason: "when_false",
      template: false,
    });
  });

  test("cell elements: compact text, tone, style and caption; editors carry the cell", () => {
    const d = resolve(attack, [goblin]);
    const [name, total, hit, dmg] = only(d, "text");
    expect(name).toMatchObject({ text: "Attack", tone: "normal", size: "large", align: "center" });
    expect(name?.caption).toBeUndefined();
    expect(name?.target).toEqual({ type: "value", cell: "name" });
    expect(total).toMatchObject({ text: "19", caption: "total", size: "normal" });
    expect(hit).toMatchObject({ text: "true", caption: "hit" });
    expect(dmg).toMatchObject({ text: "", tone: "muted" });
    const [target] = only(d, "editor");
    expect(target).toMatchObject({
      cell: "target",
      text: "Goblin",
      tone: "normal",
      caption: "target",
      target: { type: "editor", cell: "target" },
    });
  });

  test("min_size becomes minSize (0 when absent)", () => {
    const v = mk("t", {
      shape: circle(0.5),
      cells: { name: text("T") },
      face: {
        elements: [value("name", [-0.8, 0.55, 1.6, 0.3], 0, { min_size: 12 })],
      },
    });
    expect(resolve(v).primitives[0]?.minSize).toBe(12);
    expect(resolve(attack, [goblin]).primitives[0]?.minSize).toBe(0);
  });

  test("an image cell is an image primitive, an ink value an ink primitive", () => {
    const token = mk("tok", {
      shape: circle(0.5),
      cells: { name: text("Tok"), image: text("assets/tok.png") },
      face: { elements: [value("image", [-0.5, -0.5, 1, 1], 0)] },
    });
    const [img] = resolve(token).primitives;
    expect(img).toMatchObject({
      kind: "image",
      path: "assets/tok.png",
      rect: [-0.5, -0.5, 1, 1],
      element: 0,
      target: { type: "value", cell: "image" },
    });

    const strokes: Point[][] = [
      [
        [0, 0],
        [0.5, 0.5],
      ],
    ];
    const note = mk("note", {
      shape: rect(2, 2),
      cells: { name: text("Note"), ink: ink(...strokes) },
      face: { elements: [value("ink", [-1, -1, 2, 2], 0)] },
    });
    const [line] = resolve(note).primitives;
    expect(line).toMatchObject({ kind: "ink", strokes, target: { type: "value", cell: "ink" } });
  });

  test("bounds are the union of the frame and every primitive", () => {
    const v = mk("c", {
      shape: rect(2, 2),
      actions: ["Go"],
      face: { elements: [button("Go", [-1, 1.2, 2, 0.5], 0)] },
    });
    expect(resolve(v).bounds).toEqual([-1, -1, 2, 2.7]);
  });
});

// ---------------------------------------------------------------------------
// Contents elements

describe("resolveFace: contents elements", () => {
  const tplA = mk("tpl_a", { shape: rect(2.5, 3.5), template: true, cells: { name: text("A") } });
  const cardB = mk("card_b", { shape: rect(2.5, 3.5), cells: { name: text("B") } });
  const binderFace: FaceView = {
    elements: [value("name", [-3, -4.8, 6, 0.6], 0), contents([-3, -4, 6, 8], 1)],
  };
  const binder = mk("binder", {
    shape: rect(7, 10),
    at: [0, 0],
    // A character view: face_up is sent (absent, a character would fail closed to face down).
    cells: { name: text("Binder"), face_up: bool(true) },
    contents: ["tpl_a", null, "card_b"],
    face: binderFace,
  });

  test("rows, chevrons, the template's gear and the redacted entry hidden", () => {
    const c = contentsOf(resolve(binder, [tplA, cardB], undefined, "full", false));
    expect(c.element).toBe(1);
    expect(c.rect).toEqual([-3, -4, 6, 8]);
    expect(c.offset).toBe(0);
    expect(c.maxOffset).toBe(0);
    expect(c.target).toEqual({ type: "contents", container: "binder", element: 1, index: 3 });
    expect(c.entries.map((e) => e.id)).toEqual(["tpl_a", null, "card_b"]);

    const [a, hidden, b] = c.entries;
    closeAll(a?.row ?? [], [0, 0, 6, 0.6]);
    closeAll(a?.chevron ?? [], [0, 0, 0.6, 0.6]);
    expect(a).toMatchObject({ expanded: false, list: "collapsed", template: true });
    expect(a?.gear).toBeDefined();
    const g = a?.gear as Rect;
    expect(g[0] + g[2]).toBeLessThanOrEqual(6 + 1e-9);
    expect(g[1]).toBeGreaterThanOrEqual(0);
    expect(g[1] + g[3]).toBeLessThanOrEqual(0.6 + 1e-9);

    expect(hidden).toMatchObject({ id: null, drawing: null, template: false, expanded: false });
    closeAll(hidden?.row ?? [], [0, 0.6, 6, 0.6]);

    closeAll(b?.row ?? [], [0, 1.2, 6, 0.6]);
    expect(b?.gear).toBeUndefined();
    expect(b?.template).toBe(false);
  });

  test("a collapsed entry is the default collapsed face: its name filling COLLAPSED_FRAME, no base", () => {
    const c = contentsOf(resolve(binder, [tplA, cardB]));
    const d = c.entries[0]?.drawing as FaceDrawing;
    expect(d.base).toBeNull();
    expect(d.frame).toEqual([...COLLAPSED_FRAME]);
    expect(d.primitives).toHaveLength(1);
    expect(d.primitives[0]).toMatchObject({
      kind: "text",
      text: "A",
      rect: [...COLLAPSED_FRAME],
      element: null,
      target: { type: "body" },
    });
    // The collapsed frame is scaled to the row width minus the chevron, top-left aligned.
    const t = c.entries[0]?.transform;
    if (!t) throw new Error("no transform");
    closeAll(apply(t, [0, 0]), [-3 + 0.6, -4]);
    closeAll(apply(t, [6, 0]), [3, -4]);
  });

  test("a missing entry (no view) keeps its id and is hidden", () => {
    const c = contentsOf(resolve(binder, [tplA]));
    expect(c.entries[2]).toMatchObject({ id: "card_b", drawing: null });
  });

  test("an expanded entry's transform scales the child to the row width", () => {
    const fs = createFaceStateStore();
    fs.toggle("card_b");
    const c = contentsOf(resolve(binder, [tplA, cardB], fs));
    const b = c.entries[2];
    if (!b?.drawing) throw new Error("no drawing");
    expect(b).toMatchObject({ expanded: true, list: "full" });
    // A faceless card: its bounds are its frame, scaled by 5.4 / 2.5.
    expect(b.drawing.bounds).toEqual([-1.25, -1.75, 2.5, 3.5]);
    const s = 5.4 / 2.5;
    closeAll(b.row, [0, 1.2, 6, 3.5 * s]);
    closeAll(apply(b.transform, [-1.25, -1.75]), [-3 + 0.6, -4 + 1.2]);
    closeAll(apply(b.transform, [1.25, 1.75]), [3, -4 + 1.2 + 3.5 * s]);
    // The base is the board drawing at the origin.
    expect(b.drawing.base).toMatchObject({ id: "card_b", anchor: [0, 0], rotation: 0 });
  });

  test("template entries get a gear when expanded too", () => {
    const fs = createFaceStateStore();
    fs.expand("tpl_a");
    const c = contentsOf(resolve(binder, [tplA, cardB], fs));
    expect(c.entries[0]?.expanded).toBe(true);
    expect(c.entries[0]?.gear).toBeDefined();
    // The board-template gear is for board objects only.
    expect(only(c.entries[0]?.drawing as FaceDrawing, "gear")).toEqual([]);
  });

  test("entries: 'full' expands by default", () => {
    const v = mk("shelf", {
      shape: rect(7, 10),
      contents: ["card_b"],
      face: { elements: [contents([-3, -4, 6, 8], 0, { entries: "full" })] },
    });
    const c = contentsOf(resolve(v, [cardB]));
    expect(c.entries[0]?.expanded).toBe(true);
  });

  test("a child with a custom collapsed list resolves its value and an enabled button", () => {
    const row = mk("row", {
      shape: rect(2.5, 0.8),
      cells: { name: text("Row"), hp: num(7) },
      actions: ["Roll"],
      face: {
        elements: [],
        collapsed: [value("hp", [0, 0, 3, 0.6], 0), button("Roll", [3, 0, 3, 0.6], 1)],
      },
    });
    const holder = mk("holder", {
      shape: rect(7, 10),
      contents: ["row"],
      face: { elements: [contents([-3, -4, 6, 8], 0)] },
    });
    const d = contentsOf(resolve(holder, [row])).entries[0]?.drawing as FaceDrawing;
    expect(d.frame).toEqual([...COLLAPSED_FRAME]);
    expect(d.base).toBeNull();
    expect(kinds(d)).toEqual(["text", "button"]);
    expect(d.primitives[0]).toMatchObject({
      text: "7",
      element: 0,
      target: { type: "value", cell: "hp" },
    });
    expect(d.primitives[1]).toMatchObject({
      action: "Roll",
      enabled: true,
      element: 1,
      target: { type: "button", action: "Roll", enabled: true, template: false },
    });
  });

  test("a face-down child: collapsed shows its name only; expanded has a base and no primitives", () => {
    const down = mk("down", {
      shape: rect(2.5, 3.5),
      cells: { name: text("Secret"), face_up: bool(false), hp: num(3) },
      face: {
        elements: [value("hp", [0, 0, 1, 1], 0)],
        collapsed: [value("hp", [0, 0, 6, 0.6], 0)],
      },
    });
    const holder = mk("holder", {
      shape: rect(7, 10),
      contents: ["down"],
      face: { elements: [contents([-3, -4, 6, 8], 0)] },
    });
    const collapsed = contentsOf(resolve(holder, [down])).entries[0]?.drawing as FaceDrawing;
    expect(collapsed.primitives).toMatchObject([{ kind: "text", text: "Secret" }]);
    const fs = createFaceStateStore();
    fs.expand("down");
    const expanded = contentsOf(resolve(holder, [down], fs)).entries[0]?.drawing as FaceDrawing;
    expect(expanded.primitives).toEqual([]);
    expect(expanded.base).toMatchObject({ faceDown: true, faceDownGlyph: true, label: "Secret" });
  });
});

// ---------------------------------------------------------------------------
// Nested drawings inside a rotated container

describe("resolveFace: nested drawings in a rotated container", () => {
  const strokes: Point[][] = [
    [
      [-0.5, 0],
      [0.5, 0],
    ],
  ];
  const note = mk("note", {
    shape: rect(2, 2),
    cells: { name: text("Note"), color: text("#fff3a0"), text: text("hi"), ink: ink(...strokes) },
  });
  const token = mk("token", {
    shape: circle(0.5),
    cells: { name: text("Tok"), image: text("assets/tok.png") },
  });
  const card = mk("card", {
    shape: rect(2.5, 3.5),
    cells: { name: text("Card"), face_up: bool(false) },
    face: { elements: [value("name", [-1, -1, 2, 0.5], 0)] },
  });
  const d20 = mk("d20", {
    shape: circle(0.5),
    cells: { name: text("d20"), total: num(12), image: text("x.png") },
    actions: ["Roll"],
    face: {
      elements: [
        value("total", [-0.4, -0.35, 0.8, 0.5], 0, { style: { size: "huge" } }),
        button("Roll", [-0.4, 0.18, 0.8, 0.25], 1, { min_size: 10 }),
      ],
    },
  });
  const shelf = mk("shelf", {
    shape: rect(4, 12),
    at: [10, 0],
    rotation: 90,
    contents: ["note", "token", "card", "d20"],
    face: { elements: [contents([-2, -6, 4, 12], 0, { entries: "full" })] },
  });
  const views = [note, token, card, d20];

  const shelfDrawing = () => resolve(shelf, views);
  const item = drawItemFor(shelf, {
    anchor: [10, 0],
    rotation: 90,
    gm: true,
    formatText: () => "",
  });

  test("an expanded faceless note: base with fill and text, plus its ink over its frame", () => {
    const e = contentsOf(shelfDrawing()).entries[0];
    const d = e?.drawing as FaceDrawing;
    expect(d.base).toMatchObject({ id: "note", fill: "#fff3a0", text: "hi", label: "Note" });
    const inks = only(d, "ink") as InkPrimitive[];
    expect(inks).toHaveLength(1);
    expect(inks[0]).toMatchObject({ strokes, rect: [-1, -1, 2, 2], element: null });
  });

  test("an image token: base with the image", () => {
    const d = contentsOf(shelfDrawing()).entries[1]?.drawing as FaceDrawing;
    expect(d.base).toMatchObject({ id: "token", image: "assets/tok.png" });
    expect(d.primitives).toEqual([]);
  });

  test("a face-down card: the base back and glyph, no primitives", () => {
    const d = contentsOf(shelfDrawing()).entries[2]?.drawing as FaceDrawing;
    expect(d.base).toMatchObject({ faceDown: true, faceDownGlyph: true, fill: null });
    expect(d.primitives).toEqual([]);
  });

  test("a faced child's base has image, text and label cleared", () => {
    const d = contentsOf(shelfDrawing()).entries[3]?.drawing as FaceDrawing;
    expect(d.base?.image).toBeUndefined();
    expect(d.base?.label).toBeUndefined();
    expect(d.base?.fill).not.toBeNull();
  });

  test("entry transforms compose with the container's rotation", () => {
    const c = contentsOf(shelfDrawing());
    const e = c.entries[1];
    if (!e) throw new Error("no entry");
    const boardFromChild = compose(itemTransform(item), entryTransform(c, e));
    const inShelf = apply(e.transform, [0, 0]);
    // Rotated 90° clockwise about the anchor [10, 0]: (x, y) → (10 − y, x).
    closeAll(apply(boardFromChild, [0, 0]), [10 - inShelf[1], inShelf[0]]);
  });

  test("screenHeight of a nested button at two zooms decides its minSize", () => {
    const c = contentsOf(shelfDrawing());
    const e = c.entries[3];
    const d = e?.drawing as FaceDrawing;
    const roll = only(d, "button")[0] as ButtonPrimitive;
    expect(roll.minSize).toBe(10);
    const acc = compose(itemTransform(item), entryTransform(c, e as NonNullable<typeof e>));
    // The die (bounds 1 wide) is scaled to 3.6 units: the button is 0.9 units high.
    const s = 3.6 / 1;
    const at = (zoom: number) => screenHeight(roll.rect, acc, { x: 0, y: 0, zoom });
    expect(at(1 / 8)).toBeCloseTo(0.25 * s * 64 * (1 / 8));
    expect(at(1 / 8) < roll.minSize).toBe(true); // 7.2 px: hidden
    expect(at(1 / 4) >= roll.minSize).toBe(true); // 14.4 px: shown
  });
});

// ---------------------------------------------------------------------------
// Default faces

describe("resolveFace: default faces", () => {
  test("a faceless die with Roll gets a strip of buttons below its frame", () => {
    const die = mk("die", {
      shape: circle(0.5),
      cells: { name: text("d6") },
      actions: ["Roll"],
      states: [{ name: "Roll", enabled: true }],
    });
    const d = resolve(die);
    const [roll] = only(d, "button");
    expect(roll).toMatchObject({
      action: "Roll",
      label: "Roll",
      enabled: true,
      minSize: 12,
      element: null,
      target: { type: "button", action: "Roll", enabled: true, template: false },
    });
    closeAll(roll?.rect ?? [], [-0.75, 0.65, 1.5, 0.45]);
    closeAll(d.bounds, [-0.75, -0.5, 1.5, 1.6]);
  });

  test("strip buttons are 1.5 × 0.45, 0.1 apart, centred under the frame; states read as ?? []", () => {
    const die = mk("die", { shape: rect(2, 1), actions: ["A", "B"] });
    delete die.action_states;
    const buttons = only(resolve(die), "button");
    closeAll(buttons[0]?.rect ?? [], [-1.55, 0.65, 1.5, 0.45]);
    closeAll(buttons[1]?.rect ?? [], [0.05, 0.65, 1.5, 0.45]);
    expect(buttons.map((b) => b.enabled)).toEqual([false, false]);
  });

  test("a faceless shapeless binder with ten entries gets an 8-row list scrolling 1.2 units", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const children = ids.map((id) => mk(id, { shape: rect(2.5, 3.5), cells: { name: text(id) } }));
    const binder = mk("binder", { shape: null, cells: { name: text("B") }, contents: ids });
    const d = resolve(binder, children);
    expect(d.frame).toEqual([-1, -0.5, 2, 1]);
    const c = contentsOf(d);
    expect(c.element).toBe(DEFAULT_CONTENTS_ELEMENT);
    expect(c.minSize).toBe(12);
    closeAll(c.rect, [-3, 0.65, 6, 4.8]);
    expect(c.entries).toHaveLength(10);
    expect(c.entries.every((e) => !e.expanded)).toBe(true);
    expect(c.maxOffset).toBeCloseTo(1.2);
    closeAll(d.bounds, [-3, -0.5, 6, 0.5 + 0.15 + 4.8 + 0.5]);
  });

  test("the contents list sits below the strip", () => {
    const box = mk("box", { shape: rect(2, 2), actions: ["Shuffle"], contents: ["x"] });
    const c = contentsOf(resolve(box, [mk("x", { cells: { name: text("X") } })]));
    closeAll(c.rect, [-3, 1 + 0.15 + 0.45 + 0.15, 6, 0.6]);
  });

  test("the ink cell is an ink primitive over the frame", () => {
    const strokes: Point[][] = [[[0, 0]]];
    const v = mk("n", { shape: rect(2, 2), cells: { ink: ink(...strokes) } });
    expect(resolve(v).primitives).toMatchObject([
      { kind: "ink", strokes, rect: [-1, -1, 2, 2], target: { type: "body" } },
    ]);
  });

  test("a template token on the board has a gear just outside its top-right corner", () => {
    const tok = mk("tok", { shape: circle(0.5), template: true, at: [0, 0] });
    const [gear] = only(resolve(tok), "gear");
    expect(gear).toMatchObject({ id: "tok", minSize: 10, target: { type: "gear", id: "tok" } });
    closeAll(gear?.rect ?? [], [0.5, -0.8, 0.3, 0.3]);
    // Not for a non-template, nor for a template inside a container.
    expect(only(resolve(mk("t2", { shape: circle(0.5), at: [0, 0] })), "gear")).toEqual([]);
    const contained = mk("t3", { shape: circle(0.5), template: true, container: "box" });
    expect(only(resolve(contained), "gear")).toEqual([]);
  });

  test("a face-down board template has the gear only; a face-down nested child has no primitives", () => {
    const tpl = mk("down_tpl", {
      shape: rect(2.5, 3.5),
      template: true,
      at: [0, 0],
      actions: ["Roll"],
      cells: { name: text("Secret"), face_up: bool(false), ink: ink([[0, 0]]) },
      face: { elements: [button("Roll", [-1, 0, 2, 0.5], 0)] },
    });
    const d = resolve(tpl);
    expect(kinds(d)).toEqual(["gear"]);
    expect(d.primitives[0]).toMatchObject({
      id: "down_tpl",
      target: { type: "gear", id: "down_tpl" },
    });
    // Faceless too: no ink, strip or list, only the gear.
    const { face: _face, ...faceless } = tpl;
    expect(kinds(resolve(faceless))).toEqual(["gear"]);

    const holder = mk("holder", {
      shape: rect(7, 10),
      contents: ["down_tpl"],
      face: { elements: [contents([-3, -4, 6, 8], 0)] },
    });
    const fs = createFaceStateStore();
    fs.expand("down_tpl");
    const nested = contentsOf(resolve(holder, [tpl], fs)).entries[0]?.drawing as FaceDrawing;
    expect(nested.primitives).toEqual([]);
    expect(nested.base).toMatchObject({ faceDown: true });
  });

  test("a faced template on the board has a gear too; buttons carry template", () => {
    const tpl = mk("tpl", {
      shape: rect(2, 2),
      template: true,
      at: [0, 0],
      actions: ["Roll"],
      face: { elements: [button("Roll", [-1, 0, 2, 0.5], 0)] },
    });
    const d = resolve(tpl);
    expect(kinds(d)).toEqual(["button", "gear"]);
    expect((d.primitives[0] as ButtonPrimitive).template).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scrolling and reveal

describe("scrolling", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  // A 6 × 1 chip, expanded at 5.4 / 6 = 0.9 scale: 0.9 high.
  const children = ids.map((id) => mk(id, { shape: rect(6, 1), cells: { name: text(id) } }));
  const binder = mk("binder", { shape: null, contents: ids });

  test("the offset shifts rows (entryTransform, contentsRect) and is clamped to [0, maxOffset]", () => {
    const fs = createFaceStateStore();
    fs.setScroll("binder", DEFAULT_CONTENTS_ELEMENT, 0.5);
    const c = contentsOf(resolve(binder, children, fs));
    expect(c.offset).toBe(0.5);
    const e = c.entries[0];
    if (!e) throw new Error("no entry");
    closeAll(apply(entryTransform(c, e), [0, 0]), [-3 + 0.6, 0.65 - 0.5]);
    closeAll(contentsRect(c, e.row), [-3, 0.65 - 0.5, 6, 0.6]);
    fs.setScroll("binder", DEFAULT_CONTENTS_ELEMENT, 5);
    expect(contentsOf(resolve(binder, children, fs)).offset).toBeCloseTo(1.2);
    fs.setScroll("binder", DEFAULT_CONTENTS_ELEMENT, 0);
    expect(contentsOf(resolve(binder, children, fs)).offset).toBe(0);
  });

  test("revealOffset: an entry expanded near the bottom is brought wholly into the rect", () => {
    const fs = createFaceStateStore();
    fs.expand("c8");
    const c = contentsOf(resolve(binder, children, fs));
    const row = c.entries[8]?.row as Rect;
    closeAll(row, [0, 4.8, 6, 0.9]);
    expect(c.maxOffset).toBeCloseTo(9 * 0.6 + 0.9 - 4.8);
    const offset = revealOffset(c, "c8");
    expect(offset).toBeCloseTo(4.8 + 0.9 - 4.8);
    expect(row[1]).toBeGreaterThanOrEqual(offset - 1e-9);
    expect(row[1] + row[3]).toBeLessThanOrEqual(offset + c.rect[3] + 1e-9);
  });

  test("revealOffset keeps a visible row's offset, scrolls up to a row above, ignores unknown ids", () => {
    const fs = createFaceStateStore();
    fs.setScroll("binder", DEFAULT_CONTENTS_ELEMENT, 1);
    const c = contentsOf(resolve(binder, children, fs));
    expect(revealOffset(c, "c3")).toBe(1);
    expect(revealOffset(c, "c0")).toBe(0);
    expect(revealOffset(c, "c1")).toBeCloseTo(0.6);
    expect(revealOffset(c, "nope")).toBe(1);
  });

  test("revealOffset: an expanded sheet taller than its parent's list aligns its top", () => {
    const sheet = mk("sheet", { shape: rect(6, 8), cells: { name: text("Sheet") } });
    const bag = mk("bag", { shape: rect(1, 1), cells: { name: text("Binder") } });
    const character = mk("hero", {
      shape: circle(0.5),
      contents: ["bag", "sheet"],
      face: { elements: [contents([-1.5, 0.9, 3, 1.2], 0, { min_size: 24 })] },
    });
    const fs = createFaceStateStore();
    fs.expand("sheet");
    const c = contentsOf(resolve(character, [sheet, bag], fs));
    expect(c.minSize).toBe(24);
    const row = c.entries[1]?.row as Rect;
    closeAll(row, [0, 0.3, 3, 8 * (2.7 / 6)]);
    expect(row[3]).toBeGreaterThan(c.rect[3]);
    expect(revealOffset(c, "sheet")).toBeCloseTo(0.3);
  });
});

// ---------------------------------------------------------------------------
// The stocked GM binder (DESIGN.md §4.7 Example templates)

describe("the stocked GM binder", () => {
  test("every collapsed entry is a default collapsed drawing of the template's name, with a gear", () => {
    const table = Table.fromSnapshot(stockedTableSnapshot());
    const builder = new ViewBuilder(table, { type: "gm" });
    const views = (id: string) => builder.objectView(id, "all");
    const binder = views("gm_binder");
    if (!binder) throw new Error("no gm_binder");
    const d = resolveFace(binder, {
      views,
      faceState: createFaceStateStore(),
      list: "full",
      gm: true,
    });
    const c = contentsOf(d);
    expect(c.element).toBe(1);
    expect(c.entries).toHaveLength(14);
    for (const e of c.entries) {
      const child = views(e.id as string);
      const name = child?.cells.name?.value;
      expect(name?.type).toBe("text");
      expect(e.template).toBe(true);
      expect(e.gear).toBeDefined();
      expect(e.expanded).toBe(false);
      const drawing = e.drawing as FaceDrawing;
      expect(drawing.base).toBeNull();
      expect(drawing.primitives).toHaveLength(1);
      const t = drawing.primitives[0] as TextPrimitive;
      expect(t.kind).toBe("text");
      expect(t.text).toBe(name?.type === "text" ? name.value : "?");
    }
    // 14 rows of 0.66 in an 8.8-unit list.
    expect(c.maxOffset).toBeCloseTo(14 * 0.66 - 8.8);
  });
});

// ---------------------------------------------------------------------------
// Presentation bounds, drawItemFor, faceBaseItem

describe("presentationBounds", () => {
  test("a rotated faced card's bounds contain its rotated buttons", () => {
    const card = mk("card", {
      shape: rect(2.5, 3.5),
      at: [5, 5],
      rotation: 30,
      actions: ["Go"],
      face: { elements: [button("Go", [-1.2, 1.9, 2.4, 0.45], 0)] },
    });
    const item = drawItemFor(card, { anchor: [5, 5], rotation: 30, gm: true, formatText: String });
    const d = resolve(card);
    const pb = presentationBounds(item, d);
    const goRect = (d.primitives[0] as ButtonPrimitive).rect;
    inside(aabb(goRect, itemTransform(item)), pb);
    inside(item.bounds, pb);
    expect(pb.maxY).toBeGreaterThan(item.bounds.maxY);
  });

  test("a faceless die's bounds contain its strip; no drawing gives the footprint", () => {
    const die = mk("die", { shape: circle(0.5), at: [0, 0], actions: ["Roll"] });
    const item = drawItemFor(die, { anchor: [0, 0], rotation: 0, gm: true, formatText: String });
    const d = resolve(die);
    const pb = presentationBounds(item, d);
    inside(aabb((only(d, "button")[0] as ButtonPrimitive).rect, translate(0, 0)), pb);
    closeAll([pb.minX, pb.minY, pb.maxX, pb.maxY], [-0.75, -0.5, 0.75, 1.1]);
    expect(presentationBounds(item, null)).toEqual(item.bounds);
  });

  test("a rotated container's bounds use the rotation", () => {
    const v = mk("r", { shape: rect(2, 2), at: [0, 0], rotation: 90, actions: ["A"] });
    const item = drawItemFor(v, { anchor: [0, 0], rotation: 90, gm: true, formatText: String });
    const pb = presentationBounds(item, resolve(v));
    // The strip below the frame is rotated to the left of the anchor.
    closeAll([pb.minX], [-(1 + 0.15 + 0.45)]);
  });
});

describe("drawItemFor", () => {
  test("equals buildScene's item for the same placed view", () => {
    const v = mk("n", {
      shape: rect(2, 1),
      at: [3, 4],
      rotation: 45,
      cells: { name: text("Note"), text: num(3.5), color: text("#abc"), z: num(2) },
    });
    const formatText = (w: WireValue) => `<${w.type}>`;
    const scene = buildScene({
      views: [v],
      covers: [],
      board: BOARD,
      viewer: { type: "gm" },
      formatText,
    });
    expect(drawItemFor(v, { anchor: [3, 4], rotation: 45, gm: true, formatText })).toEqual(
      scene.items[0],
    );
  });
});

describe("faceBaseItem", () => {
  test("clears image, text and label for a faced, face-up object only", () => {
    const faced = mk("f", {
      shape: rect(1, 1),
      cells: { name: text("F"), image: text("a.png"), text: text("t") },
      face: { elements: [] },
    });
    const opts = { anchor: [0, 0] as Point, rotation: 0, gm: true, formatText: String };
    const base = faceBaseItem(drawItemFor(faced, opts), faced);
    expect(base.image).toBeUndefined();
    expect(base.text).toBeUndefined();
    expect(base.label).toBeUndefined();
    const plain = mk("p", { shape: rect(1, 1), cells: { name: text("P"), image: text("a.png") } });
    expect(faceBaseItem(drawItemFor(plain, opts), plain)).toEqual(drawItemFor(plain, opts));
  });
});
