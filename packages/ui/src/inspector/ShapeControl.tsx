/**
 * The inspector's shape control (vtt-3l6.12; review r3 finding 12;
 * FORMULAS.md §3.1 `shape`; PROTOCOL.md §5 `set_shape`, §6), the only
 * inspector entry point for `shape`: it shows the kind and size; "Add shape"
 * on a shapeless object offers a rect (1 × 1), a circle (r 0.5) and a
 * triangle; "Change kind" converts within the current bounding box; "Remove
 * shape" writes `null`. Each command is one `set_shape` write carrying the
 * revision captured at the click. Geometry is adjusted with the canvas
 * handles (vtt-3l6.9).
 */
import type { ObjectView } from "@vtt/protocol";
import { type ObjectId, type Shape, shapeBounds } from "@vtt/schema";
import type { CSSProperties } from "react";
import type { TableSession } from "../session/table-session";
import { inspectorRefLabel, useInspectorWrites } from "./CellRow";

export type ShapeKind = Shape["type"];

export const SHAPE_KINDS: readonly ShapeKind[] = ["rect", "circle", "polygon"];

/** What "Add shape" writes for each kind. */
export const ADD_SHAPE_DEFAULTS: { readonly [K in ShapeKind]: Extract<Shape, { type: K }> } = {
  rect: { type: "rect", width: 1, height: 1 },
  circle: { type: "circle", radius: 0.5 },
  polygon: {
    type: "polygon",
    points: [
      [0, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ],
  },
};

/** The width and height of `shape`'s unrotated bounding box. */
function boxSize(shape: Shape): [number, number] {
  const b = shapeBounds(shape, [0, 0], 0);
  return [b.maxX - b.minX, b.maxY - b.minY];
}

/**
 * `shape` as `kind`, within its current bounding box: rect w × h → circle
 * r = max(w, h) / 2; circle → rect 2r × 2r; polygon → rect of its bounds;
 * rect → polygon of its four corners. Circle ↔ polygon go through the rect
 * of the bounds. The same kind returns `shape` unchanged.
 */
export function convertShape(shape: Shape, kind: ShapeKind): Shape {
  if (shape.type === kind) return shape;
  const [w, h] = boxSize(shape);
  switch (kind) {
    case "circle":
      return { type: "circle", radius: Math.max(w, h) / 2 };
    case "rect":
      return { type: "rect", width: w, height: h };
    case "polygon":
      return {
        type: "polygon",
        points: [
          [-w / 2, -h / 2],
          [w / 2, -h / 2],
          [w / 2, h / 2],
          [-w / 2, h / 2],
        ],
      };
  }
}

/** The kind and size of a shape, or "No shape". */
export function shapeSummary(shape: Shape | null): string {
  if (shape === null) return "No shape";
  switch (shape.type) {
    case "rect":
      return `rect ${shape.width} × ${shape.height}`;
    case "circle":
      return `circle r ${shape.radius}`;
    case "polygon": {
      const [w, h] = boxSize(shape);
      return `polygon, ${shape.points.length} points, ${round(w)} × ${round(h)}`;
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The view's stored shape, or null. */
export function viewShape(view: ObjectView): Shape | null {
  const v = view.cells.shape?.value;
  return v?.type === "shape" ? v.shape : null;
}

export interface ShapeControlProps {
  object: ObjectId;
  view: ObjectView;
  session: TableSession;
  /** View-as: the summary only. */
  readOnly?: boolean;
}

const ROW_STYLE: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.25em" };

export function ShapeControl({ object, view, session, readOnly = false }: ShapeControlProps) {
  const port = useInspectorWrites(session);
  const shape = viewShape(view);

  const write = (next: Shape | null, verb: string) => {
    const baseRevision = session.getSnapshot().revision;
    const name = inspectorRefLabel(session)(object) ?? object;
    void port.write([{ type: "set_shape", object, shape: next }], {
      baseRevision,
      label: `${verb} ${name}`,
    });
  };

  return (
    <fieldset aria-label="Shape" style={{ border: "none", margin: 0, padding: 0 }}>
      <span style={{ fontWeight: 600 }}>Shape</span> <span>{shapeSummary(shape)}</span>
      {!readOnly && (
        <div style={ROW_STYLE}>
          {shape === null
            ? SHAPE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => write(ADD_SHAPE_DEFAULTS[kind], `Add ${kind} shape to`)}
                >
                  Add {kind}
                </button>
              ))
            : [
                ...SHAPE_KINDS.filter((kind) => kind !== shape.type).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => write(convertShape(shape, kind), `Change shape to ${kind} on`)}
                  >
                    Change to {kind}
                  </button>
                )),
                <button key="remove" type="button" onClick={() => write(null, "Remove shape of")}>
                  Remove shape
                </button>,
              ]}
        </div>
      )}
    </fieldset>
  );
}
