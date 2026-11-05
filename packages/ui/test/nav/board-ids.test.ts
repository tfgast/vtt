/**
 * Board ids chosen in the UI (DESIGN.md §4.1 one id namespace, §4.3 ids
 * reserved; PROTOCOL.md §5 `add_board`, §10 `invalid`).
 */
import { isValidId } from "@vtt/schema";
import { BOARD_ID_RETRIES, boardIdBase, boardIdFor, isReservedIdRejection } from "@vtt/ui";
import { describe, expect, test } from "vitest";

describe("boardIdBase", () => {
  test.each([
    ["Crypt", "crypt"],
    ["Old Crypt", "old_crypt"],
    ["The Crypt!", "the_crypt_"],
    ["CRYPT_2", "crypt_2"],
    ["Café", "caf_"],
    ["3rd Floor", "b_3rd_floor"],
    ["_hidden", "b__hidden"],
    ["  Crypt  ", "crypt"],
    ["", "b_"],
    ["🐉 Lair", "b___lair"],
  ])("%j → %j", (name, id) => {
    expect(boardIdBase(name)).toBe(id);
    expect(isValidId(boardIdBase(name)) || ["gm", "all", "owner"].includes(id)).toBe(true);
  });

  test("words of the viewer encoding are not changed by the base", () => {
    expect(boardIdBase("GM")).toBe("gm");
  });
});

describe("boardIdFor", () => {
  test("the base when free", () => {
    expect(boardIdFor("Crypt", ["gm_board"])).toBe("crypt");
  });

  test("_2, _3 … when taken", () => {
    expect(boardIdFor("Crypt", ["gm_board", "crypt"])).toBe("crypt_2");
    expect(boardIdFor("Crypt", new Set(["crypt", "crypt_2", "crypt_3"]))).toBe("crypt_4");
  });

  test("gm, all and owner are suffixed", () => {
    expect(boardIdFor("GM", [])).toBe("gm_2");
    expect(boardIdFor("All", [])).toBe("all_2");
    expect(boardIdFor("owner", ["owner_2"])).toBe("owner_3");
  });

  test("the result is always a valid id", () => {
    for (const name of ["Crypt", "gm", "", "9", "é", "a b c", "x".repeat(40)]) {
      expect(isValidId(boardIdFor(name, []))).toBe(true);
    }
  });
});

describe("isReservedIdRejection", () => {
  test("an invalid rejection naming a reserved id", () => {
    expect(isReservedIdRejection({ type: "invalid", message: '"crypt" is reserved' })).toBe(true);
  });

  test("other rejections", () => {
    expect(
      isReservedIdRejection({ type: "invalid", message: 'board "crypt" is not empty (2 on it)' }),
    ).toBe(false);
    expect(isReservedIdRejection({ type: "nothing_to_undo" })).toBe(false);
  });

  test("five retries", () => {
    expect(BOARD_ID_RETRIES).toBe(5);
  });
});
