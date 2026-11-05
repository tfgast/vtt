import { dice, EMPTY, list, num, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { roll } from "./values-helpers";

describe("dot-access", () => {
  const cells = {
    self: {
      target: ref("goblin"),
      party: list([ref("aldric"), ref("goblin")]),
      nested: list([list([ref("aldric")]), ref("goblin")]),
      caster: EMPTY,
      n: num(3),
      name: text("me"),
    },
    aldric: { ac: num(16), items: list([text("sword"), text("rope")]), owner: ref("goblin") },
    goblin: { ac: num(12), items: text("club"), owner: EMPTY },
  };

  test("through a ref reads the named cell", () => {
    expect(run("target.ac", cells)).toEqual(num(12));
  });

  test("chains through refs", () => {
    expect(run("party.owner", cells)).toEqual(list([ref("goblin"), EMPTY]));
    expect(run("aldric_ref.owner.ac", { ...cells, self: { aldric_ref: ref("aldric") } })).toEqual(
      num(12),
    );
  });

  test("a missing cell on a ref is #NAME", () => {
    expect(run("target.hp", cells)).toMatchObject({ code: "#NAME" });
  });

  test("on a deleted ref is #REF", () => {
    const scope = { thisId: "self", it: ref("ghost") };
    expect(run("it.ac", cells, { scope })).toMatchObject({ code: "#REF" });
  });

  test("on empty is empty", () => {
    expect(run("caster.spell_dc", cells)).toEqual(EMPTY);
    expect(run("empty.anything.at_all", cells)).toEqual(EMPTY);
  });

  test("on a list of refs yields a list", () => {
    expect(run("party.ac", cells)).toEqual(list([num(16), num(12)]));
  });

  test("a cell holding a list contributes its items (flattened one level)", () => {
    expect(run("party.items", cells)).toEqual(list([text("sword"), text("rope"), text("club")]));
  });

  test("nested lists flatten: the result is always flat", () => {
    expect(run("nested.ac", cells)).toEqual(list([num(16), num(12)]));
  });

  test("on an empty list is an empty list", () => {
    expect(run("[].ac", cells)).toEqual(list([]));
  });

  test("on a list with a missing cell is #NAME", () => {
    expect(run("party.items_count", cells)).toMatchObject({ code: "#NAME" });
  });

  test("on a list containing empty yields empty for that item", () => {
    expect(run("[target, empty].ac", cells)).toEqual(list([num(12), EMPTY]));
  });

  test("on a list containing a non-ref is #TYPE", () => {
    expect(run("[target, 3].ac", cells)).toMatchObject({ code: "#TYPE" });
  });

  test("on this", () => {
    expect(run("this.n", cells)).toEqual(num(3));
  });

  test.each(["n.x", "name.x", '"a".x', "true.x", "2d6.x", "all.x"])("%s is #TYPE", (source) => {
    expect(run(source, cells)).toMatchObject({ code: "#TYPE" });
  });

  test("on an error yields it", () => {
    expect(run("missing.x", cells)).toMatchObject({ code: "#NAME" });
    expect(run("(1 / 0).x", cells)).toMatchObject({ code: "#DIV0" });
  });

  describe("on a roll result", () => {
    const r = { type: "roll" as const, expr: "4d6dl1", dice: [6, 5, 3], dropped: [1], total: 14 };
    const rolls = { self: { r, r2: roll(9) } };

    test(".total is the number", () => {
      expect(run("r.total", rolls)).toEqual(num(14));
    });

    test(".dice is the kept dice", () => {
      expect(run("r.dice", rolls)).toEqual(list([num(6), num(5), num(3)]));
    });

    test(".dropped is the dropped dice", () => {
      expect(run("r.dropped", rolls)).toEqual(list([num(1)]));
      expect(run("r2.dropped", rolls)).toEqual(list([]));
    });

    test(".expr is a dice value", () => {
      expect(run("r.expr", rolls)).toEqual(dice("4d6dl1"));
    });

    test("any other name is #NAME", () => {
      expect(run("r.foo", rolls)).toMatchObject({ code: "#NAME" });
      expect(run("r.value", rolls)).toMatchObject({ code: "#NAME" });
    });

    test("over a list of rolls flattens .dice", () => {
      expect(run("[r, r2].dice", rolls)).toEqual(list([num(6), num(5), num(3), num(9)]));
      expect(run("[r, r2].total", rolls)).toEqual(list([num(14), num(9)]));
    });
  });
});
