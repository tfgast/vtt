/**
 * Face layout operations (vtt-1xv.18; DESIGN.md §4.6 Face layouts, The
 * inspector, Collapsed face; PROTOCOL.md §5 `set_face`; M5 plan Q8, Q9).
 * Pure: each op takes a layout and returns a new one checked with
 * `@vtt/schema`'s `faceProblem`, or the problem (the caller shows a notice
 * and writes nothing). Inputs are never mutated. `setFaceOps` turns a
 * layout into the one `set_face` op that replaces the whole layout.
 *
 * Coordinates are board units in the object's unrotated local frame (origin
 * at the anchor, y down). The full list's frame is the shape's bounding box
 * (`defaultFaceFrame`); the collapsed list's is `COLLAPSED_FRAME`.
 */
import type { FaceElementView, FaceView, ObjectView, WireOp } from "@vtt/protocol";
import {
  COLLAPSED_FRAME,
  defaultFaceFrame,
  type FaceElement,
  type FaceLayout,
  type FaceStyle,
  faceProblem,
  type ObjectId,
  type Rect,
  type Shape,
  STRUCTURAL_CELLS,
} from "@vtt/schema";
import {
  CONTENTS_ROW_RATIO,
  DEFAULT_CONTENTS_ROWS,
  DEFAULT_CONTENTS_WIDTH,
  STRIP_TOP_GAP,
} from "../face/face-model";

/** A layout's element list: `elements` (the full face) or `collapsed`. */
export type FaceListName = "full" | "collapsed";

/** An element by list and position. */
export interface LayoutElementRef {
  readonly list: FaceListName;
  readonly index: number;
}

/** A checked new layout, or why the edit is invalid. */
export type FaceOpResult =
  | { readonly ok: true; readonly face: FaceLayout }
  | { readonly ok: false; readonly message: string };

/** The width and height of an element added by `addCellElement` (shrunk to fit a smaller frame). */
export const CELL_ELEMENT_SIZE: readonly [number, number] = [2, 0.6];

/** The width and height of a button added by `blankElement`. */
const BUTTON_SIZE: readonly [number, number] = [1.5, 0.45];

const STRUCTURAL: ReadonlySet<string> = new Set(STRUCTURAL_CELLS.map((spec) => spec.name));

// ---------------------------------------------------------------------------
// Reading views

/** The view's stored shape, or null. */
function shapeOf(view: ObjectView): Shape | null {
  const v = view.cells.shape?.value;
  return v?.type === "shape" ? (v.shape as Shape) : null;
}

/** The frame of `list` for `view`: the shape's bounding box, or `COLLAPSED_FRAME`. */
export function faceFrameFor(view: ObjectView, list: FaceListName): Rect {
  return list === "collapsed" ? [...COLLAPSED_FRAME] : defaultFaceFrame(shapeOf(view));
}

/** The view's user cell names, alphabetically (as the inspector lists them). */
export function faceUserCells(view: ObjectView): string[] {
  return Object.keys(view.cells)
    .filter((name) => !STRUCTURAL.has(name))
    .sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
}

/** A live element without its `index`, `shown`, `reason` and `error`: the stored element. */
function storedElement(e: FaceElementView): FaceElement {
  const common = {
    rect: [...e.rect] as Rect,
    ...(e.show_when === undefined ? {} : { show_when: e.show_when }),
    ...(e.min_size === undefined ? {} : { min_size: e.min_size }),
  };
  switch (e.type) {
    case "value":
    case "editor": {
      const style: FaceStyle | undefined =
        e.style === undefined
          ? undefined
          : {
              ...(e.style.size === undefined ? {} : { size: e.style.size }),
              ...(e.style.align === undefined ? {} : { align: e.style.align }),
              ...(e.style.caption === undefined ? {} : { caption: e.style.caption }),
            };
      return {
        type: e.type,
        cell: e.cell,
        ...common,
        ...(style === undefined ? {} : { style }),
      };
    }
    case "button":
      return {
        type: "button",
        action: e.action,
        ...common,
        ...(e.label === undefined ? {} : { label: e.label }),
      };
    case "contents":
      return {
        type: "contents",
        ...common,
        ...(e.entries === undefined ? {} : { entries: e.entries }),
        ...(e.when_selected === undefined ? {} : { when_selected: e.when_selected }),
      };
  }
}

