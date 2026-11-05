/**
 * Randomized subscription equivalence over the wire (vtt-5su.12; PROTOCOL.md
 * §7.5, §8; FORMULAS.md §7; vtt-5su.9, vtt-5su.20): a real server on port 0,
 * a `ProtocolClient` holding `board`, `objects` (subtree), `all` and `log`
 * subscriptions for the GM and for Aldric, and seeded sequences of 200
 * commits of every kind over a 60-object table. After every commit, every
 * mirror (objects, covers, log-window groups) must equal a fresh `subscribe`
 * with the same params at that revision. A failure names the seed, the
 * commit and the ops that led there.
 */
import {
  DocumentStore,
  type RunningServer,
  startServer,
  systemServerTimers,
  TableHost,
} from "@vtt/authority";
import {
  ProtocolClient,
  type SubscribeParams,
  type SubscribeResult,
  type Subscription,
  type ViewMirror,
  type WireOp,
} from "@vtt/protocol";
import {
  bool,
  type Cell,
  list,
  num,
  ref,
  type Snapshot,
  type TableObject,
  text,
  type ViewerEntry,
  type ViewersValue,
} from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { at, c, f, obj, placed, snapshot, zone } from "./engine/helpers";

const SEEDS = [1, 2, 3, 5, 8];
const COMMITS = 200;
/** Commits before subscribing, so the 200 checked commits push groups out of the log window. */
const WARMUP = 10;

const GM = { type: "gm" } as const;
const ALDRIC = { type: "character", id: "aldric" } as const;

const viewers = (...entries: ViewerEntry[]): ViewersValue => ({
  type: "viewers",
  viewers: entries,
});

// The table.

/**
 * 60 objects on boards `table`, `crypt` and `attic`: Aldric; six opaque rooms
 * hidden from him (four on `table`, two on `crypt`); sixteen tokens on
 * `table` and six on `crypt`, some under rooms; four chests of three items
 * (one hidden from Aldric, one visible to him only); Aldric's hand of four
 * cards on `crypt`; a goblin template with a bag and a card template;
 * three watchers whose formulas read other objects; a dice tray and three
 * dice.
 */
