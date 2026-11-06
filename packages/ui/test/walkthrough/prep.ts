/**
 * The walkthrough's prep (vtt-nb8.9): DESIGN.md §8.4 steps 1–6 as amended
 * by vtt-nb8.2 (M6-D1, M6-D3), read as M6 plan decision Q3 states, driven
 * through the real app with vtt-nb8.18's gestures. The one exception is
 * step 5's agent, which calls the real MCP tools (`ctx.startAgent`).
 *
 * Prep-only actions are local helpers built only from the `DriverContext`
 * and `Gestures`: the image tool (key I, a click, `ctx.pickFile`), the
 * inspector's Upload… (`ctx.pickFile`), ink strokes (key D, then `drag`)
 * and the inspector's Face section (Testing Library on `ctx.root`).
 *
 * `runPrep` returns contract.ts's `PrepResult` plus what the prep observed
 * on the way (the goblin's HIT badge with a die on it and after its
 * deletion, the Fireball card as the inspector showed it, the save status);
 * the play steps (vtt-nb8.10, vtt-nb8.11) start their dice with
 * `PREP_DICE`, the only roll prep makes.
 *
 * Gesture choices the bead leaves open, or where the merged UI decides:
 * - the map is imported with a click at `[12, 8]` on Crypt, so M is `[0, 0]`;
 * - the characters are made right to left (Dara first), each at its point;
 * - a token's contents list shows only while the token is selected (M6-D12),
 *   so the token is clicked before its list is used: a character's sheet
 *   entry (step 2), the goblin's list as a drop target (step 4) and
 *   Aldric's binder entry (step 5);
 * - each room is named, and rooms 2 and 4 given the re-hiding formula, in
 *   the inspector right after it is drawn (still selected), not in place;
 * - the goblin's die's `owner` is a structural cell, so it is set with the
 *   inspector like `modifier`, not added.
 */
import { readFile } from "node:fs/promises";
import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CRYPT_MAP, exampleAssetPath, GOBLIN_IMAGE } from "@vtt/fixtures";
import type { WireOp, WireValue } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import { until } from "../support/authority";
import type {
  CharacterName,
  DiceEntry,
  DriverContext,
  Gestures,
  Point,
  PrepResult,
  RoomNumber,
} from "./contract";
import { createGestures } from "./gestures";

/** The only roll prep makes: step 4's badge check, a d20 rolled onto the goblin (15). */
export const PREP_DICE: DiceEntry[] = [
  { type: "roll", expr: "1d20", dice: [15], dropped: [], total: 15 },
];

/** The HIT badge formula (§8.4 steps 2 and 4). */
export const HIT_FORMULA = '=any(on(this).where(tag has "d20").total >= ac)';

/** The re-hiding formula of rooms 2 and 4 (§8.4 step 3). */
export const REHIDE_FORMULA = '=if(len(contents(this).where(tag has "pc")) > 0, all, gm)';

/** The rooms that re-hide once no PC is in them (§8.4 step 3). */
export const REHIDING_ROOMS: readonly RoomNumber[] = [2, 4];

/** The four characters: board point on `gm_board` and sheet values (§8.4 step 2). */
export const CHARACTERS: readonly {
  name: CharacterName;
  at: Point;
  ac: number;
  max_hp: number;
  attack_bonus: number;
  dex_save: number;
}[] = [
  { name: "Aldric", at: [10, 0], ac: 16, max_hp: 24, attack_bonus: 5, dex_save: 1 },
  { name: "Brenna", at: [12, 0], ac: 18, max_hp: 30, attack_bonus: 6, dex_save: 0 },
  { name: "Corin", at: [14, 0], ac: 14, max_hp: 18, attack_bonus: 5, dex_save: 4 },
  { name: "Dara", at: [16, 0], ac: 12, max_hp: 16, attack_bonus: 4, dex_save: 2 },
];

/** Where the image tool is clicked on Crypt: the map's centre, so M is `[0, 0]`. */
const MAP_CLICK: Point = [12, 8];

