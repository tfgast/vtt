/**
 * MCP change records and buffers (PROTOCOL.md §11 change records; §8 mirror
 * revision): a subscription's client events (`delta`, `resync`, `error`)
 * become `ChangeRecord`s in a bounded per-handle `ChangeBuffer`, which
 * `poll_changes` takes and the `vtt://subscriptions/<handle>` resource reads
 * (vtt-5su.15).
 */
import type {
  ActionView,
  CellView,
  DeltaEvent,
  GroupHeader,
  ObjectView,
  ProtocolErrorCode,
  Subscription,
} from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";

/** The buffer's capacity per subscription (PROTOCOL.md §11). */
export const CHANGE_BUFFER_LIMIT = 1000;

/** The facts of an object view that are neither cells nor its id. */
export type ObjectFacts = { is_template: boolean; is_character: boolean; actions: ActionView[] };

export type CellChange = { object: ObjectId; cell: string; before?: CellView; after?: CellView };
export type ObjectChange = { object: ObjectId; before?: ObjectFacts; after?: ObjectFacts };

export type CommitRecord = {
  type: "commit";
  revision: number;
  group: GroupHeader;
  created: ObjectId[];
  removed: ObjectId[];
  cells: CellChange[];
  objects: ObjectChange[];
};
export type ResyncRecord = {
  type: "resync";
  from_revision: number;
  to_revision: number;
  session_changed: boolean;
};
/** The subscription became terminal (§8). */
export type FailedRecord = { type: "failed"; code: ProtocolErrorCode; message: string };
export type ChangeRecord = CommitRecord | ResyncRecord | FailedRecord;

/** `{code, message}` of a failed subscription. */
export type SubscriptionFailure = { code: ProtocolErrorCode; message: string };

/** The `ObjectFacts` of a view. */
export function objectFacts(view: ObjectView): ObjectFacts {
  return { is_template: view.is_template, is_character: view.is_character, actions: view.actions };
}

/** Structural equality of JSON-like values; object key order is ignored. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((x, i) => same(x, other[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(rb, k) && same(ra[k], rb[k]));
}

/** `{...base, before?, after?}` with only the sides that are present. */
function sides<B extends object, T>(base: B, before: T | undefined, after: T | undefined) {
  return {
    ...base,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

/**
 * The commit record of one delta event (PROTOCOL.md §11): `created` and
 * `removed` are the delta's ids absent before and after; `cells` every cell
 * whose `CellView` differs (one side only when the cell or object is absent
 * there), names sorted per object; `objects` every object whose
 * `ObjectFacts` differ, an object entering or leaving included. Objects keep
 * the delta's order (upserted views, then removed ids).
 */
export function commitRecord(event: DeltaEvent): CommitRecord {
  const ids = [...new Set([...event.delta.objects.map((v) => v.id), ...event.delta.removed])];
  const record: CommitRecord = {
    type: "commit",
    revision: event.revision,
    group: event.group,
    created: [],
    removed: [],
    cells: [],
    objects: [],
  };
  for (const id of ids) {
    const before = event.before.get(id);
    const after = event.after.get(id);
    if (before === undefined && after !== undefined) record.created.push(id);
    if (before !== undefined && after === undefined) record.removed.push(id);
    const names = new Set([
      ...Object.keys(before?.cells ?? {}),
      ...Object.keys(after?.cells ?? {}),
    ]);
    for (const cell of [...names].sort()) {
      const was = before?.cells[cell];
      const now = after?.cells[cell];
      if (!same(was, now)) record.cells.push(sides({ object: id, cell }, was, now));
    }
    const factsBefore = before && objectFacts(before);
    const factsAfter = after && objectFacts(after);
    if (!same(factsBefore, factsAfter)) {
      record.objects.push(sides({ object: id }, factsBefore, factsAfter));
    }
  }
  return record;
}

/**
 * A subscription's bounded record buffer (PROTOCOL.md §11): at most `limit`
 * records; beyond that the oldest is dropped and `overflowed` is set until
 * the next `take`.
 */
export class ChangeBuffer {
  readonly limit: number;
  #records: ChangeRecord[] = [];
  #overflowed = false;
  #failed: SubscriptionFailure | null = null;
  readonly #listeners = new Set<(record: ChangeRecord) => void>();

  constructor(limit = CHANGE_BUFFER_LIMIT) {
    this.limit = limit;
  }

  get size(): number {
    return this.#records.length;
  }

  /** Records were dropped since the last `take`. */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  /** `{code, message}` of the last `failed` record pushed, else null; kept after `take`. */
  get failed(): SubscriptionFailure | null {
    return this.#failed;
  }

  /** Appends `record`, dropping the oldest beyond the limit, then calls the push listeners. */
  push(record: ChangeRecord): void {
    this.#records.push(record);
    while (this.#records.length > this.limit) {
      this.#records.shift();
      this.#overflowed = true;
    }
    if (record.type === "failed") this.#failed = { code: record.code, message: record.message };
    for (const fn of [...this.#listeners]) fn(record);
  }

  /** The buffered records, oldest first, without clearing. */
  records(): ChangeRecord[] {
    return [...this.#records];
  }

  /** Returns and clears the records and resets `overflowed`. */
  take(): { changes: ChangeRecord[]; overflowed: boolean } {
    const taken = { changes: this.#records, overflowed: this.#overflowed };
    this.#records = [];
    this.#overflowed = false;
    return taken;
  }

  /** Calls `fn` after every push; returns a function that removes it. */
  onPush(fn: (record: ChangeRecord) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }
}

/**
 * Feeds `buffer` from `sub`: one commit record per `delta`, one resync record
 * per `resync`, one failed record per `error`. Returns a function that
 * removes the three listeners.
 */
export function feedChanges(sub: Subscription, buffer: ChangeBuffer): () => void {
  const offs = [
    sub.on("delta", (_, event) => buffer.push(commitRecord(event))),
    sub.on("resync", (_, info) =>
      buffer.push({
        type: "resync",
        from_revision: info.from_revision,
        to_revision: info.to_revision,
        session_changed: info.session_changed,
      }),
    ),
    sub.on("error", (_, error) =>
      buffer.push({ type: "failed", code: error.code, message: error.message }),
    ),
  ];
  return () => {
    for (const off of offs) off();
  };
}
