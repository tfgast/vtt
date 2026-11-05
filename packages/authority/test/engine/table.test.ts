/**
 * Table (vtt-75c.12): the engine wired to the document store, the spatial
 * index and visibility (FORMULAS.md §3, §6, §7; DESIGN.md §4.2, §4.4, §7).
 */
import {
  clearOverride,
  DocumentStore,
  engineChanges,
  move,
  remove,
  setCellVisibility,
  setFormula,
  spawn,
  Table,
  undo,
  type Viewer,
  writeValue,
} from "@vtt/authority";
import { bool, list, num, ref, shape, text, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, commit, f, gm, obj, placed, snapshot, zone } from "./helpers";

const viewers = (...v: ViewersValue["viewers"]): ViewersValue => ({ type: "viewers", viewers: v });
const errCode = (r: { type: string; code?: string }) => (r.type === "error" ? r.code : undefined);

describe("recompute after a commit", () => {
  const goblin = () =>
    placed("goblin", 0, 0, {
      cells: { max_hp: c(num(7)), damage_taken: c(num(0)), hp: f("max_hp - damage_taken") },
    });

  test("hp = max_hp - damage_taken recomputes after a writeValue commit and not before", () => {
    const table = Table.fromSnapshot(snapshot([goblin()]));
    expect(table.value("goblin", "hp")).toEqual(num(7));
    const tx = table.store.begin(gm, { kind: "edit", label: "hit" });
    writeValue(tx, "goblin", "damage_taken", num(3));
    expect(table.value("goblin", "hp")).toEqual(num(7));
    tx.commit();
    expect(table.value("goblin", "hp")).toEqual(num(4));
  });

  test("an override shows instead of the formula result; clearing it resumes", () => {
    const table = Table.fromSnapshot(snapshot([goblin()]));
    commit(table, (tx) => writeValue(tx, "goblin", "hp", num(99)));
    expect(table.isOverridden("goblin", "hp")).toBe(true);
    expect(table.value("goblin", "hp")).toEqual(num(99));
    commit(table, (tx) => writeValue(tx, "goblin", "damage_taken", num(2)));
    expect(table.value("goblin", "hp")).toEqual(num(99));
    commit(table, (tx) => clearOverride(tx, "goblin", "hp"));
    expect(table.isOverridden("goblin", "hp")).toBe(false);
    expect(table.value("goblin", "hp")).toEqual(num(5));
  });

  test("a public onCommit observer registered before Table.fromStore reads the new value", () => {
    const store = DocumentStore.fromSnapshot(snapshot([goblin()]));
    const seen: unknown[] = [];
    let table: Table | undefined;
    store.onCommit(() => seen.push(table?.value("goblin", "hp")));
    table = Table.fromStore(store);
    expect(table.value("goblin", "hp")).toEqual(num(7));
    const result = commit(store, (tx) => writeValue(tx, "goblin", "damage_taken", num(5)));
    expect(result.ok && result.listenerErrors).toEqual([]);
    expect(seen).toEqual([num(2)]);
  });

  test("a cell_visibility change triggers no recomputation", () => {
    const table = Table.fromSnapshot(snapshot([goblin()]));
    expect(table.value("goblin", "hp")).toEqual(num(7));
    const before = table.engine.stats().evaluations;
    const result = commit(table, (tx) => setCellVisibility(tx, "goblin", "hp", viewers("gm")));
    expect(result.ok && engineChanges(result.summary)).toEqual([]);
    expect(table.value("goblin", "hp")).toEqual(num(7));
    expect(table.engine.stats().evaluations).toBe(before);
  });
});

