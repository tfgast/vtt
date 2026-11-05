import { type CommitPayload, DocumentStore, Rejected, type TransactionMeta } from "@vtt/authority";
import { cellKey } from "@vtt/formula";
import type { Actor, Effect } from "@vtt/schema";
import { describe, expect, test, vi } from "vitest";
import { at, lit, must, named, obj, table } from "./helpers";

const gm: Actor = { type: "gm" };
const edit = { kind: "edit", label: "edit" } as const;

const write = (
  object: string,
  cell: string,
  before: number | null,
  after: number | null,
): Effect => ({
  type: "cell",
  object,
  cell,
  before: before === null ? null : lit(before),
  after: after === null ? null : lit(after),
  cause: "edit",
});

const rename = (object: string, before: string, after: string): Effect => ({
  type: "cell",
  object,
  cell: "name",
  before: named(before),
  after: named(after),
  cause: "edit",
});

/** Spawns `orc` (allocated as seq 5) on the map. */
const spawnOrc: Effect[] = [
  { type: "allocate", ids: ["orc"], seq_before: 5, seq_after: 6 },
  {
    type: "create",
    objects: [obj("orc", { board: "map", cells: { name: named("Orc"), position: at(0, 0) } })],
    location: { type: "board", board: "map" },
  },
];

/** Moves the goblin from the map into the bag, after the gem. */
const goblinIntoBag: Effect[] = [
  {
    type: "place",
    object: "goblin",
    before: { type: "board", board: "map" },
    after: { type: "container", container: "bag", index: 2 },
  },
  {
    type: "cell",
    object: "goblin",
    cell: "position",
    before: at(1, 2),
    after: null,
    cause: "edit",
  },
  { type: "cell", object: "goblin", cell: "z", before: lit(0), after: null, cause: "edit" },
];

const removeCoin = (): Effect[] => {
  const coin = must(table().objects.coin);
  return [
    {
      type: "remove",
      objects: [coin],
      location: { type: "container", container: "bag", index: 0 },
    },
    { type: "retire", ids: ["coin"] },
  ];
};

function commitAll(store: DocumentStore, effects: Effect[], meta: TransactionMeta = edit) {
  const tx = store.begin(gm, meta);
  for (const e of effects) tx.record(e);
  return tx.commit();
}

describe("begin", () => {
  test("refuses a second open transaction", () => {
    const store = DocumentStore.fromSnapshot(table());
    const tx = store.begin(gm, edit);
    expect(() => store.begin(gm, edit)).toThrow();
    tx.abort();
    expect(() => store.begin(gm, edit).abort()).not.toThrow();
  });

  test("refuses undoes on a group that is not an undo, and an undo without undoes", () => {
    const store = DocumentStore.fromSnapshot(table());
    expect(() => store.begin(gm, { kind: "edit", label: "x", undoes: 0 })).toThrow();
    expect(() => store.begin(gm, { kind: "undo", label: "x" })).toThrow();
    expect(() => store.begin(gm, edit).abort()).not.toThrow();
  });
});

