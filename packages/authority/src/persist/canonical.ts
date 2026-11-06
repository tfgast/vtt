/**
 * Canonical JSON for the file (DESIGN.md §7, The file): the same document
 * always serializes to the same bytes, so files diff cleanly and
 * `snapshot_hash` detects hand edits but not reformatting.
 */
import type { Snapshot } from "@vtt/schema";

/**
 * How the keys of a JSON object are ordered. `fields` lists known keys in
 * schema field order, `map` sorts every key, `by` picks a layout by a
 * discriminant, and `any` sorts every key.
 */
type Layout =
  | { k: "fields"; fields: readonly (readonly [string, Layout])[] }
  | { k: "map"; of: Layout }
  | { k: "arr"; of: Layout }
  | { k: "by"; key: string; cases: Readonly<Record<string, Layout>> }
  | { k: "any" };

const ANY: Layout = { k: "any" };
const arr = (of: Layout): Layout => ({ k: "arr", of });
const map = (of: Layout): Layout => ({ k: "map", of });
const by = (key: string, cases: Record<string, Layout>): Layout => ({ k: "by", key, cases });
/** Keys in the order given; a plain name has no nested layout. */
const fields = (...fs: (string | readonly [string, Layout])[]): Layout => ({
  k: "fields",
  fields: fs.map((f) => (typeof f === "string" ? ([f, ANY] as const) : f)),
});
/** A `type`-tagged object: `type`, then the rest in order. */
const tagged = (...fs: (string | readonly [string, Layout])[]) => fields("type", ...fs);

const SHAPE = by("type", {
  rect: tagged("width", "height"),
  circle: tagged("radius"),
  polygon: tagged("points"),
});

const valueCases: Record<string, Layout> = {
  number: tagged("value"),
  text: tagged("value"),
  boolean: tagged("value"),
  empty: tagged(),
  ref: tagged("object"),
  dice: tagged("expr"),
  roll: tagged("expr", "dice", "dropped", "total"),
  ink: tagged("strokes"),
  shape: tagged(["shape", SHAPE]),
};
const VALUE = by("type", valueCases);
valueCases.list = tagged(["items", arr(VALUE)]);
// Viewer entries are strings or refs; strings print as themselves.
valueCases.viewers = tagged(["viewers", arr(VALUE)]);

const CONTENT = by("type", { ...valueCases, formula: tagged("source") });
const CELL = fields(["content", CONTENT], ["override", VALUE]);
const ACTION = fields("name", "when", "steps");

const FACE_STYLE = fields("size", "align", "caption");
const CELL_ELEMENT = tagged("cell", "rect", "show_when", "min_size", ["style", FACE_STYLE]);
const FACE_ELEMENT = by("type", {
  value: CELL_ELEMENT,
  editor: CELL_ELEMENT,
  button: tagged("action", "rect", "label", "show_when", "min_size"),
  contents: tagged("rect", "entries", "show_when", "min_size"),
});
const FACE = fields(
  ["elements", arr(FACE_ELEMENT)],
  ["collapsed", arr(FACE_ELEMENT)],
  "default_action",
);

const OBJECT = fields(
  "id",
  "is_template",
  "is_zone",
  "is_character",
  "tag",
  ["shape", SHAPE],
  "board",
  "contents",
  ["cells", map(CELL)],
  ["cell_visibility", map(VALUE)],
  ["actions", arr(ACTION)],
  ["face", FACE],
);
const BOARD = fields("id", "name");

const SNAPSHOT = fields(
  "revision",
  "next_seq",
  ["boards", arr(BOARD)],
  ["objects", map(OBJECT)],
  "retired_ids",
);

const ACTOR = by("type", { gm: tagged(), character: tagged("id"), agent: tagged("name") });
const LOCATION = by("type", {
  board: tagged("board"),
  container: tagged("container", "index"),
});
const subtree = tagged(["objects", arr(OBJECT)], ["location", LOCATION]);

// `before`/`after` of a field effect: an action list, a face, a shape, or a
// list or boolean (no keys).
const fieldEffect = (value: Layout) =>
  tagged("object", "field", ["before", value], ["after", value]);
const OTHER_FIELD = fieldEffect(SHAPE);
const FIELD_EFFECT = by("field", {
  tag: OTHER_FIELD,
  shape: OTHER_FIELD,
  is_template: OTHER_FIELD,
  is_character: OTHER_FIELD,
  actions: fieldEffect(arr(ACTION)),
  face: fieldEffect(FACE),
});

