/** EngineCover (vtt-75c.12): opaque zones over an object, failing closed. */
import { Table, writeValue } from "@vtt/authority";
import { bool, num, ref, text } from "@vtt/schema";
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

  test("an error or a wrong type from any zone read is undetermined", () => {
    const table = Table.fromSnapshot(
      snapshot([
        zone("bad_opaque", 0, 0, 10, { cells: { opaque: f("1 / 0") } }),
        zone("num_opaque", 30, 30, 2, { cells: { opaque: f("3") } }),
        zone("bad_pos", 0, 0, 10, { cells: { opaque: c(bool(true)), position: f("nope") } }),
        zone("bad_rot", 0, 0, 10, { cells: { opaque: c(bool(true)), rotation: f('"x"') } }),
        zone("ok", 0, 0, 10, { cells: { opaque: f("true") } }),
        placed("chest", 1, 1),
      ]),
    );
    expect(cover(table, "chest")).toEqual({
      covering: ["ok"],
      undetermined: ["bad_opaque", "bad_pos", "bad_rot", "num_opaque"],
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
        obj("ghost", { board: "table", cells: { position: f('"here"') } }),
      ]),
    );
    expect(cover(table, "ghost")).toEqual({ covering: [], undetermined: ["dark"] });
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
