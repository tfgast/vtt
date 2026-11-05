// @vitest-environment node
/**
 * The root `start` script and the gitignored `tables/` (vtt-nb8.4; DESIGN.md
 * §7 Platform; M6-D5).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

test("the root start script runs the launcher through tsx", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  expect(pkg.scripts.start).toBe("node --import tsx packages/authority/src/bin/start.ts");
});

test(".gitignore ignores the local tables/ directory", async () => {
  const lines = (await readFile(join(ROOT, ".gitignore"), "utf8")).split("\n");
  expect(lines).toContain("/tables/");
});