const EFFECT = by("type", {
  cell: tagged("object", "cell", ["before", CELL], ["after", CELL], "cause", "added"),
  cell_visibility: tagged("object", "cell", ["before", VALUE], ["after", VALUE]),
  field: FIELD_EFFECT,
  place: tagged("object", ["before", LOCATION], ["after", LOCATION]),
  create: subtree,
  remove: subtree,
  reorder: tagged("container", "before", "after"),
  board: tagged(["before", BOARD], ["after", BOARD]),
  allocate: tagged("ids", "seq_before", "seq_after"),
  retire: tagged("ids"),
});

const GROUP = fields(
  "index",
  "base_revision",
  "revision",
  ["actor", ACTOR],
  "kind",
  "label",
  ["origin", fields("object", "action")],
  "undoes",
  ["names", map(ANY)],
  ["effects", arr(EFFECT)],
);
const LOG = fields("first_index", ["groups", arr(GROUP)], "undo_barrier");

const FILE = fields(
  "format",
  "schema_version",
  ["snapshot", SNAPSHOT],
  "snapshot_hash",
  ["log", LOG],
  "assets",
);

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Code-unit order, the same as `canonicalSnapshot`'s. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The root layout: a table file, a snapshot, or anything else. */
function rootLayout(value: unknown): Layout {
  if (!isRecord(value)) return ANY;
  if (Object.hasOwn(value, "format") && Object.hasOwn(value, "snapshot")) return FILE;
  if (Object.hasOwn(value, "objects") && Object.hasOwn(value, "retired_ids")) return SNAPSHOT;
  return ANY;
}

/** `[key, layout]` for each own key of `obj` with a defined value, in canonical order. */
function orderedEntries(obj: Record<string, unknown>, layout: Layout): [string, Layout][] {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (layout.k === "by") {
    const tag = obj[layout.key];
    const chosen =
      typeof tag === "string" && Object.hasOwn(layout.cases, tag) ? layout.cases[tag] : undefined;
    return orderedEntries(obj, chosen ?? ANY);
  }
  if (layout.k === "fields") {
    const known = new Map(layout.fields);
    const first: [string, Layout][] = layout.fields
      .filter(([k]) => keys.includes(k))
      .map(([k, l]) => [k, l]);
    const rest = keys.filter((k) => !known.has(k)).sort(byCodeUnit);
    return [...first, ...rest.map((k): [string, Layout] => [k, ANY])];
  }
  const of = layout.k === "map" ? layout.of : ANY;
  return keys.sort(byCodeUnit).map((k) => [k, of]);
}

function emit(value: unknown, layout: Layout, indent: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: cannot serialize a ${typeof value}`);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const of = layout.k === "arr" ? layout.of : ANY;
    const items = value.map((v) => (v === undefined ? "null" : emit(v, of, inner)));
    return `[\n${inner}${items.join(`,\n${inner}`)}\n${indent}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = orderedEntries(obj, layout);
  if (entries.length === 0) return "{}";
  const parts = entries.map(([k, l]) => `${JSON.stringify(k)}: ${emit(obj[k], l, inner)}`);
  return `{\n${inner}${parts.join(`,\n${inner}`)}\n${indent}}`;
}

/**
 * Deterministic JSON: two-space indent, a trailing newline, object keys in
 * schema field order for the file's known types (a table file or a
 * snapshot at the root, and everything inside them: objects with `id`
 * first, cells, values with `type` first, groups, effects), the records
 * `objects`, `cells`, `cell_visibility` and `names` sorted by key in
 * code-unit order, and unknown keys sorted after known ones. Arrays keep
 * their order. Same input, same bytes, whatever the key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return `${emit(value, rootLayout(value), "")}\n`;
}

// SHA-256 (FIPS 180-4), in plain TypeScript so parsing stays pure and
// portable.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** The lowercase hex SHA-256 of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6) >>> 0);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
    let a = h0 as number;
    let b = h1 as number;
    let c = h2 as number;
    let d = h3 as number;
    let e = h4 as number;
    let f = h5 as number;
    let g = h6 as number;
    let hh = h7 as number;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const out = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (out[i] as number)) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** `sha256:<hex>` of `canonicalJson(snapshot)`: the file's `snapshot_hash`. */
export function snapshotHash(snapshot: Snapshot): string {
  return `sha256:${sha256Hex(canonicalJson(snapshot))}`;
}
