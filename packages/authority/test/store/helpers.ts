/** Hand-built documents shared by the store tests. */
import { type Cell, list, num, type Snapshot, type TableObject, text } from "@vtt/schema";

export const lit = (n: number): Cell => ({ content: num(n) });
export const named = (name: string): Cell => ({ content: text(name) });
export const at = (x: number, y: number): Cell => ({ content: list([num(x), num(y)]) });

/** An object with every field at its default, contained nowhere and on no board. */
export function obj(id: string, rest: Partial<TableObject> = {}): TableObject {
  return {
    id,
    is_template: false,
    is_zone: false,
    is_character: false,
    tag: [],
    shape: null,
    board: null,
    contents: [],
    cells: {},
    cell_visibility: {},
    actions: [],
    ...rest,
  };
}

/**
 * Two boards. On `map`: `goblin` (hp 7), `bag` holding `coin` then `gem`,
 * and `chest` holding `pouch`, which holds `ring`. `shelf` is empty.
 * `old` is retired; next_seq is 5.
 */
export function table(): Snapshot {
  const objects = [
    obj("goblin", {
      board: "map",
      tag: ["creature"],
      cells: { name: named("Goblin"), hp: lit(7), position: at(1, 2), z: lit(0) },
    }),
    obj("bag", {
      board: "map",
      contents: ["coin", "gem"],
      cells: { name: named("Bag"), position: at(5, 5) },
    }),
    obj("coin", { cells: { name: named("Coin"), value: lit(1) } }),
    obj("gem", { cells: { name: named("Gem"), value: lit(50) } }),
    obj("chest", { board: "map", contents: ["pouch"], cells: { position: at(9, 9) } }),
    obj("pouch", { contents: ["ring"] }),
    obj("ring", { cells: { value: lit(100) } }),
  ];
  return {
    revision: 3,
    next_seq: 5,
    boards: [
      { id: "map", name: "Map" },
      { id: "shelf", name: "Shelf" },
    ],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: ["old"],
  };
}

/** The records of `ids` in table(), in the order given. */
export function subtree(...ids: string[]): TableObject[] {
  const objects = table().objects;
  return ids.map((id) => must(objects[id]));
}

/** `x`, or a test failure when it is null or undefined. */
export function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected a value");
  return x;
}
