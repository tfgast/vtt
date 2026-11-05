/**
 * Scenario setup to a document snapshot (FIXTURES.md §3; vtt-75c.13).
 *
 * The fixture value encoding (FIXTURES §2) is the schema encoding, so every
 * value and cell content converts as the identity, checked with `isValue` /
 * `isCellContent`. `placement` becomes `board` plus a `position` cell (a
 * literal `[x, y]` list or the formula); `cell_visibility` is copied
 * verbatim onto the metadata of the same name, whatever cells it names;
 * `is_character` is set for the ids in `setup.characters`; `face` (M5) is
 * copied verbatim onto the object field of the same name, and an object
 * without one has no layout.
 */
import type { Value as FixtureValue, Setup } from "@vtt/fixtures";
import {
  type Cell,
  type CellContent,
  isCellContent,
  isValue,
  list,
  num,
  type Snapshot,
  type TableObject,
  type Value,
  type ViewersValue,
} from "@vtt/schema";

/** A fixture value as a schema value: the identity, checked. */
export function toValue(v: FixtureValue): Value {
  if (!isValue(v)) throw new Error(`not a schema value: ${JSON.stringify(v)}`);
  return structuredClone(v);
}

/** A fixture cell content as schema cell content: the identity, checked. */
export function toContent(c: unknown): CellContent {
  if (!isCellContent(c)) throw new Error(`not schema cell content: ${JSON.stringify(c)}`);
  return structuredClone(c);
}

/** The document a scenario's setup describes, at revision 0 with `next_seq` 0. */
export function documentFromSetup(setup: Setup): Snapshot {
  const characters = new Set(setup.characters);
  const objects: Record<string, TableObject> = {};
  for (const o of setup.objects) {
    const cells: Record<string, Cell> = {};
    for (const [name, content] of Object.entries(o.cells ?? {})) {
      cells[name] = { content: toContent(content) };
    }
    if (o.placement !== undefined) {
      const p = o.placement.position;
      cells.position = {
        content: Array.isArray(p) ? list([num(p[0]), num(p[1])]) : toContent(p),
      };
    }
    const cell_visibility: Record<string, ViewersValue> = {};
    for (const [name, v] of Object.entries(o.cell_visibility ?? {})) {
      cell_visibility[name] = toValue(v) as ViewersValue;
    }
    objects[o.id] = {
      id: o.id,
      is_template: o.is_template ?? false,
      is_zone: o.is_zone ?? false,
      is_character: characters.has(o.id),
      tag: [...(o.tag ?? [])],
      shape: o.shape === undefined ? null : structuredClone(o.shape),
      board: o.placement?.board ?? null,
      contents: [...(o.contents ?? [])],
      cells,
      cell_visibility,
      actions: (o.actions ?? []).map((a) => ({
        name: a.name,
        ...(a.when === undefined ? {} : { when: a.when }),
        steps: [...a.steps],
      })),
      ...(o.face === undefined ? {} : { face: structuredClone(o.face) }),
    };
  }
  return {
    revision: 0,
    next_seq: 0,
    boards: setup.boards.map((b) => ({ ...b })),
    objects,
    retired_ids: [],
  };
}