function world(): Snapshot {
  const objects: TableObject[] = [
    placed("aldric", 0, -50, {
      is_character: true,
      tag: ["pc", "creature"],
      cells: { name: c(text("Aldric")), hp: c(num(27)) },
    }),
  ];
  const rooms: [string, string, number, number][] = [
    ["room1", "table", 10, 10],
    ["room2", "table", 30, 10],
    ["room3", "table", 10, 30],
    ["room4", "table", 30, 30],
    ["room5", "crypt", 10, 10],
    ["room6", "crypt", 30, 10],
  ];
  for (const [id, board, x, y] of rooms) {
    objects.push(
      zone(id, x, y, 8, {
        board,
        cells: {
          position: at(x, y),
          name: c(text(id)),
          opaque: c(bool(true)),
          visible_to: c(viewers("gm")),
        },
      }),
    );
  }
  for (let i = 1; i <= 16; i++) {
    const x = (i % 4) * 10 + 10;
    const y = Math.floor((i - 1) / 4) * 10 + 5;
    objects.push(
      placed(`tok${i}`, x, y, {
        tag: ["creature"],
        shape: { type: "circle", radius: 0.5 },
        cells: {
          name: c(text(`Token ${i}`)),
          hp: c(num(i)),
          max_hp: c(num(20)),
          hurt: f("max_hp - hp"),
          ...(i % 5 === 0 ? { foe: c(ref(`tok${i - 1}`)) } : {}),
        },
      }),
    );
  }
  for (let i = 1; i <= 6; i++) {
    objects.push(
      placed(`ctok${i}`, i * 6, 10, {
        board: "crypt",
        tag: ["creature"],
        cells: { position: at(i * 6, 10), name: c(text(`Crypt ${i}`)), hp: c(num(i)) },
      }),
    );
  }
  for (let k = 1; k <= 4; k++) {
    const items = [1, 2, 3].map((j) => `item${(k - 1) * 3 + j}`);
    const vis: Record<string, Cell> =
      k === 2
        ? { visible_to: c(viewers("gm")) }
        : k === 3
          ? { visible_to: c(viewers(ref("aldric"))) }
          : {};
    objects.push(
      placed(`chest${k}`, 50, k * 10, {
        contents: items,
        cells: { name: c(text(`Chest ${k}`)), owner: c(ref("aldric")), ...vis },
      }),
    );
    for (const id of items) {
      objects.push(obj(id, { tag: ["loot"], cells: { name: c(text(id)), hp: c(num(1)) } }));
    }
  }
  const cards = [1, 2, 3, 4].map((i) => `card${i}`);
  objects.push(
    obj("aldric_hand", {
      board: "crypt",
      contents: cards,
      cells: {
        position: at(0, 40),
        name: c(text("Hand")),
        owner: c(ref("aldric")),
        visible_to: c(viewers(ref("aldric"))),
      },
    }),
  );
  for (const [i, id] of cards.entries()) {
    objects.push(
      obj(id, {
        cells: { name: c(text(id)), face_up: c(bool(i % 2 === 0)), owner: c(ref("aldric")) },
      }),
    );
  }
  objects.push(
    placed("tmpl_goblin", -20, 0, {
      is_template: true,
      tag: ["creature"],
      contents: ["tmpl_goblin_bag"],
      cells: { name: c(text("Goblin")), hp: c(num(7)), hurt: f("7 - hp") },
    }),
    obj("tmpl_goblin_bag", { cells: { name: c(text("Bag")), owner: f("container") } }),
    placed("tmpl_card", -20, 0, {
      board: "crypt",
      is_template: true,
      cells: { position: at(-20, 0), name: c(text("Card")), face_up: c(bool(false)) },
    }),
    placed("watch1", -30, 0, {
      cells: { name: c(text("W1")), seen: f('contents(room1).where(tag has "creature")') },
    }),
    placed("watch2", -30, 5, { cells: { name: c(text("W2")), loot: f("chest1.contents") } }),
    placed("watch3", -30, 10, { cells: { name: c(text("W3")), sum: f("tok1.hp + tok2.hp") } }),
    zone("tray", 10, -20, 6, {
      tag: ["tray"],
      cells: {
        position: at(10, -20),
        name: c(text("Tray")),
        total: f('sum(contents(this).where(tag has "die").value)'),
      },
    }),
  );
  for (let i = 1; i <= 3; i++) {
    objects.push(
      placed(`die${i}`, i * 2, -20, {
        tag: ["die"],
        cells: { name: c(text(`Die ${i}`)), value: c(num(i)) },
      }),
    );
  }
  return snapshot(objects, ["table", "crypt", "attic"]);
}

// Seeded randomness.

/** mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = rng(seed);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error("pick from nothing");
    return xs[this.int(xs.length)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  point(): [number, number] {
    return [this.int(60) - 10, this.int(50) - 5];
  }
}

// Commits.

type Write =
  | { kind: "transact"; ops: WireOp[]; actor?: { type: "character"; id: string } }
  | { kind: "undo" };

const describeWrite = (w: Write): string =>
  w.kind === "undo" ? "undo latest" : `${w.actor ? "as aldric: " : ""}${JSON.stringify(w.ops)}`;

const CELLS = ["hp", "note", "name", "link", "calc"];
const TAGS = ["creature", "die", "loot", "pc"];

/** One random write chosen from the current document. */
function randomWrite(R: Random, doc: Snapshot, boardSeq: { n: number }): Write {
  const objects = Object.values(doc.objects);
  const ids = objects.map((o) => o.id);
  const notAldric = ids.filter((id) => id !== "aldric");
  const boards = doc.boards.map((b) => b.id);
  const containers = objects.filter((o) => o.contents.length > 0);
  const zones = objects.filter((o) => o.is_zone);
  const templates = objects.filter((o) => o.is_template);
  const formulaCells = objects.flatMap((o) =>
    Object.entries(o.cells)
      .filter(([, cell]) => cell.content.type === "formula")
      .map(([cell, content]) => ({ id: o.id, cell, overridden: content.override !== undefined })),
  );
  const overridden = formulaCells.filter((x) => x.overridden);
  const anyId = () => R.pick(ids);
  const destination = () =>
    R.chance(0.5) || objects.length === 0
      ? ({ type: "board", board: R.pick(boards), position: R.point() } as const)
      : ({
          type: "container",
          container: R.chance(0.6) && containers.length > 0 ? R.pick(containers).id : anyId(),
          ...(R.chance(0.5) ? { index: 0 } : {}),
        } as const);
  const randomViewers = (): ViewersValue =>
    R.pick([
      viewers("gm"),
      viewers("all"),
      viewers(ref("aldric")),
      viewers("owner"),
      viewers("gm", ref(R.pick(ids))),
    ]);
  const refValue = () => (R.chance(0.3) ? ref(R.pick(boards)) : ref(anyId()));
  const literal = () =>
    R.pick([
      () => num(R.int(30)),
      () => text(`t${R.int(9)}`),
      () => bool(R.chance(0.5)),
      refValue,
    ])();
  const one = (op: WireOp): Write => {
    const doc_aldric = doc.objects.aldric;
    const asAldric = doc_aldric?.is_character === true && R.chance(0.2);
    return asAldric
      ? { kind: "transact", ops: [op], actor: { type: "character", id: "aldric" } }
      : { kind: "transact", ops: [op] };
  };

  const kinds: (() => Write | undefined)[] = [
    // A literal write.
    () => one({ type: "set_value", object: anyId(), cell: R.pick(CELLS), value: literal() }),
    // A formula set.
    () => {
      const other = anyId();
      const room = zones.length > 0 ? R.pick(zones).id : "room1";
      const source = R.pick([
        `${other}.hp + 1`,
        `contents(${room}).where(tag has "creature")`,
        `if(${other}.face_up, 1, 2)`,
        other,
        "1 / 0",
        "contents(this)",
        `[${R.int(40)}, ${R.int(40)}]`,
      ]);
      const cell = R.pick([...CELLS, "position", "visible_to"]);
      return one({ type: "set_formula", object: anyId(), cell, source });
    },
    // An override.
    () => {
      if (formulaCells.length === 0) return undefined;
      const { id, cell } = R.pick(formulaCells);
      const value =
        cell === "position"
          ? list([num(R.int(40)), num(R.int(40))])
          : cell === "visible_to"
            ? randomViewers()
            : cell === "opaque"
              ? bool(R.chance(0.5))
              : R.chance(0.4)
                ? refValue()
                : num(R.int(30));
      return one({ type: "set_value", object: id, cell, value });
    },
    // Clearing an override.
    () => {
      if (overridden.length === 0) return undefined;
      const { id, cell } = R.pick(overridden);
      return one({ type: "clear_override", object: id, cell });
    },
    // A move between boards and containers.
    () => one({ type: "move", object: R.pick(notAldric), to: destination() }),
    // A spawn.
    () => {
      if (templates.length === 0) return undefined;
      return one({ type: "spawn", template: R.pick(templates).id, to: destination() });
    },
    // A create inside a container.
    () => {
      if (containers.length === 0) return undefined;
      return one({
        type: "create_object",
        to: { type: "container", container: R.pick(containers).id },
        init: {
          tag: R.chance(0.5) ? ["creature"] : [],
          cells: { name: text(`new${R.int(99)}`), hp: num(R.int(10)) },
        },
      });
    },
    // A remove (mostly inside a container).
    () => {
      const inside = containers.flatMap((o) => o.contents);
      const pool = R.chance(0.6) && inside.length > 0 ? inside : notAldric;
      return one({ type: "remove", object: R.pick(pool) });
    },
    // A reorder.
    () => {
      const big = containers.filter((o) => o.contents.length >= 2);
      if (big.length === 0) return undefined;
      const k = R.pick(big);
      const permutation = k.contents.map((_, i) => i);
      for (let i = permutation.length - 1; i > 0; i--) {
        const j = R.int(i + 1);
        [permutation[i], permutation[j]] = [permutation[j] as number, permutation[i] as number];
      }
      return one({ type: "reorder", container: k.id, permutation });
    },
    // A tag edit.
    () => one({ type: "set_tag", object: anyId(), tags: TAGS.filter(() => R.chance(0.4)) }),
    // A shape edit.
    () =>
      one({
        type: "set_shape",
        object: R.chance(0.5) && zones.length > 0 ? R.pick(zones).id : anyId(),
        shape: R.pick([
          null,
          { type: "circle", radius: 1 + R.int(6) },
          { type: "rect", width: 2 + R.int(10), height: 2 + R.int(10) },
        ]),
      }),
    // A template flag.
    () => one({ type: "set_template_flag", object: anyId(), value: R.chance(0.5) }),
    // A character flag, Aldric's own half the time.
    () =>
      one({
        type: "set_character_flag",
        object: R.chance(0.5) && doc.objects.aldric ? "aldric" : anyId(),
        value: R.chance(0.6),
      }),
    // Actions.
    () =>
      one({
        type: "set_actions",
        object: anyId(),
        actions: R.chance(0.3)
          ? []
          : [{ name: "Roll save", when: "save_roll = empty", steps: ["roll(1d20) -> save_roll"] }],
      }),
    // Boards: add, rename, remove.
    () => {
      const r = R.int(3);
      if (r === 0) return one({ type: "add_board", id: `b${boardSeq.n++}`, name: "New" });
      if (r === 1) return one({ type: "rename_board", id: R.pick(boards), name: `n${R.int(9)}` });
      const removable = boards.filter((b) => b !== "table" && b !== "crypt");
      if (removable.length === 0) return undefined;
      return one({ type: "remove_board", id: R.pick(removable) });
    },
    // A ref to an object or a board, literal.
    () => one({ type: "set_value", object: anyId(), cell: "link", value: refValue() }),
    // visible_to on a container.
    () => {
      if (containers.length === 0) return undefined;
      return one({
        type: "set_value",
        object: R.pick(containers).id,
        cell: "visible_to",
        value: randomViewers(),
      });
    },
    // Opaque zones: toggles (some erroneous) and moves.
    () => {
      if (zones.length === 0) return undefined;
      const z = R.pick(zones);
      const r = R.int(4);
      if (r === 0)
        return one({ type: "set_value", object: z.id, cell: "opaque", value: bool(R.chance(0.5)) });
      if (r === 1)
        return one({
          type: "set_formula",
          object: z.id,
          cell: "opaque",
          source: R.pick(['"maybe"', "1 / 0", "true"]),
        });
      if (r === 2 && z.board !== null)
        return one({
          type: "move",
          object: z.id,
          to: { type: "board", board: z.board, position: R.point() },
        });
      return one({ type: "set_value", object: z.id, cell: "visible_to", value: randomViewers() });
    },
    // A face flip.
    () => one({ type: "set_value", object: anyId(), cell: "face_up", value: bool(R.chance(0.5)) }),
    // Per-cell visibility.
    () =>
      one({
        type: "set_cell_visibility",
        object: anyId(),
        cell: R.pick(CELLS),
        viewers: R.chance(0.2) ? null : randomViewers(),
      }),
    // Undo.
    () => ({ kind: "undo" }),
  ];
  for (;;) {
    const w = R.pick(kinds)();
    if (w !== undefined) return w;
  }
}

