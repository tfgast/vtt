import { defaultRegistry } from "@vtt/formula";
import { bool, dice, EMPTY, list, num, type RollValue, ref, text, type Value } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { FakeEnv } from "./support/fake-env";

const roll = (expr: string, total: number): RollValue => ({
  type: "roll",
  expr,
  dice: [total],
  dropped: [],
  total,
});

const tags = (...names: string[]): Value => list(names.map(text));
const refs = (...ids: string[]): Value => list(ids.map(ref));

describe("where", () => {
  test("[3, 1, 2].where(it > 1)", () => {
    expect(run("[3, 1, 2].where(it > 1)")).toEqual(list([num(3), num(2)]));
  });

  test("keeps items whose predicate is truthy, in order", () => {
    expect(run('[0, 1, "", "a", empty, []].where(it)')).toEqual(list([num(1), text("a")]));
    expect(run("[1, 2, 3].where(false)")).toEqual(list([]));
    expect(run("[].where(it > 1)")).toEqual(list([]));
  });

  test("an empty target is []", () => {
    expect(run("blank.where(it > 1)", { self: { blank: EMPTY } })).toEqual(list([]));
  });

  test("a non-list target is #TYPE", () => {
    expect(run("(3).where(it > 1)")).toMatchObject({ code: "#TYPE" });
    expect(run("this.where(true)")).toMatchObject({ code: "#TYPE" });
  });

  test("a target error propagates", () => {
    expect(run("nope.where(true)")).toMatchObject({ code: "#NAME" });
  });

  test("a predicate error makes the whole result that error", () => {
    expect(run("[1, 0, 2].where(1 / it > 0)")).toMatchObject({ code: "#DIV0" });
    expect(run('[1, "a"].where(it > 0)')).toMatchObject({ code: "#TYPE" });
  });

  test("the first item's error wins", () => {
    expect(run('[0, "a"].where(1 / it > 0)')).toMatchObject({ code: "#DIV0" });
    expect(run('["a", 0].where(1 / it > 0)')).toMatchObject({ code: "#TYPE" });
  });

  test("bare names read the item's cells; this.x reads the enclosing object", () => {
    const env = new FakeEnv({
      self: { items: refs("a", "b", "c"), x: num(2) },
      a: { x: num(1) },
      b: { x: num(5) },
      c: { x: num(3) },
    });
    expect(run("items.where(x > this.x)", env)).toEqual(refs("b", "c"));
    expect(run("items.where(x > 2)", env)).toEqual(refs("b", "c"));
    expect(run("items.where(this.x = 2)", env)).toEqual(refs("a", "b", "c"));
  });

  test("bare names with non-reference items are #TYPE", () => {
    expect(run("[1, 2].where(x > 1)", { self: { x: num(0) } })).toMatchObject({ code: "#TYPE" });
  });

  test("a cell some items lack is #NAME (strict)", () => {
    const env = new FakeEnv({
      self: { items: refs("a", "b") },
      a: { tag: tags("die"), value: num(4) },
      b: { tag: tags("coin") },
    });
    expect(run("items.where(value > 1)", env)).toMatchObject({ code: "#NAME" });
    expect(run('items.where(tag has "die").where(value > 1)', env)).toEqual(refs("a"));
  });

  test("a nested where rebinds it; the inner shadows the outer", () => {
    const env = new FakeEnv({
      self: { groups: refs("g1", "g2"), min: num(2) },
      g1: { members: refs("m1", "m2") },
      g2: { members: refs("m3") },
      m1: { hp: num(1) },
      m2: { hp: num(5) },
      m3: { hp: num(1) },
    });
    expect(run("groups.where(len(members.where(hp > this.min)) > 0)", env)).toEqual(refs("g1"));
    expect(run("[[1, 2], [0]].where(len(it.where(it > 1)) > 0)")).toEqual(
      list([list([num(1), num(2)])]),
    );
    expect(run("[1, 2, 3].where(len([5, 6].where(it > 5)) = it)")).toEqual(list([num(1)]));
  });

  test("`it` outside where is #NAME, and is restored after", () => {
    expect(run("[[1].where(it > 0), it]")).toMatchObject({ code: "#NAME" });
  });

  test("called as a plain function, where is #NAME", () => {
    expect(run("where([1], true)")).toMatchObject({ code: "#NAME" });
  });

  test("where and sort are registered with arity 1..1", () => {
    for (const name of ["where", "sort"]) {
      expect(defaultRegistry.get(name)).toMatchObject({ minArgs: 1, maxArgs: 1, kind: "lazy" });
    }
  });
});