describe("Transaction", () => {
  test("records onto a working copy, leaving the store unchanged until commit", () => {
    const store = DocumentStore.fromSnapshot(table());
    const tx = store.begin(gm, edit);
    tx.record(write("goblin", "hp", 7, 5));
    expect(tx.doc.getCell("goblin", "hp")).toEqual(lit(5));
    expect(store.getCell("goblin", "hp")).toEqual(lit(7));
    expect(tx.changes().writtenCells).toEqual([
      { object: "goblin", cell: "hp", before: lit(7), after: lit(5) },
    ]);
    tx.commit();
    expect(store.getCell("goblin", "hp")).toEqual(lit(5));
  });

  test("abort discards everything", () => {
    const store = DocumentStore.fromSnapshot(table());
    const tx = store.begin(gm, edit);
    tx.record(write("goblin", "hp", 7, 5));
    tx.abort();
    expect(store.toSnapshot()).toEqual(table());
    expect(store.history.nextIndex).toBe(0);
    expect(() => tx.record(write("goblin", "hp", 7, 5))).toThrow();
    expect(() => tx.commit()).toThrow();
  });

  test("a commit whose document fails validation leaves no trace", () => {
    const store = DocumentStore.fromSnapshot(table());
    const listener = vi.fn();
    store.onCommit(listener);
    const tx = store.begin(gm, edit);
    // A move into the bag that keeps the board-only position cell.
    tx.record(must(goblinIntoBag[0]));
    let thrown: unknown;
    try {
      tx.commit();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Rejected);
    expect((thrown as Rejected).rejection.type).toBe("invalid");
    expect(store.toSnapshot()).toEqual(table());
    expect(store.revision).toBe(3);
    expect(store.history.nextIndex).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    // The transaction is closed; a new one may begin.
    expect(() => store.begin(gm, edit).abort()).not.toThrow();
  });

  test("one commit appends exactly one group with the next index and bumps revision by one", () => {
    const store = DocumentStore.fromSnapshot(table());
    commitAll(store, [write("goblin", "hp", 7, 6)]);
    const { group } = commitAll(store, [write("goblin", "hp", 6, 5)], {
      kind: "action",
      label: "Hit",
      origin: { object: "goblin", action: "hit" },
    });
    expect(store.history.nextIndex).toBe(2);
    expect(group).toEqual({
      index: 1,
      base_revision: 4,
      revision: 5,
      actor: gm,
      kind: "action",
      label: "Hit",
      origin: { object: "goblin", action: "hit" },
      names: { goblin: "Goblin" },
      effects: [write("goblin", "hp", 6, 5)],
    });
    expect(store.history.get(1)).toEqual(group);
    expect(store.revision).toBe(5);
    expect(store.toSnapshot().revision).toBe(5);
  });

  test("a committed transaction with no effects is still a group", () => {
    const store = DocumentStore.fromSnapshot(table());
    const { group } = store.begin(gm, edit).commit();
    expect(group.effects).toEqual([]);
    expect(group.index).toBe(0);
    expect(store.revision).toBe(4);
    expect(store.history.nextIndex).toBe(1);
  });

  test("records undoes on an undo group", () => {
    const store = DocumentStore.fromSnapshot(table());
    commitAll(store, [write("goblin", "hp", 7, 6)]);
    const { group } = commitAll(store, [write("goblin", "hp", 6, 7)], {
      kind: "undo",
      label: "Undo",
      undoes: 0,
    });
    expect(group.kind).toBe("undo");
    expect(group.undoes).toBe(0);
    expect(store.history.isUndone(0)).toBe(true);
  });

  test("names hold the name at commit time, and a removed object's name before removal", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = commitAll(store, [
      rename("goblin", "Goblin", "Gob"),
      write("goblin", "hp", 7, 6),
    ]);
    commitAll(store, [rename("goblin", "Gob", "Grub")]);
    expect(store.history.get(first.group.index)?.names).toEqual({ goblin: "Gob" });
    expect(store.history.get(1)?.names).toEqual({ goblin: "Grub" });

    // Renamed, then removed, in one transaction: the name just before removal.
    const { group } = commitAll(store, [
      rename("coin", "Coin", "Penny"),
      ...removeCoin().map(withCoinName("Penny")),
    ]);
    expect(group.names).toEqual({ bag: "Bag", coin: "Penny" });
    // Unnamed objects are recorded with the empty name.
    expect(commitAll(store, [write("ring", "value", 100, 99)]).group.names).toEqual({ ring: "" });
  });

  test("the commit payload carries a summary of the effects and the state before", () => {
    const store = DocumentStore.fromSnapshot(table());
    const internal: CommitPayload[] = [];
    store.onCommitInternal((p) => {
      internal.push(p);
    });
    let seen: CommitPayload | undefined;
    let beforeHp: unknown;
    let beforeGoblin: unknown;
    store.onCommit((p) => {
      seen = p;
      beforeHp = p.before.getCell("goblin", "hp");
      beforeGoblin = p.before.locationOf("goblin");
    });
    const result = commitAll(store, [
      ...spawnOrc,
      write("goblin", "hp", 7, 7),
      ...goblinIntoBag,
      ...removeCoin(),
    ]);
    const payload = must(seen);
    expect(internal).toHaveLength(1);
    expect(internal[0]).toBe(payload);
    expect(payload.group).toBe(result.group);
    expect(payload.summary).toEqual(result.summary);
    const s = payload.summary;
    expect(s.created).toEqual(["orc"]);
    expect(s.removed).toEqual(["coin"]);
    expect(s.writtenCells).toEqual([
      { object: "goblin", cell: "hp", before: lit(7), after: lit(7) },
      { object: "goblin", cell: "position", before: at(1, 2), after: null },
      { object: "goblin", cell: "z", before: lit(0), after: null },
    ]);
    expect(s.moved).toEqual([
      {
        object: "goblin",
        from: { type: "board", board: "map" },
        to: { type: "container", container: "bag", index: 2 },
        derived: [
          ...["board", "position", "rotation", "z", "container"].map((c) => cellKey("goblin", c)),
          cellKey("bag", "contents"),
        ],
      },
    ]);
    expect(s.changedCells).toEqual(expect.arrayContaining([...must(s.moved[0]).derived]));
    // `before` is the pre-commit document.
    expect(beforeHp).toEqual(lit(7));
    expect(beforeGoblin).toEqual({ type: "board", board: "map" });
    expect(payload.before.hasObject("orc")).toBe(false);
    expect(payload.before.hasObject("coin")).toBe(true);
    expect(payload.before.revision).toBe(3);
    expect(store.locationOf("goblin")).toEqual({ type: "container", container: "bag", index: 1 });
    expect(result.group.names).toEqual({ bag: "Bag", coin: "Coin", goblin: "Goblin", orc: "Orc" });
  });

  test("internal hooks run before public listeners, whatever the registration order", () => {
    const store = DocumentStore.fromSnapshot(table());
    const order: string[] = [];
    store.onCommit(() => {
      order.push("public 1");
    });
    store.onCommitInternal(() => {
      order.push("internal 1");
    });
    store.onCommit(() => {
      order.push("public 2");
    });
    store.onCommitInternal(() => {
      order.push("internal 2");
    });
    store.begin(gm, edit).commit();
    expect(order).toEqual(["internal 1", "internal 2", "public 1", "public 2"]);
  });

  test("hooks see the committed store", () => {
    const store = DocumentStore.fromSnapshot(table());
    const seen: number[] = [];
    store.onCommitInternal(() => {
      seen.push(store.revision, store.history.nextIndex);
    });
    store.begin(gm, edit).commit();
    expect(seen).toEqual([4, 1]);
  });

  test("unsubscribing removes a listener", () => {
    const store = DocumentStore.fromSnapshot(table());
    const listener = vi.fn();
    const off = store.onCommit(listener);
    off();
    store.begin(gm, edit).commit();
    expect(listener).not.toHaveBeenCalled();
  });

  test("a throwing public listener is reported and does not abort the commit", () => {
    const store = DocumentStore.fromSnapshot(table());
    const boom = new Error("boom");
    const after = vi.fn();
    store.onCommit(() => {
      throw boom;
    });
    store.onCommit(after);
    const result = commitAll(store, [write("goblin", "hp", 7, 5)]);
    expect(result.listenerErrors).toEqual([boom]);
    expect(after).toHaveBeenCalledOnce();
    expect(store.getCell("goblin", "hp")).toEqual(lit(5));
    expect(store.history.nextIndex).toBe(1);
  });

  test("a throwing internal hook propagates after the commit is published", () => {
    const store = DocumentStore.fromSnapshot(table());
    const bug = new Error("bug");
    store.onCommitInternal(() => {
      throw bug;
    });
    const tx = store.begin(gm, edit);
    tx.record(write("goblin", "hp", 7, 5));
    expect(() => tx.commit()).toThrow(bug);
    expect(store.getCell("goblin", "hp")).toEqual(lit(5));
    expect(store.history.nextIndex).toBe(1);
    expect(() => store.begin(gm, edit).abort()).not.toThrow();
  });
});