// The harness.

let server: RunningServer | undefined;
let host: TableHost | undefined;
const clients: ProtocolClient[] = [];

afterEach(async () => {
  for (const cl of clients.splice(0)) cl.close();
  await server?.close();
  await host?.close();
  server = undefined;
  host = undefined;
}, 60_000);

async function connect(s: RunningServer, name: string): Promise<ProtocolClient> {
  const client = new ProtocolClient({
    url: s.url,
    token: s.token,
    client: { name, kind: "test" },
    onWarning: () => undefined,
  });
  clients.push(client);
  await client.connect();
  return client;
}

/** Canonical JSON: object keys sorted. */
const canon = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** Every key whose entry differs between two maps. */
function differing<K>(a: Map<K, unknown>, b: Map<K, unknown>): K[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => canon(a.get(k)) !== canon(b.get(k)));
}

/** How `mirror` differs from a fresh subscribe result; empty when equal. */
function mirrorDiff(mirror: ViewMirror, fresh: SubscribeResult): string[] {
  const out: string[] = [];
  if (mirror.revision !== fresh.revision) {
    out.push(`revision: mirror ${mirror.revision}, fresh ${fresh.revision}`);
  }
  const objects = new Map(fresh.objects.map((o) => [o.id, o]));
  for (const id of differing(mirror.objects, objects)) {
    out.push(
      `object ${id}: mirror ${canon(mirror.objects.get(id))}, fresh ${canon(objects.get(id))}`,
    );
  }
  const covers = new Map(fresh.covers.map((cv) => [cv.key, cv]));
  for (const key of differing(mirror.covers, covers)) {
    out.push(
      `cover ${key}: mirror ${canon(mirror.covers.get(key))}, fresh ${canon(covers.get(key))}`,
    );
  }
  const groups = new Map((fresh.groups ?? []).map((g) => [g.index, g]));
  for (const index of differing(mirror.groups, groups)) {
    out.push(
      `group ${index}: mirror ${canon(mirror.groups.get(index))}, fresh ${canon(groups.get(index))}`,
    );
  }
  return out;
}

