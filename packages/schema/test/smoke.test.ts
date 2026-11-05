import { PACKAGE } from "@vtt/schema";
import { expect, test } from "vitest";

test("resolves the package by name", () => {
  expect(PACKAGE).toBe("@vtt/schema");
});
