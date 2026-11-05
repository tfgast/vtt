/**
 * A stocked new table in play (vtt-1xv.22; DESIGN.md §4.7, §7 New tables
 * and ownership, §8.4 steps 1, 2, 9, 10, 12; FORMULAS.md §10; M5-D19).
 *
 * The flow runs the template records unedited on a Table from
 * `stockedTableSnapshot()` through
 * `createExecutor({handlers: [...coreHandlers, ...placementHandlers]})`.
 * The only other writes are the GM's preparation (spawns, cell edits and
 * one zone move) as the UI would make them. Then `TableHost.open`'s
 * `newTable` option, and `vtt-serve` on a missing file (stocked, or empty
 * with `--empty`), run as the real binary.
 */
import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coreHandlers,
  createExecutor,
  type InvokeOutcome,
  loadTable,
  move,
  newTableSnapshot,
  placementHandlers,
  ScriptedDiceSource,
  spawn,
  stockedTableSnapshot,
  Table,
  TableHost,
  type Transaction,
  writeValue,
} from "@vtt/authority";
import {
  type Actor,
  type ObjectId,
  type Result,
  type RollValue,
  ref,
  type Value,
} from "@vtt/schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const gm: Actor = { type: "gm" };
const executor = createExecutor({ handlers: [...coreHandlers, ...placementHandlers] });

const rolled = (expr: string, dice: number[]): RollValue => ({
  type: "roll",
  expr,
  dice,
  dropped: [],
  total: dice.reduce((a, b) => a + b, 0),
});

const n = (value: number): Value => ({ type: "number", value });

/** A Result as a plain number (a number, or a roll's total), for assertions. */
function numberOf(r: Result): number {
  if (r.type === "number") return r.value;
  if (r.type === "roll") return r.total;
  throw new Error(`not a number: ${JSON.stringify(r)}`);
}

