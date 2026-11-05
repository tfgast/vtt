/**
 * Historical faces in group views (vtt-1xv.7; PROTOCOL.md §7.6; M5-D7,
 * M5-D23; review r2 findings 5, 6): `field: "face"` effects and create and
 * remove snapshots carry `FaceLayoutView`s, lossless for the GM and, for a
 * character, filtered by current visibility (D15) with stored indices kept.
 */
import {
  changesSince,
  logPage,
  remove,
  replay,
  setFace,
  spawn,
  Table,
  type Transaction,
  undo,
  ViewBuilder,
  type Viewer,
} from "@vtt/authority";
import { type EffectView, type FaceLayoutView, type GroupView, parseResult } from "@vtt/protocol";
import {
  type Actor,
  type FaceLayout,
  num,
  type Snapshot,
  text,
  type ViewersValue,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, placed, snapshot } from "../engine/helpers";

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const GM_ACTOR: Actor = { type: "gm" };
const gmOnly: ViewersValue = { type: "viewers", viewers: ["gm"] };

/** Element 0 names the GM-only `ac`; 1 and 2 are readable with a show-when. */
const face: FaceLayout = {
  elements: [
    { type: "value", cell: "ac", rect: [-1, -1, 1, 0.5], style: { caption: true } },
    { type: "value", cell: "hp", rect: [0, -1, 1, 0.5], show_when: "hp > 0", min_size: 10 },
    { type: "button", action: "Roll", rect: [-1, 0, 2, 0.5], show_when: "roll = empty" },
    { type: "contents", rect: [-1, 0.5, 2, 0.5] },
  ],
  collapsed: [
    { type: "value", cell: "ac", rect: [0, 0, 3, 0.6] },
    { type: "value", cell: "name", rect: [3, 0, 3, 0.6], show_when: "true" },
  ],
  default_action: "Roll",
};

const gmFace: FaceLayoutView = {
  elements: face.elements.map((e, index) => ({ ...e, index })),
  collapsed: (face.collapsed ?? []).map((e, index) => ({ ...e, index })),
  default_action: "Roll",
};

const aldricFace: FaceLayoutView = {
  elements: [
    { type: "value", cell: "hp", rect: [0, -1, 1, 0.5], min_size: 10, index: 1 },
    { type: "button", action: "Roll", rect: [-1, 0, 2, 0.5], index: 2 },
    { type: "contents", rect: [-1, 0.5, 2, 0.5], index: 3 },
  ],
  collapsed: [{ type: "value", cell: "name", rect: [3, 0, 3, 0.6], index: 1 }],
  default_action: "Roll",
};

/** A face Aldric can read entirely: only show-when is withheld. */
const readable: FaceLayout = {
  elements: [{ type: "value", cell: "hp", rect: [0, 0, 1, 1], show_when: "hp > 0" }],
};

const cardCells = () => ({ name: c(text("Card")), hp: c(num(5)), ac: c(num(12)) });

/**
 * `aldric` (a character); `goblin` (visible, GM-only `ac`); `secret` (GM
 * only); template `card` carrying `face` with a GM-only `ac`.
 */
function base(): Snapshot {
  return snapshot([
    placed("aldric", 0, 0, { is_character: true, cells: { name: c(text("Aldric")) } }),
    placed("goblin", 1, 0, {
      cells: { name: c(text("Goblin")), hp: c(num(7)), ac: c(num(12)) },
      cell_visibility: { ac: gmOnly },
    }),
    placed("secret", 2, 0, {
      cells: { name: c(text("Secret")), visible_to: c(gmOnly) },
    }),
    placed("card", 9, 9, {
      is_template: true,
      cells: cardCells(),
      cell_visibility: { ac: gmOnly },
      face: structuredClone(face),
    }),
  ]);
}

function commit(table: Table, fn: (tx: Transaction) => void) {
  const r = table.store.transact(GM_ACTOR, { kind: "edit", label: "edit" }, fn);
  if (!r.ok) throw new Error(JSON.stringify(r.rejection));
  return r.group;
}

