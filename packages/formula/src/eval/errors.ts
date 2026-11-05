/**
 * Error propagation (FORMULAS.md §2.3): the first error in evaluation order
 * wins, an error keeps the origin it was first given, and lists never
 * contain errors.
 */
import {
  type ErrorOrigin,
  type ErrorValue,
  isError,
  list,
  type Result,
  type Value,
} from "@vtt/schema";

/** The first error among `results`, in argument order, or `undefined` if none. */
export function firstError(...results: Result[]): ErrorValue | undefined {
  for (const r of results) if (isError(r)) return r;
  return undefined;
}

/**
 * `error` with `origin` set, if it has none yet. An error that already has an
 * origin is returned unchanged: the origin is where it was first raised.
 */
export function withOrigin(error: ErrorValue, origin: ErrorOrigin): ErrorValue {
  if (error.origin !== undefined) return error;
  return { ...error, origin };
}

/**
 * A list built from `items`, or the first error among them in list order.
 * This is the only way a list is built from results, so lists never contain
 * errors.
 */
export function collectList(items: readonly Result[]): Result {
  const values: Value[] = [];
  for (const item of items) {
    if (isError(item)) return item;
    values.push(item);
  }
  return list(values);
}
