/**
 * The walkthrough's second play half (vtt-nb8.11): DESIGN.md §8.4 steps
 * 12–15 as amended by vtt-nb8.2 (M6-D1, M6-D3), read as M6 plan decision
 * Q3 states (the readings table of vtt-nb8.9), driven through the real app
 * with vtt-nb8.18's gestures from where `runPlayA` left the table: GM view,
 * the select tool, Crypt active, the Log tab open; the party in room 1,
 * their markers in the Initiative strip; Aldric's binder on Crypt at
 * M + [27, 15] holding [Attack template, the step-10 working copy,
 * Fireball].
 *
 * Local helpers are built only from the `DriverContext` and `Gestures`;
 * the GM assertion client is only read. `runPlayB` returns what it observed
 * on the way for its test, which asserts it.
 *
 * Gesture choices the bead leaves open, or where the merged UI decides:
 * - a template entry is dragged out with `dragEntry` and the copy read from
 *   the selection (the Fireball card, the note, the trap die);
 * - the Fireball zone is dragged out of the card's list with `dragObject`
 *   (an entry drag out). Once on Crypt it lies under the map image (zones
 *   are hit after objects), so `dragObject` cannot press it: the nudge
 *   is a plain `drag` from no selection, grabbed inside the zone clear of
 *   the tokens in it and released over G1's contents list, which is hidden
 *   while G1 is unselected (M6-D12), so the zone lands on the board;
 * - each save row is expanded in the card's list with `expandEntry` before
 *   its Roll save is pressed;
 * - G4 is selected with `click` before Delete;
 * - the Log tab is paged with `logLoadOlder` until the agent's
 *   "Fireball for Aldric" group is listed;
 * - the state compared across the restart is read through the GM client:
 *   the `document` snapshot's boards and objects, and every log group
 *   (paged `log`).
 */
import { waitFor, within } from "@testing-library/react";
import type { GroupView } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import type {
  DiceEntry,
  DriverContext,
  Gestures,
  LogGroupShown,
  PlayAResult,
  Point,
  PrepResult,
} from "./contract";
import { createGestures } from "./gestures";

const roll = (expr: string, dice: number[]): DiceEntry => ({
  type: "roll",
  expr,
  dice,
  dropped: [],
  total: dice.reduce((a, b) => a + b, 0),
});

/**
 * Play B's rolls, after `PREP_DICE` and `PLAY_A_DICE`: Fireball's damage,
 * the three saves (G1, G2, G3), the trap die, the wrong goblin's attack and
 * damage (§8.4 steps 12–14).
 */
export const PLAY_B_DICE: DiceEntry[] = [
  roll("8d6", [6, 5, 4, 3, 2, 1, 6, 1]),
  roll("1d20", [15]),
  roll("1d20", [5]),
  roll("1d20", [12]),
  roll("1d20", [8]),
  roll("1d20", [18]),
  roll("1d8", [5]),
];

/** Where Brenna steps into room 3 (§8.4 step 12, Q3), relative to M. */
export const BRENNA_IN_ROOM3: Point = [17, 11];
/** Where the Fireball card is put down (§8.4 step 12), relative to M. */
export const FIREBALL_AT: Point = [27, 22];
/** The Fireball zone: dropped on room 3, then nudged (§8.4 step 12), relative to M. */
export const ZONE_DROP: Point = [15.5, 11.5];
export const ZONE_NUDGE: Point = [14.5, 12];
/**
 * Where the nudge grabs the zone, from its anchor: pressed at M + [15.3,
 * 11], inside the zone clear of the tokens, so a plain press picks the zone
 * (M6-D10); released at M + [14.3, 11.5], clear of G1's body and over G1's
 * contents list, which an unselected G1 hides (M6-D12), so the release
 * point is the board.
 */
export const ZONE_GRAB: Point = [-0.2, -0.5];
/** The trap note and its die in the tray (§8.4 step 13), relative to M. */
export const NOTE_AT: Point = [7, 19];
export const NOTE_TEXT = "DC 12";
export const TRAP_DIE_AT: Point = [5, 18.5];

const GM_BINDER = "gm_binder";
const COMMIT_MS = 10_000;
/** The agent's Fireball group label (vtt-nb8.9). */
const FIREBALL_LABEL = "Fireball for Aldric";

