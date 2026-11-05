/**
 * Dangling references (FORMULAS.md §2, §2.4): a reference to a deleted
 * object read from a cell, directly or inside a list or a viewers value,
 * makes the whole read `#REF`.
 */
import type { ObjectId, Result, Value } from "@vtt/schema";
import { err } from "@vtt/schema";

/** The first referenced object, depth first, for which `exists` is false. */
function findDangling(v: Value, exists: (id: ObjectId) => boolean): ObjectId | undefined {
  switch (v.type) {
    case "ref":
      return exists(v.object) ? undefined : v.object;
    case "list":
      for (const item of v.items) {
        const id = findDangling(item, exists);
        if (id !== undefined) return id;
      }
      return undefined;
    case "viewers":
      for (const entry of v.viewers) {
        if (typeof entry !== "string" && !exists(entry.object)) return entry.object;
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * `value` unchanged if every reference in it (directly, inside lists at any
 * depth, or inside a viewers value) names an existing object; `#REF`
 * otherwise. Checks stop at the first dangling reference. An error is
 * returned unchanged. This is the single helper every cell read goes
 * through; the engine records each `exists` call as a dependency.
 */
export function validateRefs(value: Result, exists: (id: ObjectId) => boolean): Result {
  if (value.type === "error") return value;
  const id = findDangling(value, exists);
  return id === undefined ? value : err("#REF", `reference to deleted object ${id}`);
}
