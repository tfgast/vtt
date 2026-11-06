/**
 * The opaque-cover query (DESIGN.md §4.4, cover and fail closed; FORMULAS.md
 * §6): which zones cover an object's anchor, for `Visibility`.
 *
 * For the object's board (or its outermost container's), the zones
 * considered are every `is_zone` candidate of the spatial index for the
 * anchor's point box (which already includes every object with formula
 * geometry), every zone on the board whose `opaque` holds a formula, and,
 * defensively, every zone the index could not place by literal geometry.
 * Each zone's `is_zone`, `opaque`, `position`, `rotation` and `shape` are
 * read through the reader (the engine). An `opaque` that is an error of any
 * code or not a boolean is treated as opaque (fail closed), so such a zone
 * covers exactly its region, like one whose `opaque` is true. A zone that is
 * opaque (so treated or true), with valid geometry and the anchor in its
 * region (`pointInRegion`), is `covering`. A zone whose `is_zone`,
 * `position`, `rotation` or `shape` read is an error or of the wrong type is
 * `undetermined` (fail closed): its region is unknown. A zone never covers
 * itself.
 *
 * When the object's own anchor cannot be read as two finite numbers, every
 * zone on the board that might be opaque (valid geometry with `opaque` true
 * or treated as opaque, or any invalid geometry read) is `undetermined`.
 */
import { anchorOf, geometryNumber } from "@vtt/formula";
import { type ObjectId, type Point, pointInRegion, type Result, type Shape } from "@vtt/schema";
import type { SpatialIndex } from "../spatial/index";
import type { DocView } from "../store/document-store";
import type { CoverOracle, CoverResult, VisibilityReader } from "../visibility";

/** What the cover query reads from the store's committed document. */
export type CoverSource = Pick<
  DocView,
  "revision" | "getObject" | "getCell" | "boardOf" | "containerOf"
>;

/** A zone's evaluated geometry, or "invalid" when a geometry read failed. */
type ZoneRead =
  | { opaque: boolean; anchor: Point; rotation: number; shape: Shape | null }
  | "invalid";

/** A rotation as the evaluator reads it: a number, empty as 0, a roll as its total. */
function rotationOf(r: Result): number | undefined {
  const n = geometryNumber(r);
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

export class EngineCover implements CoverOracle {
  readonly #doc: CoverSource;
  readonly #index: Pick<SpatialIndex, "candidates" | "objectsOnBoard">;
  readonly #reader: VisibilityReader;
  /** Per board, at one revision: zones always considered whatever the anchor. */
  #always: { revision: number; byBoard: Map<ObjectId, ObjectId[]> } = {
    revision: -1,
    byBoard: new Map(),
  };

  constructor(
    doc: CoverSource,
    index: Pick<SpatialIndex, "candidates" | "objectsOnBoard">,
    reader: VisibilityReader,
  ) {
    this.#doc = doc;
    this.#index = index;
    this.#reader = reader;
  }

  opaqueZonesCovering(obj: ObjectId): CoverResult {
    const out: CoverResult = { covering: [], undetermined: [] };
    const root = this.#root(obj);
    const board = root === null ? null : this.#doc.boardOf(root);
    if (root === null || board === null) return out;
    const anchor = anchorOf(this.#reader.value(root, "position"));
    const considered = new Set<ObjectId>(
      anchor === undefined
        ? this.#zonesOn(board)
        : [
            ...this.#index
              .candidates(board, {
                minX: anchor[0],
                minY: anchor[1],
                maxX: anchor[0],
                maxY: anchor[1],
              })
              .filter((id) => this.#doc.getObject(id)?.is_zone === true),
            ...this.#alwaysConsidered(board),
          ],
    );
    considered.delete(root);
    for (const zone of considered) {
      const z = this.#readZone(zone);
      if (z === "invalid") {
        out.undetermined.push(zone);
        continue;
      }
      // A shapeless zone has no region and covers nothing.
      if (!z.opaque || z.shape === null) continue;
      if (anchor === undefined) out.undetermined.push(zone);
      else if (pointInRegion(anchor, z.shape, z.anchor, z.rotation)) out.covering.push(zone);
    }
    return out;
  }

  /** `obj` if on a board, else its outermost container; null on a containment cycle. */
  #root(obj: ObjectId): ObjectId | null {
    const seen = new Set<ObjectId>();
    let o = obj;
    for (;;) {
      if (this.#doc.boardOf(o) !== null) return o;
      const parent = this.#doc.containerOf(o);
      if (parent === null) return o;
      if (seen.has(o)) return null;
      seen.add(o);
      o = parent;
    }
  }

  /** Every zone placed directly on `board` (`is_zone` is a field, never a formula). */
  #zonesOn(board: ObjectId): ObjectId[] {
    return this.#index
      .objectsOnBoard(board)
      .filter((id) => this.#doc.getObject(id)?.is_zone === true);
  }

  /**
   * Zones on `board` considered whatever the anchor: those whose `opaque`
   * holds a formula, and those whose literal position the index cannot
   * place. Cached for the current revision.
   */
  #alwaysConsidered(board: ObjectId): ObjectId[] {
    if (this.#always.revision !== this.#doc.revision) {
      this.#always = { revision: this.#doc.revision, byBoard: new Map() };
    }
    let ids = this.#always.byBoard.get(board);
    if (ids === undefined) {
      ids = this.#zonesOn(board).filter((id) => {
        const opaque = this.#doc.getCell(id, "opaque");
        if (opaque?.content.type === "formula") return true;
        const p = this.#doc.getCell(id, "position");
        return p === undefined || anchorOf((p.override ?? p.content) as Result) === undefined;
      });
      this.#always.byBoard.set(board, ids);
    }
    return ids;
  }

  /**
   * Reads a zone through the reader; "invalid" when `is_zone` or a geometry
   * read is an error or the wrong type. An erroneous or non-boolean `opaque`
   * reads as opaque (DESIGN.md §4.4).
   */
  #readZone(zone: ObjectId): ZoneRead {
    const read = (cell: string) => this.#reader.value(zone, cell);
    const isZone = read("is_zone");
    const opaque = read("opaque");
    const anchor = anchorOf(read("position"));
    const rotation = rotationOf(read("rotation"));
    const shape = read("shape");
    if (isZone.type !== "boolean") return "invalid";
    if (anchor === undefined || rotation === undefined) return "invalid";
    if (shape.type !== "shape" && shape.type !== "empty") return "invalid";
    return {
      opaque: isZone.value && (opaque.type !== "boolean" || opaque.value),
      anchor,
      rotation,
      shape: shape.type === "shape" ? shape.shape : null,
    };
  }
}
