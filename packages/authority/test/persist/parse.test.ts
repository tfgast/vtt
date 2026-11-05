import {
  compactLog,
  DocumentStore,
  type LoadProblem,
  parseTable,
  TableLoadError,
  undo,
} from "@vtt/authority";
import type { OpGroup, Snapshot, TableLog } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { fileOf, gm, obj, playedStore, scene, setHp, textOf } from "./helpers";

/** Replaces the one occurrence of `from` in `text`. */
function handEdit(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}

/** The coin's name, a literal that appears once in the file. */
const COIN = '"value": "Coin"';
const COPPER = '"value": "Copper"';

/** The problems parseTable throws for `text`. */
function problemsOf(text: string): LoadProblem[] {
  try {
    parseTable(text);
  } catch (err) {
    expect(err).toBeInstanceOf(TableLoadError);
    const problems = (err as TableLoadError).problems;
    expect((err as Error).message).toContain(problems[0]?.message ?? "?");
    return problems;
  }
  throw new Error("expected a load error");
}

/** A store with ten hp writes, groups 0–9. */
function tenGroups(): DocumentStore {
  const store = DocumentStore.fromSnapshot(scene());
  for (let i = 0; i < 10; i++) setHp(store, 20 + i);
  return store;
}

describe("a hand-edited file", () => {
  test("parses with the edit, the log intact, earlier groups refused and new ones undoable", () => {
    const store = playedStore();
    const {
      store: loaded,
      editedExternally,
      warnings,
    } = parseTable(handEdit(textOf(store), COIN, COPPER));
    expect(editedExternally).toBe(true);
    expect(warnings).toEqual([expect.objectContaining({ type: "edited_externally" })]);
    expect(loaded.getCell("coin", "name")).toEqual({ content: { type: "text", value: "Copper" } });
    expect(loaded.history.toLog().groups).toEqual(store.history.toLog().groups);
    expect(loaded.history.firstIndex).toBe(0);
    expect(loaded.history.undoBarrier).toBe(4);

    for (const index of [0, 1, 2, 3]) {
      expect(undo(loaded, gm, { type: "group", index })).toMatchObject({
        ok: false,
        rejection: { type: "nothing_to_undo" },
      });
    }
    expect(undo(loaded, gm)).toMatchObject({ ok: false, rejection: { type: "nothing_to_undo" } });

    const fresh = setHp(loaded, 1);
    expect(fresh).toBe(4);
    const undone = undo(loaded, gm);
    expect(undone.ok && undone.group.undoes).toBe(4);
    expect(loaded.getCell("goblin", "hp")).toEqual(store.getCell("goblin", "hp"));
  });

  test("continues the revision from the last retained group", () => {
    const store = playedStore();
    const edited = handEdit(
      textOf(store),
      '"revision": 4,\n    "next_seq"',
      '"revision": 40,\n    "next_seq"',
    );
    const { store: loaded, editedExternally } = parseTable(edited);
    expect(editedExternally).toBe(true);
    expect(loaded.revision).toBe(4);
    setHp(loaded, 2);
    const last = loaded.history.groups().at(-1);
    expect(last).toMatchObject({ index: 4, base_revision: 4, revision: 5 });
  });

  test("with an empty log keeps the snapshot's revision", () => {
    const store = DocumentStore.fromSnapshot({ ...scene(), revision: 6 });
    const { store: loaded, editedExternally } = parseTable(handEdit(textOf(store), COIN, COPPER));
    expect(editedExternally).toBe(true);
    expect(loaded.revision).toBe(6);
    expect(loaded.history.undoBarrier).toBe(0);
  });

  test("after compaction to groups 8–9 sets the barrier to 10, not to the retained length", () => {
    const store = tenGroups();
    compactLog(store, 2);
    const text = textOf(store);
    expect(JSON.parse(text).log).toMatchObject({ first_index: 8, undo_barrier: 8 });

    const { store: loaded, editedExternally } = parseTable(handEdit(text, COIN, COPPER));
    expect(editedExternally).toBe(true);
    expect(loaded.history.groups().map((g) => g.index)).toEqual([8, 9]);
    expect(loaded.history.firstIndex).toBe(8);
    expect(loaded.history.undoBarrier).toBe(10);
    for (const index of [8, 9]) {
      expect(undo(loaded, gm, { type: "group", index })).toMatchObject({
        ok: false,
        rejection: { type: "nothing_to_undo" },
      });
    }
    expect(setHp(loaded, 3)).toBe(10);
    const undone = undo(loaded, gm);
    expect(undone.ok && undone.group).toMatchObject({ index: 11, undoes: 10 });
  });

  test("after compaction to an empty log sets the barrier to first_index", () => {
    const store = tenGroups();
    compactLog(store, 0);
    const { store: loaded } = parseTable(handEdit(textOf(store), COIN, COPPER));
    expect(loaded.history.groups()).toEqual([]);
    expect(loaded.history.firstIndex).toBe(10);
    expect(loaded.history.undoBarrier).toBe(10);
    expect(setHp(loaded, 3)).toBe(10);
    expect(undo(loaded, gm).ok).toBe(true);
  });
});

