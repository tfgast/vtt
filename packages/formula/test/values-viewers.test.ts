import { toViewers } from "@vtt/formula";
import { bool, dice, EMPTY, err, list, num, type Result, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { INK, roll, viewers } from "./values-helpers";

describe("toViewers", () => {
  test.each<[string, Result, Result]>([
    ["a viewers value as is", viewers("gm", ref("a")), viewers("gm", ref("a"))],
    ["a single ref (visible_to = owner)", ref("aldric"), viewers(ref("aldric"))],
    ["a list of two refs", list([ref("a"), ref("b")]), viewers(ref("a"), ref("b"))],
    [
      "a list mixing a ref and a viewers value",
      list([ref("a"), viewers("gm", ref("b"))]),
      viewers(ref("a"), "gm", ref("b")),
    ],
    [
      "a nested list",
      list([ref("a"), list([ref("b"), list([viewers("all")])])]),
      viewers(ref("a"), ref("b"), "all"),
    ],
    [
      "duplicates removed",
      list([ref("a"), viewers(ref("a"), "gm"), list([ref("a"), viewers("gm")])]),
      viewers(ref("a"), "gm"),
    ],
    ["empty is #TYPE", EMPTY, err("#TYPE")],
    ["[] is #TYPE", list([]), err("#TYPE")],
    ["a list of empty lists is #TYPE", list([list([])]), err("#TYPE")],
    ["a number is #TYPE", num(1), err("#TYPE")],
    ["an error is #TYPE", err("#REF"), err("#TYPE")],
    ["text is #TYPE", text("gm"), err("#TYPE")],
    ["a boolean is #TYPE", bool(true), err("#TYPE")],
    ["dice is #TYPE", dice("1d6"), err("#TYPE")],
    ["a roll is #TYPE", roll(3), err("#TYPE")],
    ["ink is #TYPE", INK, err("#TYPE")],
    ["a list with a non-viewer item is #TYPE", list([ref("a"), num(1)]), err("#TYPE")],
    ["a list with an empty item is #TYPE", list([ref("a"), EMPTY]), err("#TYPE")],
  ])("%s", (_name, v, expected) => {
    expect(toViewers(v)).toMatchObject(expected);
  });

  test("an error converts to a fresh #TYPE, not the error itself", () => {
    const result = toViewers(err("#REF", "gone", { object: "x", cell: "owner" }));
    expect(result).toMatchObject({ type: "error", code: "#TYPE" });
  });
});
