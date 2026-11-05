/**
 * Document invariants (DESIGN.md §4.1, §4.3, §4.4; FORMULAS.md §3.1) that the
 * structural schemas do not express. References inside values may dangle;
 * that is never a violation.
 */
import type { Snapshot } from "./document";
import { isValue } from "./guard";
import { isValidId } from "./ids";
import type { TableObject } from "./object";
import type { Point, Shape } from "./shape";
import { isStructuralLiteral, structuralCell } from "./structural";

export type ViolationKind =
  /** A board, object, or retired id fails `isValidId`. */
  | "invalid_id"
  /** Two boards or objects, or a board and an object, share an id. */
  | "duplicate_id"
  /** A key of `objects` differs from that object's `id`. */
  | "object_key_mismatch"
  /** A key of `cells` or `cell_visibility` is empty or `__proto__`. */
  | "invalid_cell_name"
  /** `cells` stores a field-backed or derived structural name, or a field name. */
  | "field_cell"
  /** An override on a cell whose content is a literal. */
  | "override_on_literal"
  /** A literal structural cell, or an override on one, has the wrong type. */
  | "structural_type"
  /** A formula on a structural cell that is literal only (`name`, `template`). */
  | "formula_not_allowed"
  /** `opaque` on an object that is not `is_zone`. */
  | "opaque_not_zone"
  /** A `cell_visibility` value that is not a non-empty viewers value. */
  | "invalid_cell_visibility"
  /** Not on exactly one board or in exactly one `contents`. */
  | "placement"
  /** Containment loops back on itself. */
  | "containment_cycle"
  /** `board` names no board. */
  | "unknown_board"
  /** `contents` names no object. */
  | "unknown_object"
  /** `position` missing on a board, or `position`/`rotation`/`z` present off one. */
  | "placement_cell"
  /** A shape that is not positive, or a polygon that is not simple. */
  | "invalid_shape"
  /** `next_seq` is not a non-negative integer. */
  | "invalid_next_seq"
  /** `retired_ids` lists an id twice. */
  | "duplicate_retired_id"
  /** Two actions on one object share a name (FIXTURES.md §3). */
  | "duplicate_action";

export interface Violation {
  kind: ViolationKind;
  path: (string | number)[];
  message: string;
}

/** Names `cells` may never hold: field-backed and derived structural cells, and the flags. */
const NOT_CELLS: ReadonlySet<string> = new Set([
  "id",
  "tag",
  "contents",
  "container",
  "board",
  "shape",
  "is_zone",
  "is_template",
  "is_character",
]);

/** Every violation in `s`, in a stable order; empty when the snapshot is valid. */
export function validateSnapshot(s: Snapshot): Violation[] {
  const out: Violation[] = [];
  const report = (kind: ViolationKind, path: Violation["path"], message: string) => {
    out.push({ kind, path, message });
  };

  // ---- ids
  const seen = new Set<string>();
  const boardIds = new Set<string>();
  const claim = (id: string, path: Violation["path"]) => {
    if (!isValidId(id)) report("invalid_id", path, `"${id}" is not a valid id`);
    if (seen.has(id)) report("duplicate_id", path, `id "${id}" is used twice`);
    seen.add(id);
  };
  s.boards.forEach((b, i) => {
    claim(b.id, ["boards", i, "id"]);
    boardIds.add(b.id);
  });
  const objects = Object.entries(s.objects);
  for (const [key, o] of objects) {
    if (key !== o.id) {
      report("object_key_mismatch", ["objects", key, "id"], `key "${key}" holds object "${o.id}"`);
    }
    claim(o.id, ["objects", key, "id"]);
  }

  if (!Number.isInteger(s.next_seq) || s.next_seq < 0) {
    report(
      "invalid_next_seq",
      ["next_seq"],
      `next_seq ${s.next_seq} is not a non-negative integer`,
    );
  }
  const retired = new Set<string>();
  s.retired_ids.forEach((id, i) => {
    if (!isValidId(id)) report("invalid_id", ["retired_ids", i], `"${id}" is not a valid id`);
    if (retired.has(id))
      report("duplicate_retired_id", ["retired_ids", i], `"${id}" retired twice`);
    retired.add(id);
  });

  // ---- each object on its own
  for (const [key, o] of objects) checkObject(o, ["objects", key], report);

  // ---- placement and containment
  const parents = new Map<string, string[]>();
  for (const [key, o] of objects) {
    o.contents.forEach((child, i) => {
      if (!Object.hasOwn(s.objects, child)) {
        report("unknown_object", ["objects", key, "contents", i], `no object "${child}"`);
        return;
      }
      const list = parents.get(child) ?? [];
      list.push(key);
      parents.set(child, list);
    });
  }
  for (const [key, o] of objects) {
    const base = ["objects", key];
    if (o.board !== null && !boardIds.has(o.board)) {
      report("unknown_board", [...base, "board"], `no board "${o.board}"`);
    }
    const holders = parents.get(key)?.length ?? 0;
    const places = holders + (o.board === null ? 0 : 1);
    if (places !== 1) {
      const where =
        places === 0 ? "neither on a board nor in a container" : "in more than one place";
      report("placement", base, `"${key}" is ${where}`);
    }
  }
  // Cycles: depth-first over every containment edge, whatever the placement
  // violations, so a cycle is found even through an object held twice.
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, "open");
    stack.push(id);
    for (const child of new Set(s.objects[id]?.contents ?? [])) {
      if (!Object.hasOwn(s.objects, child)) continue;
      const st = state.get(child);
      if (st === "open") {
        const loop = [...stack.slice(stack.indexOf(child)), child];
        report("containment_cycle", ["objects", child, "contents"], `cycle: ${loop.join(" > ")}`);
      } else if (st === undefined) {
        visit(child);
      }
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const [key] of objects) if (!state.has(key)) visit(key);

  return out;
}