describe("a stocked table in play (§8.4 steps 1, 2, 9, 10, 12)", () => {
  test("d20, Attack card from the character's binder, and Area Save on the board", () => {
    const table = Table.fromSnapshot(stockedTableSnapshot());
    const dice = new ScriptedDiceSource([
      rolled("1d20", [12]), // the d20
      rolled("1d20", [10]), // the attack
      rolled("1d8", [6]),
      rolled("8d6", [3, 5, 2, 6, 4, 1, 6, 1]), // 28
      rolled("1d20", [15]), // A's save
      rolled("1d20", [5]), // B's save
    ]);

    /** The GM's preparation writes, one committed edit each. */
    function prep<T>(label: string, fn: (tx: Transaction) => T): T {
      let out: T | undefined;
      const result = table.store.transact(gm, { kind: "edit", label }, (tx) => {
        out = fn(tx);
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return out as T;
    }
    const press = (object: ObjectId, action: string): InvokeOutcome =>
      executor.invokeAction(table, dice, { object, action, actor: gm });
    const ok = (object: ObjectId, action: string): InvokeOutcome & { ok: true } => {
      const outcome = press(object, action);
      expect(outcome.ok, `${object} ${action}: ${JSON.stringify(outcome)}`).toBe(true);
      return outcome as InvokeOutcome & { ok: true };
    };
    const value = (object: ObjectId, cell: string) => table.value(object, cell);
    const exists = (id: ObjectId) => table.store.hasObject(id);
    const contents = (id: ObjectId) => [...table.store.contentsOf(id)];
    const onBoard = (template: ObjectId, x: number, y: number) =>
      prep(`spawn ${template}`, (tx) =>
        spawn(tx, template, { type: "board", board: "gm_board", position: [x, y] }),
      );

    // Step 9: a loose d20 from the GM binder, double-clicked.
    const d20 = onBoard("tpl_d20", -10, 0).root;
    ok(d20, "Roll");
    expect(numberOf(value(d20, "total"))).toBe(12);

    // Step 2: the character, its sheet filled in.
    const spawnedCharacter = onBoard("tpl_character", 0, 0);
    const character = spawnedCharacter.root;
    const sheet = spawnedCharacter.copies.get("tpl_character_sheet") as ObjectId;
    const binder = spawnedCharacter.copies.get("tpl_character_binder") as ObjectId;
    const binderAttack = spawnedCharacter.copies.get("tpl_character_attack") as ObjectId;
    expect(value(character, "sheet")).toEqual(ref(sheet));
    prep("sheet", (tx) => {
      writeValue(tx, sheet, "attack_bonus", n(5));
      writeValue(tx, sheet, "spell_dc", n(14));
    });

    // Two tokens.
    const tokenA = onBoard("tpl_token", 10, 0).root;
    const tokenB = onBoard("tpl_token", 11, 0).root;
    for (const [token, dex] of [
      [tokenA, 2],
      [tokenB, 0],
    ] as const) {
      prep("token", (tx) => {
        writeValue(tx, token, "ac", n(13));
        writeValue(tx, token, "max_hp", n(30));
        writeValue(tx, token, "dex_save", n(dex));
      });
    }

    // Step 10: the binder's Attack card refers to the new character.
    expect(contents(binder)).toEqual([binderAttack]);
    expect(table.store.getObject(binderAttack)?.is_template).toBe(true);
    expect(value(binderAttack, "attacker")).toEqual(ref(character));
    expect(value(binderAttack, "owner")).toEqual(ref(character));
    expect(value(sheet, "owner")).toEqual(ref(character));
    expect(value(binder, "owner")).toEqual(ref(character));

    // Expanding it makes a working copy right after it; target A.
    const attack = prep("working copy", (tx) =>
      spawn(tx, binderAttack, { type: "container", container: binder, index: 1 }),
    ).root;
    expect(contents(binder)).toEqual([binderAttack, attack]);
    expect(value(attack, "attacker")).toEqual(ref(character));
    prep("target", (tx) => writeValue(tx, attack, "target", ref(tokenA)));

    ok(attack, "Roll");
    expect(numberOf(value(attack, "total"))).toBe(15);
    expect(value(attack, "hit")).toEqual({ type: "boolean", value: true });
    ok(attack, "Roll damage");
    expect(numberOf(value(attack, "dmg"))).toBe(6);
    ok(attack, "Apply");
    expect(numberOf(value(tokenA, "damage_taken"))).toBe(6);
    expect(numberOf(value(tokenA, "hp"))).toBe(24);
    const again = press(attack, "Apply");
    expect(again).toMatchObject({
      ok: false,
      rejection: { type: "when_false", object: attack, action: "Apply" },
    });

    // Step 12: the Area Save card on the board, its caster set by a drop.
    const spawnedCard = onBoard("tpl_area_save", 0, 6);
    const card = spawnedCard.root;
    const zone = spawnedCard.copies.get("tpl_area_save_zone") as ObjectId;
    expect(value(card, "zone")).toEqual(ref(zone));
    expect(value(card, "save_row")).toEqual(ref("tpl_save_row"));
    expect(value(card, "caster")).toEqual({ type: "empty" });
    prep("caster", (tx) => writeValue(tx, card, "caster", ref(character)));
    expect(numberOf(value(card, "dc"))).toBe(14);

    // The zone dragged out of the card onto the board.
    prep("zone", (tx) => move(tx, zone, { type: "board", board: "gm_board", position: [10.5, 0] }));
    expect(value(card, "targets")).toEqual({ type: "list", items: [ref(tokenA), ref(tokenB)] });

    ok(card, "Lock targets");
    const rows = contents(card);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => value(r, "target"))).toEqual([ref(tokenA), ref(tokenB)]);
    const [rowA, rowB] = rows as [ObjectId, ObjectId];

    ok(card, "Roll damage");
    expect(numberOf(value(card, "damage"))).toBe(28);
    ok(rowA, "Roll save");
    ok(rowB, "Roll save");
    expect(value(rowA, "passed")).toEqual({ type: "boolean", value: true });
    expect(numberOf(value(rowA, "damage_dealt"))).toBe(14);
    expect(value(rowB, "passed")).toEqual({ type: "boolean", value: false });
    expect(value(rowB, "damage_dealt")).toEqual(rolled("8d6", [3, 5, 2, 6, 4, 1, 6, 1]));

    ok(card, "Apply all");
    expect(numberOf(value(tokenA, "damage_taken"))).toBe(20);
    expect(numberOf(value(tokenB, "damage_taken"))).toBe(28);

    ok(card, "Discard");
    for (const gone of [zone, card, rowA, rowB]) expect(exists(gone), gone).toBe(false);
    for (const kept of [tokenA, tokenB, character]) expect(exists(kept), kept).toBe(true);

    expect(dice.remaining()).toBe(0);
  });

  test("the Area Save's Roll save is refused while caster is empty", () => {
    const table = Table.fromSnapshot(stockedTableSnapshot());
    const dice = new ScriptedDiceSource([]);
    let row: ObjectId | undefined;
    const result = table.store.transact(gm, { kind: "edit", label: "prep" }, (tx) => {
      const card = spawn(tx, "tpl_area_save", {
        type: "board",
        board: "gm_board",
        position: [0, 6],
      }).root;
      row = spawn(tx, "tpl_save_row", { type: "container", container: card }).root;
    });
    expect(result.ok).toBe(true);
    const outcome = executor.invokeAction(table, dice, {
      object: row as ObjectId,
      action: "Roll save",
      actor: gm,
    });
    expect(outcome).toMatchObject({ ok: false, rejection: { type: "when_false" } });
  });
});