/** A log group as the GM client lists it, reduced to what step 15 compares. */
export interface GroupSummary {
  index: number;
  label: string | null;
  actor: GroupView["actor"];
  kind: GroupView["kind"];
  undoes: number | null;
  undone: boolean;
}

/** The table through the GM client: the snapshot's boards and objects, and every log group. */
export interface TableCapture {
  boards: unknown;
  /** The stored snapshot's objects (literals, formula sources, overrides, containment). */
  objects: unknown;
  /**
   * Every object's GM view through the assertion client, by id: each cell's
   * evaluated value, kind, source and override, and the action states.
   */
  views: Record<ObjectId, unknown>;
  groups: GroupSummary[];
}

/** What play B saw on the way, for its test. */
export interface PlayBObserved {
  // Step 12
  brennaAt: number[];
  fireballCopy: ObjectId;
  fireballZone: ObjectId;
  /** `targets` with the zone dropped on room 3, and after the nudge (GM reads). */
  targetsDropped: ObjectId[];
  targetsNudged: ObjectId[];
  zoneDroppedAt: number[];
  zoneNudgedAt: number[];
  rows: ObjectId[];
  /** The newest Log tab group after Apply all. */
  applyAllGroup: LogGroupShown;
  // Step 13
  note: ObjectId;
  trapDie: ObjectId;
  trayText: unknown;
  // Step 14
  discardShown: boolean;
  discardEnabled: boolean;
  /** Whether the step-10 copy was still in the app's directory after Discard. */
  copyAfterDiscard: boolean;
  freshCopy: ObjectId;
  g4DamageAfterApply: number | null;
  /** The fresh copy's `dmg` after Apply. */
  freshDmg: unknown;
  g4DamageAfterUndo: number | null;
  freshAppliedAfterUndo: unknown;
  g4SelectedBeforeDelete: boolean;
  g4AfterDelete: boolean;
  g4DieAfterDelete: boolean;
  /** The Log tab after the undos: every group shown, newest first, once Fireball's is listed. */
  logShown: LogGroupShown[];
  // Step 15
  saveStatus: string;
  savedText: string;
  before: TableCapture;
  after: TableCapture;
  activeBoardAfterRestart: string | null;
  /** The group the captured log predicts Ctrl+Z reverses, and the log after it. */
  predicted: GroupSummary;
  afterUndo: GroupSummary[];
}

export interface PlayBRun {
  observed: PlayBObserved;
}

// ---------------------------------------------------------------------------
// Reading the table

type Cells = Record<string, { value: unknown }>;

/** A user cell's value in the app's own view of `id` (the current viewer's). */
function shownValue(ctx: DriverContext, id: ObjectId, cell: string): unknown {
  return ctx.session.objectView(id)?.cells[cell]?.value;
}

/** A number, or a roll's total. */
function numeric(v: unknown): number | null {
  const n = v as { type?: string; value?: unknown; total?: unknown } | undefined;
  if (n?.type === "number" && typeof n.value === "number") return n.value;
  if (n?.type === "roll" && typeof n.total === "number") return n.total;
  return null;
}

function refList(v: unknown): ObjectId[] {
  const l = v as { type?: string; items?: { type: string; object?: string }[] } | undefined;
  if (l?.type === "list") {
    return (l.items ?? []).flatMap((i) => (i.type === "ref" && i.object ? [i.object] : []));
  }
  const r = v as { type?: string; object?: string } | undefined;
  return r?.type === "ref" && r.object !== undefined ? [r.object] : [];
}

/** The GM's view of `id` through the assertion client (read only), or null when it is gone. */
async function gmCells(ctx: DriverContext, id: ObjectId): Promise<Cells | null> {
  const { objects } = await ctx.gm.request("get_objects", { ids: [id], viewer: { type: "gm" } });
  const [v] = objects;
  return v === undefined ? null : (v.cells as Cells);
}

async function gmValue(ctx: DriverContext, id: ObjectId, cell: string): Promise<unknown> {
  return (await gmCells(ctx, id))?.[cell]?.value;
}

async function gmPosition(ctx: DriverContext, id: ObjectId): Promise<number[]> {
  const v = (await gmValue(ctx, id, "position")) as { items?: { value?: unknown }[] } | undefined;
  return (v?.items ?? []).map((i) => Number(i.value));
}

