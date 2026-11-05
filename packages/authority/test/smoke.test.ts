import { PACKAGE } from "@vtt/authority";
import { expect, test } from "vitest";

test("resolves the package by name", () => {
  expect(PACKAGE).toBe("@vtt/authority");
});
