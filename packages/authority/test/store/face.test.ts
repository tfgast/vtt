/**
 * `setFace` and the `face` field (vtt-1xv.7; DESIGN.md §4.1, §4.6, §7;
 * PROTOCOL.md §5; M5-D7): one field effect per edit, an exact undo,
 * conflicts, replay and rewind, persistence, spawn and createObject.
 */
import {
  canonicalJson,
  changedCells,
  createObject,
  DocState,
  DocumentStore,
  keysIntersect,
  parseTable,
  Rejected,
  remove,
  replay,
  replayWithInverses,
  rewind,
  serializeTable,
  setFace,
  spawn,
  storedStateEqual,
  type Transaction,
  touchedKeys,
  undo,
} from "@vtt/authority";
import {
  type Actor,
  type Effect,
  type FaceLayout,
  type Rejection,
  type TableObject,
  toFixtureReason,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { must, named, table } from "./helpers";

const gm: Actor = { type: "gm" };
const edit = { kind: "edit", label: "edit" } as const;

const badge: FaceLayout = {
  elements: [
    { type: "value", cell: "hp", rect: [-0.5, -0.5, 1, 0.4], style: { size: "large" } },
    { type: "button", action: "Roll", rect: [-0.5, 0, 1, 0.4], show_when: "hp > 0" },
  ],
  default_action: "Roll",
};

const sheet: FaceLayout = {
  elements: [
    { type: "editor", cell: "name", rect: [-1, -1, 2, 0.5], min_size: 12 },
    { type: "contents", rect: [-1, 0, 2, 1], entries: "full" },
  ],
  collapsed: [{ type: "value", cell: "name", rect: [0, 0, 6, 0.6] }],
};

function run(store: DocumentStore, fn: (tx: Transaction) => void) {
  const result = store.transact(gm, edit, fn);
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result;
}

/** Expects `fn` refused `invalid` through `transact`, changing nothing. */
function expectInvalid(store: DocumentStore, fn: (tx: Transaction) => void): Rejection {
  const before = store.toSnapshot();
  const next = store.history.nextIndex;
  const tx = store.begin(gm, edit);
  expect(() => fn(tx)).toThrow(Rejected);
  expect(tx.changes().faceChanged).toEqual([]);
  tx.abort();
  const result = store.transact(gm, edit, fn);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.type).toBe("invalid");
  expect(store.toSnapshot()).toEqual(before);
  expect(store.history.nextIndex).toBe(next);
  return result.rejection;
}

const faceOf = (store: DocumentStore, id: string) => must(store.getObject(id)).face;
const hasFace = (store: DocumentStore, id: string) =>
  Object.hasOwn(must(store.getObject(id)), "face");

/** table() with `bag` carrying `sheet` and `coin` carrying `badge`. */
function faced() {
  const s = table();
  must(s.objects.bag).face = structuredClone(sheet);
  must(s.objects.coin).face = structuredClone(badge);
  return s;
}

