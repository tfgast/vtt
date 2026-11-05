/**
 * SubscriptionHub (vtt-5su.9; PROTOCOL.md §7.5, §8; FORMULAS.md §7): object
 * and cover scopes, commit events, the reference reverse index, selective
 * recomputation, visibility-relevant commits and the scope-provider seam.
 *
 * Every test that applies deltas keeps a mirror per subscription and checks,
 * after each commit, that it equals a fresh `subscribe` with the same params
 * at the same revision.
 */
import {
  addBoard,
  type CommitInfo,
  clearOverride,
  createObject,
  isVisibilityRelevant,
  move,
  remove,
  removeBoard,
  renameBoard,
  reorder,
  type ScopeProvider,
  type ScopeSubscription,
  SubscriptionHub,
  setActions,
  setCellVisibility,
  setCharacterFlag,
  setFormula,
  setShape,
  setTag,
  setTemplateFlag,
  Table,
  type Transaction,
  undo,
  ViewBuilder,
  writeValue,
} from "@vtt/authority";
import {
  type CommitEvent,
  CommitEventSchema,
  type GroupView,
  ProtocolFailure,
  type SubscribeParams,
  type SubscribeResult,
  SubscribeResultSchema,
  type SubscriptionDelta,
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
import { at, c, f, obj, placed, snapshot, zone } from "../engine/helpers";

const GM_ACTOR: Actor = { type: "gm" };
const GM = { type: "gm" } as const;
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

const sorted = (ids: readonly string[]) => [...ids].sort();

/**
 * Boards `table`, `crypt` and the empty `attic`. On `table`: Aldric, an
 * opaque room hidden from him covering a goblin, a chest holding a coin and
 * a gem, a note no formula reads, a dice tray zone and a die outside it. On
 * `crypt`: Aldric's hand holding a card, and an opaque zone hidden from him.
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
        placed("goblin", 10, 10, { cells: { name: c(text("Goblin")) } }),
        placed("chest", 30, 0, { contents: ["coin", "gem"], cells: { name: c(text("Chest")) } }),
        obj("coin", { cells: { name: c(text("Coin")) } }),
        obj("gem", { cells: { name: c(text("Gem")) } }),
        placed("note", 40, 0, { cells: { name: c(text("Note")), text: c(text("hello")) } }),
        zone("tray", 10, -20, 4, {
          tag: ["tray"],
          cells: {
            position: at(10, -20),
            name: c(text("Tray")),
            tray_total: f('sum(contents(this).where(tag has "die").value)'),
          },
        }),
        placed("die", 0, -20, { tag: ["die"], cells: { name: c(text("Die")), value: c(num(4)) } }),
        obj("hand", {
          board: "crypt",
          contents: ["card"],
          cells: {
            position: at(0, 0),
            name: c(text("Hand")),
            owner: c(ref("aldric")),
            visible_to: c(viewers(ref("aldric"))),
          },
        }),
        obj("card", { cells: { name: c(text("Card")) } }),
        zone("crypt_room", 50, 50, 6, {
          board: "crypt",
          cells: {
            position: at(50, 50),
            opaque: c(bool(true)),
            visible_to: c(viewers("gm")),
          },
        }),
        ...extra,
      ],
      ["table", "crypt", "attic"],
    ),
  );
}

interface Mirror {
  conn: string;
  params: SubscribeParams;
  objects: Map<string, string>;
  covers: Map<string, string>;
}

/** A hub over a table, with mirrors and recorded commit events per connection. */
class Harness {
  readonly table: Table;
  readonly hub: SubscriptionHub;
  readonly events = new Map<string, CommitEvent[]>();
  readonly mirrors = new Map<string, Mirror>();

  constructor(table: Table) {
    this.table = table;
    this.hub = new SubscriptionHub(table);
    this.hub.onCommitEvent((conn, event) => {
      CommitEventSchema.parse(event);
      const list = this.events.get(conn) ?? [];
      this.events.set(conn, list);
      list.push(event);
      for (const d of event.deltas) this.#apply(d);
    });
  }

  subscribe(conn: string, params: SubscribeParams): SubscribeResult {
    const result = this.hub.subscribe(conn, params);
    SubscribeResultSchema.parse(result);
    expect(result.revision).toBe(this.table.store.revision);
    if (params.scope.type !== "log") {
      this.mirrors.set(result.subscription, {
        conn,
        params,
        objects: new Map(result.objects.map((o) => [o.id, canon(o)])),
        covers: new Map(result.covers.map((cv) => [cv.key, canon(cv)])),
      });
    }
    return result;
  }

  #apply(d: SubscriptionDelta): void {
    const m = this.mirrors.get(d.subscription);
    if (m === undefined) return;
    for (const id of d.removed) {
      expect(m.objects.has(id), `removed ${id} not in mirror`).toBe(true);
      m.objects.delete(id);
    }
    for (const o of d.objects) m.objects.set(o.id, canon(o));
    for (const key of d.covers?.removed ?? []) {
      expect(m.covers.has(key), `removed cover ${key} not in mirror`).toBe(true);
      m.covers.delete(key);
    }
    for (const cv of d.covers?.upsert ?? []) m.covers.set(cv.key, canon(cv));
  }

  /** Commits `fn` as one GM edit; returns the commit event each connection received. */
  commit(fn: (tx: Transaction) => void): Map<string, CommitEvent> {
    const before = new Map([...this.events].map(([k, v]) => [k, v.length]));
    const result = this.table.store.transact(GM_ACTOR, { kind: "edit", label: "edit" }, fn);
    if (!result.ok) throw new Error(JSON.stringify(result.rejection));
    expect(result.listenerErrors).toEqual([]);
    return this.#last(before);
  }

  undo(): Map<string, CommitEvent> {
    const before = new Map([...this.events].map(([k, v]) => [k, v.length]));
    const result = undo(this.table.store, GM_ACTOR);
    if (!result.ok) throw new Error(JSON.stringify(result.rejection));
    expect(result.listenerErrors).toEqual([]);
    return this.#last(before);
  }

  #last(before: Map<string, number>): Map<string, CommitEvent> {
    const out = new Map<string, CommitEvent>();
    for (const [conn, list] of this.events) {
      expect(list.length, `one event for ${conn}`).toBe((before.get(conn) ?? 0) + 1);
      out.set(conn, list[list.length - 1] as CommitEvent);
    }
    return out;
  }

  /** Every mirror equals a fresh subscribe with the same params at this revision. */
  check(): void {
    for (const [id, m] of this.mirrors) {
      const fresh = this.hub.subscribe("__fresh__", m.params);
      this.hub.dropConnection("__fresh__");
      const objects = new Map(fresh.objects.map((o) => [o.id, canon(o)]));
      const covers = new Map(fresh.covers.map((cv) => [cv.key, canon(cv)]));
      expect(sortedEntries(m.objects), `objects of ${id}`).toEqual(sortedEntries(objects));
      expect(sortedEntries(m.covers), `covers of ${id}`).toEqual(sortedEntries(covers));
    }
  }
}