describe("an unedited file", () => {
  test("keeps the saved barrier", () => {
    const store = tenGroups();
    compactLog(store, 4);
    const { store: loaded, editedExternally } = parseTable(textOf(store));
    expect(editedExternally).toBe(false);
    expect(loaded.history.firstIndex).toBe(6);
    expect(loaded.history.undoBarrier).toBe(6);
    expect(undo(loaded, gm, { type: "group", index: 9 }).ok).toBe(true);
  });

  test("whitespace and key order are not edits", () => {
    const text = textOf(playedStore());
    const json = JSON.parse(text);
    const { editedExternally } = parseTable(JSON.stringify({ ...json, snapshot: json.snapshot }));
    expect(editedExternally).toBe(false);
    const reordered = { ...json, snapshot: { retired_ids: [], ...json.snapshot } };
    expect(parseTable(JSON.stringify(reordered)).editedExternally).toBe(false);
  });
});

/** A group of `kind` from `rev - 1` to `rev`. */
function group(index: number, rev: number, rest: Partial<OpGroup> = {}): OpGroup {
  return {
    index,
    base_revision: rev - 1,
    revision: rev,
    actor: { type: "gm" },
    kind: "edit",
    label: `g${index}`,
    names: {},
    effects: [],
    ...rest,
  };
}

const log = (groups: OpGroup[], first_index = 0, undo_barrier = first_index): TableLog => ({
  first_index,
  groups,
  undo_barrier,
});

const atRevision = (revision: number): Snapshot => ({ ...scene(), revision });

describe("load errors", () => {
  test("a valid hand-built file loads", () => {
    const { store } = parseTable(fileOf(atRevision(2), log([group(0, 1), group(1, 2)])));
    expect(store.revision).toBe(2);
  });

  test("not JSON", () => {
    expect(problemsOf("{ nope")).toEqual([expect.objectContaining({ stage: "json" })]);
  });

  test("a schema failure lists every issue", () => {
    const json = JSON.parse(fileOf(scene()));
    json.format = "something-else";
    json.snapshot.revision = -1;
    json.assets = ["/abs.png"];
    const problems = problemsOf(JSON.stringify(json));
    expect(problems.map((p) => p.stage)).toEqual(["schema", "schema", "schema"]);
    expect(problems.map((p) => p.path.join("."))).toEqual(
      expect.arrayContaining(["format", "snapshot.revision", "assets.0"]),
    );
  });

  test("a containment cycle", () => {
    const s = scene();
    s.objects.a = obj("a", { contents: ["b"] });
    s.objects.b = obj("b", { contents: ["a"] });
    expect(problemsOf(fileOf(s))).toContainEqual(
      expect.objectContaining({ stage: "snapshot", kind: "containment_cycle" }),
    );
  });

  test("a gap in group indices", () => {
    const text = fileOf(atRevision(2), log([group(0, 1), group(2, 2)]));
    expect(problemsOf(text)).toEqual([
      expect.objectContaining({ stage: "history", kind: "index", message: expect.any(String) }),
    ]);
  });

  test("a broken revision chain", () => {
    const text = fileOf(atRevision(3), log([group(0, 1), group(1, 3)]));
    expect(problemsOf(text)).toEqual([
      expect.objectContaining({ stage: "history", kind: "revision_chain" }),
    ]);
  });

  test("undoes on an edit group", () => {
    const text = fileOf(atRevision(2), log([group(0, 1), group(1, 2, { undoes: 0 })]));
    expect(problemsOf(text)).toEqual([
      expect.objectContaining({ stage: "history", kind: "undo_kind" }),
    ]);
  });

  test("an undo of an undo", () => {
    const groups = [
      group(0, 1),
      group(1, 2, { kind: "undo", undoes: 0 }),
      group(2, 3, { kind: "undo", undoes: 1 }),
    ];
    expect(problemsOf(fileOf(atRevision(3), log(groups)))).toEqual([
      expect.objectContaining({ stage: "history", kind: "undo_target" }),
    ]);
  });

  test("a barrier beyond the next index", () => {
    const text = fileOf(atRevision(2), log([group(0, 1), group(1, 2)], 0, 3));
    expect(problemsOf(text)).toEqual([
      expect.objectContaining({ stage: "history", kind: "barrier" }),
    ]);
  });

  test("a last group revision differing from the snapshot in an unedited file", () => {
    const text = fileOf(atRevision(5), log([group(0, 1), group(1, 2)]));
    expect(problemsOf(text)).toEqual([
      expect.objectContaining({ stage: "history", kind: "snapshot_revision" }),
    ]);
  });

  test("lists snapshot and history problems together", () => {
    const s = atRevision(2);
    s.objects.a = obj("a", { contents: ["b"] });
    s.objects.b = obj("b", { contents: ["a"] });
    const problems = problemsOf(fileOf(s, log([group(0, 1), group(2, 2)], 0, 9)));
    expect(problems).toContainEqual(expect.objectContaining({ kind: "containment_cycle" }));
    expect(problems).toContainEqual(expect.objectContaining({ kind: "index" }));
    expect(problems).toContainEqual(expect.objectContaining({ kind: "barrier" }));
  });
});
