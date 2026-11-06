/**
 * ActionContext reads do not copy the transaction's change summary
 * (vtt-qf5.9). Each read asks the transaction whether the cell changed in
 * it, rather than building the whole summary, so a read costs the same
 * however large the transaction is.
 */
import { ActionContext, Table, writeValue } from "@vtt/authority";
import { num } from "@vtt/schema";
import { expect, test } from "vitest";
import { c, edit, gm, placed, snapshot } from "./helpers";

const N = 1000;

test("1000 reads over a transaction with 1000 changed cells stay well under a second", () => {
  const table = Table.fromSnapshot(
    snapshot(
      Array.from({ length: N }, (_, i) =>
        placed(`o${i}`, i, 0, { cells: { v: c(num(i)), w: c(num(-i)) } }),
      ),
    ),
  );
  const tx = table.store.begin(gm, edit);
  const ctx = new ActionContext(table, tx);
  for (let i = 0; i < N; i++) writeValue(tx, `o${i}`, "v", num(i + 1));
  expect(tx.changes().changedCells.length).toBeGreaterThanOrEqual(N);

  const start = performance.now();
  const results = [];
  for (let i = 0; i < N; i++) {
    // Alternate a changed cell (working copy) and an unchanged one (table value).
    results.push(i % 2 === 0 ? ctx.read(`o${i}`, "v") : ctx.read(`o${i}`, "w"));
  }
  const elapsed = performance.now() - start;

  for (let i = 0; i < N; i++) expect(results[i]).toEqual(i % 2 === 0 ? num(i + 1) : num(-i));
  // Well under the bead's one second; the margin keeps a loaded CI machine
  // from flaking. Copying the summary on every read took about two.
  expect(elapsed).toBeLessThan(500);
});