const sortedEntries = (m: Map<string, string>) =>
  [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function deltaOf(event: CommitEvent | undefined, sub: string): SubscriptionDelta | undefined {
  return event?.deltas.find((d) => d.subscription === sub);
}

/** The ids a delta upserts and removes, sorted, and its cover changes. */
function shape(delta: SubscriptionDelta | undefined) {
  if (delta === undefined) return undefined;
  const out: { objects: string[]; removed: string[]; covers?: unknown } = {
    objects: sorted(delta.objects.map((o) => o.id)),
    removed: sorted(delta.removed),
  };
  if (delta.covers !== undefined) {
    out.covers = { upsert: delta.covers.upsert.map((cv) => cv.key), removed: delta.covers.removed };
  }
  return out;
}

/** A GM and an Aldric subscription to board `table` on connection `c1`. */
function boardPair(table: Table = world()) {
  const h = new Harness(table);
  const gm = h.subscribe("c1", { scope: { type: "board", board: "table" } }).subscription;
  const al = h.subscribe("c1", {
    scope: { type: "board", board: "table" },
    viewer: ALDRIC,
  }).subscription;
  return { h, gm, al };
}

const ALDRIC_SEES = ["aldric", "chest", "coin", "die", "gem", "note", "tray"];

describe("subscribe", () => {
  test("board scope: everything on the board and in its containers, with covers", () => {
    const h = new Harness(world());
    const gm = h.subscribe("c1", { scope: { type: "board", board: "table" } });
    expect(gm.subscription).toBe("s1");
    expect(sorted(gm.objects.map((o) => o.id))).toEqual(sorted([...ALDRIC_SEES, "goblin", "room"]));
    expect(gm.covers).toEqual([]);
    const al = h.subscribe("c1", { scope: { type: "board", board: "table" }, viewer: ALDRIC });
    expect(al.subscription).toBe("s2");
    expect(sorted(al.objects.map((o) => o.id))).toEqual(ALDRIC_SEES);
    expect(al.covers).toEqual(new ViewBuilder(h.table, ALDRIC).covers("table"));
    expect(al.covers).toHaveLength(1);
    expect(al.objects.find((o) => o.id === "note")).toEqual(
      new ViewBuilder(h.table, ALDRIC).objectView("note", "all"),
    );
  });

  test("objects scope: ids, subtree, unknown ids ignored; structural cells", () => {
    const h = new Harness(world());
    const plain = h.subscribe("c1", { scope: { type: "objects", ids: ["chest", "nope"] } });
    expect(plain.objects.map((o) => o.id)).toEqual(["chest"]);
    const sub = h.subscribe("c1", {
      scope: { type: "objects", ids: ["chest"], subtree: true },
      cells: "structural",
    });
    expect(sorted(sub.objects.map((o) => o.id))).toEqual(["chest", "coin", "gem"]);
    expect(sub.objects[0]).toEqual(new ViewBuilder(h.table, GM).objectView("chest", "structural"));
  });

  test("all scope: every live object; covers of every board", () => {
    const h = new Harness(world());
    const all = h.subscribe("c1", { scope: { type: "all" }, viewer: ALDRIC });
    const b = new ViewBuilder(h.table, ALDRIC);
    expect(sorted(all.objects.map((o) => o.id))).toEqual(sorted([...ALDRIC_SEES, "card", "hand"]));
    expect(sorted(all.covers.map((cv) => cv.key))).toEqual(
      sorted([...b.covers("table"), ...b.covers("crypt")].map((cv) => cv.key)),
    );
  });

  test("an objects subscription on a card in a hand on crypt receives crypt's covers", () => {
    const h = new Harness(world());
    const r = h.subscribe("c1", { scope: { type: "objects", ids: ["card"] }, viewer: ALDRIC });
    expect(r.objects.map((o) => o.id)).toEqual(["card"]);
    const crypt = new ViewBuilder(h.table, ALDRIC).covers("crypt");
    expect(crypt).toHaveLength(1);
    expect(r.covers).toEqual(crypt);
  });

  test("unknown board is not_found; unknown unsubscribe is not_found", () => {
    const h = new Harness(world());
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof ProtocolFailure) return e.error.code;
        throw e;
      }
      return "ok";
    };
    expect(code(() => h.hub.subscribe("c1", { scope: { type: "board", board: "nope" } }))).toBe(
      "not_found",
    );
    expect(code(() => h.hub.unsubscribe("c1", "s99"))).toBe("not_found");
    const s = h.hub.subscribe("c1", { scope: { type: "all" } }).subscription;
    expect(code(() => h.hub.unsubscribe("c2", s))).toBe("not_found");
    expect(code(() => h.hub.unsubscribe("c1", s))).toBe("ok");
  });

  test("the 17th subscription of a connection is busy", () => {
    const h = new Harness(world());
    for (let i = 0; i < 16; i++) h.hub.subscribe("c1", { scope: { type: "all" } });
    let failure: unknown;
    try {
      h.hub.subscribe("c1", { scope: { type: "all" } });
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(ProtocolFailure);
    expect((failure as ProtocolFailure).error.code).toBe("busy");
    expect(h.hub.subscribe("c2", { scope: { type: "all" } }).subscription).toBe("s17");
    h.hub.dropConnection("c1");
    for (let i = 0; i < 16; i++) h.hub.subscribe("c1", { scope: { type: "all" } });
  });
});

