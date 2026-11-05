/**
 * Comparisons of stored state (DESIGN.md §7, Replay and rewind): two
 * snapshots compared in canonical form. The revision is excluded by default;
 * identity (`next_seq` and `retired_ids`) only when asked.
 */
import type { Snapshot } from "@vtt/schema";
import { canonicalSnapshot } from "./document-store";

export interface StoredStateCompareOptions {
  /** Leave out `revision`. Default true. */
  ignoreRevision?: boolean;
  /** Leave out `next_seq` and `retired_ids`. Default false. */
  ignoreIdentity?: boolean;
}

function comparable(s: Snapshot, o: StoredStateCompareOptions): Record<string, unknown> {
  const { revision, next_seq, retired_ids, ...rest } = canonicalSnapshot(s);
  return {
    ...((o.ignoreRevision ?? true) ? {} : { revision }),
    ...rest,
    ...((o.ignoreIdentity ?? false) ? {} : { next_seq, retired_ids }),
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const show = (x: unknown): string => {
  if (x === undefined) return "(absent)";
  const json = JSON.stringify(x);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
};

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) diff(a[k], b[k], path === "" ? k : `${path}.${k}`, out);
    return;
  }
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return;
  out.push(`${path === "" ? "(root)" : path}: ${show(a)} ≠ ${show(b)}`);
}

/**
 * Every difference between the stored states of `a` and `b`, one message per
 * differing leaf, `path: a ≠ b`, in path order. Keys whose value is
 * undefined count as absent. Empty when they are equal.
 */
export function diffStoredState(
  a: Snapshot,
  b: Snapshot,
  options: StoredStateCompareOptions = {},
): string[] {
  const out: string[] = [];
  diff(comparable(a, options), comparable(b, options), "", out);
  return out;
}

/** Whether `a` and `b` hold the same stored state. */
export function storedStateEqual(
  a: Snapshot,
  b: Snapshot,
  options: StoredStateCompareOptions = {},
): boolean {
  return diffStoredState(a, b, options).length === 0;
}