/** G1–G8 drop points, relative to M: four in room 3, then four in room 5 (§8.4 step 4). */
export const GOBLIN_DROPS: readonly Point[] = [
  [14.5, 10.5],
  [15.5, 12],
  [14.5, 13.5],
  [18.5, 13.5],
  [11, 2.5],
  [12.5, 2.5],
  [11, 4.5],
  [12.5, 4.5],
];

/** The agent's name (step 5). */
export const AGENT_NAME = "walkthrough-agent";
export const ROOM4_LABEL = "Room 4: difficult terrain, hatched";
export const FIREBALL_LABEL = "Fireball for Aldric";

/** What the prep saw on the way, for its test. */
export interface PrepObserved {
  /** The goblin template's HIT element was drawn with the rolled die on it. */
  badgeShownWithDie: boolean;
  /** …and not drawn after the die was deleted. */
  badgeHiddenAfterDelete: boolean;
  /** The Fireball card's `dc`, `caster` and `damage_dice` as the inspector showed them before the GM's correction. */
  fireballInspector: { dc: string; caster: string; damage_dice: string };
  /** The status bar's save status after Ctrl+S. */
  saveStatus: string;
}

export interface PrepRun extends PrepResult {
  observed: PrepObserved;
}

const GM_BINDER = "gm_binder";
const COMMIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Reading the app's GM directory

type Cells = Record<string, { value: unknown }>;

function cellsOf(ctx: DriverContext, id: ObjectId): Cells {
  const view = ctx.session.directory().get(id);
  if (view === undefined) throw new Error(`prep: ${id} is not in the directory`);
  return view.cells as Cells;
}

function refsOf(ctx: DriverContext, id: ObjectId, cell: string): ObjectId[] {
  const v = cellsOf(ctx, id)[cell]?.value as
    | { type?: string; items?: { type: string; object?: string }[] }
    | undefined;
  return v?.type === "list"
    ? (v.items ?? []).flatMap((i) => (i.type === "ref" && i.object ? [i.object] : []))
    : [];
}

function tagsOf(ctx: DriverContext, id: ObjectId): string[] {
  const v = cellsOf(ctx, id).tag?.value as
    | { type?: string; items?: { type: string; value?: unknown }[] }
    | undefined;
  return v?.type === "list"
    ? (v.items ?? []).flatMap((i) => (typeof i.value === "string" ? [i.value] : []))
    : [];
}

function numbersOf(ctx: DriverContext, id: ObjectId, cell: string): number[] {
  const v = cellsOf(ctx, id)[cell]?.value as
    | { type?: string; items?: { value?: unknown }[] }
    | undefined;
  if (v?.type !== "list") throw new Error(`prep: ${id}.${cell} is not a list`);
  return (v.items ?? []).map((i) => Number(i.value));
}

/** The one selected object, after a gesture that selects what it made. */
function selected(ctx: DriverContext, what: string): ObjectId {
  const sel = ctx.ui.getState().selection;
  const [only] = sel;
  if (sel.length !== 1 || only === undefined) {
    throw new Error(`prep: expected ${what} selected, the selection is ${JSON.stringify(sel)}`);
  }
  return only;
}

/** Waits until the app's session has caught up with the authority. */
async function caughtUp(ctx: DriverContext): Promise<void> {
  await ctx.gm.request("log", { limit: 1 });
  const revision = ctx.gm.revision;
  await act(() => ctx.session.whenRevision(revision));
  await ctx.frame();
}

/** Waits for a commit after revision `before`, then for the app. */
async function committed(ctx: DriverContext, before: number, what: string): Promise<void> {
  await until(() => ctx.gm.revision > before, what, COMMIT_MS);
  await caughtUp(ctx);
}

const offset =
  (m: Point) =>
  (p: Point): Point => [m[0] + p[0], m[1] + p[1]];

// ---------------------------------------------------------------------------
// Prep-only helpers: chrome through Testing Library on ctx.root

type User = ReturnType<typeof userEvent.setup>;

function inspector(ctx: DriverContext): HTMLElement {
  return within(ctx.root).getByRole("complementary", { name: "Inspector panel" });
}

