/** EngineCover (vtt-75c.12): opaque zones over an object, failing closed. */
import { remove, Table, type Viewer, writeValue } from "@vtt/authority";
import { bool, num, ref, text, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, commit, f, obj, placed, snapshot, zone } from "./helpers";

const cover = (table: Table, id: string) => {
  const r = table.cover.opaqueZonesCovering(id);
  return { covering: [...r.covering].sort(), undetermined: [...r.undetermined].sort() };
};

describe("opaqueZonesCovering", () => {
  test("an opaque zone whose region holds the anchor covers; others do not", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("dark", 0, 0, 10, { cells: { opaque: c(bool(true)) } }),
        zone("clear", 0, 0, 10),
        zone("far", 50, 50, 10, { cells: { opaque: c(bool(true)) } }),
        placed("chest", 4, 4),
        placed("rock", 6, 6),
      ]),
    );
    expect(cover(table, "chest")).toEqual({ covering: ["dark"], undetermined: [] });
    expect(cover(table, "rock")).toEqual({ covering: [], undetermined: [] });
    // A zone never covers itself.
    expect(cover(table, "dark")).toEqual({ covering: [], undetermined: [] });
  });

  test("the boundary is inside; rotation of the zone is respected", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("dark", 0, 0, 10, {
          shape: { type: "rect", width: 10, height: 2 },
          cells: { opaque: c(bool(true)), rotation: c(num(90)) },
        }),
        placed("edge", 1, 5),
        placed("side", 5, 0),
      ]),
    );
    expect(cover(table, "edge").covering).toEqual(["dark"]);
    expect(cover(table, "side").covering).toEqual([]);
  });

  test("an object in a container is covered when its outermost container is", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("dark", 0, 0, 10, { cells: { opaque: c(bool(true)) } }),
        placed("chest", 1, 1, { contents: ["pouch"] }),
        obj("pouch", { contents: ["gem"] }),
        obj("gem"),
      ]),
    );
    expect(cover(table, "gem").covering).toEqual(["dark"]);
  });

  test("an erroneous or non-boolean opaque is opaque: it covers exactly its region", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("bad_opaque", 0, 0, 10, { cells: { opaque: f("1 / 0") } }),
        zone("num_opaque", 0, 0, 10, { cells: { opaque: f("3") } }),
        zone("text_opaque", 0, 0, 10, { cells: { opaque: f('"yes"') } }),
        zone("far_bad", 30, 30, 2, { cells: { opaque: f("1 / 0") } }),
        zone("ok", 0, 0, 10, { cells: { opaque: f("true") } }),
        placed("chest", 1, 1),
        placed("rock", 20, 20),
      ]),
    );
    expect(cover(table, "chest")).toEqual({
      covering: ["bad_opaque", "num_opaque", "ok", "text_opaque"],
      undetermined: [],
    });
    expect(cover(table, "rock")).toEqual({ covering: [], undetermined: [] });
  });

  test("an error or a wrong type from a zone's geometry is undetermined", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("bad_pos", 0, 0, 10, { cells: { opaque: c(bool(true)), position: f("nope") } }),
        zone("bad_rot", 0, 0, 10, { cells: { opaque: c(bool(true)), rotation: f('"x"') } }),
        zone("bad_both", 0, 0, 10, { cells: { opaque: f("1 / 0"), position: f("nope") } }),
        zone("ok", 0, 0, 10, { cells: { opaque: f("true") } }),
        placed("chest", 1, 1),
      ]),
    );
    expect(cover(table, "chest")).toEqual({
      covering: ["ok"],
      undetermined: ["bad_both", "bad_pos", "bad_rot"],
    });
  });

  test("a zone with formula geometry is read through the engine", () => {
    const table = Table.fromSnapshot(
      snapshot([
        placed("lamp", 40, 40),
        obj("shadow", {
          board: "table",
          is_zone: true,
          shape: { type: "circle", radius: 3 },
          cells: { opaque: c(bool(true)), lamp: c(ref("lamp")), position: f("lamp.position") },
        }),
        placed("chest", 0, 0),
      ]),
    );
    expect(cover(table, "chest").covering).toEqual([]);
    commit(table, (tx) =>
      writeValue(tx, "lamp", "position", { type: "list", items: [num(1), num(1)] }),
    );
    expect(cover(table, "chest").covering).toEqual(["shadow"]);
  });

  test("an object whose anchor cannot be read fails closed against every possibly opaque zone", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("dark", 50, 50, 2, { cells: { opaque: c(bool(true)) } }),
        zone("clear", 50, 50, 2),
        zone("murky", 50, 50, 2, { cells: { opaque: f("1 / 0") } }),
        obj("ghost", { board: "table", cells: { position: f('"here"') } }),
      ]),
    );
    expect(cover(table, "ghost")).toEqual({ covering: [], undetermined: ["dark", "murky"] });
  });

  test("objects on another board are never covered by this board's zones", () => {
    const table = Table.fromSnapshot(
      snapshot(
        [
          zone("dark", 0, 0, 10, { cells: { opaque: c(bool(true)) } }),
          obj("chest", {
            board: "side",
            cells: {
              name: c(text("c")),
              position: { content: { type: "list", items: [num(1), num(1)] } },
            },
          }),
        ],
        ["table", "side"],
      ),
    );
    expect(cover(table, "chest")).toEqual({ covering: [], undetermined: [] });
  });
});