describe("commit events", () => {
  test("a connection with no subscriptions receives deltas: []", () => {
    const { h } = boardPair();
    h.hub.addConnection("idle");
    const events = h.commit((tx) => writeValue(tx, "note", "text", text("bye")));
    const idle = events.get("idle");
    expect(idle?.deltas).toEqual([]);
    expect(idle?.revision).toBe(1);
    expect(idle?.group).toEqual({
      index: 0,
      revision: 1,
      actor: { type: "gm" },
      kind: "edit",
      label: "edit",
    });
    expect(idle?.boards).toBeUndefined();
  });

  test("dropConnection stops events and frees subscriptions", () => {
    const { h } = boardPair();
    h.hub.addConnection("c2");
    h.hub.dropConnection("c1");
    h.mirrors.clear();
    h.events.delete("c1");
    const events = h.commit((tx) => writeValue(tx, "note", "text", text("bye")));
    expect([...events.keys()]).toEqual(["c2"]);
  });

  test("an unsubscribed subscription gets no further deltas", () => {
    const { h, gm, al } = boardPair();
    h.hub.unsubscribe("c1", al);
    h.mirrors.delete(al);
    const e = h.commit((tx) => writeValue(tx, "note", "text", text("bye"))).get("c1");
    expect(e?.deltas.map((d) => d.subscription)).toEqual([gm]);
  });
});

