/**
 * Which listed assets the table still references (DESIGN.md §7, Revisions
 * and assets; M6-D32), for collecting the rest on command. An image cell
 * names its asset by the path the file lists (M4-D2), but a path can reach
 * a cell in other ways too: inside a list value, an override, a formula's
 * or an action's source text, or a face. So the scan is deliberately
 * coarse: a listed path is referenced when any string anywhere in a live
 * object (its cells' contents and overrides, actions, face, tags) or in any
 * effect of any retained log group (both `before` and `after`, created and
 * removed subtrees, undo groups included) contains it. A false positive only
 * keeps a file; a false negative would lose one an undo could restore.
 */
import type { DocumentStore } from "../store/document-store";

/**
 * The paths of `assets` that a string in `store`'s live objects or retained
 * groups' effects contains, in `assets` order.
 */
export function referencedAssets(store: DocumentStore, assets: readonly string[]): string[] {
  const pending = new Set(assets.filter((a) => a !== ""));
  const visit = (x: unknown): void => {
    if (pending.size === 0) return;
    if (typeof x === "string") {
      for (const asset of pending) if (x.includes(asset)) pending.delete(asset);
    } else if (Array.isArray(x)) {
      for (const item of x) visit(item);
    } else if (typeof x === "object" && x !== null) {
      for (const value of Object.values(x)) visit(value);
    }
  };
  for (const id of store.objectIds()) visit(store.getObject(id));
  for (const group of store.history.groups()) visit(group.effects);
  return assets.filter((a) => a !== "" && !pending.has(a));
}
