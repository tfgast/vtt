/**
 * Action editing and Run in the inspector (vtt-1xv.19; DESIGN.md §4.5, §4.6
 * The inspector and View as in the UI; FORMULAS.md §8.4; PROTOCOL.md §5
 * `set_actions`, §6 stale writes; M5 plan Q3, Q13) against a real
 * in-process authority with scripted dice: the real session, `UiStore`,
 * tool context and interaction runtime with the `invoke` extension, and
 * `ActionsList` over the session's view of one object.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DocumentStore,
  newTableSnapshot,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  startServer,
  TableHost,
} from "@vtt/authority";
import { type InvokeParams, ProtocolClient, type WireOp } from "@vtt/protocol";
import type { ActionDef, ObjectId, OpGroup } from "@vtt/schema";
import {
  ActionsList,
  createInPlaceEditorPort,
  createInteractionRuntime,
  createRuntimeInputs,
  createSelectTool,
  createTableSession,
  createToolContext,
  createUiStore,
  INVOKE_EXTENSION,
  type InteractionRuntime,
  invokeExtension,
  sessionNotices,
  TableProvider,
  type TableSession,
  TEMPLATE_REFUSAL,
  ToolRegistry,
  useSession,
} from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JSDOM_ORIGIN, NodeWebSocket, until, whenReady } from "../support/authority";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

// ---------------------------------------------------------------------------
// The table: Aldric, a goblin, the Attack card template and a copy aimed at the goblin

const BOARD = "gm_board";
const text = (value: string) => ({ type: "text" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const bool = (value: boolean) => ({ type: "boolean" as const, value });
const ref = (object: string) => ({ type: "ref" as const, object });
const formula = (source: string) => ({ type: "formula" as const, source });
const EMPTY = { type: "empty" as const };
const ALL = { type: "viewers" as const, viewers: ["all" as const] };
const at = (x: number, y: number) => ({
  type: "board" as const,
  board: BOARD,
  position: [x, y] as [number, number],
});

const APPLY_WHEN = "hit and dmg != empty and not applied";
const ROLL: ActionDef = {
  name: "Roll",
  when: "target != empty and roll = empty",
  steps: ["roll(1d20) -> roll"],
};
const ROLL_DAMAGE: ActionDef = {
  name: "Roll damage",
  when: "hit and dmg = empty",
  steps: ["roll(attacker.damage_dice) -> dmg"],
};
const APPLY: ActionDef = {
  name: "Apply",
  when: APPLY_WHEN,
  steps: ["add(target.damage_taken, dmg)", "set(applied, true)"],
};

const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "aldric",
    to: at(-5, 3),
    init: {
      is_character: true,
      shape: { type: "circle", radius: 0.5 },
      cells: {
        name: text("Aldric"),
        visible_to: ALL,
        attack_bonus: num(5),
        damage_dice: { type: "dice", expr: "1d8+3" },
      },
    },
  },
  {
    type: "create_object",
    id: "goblin1",
    to: at(5, 3),
    init: {
      shape: { type: "circle", radius: 0.5 },
      cells: { name: text("Goblin"), visible_to: ALL, ac: num(13), damage_taken: num(0) },
    },
  },
  {
    type: "create_object",
    id: "attack_card",
    to: at(-30, 30),
    init: {
      is_template: true,
      tag: ["card", "attack"],
      shape: { type: "rect", width: 2, height: 3 },
      cells: {
        name: text("Attack"),
        visible_to: ALL,
        face_up: bool(true),
        attacker: EMPTY,
        target: EMPTY,
        roll: EMPTY,
        dmg: EMPTY,
        applied: bool(false),
        bonus: formula("attacker.attack_bonus"),
        total: formula("roll + bonus"),
        hit: formula("roll != empty and total >= target.ac"),
      },
      actions: [ROLL, ROLL_DAMAGE, APPLY],
    },
  },
];

const roll = (expr: string, value: number): ScriptedDiceEntry => ({
  type: "roll",
  expr,
  dice: [value],
  dropped: [],
  total: value,
});

/** The view of `object`, re-rendered on every view change, as the inspector shows it. */
function Harness(props: { session: TableSession; object: ObjectId; runtime: InteractionRuntime }) {
  const { session, object, runtime } = props;
  useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  const view = session.objectView(object);
  if (view === null) return <p>not in view</p>;
  return <ActionsList view={view} gm={viewer.type === "gm"} runtime={runtime} />;
}

