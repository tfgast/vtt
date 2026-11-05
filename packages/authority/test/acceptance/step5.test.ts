/**
 * M3 epic acceptance (vtt-5su.13): DESIGN.md §8.4 step 5, headless, against
 * the real `vtt-serve` and `vtt-mcp` binaries on port 0 with temp files.
 *
 * §8.4 step 5 reads:
 *
 *   > Through the MCP server, ask the agent: "Make room 4 difficult terrain
 *   > and hatch it, and make a Fireball card for Aldric with DC 14 and 8d6."
 *   > Check its work in the inspector. Correct the DC by typing over it.
 *
 * Sentence by sentence:
 *
 * - "Through the MCP server, ask the agent: …" — block 1 starts the
 *   authority (`vtt-serve --print-session`), block 2 lays down what steps
 *   1–4 left on the table (`prep.ts`, as the GM), block 3 starts `vtt-mcp`
 *   and runs the deterministic agent (`agent-script.ts`): room 4 tagged
 *   `difficult` with `pattern: "hatch"` (M3-D26), `speed` halved, the
 *   Fireball card with its zone, its four actions and its save-row template
 *   authored in one group, the actions and `targets` explained, the zone
 *   tried on the board and the try undone.
 * - "Check its work in the inspector." — block 4: the GM reads back every
 *   object and cell, the card group's actor, Aldric's view (card and zone in,
 *   rooms and the covered PC out, six covers), and spawns a save row from
 *   the template onto the card, checks it, and undoes the spawn. (The
 *   inspector UI is M4; its data is what is checked here.)
 * - "Correct the DC by typing over it." — block 5: the GM's `dc` write
 *   reaches the agent's subscription, and the agent's stale writes and undos
 *   are refused per PROTOCOL.md §6 while a disjoint write commits.
 *
 * Block 6 closes the epic: the corrected work is saved, survives an
 * authority restart, and the MCP process reconnects and reports the resync.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProtocolClient } from "@vtt/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  authorStep5,
  CARD,
  CARD_ACTIONS,
  CARD_LABEL,
  call,
  type Json,
  ok,
  ROOM_LABEL,
  ROW,
  ROW_ACTIONS,
  ROW_FORMULAS,
  ROWS_FORMULA,
  type Step3Transcript,
  TARGETS_FORMULA,
  type ToolResult,
  ZONE,
} from "./agent-script";
import { prepare, ROOMS } from "./prep";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const SERVE_BIN = join(PKG, "src", "bin", "serve.ts");
const MCP_BIN = join(PKG, "src", "bin", "mcp.ts");

const AGENT_NAME = "step5-agent";
const AGENT_ACTOR = { type: "agent", name: AGENT_NAME };
const GM_ACTOR = { type: "gm" };
/** The whole file's budget (the bead's Done-when). */
const TOTAL_MS = 60_000;
/** One bounded wait: start-up, a reconnect (backoff up to 5 s), an exit. */
const BOUND = 20_000;
/** Per block; generous for a slow runner, the total is asserted separately. */
const BLOCK_MS = 45_000;

/** The 17 tools of PROTOCOL.md §11 merged by M3 (`import_asset` is M4's). */
const M3_TOOLS = [
  "table_info",
  "list_objects",
  "get_objects",
  "evaluate",
  "zones",
  "at_position",
  "changes_since",
  "log",
  "explain_cell",
  "explain_group",
  "explain_action",
  "transact",
  "undo",
  "save",
  "subscribe",
  "poll_changes",
  "unsubscribe",
];

interface Printed {
  url: string;
  token: string;
  session: string;
}

interface Proc {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, what: string, ms = BOUND): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function within<T>(p: Promise<T>, what: string, ms = BOUND): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shared state across the numbered blocks (they run in order).

let dir: string;
let file: string;
let config: string;
let started: number;
const servers: Proc[] = [];
let session: Printed;
let gm: ProtocolClient | undefined;
let agent: Client | undefined;
let transport: StdioClientTransport | undefined;
let agentPid = 0;
let agentStderr = "";
let t3: Step3Transcript;
let handle: string;
let oldBase: number;
let gmDcIndex: number;
let damageDiceIndex: number;