async function inspectorTab(ctx: DriverContext, user: User): Promise<void> {
  const tab = within(inspector(ctx)).getByRole("tab", { name: "Inspector" });
  if (tab.getAttribute("aria-selected") !== "true") await user.click(tab);
  await waitFor(() => {
    const t = within(inspector(ctx)).getByRole("tab", { name: "Inspector" });
    if (t.getAttribute("aria-selected") !== "true") throw new Error("the Inspector tab");
  });
}

/** The inspector's row of `cell` for the selected object. */
async function cellRow(ctx: DriverContext, cell: string): Promise<HTMLElement> {
  return waitFor(
    () => {
      const row = inspector(ctx).querySelector<HTMLElement>(
        `section[aria-label="Cells"] li[data-cell="${cell}"]`,
      );
      if (row === null) throw new Error(`no inspector row ${cell}`);
      return row;
    },
    { timeout: COMMIT_MS },
  );
}

/** The value of the selected object's `cell` as its inspector row shows it. */
async function inspectorShows(ctx: DriverContext, cell: string): Promise<string> {
  const row = await cellRow(ctx, cell);
  return row.querySelector('[data-part="value"]')?.textContent?.trim() ?? "";
}

/**
 * Adds a value element to the selected object's full face through the
 * inspector's Face section (vtt-1xv.18): Add value, then the cell picker,
 * `x y w h` and Show when, each its own `set_face` write.
 */
async function addFaceValue(
  ctx: DriverContext,
  user: User,
  object: ObjectId,
  element: { cell: string; rect: [number, number, number, number]; showWhen: string },
): Promise<void> {
  if (ctx.ui.getState().selection.join() !== object) {
    throw new Error(`addFaceValue: ${object} is not the selection`);
  }
  await inspectorTab(ctx, user);
  const face = () => within(inspector(ctx)).getByRole("region", { name: "Face" });
  const rows = () =>
    within(within(face()).getByRole("list", { name: "Full elements" })).queryAllByRole("listitem");
  const count = rows().length;
  let before = ctx.gm.revision;
  await user.click(within(face()).getByRole("button", { name: "Add value" }));
  await committed(ctx, before, "Add value");
  await waitFor(() => {
    if (rows().length !== count + 1) throw new Error("the new element row");
  });
  const row = () => rows()[count] as HTMLElement;

  before = ctx.gm.revision;
  await user.selectOptions(within(row()).getByRole("combobox", { name: "Cell" }), element.cell);
  await committed(ctx, before, `the element's cell ${element.cell}`);

  const fields: [string, string][] = [
    ["x", String(element.rect[0])],
    ["y", String(element.rect[1])],
    ["w", String(element.rect[2])],
    ["h", String(element.rect[3])],
    ["Show when", element.showWhen],
  ];
  for (const [label, text] of fields) {
    const box = within(row()).getByRole("textbox", { name: label }) as HTMLInputElement;
    if (box.value === text) continue;
    before = ctx.gm.revision;
    await user.clear(box);
    await user.paste(text);
    await user.keyboard("{Enter}");
    await committed(ctx, before, `the element's ${label} ${text}`);
  }
}

/** The inspector's Upload… on the selected object's `image` row, picking `file` (vtt-nb8.7). */
async function uploadImage(
  ctx: DriverContext,
  user: User,
  object: ObjectId,
  file: File,
): Promise<void> {
  if (ctx.ui.getState().selection.join() !== object) {
    throw new Error(`uploadImage: ${object} is not the selection`);
  }
  await inspectorTab(ctx, user);
  const row = await cellRow(ctx, "image");
  const before = ctx.gm.revision;
  ctx.pickFile(file);
  await user.click(within(row).getByRole("button", { name: "Upload…" }));
  await committed(ctx, before, `the image of ${object}`);
}