const view = (table: Table, viewer: Viewer) => new ViewBuilder(table, viewer);

const groupOf = (table: Table, viewer: Viewer, index: number): GroupView | null => {
  const g = table.store.history.get(index);
  if (g === undefined) throw new Error(`no group ${index}`);
  return view(table, viewer).groupView(g, { effects: true });
};

const snapshotFaces = (effects: EffectView[] | undefined, type: "create" | "remove") =>
  (effects ?? [])
    .flatMap((e) => (e.type === type ? e.objects : []))
    .map((o) => [o.id, o.face] as const);

describe("field: face effects", () => {
  test("the GM's effect is lossless: every element with its index and show_when", () => {
    const t = Table.fromSnapshot(base());
    const group = commit(t, (tx) => setFace(tx, "goblin", face));
    const effect = group.effects[0];
    if (effect === undefined) throw new Error("no effect");
    expect(view(t, GM).filterEffect(effect)).toEqual({
      view: { type: "field", object: "goblin", field: "face", before: null, after: gmFace },
      reduced: false,
    });
  });

  test("Aldric's drops the element naming a GM-only cell, strips show_when, keeps indices", () => {
    const t = Table.fromSnapshot(base());
    const group = commit(t, (tx) => setFace(tx, "goblin", face));
    const filtered = view(t, ALDRIC).filterEffect(group.effects[0] as never);
    expect(filtered.view).toEqual({
      type: "field",
      object: "goblin",
      field: "face",
      before: null,
      after: aldricFace,
    });
    expect(filtered.reduced).toBe(true);
    expect(groupOf(t, ALDRIC, group.index)?.label).toBeNull();
    expect(groupOf(t, GM, group.index)?.label).toBe("edit");
  });

  test("removing the layout is null on both sides; withholding only show-when keeps the label", () => {
    const t = Table.fromSnapshot(base());
    commit(t, (tx) => setFace(tx, "goblin", readable));
    const group = commit(t, (tx) => setFace(tx, "goblin", null));
    expect(groupOf(t, ALDRIC, 0)?.effects).toEqual([
      {
        type: "field",
        object: "goblin",
        field: "face",
        before: null,
        after: { elements: [{ type: "value", cell: "hp", rect: [0, 0, 1, 1], index: 0 }] },
      },
    ]);
    expect(groupOf(t, ALDRIC, 0)?.label).toBe("edit");
    expect(groupOf(t, ALDRIC, group.index)?.effects?.[0]).toMatchObject({
      after: null,
      before: { elements: [{ index: 0 }] },
    });
  });

  test("an effect on an object Aldric cannot see is dropped", () => {
    const t = Table.fromSnapshot(base());
    const group = commit(t, (tx) => setFace(tx, "secret", face));
    expect(view(t, ALDRIC).effectView(group.effects[0] as never)).toBeNull();
    expect(groupOf(t, ALDRIC, group.index)).toBeNull();
  });
});