type Report = (kind: ViolationKind, path: Violation["path"], message: string) => void;

function checkObject(o: TableObject, base: Violation["path"], report: Report): void {
  for (const [name, cell] of Object.entries(o.cells)) {
    const path = [...base, "cells", name];
    if (name === "" || name === "__proto__") {
      report("invalid_cell_name", path, `"${name}" is not a cell name`);
      continue;
    }
    if (NOT_CELLS.has(name)) {
      report("field_cell", path, `"${name}" is a field of the object, never a stored cell`);
      continue;
    }
    const isFormula = cell.content.type === "formula";
    if (cell.override !== undefined && !isFormula) {
      report("override_on_literal", [...path, "override"], `"${name}" is literal; no override`);
    }
    const spec = structuralCell(name);
    if (spec === undefined) continue;
    if (cell.content.type === "formula") {
      if (!spec.formula) report("formula_not_allowed", path, `"${name}" is literal only`);
    } else if (!isStructuralLiteral(spec, cell.content)) {
      report(
        "structural_type",
        [...path, "content"],
        `"${name}" cannot hold a ${cell.content.type}`,
      );
    }
    if (isFormula && cell.override !== undefined && !isStructuralLiteral(spec, cell.override)) {
      report(
        "structural_type",
        [...path, "override"],
        `"${name}" cannot be overridden with a ${cell.override.type}`,
      );
    }
    if (name === "opaque" && !o.is_zone) {
      report("opaque_not_zone", path, `"opaque" is for zones only; "${o.id}" is not a zone`);
    }
  }

  const has = (name: string) => Object.hasOwn(o.cells, name);
  if (o.board !== null && !has("position")) {
    report(
      "placement_cell",
      [...base, "cells", "position"],
      `"${o.id}" is on a board without a position`,
    );
  }
  if (o.board === null) {
    for (const name of ["position", "rotation", "z"]) {
      if (has(name)) {
        report(
          "placement_cell",
          [...base, "cells", name],
          `"${o.id}" is not on a board; no ${name}`,
        );
      }
    }
  }

  for (const [name, v] of Object.entries(o.cell_visibility)) {
    const path = [...base, "cell_visibility", name];
    if (name === "" || name === "__proto__") {
      report("invalid_cell_name", path, `"${name}" is not a cell name`);
    } else if (!isValue(v) || v.type !== "viewers") {
      report("invalid_cell_visibility", path, `visibility of "${name}" is not a viewers value`);
    }
  }

  const actionNames = new Set<string>();
  o.actions.forEach((a, i) => {
    if (actionNames.has(a.name)) {
      report(
        "duplicate_action",
        [...base, "actions", i, "name"],
        `action "${a.name}" is defined twice`,
      );
    }
    actionNames.add(a.name);
  });

  if (o.shape !== null) {
    const problem = shapeProblem(o.shape);
    if (problem !== undefined) report("invalid_shape", [...base, "shape"], problem);
  }
}

/** Why a shape is invalid (DESIGN.md §4.3), or undefined when it is valid. */
export function shapeProblem(shape: Shape): string | undefined {
  switch (shape.type) {
    case "circle":
      return shape.radius > 0 ? undefined : "circle radius must be > 0";
    case "rect":
      return shape.width > 0 && shape.height > 0 ? undefined : "rect width and height must be > 0";
    case "polygon":
      if (shape.points.length < 3) return "polygon needs at least three points";
      return isSimplePolygon(shape.points) ? undefined : "polygon must be simple";
  }
}

/** Sign of the turn a → b → c: positive counter-clockwise, 0 collinear. */
function orient(a: Point, b: Point, c: Point): number {
  return Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}

/** Whether p, known collinear with segment ab, lies on it (endpoints included). */
function within(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

const onSegment = (a: Point, b: Point, p: Point) => orient(a, b, p) === 0 && within(a, b, p);

/** Whether closed segments ab and cd share any point. */
function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/**
 * Simple: adjacent edges meet only at their shared vertex, non-adjacent edges
 * do not meet at all. Exact arithmetic, no tolerance.
 */
function isSimplePolygon(points: Point[]): boolean {
  const n = points.length;
  const at = (i: number) => points[i % n] as Point;
  for (let i = 0; i < n; i++) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    // Adjacent edges ab and bc: degenerate, or folding back over each other.
    if (onSegment(a, b, c) || onSegment(b, c, a)) return false;
    for (let j = i + 2; j < n; j++) {
      if ((j + 1) % n === i) continue; // the edge before ab is adjacent to it
      if (segmentsTouch(a, b, at(j), at(j + 1))) return false;
    }
  }
  return true;
}
