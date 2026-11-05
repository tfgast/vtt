// @vitest-environment node
/**
 * The single UI invocation path and the `invoke` runtime extension
 * (vtt-1xv.16; DESIGN.md §4.5 Pressing buttons in the UI, §7 Undo;
 * docs/PROTOCOL.md §4 `invoke`, §6 `uncertain`; M5 plan Q1, Q2, Q12, Q13,
 * review r2 finding 4). `requestInvoke` is pure; `invokeExtension` runs over
 * a stub session whose client answers `invoke` as told.
 */
import type {
  ActionStateView,
  InvokeParams,
  InvokeResult,
  ObjectView,
  ProtocolClient,
  Viewer,
} from "@vtt/protocol";
import { ProtocolFailure } from "@vtt/protocol";
import {
  createNoticeStore,
  defaultFacePolicy,
  type Effect,
  type ExtensionContext,
  type ExtensionEffect,
  type FacePolicy,
  INVOKE_EXTENSION,
  type InteractionStamp,
  type InvokeOutcome,
  type InvokePayload,
  invokeExtension,
  type NoticeStore,
  requestInvoke,
  TEMPLATE_REFUSAL,
  type TableSession,
} from "@vtt/ui";
import { describe, expect, test, vi } from "vitest";

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const CAMERA = { x: 3.5, y: -2, zoom: 1 };
const APPLY_WHEN = "hit and dmg != empty and not applied";

function stampOf(viewer: Viewer = GM, baseRevision = 4): InteractionStamp {
  return { interactionId: "i9", board: "map", viewer, baseRevision };
}

function card(opts: { template?: boolean; states?: ActionStateView[]; gm?: boolean } = {}) {
  const view: ObjectView = {
    id: "card",
    is_template: opts.template ?? false,
    is_character: false,
    cells: { name: { value: { type: "text", value: "Attack" }, kind: "literal" } },
    actions:
      opts.gm === false
        ? [{ name: "Roll" }, { name: "Apply" }]
        : [{ name: "Roll" }, { name: "Apply", when: APPLY_WHEN, steps: ["set(applied, true)"] }],
  };
  const states = opts.states ?? [
    { name: "Roll", enabled: true },
    { name: "Apply", enabled: false, reason: "when_false" },
  ];
  view.action_states = states;
  return view;
}

describe("requestInvoke", () => {
  test("an enabled action → one invoke extension effect with the stamp, table and no actor (GM)", () => {
    const stamp = stampOf();
    const effects = requestInvoke(defaultFacePolicy, card(), "Roll", stamp, { camera: CAMERA });
    expect(effects).toEqual<Effect[]>([
      {
        type: "extension",
        name: INVOKE_EXTENSION,
        stamp,
        payload: {
          object: "card",
          action: "Roll",
          table: { board: "map", position: [3.5, -2] },
        } satisfies InvokePayload,
      },
    ]);
  });

  test("in view-as the actor is the viewed character (Q12)", () => {
    const stamp = stampOf(ALDRIC);
    const [effect] = requestInvoke(defaultFacePolicy, card({ gm: false }), "Roll", stamp, {
      camera: CAMERA,
    });
    expect(effect).toMatchObject({
      type: "extension",
      payload: { actor: { type: "character", id: "aldric" } },
    });
  });

  test("a template refuses with one notice and nothing else (Q13)", () => {
    const effects = requestInvoke(defaultFacePolicy, card({ template: true }), "Roll", stampOf(), {
      camera: CAMERA,
    });
    expect(effects).toEqual([{ type: "notice", level: "info", text: TEMPLATE_REFUSAL }]);
    expect(TEMPLATE_REFUSAL).toBe("Templates are not played: drag out a copy.");
  });

  test("the policy's own refusal reason is the notice", () => {
    const policy: FacePolicy = { canInvoke: () => ({ ok: false, reason: "Not now." }) };
    expect(requestInvoke(policy, card(), "Roll", stampOf(), { camera: CAMERA })).toEqual([
      { type: "notice", level: "info", text: "Not now." },
    ]);
  });

  test("a disabled action shows its reason and sends nothing; the GM also sees the guard", () => {
    expect(requestInvoke(defaultFacePolicy, card(), "Apply", stampOf(), { camera: CAMERA })).toEqual(
      [{ type: "notice", level: "info", text: `Apply: its condition is false (when: ${APPLY_WHEN}).` }],
    );
    expect(
      requestInvoke(defaultFacePolicy, card({ gm: false }), "Apply", stampOf(ALDRIC), {
        camera: CAMERA,
      }),
    ).toEqual([{ type: "notice", level: "info", text: "Apply: its condition is false." }]);
  });

  test("a guard error and an action without a state are refused too", () => {
    const states: ActionStateView[] = [{ name: "Roll", enabled: false, reason: "when_error" }];
    expect(
      requestInvoke(defaultFacePolicy, card({ states, gm: false }), "Roll", stampOf(), {
        camera: CAMERA,
      }),
    ).toEqual([{ type: "notice", level: "info", text: "Roll: its condition is an error." }]);
    const bare = card({ gm: false });
    delete bare.action_states;
    expect(requestInvoke(defaultFacePolicy, bare, "Roll", stampOf(), { camera: CAMERA })).toEqual([
      { type: "notice", level: "info", text: "Roll is not available." },
    ]);
  });

  test("the template check comes before the action state", () => {
    const effects = requestInvoke(defaultFacePolicy, card({ template: true }), "Apply", stampOf(), {
      camera: CAMERA,
    });
    expect(effects).toEqual([{ type: "notice", level: "info", text: TEMPLATE_REFUSAL }]);
  });
});