describe("spatial queries follow moves", () => {
  test("a dice-tray zone sum follows a die moved in by move", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("tray", 0, 0, 4, {
          cells: { total: f('sum(contents(this).where(tag has "die").value)') },
        }),
        placed("d1", 1, 1, { tag: ["die"], cells: { value: c(num(4)) } }),
        placed("pawn", -1, 1, { cells: { value: c(num(100)) } }),
        placed("d2", 20, 20, { tag: ["die"], cells: { value: c(num(6)) } }),
      ]),
    );
    expect(table.value("tray", "total")).toEqual(num(4));
    commit(table, (tx) => move(tx, "d2", { type: "board", board: "table", position: [-1, -1] }));
    expect(table.value("tray", "total")).toEqual(num(10));
    commit(table, (tx) => move(tx, "d1", { type: "board", board: "table", position: [9, 9] }));
    expect(table.value("tray", "total")).toEqual(num(6));
  });

  test("speed follows a token moved into and out of a difficult zone", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("mud", 10, 10, 4, { tag: ["difficult"] }),
        zone("grass", 0, 0, 4),
        placed("token", 0, 0, {
          cells: {
            speed: f('if(len(zones_containing(this).where(tag has "difficult")) > 0, 15, 30)'),
          },
        }),
      ]),
    );
    expect(table.value("token", "speed")).toEqual(num(30));
    commit(table, (tx) => move(tx, "token", { type: "board", board: "table", position: [11, 9] }));
    expect(table.value("token", "speed")).toEqual(num(15));
    commit(table, (tx) => move(tx, "token", { type: "board", board: "table", position: [1, 1] }));
    expect(table.value("token", "speed")).toEqual(num(30));
  });

  test("a position formula following another object puts the follower in a zone's contents", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("room", 10, 10, 4, { cells: { inside: f("contents(this)") } }),
        placed("leader", 0, 0),
        obj("follower", {
          board: "table",
          cells: { leader: c(ref("leader")), position: f("leader.position") },
        }),
      ]),
    );
    expect(table.value("room", "inside")).toEqual(list([]));
    commit(table, (tx) =>
      move(tx, "leader", { type: "board", board: "table", position: [10, 10] }),
    );
    expect(table.value("follower", "position")).toEqual(list([num(10), num(10)]));
    const inside = table.value("room", "inside");
    expect(inside.type === "list" && inside.items).toContainEqual(ref("follower"));
    expect(inside.type === "list" && inside.items).toContainEqual(ref("leader"));
  });

  test("two positions defined from each other give #CYCLE", () => {
    const table = Table.fromSnapshot(
      snapshot([
        obj("a", { board: "table", cells: { other: c(ref("b")), position: f("other.position") } }),
        obj("b", { board: "table", cells: { other: c(ref("a")), position: f("other.position") } }),
        zone("room", 0, 0, 4, { cells: { inside: f("contents(this)") } }),
      ]),
    );
    expect(errCode(table.value("a", "position"))).toBe("#CYCLE");
    expect(errCode(table.value("b", "position"))).toBe("#CYCLE");
    expect(errCode(table.value("room", "inside"))).toBe("#CYCLE");
    // Breaking the cycle recomputes every affected cell.
    commit(table, (tx) => writeValue(tx, "b", "position", list([num(1), num(1)])));
    expect(table.value("a", "position")).toEqual(list([num(1), num(1)]));
    const inside = table.value("room", "inside");
    expect(inside.type === "list" && inside.items.length).toBe(2);
  });
});

describe("structure, names and references", () => {
  test("len(contents) changes after a spawn into the container and a remove from it", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("bag", 0, 0, { contents: ["coin"], cells: { count: f("len(contents)") } }),
        obj("coin"),
        placed("gem", 5, 5, { is_template: true }),
      ]),
    );
    expect(table.value("bag", "count")).toEqual(num(1));
    let gemCopy = "";
    commit(table, (tx) => {
      gemCopy = spawn(tx, "gem", { type: "container", container: "bag" }).root;
    });
    expect(table.value("bag", "count")).toEqual(num(2));
    expect(table.value("bag", "contents")).toEqual(list([ref("coin"), ref(gemCopy)]));
    commit(table, (tx) => remove(tx, "coin"));
    expect(table.value("bag", "count")).toEqual(num(1));
  });

  test("#REF after removing a referenced object, and the value again after undo", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("goblin", 0, 0, { cells: { ac: c(num(13)) } }),
        placed("card", 3, 0, { cells: { target: c(ref("goblin")), dc: f("target.ac") } }),
      ]),
    );
    expect(table.value("card", "dc")).toEqual(num(13));
    commit(table, (tx) => remove(tx, "goblin"));
    expect(errCode(table.value("card", "dc"))).toBe("#REF");
    expect(errCode(table.value("goblin", "ac"))).toBe("#REF");
    expect(undo(table.store, gm).ok).toBe(true);
    expect(table.value("card", "dc")).toEqual(num(13));
  });

  test('obj("Goblin") resolves by name and changes after the name is rewritten', () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("g1", 0, 0, { cells: { name: c(text("Goblin")), hp: c(num(7)) } }),
        placed("o1", 1, 0, { cells: { name: c(text("Orc")), hp: c(num(15)) } }),
        placed("card", 2, 0, { cells: { target_hp: f('obj("Goblin").hp') } }),
      ]),
    );
    expect(table.value("card", "target_hp")).toEqual(num(7));
    commit(table, (tx) => writeValue(tx, "g1", "name", text("Boss")));
    expect(errCode(table.value("card", "target_hp"))).toBe("#REF");
    commit(table, (tx) => writeValue(tx, "o1", "name", text("Goblin")));
    expect(table.value("card", "target_hp")).toEqual(num(15));
  });

  test("shape reads as a ShapeValue", () => {
    const table = Table.fromSnapshot(snapshot([zone("room", 0, 0, 4), placed("pawn", 1, 1)]));
    expect(table.value("room", "shape")).toEqual(shape({ type: "rect", width: 4, height: 4 }));
    expect(table.value("pawn", "shape")).toEqual({ type: "empty" });
    expect(table.value("room", "is_zone")).toEqual(bool(true));
  });

  test("a formula written after construction evaluates through the store", () => {
    const table = Table.fromSnapshot(snapshot([placed("p", 0, 0, { cells: { a: c(num(2)) } })]));
    commit(table, (tx) => setFormula(tx, "p", "b", "a * 3"));
    expect(table.value("p", "b")).toEqual(num(6));
    expect(errCode(table.value("p", "nope"))).toBe("#NAME");
    expect(errCode(table.value("ghost", "a"))).toBe("#REF");
  });
});