/** Every log group, newest first, through the GM client. */
async function allGroups(ctx: DriverContext): Promise<GroupSummary[]> {
  const out: GroupSummary[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await ctx.gm.request("log", before === undefined ? {} : { before });
    for (const gr of page.groups) {
      out.push({
        index: gr.index,
        label: gr.label,
        actor: gr.actor,
        kind: gr.kind,
        undoes: gr.undoes ?? null,
        undone: gr.undone,
      });
    }
    const last = page.groups.at(-1);
    if (last === undefined || last.index <= page.first_index) return out;
    before = last.index;
  }
}

async function capture(ctx: DriverContext): Promise<TableCapture> {
  const { snapshot } = await ctx.gm.request("document", {});
  const s = snapshot as { boards?: unknown; objects?: Record<ObjectId, unknown> };
  const ids = Object.keys(s.objects ?? {}).sort();
  const views: Record<ObjectId, unknown> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { objects, missing } = await ctx.gm.request("get_objects", {
      ids: ids.slice(i, i + 100),
      viewer: { type: "gm" },
    });
    if (missing.length > 0) throw new Error(`play B: GM views missing ${missing.join(", ")}`);
    for (const v of objects) views[v.id] = v;
  }
  return { boards: s.boards, objects: s.objects, views, groups: await allGroups(ctx) };
}

/** The group Ctrl+Z (`human`) selects: the newest neither undone nor an undo, by `gm` or a character. */
export function predictUndo(groups: readonly GroupSummary[]): GroupSummary | undefined {
  return [...groups]
    .sort((a, b) => b.index - a.index)
    .find(
      (gr) =>
        !gr.undone &&
        gr.kind !== "undo" &&
        (gr.actor.type === "gm" || gr.actor.type === "character"),
    );
}

/** The one selected object, after a gesture that selects what it made. */
function selected(ctx: DriverContext, what: string): ObjectId {
  const sel = ctx.ui.getState().selection;
  const [only] = sel;
  if (sel.length !== 1 || only === undefined) {
    throw new Error(`play B: expected ${what} selected, the selection is ${JSON.stringify(sel)}`);
  }
  return only;
}

const offset =
  (m: Point) =>
  (p: Point): Point => [m[0] + p[0], m[1] + p[1]];

// ---------------------------------------------------------------------------
// Local helpers over the DriverContext and Gestures

