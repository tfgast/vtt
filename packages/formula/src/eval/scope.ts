/**
 * The evaluation scope (FORMULAS.md §3): which object `this` is, what `it`
 * is bound to, whether bare names read the item's cells, and which cell is
 * being evaluated (for error origins, §2.3).
 */
import type { ErrorOrigin, ObjectId, Value } from "@vtt/schema";

export interface Scope {
  /**
   * The object the formula lives on: `this`, and the owner of bare names.
   * Absent only for object-free ad hoc evaluation (FORMULAS.md §2), where
   * `this` is `#REF` and bare names outside a predicate are `#NAME`.
   */
  readonly thisId?: ObjectId;
  /**
   * The current item inside `where`, `sort`, or `objects`. Absent elsewhere,
   * where `it` is `#NAME`. Lists never hold errors, so the item is a value.
   */
  readonly it?: Value;
  /**
   * Inside a predicate (`where`, `sort`, `objects`): bare names resolve only
   * against the item's cells, never `this`'s, and are `#TYPE` when the item
   * is not a reference.
   */
  readonly itBindsNames?: boolean;
  /** The cell being evaluated on `thisId`; new errors take it as their origin. */
  readonly cell?: string;
}

/**
 * The scope for evaluating a predicate or sort key on `item`: `this` and the
 * cell are unchanged, `it` is the item (shadowing any outer `it`), and bare
 * names are the item's cells. Used by `where`, `sort`, and `objects`.
 */
export function itemScope(scope: Scope, item: Value): Scope {
  return { ...scope, it: item, itBindsNames: true };
}

/** The origin new errors get in `scope`, or `undefined` if it names no cell. */
export function scopeOrigin(scope: Scope): ErrorOrigin | undefined {
  if (scope.cell === undefined || scope.thisId === undefined) return undefined;
  return { object: scope.thisId, cell: scope.cell };
}