// ---------------------------------------------------------------- the host

let dir: string;
let path: string;
const hosts: TableHost[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-stocked-")));
  path = join(dir, "table.json");
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await Promise.all(
    procs.splice(0).map(async (p) => {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await p.exited;
    }),
  );
  await rm(dir, { recursive: true, force: true });
});

describe("TableHost.open's newTable option", () => {
  test("a missing file is created from newTable and saved at once", async () => {
    const host = await TableHost.open(path, {
      createIfMissing: true,
      autosave: false,
      newTable: stockedTableSnapshot,
    });
    hosts.push(host);
    expect(host.table.store.toSnapshot()).toEqual(stockedTableSnapshot());
    expect(host.lastSavedRevision).toBe(0);
    expect((await loadTable(path)).store.toSnapshot()).toEqual(stockedTableSnapshot());
  });

  test("the default stays the empty table", async () => {
    const host = await TableHost.open(path, { createIfMissing: true, autosave: false });
    hosts.push(host);
    expect(host.table.store.toSnapshot()).toEqual(newTableSnapshot());
  });

  test("an existing file is loaded, not replaced", async () => {
    const first = await TableHost.open(path, { createIfMissing: true, autosave: false });
    await first.close();
    const host = await TableHost.open(path, {
      createIfMissing: true,
      autosave: false,
      newTable: stockedTableSnapshot,
    });
    hosts.push(host);
    expect(host.table.store.toSnapshot()).toEqual(newTableSnapshot());
  });
});

// ----------------------------------------------------------- vtt-serve

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const BIN = join(PKG, "src", "bin", "serve.ts");
const READY_MS = 20_000;

interface Proc {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const procs: Proc[] = [];

/** `node --import tsx src/bin/serve.ts …` from the package directory, as vtt-5su.14's tests run it. */
function serve(args: string[]): Proc {
  const child = spawnProcess(process.execPath, ["--import", "tsx", BIN, ...args], {
    cwd: PKG,
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (s: string) => {
    stdout += s;
  });
  child.stderr?.setEncoding("utf8").on("data", (s: string) => {
    stderr += s;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const proc: Proc = {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    exited,
  };
  procs.push(proc);
  return proc;
}

/** Waits for the `--print-session` line (the process is listening), then stops it with SIGTERM. */
async function runUntilListening(p: Proc): Promise<void> {
  const end = Date.now() + READY_MS;
  while (!p.stdout.includes("\n")) {
    if (p.child.exitCode !== null) throw new Error(`vtt-serve exited early:\n${p.stderr}`);
    if (Date.now() > end) throw new Error(`vtt-serve did not start:\n${p.stderr}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  p.child.kill("SIGTERM");
  expect(await p.exited).toEqual({ code: 0, signal: null });
}

describe("vtt-serve on a missing file", () => {
  test("creates the stocked table", async () => {
    await runUntilListening(serve([path, "--port", "0", "--print-session", "--no-ui"]));
    const snapshot = (await loadTable(path)).store.toSnapshot();
    expect(snapshot).toEqual(stockedTableSnapshot());
  }, 30_000);

  test("with --empty creates the empty table", async () => {
    await runUntilListening(serve([path, "--port", "0", "--print-session", "--no-ui", "--empty"]));
    const snapshot = (await loadTable(path)).store.toSnapshot();
    expect(snapshot).toEqual(newTableSnapshot());
  }, 30_000);
});
