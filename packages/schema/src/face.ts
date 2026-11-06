/**
 * Face layouts (DESIGN.md §4.6 "Face layouts"; PROTOCOL.md §5; M5-D7): which
 * cells, buttons and contents appear on an object's surface, and where. A
 * layout is data, the object field `face`, replaced whole by `set_face`.
 */
import { z } from "zod";
import { MAX_FACE_ELEMENTS } from "./action-limits";
import { shapeBounds } from "./geometry/bounds";
import type { Shape } from "./shape";

/**
 * `[x, y, w, h]` in board units in the object's unrotated local frame
 * (origin at the anchor, y down). Finite, `w` and `h` > 0.
 */
export type Rect = [x: number, y: number, w: number, h: number];

export interface FaceStyle {
  size?: "small" | "normal" | "large" | "huge";
  align?: "left" | "center" | "right";
  caption?: boolean;
}

/** A cell shown as its value, or as an in-place editor. */
export interface FaceCellElement {
  type: "value" | "editor";
  cell: string;
  rect: Rect;
  show_when?: string;
  min_size?: number;
  style?: FaceStyle;
}

/** A button bound to an action of the object. */
export interface FaceButtonElement {
  type: "button";
  action: string;
  rect: Rect;
  label?: string;
  show_when?: string;
  min_size?: number;
}

/** The object's `contents`, rendered inline. */
export interface FaceContentsElement {
  type: "contents";
  rect: Rect;
  entries?: "collapsed" | "full";
  show_when?: string;
  min_size?: number;
  /**
   * Shown only while the object (or an object inside it at any depth) is
   * selected, or an Alt drag hovers it; otherwise a count badge (M6-D12).
   * Absent means unset (always shown).
   */
  when_selected?: boolean;
}

export type FaceElement = FaceCellElement | FaceButtonElement | FaceContentsElement;

/** An object's layout: the full face, an optional collapsed face, and the double-click action. */
export interface FaceLayout {
  elements: FaceElement[];
  collapsed?: FaceElement[];
  default_action?: string;
}

/** The frame of a collapsed face, scaled to its container row. */
export const COLLAPSED_FRAME: Readonly<Rect> = Object.freeze([0, 0, 6, 0.6] as Rect);

/** The full-face frame of a shapeless object. */
const SHAPELESS_FRAME: Readonly<Rect> = Object.freeze([-1, -0.5, 2, 1] as Rect);

/**
 * The full-face frame of an object with `shape`: the shape's bounding box in
 * the unrotated local frame (shapeless: `[-1, -0.5, 2, 1]`). A fresh array.
 */
export function defaultFaceFrame(shape: Shape | null): Rect {
  if (shape === null) return [...SHAPELESS_FRAME];
  const b = shapeBounds(shape, [0, 0], 0);
  return [b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY];
}

const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const FaceStyleSchema: z.ZodType<FaceStyle> = z.strictObject({
  size: z.enum(["small", "normal", "large", "huge"]).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  caption: z.boolean().optional(),
});

const common = {
  rect: RectSchema,
  show_when: z.string().optional(),
  min_size: z.number().optional(),
};

const cellElement = <T extends "value" | "editor">(type: T) =>
  z.strictObject({
    type: z.literal(type),
    cell: z.string(),
    ...common,
    style: FaceStyleSchema.optional(),
  });

/**
 * Structural shape only: strict keys, the element kinds, finite numbers.
 * Names, sources, sizes and counts are `faceProblem`'s, so a protocol
 * client's malformed layout is `bad_request` while one breaking a limit is
 * rejected `invalid` (PROTOCOL.md §5).
 */
export const FaceElementSchema: z.ZodType<FaceElement> = z.discriminatedUnion("type", [
  cellElement("value"),
  cellElement("editor"),
  z.strictObject({
    type: z.literal("button"),
    action: z.string(),
    ...common,
    label: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("contents"),
    ...common,
    entries: z.enum(["collapsed", "full"]).optional(),
    when_selected: z.boolean().optional(),
  }),
]);

/** Structural shape only; see `FaceElementSchema`. Validity is `faceProblem`'s. */
export const FaceLayoutSchema: z.ZodType<FaceLayout> = z.strictObject({
  elements: z.array(FaceElementSchema),
  collapsed: z.array(FaceElementSchema).optional(),
  default_action: z.string().optional(),
});

/** A structurally valid layout that `faceProblem` accepts: the stored field's schema. */
export const ValidFaceLayoutSchema: z.ZodType<FaceLayout> = FaceLayoutSchema.superRefine(
  (face, ctx) => {
    const problem = faceProblem(face);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  },
);

/** The longest action name, in characters (code points), as `setActions` allows. */
const MAX_ACTION_NAME = 100;

/** The longest `show_when`, in UTF-16 code units, as `max_source_length` counts. */
const MAX_SHOW_WHEN = 10000;

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function actionNameProblem(name: string, where: string): string | undefined {
  if (name === "") return `${where}: an action name is not empty`;
  if ([...name].length > MAX_ACTION_NAME) {
    return `${where}: action name "${name.slice(0, 20)}…" is longer than ${MAX_ACTION_NAME} characters`;
  }
  return undefined;
}

function elementProblem(e: FaceElement, where: string): string | undefined {
  const [x, y, w, h] = e.rect;
  if (![x, y, w, h].every(isFiniteNumber)) return `${where}: rect is not four finite numbers`;
  if (!(w > 0 && h > 0)) return `${where}: rect width and height must be > 0`;
  if (e.show_when !== undefined) {
    if (e.show_when.trim() === "") return `${where}: show_when must not be blank`;
    if (e.show_when.length > MAX_SHOW_WHEN) {
      return `${where}: show_when is longer than ${MAX_SHOW_WHEN} characters`;
    }
  }
  if (e.min_size !== undefined && !(isFiniteNumber(e.min_size) && e.min_size >= 0)) {
    return `${where}: min_size must be a finite number >= 0`;
  }
  switch (e.type) {
    case "value":
    case "editor":
      if (e.cell === "" || e.cell === "__proto__")
        return `${where}: "${e.cell}" is not a cell name`;
      return undefined;
    case "button":
      return actionNameProblem(e.action, where);
    case "contents":
      return undefined;
  }
}

function listProblem(list: readonly FaceElement[], name: string): string | undefined {
  if (list.length > MAX_FACE_ELEMENTS) {
    return `${name} has ${list.length} elements; at most ${MAX_FACE_ELEMENTS}`;
  }
  let contents = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i] as FaceElement;
    const problem = elementProblem(e, `${name}[${i}]`);
    if (problem !== undefined) return problem;
    if (e.type === "contents" && ++contents > 1)
      return `${name} has more than one contents element`;
  }
  return undefined;
}

/**
 * Why a structurally valid layout is invalid (DESIGN.md §4.6, PROTOCOL.md
 * §5), or undefined when it is valid: rects finite with `w`, `h` > 0; cell
 * names non-empty and not `__proto__`; action names (buttons and
 * `default_action`) 1–100 characters; `show_when` non-blank and at most
 * 10,000 characters; `min_size` finite and ≥ 0; at most
 * `MAX_FACE_ELEMENTS` elements and one `contents` element per list. Whether
 * a named cell or action exists is not checked: that is presentation.
 */
export function faceProblem(face: FaceLayout): string | undefined {
  const problem =
    listProblem(face.elements, "elements") ??
    (face.collapsed === undefined ? undefined : listProblem(face.collapsed, "collapsed"));
  if (problem !== undefined) return problem;
  if (face.default_action !== undefined) {
    return actionNameProblem(face.default_action, "default_action");
  }
  return undefined;
}
