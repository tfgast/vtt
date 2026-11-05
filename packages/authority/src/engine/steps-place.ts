/**
 * The placement steps (FORMULAS.md §8.3 `move`, `spawn`, `remove`; §8.2
 * destinations; §3.1 landing rule; DESIGN.md §4.1, §7 Smaller decisions;
 * M5-D4): `placementHandlers`, written against the executor's `StepContext`
 * (invoke.ts). Nothing registers them; callers compose them with
 * `coreHandlers` in `createExecutor`.
 *
 * - `move(r, dest)`: M2 `move` (landing rule; a container that is `r` or
 *   inside it refuses `containment_cycle`).
 * - `spawn(t, dest, {cell: v, ...})`: M2 `spawn` with the evaluated record
 *   values as initial cells; each value must be storable (an error refuses
 *   with its code). Every copy's id joins `ctx.created` in creation order:
 *   the root, then its descendants in the primitive's preorder.
 * - `remove(r)`: M2 `remove`, recursive; later reads of the removed objects
 *   are `#REF` (ActionContext).
 *
 * Arguments are evaluated in source order: the object (or template), then
 * the destination, then the record values.
 *
 * Destinations (FORMULAS §8.2):
 * - a container: one reference to an existing object (`empty` → `#REF`, a
 *   list or another kind → `#TYPE`), appended to.
 * - `board(b, p)`: `b` a reference to an existing board (anything else,
 *   an object reference included, `#REF`), `p` a list of two finite numbers
 *   (else `#TYPE`).
 * - `beside(r)`: the board of `r`'s outermost container chain (`r` itself
 *   when on a board; else `step_error` "not on a board"), at that object's
 *   anchor (its `position` as the action reads it) + `[wr/2 + wm/2 + 0.25,
 *   0]`, `wr` and `wm` the widths of the literal footprint bounds of that
 *   object and of the object being placed (shape field and literal or
 *   overridden `rotation`, else 0; 0 when shapeless). A spawned copy's
 *   rotation is its initial one: the record's `rotation` when it gives a
 *   number, else the template's; so `beside`'s position is completed after
 *   the record values are evaluated.
 * - `table`: the request's `tableDestination`, else `step_error` without
 *   code.
 *
 * An error from any argument refuses `step_error` with its code. Placement
 * itself (board existence, finite positions, the landing rule) is the M2
 * primitive's; its `invalid` becomes `step_error` without code (invoke.ts).
 */
import type { DestinationNode, Expr, Step } from "@vtt/formula";
import {
  type CellContent,
  isValue,
  type ObjectId,
  type Result,
  type Shape,
  shapeBounds,
} from "@vtt/schema";
import type { Destination } from "../store/structural";
import type { StepContext, StepHandlerEntry, StepOutcome } from "./invoke";

const OK: StepOutcome = { ok: true };

/** The gap `beside` leaves between the two footprints, in board units. */
const BESIDE_GAP = 0.25;

const TABLE_MESSAGE = "the table destination needs the invoker's board and viewport centre";

type Resolved<T> = { ok: true; value: T } | { ok: false; outcome: StepOutcome };

/**
 * A resolved destination, or a `beside` one still waiting for the placed
 * object's width: on `board`, `dx` (the anchor object's half width plus
 * the gap) plus half that width right of `anchor`.
 */
type Placement =
  | { type: "ready"; dest: Destination }
  | { type: "beside"; board: string; anchor: [number, number]; dx: number };

const ready = (dest: Destination): Resolved<Placement> => ({
  ok: true,
  value: { type: "ready", dest },
});

/** The M2 destination, given the width of the placed object's literal footprint bounds. */
function complete(p: Placement, placedWidth: () => number): Destination {
  if (p.type === "ready") return p.dest;
  return {
    type: "board",
    board: p.board,
    position: [p.anchor[0] + p.dx + placedWidth() / 2, p.anchor[1]],
  };
}

const errorOutcome = (ctx: StepContext, r: Result & { type: "error" }): StepOutcome =>
  ctx.refuse({ code: r.code, message: r.message ?? r.code });

/** `expr` as one reference to an existing object. */
function reference(ctx: StepContext, expr: Expr): Resolved<ObjectId> {
  const r = ctx.resolveRef(expr);
  return r.ok ? { ok: true, value: r.object } : { ok: false, outcome: r };
}

/** Two finite numbers, or undefined. */
function point(v: Result): [number, number] | undefined {
  if (v.type !== "list" || v.items.length !== 2) return undefined;
  const [x, y] = v.items;
  if (x?.type !== "number" || y?.type !== "number") return undefined;
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return undefined;
  return [x.value, y.value];
}

/**
 * The width of `id`'s literal footprint bounds: its shape rotated by its
 * literal (or overridden) `rotation`, a formula or non-number reading 0.
 * 0 when shapeless.
 */
function literalWidth(ctx: StepContext, id: ObjectId, rotation?: CellContent): number {
  const shape = ctx.tx.doc.getObject(id)?.shape ?? null;
  if (shape === null) return 0;
  const cell = ctx.tx.doc.getCell(id, "rotation");
  const r = rotation ?? cell?.override ?? cell?.content;
  const deg = r?.type === "number" && Number.isFinite(r.value) ? r.value : 0;
  const b = shapeBounds(shape as Shape, [0, 0], deg);
  return b.maxX - b.minX;
}

