import { EMPTY, err, list, num, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";
import { FakeEnv } from "./support/fake-env";
import { viewers } from "./values-helpers";

describe("names and scope", () => {
  test("this is a reference to the scope's object", () => {
    expect(run("this")).toEqual(ref("self"));
    expect(run("this", {}, { scope: { thisId: "other" } })).toEqual(ref("other"));
  });

  test("a bare name reads the cell on this", () => {
    expect(run("max_hp", { self: { max_hp: num(12) } })).toEqual(num(12));
    expect(run("`Max HP`", { self: { "Max HP": num(9) } })).toEqual(num(9));
    expect(run("owner", { self: { owner: EMPTY } })).toEqual(EMPTY);
  });

  test("a bare name returns the read result unchanged", () => {
    const hp = num(3);
    expect(run("hp", { self: { hp } })).toBe(hp);
  });

  test("a missing bare name is #NAME", () => {
    expect(run("max_hp")).toMatchObject({ type: "error", code: "#NAME" });
  });

  test("a blank cell is empty, not #NAME", () => {
    expect(run("max_hp", { self: { max_hp: EMPTY } })).toEqual(EMPTY);
  });

  test("a dangling ref read from a cell is #REF through FakeEnv", () => {
    expect(run("target", { self: { target: ref("ghost") } })).toMatchObject({ code: "#REF" });
  });

  test("a dangling ref inside a list read from a cell is #REF through FakeEnv", () => {
    const cells = { self: { party: list([ref("aldric"), ref("ghost")]) }, aldric: {} };
    expect(run("party", cells)).toMatchObject({ code: "#REF" });
    expect(run("[1, party]", cells)).toMatchObject({ code: "#REF" });
  });

  test("a dangling ref inside a viewers value read from a cell is #REF", () => {
    const cells = { self: { visible_to: viewers("gm", ref("ghost")) } };
    expect(run("visible_to", cells)).toMatchObject({ code: "#REF" });
  });

  test("a live ref read from a cell is the ref", () => {
    expect(run("target", { self: { target: ref("aldric") }, aldric: {} })).toEqual(ref("aldric"));
  });

  test("it outside a predicate is #NAME", () => {
    expect(run("it")).toMatchObject({ code: "#NAME" });
    expect(run("it.hp")).toMatchObject({ code: "#NAME" });
  });

  test("it is the bound item, whatever its kind", () => {
    const scope = { thisId: "self", it: num(3), itBindsNames: true };
    expect(run("it", {}, { scope })).toEqual(num(3));
    expect(run("it > 1", {}, { scope })).toMatchObject({ value: true });
  });

  test("an it binding that does not bind names leaves bare names on this", () => {
    const scope = { thisId: "self", it: ref("goblin") };
    const cells = { self: { hp: num(1) }, goblin: { hp: num(7) } };
    expect(run("hp", cells, { scope })).toEqual(num(1));
    expect(run("it.hp", cells, { scope })).toEqual(num(7));
  });
});

describe("bare names inside a predicate (itBindsNames)", () => {
  const cells = { self: { x: num(1), only_this: num(5) }, goblin: { x: num(2) } };
  const scope = { thisId: "self", it: ref("goblin"), itBindsNames: true };

  test("resolve against the item's cells", () => {
    expect(run("x", cells, { scope })).toEqual(num(2));
  });

  test("this still means the enclosing object", () => {
    expect(run("this.x", cells, { scope })).toEqual(num(1));
    expect(run("this", cells, { scope })).toEqual(ref("self"));
  });

  test("never fall back to this", () => {
    expect(run("only_this", cells, { scope })).toMatchObject({ code: "#NAME" });
  });

  test("a non-ref item makes a bare name #TYPE", () => {
    const numeric = { thisId: "self", it: num(3), itBindsNames: true };
    expect(run("x", cells, { scope: numeric })).toMatchObject({ code: "#TYPE" });
    const textual = { thisId: "self", it: text("a"), itBindsNames: true };
    expect(run("x", cells, { scope: textual })).toMatchObject({ code: "#TYPE" });
  });

  test("an item referencing a deleted object makes a bare name #REF", () => {
    const ghost = { thisId: "self", it: ref("ghost"), itBindsNames: true };
    expect(run("x", cells, { scope: ghost })).toMatchObject({ code: "#REF" });
  });

  test("a dangling ref read from the item's cell is #REF", () => {
    const env = new FakeEnv({ self: {}, goblin: { target: list([ref("ghost")]) } });
    expect(run("target", env, { scope })).toMatchObject({ code: "#REF" });
  });
});

describe("error origin", () => {
  test("a new error gets the scope's cell as origin", () => {
    const result = run("1 / 0", {}, { scope: { thisId: "self", cell: "hp" } });
    expect(result).toEqual(err("#DIV0", "/ by zero", { object: "self", cell: "hp" }));
  });

  test("errors from names, calls, and dot-access get the origin", () => {
    const scope = { thisId: "self", cell: "hp" };
    const origin = { object: "self", cell: "hp" };
    expect(run("missing", {}, { scope })).toMatchObject({ code: "#NAME", origin });
    expect(run("no_such_function_zz(1)", {}, { scope })).toMatchObject({ code: "#NAME", origin });
    expect(run("if(true)", {}, { scope })).toMatchObject({ code: "#TYPE", origin });
    expect(run("n.foo", { self: { n: num(3) } }, { scope })).toMatchObject({
      code: "#TYPE",
      origin,
    });
    expect(run("[1, 1 / 0]", {}, { scope })).toMatchObject({ code: "#DIV0", origin });
  });

  test("an error that already has an origin keeps it", () => {
    const upstream = err("#DIV0", "upstream", { object: "other", cell: "ac" });
    const result = run(
      "bad + 1",
      { self: { bad: upstream } },
      { scope: { thisId: "self", cell: "hp" } },
    );
    expect(result).toEqual(upstream);
  });

  test("without a cell in scope, a new error has no origin", () => {
    const result = run("1 / 0");
    expect(result).toMatchObject({ code: "#DIV0" });
    expect(result).not.toHaveProperty("origin");
  });
});
