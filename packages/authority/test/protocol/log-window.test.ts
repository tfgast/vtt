/**
 * Log window subscriptions (vtt-5su.20; PROTOCOL.md §7.6, §8; DESIGN.md
 * §4.4, D15): the `log` scope provider plugged into the subscription hub by
 * `createSubscriptionHub`.
 *
 * Every test that applies deltas keeps a `ViewMirror` per log subscription
 * and checks, after each commit, that its window equals a fresh `subscribe`
 * with the same params at the same revision.
 */
import {
  compactLog,
  createSubscriptionHub,
  logScopeProvider,
  remove,
  removeBoard,
  type ScopeSubscription,
  type SubscriptionHub,
  Table,
  type Transaction,
  undo,
  writeValue,
} from "@vtt/authority";
import {
  type CommitEvent,
  CommitEventSchema,
  type GroupView,
  GroupViewSchema,
  LIMITS,
  type SubscribeParams,
  SubscribeResultSchema,
  type SubscriptionDelta,
  ViewMirror,
} from "@vtt/protocol";
import {
  type Actor,
  bool,
  list,
  num,
  ref,
  type TableObject,
  text,
  type ViewerEntry,
  type ViewersValue,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { at, c, placed, snapshot, zone } from "../engine/helpers";

const GM_ACTOR: Actor = { type: "gm" };
const ALDRIC = { type: "character", id: "aldric" } as const;

const viewers = (...entries: ViewerEntry[]): ViewersValue => ({
  type: "viewers",
  viewers: entries,
});

const canon = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/**
 * Boards `table` and the empty `attic`. On `table`: Aldric, an opaque room
 * hidden from him covering a goblin, a note and a die he can see.
 */
function world(extra: TableObject[] = []): Table {
  return Table.fromSnapshot(
    snapshot(
      [
        placed("aldric", 0, -50, { is_character: true, cells: { name: c(text("Aldric")) } }),
        zone("room", 10, 10, 6, {
          cells: {
            position: at(10, 10),
            name: c(text("Room")),
            opaque: c(bool(true)),
            visible_to: c(viewers("gm")),
          },
        }),
        placed("goblin", 10, 10, { cells: { name: c(text("Goblin")), hp: c(num(7)) } }),
        placed("note", 40, 0, { cells: { name: c(text("Note")), text: c(text("hello")) } }),
        placed("die", 0, -20, { cells: { name: c(text("Die")), value: c(num(4)) } }),
        ...extra,
      ],
      ["table", "attic"],
    ),
  );
}

interface LogMirror {
  params: SubscribeParams;
  mirror: ViewMirror;
}

/** A hub from `createSubscriptionHub`, with a mirror per log subscription. */
class Harness {
  readonly table: Table;
  readonly hub: SubscriptionHub;
  readonly events: CommitEvent[] = [];
  readonly mirrors = new Map<string, LogMirror>();

  constructor(table: Table = world()) {
    this.table = table;
    this.hub = createSubscriptionHub(table);
    this.hub.addConnection("c1");
    this.hub.onCommitEvent((conn, event) => {
      expect(conn).toBe("c1");
      CommitEventSchema.parse(event);
      this.events.push(event);
      for (const d of event.deltas) {
        for (const g of d.groups_upserted ?? []) GroupViewSchema.parse(g);
        const m = this.mirrors.get(d.subscription);
        if (m === undefined) continue;
        for (const i of d.groups_removed ?? []) {
          expect(m.mirror.groups.has(i), `removed group ${i} not in mirror`).toBe(true);
        }
        m.mirror.apply(d, event.revision);
      }
    });
  }

  /** Subscribes `c1` to the log for `viewer` (the GM when omitted). */
  log(viewer?: typeof ALDRIC): { id: string; groups: GroupView[] } {
    const params: SubscribeParams =
      viewer === undefined ? { scope: { type: "log" } } : { scope: { type: "log" }, viewer };
    const result = this.hub.subscribe("c1", params);
    SubscribeResultSchema.parse(result);
    expect(result.objects).toEqual([]);
    expect(result.covers).toEqual([]);
    expect(result.revision).toBe(this.table.store.revision);
    this.mirrors.set(result.subscription, { params, mirror: new ViewMirror(result) });
    return { id: result.subscription, groups: result.groups ?? [] };
  }

  /** Commits `fn` as one GM edit labelled `label`; returns its commit event. */
  commit(label: string, fn: (tx: Transaction) => void): CommitEvent {
    const n = this.events.length;
    const result = this.table.store.transact(GM_ACTOR, { kind: "edit", label }, fn);
    if (!result.ok) throw new Error(JSON.stringify(result.rejection));
    expect(result.listenerErrors).toEqual([]);
    expect(this.events.length).toBe(n + 1);
    return this.events[n] as CommitEvent;
  }

  undo(): CommitEvent {
    const n = this.events.length;
    const result = undo(this.table.store, GM_ACTOR);
    if (!result.ok) throw new Error(JSON.stringify(result.rejection));
    expect(result.listenerErrors).toEqual([]);
    expect(this.events.length).toBe(n + 1);
    return this.events[n] as CommitEvent;
  }

  /** A fresh subscribe's groups for the same params, at this revision. */
  fresh(id: string): GroupView[] {
    const m = this.mirrors.get(id);
    if (m === undefined) throw new Error(`no mirror ${id}`);
    const result = this.hub.subscribe("__fresh__", m.params);
    this.hub.dropConnection("__fresh__");
    SubscribeResultSchema.parse(result);
    return result.groups ?? [];
  }

  /** Every mirror's window equals a fresh subscribe with the same params at this revision. */
  check(): void {
    for (const [id, m] of this.mirrors) {
      expect(m.mirror.groupsNewestFirst().map(canon), `window of ${id}`).toEqual(
        this.fresh(id).map(canon),
      );
    }
  }

  /** The window `id`'s mirror holds now, newest first. */
  window(id: string): GroupView[] {
    return this.mirrors.get(id)?.mirror.groupsNewestFirst() ?? [];
  }
}

function deltaOf(event: CommitEvent, sub: string): SubscriptionDelta | undefined {
  return event.deltas.find((d) => d.subscription === sub);
}

const upserted = (d: { groups_upserted?: GroupView[] } | null | undefined) =>
  d?.groups_upserted?.map((g) => g.index);
const groupAt = (d: { groups_upserted?: GroupView[] } | undefined, index: number) =>
  d?.groups_upserted?.find((g) => g.index === index);

describe("subscribe", () => {
  test("a log subscription returns the newest groups newest first, at most max_log_window", () => {
    const h = new Harness();
    expect(h.log().groups).toEqual([]);
    for (let i = 0; i < LIMITS.max_log_window + 5; i++) {
      h.commit(`n${i}`, (tx) => writeValue(tx, "note", "text", text(`t${i}`)));
    }
    const { groups } = h.log();
    expect(LIMITS.max_log_window).toBe(200);
    expect(groups).toHaveLength(200);
    const next = h.table.store.history.nextIndex;
    expect(groups.map((g) => g.index)).toEqual(Array.from({ length: 200 }, (_, k) => next - 1 - k));
    expect(groups[0]?.label).toBe("n204");
    expect(groups[0]?.effects).toHaveLength(1);
    for (const g of groups) expect(g.undone).toBe(false);
    h.check();
  });

  test("a character's window omits the groups that are null for it, and carries effects", () => {
    const h = new Harness();
    h.commit("hurt goblin", (tx) => writeValue(tx, "goblin", "hp", num(5)));
    h.commit("write note", (tx) => writeValue(tx, "note", "text", text("x")));
    const gm = h.log();
    const al = h.log(ALDRIC);
    expect(gm.groups.map((g) => g.label)).toEqual(["write note", "hurt goblin"]);
    expect(al.groups.map((g) => g.label)).toEqual(["write note"]);
    expect(al.groups[0]?.effects).toEqual([
      {
        type: "cell",
        object: "note",
        cell: "text",
        before: { kind: "literal", value: text("hello") },
        after: { kind: "literal", value: text("x") },
        cause: "edit",
      },
    ]);
  });
});

describe("commits", () => {
  test("each new group is upserted; the GM's older groups are not re-sent", () => {
    const h = new Harness();
    const gm = h.log();
    const al = h.log(ALDRIC);
    const e1 = h.commit("a", (tx) => writeValue(tx, "note", "text", text("a")));
    const i1 = e1.group.index;
    expect(upserted(deltaOf(e1, gm.id))).toEqual([i1]);
    expect(upserted(deltaOf(e1, al.id))).toEqual([i1]);
    expect(deltaOf(e1, gm.id)?.groups_removed ?? []).toEqual([]);
    h.check();
    const e2 = h.commit("b", (tx) => writeValue(tx, "note", "text", text("b")));
    expect(upserted(deltaOf(e2, gm.id))).toEqual([e2.group.index]);
    expect(upserted(deltaOf(e2, al.id))).toEqual([e2.group.index]);
    h.check();
  });

  test("for Aldric, a reveal upserts older groups; hiding again removes or reduces them", () => {
    const h = new Harness();
    const gm = h.log();
    const al = h.log(ALDRIC);
    const gA = h.commit("hurt goblin", (tx) => writeValue(tx, "goblin", "hp", num(5))).group.index;
    const gB = h.commit("both", (tx) => {
      writeValue(tx, "goblin", "hp", num(3));
      writeValue(tx, "note", "text", text("seen"));
    }).group.index;
    expect(h.window(al.id).map((g) => g.index)).toEqual([gB]);
    expect(h.window(al.id)[0]?.label).toBeNull();
    expect(h.window(al.id)[0]?.effects).toHaveLength(1);
    h.check();

    const reveal = h.commit("reveal", (tx) => writeValue(tx, "room", "visible_to", viewers("all")));
    const dr = deltaOf(reveal, al.id);
    expect(upserted(dr)).toEqual([reveal.group.index, gB, gA]);
    expect(groupAt(dr, gA)?.label).toBe("hurt goblin");
    expect(groupAt(dr, gA)?.effects).toHaveLength(1);
    expect(groupAt(dr, gB)?.label).toBe("both");
    expect(groupAt(dr, gB)?.effects).toHaveLength(2);
    expect(dr?.groups_removed ?? []).toEqual([]);
    // The GM's views of older groups never change on a reveal.
    expect(upserted(deltaOf(reveal, gm.id))).toEqual([reveal.group.index]);
    h.check();

    const hide = h.commit("hide", (tx) => writeValue(tx, "room", "visible_to", viewers("gm")));
    const dh = deltaOf(hide, al.id);
    // The hide group touches only the room, which Aldric can no longer see.
    expect(upserted(dh)).toEqual([gB]);
    expect(groupAt(dh, gB)?.label).toBeNull();
    expect(groupAt(dh, gB)?.effects).toHaveLength(1);
    expect(dh?.groups_removed).toEqual([reveal.group.index, gA].sort((a, b) => a - b));
    expect(h.window(al.id).map((g) => g.index)).toEqual([gB]);
    h.check();
  });

  test("removing an object re-sends older groups without its effects", () => {
    const h = new Harness();
    const gm = h.log();
    const al = h.log(ALDRIC);
    const gC = h.commit("two", (tx) => {
      writeValue(tx, "note", "text", text("t"));
      writeValue(tx, "die", "value", num(6));
    }).group.index;
    expect(h.window(al.id)[0]?.effects).toHaveLength(2);
    expect(h.window(al.id)[0]?.names).toEqual({ note: "Note", die: "Die" });
    h.check();
    const e = h.commit("drop die", (tx) => remove(tx, "die"));
    const d = deltaOf(e, al.id);
    expect(upserted(d)).toEqual([gC]);
    const g = groupAt(d, gC);
    expect(g?.label).toBeNull();
    expect(g?.names).toEqual({ note: "Note" });
    expect(g?.effects?.map((x) => (x.type === "cell" ? x.object : x.type))).toEqual(["note"]);
    expect(upserted(deltaOf(e, gm.id))).toEqual([e.group.index]);
    h.check();
    // Undoing the removal restores the die's effects.
    const back = h.undo();
    const db = deltaOf(back, al.id);
    expect(upserted(db)).toContain(gC);
    expect(groupAt(db, gC)?.label).toBe("two");
    h.check();
  });

  test("an undo re-sends the undone group with undone: true, for the GM and for Aldric", () => {
    const h = new Harness();
    const gm = h.log();
    const al = h.log(ALDRIC);
    const target = h.commit("write", (tx) => writeValue(tx, "note", "text", text("x"))).group.index;
    h.check();
    const e = h.undo();
    for (const id of [gm.id, al.id]) {
      const d = deltaOf(e, id);
      expect(upserted(d)).toEqual([e.group.index, target]);
      expect(groupAt(d, target)?.undone).toBe(true);
      expect(groupAt(d, e.group.index)?.undoes).toBe(target);
      expect(groupAt(d, e.group.index)?.undone).toBe(false);
    }
    h.check();
  });

  test("an undo of a group hidden from Aldric re-sends nothing to him", () => {
    const h = new Harness();
    const al = h.log(ALDRIC);
    h.commit("hurt goblin", (tx) => writeValue(tx, "goblin", "hp", num(5)));
    const e = h.undo();
    expect(deltaOf(e, al.id)).toBeUndefined();
    expect(h.window(al.id)).toEqual([]);
    h.check();
  });

  test("a board ref in an older cell effect is redacted while the board is gone and restored on undo", () => {
    const h = new Harness();
    const gm = h.log();
    const al = h.log(ALDRIC);
    const point = h.commit("point", (tx) => writeValue(tx, "note", "target", ref("attic"))).group
      .index;
    const unpoint = h.commit("unpoint", (tx) => writeValue(tx, "note", "target", text("none")))
      .group.index;
    const after = (g: GroupView | undefined) => {
      const e = g?.effects?.[0];
      return e?.type === "cell" ? e.after : undefined;
    };
    const before = (g: GroupView | undefined) => {
      const e = g?.effects?.[0];
      return e?.type === "cell" ? e.before : undefined;
    };
    expect(after(h.window(al.id).find((g) => g.index === point))).toEqual({
      kind: "literal",
      value: ref("attic"),
    });
    h.check();

    const rm = h.commit("remove attic", (tx) => removeBoard(tx, "attic"));
    const d = deltaOf(rm, al.id);
    expect(upserted(d)).toEqual([rm.group.index, unpoint, point]);
    expect(after(groupAt(d, point))).toEqual({ kind: "literal", value: { type: "redacted" } });
    expect(groupAt(d, point)?.label).toBeNull();
    expect(before(groupAt(d, unpoint))).toEqual({
      kind: "literal",
      value: { type: "redacted" },
    });
    // GM group views are lossless: the ref is kept and nothing older is re-sent.
    expect(upserted(deltaOf(rm, gm.id))).toEqual([rm.group.index]);
    h.check();

    const back = h.undo();
    const db = deltaOf(back, al.id);
    expect(upserted(db)).toEqual([back.group.index, rm.group.index, unpoint, point]);
    expect(groupAt(db, rm.group.index)?.undone).toBe(true);
    expect(after(groupAt(db, point))).toEqual({ kind: "literal", value: ref("attic") });
    expect(groupAt(db, point)?.label).toBe("point");
    expect(before(groupAt(db, unpoint))).toEqual({ kind: "literal", value: ref("attic") });
    h.check();
  });

  test("the 201st group pushes the oldest index into groups_removed", () => {
    const h = new Harness();
    for (let i = 0; i < LIMITS.max_log_window; i++) {
      h.commit(`n${i}`, (tx) => writeValue(tx, "note", "text", text(`t${i}`)));
    }
    const gm = h.log();
    const al = h.log(ALDRIC);
    const oldest = h.table.store.history.firstIndex;
    expect(gm.groups).toHaveLength(200);
    expect(gm.groups.at(-1)?.index).toBe(oldest);
    const e = h.commit("one more", (tx) => writeValue(tx, "note", "text", text("last")));
    for (const id of [gm.id, al.id]) {
      const d = deltaOf(e, id);
      expect(upserted(d)).toEqual([e.group.index]);
      expect(d?.groups_removed).toEqual([oldest]);
    }
    expect(h.window(gm.id)).toHaveLength(200);
    h.check();
  });

  test("a group that left the window while null for Aldric is not reported removed", () => {
    const h = new Harness();
    h.commit("hidden", (tx) => writeValue(tx, "goblin", "hp", num(1)));
    for (let i = 1; i < LIMITS.max_log_window; i++) {
      h.commit(`n${i}`, (tx) => writeValue(tx, "note", "text", text(`t${i}`)));
    }
    const al = h.log(ALDRIC);
    expect(al.groups).toHaveLength(199);
    const e = h.commit("one more", (tx) => writeValue(tx, "note", "text", text("last")));
    const d = deltaOf(e, al.id);
    expect(upserted(d)).toEqual([e.group.index]);
    expect(d?.groups_removed ?? []).toEqual([]);
    h.check();
  });

  test("groups compacted away between commits are reported removed by the next commit", () => {
    const h = new Harness();
    const gm = h.log();
    const indices: number[] = [];
    for (let i = 0; i < 4; i++) {
      indices.push(
        h.commit(`n${i}`, (tx) => writeValue(tx, "note", "text", text(`t${i}`))).group.index,
      );
    }
    compactLog(h.table.store, 1);
    const e = h.commit("after", (tx) => writeValue(tx, "note", "text", text("after")));
    const d = deltaOf(e, gm.id);
    expect(upserted(d)).toEqual([e.group.index]);
    expect(d?.groups_removed).toEqual(indices.slice(0, 3));
    h.check();
  });

  test("refreshProvided after a compaction reports the dropped groups with no commit (vtt-qf5.71)", () => {
    const h = new Harness();
    const gm = h.log();
    const al = h.log(ALDRIC);
    const indices: number[] = [];
    for (let i = 0; i < 4; i++) {
      indices.push(
        h.commit(`n${i}`, (tx) => writeValue(tx, "note", "text", text(`t${i}`))).group.index,
      );
    }
    const events = h.events.length;
    compactLog(h.table.store, 1);
    const deltas = h.hub.refreshProvided();
    expect(h.events.length).toBe(events);
    expect([...deltas.keys()]).toEqual(["c1"]);
    const list = deltas.get("c1") ?? [];
    for (const d of list) {
      expect(d.objects).toEqual([]);
      expect(d.removed).toEqual([]);
      expect(d.groups_upserted).toBeUndefined();
      h.mirrors.get(d.subscription)?.mirror.apply(d, h.table.store.revision);
    }
    expect(list.find((d) => d.subscription === gm.id)?.groups_removed).toEqual(indices.slice(0, 3));
    expect(list.find((d) => d.subscription === al.id)?.groups_removed).toEqual(indices.slice(0, 3));
    h.check();
    expect(h.window(gm.id).map((g) => g.index)).toEqual([indices[3]]);
    // Nothing left to report: no delta entries, and the next commit removes nothing.
    expect(h.hub.refreshProvided().get("c1")).toEqual([]);
    const e = h.commit("after", (tx) => writeValue(tx, "note", "text", text("after")));
    expect(deltaOf(e, gm.id)?.groups_removed).toEqual([]);
    h.check();
  });

  test("a commit that changes no group view in the window yields no log delta entry", () => {
    const h = new Harness();
    const gm = h.log();
    const al = h.log(ALDRIC);
    h.commit("write", (tx) => writeValue(tx, "note", "text", text("x")));
    const e = h.commit("hurt goblin", (tx) => writeValue(tx, "goblin", "hp", num(2)));
    expect(deltaOf(e, al.id)).toBeUndefined();
    expect(upserted(deltaOf(e, gm.id))).toEqual([e.group.index]);
    h.check();
  });

  test("a visibility-relevant commit that changes no older view re-sends nothing older", () => {
    const h = new Harness();
    const al = h.log(ALDRIC);
    h.commit("write", (tx) => writeValue(tx, "note", "text", text("x")));
    // Moving the hidden goblin is visibility-relevant but changes no view Aldric has.
    const e = h.commit("move goblin", (tx) =>
      writeValue(tx, "goblin", "position", list([num(11), num(11)])),
    );
    expect(deltaOf(e, al.id)).toBeUndefined();
    h.check();
  });

  test("a sequence of mixed commits keeps every window equal to a fresh subscribe", () => {
    const h = new Harness();
    h.log();
    h.log(ALDRIC);
    const steps: [string, (tx: Transaction) => void][] = [
      ["a", (tx) => writeValue(tx, "goblin", "hp", num(1))],
      ["b", (tx) => writeValue(tx, "note", "target", ref("goblin"))],
      ["c", (tx) => writeValue(tx, "room", "opaque", bool(false))],
      ["d", (tx) => writeValue(tx, "note", "target", ref("attic"))],
      ["e", (tx) => writeValue(tx, "room", "opaque", bool(true))],
      ["f", (tx) => writeValue(tx, "note", "target", text("none"))],
      ["g", (tx) => removeBoard(tx, "attic")],
      ["h", (tx) => remove(tx, "goblin")],
    ];
    for (const [label, fn] of steps) {
      h.commit(label, fn);
      h.check();
    }
    for (let i = 0; i < 3; i++) {
      h.undo();
      h.check();
    }
  });
});

describe("logScopeProvider", () => {
  test("drop frees the subscription's state", () => {
    const table = world();
    const provider = logScopeProvider(table);
    const sub: ScopeSubscription = { id: "s1", conn: "c1", viewer: { type: "gm" }, cells: "all" };
    expect(provider.subscribe(sub).groups).toEqual([]);
    let info: Parameters<typeof provider.onCommit>[1] | undefined;
    const off = table.onCommit(({ group, summary, dirty }) => {
      info = { group, summary, dirty, visibilityRelevant: false };
    });
    const r = table.store.transact(GM_ACTOR, { kind: "edit", label: "x" }, (tx) =>
      writeValue(tx, "note", "text", text("x")),
    );
    expect(r.ok).toBe(true);
    off();
    if (info === undefined) throw new Error("no commit");
    expect(upserted(provider.onCommit(sub, info))).toEqual([0]);
    provider.drop(sub);
    expect(provider.onCommit(sub, info)).toBeNull();
  });
});