describe("an erroneous opaque through Visibility (DESIGN §4.4)", () => {
  const ALDRIC: Viewer = { type: "character", id: "aldric" };
  const GM: Viewer = { type: "gm" };
  const viewers = (...v: ViewersValue["viewers"]): ViewersValue => ({
    type: "viewers",
    viewers: v,
  });
  const errCode = (r: { type: string; code?: string }) => (r.type === "error" ? r.code : undefined);
  const world = (fog: Record<string, ReturnType<typeof c>>) =>
    Table.fromSnapshot(
      snapshot([
        placed("aldric", -20, -20, { is_character: true }),
        zone("fog", 0, 0, 10, { cells: { visible_to: c(viewers("gm")), ...fog } }),
        placed("chest", 1, 1),
        placed("tree", 30, 30),
        placed("lamp", 50, 50, { cells: { lit: c(bool(true)) } }),
      ]),
    );

  test("an opaque formula evaluating to #REF hides inside its region only", () => {
    const table = world({ lamp: c(ref("lamp")), opaque: f("lamp.lit") });
    expect(table.value("fog", "opaque")).toEqual(bool(true));
    commit(table, (tx) => remove(tx, "lamp"));
    expect(errCode(table.value("fog", "opaque"))).toBe("#REF");
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(false);
    expect(table.visibility.canSeeObject(ALDRIC, "tree")).toBe(true);
    expect(table.visibility.canSeeObject(GM, "chest")).toBe(true);
  });

  // Validation keeps a stored `opaque` literal (content or override) boolean,
  // so a non-boolean literal reaches the cover query as a formula's value.
  test("an opaque whose value is a non-boolean literal hides inside its region only", () => {
    const table = world({ opaque: f('"yes"') });
    expect(table.value("fog", "opaque")).toEqual(text("yes"));
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(false);
    expect(table.visibility.canSeeObject(ALDRIC, "tree")).toBe(true);
    expect(table.visibility.canSeeObject(GM, "chest")).toBe(true);
  });

  test("a zone whose position is an error still hides everything on its board", () => {
    const table = world({ opaque: c(bool(true)), position: f("1 / 0") });
    expect(errCode(table.value("fog", "position"))).toBe("#DIV0");
    expect(cover(table, "tree")).toEqual({ covering: [], undetermined: ["fog"] });
    expect(table.visibility.canSeeObject(ALDRIC, "chest")).toBe(false);
    expect(table.visibility.canSeeObject(ALDRIC, "tree")).toBe(false);
    expect(table.visibility.canSeeObject(GM, "tree")).toBe(true);
  });
});
