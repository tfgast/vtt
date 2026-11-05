/**
 * Live action state in object views (vtt-1xv.12; PROTOCOL.md §7.2, §8, §9
 * `explain_action`; FORMULAS.md §7, §10; M5-D9, M5-D23; review r1 findings
 * 5, 6): `ObjectView.action_states`, one per action in the order of
 * `actions`, for every viewer, in subscribe results, deltas, `get_objects`,
 * `list_objects` and `zones` views, never in effects or snapshots. A real
 * server on port 0 with scripted dice; every mirror is checked against a
 * fresh subscribe.
 */
import {
  DocumentStore,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  TableHost,
} from "@vtt/authority";
import type {
  ActionStateView,
  InvokeResult,
  ProtocolClient,
  SubscribeParams,
  Subscription,
  SubscriptionDelta,
  TransactResult,
  WireOp,
} from "@vtt/protocol";
import { num, ref, type Snapshot, text } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
import { at, c, placed, snapshot, zone } from "../engine/helpers";
import { loadScenarioFile } from "../runner/load";
import { documentFromSetup } from "../runner/setup";
import { cleanup, connect, serve } from "../server/helpers";

afterEach(cleanup);

const ALDRIC = { type: "character", id: "aldric" } as const;

interface World {
  host: TableHost;
  gm: ProtocolClient;
}

async function world(doc: Snapshot, dice: readonly ScriptedDiceEntry[] = []): Promise<World> {
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(doc), {
    dice: new ScriptedDiceSource(dice),
  });
  const { server } = await serve({ host });
  const gm = await connect(server, { instance: "gm-1" });
  return { host, gm };
}

interface Watched {
  sub: Subscription;
  deltas: SubscriptionDelta[];
}

async function watch(w: World, params: SubscribeParams): Promise<Watched> {
  const sub = await w.gm.subscribe(params);
  const deltas: SubscriptionDelta[] = [];
  sub.on("delta", (_s, e) => deltas.push(e.delta));
  return { sub, deltas };
}

