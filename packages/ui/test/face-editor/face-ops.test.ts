// @vitest-environment node
/**
 * Face layout operations (vtt-1xv.18; DESIGN.md §4.6 Face layouts, The
 * inspector; PROTOCOL.md §5 `set_face`): each op returns a new layout checked
 * with `faceProblem`, or the problem; the input layout is never mutated.
 */
import type { ObjectView } from "@vtt/protocol";
import type { FaceElement, FaceLayout, Rect } from "@vtt/schema";
import {
  addCellElement,
  addElement,
  appendCellElement,
  blankElement,
  defaultLayoutFor,
  type FaceOpResult,
  faceFrameFor,
  layoutOfView,
  moveElement,
  removeElement,
  reorderElement,
  resizeElement,
  setDefaultAction,
  setElementField,
  setFaceOps,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });

/** A GM view of a 4 × 3 rect token with two user cells and two actions. */
function tokenView(over: Partial<ObjectView> = {}): ObjectView {
  return {
    id: "tok",
    is_template: false,
    is_character: false,
    cells: {
      id: { value: text("tok"), kind: "structural" },
      name: { value: text("Goblin"), kind: "structural" },
      shape: {
        value: { type: "shape", shape: { type: "rect", width: 4, height: 3 } },
        kind: "structural",
      },
      position: { value: { type: "list", items: [num(0), num(0)] }, kind: "structural" },
      hp: { value: num(7), kind: "literal" },
      ac: { value: num(13), kind: "literal" },
    },
    actions: [{ name: "Roll" }, { name: "Attack" }],
    ...over,
  };
}

const value = (cell: string, rect: Rect, extra: Partial<FaceElement> = {}): FaceElement =>
  ({ type: "value", cell, rect, ...extra }) as FaceElement;

const FACE: FaceLayout = {
  elements: [
    value("name", [-2, -1.5, 4, 0.6]),
    value("hp", [-2, -0.9, 2, 0.6]),
    { type: "button", action: "Roll", rect: [-2, 0.5, 1.5, 0.45] },
  ],
  default_action: "Roll",
};

function ok(result: FaceOpResult): FaceLayout {
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
  return result.face;
}

function expectRect(actual: Rect | undefined, expected: Rect) {
  expect(actual).toBeDefined();
  (actual as Rect).forEach((n, i) => {
    expect(n).toBeCloseTo(expected[i] as number, 9);
  });
}

describe("frames", () => {
  test("the full frame is the shape's bounding box; the collapsed frame is fixed", () => {
    expect(faceFrameFor(tokenView(), "full")).toEqual([-2, -1.5, 4, 3]);
    const shapeless = tokenView();
    const { shape: _s, ...cells } = shapeless.cells;
    expect(faceFrameFor({ ...shapeless, cells }, "full")).toEqual([-1, -0.5, 2, 1]);
    expect(faceFrameFor(tokenView(), "collapsed")).toEqual([0, 0, 6, 0.6]);
  });
});

describe("layoutOfView", () => {
  test("null without a face; the stored layout without index, shown and reason", () => {
    expect(layoutOfView(tokenView())).toBeNull();
    const view = tokenView({
      face: {
        elements: [
          { type: "value", cell: "hp", rect: [0, 0, 1, 1], index: 0, shown: true },
          {
            type: "button",
            action: "Roll",
            rect: [0, 1, 1, 0.5],
            show_when: "hp < 5",
            index: 1,
            shown: false,
            reason: "show_when_false",
          },
        ],
        collapsed: [
          {
            type: "contents",
            rect: [0, 0, 6, 0.6],
            entries: "full",
            index: 0,
            shown: true,
          },
        ],
        default_action: "Roll",
      },
    });
    expect(layoutOfView(view)).toEqual({
      elements: [
        { type: "value", cell: "hp", rect: [0, 0, 1, 1] },
        { type: "button", action: "Roll", rect: [0, 1, 1, 0.5], show_when: "hp < 5" },
      ],
      collapsed: [{ type: "contents", rect: [0, 0, 6, 0.6], entries: "full" }],
      default_action: "Roll",
    });
  });
});

