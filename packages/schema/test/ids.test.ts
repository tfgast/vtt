import { type BoardId, isIdSyntax, isValidId, RESERVED_IDS } from "@vtt/schema";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("ids", () => {
  test("reserved ids are gm, all, owner", () => {
    expect([...RESERVED_IDS]).toEqual(["gm", "all", "owner"]);
  });

  test("a valid id matches the pattern and is not reserved", () => {
    for (const id of ["goblin1", "fb_zone", "A", "map"]) expect(isValidId(id)).toBe(true);
    for (const id of ["", "1goblin", "_x", "a-b", "a b", "gm", "all", "owner"]) {
      expect(isValidId(id)).toBe(false);
    }
  });

  test("reserved ids are syntactically ids", () => {
    for (const id of RESERVED_IDS) expect(isIdSyntax(id)).toBe(true);
  });

  test("BoardId is a string", () => {
    expectTypeOf<BoardId>().toEqualTypeOf<string>();
  });
});
