/**
 * Unit tests of the MCP change buffers (vtt-5su.15; PROTOCOL.md §11 change
 * records): the commit record built from a subscription's `delta` event,
 * `ObjectFacts`, the bounded buffer and its overflow flag, and the feed from a
 * subscription's `delta`, `resync` and `error` events.
 */
import {
  CHANGE_BUFFER_LIMIT,
  ChangeBuffer,
  type ChangeRecord,
  commitRecord,
  feedChanges,
  objectFacts,
} from "@vtt/authority";
import type {
  CellView,
  DeltaEvent,
  GroupHeader,
  ObjectView,
  ProtocolError,
  ResyncInfo,
  Subscription,
} from "@vtt/protocol";
import { describe, expect, test } from "vitest";

const num = (value: number): CellView => ({ value: { type: "number", value }, kind: "literal" });

function view(id: string, rest: Partial<ObjectView> = {}): ObjectView {
  return { id, is_template: false, is_character: false, cells: {}, actions: [], ...rest };
}

const group: GroupHeader = {
  index: 4,
  revision: 9,
  actor: { type: "gm" },
  kind: "edit",
  label: null,
};

/** A delta event over `before` and `after` (absent entries are `undefined`). */
function deltaEvent(
  before: Record<string, ObjectView | undefined>,
  after: Record<string, ObjectView | undefined>,
): DeltaEvent {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const objects = ids.flatMap((id) => (after[id] ? [after[id]] : []));
  const removed = ids.filter((id) => !after[id]);
  return {
    revision: 9,
    group,
    delta: { subscription: "s1", objects, removed },
    before: new Map(ids.map((id) => [id, before[id]])),
    after: new Map(ids.map((id) => [id, after[id]])),
  };
}

const resync = (from: number, to: number): ChangeRecord => ({
  type: "resync",
  from_revision: from,
  to_revision: to,
  session_changed: false,
});

describe("commitRecord (PROTOCOL.md §11)", () => {
  test("a changed cell carries before and after; unchanged cells and objects are omitted", () => {
    const record = commitRecord(
      deltaEvent(
        { goblin: view("goblin", { cells: { hp: num(7), name: num(1) } }) },
        { goblin: view("goblin", { cells: { hp: num(9), name: num(1) } }) },
      ),
    );
    expect(record).toEqual({
      type: "commit",
      revision: 9,
      group,
      created: [],
      removed: [],
      cells: [{ object: "goblin", cell: "hp", before: num(7), after: num(9) }],
      objects: [],
    });
  });

  test("an added cell has only after, a deleted cell only before", () => {
    const record = commitRecord(
      deltaEvent(
        { goblin: view("goblin", { cells: { old: num(1) } }) },
        { goblin: view("goblin", { cells: { fresh: num(2) } }) },
      ),
    );
    expect(record.cells).toEqual([
      { object: "goblin", cell: "fresh", after: num(2) },
      { object: "goblin", cell: "old", before: num(1) },
    ]);
  });

  test("a cell view differing only in kind or source is a change; key order is not", () => {
    const formula: CellView = {
      value: { type: "number", value: 7 },
      kind: "formula",
      source: "3+4",
    };
    const reordered = { source: "3+4", kind: "formula", value: { value: 7, type: "number" } };
    const unchanged = commitRecord(
      deltaEvent(
        { a: view("a", { cells: { hp: formula } }) },
        { a: view("a", { cells: { hp: reordered as CellView } }) },
      ),
    );
    expect(unchanged.cells).toEqual([]);
    const changed = commitRecord(
      deltaEvent(
        { a: view("a", { cells: { hp: formula } }) },
        { a: view("a", { cells: { hp: num(7) } }) },
      ),
    );
    expect(changed.cells).toEqual([{ object: "a", cell: "hp", before: formula, after: num(7) }]);
  });

  test("actions and flags that differ produce an objects entry with ObjectFacts", () => {
    const heal = [{ name: "Heal", steps: ["7 -> hp"] }];
    const record = commitRecord(
      deltaEvent(
        { a: view("a"), b: view("b") },
        { a: view("a", { actions: heal }), b: view("b", { is_character: true }) },
      ),
    );
    expect(record.objects).toEqual([
      {
        object: "a",
        before: { is_template: false, is_character: false, actions: [] },
        after: { is_template: false, is_character: false, actions: heal },
      },
      {
        object: "b",
        before: { is_template: false, is_character: false, actions: [] },
        after: { is_template: false, is_character: true, actions: [] },
      },
    ]);
    expect(record.cells).toEqual([]);
  });

  test("created and removed ids; their cells and facts have one side only", () => {
    const record = commitRecord(
      deltaEvent(
        { coin: view("coin", { cells: { value: num(1) } }), orc: undefined },
        { coin: undefined, orc: view("orc", { cells: { hp: num(7) }, is_template: true }) },
      ),
    );
    expect(record.created).toEqual(["orc"]);
    expect(record.removed).toEqual(["coin"]);
    // Objects in the delta's order: upserted views, then removed ids.
    expect(record.cells).toEqual([
      { object: "orc", cell: "hp", after: num(7) },
      { object: "coin", cell: "value", before: num(1) },
    ]);
    expect(record.objects).toEqual([
      { object: "orc", after: { is_template: true, is_character: false, actions: [] } },
      { object: "coin", before: { is_template: false, is_character: false, actions: [] } },
    ]);
  });

  test("objectFacts keeps only is_template, is_character and actions", () => {
    expect(objectFacts(view("x", { cells: { hp: num(1) }, is_character: true }))).toEqual({
      is_template: false,
      is_character: true,
      actions: [],
    });
  });
});