describe("element ops", () => {
  test("addElement appends to the full list, and to a new collapsed list", () => {
    const added = ok(addElement(FACE, "full", value("ac", [0, 0, 1, 0.5])));
    expect(added.elements).toHaveLength(4);
    expect(added.elements[3]).toEqual(value("ac", [0, 0, 1, 0.5]));
    expect(FACE.elements).toHaveLength(3);
    const collapsed = ok(addElement(FACE, "collapsed", value("name", [0, 0, 6, 0.6])));
    expect(collapsed.collapsed).toEqual([value("name", [0, 0, 6, 0.6])]);
    expect(collapsed.elements).toEqual(FACE.elements);
  });

  test("addElement reports a second contents element and a bad rect", () => {
    const one = ok(addElement(FACE, "full", { type: "contents", rect: [0, 0, 1, 1] }));
    const two = addElement(one, "full", { type: "contents", rect: [0, 0, 1, 1] });
    expect(two).toEqual({ ok: false, message: "elements has more than one contents element" });
    const bad = addElement(FACE, "full", value("ac", [0, 0, 0, 1]));
    expect(bad.ok).toBe(false);
  });

  test("moveElement sets the position and keeps the size", () => {
    const moved = ok(moveElement(FACE, { list: "full", index: 1 }, [0.5, 0.25]));
    expect(moved.elements[1]?.rect).toEqual([0.5, 0.25, 2, 0.6]);
    expect(FACE.elements[1]?.rect).toEqual([-2, -0.9, 2, 0.6]);
    expect(moveElement(FACE, { list: "full", index: 1 }, [Number.NaN, 0]).ok).toBe(false);
  });

  test("resizeElement replaces the rect; w and h must stay > 0", () => {
    const resized = ok(resizeElement(FACE, { list: "full", index: 1 }, [-1, -1, 3, 0.8]));
    expect(resized.elements[1]?.rect).toEqual([-1, -1, 3, 0.8]);
    const bad = resizeElement(FACE, { list: "full", index: 1 }, [-1, -1, 3, -0.1]);
    expect(bad).toEqual({ ok: false, message: "elements[1]: rect width and height must be > 0" });
  });

  test("removeElement drops one element; an emptied collapsed list is dropped", () => {
    const removed = ok(removeElement(FACE, { list: "full", index: 0 }));
    expect(removed.elements.map((e) => e.type)).toEqual(["value", "button"]);
    expect(removed.default_action).toBe("Roll");
    const withCollapsed = ok(addElement(FACE, "collapsed", value("name", [0, 0, 6, 0.6])));
    const emptied = ok(removeElement(withCollapsed, { list: "collapsed", index: 0 }));
    expect("collapsed" in emptied).toBe(false);
  });

  test("reorderElement moves an element to an index", () => {
    const down = ok(reorderElement(FACE, { list: "full", index: 0 }, 1));
    expect(down.elements.map((e) => (e.type === "value" ? e.cell : e.type))).toEqual([
      "hp",
      "name",
      "button",
    ]);
    const last = ok(reorderElement(FACE, { list: "full", index: 0 }, 2));
    expect(last.elements[2]).toEqual(FACE.elements[0]);
  });

  test("an index out of range is reported", () => {
    expect(removeElement(FACE, { list: "full", index: 3 }).ok).toBe(false);
    expect(reorderElement(FACE, { list: "full", index: 2 }, 3).ok).toBe(false);
    expect(reorderElement(FACE, { list: "full", index: 0 }, -1).ok).toBe(false);
    expect(moveElement(FACE, { list: "collapsed", index: 0 }, [0, 0]).ok).toBe(false);
  });

  test("setElementField sets and clears optional fields", () => {
    const ref = { list: "full", index: 1 } as const;
    const shown = ok(setElementField(FACE, ref, "show_when", "hp < 5"));
    expect(shown.elements[1]).toEqual(value("hp", [-2, -0.9, 2, 0.6], { show_when: "hp < 5" }));
    const cleared = ok(setElementField(shown, ref, "show_when", undefined));
    expect(cleared.elements[1]).toEqual(FACE.elements[1]);
    expect(ok(setElementField(FACE, ref, "min_size", 24)).elements[1]).toMatchObject({
      min_size: 24,
    });
    expect(ok(setElementField(FACE, ref, "cell", "ac")).elements[1]).toMatchObject({ cell: "ac" });
    expect(
      ok(setElementField(FACE, ref, "style", { size: "large", caption: true })).elements[1],
    ).toMatchObject({ style: { size: "large", caption: true } });
    expect(ok(setElementField(FACE, ref, "style", {})).elements[1]).not.toHaveProperty("style");
    expect(ok(setElementField(FACE, ref, "type", "editor")).elements[1]).toEqual({
      type: "editor",
      cell: "hp",
      rect: [-2, -0.9, 2, 0.6],
    });
    const button = { list: "full", index: 2 } as const;
    expect(ok(setElementField(FACE, button, "label", "Go")).elements[2]).toMatchObject({
      label: "Go",
    });
    expect(ok(setElementField(FACE, button, "action", "Attack")).elements[2]).toMatchObject({
      action: "Attack",
    });
    const contents = ok(addElement(FACE, "full", { type: "contents", rect: [0, 0, 1, 1] }));
    expect(
      ok(setElementField(contents, { list: "full", index: 3 }, "entries", "full")).elements[3],
    ).toEqual({ type: "contents", rect: [0, 0, 1, 1], entries: "full" });
  });

  test("setElementField reports invalid values and fields the kind lacks", () => {
    const ref = { list: "full", index: 1 } as const;
    expect(setElementField(FACE, ref, "show_when", "  ")).toEqual({
      ok: false,
      message: "elements[1]: show_when must not be blank",
    });
    expect(setElementField(FACE, ref, "min_size", -1).ok).toBe(false);
    expect(setElementField(FACE, ref, "cell", "").ok).toBe(false);
    expect(setElementField(FACE, ref, "action", "Roll").ok).toBe(false);
    expect(setElementField(FACE, ref, "type", "button").ok).toBe(false);
    expect(setElementField(FACE, ref, "cell", undefined).ok).toBe(false);
    expect(setElementField(FACE, { list: "full", index: 2 }, "cell", "hp").ok).toBe(false);
  });

  test("setDefaultAction sets and clears the default action", () => {
    expect(ok(setDefaultAction(FACE, "Attack")).default_action).toBe("Attack");
    expect(ok(setDefaultAction(FACE, undefined))).not.toHaveProperty("default_action");
    expect(setDefaultAction(FACE, "").ok).toBe(false);
  });
});