/** Polls an async predicate until it holds, or throws naming `what`. */
async function until(pred: () => Promise<boolean>, what: () => string, ms = COMMIT_MS) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`play B: timed out waiting for ${what()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Drags a template entry out of `container` to `to`; resolves with the copy it spawned (selected). */
async function spawnEntry(
  ctx: DriverContext,
  g: Gestures,
  container: ObjectId,
  entry: ObjectId,
  to: Point,
): Promise<ObjectId> {
  const known = new Set(ctx.session.directory().keys());
  await g.dragEntry(container, entry, to);
  const copy = selected(ctx, `the copy of ${entry}`);
  if (known.has(copy)) throw new Error(`play B: dragging ${entry} spawned nothing`);
  return copy;
}

/** Waits until the GM reads `id.cell` as the number `want`. */
async function reads(
  ctx: DriverContext,
  id: ObjectId,
  cell: string,
  want: number,
  what: string,
): Promise<void> {
  let last: unknown;
  await until(
    async () => {
      last = await gmValue(ctx, id, cell);
      return numeric(last) === want;
    },
    () => `${what} (last ${JSON.stringify(last)})`,
  );
}

/**
 * Drags a zone drawn over the map image on the board so its anchor lands on
 * `to`, as a plain drag: no selection held (Escape clears it), pressed at
 * `grab` (board units from its anchor, inside the zone) and released at
 * `grab` from `to`. A zone is hit before the map it lies on (DESIGN §4.6,
 * M6-D10), so the press picks the zone itself; before M6-D10 this needed an
 * Alt+click cycle first. The release point decides the drop; a token's
 * contents list there is hidden while the token is unselected (M6-D12), so
 * a release over it lands on the board.
 */
async function nudgeZone(
  ctx: DriverContext,
  g: Gestures,
  zone: ObjectId,
  to: Point,
  grab: Point,
): Promise<void> {
  await g.key("Escape");
  if (ctx.ui.getState().selection.length !== 0) {
    throw new Error("play B: Escape did not clear the selection before the zone nudge");
  }
  const [ax, ay] = (await gmPosition(ctx, zone)) as Point;
  await g.drag([ax + grab[0], ay + grab[1]], [to[0] + grab[0], to[1] + grab[1]]);
  await until(
    async () => {
      const p = await gmPosition(ctx, zone);
      return (
        Math.abs((p[0] ?? Number.NaN) - to[0]) < 1e-6 &&
        Math.abs((p[1] ?? Number.NaN) - to[1]) < 1e-6
      );
    },
    () => `${zone} moved to ${JSON.stringify(to)}`,
  );
  if (ctx.ui.getState().selection.join() !== zone) {
    throw new Error(`play B: the plain drag did not pick ${zone}`);
  }
}

/** The Log tab's groups, opening the tab first if it is closed. */
async function logShown(g: Gestures): Promise<LogGroupShown[]> {
  try {
    return g.logGroups();
  } catch {
    await g.logLoadOlder();
    return g.logGroups();
  }
}

const newest = (groups: readonly LogGroupShown[]): LogGroupShown => {
  const top = groups.reduce<LogGroupShown | undefined>(
    (a, b) => (a === undefined || b.index > a.index ? b : a),
    undefined,
  );
  if (top === undefined) throw new Error("play B: the Log tab lists no group");
  return top;
};

// ---------------------------------------------------------------------------
// Play B

/**
 * §8.4 steps 12–15 through the UI, continuing from `runPlayA` (dice
 * `[...PREP_DICE, ...PLAY_A_DICE, ...PLAY_B_DICE]`).
 */
export async function runPlayB(
  ctx: DriverContext,
  prep: PrepResult,
  playA: PlayAResult,
): Promise<PlayBRun> {
  const g = createGestures(ctx);
  const at = offset(prep.mapOrigin);
  const pc = prep.characters;
  const aldricBinder = playA.aldricBinder;

  // -- 12. Aldric casts Fireball: the card out of his binder, its zone onto room 3, nudged.
  await g.viewAs("GM");
  await g.dragObject(pc.Brenna.token, at(BRENNA_IN_ROOM3));
  const brennaAt = await gmPosition(ctx, pc.Brenna.token);
  // The presses stay in GM view: the card is Aldric's, so they are his (M6-D15).
  const fireballCopy = await spawnEntry(
    ctx,
    g,
    aldricBinder,
    prep.fireballTemplate,
    at(FIREBALL_AT),
  );
  const [fireballZone] = refList(await gmValue(ctx, fireballCopy, "contents"));
  if (fireballZone === undefined) throw new Error("play B: the Fireball copy holds no zone");
  await g.dragObject(fireballZone, at(ZONE_DROP));
  const zoneDroppedAt = await gmPosition(ctx, fireballZone);
  const targetsDropped = refList(await gmValue(ctx, fireballCopy, "targets"));
  await nudgeZone(ctx, g, fireballZone, at(ZONE_NUDGE), ZONE_GRAB);
  const zoneNudgedAt = await gmPosition(ctx, fireballZone);
  const targetsNudged = refList(await gmValue(ctx, fireballCopy, "targets"));

  await g.pressButton(fireballCopy, "Lock targets");
  const rows = refList(await gmValue(ctx, fireballCopy, "rows"));
  await g.pressButton(fireballCopy, "Roll damage");
  for (const row of rows) {
    await g.expandEntry(fireballCopy, row);
    await g.pressButton(row, "Roll save");
  }
  await g.pressButton(fireballCopy, "Apply all");
  const applyAllGroup = newest(await logShown(g));

  // -- 13. The stair trap: a sticky note with the DC, a loose d20 rolled in the tray.
  await g.viewAs("GM");
  const note = await spawnEntry(ctx, g, GM_BINDER, "tpl_note", at(NOTE_AT));
  await g.editInPlace(note, "text", NOTE_TEXT);
  const trapDie = await spawnEntry(ctx, g, GM_BINDER, "tpl_d20", at(TRAP_DIE_AT));
  await g.doubleClick(trapDie);
  await reads(ctx, trapDie, "value", 8, "the trap die 8");
  await reads(ctx, playA.tray, "text", 54, "the tray 54");
  const trayText = shownValue(ctx, playA.tray, "text");

  // -- 14. Discard the spent card; the wrong goblin; undo; a mistaken delete, undone.
  await g.viewAs("Aldric");
  await g.bringIntoView({ object: playA.attackCopy, element: { action: "Discard" } });
  const discardShown = g.elementShown(playA.attackCopy, { action: "Discard" });
  const discardEnabled = g.elementEnabled(playA.attackCopy, "Discard");
  await g.pressButton(playA.attackCopy, "Discard");
  const copyAfterDiscard = ctx.session.directory().has(playA.attackCopy);
  await g.expandEntry(aldricBinder, pc.Aldric.attackTemplate);
  const freshCopy = selected(ctx, "the fresh Attack working copy");
  if (freshCopy === playA.attackCopy) throw new Error("play B: the discarded copy came back");

  const g4 = ctx.byName("G4");
  await g.dropOnEditor(g4, freshCopy, "target");
  await g.pressButton(freshCopy, "Roll");
  await g.pressButton(freshCopy, "Roll damage");
  await g.pressButton(freshCopy, "Apply");
  await reads(ctx, g4, "damage_taken", 5, "G4's damage_taken 5");
  const g4DamageAfterApply = numeric(await gmValue(ctx, g4, "damage_taken"));
  const freshDmg = await gmValue(ctx, freshCopy, "dmg");
  await g.key("Ctrl+Z");
  await reads(ctx, g4, "damage_taken", 0, "G4's damage_taken back to 0");
  const g4DamageAfterUndo = numeric(await gmValue(ctx, g4, "damage_taken"));
  const freshAppliedAfterUndo = await gmValue(ctx, freshCopy, "applied");

  await g.viewAs("GM");
  await g.click(g4);
  const g4SelectedBeforeDelete = ctx.ui.getState().selection.join() === g4;
  await g.key("Delete");
  const g4Die = prep.goblinDice[3] as ObjectId;
  const g4AfterDelete = (await gmCells(ctx, g4)) !== null;
  const g4DieAfterDelete = (await gmCells(ctx, g4Die)) !== null;
  await g.key("Ctrl+Z");
  await until(
    async () => (await gmCells(ctx, g4)) !== null,
    () => "G4 restored",
  );

  let shown = await logShown(g);
  while (!shown.some((gr) => gr.label === FIREBALL_LABEL)) {
    await g.logLoadOlder();
    shown = g.logGroups();
  }
  const logGroupsShown = [...shown].sort((a, b) => b.index - a.index);

  // -- 15. Save, close and reopen; then one more Ctrl+Z.
  const before = await capture(ctx);
  await g.key("Ctrl+S");
  const status = within(ctx.root).getByRole("contentinfo");
  const saved = await waitFor(() => within(status).getByText(/^Saved/), { timeout: 20_000 });
  const saveStatus = saved.textContent ?? "";
  const savedText = await ctx.savedFile();
  await ctx.restart();
  const activeBoardAfterRestart = ctx.session.getSnapshot().activeBoard;
  const after = await capture(ctx);
  const predicted = predictUndo(before.groups);
  if (predicted === undefined) throw new Error("play B: the captured log predicts no undo");
  await g.key("Ctrl+Z");
  const afterUndo = await allGroups(ctx);

  return {
    observed: {
      brennaAt,
      fireballCopy,
      fireballZone,
      targetsDropped,
      targetsNudged,
      zoneDroppedAt,
      zoneNudgedAt,
      rows,
      applyAllGroup,
      note,
      trapDie,
      trayText,
      discardShown,
      discardEnabled,
      copyAfterDiscard,
      freshCopy,
      g4DamageAfterApply,
      freshDmg,
      g4DamageAfterUndo,
      freshAppliedAfterUndo,
      g4SelectedBeforeDelete,
      g4AfterDelete,
      g4DieAfterDelete,
      logShown: logGroupsShown,
      saveStatus,
      savedText,
      before,
      after,
      activeBoardAfterRestart,
      predicted,
      afterUndo,
    },
  };
}