describe("visibility through the real cover query", () => {
  const ALDRIC: Viewer = { type: "character", id: "aldric" };
  const GM: Viewer = { type: "gm" };
  const world = (opaque: ReturnType<typeof c>) =>
    Table.fromSnapshot(
      snapshot([
        placed("aldric", -20, -20, { is_character: true }),
        zone("fog", 0, 0, 10, { cells: { opaque, visible_to: c(viewers("gm")) } }),
        placed("chest", 1, 1),
        placed("tree", 30, 30),
      ]),
    );

  test("an object under a hidden opaque zone is not visible to a character", () => {
    const table = world(c(bool(true)));
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(false);
    expect(table.visibility.canSeeObject(ALDRIC, "tree")).toBe(true);
    expect(table.visibility.canSeeObject(GM, "chest")).toBe(true);
    commit(table, (tx) => writeValue(tx, "fog", "visible_to", viewers("all")));
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(true);
  });

  test("a hidden zone whose opaque formula is an error also hides it", () => {
    const table = world(f("1 / 0"));
    expect(errCode(table.value("fog", "opaque"))).toBe("#DIV0");
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(false);
    // Treated as opaque, not undetermined: only its region is covered.
    expect(table.visibility.canSeeObject(ALDRIC, "tree")).toBe(true);
    expect(table.visibility.canSeeObject(GM, "chest")).toBe(true);
  });

  test("an opaque formula that turns false reveals what is under it", () => {
    const table = world(f("lit"));
    commit(table, (tx) => writeValue(tx, "fog", "lit", bool(true)));
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(false);
    commit(table, (tx) => writeValue(tx, "fog", "lit", bool(false)));
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(true);
  });

  test("a formula visible_to evaluates through the engine", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("aldric", -20, -20, { is_character: true }),
        placed("note", 40, 40, { cells: { owner: c(ref("aldric")), visible_to: f("owner") } }),
      ]),
    );
    expect(table.visibility.canSeeObject(ALDRIC, "note")).toBe(true);
    commit(table, (tx) => writeValue(tx, "note", "owner", { type: "empty" }));
    expect(table.visibility.canSeeObject(ALDRIC, "note")).toBe(false);
  });
});

describe("engineChanges", () => {
  test("a move reports the derived cells; create and remove report every object", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("bag", 0, 0, { contents: ["coin"] }),
        obj("coin", { contents: ["dust"] }),
        obj("dust"),
      ]),
    );
    const moved = commit(table, (tx) =>
      move(tx, "coin", { type: "board", board: "table", position: [2, 2] }),
    );
    const cells = moved.ok ? engineChanges(moved.summary) : [];
    for (const cell of ["board", "position", "rotation", "z", "container"]) {
      expect(cells).toContainEqual({ type: "cell", object: "coin", cell });
    }
    expect(cells).toContainEqual({ type: "cell", object: "bag", cell: "contents" });
    const removed = commit(table, (tx) => remove(tx, "coin"));
    const changes = removed.ok ? engineChanges(removed.summary) : [];
    expect(changes).toContainEqual({ type: "object_deleted", object: "coin" });
    expect(changes).toContainEqual({ type: "object_deleted", object: "dust" });
    const restored = undo(table.store, gm);
    const back = restored.ok ? engineChanges(restored.summary) : [];
    expect(back).toContainEqual({ type: "object_created", object: "coin" });
    expect(back).toContainEqual({ type: "object_created", object: "dust" });
  });
});
