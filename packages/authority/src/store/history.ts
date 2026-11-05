/**
 * The operation log (DESIGN.md §7): retained groups under absolute indices,
 * the undo barrier, compaction, and the history invariants checked on load.
 */
import type { OpGroup, TableLog } from "@vtt/schema";

/** One violation of the history invariants of DESIGN.md §7. */
export type HistoryViolation =
  /** The group at `position` has index `actual`, not `expected`. */
  | { type: "index"; position: number; expected: number; actual: number; message: string }
  /** `revision` is not `base_revision` + 1. */
  | { type: "revision_step"; index: number; message: string }
  /** `base_revision` is not the previous group's `revision`. */
  | { type: "revision_chain"; index: number; expected: number; actual: number; message: string }
  /** `kind` is `undo` without `undoes`, or `undoes` is present on another kind. */
  | { type: "undo_kind"; index: number; message: string }
  /** `undoes` is not an earlier index, or names a retained undo group. */
  | { type: "undo_target"; index: number; undoes: number; message: string }
  /** `undoes` names an index an earlier group already undoes. */
  | { type: "double_undo"; index: number; undoes: number; message: string }
  /** `undo_barrier` is outside `first_index` … the next index. */
  | { type: "barrier"; undo_barrier: number; message: string }
  /** The last retained group's revision differs from the snapshot's. */
  | { type: "snapshot_revision"; expected: number; actual: number; message: string };

export interface HistoryLoadOptions {
  /** The file was edited by hand: the snapshot wins over the log's last revision. */
  editedExternally: boolean;
}

/** Every violation of the history invariants in `log`, in log order; empty when valid. */
export function validateHistory(
  log: TableLog,
  snapshotRevision: number,
  { editedExternally }: HistoryLoadOptions,
): HistoryViolation[] {
  const out: HistoryViolation[] = [];
  const { first_index: first, groups, undo_barrier: barrier } = log;
  const byIndex = new Map(groups.map((g) => [g.index, g] as const));
  const undoneBy = new Map<number, number>();

  groups.forEach((g, position) => {
    const expected = first + position;
    if (g.index !== expected) {
      out.push({
        type: "index",
        position,
        expected,
        actual: g.index,
        message: `group at position ${position} has index ${g.index}, expected ${expected}`,
      });
    }
    if (g.revision !== g.base_revision + 1) {
      out.push({
        type: "revision_step",
        index: g.index,
        message: `group ${g.index} goes from revision ${g.base_revision} to ${g.revision}`,
      });
    }
    const prev = groups[position - 1];
    if (prev !== undefined && g.base_revision !== prev.revision) {
      out.push({
        type: "revision_chain",
        index: g.index,
        expected: prev.revision,
        actual: g.base_revision,
        message: `group ${g.index} is based on revision ${g.base_revision}, but group ${prev.index} produced ${prev.revision}`,
      });
    }
    if ((g.kind === "undo") !== (g.undoes !== undefined)) {
      out.push({
        type: "undo_kind",
        index: g.index,
        message:
          g.kind === "undo"
            ? `undo group ${g.index} has no undoes`
            : `${g.kind} group ${g.index} has undoes`,
      });
    }
    if (g.undoes === undefined) return;
    const target = g.undoes;
    if (target >= g.index) {
      out.push({
        type: "undo_target",
        index: g.index,
        undoes: target,
        message: `group ${g.index} undoes ${target}, which is not earlier`,
      });
    } else if (target >= first && byIndex.get(target)?.kind === "undo") {
      out.push({
        type: "undo_target",
        index: g.index,
        undoes: target,
        message: `group ${g.index} undoes ${target}, which is an undo group`,
      });
    }
    const earlier = undoneBy.get(target);
    if (earlier !== undefined) {
      out.push({
        type: "double_undo",
        index: g.index,
        undoes: target,
        message: `group ${g.index} undoes ${target}, already undone by group ${earlier}`,
      });
    } else {
      undoneBy.set(target, g.index);
    }
  });

  const next = first + groups.length;
  if (barrier < first || barrier > next) {
    out.push({
      type: "barrier",
      undo_barrier: barrier,
      message: `undo_barrier ${barrier} is outside ${first} … ${next}`,
    });
  }
  const last = groups.at(-1);
  if (last !== undefined && !editedExternally && last.revision !== snapshotRevision) {
    out.push({
      type: "snapshot_revision",
      expected: snapshotRevision,
      actual: last.revision,
      message: `the last group produced revision ${last.revision}, but the snapshot is at ${snapshotRevision}`,
    });
  }
  return out;
}

