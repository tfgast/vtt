/**
 * Log panel test support (vtt-1xv.20): an in-process authority (the shared
 * helper's, vtt-qf5.45) whose host rolls from a FIXTURES §5 dice script, seed
 * records for the Attack card, Aldric and the goblin, and small write helpers.
 */
import {
  type AutosaveOptions,
  type CompactionPolicy,
  type RunningServer,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  type TableHost,
} from "@vtt/authority";
import type { GroupView, ProtocolClient, TransactResult, Viewer, WireOp } from "@vtt/protocol";
import type { TableSession } from "@vtt/ui";
import { type SessionOptions, startAuthority, until } from "../support/authority";

export interface LogAuthority {
  readonly server: RunningServer;
  readonly host: TableHost;
  /** A connected client; `agent` acts as `{type: "agent", name}`. */
  client(name: string, kind?: "test" | "agent"): Promise<ProtocolClient>;
  session(options?: SessionOptions): TableSession;
  cleanup(): Promise<void>;
}

const running = new Set<LogAuthority>();

export async function startLogAuthority(
  dice: ScriptedDiceEntry[] = [],
  options: { compaction?: CompactionPolicy; autosave?: Partial<AutosaveOptions> } = {},
): Promise<LogAuthority> {
  const inner = await startAuthority({ dice: new ScriptedDiceSource(dice), ...options });
  const authority: LogAuthority = {
    server: inner.server,
    host: inner.host,
    client: (name, kind = "test") => inner.client(name, { kind }),
    session: (options) => inner.session(options),
    async cleanup() {
      running.delete(authority);
      await inner.cleanup();
    },
  };
  running.add(authority);
  return authority;
}

export async function cleanupLogAuthorities(): Promise<void> {
  await Promise.all([...running].map((a) => a.cleanup()));
}

// ---------------------------------------------------------------------------
// Values and records

export const text = (value: string) => ({ type: "text" as const, value });
export const num = (value: number) => ({ type: "number" as const, value });
export const bool = (value: boolean) => ({ type: "boolean" as const, value });
export const ref = (object: string) => ({ type: "ref" as const, object });
export const formula = (source: string) => ({ type: "formula" as const, source });
export const EMPTY = { type: "empty" as const };
export const GM_ONLY = { type: "viewers" as const, viewers: ["gm" as const] };
export const ALL = { type: "viewers" as const, viewers: ["all" as const] };

export const GM: Viewer = { type: "gm" };
export const ALDRIC: Viewer = { type: "character", id: "aldric" };

export const at = (x: number, y: number) => ({
  type: "board" as const,
  board: "gm_board",
  position: [x, y] as [number, number],
});

export const roll = (expr: string, dice: number[], total: number): ScriptedDiceEntry => ({
  type: "roll",
  expr,
  dice,
  dropped: [],
  total,
});

/** Aldric (a character), the goblin and an Attack card aimed at it (FORMULAS §10). */
export const ATTACK_SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: {
      is_character: true,
      cells: {
        name: text("Aldric"),
        attack_bonus: num(5),
        damage_dice: { type: "dice", expr: "1d8+3" },
      },
    },
  },
  {
    type: "create_object",
    id: "goblin",
    to: at(3, 0),
    init: { cells: { name: text("Goblin"), ac: num(13), damage_taken: num(0) } },
  },
  {
    type: "create_object",
    id: "attack",
    to: at(6, 0),
    init: {
      cells: {
        name: text("Attack"),
        attacker: ref("aldric"),
        target: ref("goblin"),
        roll: EMPTY,
        dmg: EMPTY,
        applied: bool(false),
        bonus: formula("attacker.attack_bonus"),
        total: formula("roll + bonus"),
        hit: formula("roll != empty and total >= target.ac"),
      },
      actions: [
        { name: "Roll", when: "target != empty and roll = empty", steps: ["roll(1d20) -> roll"] },
        {
          name: "Roll damage",
          when: "hit and dmg = empty",
          steps: ["roll(attacker.damage_dice) -> dmg"],
        },
        {
          name: "Apply",
          when: "hit and dmg != empty and not applied",
          steps: ["add(target.damage_taken, dmg)", "set(applied, true)"],
        },
      ],
    },
  },
];

/** Aldric and a public note, for visibility tests. */
export const PARTY_SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(0, 0),
    init: { is_character: true, cells: { name: text("Aldric") } },
  },
  {
    type: "create_object",
    id: "note",
    to: at(2, 0),
    init: { cells: { name: text("Note"), n: num(0), secret: num(0) } },
  },
];

/** Commits `ops` as one group; throws on a rejection. */
export async function commit(
  client: ProtocolClient,
  ops: WireOp[],
  label?: string,
): Promise<Extract<TransactResult, { status: "committed" }>> {
  const result = await client.transact(ops, label === undefined ? {} : { label });
  if (result.status !== "committed") {
    throw new Error(`rejected: ${JSON.stringify(result.rejection)}`);
  }
  return result;
}

/**
 * `count` groups, each setting `object.cell` to the next number, labelled
 * `<prefix> <k>`, written round-robin by `writers` (the authority limits
 * requests per connection and second) with the latest revision as base;
 * resolves once every writer has seen the last commit.
 */
export async function commitMany(
  writers: ProtocolClient | readonly ProtocolClient[],
  count: number,
  object: string,
  cell: string,
  prefix: string,
): Promise<number[]> {
  const pool = Array.isArray(writers) ? writers : [writers as ProtocolClient];
  const indices: number[] = [];
  let revision = Math.max(...pool.map((c) => c.revision));
  for (let k = 0; k < count; k++) {
    const client = pool[k % pool.length] as ProtocolClient;
    const result = await client.transact([{ type: "set_value", object, cell, value: num(k + 1) }], {
      label: `${prefix} ${k}`,
      base_revision: revision,
    });
    if (result.status !== "committed") {
      throw new Error(`rejected: ${JSON.stringify(result.rejection)}`);
    }
    revision = result.revision;
    indices.push(result.index);
  }
  await until(() => pool.every((c) => c.revision >= revision), "the writers to catch up");
  return indices;
}

/** A GM client and three more GM writers, for `commitMany`. */
export async function writers(authority: LogAuthority): Promise<ProtocolClient[]> {
  const out: ProtocolClient[] = [];
  for (let k = 0; k < 4; k++) out.push(await authority.client(`writer ${k}`));
  return out;
}

/** Waits until `session` has reached `client`'s revision. */
export async function caughtUp(session: TableSession, client: ProtocolClient): Promise<void> {
  await session.whenRevision(client.revision);
}

export const indicesOf = (groups: readonly GroupView[]) => groups.map((g) => g.index);

export { until };