/**
 * The stored layout carried by `view`'s live face, or null when it has none.
 * Lossless for GM views (they carry every element and its `show_when`), so
 * this is what the GM's edits start from.
 */
export function layoutOfView(view: ObjectView): FaceLayout | null {
  const face: FaceView | undefined = view.face;
  if (face === undefined) return null;
  return {
    elements: face.elements.map(storedElement),
    ...(face.collapsed === undefined ? {} : { collapsed: face.collapsed.map(storedElement) }),
    ...(face.default_action === undefined ? {} : { default_action: face.default_action }),
  };
}

/** The elements of `list` (an absent collapsed list is empty). */
export function faceListOf(face: FaceLayout, list: FaceListName): readonly FaceElement[] {
  return list === "full" ? face.elements : (face.collapsed ?? []);
}

// ---------------------------------------------------------------------------
// Checking

function checked(face: FaceLayout): FaceOpResult {
  const problem = faceProblem(face);
  return problem === undefined ? { ok: true, face } : { ok: false, message: problem };
}

const fail = (message: string): FaceOpResult => ({ ok: false, message });

/** `face` with `list` replaced; an emptied collapsed list is dropped (back to the default collapsed face). */
function withList(face: FaceLayout, list: FaceListName, elements: FaceElement[]): FaceLayout {
  if (list === "full") return { ...face, elements };
  const { collapsed: _old, ...rest } = face;
  return elements.length === 0 ? rest : { ...rest, collapsed: elements };
}

function listName(list: FaceListName): string {
  return list === "full" ? "elements" : "collapsed";
}

function outOfRange(ref: LayoutElementRef): FaceOpResult {
  return fail(`${listName(ref.list)}[${ref.index}] does not exist`);
}

/** Replaces the element at `ref` with `update(element)` (a string is a problem). */
function updateAt(
  face: FaceLayout,
  ref: LayoutElementRef,
  update: (e: FaceElement) => FaceElement | string,
): FaceOpResult {
  const list = faceListOf(face, ref.list);
  const current = list[ref.index];
  if (!Number.isInteger(ref.index) || current === undefined) return outOfRange(ref);
  const next = update(current);
  if (typeof next === "string") return fail(`${listName(ref.list)}[${ref.index}]: ${next}`);
  const elements = [...list];
  elements[ref.index] = next;
  return checked(withList(face, ref.list, elements));
}

// ---------------------------------------------------------------------------
// Element ops

/** Appends `element` to `list` (creating the collapsed list when absent). */
export function addElement(
  face: FaceLayout,
  list: FaceListName,
  element: FaceElement,
): FaceOpResult {
  return checked(withList(face, list, [...faceListOf(face, list), element]));
}

/** Moves the element at `ref` so its rect's top-left is `[x, y]`; the size is kept. */
export function moveElement(
  face: FaceLayout,
  ref: LayoutElementRef,
  [x, y]: readonly [number, number],
): FaceOpResult {
  return updateAt(face, ref, (e) => ({ ...e, rect: [x, y, e.rect[2], e.rect[3]] }));
}

/** Sets the element's whole rect (a resize from a handle may move its origin too). */
export function resizeElement(face: FaceLayout, ref: LayoutElementRef, rect: Rect): FaceOpResult {
  return updateAt(face, ref, (e) => ({ ...e, rect: [...rect] as Rect }));
}

/** Removes the element at `ref`. Removing the last collapsed element drops the collapsed list. */
export function removeElement(face: FaceLayout, ref: LayoutElementRef): FaceOpResult {
  const list = faceListOf(face, ref.list);
  if (!Number.isInteger(ref.index) || list[ref.index] === undefined) return outOfRange(ref);
  return checked(
    withList(
      face,
      ref.list,
      list.filter((_, i) => i !== ref.index),
    ),
  );
}