async function world(options: { dice?: ScriptedDiceEntry[]; object?: "card" | "template" } = {}) {
  const dice = new ScriptedDiceSource(options.dice ?? []);
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(newTableSnapshot()), { dice });
  const server = await startServer({ host, port: 0, allowOrigins: [JSDOM_ORIGIN] });
  cleanups.push(async () => {
    await server.close();
    await host.close().catch(() => undefined);
  });
  const client = async (name: string) => {
    const c = new ProtocolClient({
      url: server.url,
      token: server.token,
      client: { name, kind: "test" },
      WebSocket: NodeWebSocket,
      onWarning: () => undefined,
    });
    cleanups.push(() => c.close());
    await c.connect();
    return c;
  };
  const gm = await client("seed");
  const seeded = await gm.transact(SEED, { label: "Seed" });
  if (seeded.status !== "committed") throw new Error(JSON.stringify(seeded));
  const spawned = await gm.transact(
    [
      {
        type: "spawn",
        template: "attack_card",
        to: at(0, 0),
        cells: { attacker: ref("aldric"), target: ref("goblin1") },
        as: "$card",
      },
    ],
    { label: "Spawn" },
  );
  if (spawned.status !== "committed") throw new Error(JSON.stringify(spawned));
  const card = spawned.bindings.$card as ObjectId;
  const object = options.object === "template" ? "attack_card" : card;

  const session = createTableSession({
    url: server.url,
    token: server.token,
    WebSocket: NodeWebSocket,
  });
  cleanups.push(() => session.close());
  await whenReady(session);
  await until(() => session.objectView(object) !== null, "the object's view");

  const ui = createUiStore({ session });
  const registry = new ToolRegistry();
  registry.register(createSelectTool());
  const runtime = createInteractionRuntime({
    registry,
    inputs: createRuntimeInputs(session, ui),
    toolContext: createToolContext(session, ui, {
      pickFile: async () => null,
      upload: async () => ({ path: "x.png", width: 1, height: 1 }),
    }),
    ui,
    editor: createInPlaceEditorPort(ui),
    whenRevision: (r) => session.whenRevision(r),
    extensions: {
      effects: { [INVOKE_EXTENSION]: invokeExtension(session, sessionNotices(session)) },
    },
  });
  cleanups.push(() => runtime.dispose());

  render(
    <TableProvider session={session} ui={ui}>
      <Harness session={session} object={object} runtime={runtime} />
    </TableProvider>,
  );
  const request = vi.spyOn(session.client, "request");
  const calls = (method: string) =>
    request.mock.calls.filter(([m]) => m === method).map(([, p]) => p);
  const transacts = () =>
    calls("transact") as { ops: WireOp[]; base_revision?: number; label?: string }[];
  const invokes = () => calls("invoke") as InvokeParams[];
  const groups = (): readonly OpGroup[] => host.table.store.history.groups() as readonly OpGroup[];
  const stored = () => host.table.store.getObject(object)?.actions;
  const notices = () => sessionNotices(session).list();
  return {
    host,
    gm,
    client,
    session,
    ui,
    card,
    object,
    transacts,
    invokes,
    groups,
    stored,
    notices,
  };
}

const section = () => screen.getByRole("region", { name: "Actions" });
const item = (name: string) =>
  section().querySelector(`li[data-action="${CSS.escape(name)}"]`) as HTMLElement;

// ---------------------------------------------------------------------------