describe("defaultFacePolicy", () => {
  test("refuses templates and allows everything else", () => {
    expect(defaultFacePolicy.canInvoke(card({ template: true }))).toEqual({
      ok: false,
      reason: TEMPLATE_REFUSAL,
    });
    expect(defaultFacePolicy.canInvoke(card())).toEqual({ ok: true });
    expect(defaultFacePolicy.onButton).toBeUndefined();
    expect(defaultFacePolicy.onToggle).toBeUndefined();
    expect(defaultFacePolicy.onGear).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// invokeExtension

type Answer = InvokeResult | ProtocolFailure;

function stubSession(answers: Answer[], viewer: Viewer = GM) {
  const sent: InvokeParams[] = [];
  const request = vi.fn(async (method: string, params: InvokeParams) => {
    if (method !== "invoke") throw new Error(`unexpected ${method}`);
    sent.push(structuredClone(params));
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no answer left");
    if (answer instanceof ProtocolFailure) throw answer;
    return answer;
  });
  const client = { session: "s-1", revision: 9, request } as unknown as ProtocolClient;
  const view = card();
  const session = {
    client,
    getSnapshot: () => ({ viewer }),
    objectView: (id: string) => (id === "card" ? view : null),
    refLabel: (_viewer: Viewer, id: string) => (id === "card" ? "Attack" : id),
  } as unknown as TableSession;
  return { session, sent, request };
}

function effectOf(payload: InvokePayload, viewer: Viewer = GM): ExtensionEffect {
  return { type: "extension", name: INVOKE_EXTENSION, stamp: stampOf(viewer, 4), payload };
}

const PAYLOAD: InvokePayload = {
  object: "card",
  action: "Apply",
  table: { board: "map", position: [3.5, -2] },
};

async function run(
  answers: Answer[],
  payload: InvokePayload = PAYLOAD,
  viewer: Viewer = GM,
): Promise<{
  outcome: InvokeOutcome;
  notices: NoticeStore;
  sent: InvokeParams[];
  request: ReturnType<typeof vi.fn>;
}> {
  const { session, sent, request } = stubSession(answers, viewer);
  const notices = createNoticeStore();
  const handler = invokeExtension(session, notices);
  const outcome = (await handler(
    effectOf(payload, viewer),
    {} as ExtensionContext,
  )) as InvokeOutcome;
  return { outcome, notices, sent, request };
}

describe("invokeExtension", () => {
  test("committed: one invoke with the stamp's base revision, table, actor and a txn_id; no notice", async () => {
    const result: InvokeResult = { status: "committed", revision: 10, index: 9, created: [] };
    const payload: InvokePayload = { ...PAYLOAD, actor: { type: "character", id: "aldric" } };
    const { outcome, notices, sent } = await run([result], payload, ALDRIC);
    expect(outcome).toEqual(result);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      object: "card",
      action: "Apply",
      base_revision: 4,
      table: { board: "map", position: [3.5, -2] },
      actor: { type: "character", id: "aldric" },
    });
    expect(typeof sent[0]?.txn_id).toBe("string");
    expect(sent[0]?.retry).toBeUndefined();
    expect(notices.list()).toEqual([]);
  });

  test("when_false: a notice naming the action; the GM also sees its when source", async () => {
    const rejected: InvokeResult = {
      status: "rejected",
      rejection: { type: "when_false", object: "card", action: "Apply" },
    };
    const gm = await run([rejected]);
    expect(gm.outcome).toEqual(rejected);
    expect(gm.notices.list()).toMatchObject([
      { level: "error", text: `Apply: its condition is false (when: ${APPLY_WHEN}).` },
    ]);
    const aldric = await run([rejected], { ...PAYLOAD, actor: { type: "character", id: "aldric" } }, ALDRIC);
    expect(aldric.notices.list()).toMatchObject([
      { level: "error", text: "Apply: its condition is false." },
    ]);
  });

  test("stale_write: a sticky stale notice, never retried", async () => {
    const rejected: InvokeResult = {
      status: "rejected",
      rejection: {
        type: "stale_write",
        base_revision: 4,
        revision: 6,
        floor: 0,
        truncated: false,
        conflicts: [
          { index: 5, revision: 6, actor: { type: "gm" }, label: "Apply", keys: ["obj:card"] },
        ],
      },
    };
    const { notices, request } = await run([rejected]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(notices.list()).toMatchObject([
      {
        level: "warning",
        kind: "stale",
        text: 'Not applied: the table changed first ("Apply" by the GM).',
      },
    ]);
  });

  test("uncertain: the sticky uncertain notice; the client is asked once", async () => {
    const lost = new ProtocolFailure("uncertain", "no response in time", { reason: "timeout" });
    const { outcome, notices, request } = await run([lost]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "uncertain" });
    expect(notices.list()).toMatchObject([
      { level: "warning", kind: "uncertain", text: "Apply may or may not have been applied." },
    ]);
  });

  test("another protocol error: an error notice and a failed outcome", async () => {
    const failure = new ProtocolFailure("disconnected", "not connected");
    const { outcome, notices } = await run([failure]);
    expect(outcome).toMatchObject({ status: "failed", error: { code: "disconnected" } });
    expect(notices.list()).toMatchObject([
      { level: "error", text: '"Apply" was not applied. Not connected to the table (not connected).' },
    ]);
  });
});
