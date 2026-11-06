/**
 * The walkthrough's first play half (vtt-nb8.10): DESIGN.md §8.4 steps
 * 7–11 as amended by vtt-nb8.2 (M6-D1, M6-D3), read as M6 plan decision Q3
 * states (the readings table of vtt-nb8.9), driven through the real app
 * with vtt-nb8.18's gestures from where `runPrep` left the table: the GM
 * board active, the select tool, M = [0, 0], the GM binder on Crypt at
 * M + [27, 5], every character's sheet (and Aldric's binder) expanded in its
 * token's contents list.
 *
 * Local helpers are built only from the `DriverContext` and `Gestures`.
 * `runPlayA` returns contract.ts's `PlayAResult` plus what it observed on
 * the way (cover counts, elements drawn, the disabled Apply's notice), for
 * its test; play B (vtt-nb8.11) continues from its end state: GM view, the
 * select tool, Crypt active.
 *
 * Gesture choices the bead leaves open, or where the merged UI decides:
 * - a token's contents list shows only while the token is selected
 *   (M6-D12), so the token is clicked before its list is used: Aldric's
 *   (step 8's collapses, step 10's binder entry) and G2's (step 11's die);
 * - Aldric's sheet and binder are collapsed in his token's list on the GM
 *   board before the marquee, so his binder's row is in view without
 *   scrolling in step 10. The other sheets stay expanded (nothing later
 *   needs them collapsed; their lists are hidden while unselected);
 * - the marquee runs from `[8, -1]` to `[18, 2.5]` on the GM board, which
 *   holds the four whole tokens and nothing else;
 * - the characters are dragged into room 1 in the order Aldric, Brenna,
 *   Corin, Dara;
 * - the tray and the strip are drawn with Fog unchecked and named in the
 *   inspector right after they are drawn (still selected);
 * - each marker is dragged out of the GM binder onto its slot, then its
 *   character's token is dropped on the marker's `of` editor, before the
 *   next marker (M6-D26);
 * - covers are counted under a camera showing the whole map
 *   (`MAP_CAMERA`), since a frame draws only the covers on screen.
 */
import { waitFor, within } from "@testing-library/react";
import type { ObjectId } from "@vtt/schema";
import { until } from "../support/authority";
import type {
  CameraTarget,
  CharacterName,
  DiceEntry,
  DriverContext,
  Gestures,
  LogGroupShown,
  PlayAResult,
  Point,
  PrepResult,
} from "./contract";
import { createGestures } from "./gestures";

const roll = (expr: string, n: number): DiceEntry => ({
  type: "roll",
  expr,
  dice: [n],
  dropped: [],
  total: n,
});

/**
 * Play A's rolls, after `PREP_DICE`: initiative (Aldric, Brenna, Corin,
 * Dara), Aldric's attack and damage, the goblin's die (§8.4 steps 9–11).
 */
export const PLAY_A_DICE: DiceEntry[] = [
  roll("1d20", 14),
  roll("1d20", 9),
  roll("1d20", 17),
  roll("1d20", 6),
  roll("1d20", 15),
  roll("1d8", 6),
  roll("1d20", 13),
];

/** The tray's sum (§8.4 step 9, FORMULAS §10), typed into its `text`. */
export const TRAY_FORMULA = '=sum(contents(this).where(tag has "die").value)';

/** Where the characters stand in room 1, relative to M (§8.4 step 8). */
export const ROOM1_SPOTS: Readonly<Record<CharacterName, Point>> = {
  Aldric: [2, 12],
  Brenna: [3, 12],
  Corin: [4, 12],
  Dara: [5, 12],
};

/** Aldric's step into room 2 and back (§8.4 step 8). */
export const ALDRIC_IN_ROOM2: Point = [9, 13];
export const ALDRIC_BACK: Point = [2, 13];

/** The tray and its four dice (§8.4 step 9), relative to M. */
export const TRAY_RECT: [Point, Point] = [
  [0, 17],
  [6, 20],
];
export const TRAY_DROPS: readonly Point[] = [
  [1, 18.5],
  [2, 18.5],
  [3, 18.5],
  [4, 18.5],
];

/** The initiative strip and its marker slots, in strip order (§8.4 step 9), relative to M. */
export const STRIP_RECT: [Point, Point] = [
  [8, 17],
  [20, 18],
];
export const STRIP_SLOTS: readonly Point[] = [
  [9, 17.5],
  [11, 17.5],
  [13, 17.5],
  [15, 17.5],
];