/** Moves the element at `ref` to position `to` of its list (later elements draw above). */
export function reorderElement(face: FaceLayout, ref: LayoutElementRef, to: number): FaceOpResult {
  const list = faceListOf(face, ref.list);
  const moved = list[ref.index];
  if (!Number.isInteger(ref.index) || moved === undefined) return outOfRange(ref);
  if (!Number.isInteger(to) || to < 0 || to >= list.length) {
    return fail(`${listName(ref.list)}: position ${to} does not exist`);
  }
  const elements = list.filter((_, i) => i !== ref.index);
  elements.splice(to, 0, moved);
  return checked(withList(face, ref.list, elements));
}

/** The settable fields of an element and their values. */
export interface FaceElementFields {
  /** `value` ↔ `editor` only; other kinds are added and deleted, not converted. */
  type: FaceElement["type"];
  cell: string;
  action: string;
  label: string;
  show_when: string;
  min_size: number;
  style: FaceStyle;
  entries: "collapsed" | "full";
  when_selected: boolean;
}

const KIND_FIELDS: Record<FaceElement["type"], ReadonlySet<keyof FaceElementFields>> = {
  value: new Set(["type", "cell", "show_when", "min_size", "style"]),
  editor: new Set(["type", "cell", "show_when", "min_size", "style"]),
  button: new Set(["type", "action", "label", "show_when", "min_size"]),
  contents: new Set(["type", "entries", "show_when", "min_size", "when_selected"]),
};

const REQUIRED: ReadonlySet<keyof FaceElementFields> = new Set(["type", "cell", "action"]);

/**
 * Sets `field` of the element at `ref` to `value`; `undefined` (or an empty
 * `style`) removes an optional field. A field the element's kind lacks, a
 * required field cleared, or a kind change other than `value` ↔ `editor` is
 * reported. Values are then checked with `faceProblem` (a blank `show_when`
 * is invalid: callers map empty input to `undefined`).
 */
export function setElementField<K extends keyof FaceElementFields>(
  face: FaceLayout,
  ref: LayoutElementRef,
  field: K,
  value: FaceElementFields[K] | undefined,
): FaceOpResult {
  return updateAt(face, ref, (e) => {
    if (!KIND_FIELDS[e.type].has(field)) return `a ${e.type} element has no ${field}`;
    if (value === undefined && REQUIRED.has(field)) return `${field} is required`;
    if (field === "type") {
      const cellKinds = ["value", "editor"];
      if (!(cellKinds.includes(e.type) && cellKinds.includes(value as string))) {
        return value === e.type ? e : `a ${e.type} element cannot become ${String(value)}`;
      }
    }
    const next: Record<string, unknown> = { ...e };
    const empty = field === "style" && value !== undefined && Object.keys(value).length === 0;
    if (value === undefined || empty) delete next[field];
    else next[field] = value;
    return next as unknown as FaceElement;
  });
}

/** Sets or (with `undefined`) clears the layout's `default_action`. */
export function setDefaultAction(face: FaceLayout, action: string | undefined): FaceOpResult {
  const { default_action: _old, ...rest } = face;
  return checked(action === undefined ? rest : { ...rest, default_action: action });
}

// ---------------------------------------------------------------------------
// New elements and layouts

/** `size` shrunk to fit `frame`, at `point` clamped so the rect stays inside `frame`. */
function clampedRect(
  frame: Rect,
  point: readonly [number, number],
  size: readonly [number, number],
): Rect {
  const [fx, fy, fw, fh] = frame;
  const w = Math.min(size[0], fw);
  const h = Math.min(size[1], fh);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return [clamp(point[0], fx, fx + fw - w), clamp(point[1], fy, fy + fh - h), w, h];
}

/**
 * A new element of `kind` for `list` of `view`'s layout, inside the list's
 * frame: a value or editor for the first user cell (else `name`), 2 × 0.6 at
 * the frame's top-left; a button for the first action, 1.5 × 0.45 at the
 * frame's bottom-left (null when the object has no action); a contents
 * element filling the frame. Sizes shrink to fit a smaller frame.
 */