describe("transact", () => {
  test("commits and returns the group, summary and listener errors", () => {
    const store = DocumentStore.fromSnapshot(table());
    const result = store.transact(gm, edit, (tx) => {
      tx.record(write("goblin", "hp", 7, 5));
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.index).toBe(0);
    expect(result.summary.writtenCells).toHaveLength(1);
    expect(result.listenerErrors).toEqual([]);
  });

  test("returns a rejection for Rejected, aborting and calling onAbort", () => {
    const store = DocumentStore.fromSnapshot(table());
    const onAbort = vi.fn();
    const result = store.transact(
      gm,
      edit,
      (tx) => {
        tx.record(write("goblin", "hp", 7, 5));
        throw new Rejected({ type: "protected_cell", object: "goblin", cell: "id" });
      },
      { onAbort },
    );
    expect(result).toEqual({
      ok: false,
      rejection: { type: "protected_cell", object: "goblin", cell: "id" },
    });
    expect(onAbort).toHaveBeenCalledOnce();
    expect(store.toSnapshot()).toEqual(table());
    expect(store.history.nextIndex).toBe(0);
  });

  test("returns a rejection when the working document fails validation", () => {
    const store = DocumentStore.fromSnapshot(table());
    const onAbort = vi.fn();
    const result = store.transact(gm, edit, (tx) => tx.record(must(goblinIntoBag[0])), {
      onAbort,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.type).toBe("invalid");
    expect(onAbort).toHaveBeenCalledOnce();
    expect(store.toSnapshot()).toEqual(table());
  });

  test("rethrows any other error unchanged after aborting, and calls onAbort", () => {
    class ScenarioError extends Error {}
    const store = DocumentStore.fromSnapshot(table());
    const onAbort = vi.fn();
    const error = new ScenarioError("script exhausted");
    let thrown: unknown;
    try {
      store.transact(
        gm,
        edit,
        (tx) => {
          tx.record(write("goblin", "hp", 7, 5));
          throw error;
        },
        { onAbort },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(error);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(store.toSnapshot()).toEqual(table());
    expect(store.history.nextIndex).toBe(0);
    expect(() => store.begin(gm, edit).abort()).not.toThrow();
  });

  test("does not call onAbort after a commit whose listener throws", () => {
    const store = DocumentStore.fromSnapshot(table());
    const boom = new Error("boom");
    store.onCommit(() => {
      throw boom;
    });
    const onAbort = vi.fn();
    const result = store.transact(gm, edit, (tx) => tx.record(write("goblin", "hp", 7, 5)), {
      onAbort,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listenerErrors).toEqual([boom]);
    expect(onAbort).not.toHaveBeenCalled();
    expect(store.revision).toBe(4);
  });

  test("an internal hook error after the commit point propagates without onAbort", () => {
    const store = DocumentStore.fromSnapshot(table());
    const bug = new Error("bug");
    store.onCommitInternal(() => {
      throw bug;
    });
    const onAbort = vi.fn();
    expect(() => store.transact(gm, edit, () => {}, { onAbort })).toThrow(bug);
    expect(onAbort).not.toHaveBeenCalled();
    expect(store.revision).toBe(4);
  });
});

describe("immutability of reads", () => {
  test("a store read cannot change the committed document", () => {
    const store = DocumentStore.fromSnapshot(table());
    const cell = must(store.getCell("goblin", "hp")) as unknown as { content: { value: number } };
    expect(() => {
      cell.content.value = 1;
    }).toThrow(TypeError);
    expect(store.getCell("goblin", "hp")).toEqual(lit(7));
    commitAll(store, [write("goblin", "hp", 7, 5)]);
    const goblin = must(store.getObject("goblin")) as unknown as { cells: Record<string, unknown> };
    expect(() => {
      goblin.cells.hp = lit(1);
    }).toThrow(TypeError);
    expect(store.getCell("goblin", "hp")).toEqual(lit(5));
    expect(store.history.nextIndex).toBe(1);
  });

  test("mutating a record read from tx.doc commits nothing", () => {
    const store = DocumentStore.fromSnapshot(table());
    const tx = store.begin(gm, edit);
    const goblin = must(tx.doc.getObject("goblin")) as unknown as {
      cells: Record<string, unknown>;
    };
    goblin.cells.hp = lit(1);
    const cell = must(tx.doc.getCell("goblin", "name")) as unknown as { content: unknown };
    cell.content = named("Changed");
    expect(tx.doc.getCell("goblin", "hp")).toEqual(lit(7));
    const { group } = tx.commit();
    expect(group.effects).toEqual([]);
    expect(store.toSnapshot()).toEqual({ ...table(), revision: 4 });
  });

  test("an internal hook cannot mutate before", () => {
    const store = DocumentStore.fromSnapshot(table());
    let attempt: unknown;
    let beforeHp: unknown;
    store.onCommitInternal(({ before }) => {
      const goblin = must(before.getObject("goblin")) as unknown as {
        cells: Record<string, unknown>;
      };
      try {
        goblin.cells.hp = lit(1);
      } catch (e) {
        attempt = e;
      }
      beforeHp = before.getCell("goblin", "hp");
    });
    commitAll(store, [write("goblin", "hp", 7, 5)]);
    expect(attempt).toBeInstanceOf(TypeError);
    expect(beforeHp).toEqual(lit(7));
    expect(store.getCell("goblin", "hp")).toEqual(lit(5));
  });
});

describe("transact with a throwing onAbort", () => {
  const hookError = new Error("hook");
  const onAbort = () => {
    throw hookError;
  };

  test("keeps the rejection and reports the hook error", () => {
    const store = DocumentStore.fromSnapshot(table());
    const onAbortError = vi.fn();
    const result = store.transact(
      gm,
      edit,
      () => {
        throw new Rejected({ type: "nothing_to_undo" });
      },
      { onAbort, onAbortError },
    );
    expect(result).toEqual({
      ok: false,
      rejection: { type: "nothing_to_undo" },
      abortHookError: hookError,
    });
    expect(onAbortError).toHaveBeenCalledWith(hookError);
    expect(store.lastAbortHookError).toBe(hookError);
    expect(() => store.begin(gm, edit).abort()).not.toThrow();
  });

  test("rethrows the original error unchanged and reports the hook error", () => {
    const store = DocumentStore.fromSnapshot(table());
    const original = new Error("original");
    const onAbortError = vi.fn();
    expect(() =>
      store.transact(
        gm,
        edit,
        () => {
          throw original;
        },
        { onAbort, onAbortError },
      ),
    ).toThrow(original);
    expect(onAbortError).toHaveBeenCalledWith(hookError);
    expect(store.lastAbortHookError).toBe(hookError);
  });

  test("without onAbortError, records the hook error and rethrows the original", () => {
    const store = DocumentStore.fromSnapshot(table());
    const original = new Error("original");
    expect(() =>
      store.transact(
        gm,
        edit,
        () => {
          throw original;
        },
        { onAbort },
      ),
    ).toThrow(original);
    expect(store.lastAbortHookError).toBe(hookError);
    expect(store.toSnapshot()).toEqual(table());
  });
});

/** Replaces the coin record in a removal with one carrying `name`. */
function withCoinName(name: string) {
  return (e: Effect): Effect =>
    e.type === "remove"
      ? {
          ...e,
          objects: e.objects.map((o) =>
            o.id === "coin" ? { ...o, cells: { ...o.cells, name: named(name) } } : o,
          ),
        }
      : e;
}