/** Where Aldric's binder is put down on Crypt (§8.4 step 10, Q3), relative to M. */
export const ALDRIC_BINDER_AT: Point = [27, 15];

/** A camera showing the whole 24 × 16 map in the 800 × 600 viewport. */
const MAP_CAMERA = (m: Point): CameraTarget => ({ center: [m[0] + 12, m[1] + 8], zoom: 0.45 });

const GM_BINDER = "gm_binder";
const COMMIT_MS = 10_000;
const NAMES: readonly CharacterName[] = ["Aldric", "Brenna", "Corin", "Dara"];

/** What play A saw on the way, for its test. */
export interface PlayAObserved {
  /** Step 7: covers drawn viewing Crypt as Aldric, before and after room 1 is revealed. */
  coversAtStart: number;
  coversAfterRoom1: number;
  /** Step 7: whether room 1 is covered in Aldric's view after its reveal. */
  room1CoveredAfter: boolean;
  /** Step 8: covers drawn as Aldric, and room 2 covered, with Aldric in room 2 and after he left. */
  coversAldricInRoom2: number;
  room2CoveredWithAldricIn: boolean;
  coversAldricBack: number;
  room2CoveredAfterLeaving: boolean;
  /** Step 9: the tray's `text` as the app showed it after the four rolls. */
  trayText: unknown;
  /** Step 10: the working copy's place and state right after the expand. */
  copyRightAfterTemplate: boolean;
  copyExpanded: boolean;
  copySelected: boolean;
  /** Step 10: G1's position before and after the drop on `target`. */
  g1Before: number[];
  g1After: number[];
  /** Step 10: the copy's `hit` element drawn in GM view after Roll. */
  hitShown: boolean;
  /** Step 10: whether Aldric's view (the app's, as Aldric) has G1's `ac`. */
  g1AcInAldricView: boolean;
  /** Step 10: G1's `hp` element drawn after Apply, and the text drawn at it. */
  g1HpShown: boolean;
  g1HpText: string[];
  /** Step 10: the Log tab's newest group after Apply. */
  applyGroup: LogGroupShown;
  /** Step 10: the Apply button after use: drawn, enabled, and the notice pressing it showed. */
  applyShownAfter: boolean;
  applyEnabledAfter: boolean;
  applyNotice: string;
  /** Step 10: the authority's revision before and after the disabled Apply was pressed. */
  revisionBeforeDisabledApply: number;
  revisionAfterDisabledApply: number;
  /** Step 11: Aldric's `hit` element drawn after the goblin's die was rolled on him. */
  aldricHitShown: boolean;
  /** Step 8: each character's board and position right after the move to Crypt, and in room 1. */
  movedToCrypt: Record<CharacterName, { board: ObjectId | null; position: number[] }>;
  inRoom1: Record<CharacterName, number[]>;
  /** Step 8: Aldric's position in room 2, and after he went back. */
  aldricInRoom2: number[];
  aldricBack: number[];
}

export interface PlayARun extends PlayAResult {
  observed: PlayAObserved;
}

// ---------------------------------------------------------------------------
// Reading the app's GM directory

type Cells = Record<string, { value: unknown }>;

function cellsOf(ctx: DriverContext, id: ObjectId): Cells {
  const view = ctx.session.directory().get(id);
  if (view === undefined) throw new Error(`play A: ${id} is not in the directory`);
  return view.cells as Cells;
}

/** A user cell's value in the app's own view of `id` (the directory holds structural cells only). */
function shownValue(ctx: DriverContext, id: ObjectId, cell: string): unknown {
  return ctx.session.objectView(id)?.cells[cell]?.value;
}

/** A number, or a roll's total (a rolled `value`, `roll` or `dmg` holds the roll). */
function numeric(v: unknown): number | null {
  const n = v as { type?: string; value?: unknown; total?: unknown } | undefined;
  if (n?.type === "number" && typeof n.value === "number") return n.value;
  if (n?.type === "roll" && typeof n.total === "number") return n.total;
  return null;
}

function numberOf(ctx: DriverContext, id: ObjectId, cell: string): number {
  const v = shownValue(ctx, id, cell);
  const n = numeric(v);
  if (n === null) throw new Error(`play A: ${id}.${cell} is not a number (${JSON.stringify(v)})`);
  return n;
}

function positionOf(ctx: DriverContext, id: ObjectId): number[] {
  const v = cellsOf(ctx, id).position?.value as { items?: { value?: unknown }[] } | undefined;
  return (v?.items ?? []).map((i) => Number(i.value));
}

