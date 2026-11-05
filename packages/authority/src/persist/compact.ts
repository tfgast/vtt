/** Log compaction (DESIGN.md §7, The file). */
import type { DocumentStore } from "../store/document-store";

/**
 * Keeps the last `keepLast` retained groups of `store`'s history with their
 * absolute indices, advancing `first_index` and raising the undo barrier to
 * at least it. Delegates to `History.compact`.
 */
export function compactLog(store: DocumentStore, keepLast: number): void {
  store.history.compact(keepLast);
}