describe("setFace", () => {
  test("records one field effect with the exact before and after", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = run(store, (tx) => setFace(tx, "goblin", badge));
    expect(first.group.effects).toEqual([
      { type: "field", object: "goblin", field: "face", before: null, after: badge },
    ]);
    const second = run(store, (tx) => setFace(tx, "goblin", sheet));
    expect(second.group.effects).toEqual([
      { type: "field", object: "goblin", field: "face", before: badge, after: sheet },
    ]);
    expect(faceOf(store, "goblin")).toEqual(sheet);
  });

  test("null removes the layout: the field is absent again", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => setFace(tx, "goblin", badge));
    const result = run(store, (tx) => setFace(tx, "goblin", null));
    expect(result.group.effects).toEqual([
      { type: "field", object: "goblin", field: "face", before: badge, after: null },
    ]);
    expect(hasFace(store, "goblin")).toBe(false);
    expect(store.toSnapshot().objects).toEqual(table().objects);
  });

  test("does not alias the caller's layout", () => {
    const store = DocumentStore.fromSnapshot(table());
    const mine = structuredClone(badge);
    run(store, (tx) => setFace(tx, "goblin", mine));
    mine.elements.pop();
    must(mine.elements[0]).rect[0] = 42;
    expect(faceOf(store, "goblin")).toEqual(badge);
  });

  test("lists the object in faceChanged once, and changes no readable cell", () => {
    const store = DocumentStore.fromSnapshot(table());
    const result = run(store, (tx) => {
      setFace(tx, "goblin", badge);
      setFace(tx, "bag", sheet);
      setFace(tx, "goblin", null);
    });
    expect(result.summary.faceChanged).toEqual(["goblin", "bag"]);
    expect(result.summary.actionsChanged).toEqual([]);
    expect(result.summary.changedCells).toEqual([]);
    expect(result.summary.writtenCells).toEqual([]);
  });

  test("undo restores the previous layout, and then no layout", () => {
    const store = DocumentStore.fromSnapshot(table());
    run(store, (tx) => setFace(tx, "goblin", badge));
    run(store, (tx) => setFace(tx, "goblin", sheet));
    expect(undo(store, gm).ok).toBe(true);
    expect(faceOf(store, "goblin")).toEqual(badge);
    expect(undo(store, gm).ok).toBe(true);
    expect(hasFace(store, "goblin")).toBe(false);
  });

  test("undo of a removal of the layout restores it", () => {
    const store = DocumentStore.fromSnapshot(faced());
    run(store, (tx) => setFace(tx, "bag", null));
    const result = undo(store, gm);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.group.effects).toEqual([
      { type: "field", object: "bag", field: "face", before: null, after: sheet },
    ]);
    expect(result.summary.faceChanged).toEqual(["bag"]);
    expect(faceOf(store, "bag")).toEqual(sheet);
  });

  test("a later setFace on the same object makes undo of the earlier one conflict", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = run(store, (tx) => setFace(tx, "goblin", badge)).group.index;
    const second = run(store, (tx) => setFace(tx, "goblin", sheet)).group.index;
    const result = undo(store, gm, { type: "group", index: first });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection).toMatchObject({ type: "undo_conflict", conflicting: [second] });
    expect(faceOf(store, "goblin")).toEqual(sheet);
  });

  test("a later setFace on another object does not conflict", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = run(store, (tx) => setFace(tx, "goblin", badge)).group.index;
    run(store, (tx) => setFace(tx, "bag", sheet));
    expect(undo(store, gm, { type: "group", index: first }).ok).toBe(true);
    expect(hasFace(store, "goblin")).toBe(false);
    expect(faceOf(store, "bag")).toEqual(sheet);
  });

  test("a later removal of the object conflicts", () => {
    const store = DocumentStore.fromSnapshot(table());
    const first = run(store, (tx) => setFace(tx, "goblin", badge)).group.index;
    const removal = run(store, (tx) => remove(tx, "goblin")).group.index;
    const result = undo(store, gm, { type: "group", index: first });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection).toMatchObject({ type: "undo_conflict", conflicting: [removal] });
  });

  test("a removal carries the face in its snapshot, and its undo restores it", () => {
    const store = DocumentStore.fromSnapshot(faced());
    const result = run(store, (tx) => remove(tx, "bag"));
    const removal = result.group.effects[0];
    expect(removal?.type).toBe("remove");
    if (removal?.type !== "remove") throw new Error("unreachable");
    expect(removal.objects.map((o) => [o.id, o.face])).toEqual([
      ["bag", sheet],
      ["coin", badge],
      ["gem", undefined],
    ]);
    expect(Object.hasOwn(must(removal.objects[2]), "face")).toBe(false);
    expect(undo(store, gm).ok).toBe(true);
    expect(faceOf(store, "bag")).toEqual(sheet);
    expect(faceOf(store, "coin")).toEqual(badge);
    expect(hasFace(store, "gem")).toBe(false);
  });

  describe("refusals", () => {
    const value = { type: "value", cell: "hp", rect: [0, 0, 1, 1] };
    const cases: [string, unknown][] = [
      ["a layout that is not an object", "face"],
      ["a layout without elements", {}],
      ["an unknown layout key", { elements: [], extra: 1 }],
      ["an unknown element key", { elements: [{ ...value, shown: true }] }],
      ["an element that is not an object", { elements: [null] }],
      ["an unknown element type", { elements: [{ ...value, type: "image" }] }],
      ["a malformed rect", { elements: [{ ...value, rect: [0, 0, 1] }] }],
      ["a zero-width rect", { elements: [{ ...value, rect: [0, 0, 0, 1] }] }],
      ["an empty cell name", { elements: [{ ...value, cell: "" }] }],
      ["an empty action name", { elements: [{ type: "button", action: "", rect: [0, 0, 1, 1] }] }],
      ["a blank show_when", { elements: [{ ...value, show_when: "  " }] }],
      ["a negative min_size", { elements: [{ ...value, min_size: -2 }] }],
      [
        "two contents elements",
        {
          elements: [
            { type: "contents", rect: [0, 0, 1, 1] },
            { type: "contents", rect: [0, 0, 1, 1] },
          ],
        },
      ],
      ["201 elements", { elements: Array.from({ length: 201 }, () => value) }],
      [
        "201 collapsed elements",
        { elements: [], collapsed: Array.from({ length: 201 }, () => value) },
      ],
    ];

    test.each(cases)("%s is invalid and changes nothing", (_, face) => {
      const store = DocumentStore.fromSnapshot(table());
      run(store, (tx) => setFace(tx, "goblin", badge));
      const rejection = expectInvalid(store, (tx) => setFace(tx, "goblin", face as FaceLayout));
      expect(toFixtureReason(rejection)).toBeNull();
      expect(faceOf(store, "goblin")).toEqual(badge);
    });

    test("an unknown object is invalid, also for null", () => {
      const store = DocumentStore.fromSnapshot(table());
      expectInvalid(store, (tx) => setFace(tx, "nobody", badge));
      expectInvalid(store, (tx) => setFace(tx, "nobody", null));
      expectInvalid(store, (tx) => setFace(tx, "map", null));
    });

    test("200 elements are accepted", () => {
      const store = DocumentStore.fromSnapshot(table());
      const face = { elements: Array.from({ length: 200 }, () => structuredClone(value)) };
      run(store, (tx) => setFace(tx, "goblin", face as FaceLayout));
      expect(faceOf(store, "goblin")?.elements).toHaveLength(200);
    });
  });
});

