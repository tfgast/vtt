/**
 * Visibility (DESIGN.md §4.4; FIXTURES.md §7 `object_visible`, `cell_visible`):
 * who can see an object and each of its cells. Every evaluated input fails
 * closed; the GM sees everything that exists.
 *
 * Evaluation and cover geometry are supplied: `reader` gives a cell's current
 * value with structural defaults applied, `cover` the opaque zones over an
 * object. This module only composes the rules.
 */
import { toViewers } from "@vtt/formula";
import type { ObjectId, Result } from "@vtt/schema";
import type { DocView } from "./store/document-store";

/** Who is looking: the GM, or a character (an object with `is_character`). */
export type Viewer = { type: "gm" } | { type: "character"; id: ObjectId };

/** The current evaluated value of a cell, with structural defaults applied. */
export interface VisibilityReader {
  value(obj: ObjectId, cell: string): Result;
}

/**
 * Opaque zones over an object's anchor on its board. `covering`: zones whose
 * region contains the anchor and whose `opaque` is true. `undetermined`: zones
 * on that board whose `opaque`, `is_zone` or geometry could not be evaluated
 * to valid values.
 */
export interface CoverResult {
  covering: ObjectId[];
  undetermined: ObjectId[];
}

export interface CoverOracle {
  opaqueZonesCovering(obj: ObjectId): CoverResult;
}

/**
 * Cells a face-down object still shows to anyone who can see the object: its
 * back, its placement, and its name. Per-cell visibility still applies.
 */
export const FACE_DOWN_EXEMPT: readonly string[] = Object.freeze([
  "name",
  "board",
  "position",
  "rotation",
  "z",
  "container",
  "face_up",
  "shape",
]);

export class Visibility {
  readonly #store: DocView;
  readonly #reader: VisibilityReader;
  readonly #cover: CoverOracle;

  constructor(store: DocView, reader: VisibilityReader, cover: CoverOracle) {
    this.#store = store;
    this.#reader = reader;
    this.#cover = cover;
  }

  /**
   * Whether the viewer set `value` (converted with `toViewers`; a failed
   * conversion admits nobody) admits `viewer`, resolving `owner` against
   * `holder`'s `owner` cell.
   */
  viewerSetAdmits(value: Result, viewer: Viewer, holder: ObjectId): boolean {
    if (viewer.type === "gm") return true;
    if (!this.#isCharacter(viewer.id)) return false;
    const set = toViewers(value);
    if (set.type !== "viewers") return false;
    return set.viewers.some((entry) => {
      if (entry === "all") return true;
      if (entry === "gm") return false;
      if (entry === "owner") return this.#isOwner(viewer.id, holder);
      return entry.object === viewer.id;
    });
  }

  /** Its own `visible_to` admits the viewer, and so does its container's, recursively. */
  isEffectivelyVisible(viewer: Viewer, obj: ObjectId): boolean {
    if (!this.#store.hasObject(obj)) return false;
    if (viewer.type === "gm") return true;
    if (!this.#isCharacter(viewer.id)) return false;
    const seen = new Set<ObjectId>();
    for (let o: ObjectId | null = obj; o !== null; o = this.#store.containerOf(o)) {
      if (seen.has(o)) return false;
      seen.add(o);
      if (!this.viewerSetAdmits(this.#reader.value(o, "visible_to"), viewer, o)) return false;
    }
    return true;
  }

  /**
   * Whether an opaque zone the viewer cannot effectively see covers the object
   * (or its outermost container), including zones whose cover could not be
   * determined. Independent of `z`; a zone never covers itself.
   */
  isCovered(viewer: Viewer, obj: ObjectId): boolean {
    if (!this.#store.hasObject(obj)) return true;
    if (viewer.type === "gm") return false;
    if (!this.#isCharacter(viewer.id)) return true;
    const root = this.#root(obj);
    if (root === null) return true;
    if (this.#store.boardOf(root) === null) return false;
    const { covering, undetermined } = this.#cover.opaqueZonesCovering(root);
    return [...covering, ...undetermined].some(
      (zone) => zone !== root && !this.isEffectivelyVisible(viewer, zone),
    );
  }

  /** `object_visible`: effectively visible and not covered. */
  canSeeObject(viewer: Viewer, obj: ObjectId): boolean {
    return this.isEffectivelyVisible(viewer, obj) && !this.isCovered(viewer, obj);
  }

  /**
   * `cell_visible`: the object is visible, its `cell_visibility` entry for the
   * cell (if any) admits the viewer, and, unless the cell is exempt, a
   * face-down object shows it only to its owner.
   */
  canSeeCell(viewer: Viewer, obj: ObjectId, cell: string): boolean {
    if (!this.canSeeObject(viewer, obj)) return false;
    if (viewer.type === "gm") return true;
    const entry = this.#store.getCellVisibility(obj, cell);
    if (entry !== undefined && !this.viewerSetAdmits(entry as Result, viewer, obj)) return false;
    if (FACE_DOWN_EXEMPT.includes(cell)) return true;
    const faceUp = this.#reader.value(obj, "face_up");
    if (faceUp.type === "boolean" && faceUp.value) return true;
    return this.#isOwner(viewer.id, obj);
  }

  #isCharacter(id: ObjectId): boolean {
    return this.#store.getObject(id)?.is_character === true;
  }

  /** Whether `holder`'s `owner` evaluates to a ref to character `id`. */
  #isOwner(id: ObjectId, holder: ObjectId): boolean {
    const owner = this.#reader.value(holder, "owner");
    return owner.type === "ref" && owner.object === id && this.#isCharacter(id);
  }

  /** `obj` if on a board, else its outermost container; null on a containment cycle. */
  #root(obj: ObjectId): ObjectId | null {
    const seen = new Set<ObjectId>();
    let o = obj;
    for (;;) {
      if (this.#store.boardOf(o) !== null) return o;
      const parent = this.#store.containerOf(o);
      if (parent === null) return o;
      if (seen.has(o)) return null;
      seen.add(o);
      o = parent;
    }
  }
}