export function blankElement(
  kind: FaceElement["type"],
  view: ObjectView,
  list: FaceListName,
): FaceElement | null {
  const frame = faceFrameFor(view, list);
  const [fx, fy, fw, fh] = frame;
  switch (kind) {
    case "value":
    case "editor":
      return {
        type: kind,
        cell: faceUserCells(view)[0] ?? "name",
        rect: clampedRect(frame, [fx, fy], CELL_ELEMENT_SIZE),
      };
    case "button": {
      const action = view.actions[0]?.name;
      if (action === undefined) return null;
      return { type: "button", action, rect: clampedRect(frame, [fx, fy + fh], BUTTON_SIZE) };
    }
    case "contents":
      return { type: "contents", rect: [fx, fy, fw, fh] };
  }
}

/** The generated contents list's rect: centred below `frame`, 1 to 8 rows. */
function generatedContentsRect(view: ObjectView, frame: Rect): Rect {
  const v = view.cells.contents?.value;
  const count = v?.type === "list" ? v.items.length : 0;
  const rows = Math.min(Math.max(count, 1), DEFAULT_CONTENTS_ROWS);
  const w = DEFAULT_CONTENTS_WIDTH;
  const rowHeight = w / (1 / CONTENTS_ROW_RATIO);
  return [
    frame[0] + frame[2] / 2 - w / 2,
    frame[1] + frame[3] + STRIP_TOP_GAP,
    w,
    rows * rowHeight,
  ];
}

/**
 * "Create face": a `name` value element across the top, then one captioned
 * value row per user cell (alphabetically), then one button per action (in
 * action order), each row the frame's width and `frame height / rows` high,
 * then the object's contents list below the frame, shown only while
 * selected (`when_selected`, `min_size` 24; M6-D19), placed as the faceless
 * default places it (`defaultContentsRect`): centred, 6 units wide, one row
 * per entry from 1 up to `DEFAULT_CONTENTS_ROWS`. The list is always
 * included, even while `contents` is empty. No collapsed list and no
 * `default_action`. More rows than a list allows is reported.
 */
export function defaultLayoutFor(view: ObjectView): FaceOpResult {
  const [fx, fy, fw, fh] = faceFrameFor(view, "full");
  const cells = faceUserCells(view);
  const actions = view.actions.map((a) => a.name);
  const rows = 1 + cells.length + actions.length;
  const h = fh / rows;
  const rect = (i: number): Rect => [fx, fy + i * h, fw, h];
  const elements: FaceElement[] = [
    { type: "value", cell: "name", rect: rect(0), style: { size: "large" } },
    ...cells.map(
      (cell, i): FaceElement => ({
        type: "value",
        cell,
        rect: rect(1 + i),
        style: { caption: true },
      }),
    ),
    ...actions.map(
      (action, i): FaceElement => ({ type: "button", action, rect: rect(1 + cells.length + i) }),
    ),
    {
      type: "contents",
      rect: generatedContentsRect(view, [fx, fy, fw, fh]),
      min_size: 24,
      when_selected: true,
    },
  ];
  return checked({ elements });
}

/**
 * Adds a value element for `cell` to the full list, 2 × 0.6 units with its
 * top-left at the object-local `point` (vtt-1xv.27 converts drop points),
 * clamped into the full frame (and shrunk to a smaller frame). A null face
 * starts from `defaultLayoutFor(view)`.
 */
export function addCellElement(
  face: FaceLayout | null,
  view: ObjectView,
  cell: string,
  point: readonly [number, number],
): FaceOpResult {
  let base = face;
  if (base === null) {
    const created = defaultLayoutFor(view);
    if (!created.ok) return created;
    base = created.face;
  }
  const rect = clampedRect(faceFrameFor(view, "full"), point, CELL_ELEMENT_SIZE);
  return addElement(base, "full", { type: "value", cell, rect });
}

/** The one op replacing `object`'s whole layout (`null` removes it). */
export function setFaceOps(object: ObjectId, face: FaceLayout | null): WireOp[] {
  return [{ type: "set_face", object, face }];
}