function refOf(ctx: DriverContext, id: ObjectId, cell: string): ObjectId | null {
  const v = cellsOf(ctx, id)[cell]?.value as { type?: string; object?: string } | undefined;
  return v?.type === "ref" && v.object !== undefined ? v.object : null;
}

function refsOf(ctx: DriverContext, id: ObjectId, cell: string): ObjectId[] {
  const v = cellsOf(ctx, id)[cell]?.value as
    | { type?: string; items?: { type: string; object?: string }[] }
    | undefined;
  return v?.type === "list"
    ? (v.items ?? []).flatMap((i) => (i.type === "ref" && i.object ? [i.object] : []))
    : [];
}

/** The one selected object, after a gesture that selects what it made. */
function selected(ctx: DriverContext, what: string): ObjectId {
  const sel = ctx.ui.getState().selection;
  const [only] = sel;
  if (sel.length !== 1 || only === undefined) {
    throw new Error(`play A: expected ${what} selected, the selection is ${JSON.stringify(sel)}`);
  }
  return only;
}

const offset =
  (m: Point) =>
  (p: Point): Point => [m[0] + p[0], m[1] + p[1]];

// ---------------------------------------------------------------------------
// Local helpers over the DriverContext and Gestures

/**
 * Covers drawn and whether `room` is covered, viewing the whole map. Covers
 * are opaque (their key never names the zone), so `room`'s is the one whose
 * region is centred on the room's rect.
 */
async function coverState(
  ctx: DriverContext,
  g: Gestures,
  m: Point,
  rect: [number, number, number, number],
): Promise<{ covers: number; covered: boolean }> {
  await ctx.setCamera(MAP_CAMERA(m));
  await ctx.frame();
  const view = ctx.session.boardView();
  if (view === null) throw new Error("play A: the app shows no board");
  const [cx, cy] = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
  const covered = [...view.covers.values()].some((cover) => {
    const r = cover.region as { position?: number[] };
    const [x, y] = r.position ?? [];
    return x !== undefined && y !== undefined && Math.abs(x - cx) < 1e-6 && Math.abs(y - cy) < 1e-6;
  });
  return { covers: g.covers(), covered };
}

/** Texts the last frame drew whose box holds the viewport's centre (where `bringIntoView` centres). */
function textsAtCentre(ctx: DriverContext): string[] {
  const calls = ctx.renderer.calls;
  let start = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.name === "clearRect") {
      start = i;
      break;
    }
  }
  const { width, height } = ctx.ui.getState().viewport;
  const [cx, cy] = [width / 2, height / 2];
  return calls
    .slice(start)
    .filter(
      (c) =>
        c.name === "fillText" &&
        c.extent != null &&
        c.extent.minX <= cx &&
        cx <= c.extent.maxX &&
        c.extent.minY <= cy &&
        cy <= c.extent.maxY,
    )
    .map((c) => String(c.args[0]));
}

/** The text of the newest notice the app shows (`Notices`). */
async function newestNotice(ctx: DriverContext, matching: RegExp): Promise<string> {
  return waitFor(
    () => {
      const list = within(ctx.root).getByRole("list", { name: "Notices" });
      const texts = within(list)
        .getAllByRole("status")
        .map((li) => li.querySelector("span > span:last-child")?.textContent ?? "");
      const hit = texts.findLast((t) => matching.test(t));
      if (hit === undefined) throw new Error(`no notice ${matching} in ${JSON.stringify(texts)}`);
      return hit;
    },
    { timeout: COMMIT_MS },
  );
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
  if (known.has(copy)) throw new Error(`play A: dragging ${entry} spawned nothing`);
  return copy;
}

/** Waits until the app's view shows `id.cell` as `want`. */
async function shows(
  ctx: DriverContext,
  id: ObjectId,
  cell: string,
  want: number,
  what: string,
): Promise<void> {
  await until(
    () => {
      return numeric(shownValue(ctx, id, cell)) === want;
    },
    what,
    COMMIT_MS,
  );
}

// ---------------------------------------------------------------------------
// Play A