describe("one operation kind each, for a GM and an Aldric subscription", () => {
  test("set_tag on an object no formula reads", () => {
    const { h, gm, al } = boardPair();
    const e = h.commit((tx) => setTag(tx, "note", ["paper"])).get("c1");
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["note"], removed: [] });
    expect(shape(deltaOf(e, al))).toEqual({ objects: ["note"], removed: [] });
    expect(e?.deltas).toHaveLength(2);
    h.check();
  });

  test("set_shape on an object no formula reads", () => {
    const { h, gm, al } = boardPair();
    const e = h.commit((tx) => setShape(tx, "note", { type: "circle", radius: 2 })).get("c1");
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["note"], removed: [] });
    expect(shape(deltaOf(e, al))).toEqual({ objects: ["note"], removed: [] });
    h.check();
  });

  test("reorder: the container is re-sent", () => {
    const { h, gm, al } = boardPair();
    const e = h.commit((tx) => reorder(tx, "chest", [1, 0])).get("c1");
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["chest"], removed: [] });
    expect(shape(deltaOf(e, al))).toEqual({ objects: ["chest"], removed: [] });
    h.check();
  });

  test("set_template_flag", () => {
    const { h, gm, al } = boardPair();
    const e = h.commit((tx) => setTemplateFlag(tx, "note", true)).get("c1");
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["note"], removed: [] });
    expect(shape(deltaOf(e, al))).toEqual({ objects: ["note"], removed: [] });
    expect(deltaOf(e, gm)?.objects[0]?.is_template).toBe(true);
    h.check();
  });

  test("set_character_flag on Aldric: his whole view is recomputed", () => {
    const { h, gm, al } = boardPair();
    const off = h.commit((tx) => setCharacterFlag(tx, "aldric", false)).get("c1");
    expect(shape(deltaOf(off, gm))).toEqual({ objects: ["aldric"], removed: [] });
    expect(shape(deltaOf(off, al))).toEqual({ objects: [], removed: ALDRIC_SEES });
    h.check();
    const on = h.undo().get("c1");
    expect(shape(deltaOf(on, gm))).toEqual({ objects: ["aldric"], removed: [] });
    expect(shape(deltaOf(on, al))).toEqual({ objects: ALDRIC_SEES, removed: [] });
    h.check();
  });

  test("set_actions", () => {
    const { h, gm, al } = boardPair();
    const e = h
      .commit((tx) => setActions(tx, "note", [{ name: "Read", steps: ["1 -> text"] }]))
      .get("c1");
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["note"], removed: [] });
    expect(shape(deltaOf(e, al))).toEqual({ objects: ["note"], removed: [] });
    expect(deltaOf(e, gm)?.objects[0]?.actions).toEqual([{ name: "Read", steps: ["1 -> text"] }]);
    expect(deltaOf(e, al)?.objects[0]?.actions).toEqual([{ name: "Read" }]);
    h.check();
  });

  test("create_object inside a container: the container's contents re-sent", () => {
    const { h, gm, al } = boardPair();
    const e = h
      .commit((tx) => {
        createObject(
          tx,
          { cells: { name: c(text("Ring")) } },
          { type: "container", container: "chest" },
          "ring",
        );
      })
      .get("c1");
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["chest", "ring"], removed: [] });
    expect(shape(deltaOf(e, al))).toEqual({ objects: ["chest", "ring"], removed: [] });
    h.check();
  });

  test("remove inside a container: the container's contents re-sent", () => {
    const { h, gm, al } = boardPair();
    const e = h.commit((tx) => remove(tx, "coin")).get("c1");
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["chest"], removed: ["coin"] });
    expect(shape(deltaOf(e, al))).toEqual({ objects: ["chest"], removed: ["coin"] });
    h.check();
    const back = h.undo().get("c1");
    expect(shape(deltaOf(back, gm))).toEqual({ objects: ["chest", "coin"], removed: [] });
    expect(shape(deltaOf(back, al))).toEqual({ objects: ["chest", "coin"], removed: [] });
    h.check();
  });

  test("rename_board: boards in the event, no object delta", () => {
    const { h } = boardPair();
    const e = h.commit((tx) => renameBoard(tx, "table", "The table")).get("c1");
    expect(e?.boards).toEqual([
      { id: "table", name: "The table" },
      { id: "crypt", name: "crypt" },
      { id: "attic", name: "attic" },
    ]);
    expect(e?.deltas).toEqual([]);
    h.check();
  });

  test("add_board", () => {
    const { h } = boardPair();
    h.subscribe("c1", { scope: { type: "all" }, viewer: ALDRIC });
    const e = h.commit((tx) => addBoard(tx, "loft", "Loft")).get("c1");
    expect(e?.boards?.map((b) => b.id)).toEqual(["table", "crypt", "attic", "loft"]);
    expect(e?.deltas).toEqual([]);
    h.check();
  });

  test("remove_board", () => {
    const { h } = boardPair();
    h.subscribe("c1", { scope: { type: "all" }, viewer: ALDRIC });
    const e = h.commit((tx) => removeBoard(tx, "attic")).get("c1");
    expect(e?.boards?.map((b) => b.id)).toEqual(["table", "crypt"]);
    expect(e?.deltas).toEqual([]);
    h.check();
    const back = h.undo().get("c1");
    expect(back?.boards?.map((b) => b.id)).toEqual(["table", "crypt", "attic"]);
    h.check();
  });
});