describe("where with aggregates (Done-when)", () => {
  const cup = new FakeEnv({
    self: { cup: ref("cup") },
    cup: { contents: refs("d1", "d2", "coin") },
    d1: { tag: tags("die", "d6"), value: num(4) },
    d2: { tag: tags("die", "d6"), value: num(6) },
    coin: { tag: tags("coin"), value: text("heads") },
  });
  const emptyCup = new FakeEnv({ self: { cup: ref("cup") }, cup: { contents: list([]) } });

  test('sum(contents.where(tag has "die").value)', () => {
    expect(run('sum(cup.contents.where(tag has "die").value)', cup)).toEqual(num(10));
    expect(run('sum(cup.contents.where(tag has "die").value)', emptyCup)).toEqual(num(0));
    expect(
      run('sum(contents.where(tag has "die").value)', cup, { scope: { thisId: "cup" } }),
    ).toEqual(num(10));
  });

  test('any(xs.where(tag has "d20").total >= 13)', () => {
    const env = (a: number, b: number) =>
      new FakeEnv({
        self: { xs: refs("a", "b", "c") },
        a: { tag: tags("d20"), total: roll("1d20", a) },
        b: { tag: tags("d20"), total: roll("1d20", b) },
        c: { tag: tags("d6"), total: roll("1d6", 20) },
      });
    expect(run('any(xs.where(tag has "d20").total >= 13)', env(4, 15))).toEqual(bool(true));
    expect(run('any(xs.where(tag has "d20").total >= 13)', env(4, 12))).toEqual(bool(false));
  });

  test('len(zones.where(tag has "difficult")) > 0', () => {
    const env = (second: string) =>
      new FakeEnv({
        self: { zones: refs("z1", "z2") },
        z1: { tag: tags("water") },
        z2: { tag: tags(second) },
      });
    expect(run('len(zones.where(tag has "difficult")) > 0', env("difficult"))).toEqual(bool(true));
    expect(run('len(zones.where(tag has "difficult")) > 0', env("road"))).toEqual(bool(false));
  });
});

describe("sort", () => {
  test("ascending by key", () => {
    expect(run("[3, 1, 2].sort(it)")).toEqual(list([num(1), num(2), num(3)]));
    expect(run('["b", "a", "c"].sort(it)')).toEqual(list([text("a"), text("b"), text("c")]));
  });

  test("desc", () => {
    expect(run("[3, 1, 2].sort(it, desc)")).toEqual(list([num(3), num(2), num(1)]));
  });

  test("stable, also under desc", () => {
    const env = new FakeEnv({
      self: { xs: refs("a", "b", "c", "d") },
      a: { init: num(2) },
      b: { init: num(1) },
      c: { init: num(2) },
      d: { init: num(1) },
    });
    expect(run("xs.sort(init)", env)).toEqual(refs("b", "d", "a", "c"));
    expect(run("xs.sort(init, desc)", env)).toEqual(refs("a", "c", "b", "d"));
    expect(run("xs.sort(0)", env)).toEqual(refs("a", "b", "c", "d"));
  });

  test("empty keys sort last in both directions", () => {
    const env = new FakeEnv({
      self: { xs: refs("a", "b", "c", "d") },
      a: { init: EMPTY },
      b: { init: num(1) },
      c: { init: num(3) },
      d: { init: EMPTY },
    });
    expect(run("xs.sort(init)", env)).toEqual(refs("b", "c", "a", "d"));
    expect(run("xs.sort(init, desc)", env)).toEqual(refs("c", "b", "a", "d"));
    expect(run("[empty, 2, empty, 1].sort(it)")).toEqual(list([num(1), num(2), EMPTY, EMPTY]));
  });

  test("roll keys compare by total, with numbers", () => {
    const env = new FakeEnv({ self: { a: roll("1d20", 7), b: roll("1d20", 15) } });
    expect(run("[b, 10, a].sort(it)", env)).toEqual(
      list([roll("1d20", 7), num(10), roll("1d20", 15)]),
    );
  });

  test("text keys compare by code point", () => {
    expect(run('["😀", "￿"].sort(it)')).toEqual(list([text("￿"), text("😀")]));
  });

  test("mixed keys are #TYPE", () => {
    expect(run('[1, "a"].sort(it)')).toMatchObject({ code: "#TYPE" });
    expect(run('["a", 1].sort(it, desc)')).toMatchObject({ code: "#TYPE" });
  });

  test("unorderable keys are #TYPE", () => {
    expect(run("[true, false].sort(it)")).toMatchObject({ code: "#TYPE" });
    expect(run("[[1], [2]].sort(it)")).toMatchObject({ code: "#TYPE" });
    expect(run("[1d6].sort(it)", {})).toMatchObject({ code: "#TYPE" });
    expect(run("[this].sort(it)")).toMatchObject({ code: "#TYPE" });
  });

  test("all-empty keys keep input order", () => {
    expect(run("[3, 1, 2].sort(empty)")).toEqual(list([num(3), num(1), num(2)]));
  });

  test("a key error makes the whole result that error", () => {
    expect(run("[1, 0].sort(1 / it)")).toMatchObject({ code: "#DIV0" });
    const env = new FakeEnv({ self: { xs: refs("a", "b") }, a: { init: num(1) }, b: {} });
    expect(run("xs.sort(init)", env)).toMatchObject({ code: "#NAME" });
  });

  test("target rules match where", () => {
    expect(run("blank.sort(it)", { self: { blank: EMPTY } })).toEqual(list([]));
    expect(run("(3).sort(it)")).toMatchObject({ code: "#TYPE" });
    expect(run("[].sort(it)")).toEqual(list([]));
    expect(run("[1, 2].sort(x)")).toMatchObject({ code: "#TYPE" });
    expect(run("sort([1], it)")).toMatchObject({ code: "#NAME" });
  });

  test("bare names are the item's cells; this is the enclosing object", () => {
    const env = new FakeEnv({
      self: { xs: refs("a", "b"), w: num(-1) },
      a: { v: num(1) },
      b: { v: num(2) },
    });
    expect(run("xs.sort(v * this.w)", env)).toEqual(refs("b", "a"));
  });

  test("sort composes with where", () => {
    expect(run("[5, 1, 4, 2].where(it > 1).sort(it)")).toEqual(list([num(2), num(4), num(5)]));
  });

  test("dice values in the list are fine as long as keys order", () => {
    expect(run("[1d6, 2d6].sort(max_roll(it), desc)")).toEqual(list([dice("2d6"), dice("1d6")]));
  });
});
