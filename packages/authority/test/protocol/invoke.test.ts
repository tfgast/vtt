/**
 * The `invoke` command over a real server (vtt-1xv.11; PROTOCOL.md §3, §4,
 * §6, §10; DESIGN.md §5.2, §7; FORMULAS.md §8, §10; M5-D1): a server on port
 * 0 over an in-memory `TableHost` with a `ScriptedDiceSource`, Node's
 * `WebSocket` and `ProtocolClient`. Covers the Attack card's three actions,
 * the Fireball card's Lock targets (spawned rows in `created`) and Discard,
 * refusals, deduplication shared with `transact`, stale writes (declared and
 * touched keys), the character actor, the action limits, and
 * `invokeWithRetry` across a same-session drop and a restart.
 */
import {
  DocumentStore,
  type RunningServer,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  TableHost,
} from "@vtt/authority";
import {
  enableRecovery,
  type InvokeResult,
  invokeWithRetry,
  LIMITS,
  type ProtocolClient,
  type ProtocolError,
  ProtocolFailure,
  type TransactResult,
  type WebSocketConstructor,
  type WebSocketLike,
  type WireOp,
} from "@vtt/protocol";
import { MAX_EACH_ITEMS, type Snapshot } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { loadScenarioFile } from "../runner/load";
import { documentFromSetup } from "../runner/setup";
import { cleanup, connect, serve, until } from "../server/helpers";

afterEach(cleanup);

type Committed = Extract<InvokeResult, { status: "committed" }>;
type Refused = Extract<InvokeResult, { status: "rejected" }>;

function committed(r: InvokeResult | TransactResult): Committed {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Committed;
}

function refused(r: InvokeResult): Refused {
  expect(r.status, JSON.stringify(r)).toBe("rejected");
  return r as Refused;
}

async function failure(promise: Promise<unknown>): Promise<ProtocolError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolFailure);
    return (e as ProtocolFailure).error;
  }
  throw new Error("expected a rejection");
}

interface World {
  host: TableHost;
  server: RunningServer;
  dice: ScriptedDiceSource;
  gm: ProtocolClient;
  /** A second connected client, recording every commit event it receives. */
  other: ProtocolClient;
  otherCommits: number[];
}

async function world(
  snapshot: Snapshot,
  entries: readonly ScriptedDiceEntry[],
  connectOptions: Parameters<typeof connect>[1] = {},
): Promise<World> {
  const dice = new ScriptedDiceSource(entries);
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(snapshot), { dice });
  const { server } = await serve({ host });
  const gm = await connect(server, { instance: "gm-1", ...connectOptions });
  const other = await connect(server, { instance: "other-1" });
  const otherCommits: number[] = [];
  other.on("commit", (e) => otherCommits.push(e.revision));
  return { host, server, dice, gm, other, otherCommits };
}

/** Everything a refused invoke must leave unchanged. */
function state(w: World) {
  return {
    doc: JSON.stringify(w.host.table.store.toSnapshot()),
    revision: w.host.revision,
    log: w.host.table.store.history.groups().length,
    dice: w.dice.remaining(),
  };
}

/** Asserts the refusal changed nothing and no commit event reached the second client. */
async function unchanged(w: World, before: ReturnType<typeof state>): Promise<void> {
  // A round trip on the second client: any commit event would have arrived before it.
  await w.other.request("list_objects", { limit: 1 });
  expect(state(w)).toEqual(before);
  expect(w.otherCommits.filter((r) => r > before.revision)).toEqual([]);
}

const cellOf = (w: World, object: string, cell: string) =>
  w.host.table.store.getObject(object)?.cells[cell]?.content;

// ---------------------------------------------------------------------------
// The Attack card (FORMULAS §10; attack-card.json)

const ATTACK = await loadScenarioFile("attack-card.json");
const ATTACK_DICE = ATTACK.dice as ScriptedDiceEntry[];