/** A refused restore, with every violation found. */
export class HistoryError extends Error {
  readonly violations: HistoryViolation[];

  constructor(violations: HistoryViolation[]) {
    super(`invalid history: ${violations.map((v) => v.message).join("; ")}`);
    this.name = "HistoryError";
    this.violations = violations;
  }
}

/**
 * The only owner of the log. Indices are absolute and stable across
 * compaction; `nextIndex` is `firstIndex` + the retained count. Groups below
 * `undoBarrier` are record only. The barrier is never lowered except by
 * `restore`.
 */
export class History {
  #first = 0;
  #groups: OpGroup[] = [];
  #barrier = 0;
  /** Target index → the retained undo group that undoes it. */
  #undoneBy = new Map<number, number>();

  get firstIndex(): number {
    return this.#first;
  }

  get nextIndex(): number {
    return this.#first + this.#groups.length;
  }

  get undoBarrier(): number {
    return this.#barrier;
  }

  /** The retained groups, oldest first. */
  groups(): readonly OpGroup[] {
    return this.#groups;
  }

  /** The retained group at absolute `index`, or undefined. */
  get(index: number): OpGroup | undefined {
    return index >= this.#first ? this.#groups[index - this.#first] : undefined;
  }

  /** Whether a retained undo group undoes `index`. */
  isUndone(index: number): boolean {
    return this.#undoneBy.has(index);
  }

  /**
   * Appends a group under index `nextIndex` and returns it. Refuses an undo
   * group (or `undoes`) that breaks the undo invariants; revision chaining is
   * the caller's.
   */
  append(group: Omit<OpGroup, "index"> | OpGroup): OpGroup {
    const index = this.nextIndex;
    const g: OpGroup = { ...group, index };
    if ((g.kind === "undo") !== (g.undoes !== undefined)) {
      throw new Error(`group ${index}: kind "undo" exactly when undoes is present`);
    }
    if (g.undoes !== undefined) {
      if (g.undoes >= index) throw new Error(`group ${index} undoes a later index ${g.undoes}`);
      if (this.get(g.undoes)?.kind === "undo") {
        throw new Error(`group ${index} undoes undo group ${g.undoes}`);
      }
      if (this.#undoneBy.has(g.undoes)) {
        throw new Error(`group ${index} undoes ${g.undoes}, which is already undone`);
      }
      this.#undoneBy.set(g.undoes, index);
    }
    this.#groups.push(g);
    return g;
  }

  /**
   * Replaces the history with a loaded log, or throws HistoryError when it
   * violates the invariants (and changes nothing). After a hand edit the
   * barrier is raised to the next index, so every retained group stays as
   * record (DESIGN.md §7, The file).
   */
  restore(log: TableLog, snapshotRevision: number, options: HistoryLoadOptions): void {
    const violations = validateHistory(log, snapshotRevision, options);
    if (violations.length > 0) throw new HistoryError(violations);
    this.#first = log.first_index;
    this.#groups = structuredClone(log.groups);
    this.#barrier = options.editedExternally ? this.nextIndex : log.undo_barrier;
    this.#undoneBy = new Map();
    for (const g of this.#groups) if (g.undoes !== undefined) this.#undoneBy.set(g.undoes, g.index);
  }

  /**
   * Keeps the last `keepLast` groups with their indices, advances
   * `firstIndex`, and raises the barrier to at least `firstIndex`.
   */
  compact(keepLast: number): void {
    if (!Number.isInteger(keepLast) || keepLast < 0) throw new Error(`bad keepLast ${keepLast}`);
    const drop = Math.max(0, this.#groups.length - keepLast);
    for (const g of this.#groups.slice(0, drop)) {
      if (g.undoes !== undefined) this.#undoneBy.delete(g.undoes);
    }
    this.#groups = this.#groups.slice(drop);
    this.#first += drop;
    this.#barrier = Math.max(this.#barrier, this.#first);
  }

  /** Raises the barrier to `index` if higher; refuses one past the next index. */
  raiseBarrier(index: number): void {
    if (index > this.nextIndex) {
      throw new Error(`barrier ${index} is past the next index ${this.nextIndex}`);
    }
    this.#barrier = Math.max(this.#barrier, index);
  }

  /** The log as the file stores it. */
  toLog(): TableLog {
    return {
      first_index: this.#first,
      groups: structuredClone(this.#groups),
      undo_barrier: this.#barrier,
    };
  }
}
