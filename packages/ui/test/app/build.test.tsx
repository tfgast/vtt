// @vitest-environment node
/**
 * The composed UI builds (vtt-3l6.17; M4 plan Q16: no browser automation):
 * Vite's `build()` API over the UI's own config, into a temp directory.
 */
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, expect, test } from "vitest";

const UI = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let dir: string | null = null;

afterEach(async () => {
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

test("vite build() of the UI succeeds into a temp outDir", async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-app-build-")));
  const outDir = join(dir, "dist");
  await build({
    root: UI,
    configFile: join(UI, "vite.config.ts"),
    configLoader: "runner",
    mode: "production",
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
  const html = await readFile(join(outDir, "index.html"), "utf8");
  expect(html).toContain('id="root"');
  const bundles = await readdir(join(outDir, "ui-assets"));
  expect(bundles.some((f) => f.endsWith(".js"))).toBe(true);
}, 120_000);
