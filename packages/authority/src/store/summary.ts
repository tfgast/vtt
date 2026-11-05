/**
 * The change summary every commit carries (DESIGN.md §7): objects and boards
 * created and removed, cells written with their states, per-cell visibility
 * changes, moves with the cells each derives, every changed cell, and the
 * objects whose action list changed.
 */
import type { CellKey } from "@vtt/formula";
import type { BoardId, CellState, Effect, Location, ObjectId } from "@vtt/schema";
import type { DocState } from "./doc";
import { changedCells } from "./effects";

export interface WrittenCell {
  object: ObjectId;
  cell: string;
  before: CellState;
  after: CellState;
}

export interface MovedObject {
  object: ObjectId;
  from: Location;
  to: Location;
  /** The readable cells the move changes (`changedCells` of the place). */
  derived: CellKey[];
}

/**
 * What one transaction changed, in effect order. Nothing nets out: an object
 * created and removed in one transaction is in both lists, and a write of
 * the value a cell already holds is still a written cell.
 */
export interface ChangeSummary {
  /** Every created object, subtrees in preorder. */
  created: ObjectId[];
  /** Every removed object, subtrees in preorder. */
  removed: ObjectId[];
  boardsCreated: BoardId[];
  boardsRemoved: BoardId[];
  /** One entry per cell effect, explicit same-value writes included. */
  writtenCells: WrittenCell[];
  /** One entry per per-cell visibility change. */
  visibility: { object: ObjectId; cell: string }[];
  moved: MovedObject[];
  /** The union of every effect's `changedCells`, each once, in first-seen order. */
  changedCells: CellKey[];
  /** Every object with a `field: "actions"` effect, each once, in first-seen order. */
  actionsChanged: ObjectId[];
}

/** Builds a ChangeSummary one effect at a time, each against the state before it. */
export class SummaryBuilder {
  readonly #summary: ChangeSummary = {
    created: [],
    removed: [],
    boardsCreated: [],
    boardsRemoved: [],
    writtenCells: [],
    visibility: [],
    moved: [],
    changedCells: [],
    actionsChanged: [],
  };
  readonly #changed = new Set<CellKey>();

  /** Records `effect`; `stateBefore` is the document just before it applies. */
  add(effect: Effect, stateBefore: DocState): void {
    const s = this.#summary;
    const changed = changedCells(effect, stateBefore);
    for (const k of changed) {
      if (!this.#changed.has(k)) {
        this.#changed.add(k);
        s.changedCells.push(k);
      }
    }
    switch (effect.type) {
      case "cell":
        s.writtenCells.push({
          object: effect.object,
          cell: effect.cell,
          before: structuredClone(effect.before),
          after: structuredClone(effect.after),
        });
        return;
      case "cell_visibility":
        s.visibility.push({ object: effect.object, cell: effect.cell });
        return;
      case "place":
        s.moved.push({
          object: effect.object,
          from: { ...effect.before },
          to: { ...effect.after },
          derived: changed,
        });
        return;
      case "create":
        s.created.push(...effect.objects.map((o) => o.id));
        return;
      case "remove":
        s.removed.push(...effect.objects.map((o) => o.id));
        return;
      case "board":
        if (effect.before === null && effect.after !== null) s.boardsCreated.push(effect.after.id);
        if (effect.after === null && effect.before !== null) s.boardsRemoved.push(effect.before.id);
        return;
      case "field":
        if (effect.field === "actions" && !s.actionsChanged.includes(effect.object)) {
          s.actionsChanged.push(effect.object);
        }
        return;
      case "reorder":
      case "allocate":
      case "retire":
        return;
    }
  }

  /** A copy of the summary so far. */
  build(): ChangeSummary {
    return structuredClone(this.#summary);
  }
}