const SCOPES: SubscribeParams["scope"][] = [
  { type: "board", board: "table" },
  { type: "board", board: "crypt" },
  {
    type: "objects",
    ids: ["chest1", "aldric_hand", "tok1", "room1", "tmpl_goblin"],
    subtree: true,
  },
  { type: "all" },
  { type: "log" },
];

const label = (p: SubscribeParams) =>
  `${p.viewer?.type === "character" ? "aldric" : "gm"} ${canon(p.scope)}`;

async function apply(client: ProtocolClient, w: Write): Promise<boolean> {
  if (w.kind === "undo") {
    const r = await client.request("undo", { target: { type: "latest" } });
    return r.status === "committed";
  }
  const r = await client.transact(w.ops, w.actor ? { actor: w.actor } : {});
  return r.status === "committed";
}

async function runSeed(seed: number): Promise<void> {
  const R = new Random(seed);
  host = TableHost.inMemory(DocumentStore.fromSnapshot(world()));
  // The clock runs 1000x fast for the per-connection request budget only
  // (PROTOCOL.md §10, max_requests_per_second): this test sends about 25
  // requests per commit, back to back, and the budget is not under test.
  const timers = { ...systemServerTimers, now: () => performance.now() * 1000 };
  server = await startServer({ host, port: 0, timers });
  const writer = await connect(server, "writer");
  const checker = await connect(server, "checker");
  const boardSeq = { n: 1 };
  const history: string[] = [];

  const commitOne = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const doc = (await writer.request("document", {})).snapshot;
      const w = randomWrite(R, doc, boardSeq);
      if (await apply(writer, w)) {
        history.push(`r${writer.revision}: ${describeWrite(w)}`);
        return;
      }
    }
    throw new Error(`seed ${seed}: 200 refused writes in a row`);
  };

  for (let i = 0; i < WARMUP; i++) await commitOne();

  const subs: Subscription[] = [];
  for (const viewer of [GM, ALDRIC]) {
    for (const scope of SCOPES) subs.push(await writer.subscribe({ scope, viewer }));
  }

  for (let k = 0; k < COMMITS; k++) {
    await commitOne();
    for (const sub of subs) {
      const fresh = await checker.request("subscribe", sub.params);
      await checker.request("unsubscribe", { subscription: fresh.subscription });
      const diffs = sub.state === "live" ? mirrorDiff(sub.mirror, fresh) : [`state ${sub.state}`];
      if (diffs.length > 0) {
        throw new Error(
          [
            `seed ${seed}, commit ${k} (revision ${writer.revision}), subscription ${label(sub.params)}:`,
            ...diffs.slice(0, 8).map((d) => `  ${d.length > 600 ? `${d.slice(0, 600)}…` : d}`),
            "last writes:",
            ...history.slice(-12).map((h) => `  ${h}`),
          ].join("\n"),
        );
      }
    }
  }
  expect(writer.revision).toBe(WARMUP + COMMITS);
}

describe("subscription equivalence over the protocol", () => {
  test("the table has 60 objects", () => {
    expect(Object.keys(world().objects)).toHaveLength(60);
  });

  test.each(SEEDS)(
    "seed %i: 200 commits keep every mirror equal to a fresh subscribe",
    { timeout: 180_000 },
    async (seed) => {
      await runSeed(seed);
    },
  );
});
