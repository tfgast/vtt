/**
 * Hit testing on a scene (DESIGN.md §4.3 tolerance, §4.4 covers, §4.6 On the
 * canvas: hit order, Alt+click cycles; review r1 finding 6; M6-D10).
 * Footprints use the schema geometry the authority uses (`pointInRegion`).
 */
import { type Bounds, type ObjectId, type Point, pointInRegion } from "@vtt/schema";
import { type Camera, cameraScale } from "./camera";
import type { DrawItem, Scene } from "./scene";

/** A shapeless object is hit within this many screen pixels of its anchor. */
export const HIT_SLOP_PX = 6;

/** Whether board point `point` lies inside any of the scene's covers. */
export function isCovered(scene: Scene, point: Point): boolean {
  return scene.covers.some(
    (c) => c.wholeBoard || pointInRegion(point, c.shape, c.anchor, c.rotation),
  );
}

function contains(item: DrawItem, point: Point, camera: Camera): boolean {
  if (item.shape !== null) return pointInRegion(point, item.shape, item.anchor, item.rotation);
  const distance = Math.hypot(point[0] - item.anchor[0], point[1] - item.anchor[1]);
  return distance * cameraScale(camera) <= HIT_SLOP_PX;
}

function encloses(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.maxX >= inner.maxX &&
    outer.minY <= inner.minY &&
    outer.maxY >= inner.maxY
  );
}

/**
 * The scene's items for which `keep` holds, in hit order (DESIGN.md §4.6 On
 * the canvas, M6-D10): three buckets, each by descending z then descending
 * draw index. First the non-zones that are not backdrops, then the zones,
 * then the backdrops: non-zones whose bounding rect contains the bounding
 * rect of at least one kept zone. So a token in a room comes before the
 * room, and the room before the map it lies on, whatever their z.
 */
export function hitOrder(scene: Scene, keep: (item: DrawItem) => boolean): DrawItem[] {
  const hits: { item: DrawItem; index: number }[] = [];
  scene.items.forEach((item, index) => {
    if (keep(item)) hits.push({ item, index });
  });
  hits.sort((a, b) => {
    if (a.item.z !== b.item.z) return a.item.z > b.item.z ? -1 : 1;
    return b.index - a.index;
  });
  const sorted = hits.map((h) => h.item);
  const zones = sorted.filter((item) => item.isZone);
  const backdrop = (item: DrawItem) => zones.some((zone) => encloses(item.bounds, zone.bounds));
  const others = sorted.filter((item) => !item.isZone);
  return [...others.filter((item) => !backdrop(item)), ...zones, ...others.filter(backdrop)];
}

function topmostFirst(scene: Scene, keep: (item: DrawItem) => boolean): ObjectId[] {
  return hitOrder(scene, keep).map((item) => item.id);
}

/**
 * Every item whose footprint contains board point `point`, in `hitOrder`;
 * empty when the point lies in a cover.
 */
export function hitsAt(scene: Scene, point: Point, camera: Camera): ObjectId[] {
  if (isCovered(scene, point)) return [];
  return topmostFirst(scene, (item) => contains(item, point, camera));
}

/** The first entry of `hitsAt`, or null. */
export function hitTest(scene: Scene, point: Point, camera: Camera): ObjectId | null {
  return hitsAt(scene, point, camera)[0] ?? null;
}

/**
 * Items whose bounds lie inside board rectangle `rect` (its corners in any
 * order), in `hitOrder`.
 */
export function marqueeHit(scene: Scene, rect: Bounds): ObjectId[] {
  const minX = Math.min(rect.minX, rect.maxX);
  const maxX = Math.max(rect.minX, rect.maxX);
  const minY = Math.min(rect.minY, rect.maxY);
  const maxY = Math.max(rect.minY, rect.maxY);
  return topmostFirst(
    scene,
    ({ bounds: b }) => b.minX >= minX && b.maxX <= maxX && b.minY >= minY && b.maxY <= maxY,
  );
}