const byId = <T extends { id: string }>(xs: Iterable<T>) =>
  [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Every mirror equals a fresh subscribe with the same params at the same revision. */
async function fresh(w: World, ...subs: Watched[]): Promise<void> {
  for (const { sub } of subs) {
    const result = await w.gm.request("subscribe", sub.params);
    await w.gm.request("unsubscribe", { subscription: result.subscription });
    expect(sub.mirror.revision).toBe(result.revision);
    expect(byId(sub.mirror.objects.values())).toEqual(byId(result.objects));
    expect(byId([...sub.mirror.covers.values()].map((cv) => ({ ...cv, id: cv.key })))).toEqual(
      byId(result.covers.map((cv) => ({ ...cv, id: cv.key }))),
    );
  }
}

function committed(r: InvokeResult | TransactResult) {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Extract<TransactResult, { status: "committed" }>;
}

const write = async (w: World, ops: WireOp[]) =>
  committed(await w.gm.transact(ops, { base_revision: w.host.revision }));

// ---------------------------------------------------------------------------
// The Attack card (FORMULAS.md §10; attack-card.json)

const ATTACK = await loadScenarioFile("attack-card.json");
const ATTACK_DICE = ATTACK.dice as ScriptedDiceEntry[];

async function attack() {
  const w = await world(documentFromSetup(ATTACK.setup), ATTACK_DICE);
  const spawned = await write(w, [
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
  ]);
  const card = spawned.bindings.$card as string;
  const invoke = async (action: string) =>
    committed(await w.gm.invoke({ object: card, action, base_revision: w.host.revision }));
  return { ...w, card, invoke };
}

const on = (name: string): ActionStateView => ({ name, enabled: true });
const off = (name: string): ActionStateView => ({ name, enabled: false, reason: "when_false" });

describe("the Attack card's action_states", () => {
  test("match FORMULAS §10 before and after each action, for the GM and Aldric, in every live view", async () => {
    const w = await attack();
    const gm = await watch(w, { scope: { type: "board", board: "table" } });
    const aldric = await watch(w, { scope: { type: "board", board: "table" }, viewer: ALDRIC });
    const expectStates = async (states: ActionStateView[]) => {
      for (const s of [gm, aldric]) {
        expect(s.sub.mirror.objects.get(w.card)?.action_states).toEqual(states);
      }
      await fresh(w, gm, aldric);
      for (const viewer of [undefined, ALDRIC]) {
        const got = await w.gm.request("get_objects", { ids: [w.card], viewer });
        expect(got.objects[0]?.action_states).toEqual(states);
        const listed = await w.gm.request("list_objects", { filter: { tag: "attack" }, viewer });
        expect(listed.objects.find((o) => o.id === w.card)?.action_states).toEqual(states);
      }
    };

    await expectStates([on("Roll"), off("Roll damage"), off("Apply")]);
    await w.invoke("Roll");
    await expectStates([off("Roll"), on("Roll damage"), off("Apply")]);
    await w.invoke("Roll damage");
    await expectStates([off("Roll"), off("Roll damage"), on("Apply")]);
    await w.invoke("Apply");
    await expectStates([off("Roll"), off("Roll damage"), off("Apply")]);

    // `actions` stays the definitions: names only for Aldric, guards and steps for the GM.
    expect(aldric.sub.mirror.objects.get(w.card)?.actions).toEqual([
      { name: "Roll" },
      { name: "Roll damage" },
      { name: "Apply" },
    ]);
    expect(gm.sub.mirror.objects.get(w.card)?.actions[2]).toEqual({
      name: "Apply",
      when: "hit and dmg != empty and not applied",
      steps: ["add(target.damage_taken, dmg)", "set(applied, true)"],
    });
  });

  test("the template's state is computed too, and agrees with explain_action", async () => {
    const w = await attack();
    const got = await w.gm.request("get_objects", { ids: ["attack_card", w.card] });
    for (const view of got.objects) {
      expect(view.action_states.map((s) => s.name)).toEqual(view.actions.map((a) => a.name));
      for (const s of view.action_states) {
        const explained = await w.gm.request("explain_action", { object: view.id, action: s.name });
        expect({ enabled: explained.enabled, reason: explained.reason }).toEqual({
          enabled: s.enabled,
          reason: s.reason,
        });
      }
    }
    // The template has no target: every guard is false.
    expect(got.objects[0]?.action_states).toEqual([off("Roll"), off("Roll damage"), off("Apply")]);
  });
});

// ---------------------------------------------------------------------------
// Guards reading other objects

/**
 * `sword` targets `goblin` (`Strike` when `target.hp > 0`), has an action
 * with no guard and one whose guard is an error; `shrine` is a zone with an
 * action.
 */
function guarded(): Snapshot {
  return snapshot([
    placed("aldric", 0, -50, { is_character: true, cells: { name: c(text("Aldric")) } }),
    placed("goblin", 5, 0, { cells: { name: c(text("Goblin")), hp: c(num(3)) } }),
    placed("sword", 0, 0, {
      cells: { name: c(text("Sword")), target: c(ref("goblin")) },
      actions: [
        { name: "Strike", when: "target.hp > 0", steps: ["add(target.hp, -1)"] },
        { name: "Polish", steps: ['set(name, "Shiny")'] },
        { name: "Broken", when: "1 / 0 > 0", steps: ['set(name, "x")'] },
      ],
    }),
    zone("shrine", 20, 20, 4, {
      cells: { position: at(20, 20), name: c(text("Shrine")), charged: c(num(0)) },
      actions: [{ name: "Pray", when: "charged > 0", steps: ["set(charged, 0)"] }],
    }),
  ]);
}

describe("guards and deltas", () => {
  test("no guard is enabled without a reason; a guard error is when_error", async () => {
    const w = await world(guarded());
    const got = await w.gm.request("get_objects", { ids: ["sword"], viewer: ALDRIC });
    expect(got.objects[0]?.action_states).toEqual([
      on("Strike"),
      on("Polish"),
      { name: "Broken", enabled: false, reason: "when_error" },
    ]);
  });

  test("a guard reading another object's cell changes enabled in the delta of a commit that changes only that object", async () => {
    const w = await world(guarded());
    // Only the sword is in scope: the goblin's change reaches it through re-viewing guarded objects.
    const gm = await watch(w, { scope: { type: "objects", ids: ["sword"] } });
    const aldric = await watch(w, { scope: { type: "objects", ids: ["sword"] }, viewer: ALDRIC });
    expect(gm.sub.mirror.objects.get("sword")?.action_states?.[0]).toEqual(on("Strike"));

    await write(w, [
      { type: "set_value", object: "goblin", cell: "hp", value: { type: "number", value: 0 } },
    ]);
    for (const s of [gm, aldric]) {
      expect(s.deltas).toHaveLength(1);
      expect(s.deltas[0]?.objects.map((o) => o.id)).toEqual(["sword"]);
      expect(s.deltas[0]?.objects[0]?.action_states?.[0]).toEqual(off("Strike"));
    }
    await fresh(w, gm, aldric);

    // A commit that changes nothing a guard reads sends no view: only changed views are sent.
    await write(w, [
      { type: "set_value", object: "goblin", cell: "name", value: { type: "text", value: "Gob" } },
    ]);
    for (const s of [gm, aldric]) expect(s.deltas).toHaveLength(1);
    await fresh(w, gm, aldric);
  });

  test("zones views carry action_states", async () => {
    const w = await world(guarded());
    const zones = await w.gm.request("zones", { board: "table" });
    expect(zones.zones.find((z) => z.id === "shrine")?.view.action_states).toEqual([off("Pray")]);
    await write(w, [
      { type: "set_value", object: "shrine", cell: "charged", value: { type: "number", value: 1 } },
    ]);
    const again = await w.gm.request("zones", { board: "table", viewer: ALDRIC });
    expect(again.zones.find((z) => z.id === "shrine")?.view.action_states).toEqual([on("Pray")]);
  });
});

// ---------------------------------------------------------------------------
// Effects and snapshots

describe("effects and snapshots", () => {
  test("group views in the log window carry no action_states", async () => {
    const w = await attack();
    const log = await watch(w, { scope: { type: "log" } });
    const aldricLog = await watch(w, { scope: { type: "log" }, viewer: ALDRIC });
    await w.invoke("Roll");
    await write(w, [
      {
        type: "set_actions",
        object: w.card,
        actions: [{ name: "Roll", steps: ["roll(1d20) -> roll"] }],
      },
    ]);
    await write(w, [{ type: "remove", object: w.card }]);
    for (const s of [log, aldricLog]) {
      const groups = s.sub.mirror.groupsNewestFirst();
      expect(groups.length).toBeGreaterThan(0);
      const effects = groups.flatMap((g) => g.effects ?? []);
      expect(effects.some((e) => e.type === "create" || e.type === "remove")).toBe(true);
      expect(JSON.stringify(groups)).not.toContain("action_states");
    }
    // The GM log holds the spawn snapshot and the actions effect, still without live state.
    const gmEffects = log.sub.mirror.groupsNewestFirst().flatMap((g) => g.effects ?? []);
    expect(gmEffects.some((e) => e.type === "field" && e.field === "actions")).toBe(true);
    const changes = await w.gm.request("changes_since", { revision: 0 });
    expect(JSON.stringify(changes)).not.toContain("action_states");
  });
});
