import { PACKAGE } from "@vtt/formula";
import { expect, test } from "vitest";

test("resolves the package by name", () => {
  expect(PACKAGE).toBe("@vtt/formula");
});
