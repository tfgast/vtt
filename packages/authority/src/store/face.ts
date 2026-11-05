/**
 * The face primitive (DESIGN.md §4.6 "Face layouts", §7; PROTOCOL.md §5;
 * M5-D7): `setFace` replaces an object's whole layout in one field effect.
 */
import {
  type FaceLayout,
  FaceLayoutSchema,
  faceProblem,
  type ObjectId,
  type TableObject,
} from "@vtt/schema";
import type { Transaction } from "./transaction";
import { Rejected } from "./transaction";

function invalid(message: string): never {
  throw new Rejected({ type: "invalid", message });
}

/**
 * Replaces the object's face layout (`null` removes it) with one
 * `field: "face"` effect, touching `face:<object>`. Refused `invalid` for an
 * unknown object, a malformed layout, or a `faceProblem`. Changes no
 * readable cell. Stores a checked copy, never the caller's layout.
 */
export function setFace(tx: Transaction, obj: ObjectId, face: FaceLayout | null): void {
  const o = tx.doc.getObject(obj) as TableObject | undefined;
  if (o === undefined) invalid(`no object "${String(obj)}"`);
  let after: FaceLayout | null = null;
  if (face !== null) {
    const parsed = FaceLayoutSchema.safeParse(face);
    if (!parsed.success)
      invalid(`the face of "${obj}" is not a face layout: ${parsed.error.message}`);
    const problem = faceProblem(parsed.data);
    if (problem !== undefined) invalid(`the face of "${obj}": ${problem}`);
    after = structuredClone(parsed.data);
  }
  const before = o.face === undefined ? null : structuredClone(o.face);
  tx.record({ type: "field", object: obj, field: "face", before, after });
}