/** `vtt-serve <file> --print-session [args]`, port 0 unless `args` names one. */
function serve(args: string[]): Proc {
  const port = args.includes("--port") ? [] : ["--port", "0"];
  const child = spawn(
    process.execPath,
    ["--import", "tsx", SERVE_BIN, file, ...port, "--print-session", ...args],
    {
      cwd: PKG,
      env: { ...process.env, VTT_URL: undefined, VTT_TOKEN: undefined, XDG_CONFIG_HOME: config },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  servers.push(proc);
  return proc;
}

async function printed(p: Proc): Promise<Printed> {
  await Promise.race([
    until(() => p.stdout.includes("\n"), "the --print-session line"),
    p.exited.then(({ code }) => {
      throw new Error(`vtt-serve exited (${code}) before listening:\n${p.stderr}`);
    }),
  ]);
  return JSON.parse(p.stdout.split("\n")[0] as string) as Printed;
}

const running = (p: Proc) => p.child.exitCode === null && p.child.signalCode === null;

/** Calls `name` every 100 ms until `pred` holds; tolerates gated (`isError`) answers meanwhile. */
async function untilTool(
  name: string,
  args: Record<string, unknown>,
  pred: (r: ToolResult) => boolean,
  what: string,
): Promise<ToolResult> {
  const end = Date.now() + BOUND;
  for (;;) {
    const result = await call(agent as Client, name, args);
    if (pred(result)) return result;
    if (Date.now() > end) {
      throw new Error(
        `timed out waiting for ${what}; last ${name}: ${JSON.stringify(result.structuredContent)}\n${agentStderr}`,
      );
    }
    await sleep(100);
  }
}

const succeeded = (r: ToolResult) => r.isError !== true;

async function gmGet(ids: string[]): Promise<Map<string, Json>> {
  const result = await (gm as ProtocolClient).request("get_objects", { ids });
  expect(result.missing).toEqual([]);
  return new Map(result.objects.map((v) => [v.id, v as Json]));
}

const lit = (value: Json) => ({ kind: "literal", value });
const num = (value: number) => ({ type: "number", value });
const ref = (object: string) => ({ type: "ref", object });
const EMPTY_LIST = { type: "list", items: [] };

/** Every node of a dependency tree, depth first. */
function nodes(deps: Json[]): Json[] {
  return deps.flatMap((d) => [d, ...nodes(d.dependencies ?? [])]);
}

beforeAll(async () => {
  started = Date.now();
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-step5-")));
  config = join(dir, "config");
  file = join(dir, "crypt.table.json");
});

afterAll(async () => {
  try {
    gm?.close();
    if (agent !== undefined) await agent.close().catch(() => undefined);
    await until(() => !alive(agentPid), "vtt-mcp to exit").catch(() => undefined);
    for (const p of servers) {
      if (running(p)) {
        p.child.kill("SIGTERM");
        await within(p.exited, "vtt-serve to exit").catch(() => undefined);
      }
    }
    // Whatever is still running after the graceful attempts is a failure; kill it, then assert.
    const leftovers = [
      ...(alive(agentPid) ? [`vtt-mcp ${agentPid}`] : []),
      ...servers.filter(running).map((p) => `vtt-serve ${p.child.pid}`),
    ];
    if (alive(agentPid)) process.kill(agentPid, "SIGKILL");
    for (const p of servers.filter(running)) {
      p.child.kill("SIGKILL");
      await p.exited;
    }
    expect(leftovers).toEqual([]);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(join(config, "vtt", "session.json"))).toBe(false);
    expect(Date.now() - started).toBeLessThan(TOTAL_MS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, BOUND * 3);

describe("§8.4 step 5 through vtt-serve and vtt-mcp", () => {
  test(
    "1. vtt-serve --port 0 --print-session prints {url, token}",
    async () => {
      session = await printed(serve([]));
      expect(session.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
      expect(session.token).toEqual(expect.any(String));
    },
    BLOCK_MS,
  );

  test(
    "2. prep, as the GM over a ui ProtocolClient: Crypt, Aldric and his binder, six rooms, pc1, goblin1",
    async () => {
      gm = new ProtocolClient({
        url: session.url,
        token: session.token,
        client: { name: "step5-gm", kind: "ui" },
        onWarning: () => undefined,
      });
      const welcome = await within(gm.connect(), "the GM welcome");
      expect(welcome.actor).toEqual(GM_ACTOR);
      await prepare(gm);
      const zones = await gm.request("zones", { board: "crypt" });
      expect(zones.zones.map((z) => z.id)).toEqual(ROOMS.map((r) => r.id));
      expect(zones.zones.find((z) => z.id === "room4")?.contents).toEqual(["pc1"]);
      expect(zones.zones.find((z) => z.id === "room3")?.contents).toEqual(["goblin1"]);
    },
    BLOCK_MS,
  );

  test(
    "3. the agent over vtt-mcp: room 4 difficult and hatched, the Fireball card, explain, the zone tried and undone",
    async () => {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          MCP_BIN,
          "--url",
          session.url,
          "--token",
          session.token,
          "--name",
          AGENT_NAME,
        ],
        cwd: PKG,
        env: { ...getDefaultEnvironment(), XDG_CONFIG_HOME: config },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        agentStderr += chunk.toString();
      });
      agent = new Client({ name: "step5-host", version: "1.0.0" });
      const watch = setInterval(() => {
        agentPid = transport?.pid ?? agentPid;
      }, 1);
      try {
        await within(agent.connect(transport), "MCP initialization");
      } finally {
        agentPid = transport.pid ?? agentPid;
        clearInterval(watch);
      }
      expect(agentPid).toBeGreaterThan(0);
      const { tools } = await agent.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(M3_TOOLS));
      await untilTool("table_info", {}, succeeded, "vtt-mcp to connect");

      t3 = await authorStep5(agent);

      expect(t3.info).toMatchObject({ actor: AGENT_ACTOR, session: session.session });
      expect(t3.room4).toBe("room4");
      expect(t3.roomGroup).toMatchObject({ status: "committed" });
      // FORMULAS.md §10 Difficult terrain: 30 halved in a difficult zone.
      expect(t3.pc1.objects[0].cells.speed.value).toEqual(num(15));
      expect(t3.cardGroup).toMatchObject({ status: "committed" });
      expect(t3.cardGroup.created.map((c: Json) => c.id)).toEqual([CARD, ZONE, ROW]);

      // Every action's guard parses; none is a when_error.
      for (const [name, explained] of [
        ...Object.entries(t3.explainCard),
        ["Roll save", t3.explainRollSave],
      ]) {
        expect(explained.reason, name).not.toBe("when_error");
        expect(JSON.stringify(explained), name).not.toContain("#SYNTAX");
        expect(explained.guard?.value?.type, name).not.toBe("error");
      }
      expect(t3.explainCard["Lock targets"]).toMatchObject({
        enabled: true,
        guard: { source: "not locked", value: { type: "boolean", value: true } },
      });
      expect(t3.explainCard["Roll damage"]).toMatchObject({ enabled: false, reason: "when_false" });
      expect(t3.explainCard["Apply all"]).toMatchObject({ enabled: false, reason: "when_false" });
      expect(t3.explainCard.Discard).toEqual({
        object: CARD,
        action: "Discard",
        enabled: true,
        steps: ["remove(zone)", "remove(this)"],
      });
      expect(t3.explainRollSave).toMatchObject({
        object: ROW,
        action: "Roll save",
        enabled: true,
        guard: { source: "save_roll = empty", value: { type: "boolean", value: true } },
        steps: ["roll(1d20) -> save_roll"],
      });

      // The zone inside the card: `targets` is [] and asks the spatial index for nothing
      // (FORMULAS.md §7). Its recorded dependencies are the card's `zone` cell, the existence
      // check that dereferencing that ref records (an `exists` node, PROTOCOL.md §9), and the
      // zone's cells; no `index` node.
      const inside = nodes(t3.targetsInside.dependencies);
      const insideJson = JSON.stringify(t3.targetsInside.dependencies);
      expect(t3.targetsInside.view.value).toEqual(EMPTY_LIST);
      expect(inside).toContainEqual(
        expect.objectContaining({ type: "cell", object: CARD, cell: "zone" }),
      );
      expect(
        inside.filter((n) => n.type === "index"),
        insideJson,
      ).toEqual([]);
      for (const node of inside.filter((n) => n.type !== "cell")) {
        expect(node, insideJson).toEqual({ type: "exists", object: ZONE, exists: true });
      }
      // On the board, outside every room: `targets` now asks the spatial index.
      expect(t3.move).toMatchObject({ status: "committed" });
      expect(t3.targetsOnBoard.view.value).toEqual(EMPTY_LIST);
      expect(t3.targetsOnBoard.dependencies).toContainEqual({ type: "index" });
      // The agent's own undo puts the zone back inside the card.
      expect(t3.undoMove).toMatchObject({ status: "committed" });
      const [zone, card] = t3.afterUndo.objects;
      expect(zone.cells.container.value).toEqual(ref(CARD));
      expect(zone.cells.board.value).toEqual({ type: "empty" });
      expect(card.cells.contents.value).toEqual({ type: "list", items: [ref(ZONE)] });
    },
    BLOCK_MS,
  );

  test(
    "4. the GM checks the work: objects and cells, the card group's actor, Aldric's view, a save row spawned and undone",
    async () => {
      const g = gm as ProtocolClient;
      const views = await gmGet([CARD, ZONE, ROW, "room4"]);
      const card = views.get(CARD);
      expect(card.cells).toMatchObject({
        name: lit({ type: "text", value: "Fireball" }),
        owner: lit(ref("aldric")),
        caster: lit(ref("aldric")),
        zone: lit(ref(ZONE)),
        dc: lit(num(14)),
        damage_dice: lit({ type: "dice", expr: "8d6" }),
        damage: lit({ type: "empty" }),
        locked: lit({ type: "boolean", value: false }),
        applied: lit({ type: "boolean", value: false }),
        save_row: lit(ref(ROW)),
        targets: { kind: "formula", source: TARGETS_FORMULA, value: EMPTY_LIST },
        rows: { kind: "formula", source: ROWS_FORMULA, value: EMPTY_LIST },
        container: { value: ref("aldric_binder") },
      });
      expect(card.actions).toEqual(CARD_ACTIONS);

      const zone = views.get(ZONE);
      expect(zone.cells).toMatchObject({
        is_zone: { value: { type: "boolean", value: true } },
        shape: { value: { type: "shape", shape: { type: "circle", radius: 20 } } },
        container: { value: ref(CARD) },
      });

      const row = views.get(ROW);
      expect(row.is_template).toBe(true);
      expect(row.cells).toMatchObject({
        tag: { value: { type: "list", items: [{ type: "text", value: "save_row" }] } },
        target: lit({ type: "empty" }),
        save_roll: lit({ type: "empty" }),
        container: { value: ref("aldric_binder") },
      });
      for (const [cell, source] of Object.entries(ROW_FORMULAS)) {
        expect(row.cells[cell], cell).toMatchObject({ kind: "formula", source });
      }
      expect(row.actions).toEqual(ROW_ACTIONS);

      const room4 = views.get("room4");
      expect(room4.cells).toMatchObject({
        tag: { value: { type: "list", items: [{ type: "text", value: "difficult" }] } },
        pattern: lit({ type: "text", value: "hatch" }),
      });

      // The card group: one group, the agent's, holding all three creations.
      const log = await g.request("log", { limit: 200, effects: true });
      const cardGroups = log.groups.filter((gr) => gr.label === CARD_LABEL);
      expect(cardGroups).toHaveLength(1);
      const cardGroup = cardGroups[0] as Json;
      expect(cardGroup).toMatchObject({
        index: t3.cardGroup.index,
        actor: AGENT_ACTOR,
        kind: "edit",
      });
      const createdIds = (cardGroup.effects as Json[])
        .filter((e) => e.type === "create")
        .flatMap((e) => e.objects.map((o: Json) => o.id));
      expect(createdIds.sort()).toEqual([CARD, ZONE, ROW].sort());
      expect(log.groups.find((gr) => gr.label === ROOM_LABEL)).toMatchObject({
        actor: AGENT_ACTOR,
      });

      // What Aldric sees: his card and its zone; no room, no covered pc1; six covers on the Crypt.
      const sub = await g.subscribe({
        scope: { type: "all" },
        viewer: { type: "character", id: "aldric" },
      });
      const seen = [...sub.mirror.objects.keys()];
      expect(seen).toEqual(expect.arrayContaining([CARD, ZONE]));
      for (const r of ROOMS) expect(seen).not.toContain(r.id);
      expect(seen).not.toContain("pc1");
      const covers = [...sub.mirror.covers.values()];
      expect(covers).toHaveLength(6);
      for (const c of covers) {
        expect(c.board).toBe("crypt");
        expect(c.region).toMatchObject({ shape: { type: "rect", width: 100, height: 100 } });
      }
      await sub.close();

      // The GM spawns a row from the template onto the card, checks it, and undoes the spawn.
      const spawned = await g.transact(
        [{ type: "spawn", template: ROW, to: { type: "container", container: CARD }, as: "$row" }],
        { label: "GM: try a save row on the card" },
      );
      expect(spawned.status, JSON.stringify(spawned)).toBe("committed");
      if (spawned.status !== "committed") return;
      const copyId = spawned.bindings.$row as string;
      expect(copyId).toEqual(expect.any(String));
      expect(copyId).not.toBe(ROW);
      const afterSpawn = await gmGet([copyId, CARD]);
      const copy = afterSpawn.get(copyId);
      expect(copy.actions).toEqual(ROW_ACTIONS);
      expect(copy.cells).toMatchObject({
        target: lit({ type: "empty" }),
        save_roll: lit({ type: "empty" }),
        card: { kind: "formula", source: "container", value: ref(CARD) },
        container: { value: ref(CARD) },
      });
      for (const [cell, source] of Object.entries(ROW_FORMULAS)) {
        expect(copy.cells[cell], cell).toMatchObject({ kind: "formula", source });
      }
      expect(afterSpawn.get(CARD).cells.rows.value).toEqual({ type: "list", items: [ref(copyId)] });

      const undone = await g.request("undo", { target: { type: "mine" } });
      expect(undone.status, JSON.stringify(undone)).toBe("committed");
      const afterUndo = await g.request("get_objects", { ids: [copyId, CARD] });
      expect(afterUndo.missing).toEqual([copyId]);
      expect((afterUndo.objects[0] as Json).cells.rows.value).toEqual(EMPTY_LIST);
    },
    BLOCK_MS,
  );

  test(
    "5. the GM types over the DC: the agent sees it, its stale write and undos are refused, a disjoint write commits",
    async () => {
      const a = agent as Client;
      const g = gm as ProtocolClient;
      const subscribed = await ok(a, "subscribe", { scope: { type: "objects", ids: [CARD] } });
      handle = subscribed.subscription;
      oldBase = subscribed.revision;
      expect(subscribed.objects).toBe(1);

      const dc = await g.transact([
        { type: "set_value", object: CARD, cell: "dc", value: { type: "number", value: 15 } },
      ]);
      expect(dc.status, JSON.stringify(dc)).toBe("committed");
      if (dc.status !== "committed") return;
      gmDcIndex = dc.index;

      const changes: Json[] = [];
      const isDc = (c: Json) => c.type === "commit" && c.group.index === gmDcIndex;
      await untilTool(
        "poll_changes",
        { subscription: handle, wait_ms: 2000 },
        (r) => {
          if (r.isError === true) return false;
          changes.push(...r.structuredContent.changes);
          return changes.some(isDc);
        },
        "the GM's dc change",
      );
      const record = changes.find(isDc);
      expect(record.group).toMatchObject({ actor: GM_ACTOR, kind: "edit" });
      expect(record.cells).toEqual([
        expect.objectContaining({
          object: CARD,
          cell: "dc",
          before: expect.objectContaining({ value: num(14) }),
          after: expect.objectContaining({ value: num(15) }),
        }),
      ]);

      const stale = await call(a, "transact", {
        base_revision: oldBase,
        label: "Fireball DC 16",
        ops: [
          { type: "set_value", object: CARD, cell: "dc", value: { type: "number", value: 16 } },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({
        status: "rejected",
        rejection: {
          type: "stale_write",
          base_revision: oldBase,
          truncated: false,
          conflicts: [{ index: gmDcIndex, actor: GM_ACTOR, keys: [`cell:${CARD}/dc`] }],
        },
      });
      expect(stale.structuredContent.rejection.conflicts).toHaveLength(1);

      const cardIndex = t3.cardGroup.index as number;
      const conflict = await call(a, "undo", { target: { type: "group", index: cardIndex } });
      expect(conflict.isError).toBe(true);
      expect(conflict.structuredContent).toMatchObject({
        status: "rejected",
        rejection: { type: "undo_conflict", target: cardIndex },
      });
      expect(conflict.structuredContent.rejection.conflicting).toContain(gmDcIndex);

      const disjoint = await ok(a, "transact", {
        base_revision: oldBase,
        label: "Fireball 10d6",
        ops: [
          {
            type: "set_value",
            object: CARD,
            cell: "damage_dice",
            value: { type: "dice", expr: "10d6" },
          },
        ],
      });
      expect(disjoint).toMatchObject({ status: "committed" });
      damageDiceIndex = disjoint.index;

      const changed = await call(a, "undo", { target: { type: "mine" }, expect_index: cardIndex });
      expect(changed.isError).toBe(true);
      expect(changed.structuredContent).toMatchObject({
        status: "rejected",
        rejection: { type: "undo_target_changed", expected: cardIndex, actual: damageDiceIndex },
      });
    },
    BLOCK_MS,
  );

  test(
    "6. save, restart on the same port and token: vtt-mcp reconnects, reports the resync, and reads the corrected card",
    async () => {
      const a = agent as Client;
      await ok(a, "poll_changes", { subscription: handle });
      const saved = await ok(a, "save");
      expect(saved).toMatchObject({ status: "saved" });

      gm?.close();
      const first = servers[0] as Proc;
      first.child.kill("SIGTERM");
      expect(await within(first.exited, "vtt-serve to exit")).toEqual({ code: 0, signal: null });

      const port = new URL(session.url).port;
      const second = await printed(serve(["--port", port, "--token", session.token]));
      expect(second.url).toBe(session.url);
      expect(second.session).not.toBe(session.session);

      const records: Json[] = [];
      await untilTool(
        "poll_changes",
        { subscription: handle, wait_ms: 1000 },
        (r) => {
          if (r.isError === true) return false;
          records.push(...r.structuredContent.changes);
          return records.some((c) => c.type === "resync");
        },
        "the resync record",
      );
      expect(records.find((c) => c.type === "resync")).toMatchObject({ session_changed: true });

      const got = await ok(a, "get_objects", { ids: [CARD] });
      const card = got.objects[0];
      expect(card.cells.dc.value).toEqual(num(15));
      expect(card.cells.damage_dice.value).toEqual({ type: "dice", expr: "10d6" });
      expect(card.actions).toEqual(CARD_ACTIONS);

      const log = await ok(a, "log", { limit: 200 });
      const mine = (log.groups as Json[]).filter((gr) => gr.actor.type === "agent");
      for (const gr of mine) expect(gr.actor).toEqual(AGENT_ACTOR);
      expect(mine.map((gr) => gr.index)).toEqual(
        expect.arrayContaining([t3.roomGroup.index, t3.cardGroup.index, damageDiceIndex]),
      );
      expect(mine.find((gr) => gr.index === t3.cardGroup.index)?.label).toBe(CARD_LABEL);
      expect(mine.find((gr) => gr.index === t3.roomGroup.index)?.label).toBe(ROOM_LABEL);
      expect(log.groups.find((gr: Json) => gr.index === gmDcIndex)?.actor).toEqual(GM_ACTOR);
    },
    BLOCK_MS,
  );
});
