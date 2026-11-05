/**
 * The M1 test host reads structural cells through the canonical table in
 * @vtt/schema (STRUCTURAL_CELLS, structuralDefault; vtt-75c.12), so its
 * defaults cannot drift from the document's.
 */
import { STRUCTURAL_CELLS, structuralDefault, type TableObject } from "@vtt/schema";
import { expect, test } from "vitest";
import { MemoryHost } from "./support/memory-host";

test("every structural cell of a fresh object reads as the canonical default", () => {
  const host = MemoryHost.fromSetup({
    boards: [{ id: "table" }],
    characters: [],
    objects: [{ id: "bare", placement: { board: "table", position: [0, 0] } }],
  });
  const bare: TableObject = {
    id: "bare",
    is_template: false,
    is_zone: false,
    is_character: false,
    tag: [],
    shape: null,
    board: "table",
    contents: [],
    cells: {},
    cell_visibility: {},
    actions: [],
  };
  for (const spec of STRUCTURAL_CELLS) {
    if (spec.name === "position") continue; // placed: the setup writes it
    expect(host.cell("bare", spec.name), spec.name).toEqual(structuralDefault(spec.name, bare));
  }
});
