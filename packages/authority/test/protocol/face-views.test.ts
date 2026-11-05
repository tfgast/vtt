/**
 * Live faces in object views (vtt-1xv.12; DESIGN.md §4.4, §4.6; PROTOCOL.md
 * §7.2, §8; FORMULAS.md §7, §10; M5-D8, M5-D9, M5-D23; review r1 findings
 * 6, 7; review r3 finding 6): `ObjectView.face` with each element's stored
 * `index` and `shown`. GM views keep every element with its `show_when` and
 * a `reason` when hidden; character views keep only shown elements whose
 * cell they can read, without `show_when`. A real server on port 0 with
 * scripted dice; every mirror is checked against a fresh subscribe.
 */
import {
  DocumentStore,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  TableHost,
} from "@vtt/authority";
import type {
  FaceElementView,
  FaceView,
  InvokeResult,
  ProtocolClient,
  SubscribeParams,
  Subscription,
  SubscriptionDelta,
  TransactResult,
  WireOp,
} from "@vtt/protocol";
import type { FaceElement, FaceLayout, Snapshot } from "@vtt/schema";
import { afterEach, describe, expect, test } from "vitest";
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

/** The stored element with its index and live state (the GM's lossless reading). */
const live = (e: FaceElement, index: number, state: Partial<FaceElementView> = {}) =>
  ({ ...e, index, shown: true, ...state }) as FaceElementView;

// ---------------------------------------------------------------------------
// The Attack card (DESIGN.md §4.6 face; FORMULAS.md §10)

const ATTACK = await loadScenarioFile("attack-card.json");
const ATTACK_DICE = ATTACK.dice as ScriptedDiceEntry[];

/** The Attack card face of DESIGN.md §4.6, verbatim. Buttons: 5 Roll, 6 Roll damage, 7 Apply. */
const ATTACK_FACE: FaceLayout = {
  elements: [
    { type: "value", cell: "name", rect: [-1.2, -1.7, 2.4, 0.4], style: { size: "large" } },
    { type: "editor", cell: "target", rect: [-1.2, -1.2, 2.4, 0.4], style: { caption: true } },
    { type: "value", cell: "total", rect: [-1.2, -0.7, 1.1, 0.5], style: { caption: true } },
    { type: "value", cell: "hit", rect: [0.1, -0.7, 1.1, 0.5], style: { caption: true } },
    { type: "value", cell: "dmg", rect: [-1.2, -0.1, 2.4, 0.4], style: { caption: true } },
    { type: "button", action: "Roll", rect: [-1.2, 0.5, 1.1, 0.45], show_when: "roll = empty" },
    {
      type: "button",
      action: "Roll damage",
      rect: [0.1, 0.5, 1.1, 0.45],
      show_when: "hit and dmg = empty",
    },
    { type: "button", action: "Apply", rect: [-1.2, 1.1, 2.4, 0.45], show_when: "not applied" },
  ],
  default_action: "Roll",
};

const element = (i: number) => ATTACK_FACE.elements[i] as FaceElement;

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
    { type: "set_face", object: "$card", face: ATTACK_FACE },
  ]);
  const card = spawned.bindings.$card as string;
  const invoke = async (action: string) =>
    committed(await w.gm.invoke({ object: card, action, base_revision: w.host.revision }));
  return { ...w, card, invoke };
}

const hidden = { shown: false, reason: "show_when_false" } as const;

/** The GM's face with buttons 5–7 shown or hidden. */
function gmAttackFace(roll: boolean, damage: boolean, apply: boolean): FaceView {
  return {
    elements: [
      ...[0, 1, 2, 3, 4].map((i) => live(element(i), i)),
      live(element(5), 5, roll ? {} : hidden),
      live(element(6), 6, damage ? {} : hidden),
      live(element(7), 7, apply ? {} : hidden),
    ],
    default_action: "Roll",
  };
}

/** Aldric's face: the shown elements only, without show_when. */
function aldricAttackFace(roll: boolean, damage: boolean, apply: boolean): FaceView {
  const shown = [0, 1, 2, 3, 4];
  if (roll) shown.push(5);
  if (damage) shown.push(6);
  if (apply) shown.push(7);
  return {
    elements: shown.map((i) => {
      const { show_when: _, ...rest } = element(i);
      return live(rest as FaceElement, i);
    }),
    default_action: "Roll",
  };
}

