import { PACKAGE } from "@vtt/fixtures";
import { expect, test } from "vitest";

test("resolves the package by name", () => {
  expect(PACKAGE).toBe("@vtt/fixtures");
});