describe("deterministic equivalence", () => {
  test("a sequence of every kind of change keeps every mirror equal to a fresh subscribe", () => {
    const h = new Harness(world());
    for (const viewer of [GM, ALDRIC]) {
      h.subscribe("c1", { scope: { type: "board", board: "table" }, viewer });
      h.subscribe("c1", { scope: { type: "board", board: "crypt" }, viewer, cells: "structural" });
      h.subscribe("c2", {
        scope: { type: "objects", ids: ["chest", "hand"], subtree: true },
        viewer,
      });
      h.subscribe("c2", { scope: { type: "objects", ids: ["card", "goblin"] }, viewer });
      h.subscribe("c2", { scope: { type: "all" }, viewer });
    }
    h.check();
    const steps: ((tx: Transaction) => void)[] = [
      (tx) => writeValue(tx, "note", "text", text("x")),
      (tx) => setFormula(tx, "note", "f", "1 + 2"),
      (tx) => writeValue(tx, "note", "f", num(7)),
      (tx) => clearOverride(tx, "note", "f"),
      (tx) => move(tx, "goblin", { type: "container", container: "chest" }),
      (tx) => writeValue(tx, "room", "visible_to", viewers("all")),
      (tx) => setCellVisibility(tx, "note", "text", viewers("gm")),
      (tx) => writeValue(tx, "card", "face_up", bool(false)),
      (tx) => move(tx, "card", { type: "board", board: "table", position: [11, 11] }),
      (tx) => writeValue(tx, "card", "owner", ref("aldric")),
      (tx) => writeValue(tx, "room", "visible_to", viewers("gm")),
      (tx) => setFormula(tx, "room", "opaque", '"maybe"'),
      (tx) => setShape(tx, "room", null),
      (tx) => setFormula(tx, "room", "position", '"nowhere"'),
      (tx) => setCharacterFlag(tx, "aldric", false),
      (tx) => setCharacterFlag(tx, "aldric", true),
      (tx) => remove(tx, "chest"),
      (tx) =>
        createObject(
          tx,
          { tag: ["die"], cells: { value: c(num(2)) } },
          { type: "board", board: "table", position: [10, -20] },
          "die2",
        ),
      (tx) => move(tx, "hand", { type: "board", board: "table", position: [1, 1] }),
      (tx) => removeBoard(tx, "attic"),
      (tx) => renameBoard(tx, "crypt", "Crypt"),
      (tx) => setFormula(tx, "hand", "visible_to", "owner"),
      (tx) => writeValue(tx, "hand", "owner", ref("goblin")),
    ];
    for (const step of steps) {
      h.commit(step);
      h.check();
    }
    for (let i = 0; i < 6; i++) {
      h.undo();
      h.check();
    }
  });
});

describe("scope changes", () => {
  test("moves between boards and containers enter and leave scopes", () => {
    const h = new Harness(world());
    const table = h.subscribe("c1", { scope: { type: "board", board: "table" } }).subscription;
    const crypt = h.subscribe("c1", {
      scope: { type: "board", board: "crypt" },
      viewer: ALDRIC,
    }).subscription;
    const chest = h.subscribe("c1", {
      scope: { type: "objects", ids: ["chest"], subtree: true },
    }).subscription;
    let e = h.commit((tx) => move(tx, "note", { type: "board", board: "crypt", position: [5, 5] }));
    expect(shape(deltaOf(e.get("c1"), table))).toEqual({ objects: [], removed: ["note"] });
    expect(shape(deltaOf(e.get("c1"), crypt))).toEqual({ objects: ["note"], removed: [] });
    expect(deltaOf(e.get("c1"), chest)).toBeUndefined();
    h.check();
    e = h.commit((tx) => move(tx, "note", { type: "container", container: "chest" }));
    expect(shape(deltaOf(e.get("c1"), table))).toEqual({ objects: ["chest", "note"], removed: [] });
    expect(shape(deltaOf(e.get("c1"), crypt))).toEqual({ objects: [], removed: ["note"] });
    expect(shape(deltaOf(e.get("c1"), chest))).toEqual({ objects: ["chest", "note"], removed: [] });
    h.check();
    e = h.commit((tx) => move(tx, "chest", { type: "container", container: "hand" }));
    expect(shape(deltaOf(e.get("c1"), table))).toEqual({
      objects: [],
      removed: ["chest", "coin", "gem", "note"],
    });
    expect(shape(deltaOf(e.get("c1"), crypt))).toEqual({
      objects: ["chest", "coin", "gem", "hand", "note"],
      removed: [],
    });
    h.check();
    h.undo();
    h.check();
  });

  test("a die moved into the dice tray re-sends the tray with its new sum", () => {
    const { h, gm, al } = boardPair();
    expect(h.table.value("tray", "tray_total")).toEqual(num(0));
    const e = h.commit((tx) => writeValue(tx, "die", "position", list([num(10), num(-20)])));
    const d = deltaOf(e.get("c1"), gm);
    expect(shape(d)).toEqual({ objects: ["die", "tray"], removed: [] });
    expect(d?.objects.find((o) => o.id === "tray")?.cells.tray_total?.value).toEqual(num(4));
    expect(shape(deltaOf(e.get("c1"), al))).toEqual({ objects: ["die", "tray"], removed: [] });
    h.check();
  });
});