describe("the face field effect", () => {
  const effect: Effect = {
    type: "field",
    object: "goblin",
    field: "face",
    before: null,
    after: badge,
  };

  test("touches face:<obj>", () => {
    expect(touchedKeys(effect)).toEqual(["face:goblin"]);
  });

  test("face:<obj> intersects itself and obj:<obj>, nothing else", () => {
    expect(keysIntersect(["face:goblin"], ["face:goblin"])).toBe(true);
    expect(keysIntersect(["face:goblin"], ["obj:goblin"])).toBe(true);
    expect(keysIntersect(["obj:goblin"], ["face:goblin"])).toBe(true);
    expect(keysIntersect(["face:goblin"], ["face:bag"])).toBe(false);
    expect(keysIntersect(["face:goblin"], ["actions:goblin"])).toBe(false);
    expect(keysIntersect(["face:goblin"], ["obj:goblin_2", "obj:gob"])).toBe(false);
    expect(keysIntersect(["face:goblin"], ["cell:goblin/face", "cell:goblin/face_up"])).toBe(false);
  });

  test("changes no readable cell", () => {
    expect(changedCells(effect, DocState.fromSnapshot(table()))).toEqual([]);
  });
});

describe("spawn and createObject", () => {
  test("spawn copies every face of the subtree verbatim", () => {
    const s = faced();
    must(s.objects.bag).is_template = true;
    const store = DocumentStore.fromSnapshot(s);
    let root = "";
    const result = run(store, (tx) => {
      root = spawn(tx, "bag", { type: "board", board: "shelf", position: [0, 0] }).root;
    });
    const created = result.group.effects.find((e) => e.type === "create");
    if (created?.type !== "create") throw new Error("no create effect");
    expect(created.objects.map((o) => o.face)).toEqual([sheet, badge, undefined]);
    const rootCopy = must(store.getObject(root));
    expect(rootCopy.face).toEqual(sheet);
    const coinCopy = must(store.getObject(must(rootCopy.contents[0])));
    expect(coinCopy.face).toEqual(badge);
    expect(hasFace(store, must(rootCopy.contents[1]))).toBe(false);
    // A copy, not an alias.
    expect(rootCopy.face).not.toBe(faceOf(store, "bag"));
    run(store, (tx) => setFace(tx, root, null));
    expect(faceOf(store, "bag")).toEqual(sheet);
  });

  test("createObject accepts init.face", () => {
    const store = DocumentStore.fromSnapshot(table());
    let id = "";
    const result = run(store, (tx) => {
      id = createObject(
        tx,
        { face: badge, cells: { name: named("Die") } },
        {
          type: "board",
          board: "shelf",
          position: [1, 1],
        },
      );
    });
    expect(faceOf(store, id)).toEqual(badge);
    const created = result.group.effects.find((e) => e.type === "create");
    if (created?.type !== "create") throw new Error("no create effect");
    expect(must(created.objects[0]).face).toEqual(badge);
  });

  test("createObject refuses an init.face with a faceProblem", () => {
    const store = DocumentStore.fromSnapshot(table());
    const bad = { elements: [{ type: "value", cell: "", rect: [0, 0, 1, 1] }] } as FaceLayout;
    expectInvalid(store, (tx) => {
      createObject(tx, { face: bad }, { type: "board", board: "shelf", position: [1, 1] });
    });
  });
});