describe("ChangeBuffer", () => {
  test("take returns and clears; records reads without clearing", () => {
    const buffer = new ChangeBuffer();
    buffer.push(resync(1, 2));
    buffer.push(resync(2, 3));
    expect(buffer.size).toBe(2);
    expect(buffer.records()).toEqual([resync(1, 2), resync(2, 3)]);
    expect(buffer.size).toBe(2);
    expect(buffer.take()).toEqual({ changes: [resync(1, 2), resync(2, 3)], overflowed: false });
    expect(buffer.size).toBe(0);
    expect(buffer.take()).toEqual({ changes: [], overflowed: false });
  });

  test(`holds at most ${CHANGE_BUFFER_LIMIT} records, dropping the oldest and flagging overflow until taken`, () => {
    expect(CHANGE_BUFFER_LIMIT).toBe(1000);
    const buffer = new ChangeBuffer();
    for (let i = 0; i <= CHANGE_BUFFER_LIMIT; i++) buffer.push(resync(i, i + 1));
    expect(buffer.size).toBe(CHANGE_BUFFER_LIMIT);
    expect(buffer.overflowed).toBe(true);
    expect(buffer.records()[0]).toEqual(resync(1, 2));
    expect(buffer.overflowed).toBe(true);
    const taken = buffer.take();
    expect(taken.overflowed).toBe(true);
    expect(taken.changes).toHaveLength(CHANGE_BUFFER_LIMIT);
    expect(taken.changes.at(-1)).toEqual(resync(CHANGE_BUFFER_LIMIT, CHANGE_BUFFER_LIMIT + 1));
    expect(buffer.overflowed).toBe(false);
    buffer.push(resync(0, 1));
    expect(buffer.take().overflowed).toBe(false);
  });

  test("a smaller limit, and push listeners called once per record until removed", () => {
    const buffer = new ChangeBuffer(2);
    const seen: ChangeRecord[] = [];
    const off = buffer.onPush((record) => seen.push(record));
    buffer.push(resync(1, 2));
    buffer.push(resync(2, 3));
    buffer.push(resync(3, 4));
    expect(buffer.records()).toEqual([resync(2, 3), resync(3, 4)]);
    expect(buffer.overflowed).toBe(true);
    expect(seen).toHaveLength(3);
    off();
    buffer.push(resync(4, 5));
    expect(seen).toHaveLength(3);
  });

  test("failed is null until a failed record is pushed, and stays after take", () => {
    const buffer = new ChangeBuffer();
    expect(buffer.failed).toBeNull();
    buffer.push({ type: "failed", code: "not_found", message: "no board shelf" });
    expect(buffer.failed).toEqual({ code: "not_found", message: "no board shelf" });
    buffer.take();
    expect(buffer.failed).toEqual({ code: "not_found", message: "no board shelf" });
  });
});

describe("feedChanges", () => {
  /** A stand-in for a client `Subscription` that only records listeners. */
  function fakeSubscription() {
    const listeners = new Map<string, Set<(sub: Subscription, payload: unknown) => void>>();
    const sub = {
      on(event: string, fn: (sub: Subscription, payload: unknown) => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(fn);
        listeners.set(event, set);
        return () => set.delete(fn);
      },
    } as unknown as Subscription;
    const emit = (event: string, payload: unknown) => {
      for (const fn of listeners.get(event) ?? []) fn(sub, payload);
    };
    const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
    return { sub, emit, count };
  }

  test("delta, resync and error events become commit, resync and failed records", () => {
    const { sub, emit, count } = fakeSubscription();
    const buffer = new ChangeBuffer();
    const off = feedChanges(sub, buffer);
    expect(count()).toBe(3);
    emit(
      "delta",
      deltaEvent(
        { goblin: view("goblin", { cells: { hp: num(7) } }) },
        { goblin: view("goblin", { cells: { hp: num(8) } }) },
      ),
    );
    const info: ResyncInfo = { from_revision: 9, to_revision: 12, session_changed: true };
    emit("resync", info);
    const error: ProtocolError = { code: "not_found", message: "gone", details: { id: "shelf" } };
    emit("error", error);
    const { changes } = buffer.take();
    expect(changes.map((r) => r.type)).toEqual(["commit", "resync", "failed"]);
    expect(changes[1]).toEqual({ type: "resync", ...info });
    expect(changes[2]).toEqual({ type: "failed", code: "not_found", message: "gone" });
    off();
    expect(count()).toBe(0);
  });
});