describe("editing as the GM", () => {
  test("each action shows its name, state, when and steps", async () => {
    await world();
    const roll = item("Roll");
    expect(within(roll).getByText("Roll")).toBeDefined();
    expect(within(roll).getByText("enabled")).toBeDefined();
    expect(within(roll).getByText(ROLL.when as string)).toBeDefined();
    expect(within(roll).getByText("roll(1d20) -> roll")).toBeDefined();
    expect(within(item("Apply")).getByText("disabled: its condition is false")).toBeDefined();
    expect(within(item("Apply")).getByText("set(applied, true)")).toBeDefined();
  });

  test("a stored step that does not parse is marked with the parser's message", async () => {
    const w = await world();
    const bad: ActionDef = { name: "Broken", steps: ["roll(1d20)"] };
    const result = await w.gm.transact(
      [{ type: "set_actions", object: w.object, actions: [ROLL, ROLL_DAMAGE, APPLY, bad] }],
      { label: "Break" },
    );
    expect(result.status).toBe("committed");
    await waitFor(() => expect(item("Broken")).not.toBeNull());
    expect(within(item("Broken")).getByText("roll(1d20)")).toBeDefined();
    expect(within(item("Broken")).getByText(/->/)).toBeDefined();
  });

  test("adding an action with an invalid step shows the parse message and sends nothing; fixing it saves one group", async () => {
    const w = await world();
    const user = userEvent.setup();
    const before = w.groups().length;
    await user.click(within(section()).getByRole("button", { name: "Add action" }));
    const editor = within(section()).getByRole("group", { name: "New action" });
    const name = within(editor).getByRole("textbox", { name: "Action name" });
    await user.clear(name);
    await user.type(name, "Reroll");
    const step = within(editor).getByRole("textbox", { name: "Step 1" });
    await user.type(step, "roll(1d20)");
    expect(step.getAttribute("aria-invalid")).toBe("true");
    const alert = within(editor).getByRole("alert");
    expect(alert.textContent).toMatch(/->/);
    // The caret sits under the offset of the problem.
    const caret = alert.querySelector("pre");
    expect(caret?.textContent).toMatch(/^roll\(1d20\)\n {2,}\^$/);
    const save = within(editor).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    fireEvent.click(save);
    expect(w.transacts()).toEqual([]);

    await user.type(step, " -> roll");
    expect(step.getAttribute("aria-invalid")).toBe("false");
    expect(within(editor).queryByRole("alert")).toBeNull();
    await user.click(save);
    await waitFor(() => expect(w.groups().length).toBe(before + 1));
    expect(w.transacts()).toHaveLength(1);
    const sent = w.transacts()[0];
    expect(sent?.ops).toEqual([
      {
        type: "set_actions",
        object: w.object,
        actions: [ROLL, ROLL_DAMAGE, APPLY, { name: "Reroll", steps: ["roll(1d20) -> roll"] }],
      },
    ]);
    expect(w.stored()?.map((a) => a.name)).toEqual(["Roll", "Roll damage", "Apply", "Reroll"]);
    await waitFor(() => expect(item("Reroll")).not.toBeNull());
    expect(within(section()).queryByRole("group")).toBeNull();
  });

  test("a when that does not parse blocks Save; an empty when saves no precondition", async () => {
    const w = await world();
    const user = userEvent.setup();
    await user.click(within(item("Roll")).getByRole("button", { name: "Edit Roll" }));
    const editor = within(section()).getByRole("group", { name: "Edit Roll" });
    const when = within(editor).getByRole("textbox", { name: "Condition (when)" });
    await user.clear(when);
    await user.type(when, "target !=");
    expect(within(editor).getByRole("alert")).toBeDefined();
    const save = within(editor).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.clear(when);
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(w.stored()?.[0]).toEqual({ name: "Roll", steps: ROLL.steps }));
    expect(w.transacts()).toHaveLength(1);
  });

  test("Save with nothing changed sends nothing and closes; Cancel and Escape send nothing", async () => {
    const w = await world();
    const user = userEvent.setup();
    await user.click(within(item("Roll")).getByRole("button", { name: "Edit Roll" }));
    await user.click(within(section()).getByRole("button", { name: "Save" }));
    expect(within(section()).queryByRole("group")).toBeNull();
    await user.click(within(item("Roll")).getByRole("button", { name: "Edit Roll" }));
    await user.type(within(section()).getByRole("textbox", { name: "Step 1" }), "x");
    await user.click(within(section()).getByRole("button", { name: "Cancel" }));
    await user.click(within(item("Roll")).getByRole("button", { name: "Edit Roll" }));
    await user.type(within(section()).getByRole("textbox", { name: "Step 1" }), "x{Escape}");
    expect(within(section()).queryByRole("group")).toBeNull();
    expect(w.transacts()).toEqual([]);
  });

  test("steps are added, reordered and removed in the editor; Save writes them in order", async () => {
    const w = await world();
    const user = userEvent.setup();
    await user.click(within(item("Apply")).getByRole("button", { name: "Edit Apply" }));
    const editor = within(section()).getByRole("group", { name: "Edit Apply" });
    await user.click(within(editor).getByRole("button", { name: "Add step" }));
    await user.type(within(editor).getByRole("textbox", { name: "Step 3" }), "set(dmg, empty)");
    await user.click(within(editor).getByRole("button", { name: "Move step 3 up" }));
    await user.click(within(editor).getByRole("button", { name: "Remove step 1" }));
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(w.stored()?.[2]?.steps).toEqual(["set(dmg, empty)", "set(applied, true)"]),
    );
    expect(w.transacts()).toHaveLength(1);
  });

  test("renaming to a duplicate is blocked; a free name is one set_actions", async () => {
    const w = await world();
    const user = userEvent.setup();
    await user.click(within(item("Roll")).getByRole("button", { name: "Rename Roll" }));
    const field = within(section()).getByRole("textbox", { name: "New name for Roll" });
    await user.clear(field);
    await user.type(field, "Apply{Enter}");
    expect(within(section()).getByRole("alert").textContent).toMatch(/already exists/);
    expect(w.transacts()).toEqual([]);
    // In the editor too: a duplicate name disables Save.
    await user.keyboard("{Escape}");
    await user.click(within(item("Roll")).getByRole("button", { name: "Edit Roll" }));
    const name = within(section()).getByRole("textbox", { name: "Action name" });
    await user.clear(name);
    await user.type(name, "Roll damage");
    expect(
      (within(section()).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(within(section()).getByRole("button", { name: "Cancel" }));
    expect(w.transacts()).toEqual([]);

    const base = w.session.getSnapshot().revision;
    await user.click(within(item("Roll")).getByRole("button", { name: "Rename Roll" }));
    const again = within(section()).getByRole("textbox", { name: "New name for Roll" });
    await user.clear(again);
    await user.type(again, "Attack roll{Enter}");
    await waitFor(() => expect(w.stored()?.[0]?.name).toBe("Attack roll"));
    expect(w.transacts()).toHaveLength(1);
    expect(w.transacts()[0]?.base_revision).toBe(base);
  });

  test("Move up, Move down and Delete are each one set_actions at the click", async () => {
    const w = await world();
    const user = userEvent.setup();
    await user.click(within(item("Apply")).getByRole("button", { name: "Move Apply up" }));
    await waitFor(() =>
      expect(w.stored()?.map((a) => a.name)).toEqual(["Roll", "Apply", "Roll damage"]),
    );
    await waitFor(() =>
      expect(
        (within(item("Roll")).getByRole("button", { name: "Move Roll up" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    await user.click(within(item("Roll")).getByRole("button", { name: "Move Roll down" }));
    await waitFor(() =>
      expect(w.stored()?.map((a) => a.name)).toEqual(["Apply", "Roll", "Roll damage"]),
    );
    await user.click(within(item("Roll")).getByRole("button", { name: "Delete Roll" }));
    await waitFor(() => expect(w.stored()?.map((a) => a.name)).toEqual(["Apply", "Roll damage"]));
    expect(w.transacts().map((t) => t.ops.length)).toEqual([1, 1, 1]);
    expect(w.transacts().every((t) => t.ops[0]?.type === "set_actions")).toBe(true);
  });

  test("a concurrent set_actions between Edit and Save yields stale_write and keeps the editor text", async () => {
    const w = await world();
    const user = userEvent.setup();
    const base = w.session.getSnapshot().revision;
    await user.click(within(item("Roll")).getByRole("button", { name: "Edit Roll" }));
    const step = within(section()).getByRole("textbox", { name: "Step 1" });
    await user.clear(step);
    await user.type(step, "roll(1d20 + 1) -> roll");

    const other = await w.client("other");
    const concurrent = await other.transact(
      [{ type: "set_actions", object: w.object, actions: [ROLL, APPLY] }],
      { base_revision: base, label: "Other" },
    );
    expect(concurrent.status).toBe("committed");
    await act(() => w.session.whenRevision(base + 1));

    await user.click(within(section()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.notices().some((n) => n.kind === "stale")).toBe(true));
    expect(w.transacts()).toHaveLength(1);
    expect(w.transacts()[0]?.base_revision).toBe(base);
    expect(w.stored()).toEqual([ROLL, APPLY]);
    // The editor is still open with the typed text, and Save works again.
    const kept = within(section()).getByRole("textbox", { name: "Step 1" }) as HTMLInputElement;
    expect(kept.value).toBe("roll(1d20 + 1) -> roll");
    expect(
      (within(section()).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("Run", () => {
  test("Run on the Attack card's Roll commits", async () => {
    const w = await world({ dice: [roll("1d20", 15)] });
    const user = userEvent.setup();
    const base = w.session.getSnapshot().revision;
    const run = within(item("Roll")).getByRole("button", { name: "Run Roll" });
    expect(run.getAttribute("aria-disabled")).toBe("false");
    await user.click(run);
    await waitFor(() => {
      const value = w.session.objectView(w.object)?.cells.roll?.value;
      expect(value?.type === "roll" ? value.total : null).toBe(15);
    });
    expect(w.invokes()).toHaveLength(1);
    const { txn_id: _txn, ...sent } = w.invokes()[0] as InvokeParams & { txn_id?: string };
    expect(sent).toEqual({
      object: w.object,
      action: "Roll",
      base_revision: base,
      table: { board: BOARD, position: [0, 0] },
    });
    expect(w.groups().at(-1)?.label).toBe("Roll");
    // Roll is now disabled (its condition needs roll = empty).
    await waitFor(() =>
      expect(within(item("Roll")).getByText("disabled: its condition is false")).toBeDefined(),
    );
  });

  test("Run on a disabled action shows the reason and sends nothing", async () => {
    const w = await world();
    const user = userEvent.setup();
    const run = within(item("Apply")).getByRole("button", { name: "Run Apply" });
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(run.getAttribute("title")).toBe("Apply: its condition is false.");
    expect(within(item("Apply")).getByText("Apply: its condition is false.")).toBeDefined();
    await user.click(run);
    await waitFor(() =>
      expect(w.notices().map((n) => n.text)).toContain(
        `Apply: its condition is false (when: ${APPLY_WHEN}).`,
      ),
    );
    expect(w.invokes()).toEqual([]);
  });

  test("Run is disabled on a template and, when forced, sends no request", async () => {
    const w = await world({ object: "template" });
    const run = within(item("Roll")).getByRole("button", { name: "Run Roll" });
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(within(item("Roll")).getByText(TEMPLATE_REFUSAL)).toBeDefined();
    fireEvent.click(run);
    await waitFor(() => expect(w.notices().map((n) => n.text)).toContain(TEMPLATE_REFUSAL));
    expect(w.invokes()).toEqual([]);
    expect(w.transacts()).toEqual([]);
    // Templates are still edited.
    expect(within(item("Roll")).getByRole("button", { name: "Edit Roll" })).toBeDefined();
  });
});

describe("view-as", () => {
  test("as Aldric only names and states show", async () => {
    const w = await world();
    await act(() => w.session.setView(BOARD, { type: "character", id: "aldric" }));
    await until(
      () => w.session.objectView(w.object)?.actions[0]?.steps === undefined,
      "Aldric's view of the card",
    );
    await waitFor(() => expect(within(section()).queryByRole("button")).toBeNull());
    expect(within(item("Roll")).getByText("Roll")).toBeDefined();
    expect(within(item("Roll")).getByText("enabled")).toBeDefined();
    expect(within(item("Apply")).getByText("disabled: its condition is false")).toBeDefined();
    expect(within(section()).queryByText(ROLL.when as string)).toBeNull();
    expect(within(section()).queryByText("roll(1d20) -> roll")).toBeNull();
    expect(within(section()).queryByRole("textbox")).toBeNull();
  });

  test("an open editor closes on switching to view-as and nothing is written", async () => {
    const w = await world();
    const user = userEvent.setup();
    await user.click(within(item("Roll")).getByRole("button", { name: "Edit Roll" }));
    await user.type(within(section()).getByRole("textbox", { name: "Step 1" }), "x");
    await act(() => w.session.setView(BOARD, { type: "character", id: "aldric" }));
    await waitFor(() => expect(within(section()).queryByRole("group")).toBeNull());
    await act(() => w.session.setView(BOARD, { type: "gm" }));
    await waitFor(() =>
      expect(within(item("Roll")).getByRole("button", { name: "Edit Roll" })).toBeDefined(),
    );
    expect(within(section()).queryByRole("group")).toBeNull();
    expect(w.transacts()).toEqual([]);
  });
});
