import { validateRefs } from "@vtt/formula";
import { EMPTY, err, list, num, type Result, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { viewers } from "./values-helpers";

const live = new Set(["aldric", "goblin"]);
const exists = (id: string) => live.has(id);

describe("validateRefs", () => {
  test.each<[string, Result, boolean]>([
    ["a live ref", ref("goblin"), true],
    ["a dangling ref", ref("ghost"), false],
    ["a list of live refs", list([ref("aldric"), ref("goblin")]), true],
    ["a dangling ref in a list", list([ref("aldric"), ref("ghost")]), false],
    ["a dangling ref nested two lists deep", list([num(1), list([list([ref("ghost")])])]), false],
    ["a live ref nested two lists deep", list([list([ref("aldric")])]), true],
    ["a dangling ref in a viewers value", viewers("gm", ref("ghost")), false],
    ["a viewers value of live refs", viewers("gm", ref("aldric")), true],
    ["a viewers value inside a list", list([viewers(ref("ghost"))]), false],
    ["a value with no refs", text("ghost"), true],
    ["empty", EMPTY, true],
  ])("%s", (_name, value, ok) => {
    const result = validateRefs(value, exists);
    if (ok) expect(result).toBe(value);
    else expect(result).toMatchObject({ type: "error", code: "#REF" });
  });

  test("an error passes through unchanged", () => {
    const e = err("#DIV0");
    expect(validateRefs(e, exists)).toBe(e);
  });
});