/** The image tool (key I), a click at `at` and `file` picked; resolves with the new image's id. */
async function importImage(
  ctx: DriverContext,
  g: Gestures,
  at: Point,
  file: File,
): Promise<ObjectId> {
  await g.key("i");
  await until(() => ctx.ui.getState().tool.id === "image", "the image tool", COMMIT_MS);
  const known = new Set(ctx.session.directory().keys());
  const before = ctx.gm.revision;
  ctx.pickFile(file);
  await g.drag(at, at);
  await committed(ctx, before, "the image imported");
  let made: ObjectId | undefined;
  await until(
    () => {
      made = [...ctx.session.directory().keys()].find((id) => !known.has(id));
      return made !== undefined;
    },
    "the imported image",
    COMMIT_MS,
  );
  return made as ObjectId;
}

/** Three ink strokes with the ink tool (key D), each one `drag`, each appended to what it is drawn on. */
async function inkStrokes(
  ctx: DriverContext,
  g: Gestures,
  strokes: readonly [Point, Point][],
): Promise<void> {
  await g.key("d");
  await until(() => ctx.ui.getState().tool.id === "ink", "the ink tool", COMMIT_MS);
  for (const [from, to] of strokes) {
    const before = ctx.gm.revision;
    await g.drag(from, to);
    await committed(ctx, before, "an ink stroke");
  }
  await g.key("v");
  await until(() => ctx.ui.getState().tool.id === "select", "the select tool", COMMIT_MS);
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
  if (known.has(copy)) throw new Error(`prep: dragging ${entry} spawned nothing`);
  return copy;
}

// ---------------------------------------------------------------------------
// The agent (step 5)

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
}

type Agent = Awaited<ReturnType<DriverContext["startAgent"]>>;