function boardDestination(
  ctx: StepContext,
  node: DestinationNode & { type: "board" },
): Resolved<Placement> {
  const b = ctx.evaluate(node.board);
  if (b.type === "error") return { ok: false, outcome: errorOutcome(ctx, b) };
  if (b.type !== "ref" || ctx.tx.doc.getBoard(b.object) === undefined) {
    const found = b.type === "ref" ? `"${b.object}", not a board` : b.type;
    return {
      ok: false,
      outcome: ctx.refuse({ code: "#REF", message: `board(b, p) needs a board, found ${found}` }),
    };
  }
  const p = ctx.evaluate(node.position);
  if (p.type === "error") return { ok: false, outcome: errorOutcome(ctx, p) };
  const position = point(p);
  if (position === undefined) {
    return {
      ok: false,
      outcome: ctx.refuse({
        code: "#TYPE",
        message: "board(b, p) needs a position of two finite numbers",
      }),
    };
  }
  return ready({ type: "board", board: b.object, position });
}

function besideDestination(
  ctx: StepContext,
  node: DestinationNode & { type: "beside" },
): Resolved<Placement> {
  const r = reference(ctx, node.object);
  if (!r.ok) return r;
  const doc = ctx.tx.doc;
  let top = r.value;
  for (let c = doc.containerOf(top); c !== null; c = doc.containerOf(c)) top = c;
  const board = doc.boardOf(top);
  if (board === null) {
    return { ok: false, outcome: ctx.refuse({ message: `"${r.value}" is not on a board` }) };
  }
  const p = ctx.read(top, "position") ?? { type: "empty" };
  if (p.type === "error") return { ok: false, outcome: errorOutcome(ctx, p) };
  const anchor = point(p);
  if (anchor === undefined) {
    return {
      ok: false,
      outcome: ctx.refuse({
        code: "#TYPE",
        message: `beside needs "${top}" at a position of two finite numbers`,
      }),
    };
  }
  const dx = literalWidth(ctx, top) / 2 + BESIDE_GAP;
  return { ok: true, value: { type: "beside", board, anchor, dx } };
}

/** The placement `node` names, its arguments evaluated. */
function destination(ctx: StepContext, node: DestinationNode): Resolved<Placement> {
  switch (node.type) {
    case "container": {
      const r = reference(ctx, node.container);
      return r.ok ? ready({ type: "container", container: r.value }) : r;
    }
    case "board":
      return boardDestination(ctx, node);
    case "beside":
      return besideDestination(ctx, node);
    case "table": {
      const t = ctx.tableDestination;
      if (t === undefined) return { ok: false, outcome: ctx.refuse({ message: TABLE_MESSAGE }) };
      return ready({ type: "board", board: t.board, position: [t.position[0], t.position[1]] });
    }
  }
}

function move(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "move") throw new Error(`move handler got ${step.kind}`);
  const r = reference(ctx, step.object);
  if (!r.ok) return r.outcome;
  const dest = destination(ctx, step.to);
  if (!dest.ok) return dest.outcome;
  ctx.primitives.move(
    r.value,
    complete(dest.value, () => literalWidth(ctx, r.value)),
  );
  return OK;
}

function spawn(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "spawn") throw new Error(`spawn handler got ${step.kind}`);
  const t = reference(ctx, step.template);
  if (!t.ok) return t.outcome;
  const dest = destination(ctx, step.to);
  if (!dest.ok) return dest.outcome;
  const entries: [string, CellContent][] = [];
  for (const { name, value } of step.cells) {
    const v = ctx.evaluate(value);
    if (v.type === "error") return errorOutcome(ctx, v);
    if (!isValue(v)) {
      return ctx.refuse({ code: "#TYPE", message: `the value of ${name} is not storable` });
    }
    entries.push([name, v]);
  }
  // fromEntries defines own properties, so no name reaches the prototype.
  const initial: Record<string, CellContent> = Object.fromEntries(entries);
  // The copy's rotation is the record's when it gives one, else the template's.
  const rotation = Object.hasOwn(initial, "rotation") ? initial.rotation : undefined;
  const placed = complete(dest.value, () => literalWidth(ctx, t.value, rotation));
  const { copies } = ctx.primitives.spawn(t.value, placed, initial);
  // The copies map is in the primitive's creation order: the root, then its subtree in preorder.
  ctx.created.push(...copies.values());
  return OK;
}

function remove(ctx: StepContext, step: Step): StepOutcome {
  if (step.kind !== "remove") throw new Error(`remove handler got ${step.kind}`);
  const r = reference(ctx, step.object);
  if (!r.ok) return r.outcome;
  ctx.primitives.remove(r.value);
  return OK;
}

/** The placement steps' handlers: `move`, `spawn`, `remove`. */
export const placementHandlers: StepHandlerEntry[] = [
  { kind: "move", handle: move },
  { kind: "spawn", handle: spawn },
  { kind: "remove", handle: remove },
];