/** §8.4 steps 7–11 through the UI, continuing from `runPrep` (dice `[...PREP_DICE, ...PLAY_A_DICE]`). */
export async function runPlayA(ctx: DriverContext, prep: PrepResult): Promise<PlayARun> {
  const g = createGestures(ctx);
  const m = prep.mapOrigin;
  const at = offset(m);
  const room1 = prep.rooms[1].id;
  const room3 = prep.rooms[3].id;
  const pc = prep.characters;

  // -- 7. Crypt as Aldric: six covers. Room 1 revealed by hand: five.
  await g.showBoard("Crypt");
  await g.viewAs("Aldric");
  const coversAtStart = (await coverState(ctx, g, m, prep.rooms[1].rect)).covers;
  await g.viewAs("GM");
  await g.inspectorSet(room1, "visible_to", "all");
  await g.viewAs("Aldric");
  const afterRoom1 = await coverState(ctx, g, m, prep.rooms[1].rect);
  await g.viewAs("GM");

  // -- 8. The party into room 1; room 3 revealed by hand; room 2 reveals itself and re-hides.
  await g.showBoard("GM");
  // Aldric's list shows once he is selected; the other sheets stay expanded (see the
  // module comment).
  await g.click(pc.Aldric.token);
  await g.collapseEntry(pc.Aldric.token, pc.Aldric.binder);
  await g.collapseEntry(pc.Aldric.token, pc.Aldric.sheet);
  await g.marquee([8, -1], [18, 2.5]);
  const party = NAMES.map((n) => pc[n].token);
  await until(
    () => [...ctx.ui.getState().selection].sort().join() === [...party].sort().join(),
    "the four characters selected",
    COMMIT_MS,
  );
  await g.moveSelectionToBoard("Crypt");
  const movedToCrypt = {} as PlayAObserved["movedToCrypt"];
  for (const name of NAMES) {
    movedToCrypt[name] = {
      board: refOf(ctx, pc[name].token, "board"),
      position: positionOf(ctx, pc[name].token),
    };
  }
  for (const name of NAMES) await g.dragObject(pc[name].token, at(ROOM1_SPOTS[name]));
  const inRoom1 = {} as PlayAObserved["inRoom1"];
  for (const name of NAMES) inRoom1[name] = positionOf(ctx, pc[name].token);
  await g.inspectorSet(room3, "visible_to", "all");
  await g.dragObject(pc.Aldric.token, at(ALDRIC_IN_ROOM2));
  const aldricInRoom2 = positionOf(ctx, pc.Aldric.token);
  await g.viewAs("Aldric");
  const inRoom2 = await coverState(ctx, g, m, prep.rooms[2].rect);
  await g.viewAs("GM");
  await g.dragObject(pc.Aldric.token, at(ALDRIC_BACK));
  const aldricBack = positionOf(ctx, pc.Aldric.token);
  await g.viewAs("Aldric");
  const back = await coverState(ctx, g, m, prep.rooms[2].rect);
  await g.viewAs("GM");

  // -- 9. Initiative: a dice tray, four loose d20s rolled in it, markers lined up in a strip.
  const tray = await g.drawZone(at(TRAY_RECT[0]), at(TRAY_RECT[1]), { fog: false });
  await g.inspectorSet(tray, "name", "Tray");
  await g.inspectorAddCell(tray, "text", TRAY_FORMULA);
  const trayDice: ObjectId[] = [];
  for (const drop of TRAY_DROPS) {
    trayDice.push(await spawnEntry(ctx, g, GM_BINDER, "tpl_d20", at(drop)));
  }
  const rolls: number[] = [];
  for (const die of trayDice) {
    const before = ctx.gm.revision;
    await g.doubleClick(die);
    if (ctx.gm.revision === before)
      throw new Error(`play A: double-clicking ${die} rolled nothing`);
    rolls.push(numberOf(ctx, die, "value"));
  }
  const trayText = shownValue(ctx, tray, "text");
  // Bonuses added by eye from each sheet's dex_save.
  const totals = NAMES.map((name, i) => ({
    name,
    roll: rolls[i] as number,
    total: (rolls[i] as number) + numberOf(ctx, pc[name].sheet, "dex_save"),
  }));
  const initiative = [...totals].sort((a, b) => b.total - a.total);

  const strip = await g.drawZone(at(STRIP_RECT[0]), at(STRIP_RECT[1]), { fog: false });
  await g.inspectorSet(strip, "name", "Initiative");
  // One marker per character, highest first; the tokens stay on the map (M6-D26).
  const markers: ObjectId[] = [];
  for (const [i, entry] of initiative.entries()) {
    const marker = await spawnEntry(ctx, g, GM_BINDER, "tpl_marker", at(STRIP_SLOTS[i] as Point));
    await g.dropOnEditor(pc[entry.name as CharacterName].token, marker, "of");
    markers.push(marker);
  }

  // -- 10. Aldric attacks with a working copy of his Attack card.
  const aldricBinder = pc.Aldric.binder;
  await g.click(pc.Aldric.token);
  await g.dragObject(aldricBinder, at(ALDRIC_BINDER_AT));
  // The presses stay in GM view: the card is Aldric's, so they are his (M6-D15).
  await g.expandEntry(aldricBinder, pc.Aldric.attackTemplate);
  const attackCopy = selected(ctx, "the Attack card's working copy");
  const binderContents = refsOf(ctx, aldricBinder, "contents");
  const copyRightAfterTemplate =
    binderContents.indexOf(attackCopy) === binderContents.indexOf(pc.Aldric.attackTemplate) + 1;
  const copyExpanded = ctx.faceState.isExpanded(attackCopy, "collapsed");
  const copySelected = ctx.ui.getState().selection.join() === attackCopy;

  const g1 = ctx.byName("G1");
  const g1Before = positionOf(ctx, g1);
  await g.dropOnEditor(g1, attackCopy, "target");
  const g1After = positionOf(ctx, g1);

  await g.pressButton(attackCopy, "Roll");
  await g.bringIntoView({ object: attackCopy, element: { cell: "hit" } });
  const hitShown = g.elementShown(attackCopy, { cell: "hit" });
  // View as Aldric to check that `ac` is hidden, then back to GM view.
  await g.viewAs("Aldric");
  const g1AcInAldricView = ctx.session.objectView(g1)?.cells.ac !== undefined;
  await g.viewAs("GM");
  await g.pressButton(attackCopy, "Roll damage");
  await g.pressButton(attackCopy, "Apply");
  await shows(ctx, g1, "hp", 1, "G1's hp 1");
  await g.bringIntoView({ object: g1, element: { cell: "hp" } });
  const g1HpShown = g.elementShown(g1, { cell: "hp" });
  const g1HpText = textsAtCentre(ctx);

  await g.logLoadOlder();
  const groups = g.logGroups();
  const applyGroup = groups.reduce((a, b) => (b.index > a.index ? b : a));

  await g.bringIntoView({ object: attackCopy, element: { action: "Apply" } });
  const applyShownAfter = g.elementShown(attackCopy, { action: "Apply" });
  const applyEnabledAfter = g.elementEnabled(attackCopy, "Apply");
  const revisionBeforeDisabledApply = ctx.gm.revision;
  await g.pressButton(attackCopy, "Apply", { expectDisabled: true });
  await ctx.gm.request("log", { limit: 1 });
  const revisionAfterDisabledApply = ctx.gm.revision;
  const applyNotice = await newestNotice(ctx, /^Apply/);

  // -- 11. A goblin attacks back: G2's own die out of its list onto Aldric, rolled.
  await g.viewAs("GM");
  const g2 = ctx.byName("G2");
  const goblinDie = prep.goblinDice[1] as ObjectId;
  const aldricAt = positionOf(ctx, pc.Aldric.token) as Point;
  await g.click(g2);
  await g.dragObject(goblinDie, aldricAt);
  if (refsOf(ctx, g2, "contents").includes(goblinDie)) {
    throw new Error("play A: G2's die is still in G2's contents");
  }
  await g.doubleClick(goblinDie);
  await shows(ctx, goblinDie, "value", 13, "the goblin's die 13");
  await g.bringIntoView({ object: pc.Aldric.token, element: { cell: "hit" } });
  const aldricHitShown = g.elementShown(pc.Aldric.token, { cell: "hit" });

  const hp: Record<string, number> = {};
  for (const name of NAMES) hp[name] = numberOf(ctx, pc[name].token, "hp");
  for (const [i, id] of prep.goblins.entries()) hp[`G${i + 1}`] = numberOf(ctx, id, "hp");

  return {
    initiative,
    tray,
    strip,
    markers,
    trayDice,
    aldricBinder,
    attackCopy,
    goblinDie,
    hp,
    observed: {
      coversAtStart,
      coversAfterRoom1: afterRoom1.covers,
      room1CoveredAfter: afterRoom1.covered,
      coversAldricInRoom2: inRoom2.covers,
      room2CoveredWithAldricIn: inRoom2.covered,
      coversAldricBack: back.covers,
      room2CoveredAfterLeaving: back.covered,
      trayText,
      copyRightAfterTemplate,
      copyExpanded,
      copySelected,
      g1Before,
      g1After,
      hitShown,
      g1AcInAldricView,
      g1HpShown,
      g1HpText,
      applyGroup,
      applyShownAfter,
      applyEnabledAfter,
      applyNotice,
      revisionBeforeDisabledApply,
      revisionAfterDisabledApply,
      aldricHitShown,
      movedToCrypt,
      inRoom1,
      aldricInRoom2,
      aldricBack,
    },
  };
}