describe("the Attack card's face", () => {
  test("buttons and action states follow FORMULAS §10 before and after each action", async () => {
    const w = await attack();
    const gm = await watch(w, { scope: { type: "board", board: "table" } });
    const aldric = await watch(w, { scope: { type: "board", board: "table" }, viewer: ALDRIC });
    const check = async (roll: boolean, damage: boolean, apply: boolean, applyEnabled: boolean) => {
      expect(gm.sub.mirror.objects.get(w.card)?.face).toEqual(gmAttackFace(roll, damage, apply));
      expect(aldric.sub.mirror.objects.get(w.card)?.face).toEqual(
        aldricAttackFace(roll, damage, apply),
      );
      for (const s of [gm, aldric]) {
        expect(s.sub.mirror.objects.get(w.card)?.action_states?.[2]?.enabled).toBe(applyEnabled);
      }
      expect(JSON.stringify(aldric.sub.mirror.objects.get(w.card))).not.toContain("show_when");
      await fresh(w, gm, aldric);
    };

    // Apply is shown and disabled before the rolls.
    await check(true, false, true, false);
    await w.invoke("Roll");
    await check(false, true, true, false);
    // Enabled after Roll damage.
    await w.invoke("Roll damage");
    await check(false, false, true, true);
    // Hidden after Apply: shown false for the GM, absent for Aldric.
    await w.invoke("Apply");
    await check(false, false, false, false);
    const gmApply = gm.sub.mirror.objects.get(w.card)?.face?.elements[7];
    expect(gmApply).toMatchObject({ index: 7, shown: false, show_when: "not applied" });
    const aldricFace = aldric.sub.mirror.objects.get(w.card)?.face;
    expect(aldricFace?.elements.some((e) => e.index === 7)).toBe(false);
    expect(aldricFace?.elements.every((e) => e.shown)).toBe(true);
  });

  test("a cells: structural subscription and a named-cells get_objects carry no face", async () => {
    const w = await attack();
    const structural = await watch(w, {
      scope: { type: "board", board: "table" },
      cells: "structural",
    });
    const view = structural.sub.mirror.objects.get(w.card);
    expect(view).toBeDefined();
    expect(view !== undefined && "face" in view).toBe(false);
    expect(view?.action_states).toHaveLength(3);
    await w.invoke("Roll");
    expect("face" in (structural.sub.mirror.objects.get(w.card) ?? {})).toBe(false);
    await fresh(w, structural);
    const named = await w.gm.request("get_objects", { ids: [w.card], cells: ["name"] });
    expect("face" in (named.objects[0] ?? {})).toBe(false);
    const all = await w.gm.request("get_objects", { ids: [w.card] });
    expect(all.objects[0]?.face?.elements).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// The goblin: GM-only cells, show-when errors

describe("character filtering", () => {
  test("a value element on the goblin's GM-only ac is absent from Aldric's face; the next keeps its index", async () => {
    const w = await world(documentFromSetup(ATTACK.setup));
    const gm = await watch(w, { scope: { type: "board", board: "table" } });
    const aldric = await watch(w, { scope: { type: "board", board: "table" }, viewer: ALDRIC });
    const face: FaceLayout = {
      elements: [
        { type: "value", cell: "name", rect: [-0.5, -0.5, 1, 0.3] },
        { type: "value", cell: "ac", rect: [-0.5, -0.2, 1, 0.3], style: { caption: true } },
        { type: "value", cell: "damage_taken", rect: [-0.5, 0.1, 1, 0.3] },
      ],
      collapsed: [
        { type: "value", cell: "ac", rect: [0, 0, 3, 0.6] },
        { type: "value", cell: "name", rect: [3, 0, 3, 0.6] },
      ],
    };
    await write(w, [{ type: "set_face", object: "goblin1", face }]);
    expect(aldric.sub.mirror.objects.get("goblin1")?.face).toEqual({
      elements: [
        live(face.elements[0] as FaceElement, 0),
        live(face.elements[2] as FaceElement, 2),
      ],
      collapsed: [live((face.collapsed ?? [])[1] as FaceElement, 1)],
    });
    expect(gm.sub.mirror.objects.get("goblin1")?.face).toEqual({
      elements: face.elements.map((e, i) => live(e, i)),
      collapsed: (face.collapsed ?? []).map((e, i) => live(e, i)),
    });
    await fresh(w, gm, aldric);
  });

  test("a show_when error hides the element; the GM view has its code", async () => {
    const w = await world(documentFromSetup(ATTACK.setup));
    const gm = await watch(w, { scope: { type: "board", board: "table" } });
    const aldric = await watch(w, { scope: { type: "board", board: "table" }, viewer: ALDRIC });
    const broken: FaceElement = {
      type: "value",
      cell: "damage_taken",
      rect: [0, 0, 1, 1],
      show_when: "damage_taken / 0 > 1",
    };
    await write(w, [{ type: "set_face", object: "goblin1", face: { elements: [broken] } }]);
    expect(gm.sub.mirror.objects.get("goblin1")?.face?.elements).toEqual([
      live(broken, 0, { shown: false, reason: "show_when_error", error: "#DIV0" }),
    ]);
    expect(aldric.sub.mirror.objects.get("goblin1")?.face).toEqual({ elements: [] });
    await fresh(w, gm, aldric);
  });

  test("a button naming no action is shown false (no_action) for the GM, absent for Aldric; so is a default_action naming none", async () => {
    const w = await world(documentFromSetup(ATTACK.setup));
    const gm = await watch(w, { scope: { type: "board", board: "table" } });
    const aldric = await watch(w, { scope: { type: "board", board: "table" }, viewer: ALDRIC });
    const button: FaceElement = { type: "button", action: "Bite", rect: [0, 0, 1, 1] };
    await write(w, [
      { type: "set_face", object: "goblin1", face: { elements: [button], default_action: "Bite" } },
    ]);
    expect(gm.sub.mirror.objects.get("goblin1")?.face).toEqual({
      elements: [live(button, 0, { shown: false, reason: "no_action" })],
      default_action: "Bite",
    });
    expect(aldric.sub.mirror.objects.get("goblin1")?.face).toEqual({ elements: [] });
    // Adding the action shows the button (an actions change re-views the object).
    await write(w, [
      {
        type: "set_actions",
        object: "goblin1",
        actions: [{ name: "Bite", steps: ["set(ac, 1)"] }],
      },
    ]);
    expect(aldric.sub.mirror.objects.get("goblin1")?.face).toEqual({
      elements: [live(button, 0)],
      default_action: "Bite",
    });
    await fresh(w, gm, aldric);
  });
});

// ---------------------------------------------------------------------------
// Face invalidation (Q10; review r1 finding 6)

describe("an unconditional face (no show_when, no guards)", () => {
  test("adding, changing, removing and undoing it each produce the delta that makes the mirror equal a fresh subscribe", async () => {
    const w = await world(documentFromSetup(ATTACK.setup));
    const subs = [
      await watch(w, { scope: { type: "board", board: "table" } }),
      await watch(w, { scope: { type: "board", board: "table" }, viewer: ALDRIC }),
      await watch(w, { scope: { type: "objects", ids: ["goblin1"] }, viewer: ALDRIC }),
      await watch(w, { scope: { type: "all" } }),
    ];
    const first: FaceLayout = { elements: [{ type: "value", cell: "name", rect: [0, 0, 1, 1] }] };
    const second: FaceLayout = {
      elements: [
        { type: "value", cell: "name", rect: [0, 0, 2, 1], style: { size: "huge" } },
        { type: "editor", cell: "damage_taken", rect: [0, 1, 2, 1] },
      ],
    };
    const step = async (op: () => Promise<unknown>, expected: FaceLayout | null) => {
      const counts = subs.map((s) => s.deltas.length);
      await op();
      for (const [i, s] of subs.entries()) {
        expect(s.deltas.length).toBe((counts[i] ?? 0) + 1);
        const view = s.deltas.at(-1)?.objects.find((o) => o.id === "goblin1");
        expect(view).toBeDefined();
        if (expected === null) expect(view !== undefined && "face" in view).toBe(false);
        else
          expect(view?.face?.elements.map((e) => e.index)).toEqual(
            expected.elements.map((_, k) => k),
          );
      }
      await fresh(w, ...subs);
    };
    await step(() => write(w, [{ type: "set_face", object: "goblin1", face: first }]), first);
    await step(() => write(w, [{ type: "set_face", object: "goblin1", face: second }]), second);
    await step(() => write(w, [{ type: "set_face", object: "goblin1", face: null }]), null);
    await step(async () => {
      committed(await w.gm.request("undo", { target: { type: "latest" } }));
    }, second);
  });
});