/** The attack-card setup with `card` spawned from the template by Aldric's binder and targeting the goblin. */
async function attack(connectOptions: Parameters<typeof connect>[1] = {}) {
  const w = await world(documentFromSetup(ATTACK.setup), ATTACK_DICE, connectOptions);
  const spawned = committed(
    await w.gm.transact(
      [
        {
          type: "spawn",
          template: "attack_card",
          to: { type: "board", board: "table", position: [2, 0] },
          cells: { attacker: { type: "ref", object: "aldric" } },
          as: "$card",
        },
        {
          type: "set_value",
          object: "$card",
          cell: "target",
          value: { type: "ref", object: "goblin1" },
        },
      ],
      { base_revision: w.host.revision },
    ),
  ) as unknown as Extract<TransactResult, { status: "committed" }>;
  const card = spawned.bindings.$card;
  if (card === undefined) throw new Error("no card");
  const invoke = (action: string, extra: Record<string, unknown> = {}) =>
    w.gm.invoke({ object: card, action, base_revision: w.host.revision, ...extra });
  return { ...w, card, invoke };
}

describe("invoke: the Attack card", () => {
  test("Roll, Roll damage and Apply commit as action groups with scripted dice", async () => {
    const w = await attack();
    const r0 = w.host.revision;

    const roll = committed(await w.invoke("Roll"));
    expect(roll).toEqual({ status: "committed", revision: r0 + 1, index: 1, created: [] });
    expect(cellOf(w, w.card, "roll")).toEqual(ATTACK_DICE[0]);
    const group = w.host.table.store.history.get(roll.index);
    expect(group).toMatchObject({
      kind: "action",
      label: "Roll",
      origin: { object: w.card, action: "Roll" },
      actor: { type: "gm" },
      revision: r0 + 1,
    });

    const damage = committed(await w.invoke("Roll damage", { label: "Damage!" }));
    expect(damage.revision).toBe(r0 + 2);
    expect(cellOf(w, w.card, "dmg")).toEqual(ATTACK_DICE[1]);
    expect(w.host.table.store.history.get(damage.index)?.label).toBe("Damage!");

    const apply = committed(await w.invoke("Apply"));
    expect(apply.revision).toBe(r0 + 3);
    expect(cellOf(w, "goblin1", "damage_taken")).toEqual({ type: "number", value: 8 });
    expect(cellOf(w, w.card, "applied")).toEqual({ type: "boolean", value: true });
    expect(w.dice.remaining()).toBe(0);
    await until(() => w.otherCommits.includes(r0 + 3), 3000, "the second client's commit event");

    // A second Apply: when_false, nothing changes.
    const before = state(w);
    const again = refused(await w.invoke("Apply"));
    expect(again).toEqual({
      status: "rejected",
      rejection: { type: "when_false", object: w.card, action: "Apply" },
    });
    await unchanged(w, before);
  });

  test("an invoke with actor Aldric records that actor", async () => {
    const w = await attack();
    const r = committed(await w.invoke("Roll", { actor: { type: "character", id: "aldric" } }));
    expect(w.host.table.store.history.get(r.index)?.actor).toEqual({
      type: "character",
      id: "aldric",
    });
  });

  test("a repeated txn_id returns the stored result without consuming dice; other params are invalid", async () => {
    const w = await attack();
    const first = committed(await w.invoke("Roll", { txn_id: "t1" }));
    const remaining = w.dice.remaining();
    const before = state(w);
    const repeat = await w.gm.invoke({
      object: w.card,
      action: "Roll",
      base_revision: first.revision - 1,
      txn_id: "t1",
    });
    expect(repeat).toEqual(first);
    expect(w.dice.remaining()).toBe(remaining);
    await unchanged(w, before);

    const reused = refused(
      await w.gm.invoke({
        object: w.card,
        action: "Roll damage",
        base_revision: first.revision - 1,
        txn_id: "t1",
      }),
    );
    expect(reused.rejection).toEqual({
      type: "invalid",
      message: "txn_id reused with different params",
    });
    await unchanged(w, before);

    // One store with transact: the method is part of the fingerprint.
    const crossed = await w.gm.transact(
      [{ type: "set_value", object: w.card, cell: "n", value: { type: "number", value: 1 } }],
      { base_revision: w.host.revision, txn_id: "t1" },
    );
    expect(crossed).toEqual({
      status: "rejected",
      rejection: { type: "invalid", message: "txn_id reused with different params" },
    });
    await unchanged(w, before);

    // A retry of the stored invoke on a new connection with the same instance.
    const again = await connect(w.server, { instance: "gm-1" });
    const retried = await again.request("invoke", {
      object: w.card,
      action: "Roll",
      base_revision: first.revision - 1,
      txn_id: "t1",
      retry: true,
    });
    expect(retried).toEqual(first);
    expect(
      await failure(
        again.request("invoke", {
          object: w.card,
          action: "Roll",
          base_revision: w.host.revision,
          txn_id: "t-unknown",
          retry: true,
        }),
      ),
    ).toMatchObject({ code: "retry_unknown" });
    await unchanged(w, before);
  });

  test("a rejected result is stored too", async () => {
    const w = await attack();
    const first = refused(await w.invoke("Apply", { txn_id: "t2" }));
    expect(first.rejection.type).toBe("when_false");
    committed(await w.invoke("Roll"));
    committed(await w.invoke("Roll damage"));
    // Apply is enabled now, but the stored rejection is returned.
    const again = await w.gm.invoke({
      object: w.card,
      action: "Apply",
      base_revision: w.host.revision - 2,
      txn_id: "t2",
    });
    expect(again).toEqual(first);
  });

  test("a concurrent write to the target's damage_taken makes Apply stale_write (touched keys)", async () => {
    const w = await attack();
    committed(await w.invoke("Roll"));
    committed(await w.invoke("Roll damage"));
    const base = w.host.revision;
    const write = committed(
      await w.other.transact(
        [
          {
            type: "set_value",
            object: "goblin1",
            cell: "damage_taken",
            value: { type: "number", value: 2 },
          },
        ],
        { base_revision: base },
      ),
    );
    await until(() => w.otherCommits.includes(write.revision));
    const before = state(w);
    const r = refused(await w.gm.invoke({ object: w.card, action: "Apply", base_revision: base }));
    expect(r.step).toBeUndefined();
    expect(r.rejection).toEqual({
      type: "stale_write",
      base_revision: base,
      revision: base + 1,
      floor: 0,
      truncated: false,
      conflicts: [
        {
          index: write.index,
          revision: base + 1,
          actor: { type: "gm" },
          label: "set_value goblin1.damage_taken",
          keys: ["cell:goblin1/damage_taken"],
        },
      ],
    });
    await unchanged(w, before);
    // At the current revision it commits.
    committed(await w.invoke("Apply"));
    expect(cellOf(w, "goblin1", "damage_taken")).toEqual({ type: "number", value: 10 });
  });

  test("a concurrent write of empty to the card's dmg makes Roll damage stale_write; no dice consumed", async () => {
    const w = await attack();
    committed(await w.invoke("Roll"));
    const base = w.host.revision;
    committed(
      await w.other.transact(
        [{ type: "set_value", object: w.card, cell: "dmg", value: { type: "empty" } }],
        { base_revision: base },
      ),
    );
    await until(() => w.otherCommits.includes(base + 1));
    const before = state(w);
    expect(before.dice).toBe(1);
    const r = refused(
      await w.gm.invoke({ object: w.card, action: "Roll damage", base_revision: base }),
    );
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      base_revision: base,
      truncated: false,
      conflicts: [{ revision: base + 1, keys: [`cell:${w.card}/dmg`] }],
    });
    await unchanged(w, before);
    expect(w.dice.remaining()).toBe(1);
  });

  test("an unknown object or action is rejected invalid; an object removed since base_revision is stale_write", async () => {
    const w = await attack();
    const before = state(w);
    const ghost = refused(
      await w.gm.invoke({ object: "ghost", action: "Roll", base_revision: w.host.revision }),
    );
    expect(ghost.rejection).toMatchObject({ type: "invalid" });
    const noAction = refused(await w.invoke("Fly"));
    expect(noAction.rejection).toMatchObject({ type: "invalid" });
    await unchanged(w, before);

    const base = w.host.revision;
    committed(
      await w.other.transact([{ type: "remove", object: w.card }], { base_revision: base }),
    );
    const removed = refused(
      await w.gm.invoke({ object: w.card, action: "Roll", base_revision: base }),
    );
    expect(removed.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ revision: base + 1, keys: [`obj:${w.card}`] }],
    });
  });

  test("structural and state validation answer bad_request, never stored", async () => {
    const w = await attack();
    const base = w.host.revision;
    expect(
      await failure(
        w.gm.request("invoke", {
          object: w.card,
          action: "Roll",
          base_revision: base,
          retry: true,
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    expect(
      await failure(
        w.gm.invoke({
          object: w.card,
          action: "Roll",
          base_revision: base,
          label: "x".repeat(201),
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    expect(
      await failure(w.gm.invoke({ object: w.card, action: "Roll", base_revision: base + 1 })),
    ).toMatchObject({ code: "bad_request" });
    expect(
      await failure(
        w.gm.invoke({
          object: w.card,
          action: "Roll",
          base_revision: base,
          txn_id: "t3",
          actor: { type: "character", id: "goblin1" },
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    // Not stored: the same txn_id with valid params executes.
    committed(
      await w.gm.invoke({ object: w.card, action: "Roll", base_revision: base, txn_id: "t3" }),
    );

    const agent = await connect(w.server, {
      instance: "agent-1",
      client: { name: "claude", kind: "agent" },
    });
    const before = state(w);
    expect(
      await failure(
        agent.invoke({
          object: w.card,
          action: "Roll damage",
          base_revision: w.host.revision,
          actor: { type: "character", id: "aldric" },
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    await unchanged(w, before);
    // Without actor, the agent's own actor is recorded.
    const r = committed(
      await agent.invoke({ object: w.card, action: "Roll damage", base_revision: w.host.revision }),
    );
    expect(w.host.table.store.history.get(r.index)?.actor).toEqual({
      type: "agent",
      name: "claude",
    });
  });

  test("the when guard is evaluated at the current revision, not at base_revision", async () => {
    const w = await attack();
    const base = w.host.revision;
    committed(await w.invoke("Roll"));
    // Roll damage was disabled at `base` (no roll yet) but is enabled now; the
    // Roll group touched only the card's roll, which conflicts with obj:<card>.
    const stale = refused(
      await w.gm.invoke({ object: w.card, action: "Roll damage", base_revision: base }),
    );
    expect(stale.rejection.type).toBe("stale_write");
    // A guard reading another object: disabled at base, enabled now, no conflict.
    const doc = documentFromSetup(ATTACK.setup);
    const aldric = doc.objects.aldric;
    if (aldric === undefined) throw new Error("fixture");
    aldric.actions = [
      { name: "Strike", when: 'obj("goblin1").ac > 13', steps: ["set(attack_bonus, 6)"] },
    ];
    const w2 = await world(doc, []);
    const b2 = w2.host.revision;
    const early = refused(
      await w2.gm.invoke({ object: "aldric", action: "Strike", base_revision: b2 }),
    );
    expect(early.rejection.type).toBe("when_false");
    committed(
      await w2.other.transact(
        [
          {
            type: "set_value",
            object: "goblin1",
            cell: "ac",
            value: { type: "number", value: 15 },
          },
        ],
        { base_revision: b2 },
      ),
    );
    committed(await w2.gm.invoke({ object: "aldric", action: "Strike", base_revision: b2 }));
  });
});

// ---------------------------------------------------------------------------
// The Fireball card (FORMULAS §10; fireball.json): placement steps

describe("invoke: the Fireball card", () => {
  test("Lock targets lists the spawned rows in created; Discard removes the card and its zone", async () => {
    const scenario = await loadScenarioFile("fireball.json");
    const w = await world(documentFromSetup(scenario.setup), scenario.dice as ScriptedDiceEntry[]);
    const spawned = (await w.gm.transact(
      [
        {
          type: "spawn",
          template: "fireball",
          to: { type: "container", container: "aldric_binder", index: 0 },
          cells: { caster: { type: "ref", object: "aldric" } },
          as: "$fb",
          owned: { fireball_zone: "$zone" },
        },
        { type: "move", object: "$zone", to: { type: "board", board: "map", position: [10, 10] } },
      ],
      { base_revision: w.host.revision },
    )) as Extract<TransactResult, { status: "committed" }>;
    expect(spawned.status).toBe("committed");
    const fb = spawned.bindings.$fb as string;
    const zone = spawned.bindings.$zone as string;

    const lock = committed(
      await w.gm.invoke({
        object: fb,
        action: "Lock targets",
        base_revision: w.host.revision,
        actor: { type: "character", id: "aldric" },
      }),
    );
    const contents = w.host.table.store.getObject(fb)?.contents ?? [];
    const rows = contents.filter((id) => id !== zone);
    expect(rows).toHaveLength(2);
    expect(lock.created).toEqual(rows);
    for (const row of rows) {
      expect(w.host.table.store.getObject(row)?.cells.template?.content).toEqual({
        type: "ref",
        object: "save_row_t",
      });
    }
    expect(cellOf(w, fb, "locked")).toEqual({ type: "boolean", value: true });

    const discard = committed(
      await w.gm.invoke({ object: fb, action: "Discard", base_revision: w.host.revision }),
    );
    expect(discard.created).toEqual([]);
    expect(w.host.table.store.getObject(fb)).toBeUndefined();
    expect(w.host.table.store.getObject(zone)).toBeUndefined();
    expect(w.host.table.store.history.get(discard.index)).toMatchObject({
      kind: "action",
      label: "Discard",
      origin: { object: fb, action: "Discard" },
    });
  });

  test("the table param is what the table destination resolves to", async () => {
    const doc = documentFromSetup(ATTACK.setup);
    const aldric = doc.objects.aldric;
    if (aldric === undefined) throw new Error("fixture");
    aldric.actions = [{ name: "Deal", steps: ['spawn(obj("attack_card"), table)'] }];
    const w = await world(doc, []);
    const r = committed(
      await w.gm.invoke({
        object: "aldric",
        action: "Deal",
        base_revision: w.host.revision,
        table: { board: "table", position: [7, -3] },
      }),
    );
    expect(r.created).toHaveLength(1);
    const copy = w.host.table.store.getObject(r.created[0] as string);
    expect(copy?.board).toBe("table");
    expect(copy?.cells.position?.content).toEqual({
      type: "list",
      items: [
        { type: "number", value: 7 },
        { type: "number", value: -3 },
      ],
    });
    // Without it the table destination refuses with the step index.
    const before = state(w);
    const none = refused(
      await w.gm.invoke({ object: "aldric", action: "Deal", base_revision: w.host.revision }),
    );
    expect(none).toMatchObject({ rejection: { type: "step_error", step: 0 }, step: 0 });
    await unchanged(w, before);
  });
});

// ---------------------------------------------------------------------------
// Limits (M5-D5)

describe("invoke: limits", () => {
  test("an each past LIMITS.max_each_items is step_error #LIMIT", async () => {
    expect(LIMITS.max_each_items).toBe(MAX_EACH_ITEMS);
    const doc = documentFromSetup(ATTACK.setup);
    const aldric = doc.objects.aldric;
    if (aldric === undefined) throw new Error("fixture");
    aldric.actions = [{ name: "Count", steps: ["set(n, 0)", "each(xs, add(n, 1))"] }];
    const w = await world(doc, []);
    const items = (k: number): WireOp => ({
      type: "set_value",
      object: "aldric",
      cell: "xs",
      value: {
        type: "list",
        items: Array.from({ length: k }, (_, i) => ({ type: "number" as const, value: i })),
      },
    });
    committed(
      await w.gm.transact([items(LIMITS.max_each_items)], { base_revision: w.host.revision }),
    );
    committed(
      await w.gm.invoke({ object: "aldric", action: "Count", base_revision: w.host.revision }),
    );
    expect(cellOf(w, "aldric", "n")).toEqual({ type: "number", value: LIMITS.max_each_items });

    committed(
      await w.gm.transact([items(LIMITS.max_each_items + 1)], { base_revision: w.host.revision }),
    );
    const before = state(w);
    const r = refused(
      await w.gm.invoke({ object: "aldric", action: "Count", base_revision: w.host.revision }),
    );
    expect(r).toMatchObject({
      rejection: { type: "step_error", object: "aldric", action: "Count", step: 1, code: "#LIMIT" },
      step: 1,
    });
    await unchanged(w, before);
  });
});

// ---------------------------------------------------------------------------
// invokeWithRetry over a real server

/**
 * A `WebSocket` that swallows the response to the first `invoke` sent
 * without `retry` and closes the socket instead, so the authority has
 * executed (and stored) the invocation but the client never sees the result.
 */
function droppingWebSocket(onDrop: () => void): WebSocketConstructor {
  let target: string | null = null;
  let dropped = false;
  return class implements WebSocketLike {
    readonly #inner: WebSocket;
    constructor(url: string) {
      this.#inner = new WebSocket(url);
    }
    send(data: string): void {
      const msg = JSON.parse(data);
      if (!dropped && target === null && msg.method === "invoke" && msg.params.retry !== true) {
        target = msg.id;
      }
      this.#inner.send(data);
    }
    close(code?: number, reason?: string): void {
      this.#inner.close(code, reason);
    }
    // biome-ignore lint/suspicious/noExplicitAny: the platform's event types vary
    addEventListener(type: string, listener: (event: any) => void): void {
      if (type !== "message") {
        this.#inner.addEventListener(type, listener);
        return;
      }
      this.#inner.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (!dropped && target !== null && msg.type === "response" && msg.id === target) {
          dropped = true;
          this.#inner.close(4000, "test drop");
          onDrop();
          return;
        }
        listener(event);
      });
    }
  };
}

describe("invokeWithRetry", () => {
  test("resends once after a same-session socket drop and returns the stored result", async () => {
    let drops = 0;
    const w = await attack({ WebSocket: droppingWebSocket(() => drops++) });
    enableRecovery(w.gm, { reconnect: { initialMs: 10, maxMs: 50 } });
    const r0 = w.host.revision;
    const result = await invokeWithRetry(
      w.gm,
      { object: w.card, action: "Roll", base_revision: r0, txn_id: "rt-1" },
      { retry: { timeoutMs: 5000 } },
    );
    expect(drops).toBe(1);
    expect(result).toEqual({ status: "committed", revision: r0 + 1, index: 1, created: [] });
    // Executed once: one group, one die.
    expect(w.host.revision).toBe(r0 + 1);
    expect(w.dice.remaining()).toBe(1);
  });

  test("reports uncertain after a restart (a new session); the resend is never sent", async () => {
    let dropped = false;
    const w = await attack({ WebSocket: droppingWebSocket(() => (dropped = true)) });
    enableRecovery(w.gm, { reconnect: { initialMs: 10, maxMs: 50 } });
    const r0 = w.host.revision;
    const pending = invokeWithRetry(
      w.gm,
      { object: w.card, action: "Roll", base_revision: r0, txn_id: "rt-2" },
      { retry: { timeoutMs: 5000 } },
    );
    const outcome = failure(pending);
    await until(() => dropped, 3000, "the dropped response");
    const { port, token } = w.server;
    const oldSession = w.server.session;
    await w.server.close();
    const { server: restarted } = await serve({ host: w.host, port, token });
    expect(restarted.session).not.toBe(oldSession);
    expect(await outcome).toMatchObject({
      code: "uncertain",
      details: { txn_id: "rt-2", reason: "session_changed" },
    });
    // The first send committed once; nothing was resent.
    expect(w.host.revision).toBe(r0 + 1);
    expect(w.dice.remaining()).toBe(1);
  });
});
