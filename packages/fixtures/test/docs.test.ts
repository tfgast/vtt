import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FORMULAS_FIXTURES } from "@vtt/fixtures";
import { expect, test } from "vitest";

const docs = join(import.meta.dirname, "..", "..", "..", "docs");

test("FORMULAS_FIXTURES matches the §10 headings of FORMULAS.md", async () => {
  const text = await readFile(join(docs, "FORMULAS.md"), "utf8");
  const section = text.slice(text.indexOf("## 10. Fixtures"), text.indexOf("## 11."));
  const headings = [...section.matchAll(/^\*\*(.+)\*\*$/gm)].map((m) => m[1]);
  expect(headings).toEqual([...FORMULAS_FIXTURES]);
});

test("docs/FIXTURES.md has one section per §10 fixture, in order", async () => {
  const text = await readFile(join(docs, "FIXTURES.md"), "utf8");
  const headings = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  expect(
    headings.filter((h) => (FORMULAS_FIXTURES as readonly string[]).includes(h ?? "")),
  ).toEqual([...FORMULAS_FIXTURES]);
});