async function call<T>(agent: Agent, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await agent.mcp.callTool({ name, arguments: args })) as ToolResult;
  if (result.isError === true) {
    throw new Error(`prep: the agent's ${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent as T;
}

interface AgentView {
  id: ObjectId;
  cells: Record<string, { value: unknown }>;
}

const agentText = (v: AgentView, cell: string): unknown =>
  (v.cells[cell]?.value as { value?: unknown } | undefined)?.value;

const agentRef = (v: AgentView, cell: string): ObjectId => {
  const value = v.cells[cell]?.value as { type?: string; object?: string } | undefined;
  if (value?.type !== "ref" || value.object === undefined) {
    throw new Error(`prep: the agent read no reference in ${v.id}.${cell}`);
  }
  return value.object;
};

/**
 * §8.4 step 5's agent: room 4 made difficult terrain and hatched, then the
 * Fireball template in Aldric's binder (M5-D18's recipe) and Aldric's sheet
 * `spell_dc` 14, as two groups.
 */
async function runAgent(ctx: DriverContext, crypt: BoardId): Promise<void> {
  const agent = await ctx.startAgent(AGENT_NAME);
  try {
    const { zones } = await call<{ zones: { id: ObjectId; view: AgentView }[] }>(agent, "zones", {
      board: crypt,
    });
    const room4 = zones.find((z) => agentText(z.view, "name") === "Room 4");
    if (room4 === undefined) throw new Error("prep: the agent found no Room 4");
    const terrain: WireOp[] = [
      { type: "set_tag", object: room4.id, tags: ["difficult"] },
      {
        type: "set_value",
        object: room4.id,
        cell: "pattern",
        value: { type: "text", value: "hatch" },
      },
    ];
    await call(agent, "transact", {
      ops: terrain,
      base_revision: ctx.gm.revision,
      label: ROOM4_LABEL,
    });

    const listed = await call<{ objects: AgentView[] }>(agent, "list_objects", {
      filter: { name: "Aldric", is_character: true },
    });
    const [aldricListed] = listed.objects;
    if (listed.objects.length !== 1 || aldricListed === undefined) {
      throw new Error(`prep: the agent found ${listed.objects.length} characters named Aldric`);
    }
    const aldric = aldricListed.id;
    const contents = (
      aldricListed.cells.contents?.value as { items?: { object?: string }[] } | undefined
    )?.items?.flatMap((i) => (i.object === undefined ? [] : [i.object]));
    if (contents === undefined || contents.length === 0) {
      throw new Error("prep: the agent read no contents on Aldric");
    }
    const got = await call<{ revision: number; objects: AgentView[] }>(agent, "get_objects", {
      ids: [aldric, ...contents],
      cells: "all",
    });
    const aldricView = got.objects.find((o) => o.id === aldric);
    if (aldricView === undefined) throw new Error("prep: the agent could not read Aldric");
    const sheet = agentRef(aldricView, "sheet");
    const binder = got.objects.find((o) => {
      if (o.id === aldric) return false;
      const tags = o.cells.tag?.value as { items?: { value?: unknown }[] } | undefined;
      return tags?.items?.some((t) => t.value === "binder") === true;
    });
    if (binder === undefined) throw new Error("prep: the agent found no binder on Aldric");
    const binderOwner = binder.cells.owner?.value as WireValue | undefined;
    if (binderOwner?.type !== "ref" || binderOwner.object !== aldric) {
      throw new Error("prep: Aldric's binder is not owned by Aldric");
    }

    const fireball: WireOp[] = [
      {
        type: "spawn",
        template: "tpl_area_save",
        to: { type: "container", container: binder.id },
        as: "$fb",
      },
      { type: "set_template_flag", object: "$fb", value: true },
      {
        type: "set_value",
        object: "$fb",
        cell: "name",
        value: { type: "text", value: "Fireball" },
      },
      { type: "set_value", object: "$fb", cell: "caster", value: { type: "ref", object: aldric } },
      // M6-D15 (the MCP instructions): the card's owner is the binder's owner.
      { type: "set_value", object: "$fb", cell: "owner", value: binderOwner },
      {
        type: "set_value",
        object: "$fb",
        cell: "damage_dice",
        value: { type: "dice", expr: "8d6" },
      },
      { type: "set_value", object: sheet, cell: "spell_dc", value: { type: "number", value: 14 } },
    ];
    await call(agent, "transact", {
      ops: fireball,
      base_revision: got.revision,
      label: FIREBALL_LABEL,
    });
  } finally {
    await agent.close();
  }
}

// ---------------------------------------------------------------------------
// The prep

/** §8.4 steps 1–6 through the UI on a fresh `startWalkthrough` table (dice `PREP_DICE`). */
export async function runPrep(ctx: DriverContext): Promise<PrepRun> {
  const g = createGestures(ctx);
  const user = userEvent.setup({ delay: null });

  // -- 1. A new table: the GM board holds the stocked GM binder.
  if (ctx.session.getSnapshot().activeBoard !== "gm_board") {
    throw new Error("prep: the table does not open on the GM board");
  }

  // -- 2. The HIT badge on the character template, then four characters.
  await g.gear("tpl_character");
  await g.inspectorAddCell("tpl_character", "hit", HIT_FORMULA);
  await addFaceValue(ctx, user, "tpl_character", {
    cell: "hit",
    rect: [-0.5, -0.95, 1, 0.3],
    showWhen: "hit",
  });

  // Made right to left (Dara first, Aldric last), 2 units apart: each token's list
  // shows only while it is selected, so neighbours' lists never overlap.
  const characters = {} as PrepResult["characters"];
  for (const c of [...CHARACTERS].reverse()) {
    const token = await spawnEntry(ctx, g, GM_BINDER, "tpl_character", c.at);
    await g.editInPlace(token, "name", c.name);
    const contents = refsOf(ctx, token, "contents");
    const binder = contents.find((id) => tagsOf(ctx, id).includes("binder"));
    const sheet = contents.find((id) => id !== binder);
    if (binder === undefined || sheet === undefined) {
      throw new Error(`prep: ${c.name} has no sheet and binder`);
    }
    const [attackTemplate] = refsOf(ctx, binder, "contents");
    if (attackTemplate === undefined) throw new Error(`prep: ${c.name}'s binder is empty`);
    await g.click(token);
    await g.expandEntry(token, sheet);
    for (const cell of ["ac", "max_hp", "attack_bonus", "dex_save"] as const) {
      await g.editInPlace(sheet, cell, String(c[cell]));
    }
    characters[c.name] = { token, sheet, binder, attackTemplate };
  }

  // -- 3. Crypt: the map, six opaque rooms, the re-hiding formula, the GM binder beside the map.
  await g.addBoard("Crypt");
  const crypt = ctx.session.getSnapshot().boards.find((b) => b.name === "Crypt")?.id;
  if (crypt === undefined) throw new Error("prep: no Crypt board");
  const mapBytes = await readFile(exampleAssetPath(CRYPT_MAP.file));
  const map = await importImage(
    ctx,
    g,
    MAP_CLICK,
    new File([mapBytes], CRYPT_MAP.file, { type: "image/png" }),
  );
  const shape = cellsOf(ctx, map).shape?.value as
    | { shape?: { type: string; width?: number; height?: number } }
    | undefined;
  const [px, py] = numbersOf(ctx, map, "position");
  const w = shape?.shape?.width;
  const h = shape?.shape?.height;
  if (px === undefined || py === undefined || w === undefined || h === undefined) {
    throw new Error("prep: the map has no rect or position");
  }
  const mapOrigin: Point = [px - w / 2, py - h / 2];
  const at = offset(mapOrigin);
  const unit = 1 / CRYPT_MAP.px_per_unit;

  const rooms = {} as PrepResult["rooms"];
  for (const room of CRYPT_MAP.rooms) {
    const [x, y, rw, rh] = room.rect_px;
    const rect: [number, number, number, number] = [
      mapOrigin[0] + x * unit,
      mapOrigin[1] + y * unit,
      rw * unit,
      rh * unit,
    ];
    const id = await g.drawZone([rect[0], rect[1]], [rect[0] + rect[2], rect[1] + rect[3]], {
      fog: true,
    });
    rooms[room.n] = { id, rect };
    // Named (and given the re-hiding formula) in the inspector while the new zone is
    // selected: over the map a click or double-click reaches the map, since objects
    // are hit before zones (DESIGN §4.6), and the gestures have no Alt+click cycling.
    await g.inspectorSet(id, "name", `Room ${room.n}`);
    if (REHIDING_ROOMS.includes(room.n)) await g.inspectorSet(id, "visible_to", REHIDE_FORMULA);
  }
  await g.showBoard("GM");
  await g.click(GM_BINDER);
  await g.moveSelectionToBoard("Crypt");
  await g.dragObject(GM_BINDER, at([27, 5]));

  // -- 4. The goblin template, its badge checked with a rolled die, eight copies.
  const goblinTemplate = await spawnEntry(ctx, g, GM_BINDER, "tpl_token", at([-4, 8]));
  await g.editInPlace(goblinTemplate, "name", "Goblin");
  const goblinBytes = await readFile(exampleAssetPath(GOBLIN_IMAGE.file));
  await g.click(goblinTemplate);
  await uploadImage(
    ctx,
    user,
    goblinTemplate,
    new File([goblinBytes], GOBLIN_IMAGE.file, { type: "image/png" }),
  );
  await g.inspectorSet(goblinTemplate, "ac", "13");
  await g.inspectorCellVisibility(goblinTemplate, "ac", "gm");
  await g.inspectorSet(goblinTemplate, "max_hp", "7");
  await g.inspectorSet(goblinTemplate, "attack_bonus", "4");
  await g.inspectorSet(goblinTemplate, "dex_save", "2");
  await g.inspectorSet(goblinTemplate, "hit", HIT_FORMULA);
  await g.inspectorFlags(goblinTemplate, { character: true, template: true });

  // The badge check: a d20 dropped on the goblin and rolled (15 ≥ 13), then deleted.
  const badgeDie = await spawnEntry(ctx, g, GM_BINDER, "tpl_d20", at([-4, 8]));
  await g.doubleClick(badgeDie);
  await g.bringIntoView({ object: goblinTemplate, element: { cell: "hit" } });
  const badgeShownWithDie = g.elementShown(goblinTemplate, { cell: "hit" });
  await g.click(badgeDie);
  await g.key("Delete");
  await until(() => !ctx.session.directory().has(badgeDie), "the badge die deleted", COMMIT_MS);
  await g.bringIntoView(goblinTemplate);
  await ctx.frame();
  const badgeHiddenAfterDelete = !g.elementShown(goblinTemplate, { cell: "hit" });

  // The goblin's own attack die, in its contents list (shown while the goblin is selected).
  await g.click(goblinTemplate);
  await g.dragEntry(GM_BINDER, "tpl_d20", { object: goblinTemplate, contents: true });
  const [goblinDie] = refsOf(ctx, goblinTemplate, "contents");
  if (goblinDie === undefined) throw new Error("prep: no die in the goblin's contents");
  await g.inspectorSet(goblinDie, "owner", `@${goblinTemplate}`);
  await g.inspectorSet(goblinDie, "modifier", "=owner.attack_bonus");

  const goblins: ObjectId[] = [];
  const goblinDice: ObjectId[] = [];
  for (const [i, drop] of GOBLIN_DROPS.entries()) {
    const known = new Set(ctx.session.directory().keys());
    await g.dragObject(goblinTemplate, at(drop));
    const copy = selected(ctx, `the goblin copy ${i + 1}`);
    if (known.has(copy)) throw new Error("prep: dragging the goblin template spawned nothing");
    await g.inspectorSet(copy, "name", `G${i + 1}`);
    const [die] = refsOf(ctx, copy, "contents");
    if (die === undefined) throw new Error(`prep: G${i + 1} has no die`);
    goblins.push(copy);
    goblinDice.push(die);
  }

  // -- 5. The agent; the GM checks the Fireball card and corrects its DC.
  await runAgent(ctx, crypt);
  await caughtUp(ctx);
  const aldric = characters.Aldric;
  const fireballTemplate = refsOf(ctx, aldric.binder, "contents").find(
    (id) => id !== aldric.attackTemplate,
  );
  if (fireballTemplate === undefined) throw new Error("prep: no Fireball in Aldric's binder");
  await g.showBoard("GM");
  await g.click(aldric.token);
  await g.expandEntry(aldric.token, aldric.binder);
  await g.gear(fireballTemplate);
  await inspectorTab(ctx, user);
  const fireballInspector = {
    dc: await inspectorShows(ctx, "dc"),
    caster: await inspectorShows(ctx, "caster"),
    damage_dice: await inspectorShows(ctx, "damage_dice"),
  };
  await g.inspectorSet(fireballTemplate, "dc", "15");

  // -- 6. A sticky note made on Crypt, moved to the GM board, scribbled on in ink; save.
  await g.showBoard("Crypt");
  const note = await spawnEntry(ctx, g, GM_BINDER, "tpl_note", at([-4, 12]));
  await g.moveSelectionToBoard("GM");
  const [nx, ny] = numbersOf(ctx, note, "position");
  if (nx === undefined || ny === undefined) throw new Error("prep: the note has no position");
  await inkStrokes(ctx, g, [
    [
      [nx - 0.75, ny - 0.25],
      [nx + 0.75, ny - 0.25],
    ],
    [
      [nx - 0.75, ny + 0.25],
      [nx + 0.75, ny + 0.25],
    ],
    [
      [nx - 0.75, ny + 0.75],
      [nx + 0.75, ny + 0.5],
    ],
  ]);
  await g.key("Ctrl+S");
  const status = within(ctx.root).getByRole("contentinfo");
  const saved = await waitFor(() => within(status).getByText(/^Saved/), { timeout: 20_000 });
  const saveStatus = saved.textContent ?? "";

  return {
    characters,
    gmBinder: GM_BINDER,
    crypt,
    map,
    mapOrigin,
    unitsPerPx: 0.01,
    rooms,
    goblinTemplate,
    goblins,
    goblinDice,
    fireballTemplate,
    note,
    observed: { badgeShownWithDie, badgeHiddenAfterDelete, fireballInspector, saveStatus },
  };
}
