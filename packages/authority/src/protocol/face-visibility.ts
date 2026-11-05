/**
 * Face element visibility (PROTOCOL.md §7.2; FIXTURES.md §7 `face_element`;
 * review r2 finding 11, review r3 finding 6): the one predicate the direct
 * fixture runner, the protocol runner and live views share.
 */
import type { ObjectId } from "@vtt/schema";
import type { Table } from "../engine/table";
import type { Viewer } from "../visibility";
import { ViewBuilder } from "./views";

/** A face element by its stored position: `list` `"full"` is `elements`, `"collapsed"` is `collapsed`. */
export interface FaceElementRef {
  list: "full" | "collapsed";
  index: number;
}

/**
 * True exactly when the viewer's live object view of `object` (built by
 * `ViewBuilder.objectView` with every cell) has a face element in that list
 * with that stored `index` and `shown === true`. False when the object is
 * absent from the view (nonexistent, invisible, covered), has no layout or
 * no such list, or the element is absent or not shown.
 */
export function faceElementVisible(
  table: Table,
  viewer: Viewer,
  object: ObjectId,
  element: FaceElementRef,
): boolean {
  const face = new ViewBuilder(table, viewer).objectView(object, "all")?.face;
  const list = element.list === "full" ? face?.elements : face?.collapsed;
  return list?.some((e) => e.index === element.index && e.shown === true) ?? false;
}