describe("blankElement", () => {
  test("new elements of each kind sit inside the list's frame", () => {
    const view = tokenView();
    expect(blankElement("value", view, "full")).toEqual(value("ac", [-2, -1.5, 2, 0.6]));
    expect(blankElement("editor", view, "collapsed")).toEqual({
      type: "editor",
      cell: "ac",
      rect: [0, 0, 2, 0.6],
    });
    expect(blankElement("button", view, "full")).toEqual({
      type: "button",
      action: "Roll",
      rect: [-2, 1.05, 1.5, 0.45],
    });
    expect(blankElement("contents", view, "full")).toEqual({
      type: "contents",
      rect: [-2, -1.5, 4, 3],
    });
    expect(blankElement("button", tokenView({ actions: [] }), "full")).toBeNull();
  });
});

describe("addCellElement", () => {
  test("a value element 2 × 0.6 at the object-local point", () => {
    const face = ok(addCellElement(FACE, tokenView(), "ac", [0, 0]));
    expect(face.elements).toHaveLength(4);
    expect(face.elements[3]).toEqual(value("ac", [0, 0, 2, 0.6]));
    expect(face.default_action).toBe("Roll");
  });

  test("clamped into the frame", () => {
    const view = tokenView();
    expect(ok(addCellElement(FACE, view, "ac", [1.5, 1.4])).elements[3]?.rect).toEqual([
      0, 0.9, 2, 0.6,
    ]);
    expect(ok(addCellElement(FACE, view, "ac", [-5, -5])).elements[3]?.rect).toEqual([
      -2, -1.5, 2, 0.6,
    ]);
    // A frame smaller than the element shrinks it to the frame.
    const small = tokenView();
    small.cells.shape = {
      value: { type: "shape", shape: { type: "circle", radius: 0.25 } },
      kind: "structural",
    };
    expect(ok(addCellElement(FACE, small, "ac", [3, 3])).elements[3]?.rect).toEqual([
      -0.25, -0.25, 0.5, 0.5,
    ]);
  });

  test("from a null face it starts from the default layout", () => {
    const view = tokenView();
    const face = ok(addCellElement(null, view, "hp", [-1, 0]));
    const base = ok(defaultLayoutFor(view));
    expect(face.elements.slice(0, -1)).toEqual(base.elements);
    expect(face.elements.at(-1)).toEqual(value("hp", [-1, 0, 2, 0.6]));
  });
});

