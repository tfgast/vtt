/**
 * The structural cells every object has (FORMULAS.md §3.1): the canonical
 * table of where each is stored, how it is protected, what it holds, and what
 * it reads as when absent.
 */
import type { TableObject } from "./object";
import { bool, EMPTY, list, ref, shape, text, type Value } from "./values";

export type StructuralCellName =
  | "id"
  | "name"
  | "tag"
  | "visible_to"
  | "owner"
  | "template"
  | "contents"
  | "container"
  | "board"
  | "position"
  | "rotation"
  | "z"
  | "face_up"
  | "shape"
  | "opaque"
  | "is_zone";

/**
 * Where the cell lives. `field`: a dedicated field of TableObject, never in
 * `cells`. `cell`: an entry in `cells`, absent until written. `derived`:
 * never stored, computed from the document (`container`).
 */
export type StructuralStorage = "field" | "cell" | "derived";

/**
 * `full`: only the engine changes it (moves, spawns). `membership`: who is in
 * it is engine-only; `shuffle` may reorder it. `derived`: cannot be set at
 * all. `edit_only`: no cell write or action changes it; only the `setShape`
 * edit primitive does. `none`: an ordinary writable cell.
 */
export type StructuralProtection = "full" | "membership" | "derived" | "edit_only" | "none";

/** A literal kind a structural cell may hold or read as. */
export type StructuralLiteral =
  | "text"
  | "text_list"
  | "viewers"
  | "ref"
  | "ref_list"
  | "empty"
  | "boolean"
  | "number"
  | "point"
  | "shape";

export interface StructuralCellSpec {
  readonly name: StructuralCellName;
  readonly storage: StructuralStorage;
  readonly protection: StructuralProtection;
  /** The literal kinds it may hold (cell storage) or reads as (field, derived). */
  readonly literal: readonly StructuralLiteral[];
  /** Whether a formula may be stored in it. Never for fields and derived cells. */
  readonly formula: boolean;
  /** `shape`: the stored Shape reads as a shape value, or empty. `value`: as stored. */
  readonly reads: "value" | "shape";
  /** What it reads as when absent. `id` has none: it is allocated (DESIGN.md §4.1). */
  readonly default?: Value;
}

const spec = (s: StructuralCellSpec): StructuralCellSpec => Object.freeze(s);

/** One entry per FORMULAS.md §3.1 cell, in the order of that table. */
export const STRUCTURAL_CELLS: readonly StructuralCellSpec[] = Object.freeze([
  spec({
    name: "id",
    storage: "field",
    protection: "full",
    literal: ["text"],
    formula: false,
    reads: "value",
  }),
  spec({
    name: "name",
    storage: "cell",
    protection: "none",
    literal: ["text"],
    formula: false,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "tag",
    storage: "field",
    protection: "none",
    literal: ["text_list"],
    formula: false,
    reads: "value",
    default: list([]),
  }),
  spec({
    name: "visible_to",
    storage: "cell",
    protection: "none",
    literal: ["viewers"],
    formula: true,
    reads: "value",
    default: { type: "viewers", viewers: ["all"] },
  }),
  spec({
    name: "owner",
    storage: "cell",
    protection: "none",
    literal: ["ref", "empty"],
    formula: true,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "template",
    storage: "cell",
    protection: "none",
    literal: ["ref", "empty"],
    formula: false,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "contents",
    storage: "field",
    protection: "membership",
    literal: ["ref_list"],
    formula: false,
    reads: "value",
    default: list([]),
  }),
  spec({
    name: "container",
    storage: "derived",
    protection: "derived",
    literal: ["ref", "empty"],
    formula: false,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "board",
    storage: "field",
    protection: "full",
    literal: ["ref", "empty"],
    formula: false,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "position",
    storage: "cell",
    protection: "none",
    literal: ["point"],
    formula: true,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "rotation",
    storage: "cell",
    protection: "none",
    literal: ["number", "empty"],
    formula: true,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "z",
    storage: "cell",
    protection: "none",
    literal: ["number", "empty"],
    formula: true,
    reads: "value",
    default: EMPTY,
  }),
  spec({
    name: "face_up",
    storage: "cell",
    protection: "none",
    literal: ["boolean"],
    formula: true,
    reads: "value",
    default: bool(true),
  }),
  spec({
    name: "shape",
    storage: "field",
    protection: "edit_only",
    literal: ["shape", "empty"],
    formula: false,
    reads: "shape",
    default: EMPTY,
  }),
  spec({
    name: "opaque",
    storage: "cell",
    protection: "none",
    literal: ["boolean"],
    formula: true,
    reads: "value",
    default: bool(false),
  }),
  spec({
    name: "is_zone",
    storage: "field",
    protection: "full",
    literal: ["boolean"],
    formula: false,
    reads: "value",
    default: bool(false),
  }),
]);

const BY_NAME: ReadonlyMap<string, StructuralCellSpec> = new Map(
  STRUCTURAL_CELLS.map((s) => [s.name, s]),
);

/** The spec of a structural cell, or undefined for any other name. */
export function structuralCell(name: string): StructuralCellSpec | undefined {
  return BY_NAME.get(name);
}

const isFinitePoint = (v: Value): boolean =>
  v.type === "list" &&
  v.items.length === 2 &&
  v.items.every((i) => i.type === "number" && Number.isFinite(i.value));

function matches(kind: StructuralLiteral, v: Value): boolean {
  switch (kind) {
    case "text_list":
      return v.type === "list" && v.items.every((i) => i.type === "text");
    case "ref_list":
      return v.type === "list" && v.items.every((i) => i.type === "ref");
    case "point":
      return isFinitePoint(v);
    case "text":
    case "viewers":
    case "ref":
    case "empty":
    case "boolean":
    case "number":
    case "shape":
      return v.type === kind;
  }
}

/** Whether `v` is a literal of the cell's type (also how an override type-checks). */
export function isStructuralLiteral(s: StructuralCellSpec, v: Value): boolean {
  return s.literal.some((kind) => matches(kind, v));
}

/**
 * What structural cell `name` reads as on `obj` when `obj` stores no cell of
 * that name. A field-backed cell reads its field (`shape` as a shape value or
 * empty); a cell-backed one reads its default. `container` is derived from
 * the whole document, which `obj` alone cannot give: this returns its
 * default, empty, which is right only for an object not in a container.
 */
export function structuralDefault(name: StructuralCellName, obj: TableObject): Value {
  switch (name) {
    case "id":
      return text(obj.id);
    case "tag":
      return list(obj.tag.map(text));
    case "contents":
      return list(obj.contents.map(ref));
    case "board":
      return obj.board === null ? EMPTY : ref(obj.board);
    case "shape":
      return obj.shape === null ? EMPTY : shape(structuredClone(obj.shape));
    case "is_zone":
      return bool(obj.is_zone);
    default: {
      const d = BY_NAME.get(name)?.default;
      if (d === undefined) throw new Error(`no default for structural cell "${name}"`);
      return structuredClone(d);
    }
  }
}