describe("create and remove snapshots", () => {
  test("a spawn of a faced template carries the face: lossless for the GM, filtered for Aldric", () => {
    const t = Table.fromSnapshot(base());
    let copy = "";
    const group = commit(t, (tx) => {
      copy = spawn(tx, "card", { type: "board", board: "table", position: [4, 4] }).root;
    });
    expect(snapshotFaces(groupOf(t, GM, group.index)?.effects, "create")).toEqual([[copy, gmFace]]);
    expect(snapshotFaces(groupOf(t, ALDRIC, group.index)?.effects, "create")).toEqual([
      [copy, aldricFace],
    ]);
    expect(groupOf(t, ALDRIC, group.index)?.label).toBeNull();
  });

  test("a snapshot of an object without a layout has no face", () => {
    const t = Table.fromSnapshot(base());
    const group = commit(t, (tx) => remove(tx, "goblin"));
    const [snap] = (groupOf(t, GM, group.index)?.effects ?? []).flatMap((e) =>
      e.type === "remove" ? e.objects : [],
    );
    expect(snap).toBeDefined();
    expect(snap !== undefined && "face" in snap).toBe(false);
  });

  test("a remove: lossless for the GM, omitted for Aldric until an undo restores the object", () => {
    const t = Table.fromSnapshot(base());
    commit(t, (tx) => setFace(tx, "goblin", face));
    const removal = commit(t, (tx) => remove(tx, "goblin"));

    expect(snapshotFaces(groupOf(t, GM, removal.index)?.effects, "remove")).toEqual([
      ["goblin", gmFace],
    ]);
    // Removed, so invisible now (D15): no snapshot, and nothing else to show.
    expect(groupOf(t, ALDRIC, removal.index)).toBeNull();

    expect(undo(t.store, GM_ACTOR).ok).toBe(true);
    expect(t.store.getObject("goblin")?.face).toEqual(face);
    const restored = groupOf(t, ALDRIC, removal.index);
    expect(snapshotFaces(restored?.effects, "remove")).toEqual([["goblin", aldricFace]]);
    expect(restored?.label).toBeNull();
    // The undo group's create carries the same filtered face.
    expect(snapshotFaces(groupOf(t, ALDRIC, removal.index + 1)?.effects, "create")).toEqual([
      ["goblin", aldricFace],
    ]);
  });

  test("replaying the face edit, the removal and its undo restores the face", () => {
    const start = base();
    const t = Table.fromSnapshot(start);
    commit(t, (tx) => setFace(tx, "goblin", face));
    commit(t, (tx) => remove(tx, "goblin"));
    expect(undo(t.store, GM_ACTOR).ok).toBe(true);
    const replayed = replay(start, t.store.history.groups());
    expect(replayed).toEqual(t.store.toSnapshot());
    expect(replayed.objects.goblin?.face).toEqual(face);
  });
});

describe("log and changes_since results with faces pass the client's validation", () => {
  /** A table whose log holds a face edit, a spawn, a removal and its undo. */
  function played(): Table {
    const t = Table.fromSnapshot(base());
    commit(t, (tx) => setFace(tx, "goblin", face));
    commit(t, (tx) => {
      spawn(tx, "card", { type: "board", board: "table", position: [4, 4] });
    });
    commit(t, (tx) => remove(tx, "goblin"));
    expect(undo(t.store, GM_ACTOR).ok).toBe(true);
    return t;
  }

  /** Every FaceLayoutView in a result's groups. */
  function faces(groups: GroupView[]): FaceLayoutView[] {
    const out: FaceLayoutView[] = [];
    for (const g of groups) {
      for (const e of g.effects ?? []) {
        if (e.type === "field" && e.field === "face") {
          for (const f of [e.before, e.after]) if (f !== null) out.push(f);
        }
        if (e.type === "create" || e.type === "remove") {
          for (const o of e.objects) if (o.face !== undefined && o.face !== null) out.push(o.face);
        }
      }
    }
    return out;
  }

  const viewers: [string, Viewer, FaceLayoutView][] = [
    ["GM", GM, gmFace],
    ["Aldric", ALDRIC, aldricFace],
  ];

  test.each(viewers)("%s", (_, viewer, expected) => {
    const t = played();
    const changes = changesSince(t, { revision: 0, viewer });
    const parsedChanges = parseResult("changes_since", JSON.parse(JSON.stringify(changes)));
    expect(parsedChanges).toEqual({ ok: true, value: changes, warnings: [] });

    const log = logPage(t, { viewer, effects: true });
    const parsedLog = parseResult("log", JSON.parse(JSON.stringify(log)));
    expect(parsedLog).toEqual({ ok: true, value: log, warnings: [] });

    // The face edit, the spawned copy, the removal and the undo's re-creation.
    const all = faces(changes.groups);
    expect(all).toHaveLength(4);
    for (const f of all) expect(f).toEqual(expected);
    for (const f of [...all, ...faces(log.groups)]) {
      for (const e of [...f.elements, ...(f.collapsed ?? [])]) {
        expect(typeof e.index).toBe("number");
        expect("shown" in e).toBe(false);
      }
    }
  });
});