describe("appendCellElement (vtt-qf5.46)", () => {
  test("appends where the inspector's Add puts a new value row", () => {
    const view = tokenView();
    const face = ok(appendCellElement(FACE, view, "hp"));
    expect(face.elements.slice(0, -1)).toEqual(FACE.elements);
    const added = face.elements.at(-1);
    expect(added).toEqual(value("hp", [-2, -1.5, 2, 0.6]));
    expect(added?.rect).toEqual(blankElement("value", view, "full")?.rect);
    expect(face.collapsed).toEqual(FACE.collapsed);
    expect(face.default_action).toBe("Roll");
  });

  test("from a null face it starts from the default layout", () => {
    const view = tokenView();
    const face = ok(appendCellElement(null, view, "hp"));
    expect(face.elements.slice(0, -1)).toEqual(ok(defaultLayoutFor(view)).elements);
    expect(face.elements.at(-1)).toEqual(value("hp", [-2, -1.5, 2, 0.6]));
  });
});

describe("defaultLayoutFor", () => {
  test("name across the top, a captioned row per user cell, a button per action", () => {
    const face = ok(defaultLayoutFor(tokenView()));
    expect(face.elements.map((e) => ({ ...e, rect: undefined }))).toEqual([
      { type: "value", cell: "name", rect: undefined, style: { size: "large" } },
      { type: "value", cell: "ac", rect: undefined, style: { caption: true } },
      { type: "value", cell: "hp", rect: undefined, style: { caption: true } },
      { type: "button", action: "Roll", rect: undefined },
      { type: "button", action: "Attack", rect: undefined },
      { type: "contents", rect: undefined, min_size: 24, when_selected: true },
    ]);
    const rects: Rect[] = [
      [-2, -1.5, 4, 0.6],
      [-2, -0.9, 4, 0.6],
      [-2, -0.3, 4, 0.6],
      [-2, 0.3, 4, 0.6],
      [-2, 0.9, 4, 0.6],
      [-3, 1.65, 6, 0.6],
    ];
    face.elements.forEach((e, i) => {
      expectRect(e.rect, rects[i] as Rect);
    });
    expect(face).not.toHaveProperty("collapsed");
    expect(face).not.toHaveProperty("default_action");
  });

  test("a shapeless object with no user cells or actions gets its name and contents list", () => {
    const view = tokenView({ actions: [] });
    const { shape: _s, hp: _h, ac: _a, ...cells } = view.cells;
    expect(ok(defaultLayoutFor({ ...view, cells }))).toEqual({
      elements: [
        { type: "value", cell: "name", rect: [-1, -0.5, 2, 1], style: { size: "large" } },
        { type: "contents", rect: [-3, 0.65, 6, 0.6], min_size: 24, when_selected: true },
      ],
    });
  });

  test("ends with a when_selected contents list below the last row, with or without contents (M6-D19)", () => {
    const refs = (n: number) => ({
      value: {
        type: "list" as const,
        items: Array.from({ length: n }, (_, i) => ({ type: "ref" as const, object: `o${i}` })),
      },
      kind: "structural" as const,
    });
    const cases: [ObjectView, Rect][] = [
      [tokenView(), [-3, 1.65, 6, 0.6]],
      [tokenView({ cells: { ...tokenView().cells, contents: refs(0) } }), [-3, 1.65, 6, 0.6]],
      [tokenView({ cells: { ...tokenView().cells, contents: refs(3) } }), [-3, 1.65, 6, 1.8]],
      [tokenView({ cells: { ...tokenView().cells, contents: refs(20) } }), [-3, 1.65, 6, 4.8]],
    ];
    for (const [view, expected] of cases) {
      const elements = ok(defaultLayoutFor(view)).elements;
      const last = elements.at(-1);
      expect(last).toMatchObject({ type: "contents", min_size: 24, when_selected: true });
      expect(elements.filter((e) => e.type === "contents")).toHaveLength(1);
      expectRect(last?.rect, expected);
      // Below every other generated row.
      const rowsBottom = Math.max(...elements.slice(0, -1).map((e) => e.rect[1] + e.rect[3]));
      expect((last as FaceElement).rect[1]).toBeGreaterThan(rowsBottom);
    }
  });

  test("more rows than a list allows is reported", () => {
    const view = tokenView();
    for (let i = 0; i < 200; i++) view.cells[`c${i}`] = { value: num(i), kind: "literal" };
    const result = defaultLayoutFor(view);
    expect(result.ok).toBe(false);
  });
});

describe("setFaceOps", () => {
  test("one set_face op, null removing the layout", () => {
    expect(setFaceOps("tok", FACE)).toEqual([{ type: "set_face", object: "tok", face: FACE }]);
    expect(setFaceOps("tok", null)).toEqual([{ type: "set_face", object: "tok", face: null }]);
  });
});
