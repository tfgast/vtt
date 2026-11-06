/**
 * The prepped first-session table (vtt-qf5.34; DESIGN.md §8.4, repeat
 * playtests; M6 plan Q11; M6-D29): `runPrep` on a fresh walkthrough table
 * generates the table a repeat playtest starts from at step 7, and the
 * shipped copy in `@vtt/fixtures` (`preppedTablePath`) must equal a fresh
 * generation.
 *
 * Regenerate (after a change to prep, the stocked templates or the file
 * format) from the repo root with `pnpm fixtures:prepped`, which runs this
 * file with VTT_WRITE_PREPPED_TABLE=1: the generation then overwrites the
 * shipped table and its assets directory instead of comparing.
 *
 * Nothing is normalised: prep's dice are scripted (`PREP_DICE`), object ids
 * are allocated in sequence (`next_seq`), the file holds no timestamps, and
 * asset names carry a content hash, so a generation is byte-identical to the
 * last. The shipped file is the host's own output, so Biome skips
 * `packages/fixtures/examples`.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { examplesDir, PREPPED_TABLE, preppedTablePath } from "@vtt/fixtures";
import { afterEach, describe, expect, test } from "vitest";
import type { DriverContext } from "./contract";
import { startWalkthrough } from "./infra";
import { PREP_DICE, runPrep } from "./prep";

const WRITE = process.env.VTT_WRITE_PREPPED_TABLE === "1";

let ctx: DriverContext | null = null;

afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

/** The asset files of the table at `file`: name → bytes. */
async function assetsOf(file: string): Promise<Map<string, Uint8Array>> {
  const dir = join(dirname(file), PREPPED_TABLE.assetsDir);
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  return new Map(
    await Promise.all(names.map(async (n) => [n, await readFile(join(dir, n))] as const)),
  );
}

describe("the prepped first-session table (vtt-qf5.34)", () => {
  test(WRITE
    ? "writes a fresh generation over the shipped table"
    : "the shipped table equals a fresh generation of runPrep", async () => {
    const c = await startWalkthrough({ dice: PREP_DICE });
    ctx = c;
    await runPrep(c);
    // Asset paths name the table file (`<file>.assets/…`), so the walkthrough's must match.
    expect(basename(c.file)).toBe(PREPPED_TABLE.file);
    const generated = await c.savedFile();
    const assets = await assetsOf(c.file);

    if (WRITE) {
      const out = examplesDir();
      await rm(join(out, PREPPED_TABLE.assetsDir), { recursive: true, force: true });
      await mkdir(join(out, PREPPED_TABLE.assetsDir), { recursive: true });
      await writeFile(preppedTablePath(), generated);
      for (const [name, bytes] of assets) {
        await writeFile(join(out, PREPPED_TABLE.assetsDir, name), bytes);
      }
      return;
    }

    const shippedText = await readFile(preppedTablePath(), "utf8");
    // Parsed first, for a readable diff; then the exact bytes the host wrote.
    expect(JSON.parse(shippedText)).toEqual(JSON.parse(generated));
    expect(shippedText === generated, "the shipped table's text").toBe(true);
    const shipped = await assetsOf(preppedTablePath());
    expect([...shipped.keys()]).toEqual([...assets.keys()]);
    for (const [name, bytes] of assets) {
      expect(Buffer.from(shipped.get(name) as Uint8Array).equals(Buffer.from(bytes)), name).toBe(
        true,
      );
    }
  }, 240_000);
});