describe("covers", () => {
  test("revealing a room: cover removed and tokens under it upserted for Aldric", () => {
    const { h, gm, al } = boardPair();
    const roomKey = h.mirrors.get(al)?.covers.keys().next().value;
    const e = h.commit((tx) => writeValue(tx, "room", "visible_to", viewers("all"))).get("c1");
    expect(shape(deltaOf(e, al))).toEqual({
      objects: ["goblin", "room"],
      removed: [],
      covers: { upsert: [], removed: [roomKey] },
    });
    expect(shape(deltaOf(e, gm))).toEqual({ objects: ["room"], removed: [] });
    h.check();
    const hide = h.undo().get("c1");
    expect(shape(deltaOf(hide, al))).toEqual({
      objects: [],
      removed: ["goblin", "room"],
      covers: { upsert: [roomKey], removed: [] },
    });
    h.check();
  });

  test("moving a hidden zone moves its cover and changes what it hides", () => {
    const { h, al } = boardPair();
    const e = h.commit((tx) => writeValue(tx, "room", "position", list([num(40), num(0)])));
    const d = deltaOf(e.get("c1"), al);
    expect(shape(d)).toEqual({
      objects: ["goblin"],
      removed: ["note"],
      covers: { upsert: [h.mirrors.get(al)?.covers.keys().next().value], removed: [] },
    });
    h.check();
  });

  test("an opaque toggle through a formula is visibility-relevant", () => {
    const h = new Harness(world([placed("switch", 60, 60, { cells: { on: c(bool(true)) } })]));
    h.commit((tx) => writeValue(tx, "room", "tmp", ref("switch")));
    h.commit((tx) => setFormula(tx, "room", "opaque", "tmp.on"));
    const al = h.subscribe("c1", {
      scope: { type: "board", board: "table" },
      viewer: ALDRIC,
    }).subscription;
    const roomKey = [...(h.mirrors.get(al)?.covers.keys() ?? [])][0];
    expect(roomKey).toBeDefined();
    const e = h.commit((tx) => writeValue(tx, "switch", "on", bool(false))).get("c1");
    expect(shape(deltaOf(e, al))).toEqual({
      objects: ["goblin", "switch"],
      removed: [],
      covers: { upsert: [], removed: [roomKey] },
    });
    h.check();
  });
});

