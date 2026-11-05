/**
 * Small documents for the engine-core tests: every object on board `table`
 * unless listed in another object's `contents`. A string starting with `=`
 * is a formula, a number is a number literal, anything else a schema value.
 */
import { type CellContent, num, type Value } from "@vtt/schema";
import { MemoryHost } from "./memory-host";

export type CellSpec = string | number | Value;

export interface ObjectSpec {
  cells?: Record<string, CellSpec>;
  contents?: string[];
}

export const formula = (source: string): CellContent => ({ type: "formula", source });

export function content(spec: CellSpec): CellContent {
  if (typeof spec === "number") return num(spec);
  if (typeof spec === "string") {
    if (!spec.startsWith("=")) throw new Error(`cell spec "${spec}" is not a formula`);
    return formula(spec.slice(1));
  }
  return spec;
}

/** A MemoryHost holding `objects`. */
export function doc(objects: Record<string, ObjectSpec>): MemoryHost {
  const contained = new Set(Object.values(objects).flatMap((o) => o.contents ?? []));
  return MemoryHost.fromSetup({
    boards: [{ id: "table" }],
    characters: [],
    objects: Object.entries(objects).map(([id, o]) => ({
      id,
      ...(contained.has(id) ? {} : { placement: { board: "table", position: [0, 0] } }),
      ...(o.contents === undefined ? {} : { contents: o.contents }),
      cells: Object.fromEntries(
        Object.entries(o.cells ?? {}).map(([name, c]) => [name, content(c) as never]),
      ),
    })),
  });
}