describe("persistence, replay and rewind", () => {
  test("face effects survive serialize → parse, replay, and undo after loading", () => {
    const base = faced();
    const store = DocumentStore.fromSnapshot(base);
    run(store, (tx) => setFace(tx, "goblin", badge));
    run(store, (tx) => setFace(tx, "bag", null));
    run(store, (tx) => remove(tx, "chest"));
    run(store, (tx) => setFace(tx, "goblin", sheet));

    const text = canonicalJson(serializeTable(store, []));
    const { store: loaded, editedExternally } = parseTable(text);
    expect(editedExternally).toBe(false);
    expect(loaded.toSnapshot()).toEqual(store.toSnapshot());
    expect(loaded.history.toLog()).toEqual(store.history.toLog());
    expect(replay(base, loaded.history.groups())).toEqual(loaded.toSnapshot());
    expect(canonicalJson(serializeTable(loaded, []))).toBe(text);

    expect(undo(loaded, gm, { type: "group", index: 1 }).ok).toBe(true);
    expect(faceOf(loaded, "bag")).toEqual(sheet);
    expect(faceOf(loaded, "goblin")).toEqual(sheet);
  });

  test("rewind restores the faces before the groups", () => {
    const base = faced();
    const store = DocumentStore.fromSnapshot(base);
    run(store, (tx) => setFace(tx, "goblin", badge));
    run(store, (tx) => setFace(tx, "bag", null));
    run(store, (tx) => remove(tx, "coin"));
    const groups = store.history.groups();
    const { snapshot: head, inverses } = replayWithInverses(base, groups);
    expect(storedStateEqual(head, store.toSnapshot(), { ignoreRevision: false })).toBe(true);
    const back = rewind(head, groups, inverses);
    expect(storedStateEqual(back, base, { ignoreRevision: false })).toBe(true);
    expect(back.objects.bag?.face).toEqual(sheet);
    expect(back.objects.coin?.face).toEqual(badge);
    expect(Object.hasOwn(must(back.objects.goblin), "face")).toBe(false);
  });

  test("canonical JSON orders face keys as the schema does, wherever a face appears", () => {
    const scrambled = {
      default_action: "Roll",
      collapsed: [{ rect: [0, 0, 6, 0.6], cell: "name", type: "value" }],
      elements: [
        {
          style: { caption: true, align: "center", size: "small" },
          min_size: 3,
          show_when: "hp > 0",
          rect: [0, 0, 1, 1],
          cell: "hp",
          type: "editor",
        },
        {
          min_size: 1,
          show_when: "x",
          label: "Go",
          rect: [0, 0, 1, 1],
          action: "Roll",
          type: "button",
        },
        { min_size: 2, show_when: "y", entries: "full", rect: [0, 0, 1, 1], type: "contents" },
      ],
    } as unknown as FaceLayout;
    const s = table();
    must(s.objects.coin).face = structuredClone(scrambled);
    const store = DocumentStore.fromSnapshot(s);
    run(store, (tx) => setFace(tx, "goblin", scrambled));
    run(store, (tx) => remove(tx, "bag"));

    const text = canonicalJson(serializeTable(store, []));
    const file = JSON.parse(text);
    const checkFace = (face: Record<string, unknown>) => {
      expect(Object.keys(face)).toEqual(["elements", "collapsed", "default_action"]);
      const [editor, btn, cont] = face.elements as Record<string, unknown>[];
      expect(Object.keys(must(editor))).toEqual([
        "type",
        "cell",
        "rect",
        "show_when",
        "min_size",
        "style",
      ]);
      expect(Object.keys(must(editor).style as object)).toEqual(["size", "align", "caption"]);
      expect(Object.keys(must(btn))).toEqual([
        "type",
        "action",
        "rect",
        "label",
        "show_when",
        "min_size",
      ]);
      expect(Object.keys(must(cont))).toEqual(["type", "rect", "entries", "show_when", "min_size"]);
      const [collapsed] = face.collapsed as Record<string, unknown>[];
      expect(Object.keys(must(collapsed))).toEqual(["type", "cell", "rect"]);
    };
    checkFace(file.snapshot.objects.goblin.face);
    const objectKeys = Object.keys(file.snapshot.objects.goblin);
    expect(objectKeys.at(-1)).toBe("face");
    expect(objectKeys.at(-2)).toBe("actions");
    const [setGroup, removeGroup] = file.log.groups;
    const fieldEffect = setGroup.effects[0];
    expect(Object.keys(fieldEffect)).toEqual(["type", "object", "field", "before", "after"]);
    expect(fieldEffect.before).toBeNull();
    checkFace(fieldEffect.after);
    const removed = removeGroup.effects[0].objects.find((o: TableObject) => o.id === "coin");
    checkFace(removed.face);

    expect(canonicalJson(serializeTable(parseTable(text).store, []))).toBe(text);
  });
});