describe("references in effective literal content", () => {
  const holders = (target: string) => [
    placed("hd", 100, 0, { cells: { r: c(ref(target)) } }),
    placed("hl", 101, 0, { cells: { r: c(list([num(1), list([ref(target)])])) } }),
    placed("hv", 102, 0, { cells: { visible_to: c(viewers("all", ref(target))) } }),
    placed("od", 103, 0, {
      cells: { r: { content: { type: "formula", source: "1" }, override: ref(target) } },
    }),
    placed("ol", 104, 0, {
      cells: {
        r: { content: { type: "formula", source: "1" }, override: list([list([ref(target)])]) },
      },
    }),
    placed("ov", 105, 0, {
      cells: {
        visible_to: {
          content: { type: "formula", source: "all" },
          override: viewers("all", ref(target)),
        },
      },
    }),
  ];
  const HOLDERS = ["hd", "hl", "hv", "od", "ol", "ov"];

  test("holders are re-sent when the target is removed and when the removal is undone", () => {
    const h = new Harness(world([placed("target", 200, 0), ...holders("target")]));
    const s = h.subscribe("c1", { scope: { type: "objects", ids: HOLDERS } }).subscription;
    expect(sorted(h.hub.referenceHolders("target"))).toEqual(HOLDERS);
    const gone = h.commit((tx) => remove(tx, "target")).get("c1");
    expect(shape(deltaOf(gone, s))).toEqual({ objects: HOLDERS, removed: [] });
    expect(deltaOf(gone, s)?.objects.find((o) => o.id === "hd")?.cells.r?.value.type).toBe("error");
    h.check();
    const back = h.undo().get("c1");
    expect(shape(deltaOf(back, s))).toEqual({ objects: HOLDERS, removed: [] });
    expect(deltaOf(back, s)?.objects.find((o) => o.id === "hd")?.cells.r?.value).toEqual(
      ref("target"),
    );
    h.check();
  });

  test("clearing an override that named the target drops the holder from the index", () => {
    const h = new Harness(world([placed("target", 200, 0), ...holders("target")]));
    const s = h.subscribe("c1", { scope: { type: "objects", ids: HOLDERS } }).subscription;
    const cleared = h.commit((tx) => clearOverride(tx, "od", "r")).get("c1");
    expect(shape(deltaOf(cleared, s))).toEqual({ objects: ["od"], removed: [] });
    expect(h.hub.referenceHolders("target")).not.toContain("od");
    const gone = h.commit((tx) => remove(tx, "target")).get("c1");
    expect(shape(deltaOf(gone, s))).toEqual({
      objects: HOLDERS.filter((id) => id !== "od"),
      removed: [],
    });
    h.check();
  });

  test("literal writes, formula sets and deletes keep the index current", () => {
    const h = new Harness(world([placed("target", 200, 0), placed("w", 100, 0)]));
    h.commit((tx) => writeValue(tx, "w", "r", list([ref("target")])));
    expect(h.hub.referenceHolders("target")).toEqual(["w"]);
    h.commit((tx) => setFormula(tx, "w", "r", "2"));
    expect(h.hub.referenceHolders("target")).toEqual([]);
    h.commit((tx) => writeValue(tx, "w", "r", ref("target")));
    expect(h.hub.referenceHolders("target")).toEqual(["w"]);
    h.commit((tx) => remove(tx, "w"));
    expect(h.hub.referenceHolders("target")).toEqual([]);
    h.undo();
    expect(h.hub.referenceHolders("target")).toEqual(["w"]);
  });

  test("a literal board ref: the holder is re-sent when the board is removed and re-created", () => {
    const h = new Harness(world([placed("hb", 100, 0, { cells: { r: c(ref("attic")) } })]));
    const s = h.subscribe("c1", { scope: { type: "objects", ids: ["hb"] } }).subscription;
    expect(h.hub.referenceHolders("attic")).toEqual(["hb"]);
    const gone = h.commit((tx) => removeBoard(tx, "attic")).get("c1");
    expect(shape(deltaOf(gone, s))).toEqual({ objects: ["hb"], removed: [] });
    h.check();
    const back = h.undo().get("c1");
    expect(shape(deltaOf(back, s))).toEqual({ objects: ["hb"], removed: [] });
    expect(deltaOf(back, s)?.objects[0]?.cells.r?.value).toEqual(ref("attic"));
    h.check();
  });

  test("board existence for a character: views follow a fresh subscribe", () => {
    const h = new Harness(
      world([
        placed("p", 100, 0, {
          contents: ["pc"],
          cells: {
            visible_to: c(viewers("all", ref("attic"))),
            lst: c(list([num(1), ref("attic")])),
          },
        }),
        obj("pc", { cells: { b: c(ref("attic")) } }),
        placed("q", 101, 0, { cells: { lst: c(list([ref("attic")])) } }),
      ]),
    );
    const relevant: boolean[] = [];
    h.table.onCommit(({ group, summary, dirty }) => {
      relevant.push(isVisibilityRelevant(group, summary, dirty));
    });
    const s = h.subscribe("c1", {
      scope: { type: "objects", ids: ["p", "q"], subtree: true },
      viewer: ALDRIC,
    }).subscription;
    expect(sorted([...(h.mirrors.get(s)?.objects.keys() ?? [])])).toEqual(["p", "pc", "q"]);
    // A dangling ref makes the whole literal read #REF (FORMULAS.md §2.4), before
    // any redaction: p's visible_to admits nobody, hiding p and pc; q shows #REF.
    const gone = h.commit((tx) => removeBoard(tx, "attic")).get("c1");
    expect(shape(deltaOf(gone, s))).toEqual({ objects: ["q"], removed: ["p", "pc"] });
    expect(deltaOf(gone, s)?.objects[0]?.cells.lst?.value).toMatchObject({
      type: "error",
      code: "#REF",
    });
    h.check();
    const back = h.undo().get("c1");
    expect(shape(deltaOf(back, s))).toEqual({ objects: ["p", "pc", "q"], removed: [] });
    expect(deltaOf(back, s)?.objects.find((o) => o.id === "pc")?.cells.b?.value).toEqual(
      ref("attic"),
    );
    h.check();
    expect(sorted([...(h.mirrors.get(s)?.objects.keys() ?? [])])).toEqual(["p", "pc", "q"]);
    expect(relevant).toEqual([true, true]);
  });
});

describe("selective recomputation and evaluation", () => {
  test("a literal write with no dependents on a 3,000-object board builds at most 3 views", () => {
    const tokens = Array.from({ length: 3000 }, (_, i) =>
      placed(`t${i}`, i % 100, Math.floor(i / 100), { cells: { hp: c(num(i)) } }),
    );
    const h = new Harness(Table.fromSnapshot(snapshot(tokens)));
    const s = h.subscribe("c1", { scope: { type: "board", board: "table" } }).subscription;
    const before = h.hub.stats().viewsBuilt;
    const e = h.commit((tx) => writeValue(tx, "t1234", "hp", num(-1))).get("c1");
    expect(h.hub.stats().viewsBuilt - before).toBeLessThanOrEqual(3);
    expect(shape(deltaOf(e, s))).toEqual({ objects: ["t1234"], removed: [] });
  });

  test("unreachable formulas stay dirty; a subscribed formula pulls its outside dependency", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("a", 0, 0, { cells: { bref: c(ref("b")), total: f("bref.x * 2") } }),
        placed("b", 1, 0, { cells: { cref: c(ref("cc")), x: f("cref.v + 1") } }),
        placed("cc", 2, 0, { cells: { v: c(num(1)) } }),
        placed("z", 3, 0, { cells: { cref: c(ref("cc")), w: f("cref.v * 3") } }),
      ]),
    );
    const h = new Harness(table);
    const s = h.subscribe("c1", { scope: { type: "objects", ids: ["a"] } }).subscription;
    expect(table.value("z", "w")).toEqual(num(3));
    const before = table.engine.stats().evaluations;
    const e = h.commit((tx) => writeValue(tx, "cc", "v", num(5))).get("c1");
    expect(table.engine.stats().evaluations - before).toBe(2);
    expect(deltaOf(e, s)?.objects[0]?.cells.total?.value).toEqual(num(12));
    expect(table.value("z", "w")).toEqual(num(15));
    expect(table.engine.stats().evaluations - before).toBe(3);
    h.check();
  });
});

describe("visibility relevance", () => {
  test("isVisibilityRelevant follows the rule", () => {
    const table = world();
    const seen: boolean[] = [];
    table.onCommit((p) => seen.push(isVisibilityRelevant(p.group, p.summary, p.dirty)));
    const run = (fn: (tx: Transaction) => void) => {
      const r = table.store.transact(GM_ACTOR, { kind: "edit", label: "x" }, fn);
      if (!r.ok) throw new Error(JSON.stringify(r.rejection));
    };
    run((tx) => writeValue(tx, "note", "text", text("x"))); // false
    run((tx) => writeValue(tx, "note", "face_up", bool(false))); // true
    run((tx) => setTag(tx, "note", ["a"])); // false
    run((tx) => setShape(tx, "note", null)); // true
    run((tx) => setCharacterFlag(tx, "note", true)); // true
    run((tx) => setTemplateFlag(tx, "note", true)); // false
    run((tx) => renameBoard(tx, "attic", "Attic")); // false
    run((tx) => addBoard(tx, "loft")); // true
    run((tx) => remove(tx, "gem")); // true
    run((tx) => writeValue(tx, "note", "owner", ref("aldric"))); // true
    expect(seen).toEqual([false, true, false, true, true, false, false, true, true, true]);
  });
});

describe("scope providers", () => {
  test("a log subscription without a provider is unsupported", () => {
    const h = new Harness(world());
    expect(() => h.hub.subscribe("c1", { scope: { type: "log" } })).toThrow(ProtocolFailure);
    try {
      h.hub.subscribe("c1", { scope: { type: "log" } });
    } catch (e) {
      expect((e as ProtocolFailure).error.code).toBe("unsupported");
    }
  });

  test("a registered provider receives subscribe, onCommit and drop; its result is merged", () => {
    const h = new Harness(world());
    const calls: string[] = [];
    const commits: CommitInfo[] = [];
    const provider: ScopeProvider = {
      subscribe(sub: ScopeSubscription) {
        calls.push(`subscribe ${sub.id} ${sub.conn} ${sub.viewer.type} ${sub.cells}`);
        return { groups: [] };
      },
      onCommit(sub, commit) {
        calls.push(`commit ${sub.id} ${commit.group.revision}`);
        commits.push(commit);
        if (commit.group.revision === 2) return null;
        const view = new ViewBuilder(h.table, sub.viewer).groupView(commit.group, {
          effects: true,
        }) as GroupView;
        return { groups_upserted: [view], groups_removed: [] };
      },
      drop(sub) {
        calls.push(`drop ${sub.id}`);
      },
    };
    h.hub.registerScope("log", provider);
    const r = h.hub.subscribe("c1", { scope: { type: "log" } });
    SubscribeResultSchema.parse(r);
    expect(r).toEqual({ subscription: "s1", revision: 0, objects: [], covers: [], groups: [] });
    const e1 = h.commit((tx) => writeValue(tx, "note", "text", text("x"))).get("c1");
    expect(e1?.deltas).toHaveLength(1);
    expect(e1?.deltas[0]?.subscription).toBe("s1");
    expect(e1?.deltas[0]?.objects).toEqual([]);
    expect(e1?.deltas[0]?.removed).toEqual([]);
    expect(e1?.deltas[0]?.groups_upserted?.map((g) => g.index)).toEqual([0]);
    const e2 = h.commit((tx) => writeValue(tx, "room", "visible_to", viewers("all"))).get("c1");
    expect(e2?.deltas).toEqual([]);
    h.hub.unsubscribe("c1", r.subscription);
    h.commit((tx) => writeValue(tx, "note", "text", text("y")));
    expect(calls).toEqual(["subscribe s1 c1 gm all", "commit s1 1", "commit s1 2", "drop s1"]);
    expect(commits.map((x) => x.visibilityRelevant)).toEqual([false, true]);
    expect(commits[0]?.summary.changedCells).toEqual(["note:text"]);
    expect(commits[0]?.dirty).toEqual([]);
  });

  test("the provider subscription counts toward the per-connection limit and is dropped with it", () => {
    const h = new Harness(world());
    const dropped: string[] = [];
    h.hub.registerScope("log", {
      subscribe: () => ({ groups: [] }),
      onCommit: () => null,
      drop: (sub) => dropped.push(sub.id),
    });
    for (let i = 0; i < 15; i++) h.hub.subscribe("c1", { scope: { type: "all" } });
    h.hub.subscribe("c1", { scope: { type: "log" }, viewer: ALDRIC });
    expect(() => h.hub.subscribe("c1", { scope: { type: "log" } })).toThrow(ProtocolFailure);
    h.hub.dropConnection("c1");
    expect(dropped).toEqual(["s16"]);
  });
});
