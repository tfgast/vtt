/**
 * M4 epic acceptance (vtt-3l6.18): DESIGN.md §8.4 prep steps 1–4 by hand,
 * minus binders, as interpreted by M4 plan Q19; §8.1; FORMULAS.md §10
 * ("Re-hiding a room when the party leaves", "A goblin that shows HIT when a
 * die on it beats its AC", "A die with a modifier"). The real composed
 * `<App>` runs in jsdom against an in-process authority on a temp table file
 * with the asset routes; every change is made by the GM's gestures
 * (prep-script.ts); a second GM protocol client checks the results.
 *
 * §8.4, sentence by sentence, and the block that covers it:
 *
 * 1. "Open a new table." → block 1. "The GM board is empty except for the
 *    GM binder, stocked with the example templates." → block 1 without the
 *    binder (Q19: the GM board is empty).
 * 2. "Add the HIT badge formula to the character template's token once." →
 *    block 2 (the template is made by hand: a token "PC" tagged `pc`, `hit`
 *    typed in the formula bar, Character and Template in the header).
 *    "Then drag the character template out four times." → block 2 (template
 *    drags on the GM board, not out of a binder). "Each creates a character
 *    object owning a sheet and a binder." → blocks 2 and 6: each copy holds
 *    its own "Sheet" note copy whose `owner` is that copy; no binder (Q19).
 *    "Name each character on its token, then fill in AC, HP, attack bonus and
 *    Dex save by typing into the sheet faces; each sheet's header shows its
 *    character's name." → block 2: the name in place on the canvas, `ac`,
 *    `hp`, `attack_bonus`, `dex_save` typed into the inspector (faces are
 *    M5). "Each binder already holds an Attack card template." → skipped
 *    (Q19).
 * 3. "Import the dungeon map as one image on a second board, "Crypt."" →
 *    block 3 (the image tool with the example crypt map). "Draw six opaque
 *    zones over the rooms, each `visible_to = gm`." → block 3 (rect zones
 *    with Fog). "Give rooms 2 and 4 the re-hiding formula; leave the rest
 *    manual." → block 3 (typed into `visible_to`), exercised in block 5.
 * 4. "Make a goblin template once: image, `ac` (GM-only cell), `max_hp`,
 *    `damage_taken`, `attack_bonus`, `dex_save`, the HIT badge formula, tag
 *    `creature`, and an owned attack d20 whose `modifier` follows the owner's
 *    attack bonus." → block 4 (the d20 is a contained token whose `owner` is
 *    the goblin, `modifier = owner.attack_bonus`, `total = value + modifier`).
 *    "Place eight: four in room 3, four in room 5." → block 4 (eight template
 *    drags on the GM board, a marquee, "Move selection to board…" Crypt, then
 *    drags into the rooms; M4 has no cross-board drag, review r1 finding 5).
 *
 * Block 5 checks the prep through the UI with fixed numbers (the PC used has
 * `ac` 13, the goblin `attack_bonus` 5): room 2 reveals itself while a PC is
 * inside and re-covers once it left; a goblin's die taken out and put on the
 * PC drives the PC's `hit` (9 + 5 ≥ 13 true, 7 + 5 < 13 false); viewing as
 * the PC draws six covers and no goblin. Block 6 checks every object, cell,
 * formula, tag, visibility entry, owner and containment through the
 * protocol; block 7 saves, closes and reopens the file.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fireEvent, screen, within } from "@testing-library/react";
import { TableHost } from "@vtt/authority";
import type { ProtocolClient, WireResult } from "@vtt/protocol";
import type { Bounds, Cell, ObjectId, Point, Snapshot, TableObject } from "@vtt/schema";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { until } from "../support/authority";
import {
  addCell,
  addCellWith,
  addTag,
  addVisibilityRule,
  altClickUntil,
  CRYPT_MAP_FILE,
  cellOf,
  chooseTool,
  click,
  coverFills,
  drag,
  editInPlace,
  GM_BOARD,
  GOBLIN_FILE,
  hasFormula,
  header,
  inspector,
  isNumber,
  isRef,
  isText,
  lastFrame,
  moveSelectionTo,
  newSelection,
  onBoard,
  type PrepApp,
  type PrepAuthority,
  pngFile,
  positionOf,
  pressEscape,
  RECT,
  refsOf,
  renderPrepApp,
  rowValue,
  screenOf,
  setFlag,
  settle,
  startPrepAuthority,
  texts,
  typeFormulaInBar,
  typeIntoRow,
  user,
  viewAs,
  wheel,
} from "./prep-script";

// ---------------------------------------------------------------------------
// The script's fixed inputs

/** FORMULAS.md §10, "A goblin that shows HIT when a die on it beats its AC". */
const HIT = 'any(on(this).where(tag has "d20").total >= ac)';
/** FORMULAS.md §10, "Re-hiding a room when the party leaves". */
const REHIDE = 'if(len(contents(this).where(tag has "pc")) > 0, all, gm)';
const MODIFIER = "owner.attack_bonus";
const TOTAL = "value + modifier";

/** One wheel step that zooms out to about half (1.1 per 100 px). */
const ZOOM_OUT = 728;

// The GM board (board units).
const PC_AT: Point = [-10, -6];
const SHEET_AT: Point = [-10, -2];
const PC_COPY_AT: Point[] = [
  [-8, 1.5],
  [-6, 1.5],
  [-4, 1.5],
  [-2, 1.5],
];
const PCS = [
  { name: "Aldric", ac: 13, hp: 12, attack_bonus: 5, dex_save: 1 },
  { name: "Brienne", ac: 16, hp: 14, attack_bonus: 4, dex_save: 0 },
  { name: "Cato", ac: 12, hp: 9, attack_bonus: 3, dex_save: 3 },
  { name: "Dara", ac: 14, hp: 10, attack_bonus: 4, dex_save: 4 },
];
const PC_CELLS = ["ac", "hp", "attack_bonus", "dex_save"] as const;
const GOBLIN_AT: Point = [-10, 5];
const DIE_AT: Point = [-7, 7];
const GOBLIN = { name: "Goblin", ac: 13, max_hp: 7, damage_taken: 0, attack_bonus: 5, dex_save: 2 };
const GOBLIN_CELLS = ["ac", "max_hp", "damage_taken", "attack_bonus", "dex_save"] as const;
const DIE_VALUE = 10;
const GOBLIN_COPY_AT: Point[] = [2, 4, 6, 8].flatMap((x): Point[] => [
  [x, 2],
  [x, 4],
]);
const MARQUEE: [Point, Point] = [
  [0.5, 0.5],
  [9.5, 5.5],
];

// The Crypt board: the example map (2400 × 1600 px, 100 px per unit) centered on 0,0.
const MAP_AT: Point = [0, 0];
const MAP_PX = { width: 2400, height: 1600 };
/** The rooms' pixel rectangles on the map (`CRYPT_MAP.rooms` of `@vtt/fixtures`). */
const ROOMS_PX: [number, number, number, number][] = [
  [100, 1100, 500, 400],
  [700, 1100, 500, 400],
  [1300, 900, 700, 600],
  [100, 100, 600, 600],
  [900, 100, 700, 600],
  [1800, 100, 500, 600],
];
const ROOMS: Bounds[] = ROOMS_PX.map(([x, y, w, h]) => ({
  minX: x / 100 - MAP_PX.width / 200,
  minY: y / 100 - MAP_PX.height / 200,
  maxX: (x + w) / 100 - MAP_PX.width / 200,
  maxY: (y + h) / 100 - MAP_PX.height / 200,
}));
const centerOf = (b: Bounds): Point => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
const room = (n: number) => ROOMS[n - 1] as Bounds;
/** Four spots in room 3 and four in room 5. */
const ROOM3_SPOTS: Point[] = [2, 3.5, 5, 6.5].map((x): Point => [x, 5.5]);
const ROOM5_SPOTS: Point[] = [-2, -0.5, 1, 2.5].map((x): Point => [x, -4]);
/** On the map, outside all six rooms. */
const OUTSIDE: Point = [-2, 1.5];
const ROOM2_INSIDE: Point = centerOf(room(2));

const inside = (b: Bounds, [x, y]: Point) =>
  x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
const near = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

// ---------------------------------------------------------------------------
// Shared state: one table, prepared block by block.

let authority: PrepAuthority;
let app: PrepApp;
let gm: ProtocolClient;

const ids = {
  pc: "" as ObjectId,
  sheet: "" as ObjectId,
  pcCopies: [] as ObjectId[],
  sheetCopies: [] as ObjectId[],
  crypt: "",
  map: "" as ObjectId,
  rooms: [] as ObjectId[],
  goblin: "" as ObjectId,
  die: "" as ObjectId,
  goblinCopies: [] as ObjectId[],
  dieCopies: [] as ObjectId[],
};
/** Asset paths uploaded by the image tool. */
const assets = { map: "", goblin: "" };

beforeAll(async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    x: 0,
    y: 0,
    right: RECT.width,
    bottom: RECT.height,
    toJSON: () => ({}),
  });
  localStorage.clear();
  authority = await startPrepAuthority();
  gm = await authority.client("checker");
});

afterAll(async () => {
  app?.unmount();
  vi.restoreAllMocks();
  await authority?.cleanup();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Protocol helpers (the second GM client)

async function views(list: readonly ObjectId[]) {
  const result = await gm.request("get_objects", { ids: [...list] });
  expect(result.missing).toEqual([]);
  return new Map(result.objects.map((o) => [o.id, o]));
}

async function protocolValue(id: ObjectId, cell: string): Promise<WireResult | undefined> {
  return (await views([id])).get(id)?.cells[cell]?.value;
}

async function documentNow(): Promise<Snapshot> {
  return (await gm.request("document", {})).snapshot;
}

const lit = (cell: Cell | undefined) => cell?.content;
const num = (value: number) => ({ type: "number", value });
const text = (value: string) => ({ type: "text", value });
const ref = (object: ObjectId) => ({ type: "ref", object });
const formula = (source: string) => ({ type: "formula", source });
const bool = (value: boolean) => ({ type: "boolean", value });
const gmOnly = { type: "viewers", viewers: ["gm"] };

/** Waits until the app's GM view of `zone`'s `visible_to` is exactly `word`, then asks the protocol. */
async function visibleToIs(zone: ObjectId, word: "all" | "gm"): Promise<void> {
  await until(() => {
    const v = cellOf(app, zone, "visible_to");
    return v?.type === "viewers" && v.viewers.length === 1 && v.viewers[0] === word;
  }, `${zone}.visible_to = ${word}`);
  expect(await protocolValue(zone, "visible_to")).toEqual({ type: "viewers", viewers: [word] });
}

/** Waits until the app's view of `id.hit` is `value`, then asks the protocol. */
async function hitIs(id: ObjectId, value: boolean): Promise<void> {
  await until(() => {
    const v = cellOf(app, id, "hit");
    return v?.type === "boolean" && v.value === value;
  }, `${id}.hit = ${value}`);
  expect(await protocolValue(id, "hit")).toEqual(bool(value));
}

/** The device boxes of the cover fills in the newest frame, once there are `n`. */
async function coversDrawn(n: number): Promise<Bounds[]> {
  await until(() => coverFills(lastFrame(app)).length === n, `${n} covers drawn`);
  return coverFills(lastFrame(app)).map((c) => c.extent as Bounds);
}

const covering = (boxes: Bounds[], p: Point) => boxes.some((b) => inside(b, screenOf(app, p)));

// ---------------------------------------------------------------------------

describe("§8.4 prep steps 1–4 by hand, minus binders", () => {
  test("1. a new table: the GM board exists and is empty", { timeout: 15_000 }, async () => {
    app = await renderPrepApp(authority);
    const tab = await screen.findByRole("tab", { name: "GM" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const tabs = within(screen.getByRole("tablist", { name: "Boards" })).getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    await onBoard(app, GM_BOARD);
    expect(app.session.boardView()?.objects.size).toBe(0);
    expect((await gm.request("list_objects", {})).objects).toEqual([]);
    expect((await documentNow()).boards.map((b) => b.id)).toEqual([GM_BOARD]);

    // Zoom out once so the prep fits the canvas.
    wheel(app, ZOOM_OUT);
    await settle();
    expect(app.ui.getState().camera.zoom).toBeCloseTo(0.5, 2);
  });

  test("2. the character template, copied four times and filled in", {
    timeout: 30_000,
  }, async () => {
    // A token, named "PC" in place.
    chooseTool("Token");
    click(app, PC_AT);
    const pc = await newSelection(app, "token_", "the PC token");
    ids.pc = pc;
    await until(() => app.ui.getState().tool.id === "select", "the select tool");
    await editInPlace(app, pc, PC_AT, "name", "PC");

    // Tag `pc`, the HIT badge in the formula bar, the cells the copies fill in.
    await addTag(app, pc, "pc");
    await addCell(app, pc, "hit");
    await typeFormulaInBar(app, pc, "hit", HIT);
    for (const cell of PC_CELLS) await addCell(app, pc, cell);

    // A character template (header toggles).
    await setFlag(app, pc, "Character");
    await setFlag(app, pc, "Template");

    // A "Sheet" note Alt-dropped into it, its `owner` written as @<pc>.
    chooseTool("Note");
    click(app, SHEET_AT);
    const sheet = await newSelection(app, "note_", "the sheet note");
    ids.sheet = sheet;
    await header(sheet);
    await typeIntoRow(app, sheet, "name", "Sheet", isText("Sheet"));
    drag(app, SHEET_AT, PC_AT, { altKey: true });
    await until(() => refsOf(cellOf(app, pc, "contents")).includes(sheet), "the sheet in the PC");
    expect(cellOf(app, sheet, "container")).toEqual(ref(pc));
    // Containment does not set ownership: select the sheet in the PC's contents list.
    click(app, PC_AT);
    await header(pc);
    const contents = within(inspector()).getByRole("region", { name: "Contents" });
    await user.click(within(contents).getByRole("button", { name: "Sheet" }));
    await header(sheet);
    expect(await rowValue("owner")).toBe("empty");
    await typeIntoRow(app, sheet, "owner", `@${pc}`, isRef(pc));

    // Four template drags on the GM board.
    for (const at of PC_COPY_AT) {
      drag(app, PC_AT, at);
      ids.pcCopies.push(await newSelection(app, `${pc}_`, "the PC copy", ids.pcCopies));
    }
    for (const [i, copy] of ids.pcCopies.entries()) {
      expect(near(positionOf(app, copy), PC_COPY_AT[i] as Point)).toBe(true);
      const [sheetCopy] = refsOf(cellOf(app, copy, "contents"));
      expect(sheetCopy).toMatch(new RegExp(`^${sheet}_\\d+$`));
      ids.sheetCopies.push(sheetCopy as ObjectId);
    }

    // Each copy: the name in place, the numbers in the inspector.
    for (const [i, copy] of ids.pcCopies.entries()) {
      const at = PC_COPY_AT[i] as Point;
      const values = PCS[i] as (typeof PCS)[number];
      click(app, at);
      await header(copy);
      await editInPlace(app, copy, at, "name", values.name);
      for (const cell of PC_CELLS) {
        await typeIntoRow(app, copy, cell, String(values[cell]), isNumber(values[cell]));
      }
      // The HIT badge shows in the inspector (no d20 on the character yet).
      expect(await rowValue("hit")).toBe("false");
      // Its sheet copy's `owner` reads the character's name (faces are M5).
      const held = within(inspector()).getByRole("region", { name: "Contents" });
      await user.click(within(held).getByRole("button", { name: "Sheet" }));
      await header(ids.sheetCopies[i] as ObjectId);
      expect(await rowValue("owner")).toBe(`${values.name} (${copy})`);
    }
  });

  test("3. the Crypt board: the map, six fog rooms, re-hiding rooms 2 and 4", {
    timeout: 30_000,
  }, async () => {
    await user.click(screen.getByRole("button", { name: "New board" }));
    await user.type(screen.getByRole("textbox", { name: "Board name" }), "Crypt{Enter}");
    await until(
      () => app.session.getSnapshot().boards.some((b) => b.name === "Crypt"),
      "the Crypt board",
    );
    ids.crypt = app.session.getSnapshot().boards.find((b) => b.name === "Crypt")?.id ?? "";
    await onBoard(app, ids.crypt);
    expect(screen.getByRole("tab", { name: "Crypt" }).getAttribute("aria-selected")).toBe("true");
    wheel(app, ZOOM_OUT);
    await settle();

    // The image tool imports the map (the picker is injected).
    app.picks.push(await pngFile(CRYPT_MAP_FILE, "crypt-map.png"));
    chooseTool("Image");
    click(app, MAP_AT);
    ids.map = await newSelection(app, "image_", "the map image");
    const image = cellOf(app, ids.map, "image");
    expect(image?.type).toBe("text");
    assets.map = (image as { value: string }).value;
    expect(authority.host.assets).toContain(assets.map);

    // Six fog rect zones over the rooms; rooms 2 and 4 re-hide.
    for (const [i, bounds] of ROOMS.entries()) {
      chooseTool("Rectangle zone");
      const fog = screen.getByRole("checkbox", { name: "Fog" }) as HTMLInputElement;
      if (!fog.checked) fireEvent.click(fog);
      expect(fog.checked).toBe(true);
      drag(app, [bounds.minX, bounds.minY], [bounds.maxX, bounds.maxY]);
      const zone = await newSelection(app, "zone_", `room ${i + 1}`, ids.rooms);
      ids.rooms.push(zone);
      await header(zone);
      await typeIntoRow(app, zone, "name", `Room ${i + 1}`, isText(`Room ${i + 1}`));
      if (i === 1 || i === 3) {
        await typeIntoRow(app, zone, "visible_to", `=${REHIDE}`, () =>
          hasFormula(app, zone, "visible_to", REHIDE),
        );
      }
    }
  });

  test("4. the goblin template, eight copies moved to Crypt, four in room 3 and four in room 5", {
    timeout: 40_000,
  }, async () => {
    await user.click(screen.getByRole("tab", { name: "GM" }));
    await onBoard(app, GM_BOARD);

    // The goblin: an image with its cells, `ac` GM-only, the HIT badge, tag `creature`.
    app.picks.push(await pngFile(GOBLIN_FILE, "goblin.png"));
    chooseTool("Image");
    click(app, GOBLIN_AT);
    const goblin = await newSelection(app, "image_", "the goblin image", [ids.map]);
    ids.goblin = goblin;
    assets.goblin = (cellOf(app, goblin, "image") as { value: string }).value;
    await header(goblin);
    await typeIntoRow(app, goblin, "name", GOBLIN.name, isText(GOBLIN.name));
    for (const cell of GOBLIN_CELLS) {
      await addCellWith(app, goblin, cell, String(GOBLIN[cell]), isNumber(GOBLIN[cell]));
    }
    await addVisibilityRule(app, goblin, "ac", "gm");
    await addCell(app, goblin, "hit");
    await typeFormulaInBar(app, goblin, "hit", HIT);
    await addTag(app, goblin, "creature");

    // Its attack d20: a token named in place, tagged, owned by the goblin.
    chooseTool("Token");
    click(app, DIE_AT);
    const die = await newSelection(app, "token_", "the die token", [ids.pc]);
    ids.die = die;
    await header(die);
    await editInPlace(app, die, DIE_AT, "name", "d20");
    await addTag(app, die, "die");
    await addTag(app, die, "d20");
    await typeIntoRow(app, die, "owner", `@${goblin}`, isRef(goblin));
    await addCellWith(app, die, "value", String(DIE_VALUE), isNumber(DIE_VALUE));
    await addCell(app, die, "modifier");
    await typeIntoRow(app, die, "modifier", `=${MODIFIER}`, () =>
      hasFormula(app, die, "modifier", MODIFIER),
    );
    await addCell(app, die, "total");
    await typeFormulaInBar(app, die, "total", TOTAL);
    await until(() => isNumber(GOBLIN.attack_bonus)(cellOf(app, die, "modifier")), "modifier");
    expect(await rowValue("total")).toBe(String(DIE_VALUE + GOBLIN.attack_bonus));

    // Alt-dropped into the goblin, which becomes a template.
    drag(app, DIE_AT, GOBLIN_AT, { altKey: true });
    await until(
      () => refsOf(cellOf(app, goblin, "contents")).includes(die),
      "the die in the goblin",
    );
    click(app, GOBLIN_AT);
    await header(goblin);
    await setFlag(app, goblin, "Template");

    // Eight template drags on the GM board.
    for (const at of GOBLIN_COPY_AT) {
      drag(app, GOBLIN_AT, at);
      ids.goblinCopies.push(
        await newSelection(app, `${goblin}_`, "the goblin copy", ids.goblinCopies),
      );
    }
    for (const copy of ids.goblinCopies) {
      const [dieCopy] = refsOf(cellOf(app, copy, "contents"));
      expect(dieCopy).toMatch(new RegExp(`^${die}_\\d+$`));
      ids.dieCopies.push(dieCopy as ObjectId);
    }

    // A marquee selects the eight; "Move selection to board…" → Crypt.
    drag(app, MARQUEE[0], MARQUEE[1]);
    await until(() => app.ui.getState().selection.length === 8, "the marquee selection");
    expect(new Set(app.ui.getState().selection)).toEqual(new Set(ids.goblinCopies));
    await moveSelectionTo(app, "Crypt", ids.crypt);
    expect(new Set(app.ui.getState().selection)).toEqual(new Set(ids.goblinCopies));

    // On Crypt: four dragged into room 3, four into room 5.
    const spots = [...ROOM3_SPOTS, ...ROOM5_SPOTS];
    for (const [i, copy] of ids.goblinCopies.entries()) {
      const to = spots[i] as Point;
      // Escape clears the selection, so no selected goblin's handles lie under the press.
      pressEscape(app);
      drag(app, positionOf(app, copy), to);
      await until(() => near(positionOf(app, copy), to), `${copy} placed`);
    }
    for (const [i, copy] of ids.goblinCopies.entries()) {
      expect(inside(room(i < 4 ? 3 : 5), positionOf(app, copy))).toBe(true);
    }
  });

  test("5. checks: room 2 re-hides; the goblin's die drives the PC's HIT; six covers, no goblin", {
    timeout: 40_000,
  }, async () => {
    const aldric = ids.pcCopies[0] as ObjectId;
    const room2 = ids.rooms[1] as ObjectId;

    // The PC (ac 13) moved to Crypt with "Move selection to board…", placed outside all rooms.
    await user.click(screen.getByRole("tab", { name: "GM" }));
    await onBoard(app, GM_BOARD);
    click(app, PC_COPY_AT[0] as Point);
    await header(aldric);
    await moveSelectionTo(app, "Crypt", ids.crypt);
    drag(app, positionOf(app, aldric), OUTSIDE);
    await until(() => near(positionOf(app, aldric), OUTSIDE), "Aldric outside the rooms");
    await visibleToIs(room2, "gm");

    // Viewing as the PC: every room is covered.
    await viewAs(app, "Aldric", `character:${aldric}`);
    expect(covering(await coversDrawn(6), ROOM2_INSIDE)).toBe(true);
    await viewAs(app, "GM", "gm");

    // Into room 2: it reveals itself to the PC.
    drag(app, OUTSIDE, ROOM2_INSIDE);
    await until(() => near(positionOf(app, aldric), ROOM2_INSIDE), "Aldric in room 2");
    await visibleToIs(room2, "all");
    await viewAs(app, "Aldric", `character:${aldric}`);
    expect(covering(await coversDrawn(5), ROOM2_INSIDE)).toBe(false);
    await viewAs(app, "GM", "gm");

    // Out again to an uncovered spot outside all rooms: room 2 is covered again.
    drag(app, ROOM2_INSIDE, OUTSIDE);
    await until(() => near(positionOf(app, aldric), OUTSIDE), "Aldric out of room 2");
    await visibleToIs(room2, "gm");
    await viewAs(app, "Aldric", `character:${aldric}`);
    expect(covering(await coversDrawn(6), ROOM2_INSIDE)).toBe(true);
    await viewAs(app, "GM", "gm");

    // The goblin's die: "Take out", then dragged onto the PC.
    const goblin = ids.goblinCopies[0] as ObjectId;
    const die = ids.dieCopies[0] as ObjectId;
    const goblinAt = positionOf(app, goblin);
    click(app, goblinAt);
    await header(goblin);
    const contents = within(inspector()).getByRole("region", { name: "Contents" });
    await user.click(within(contents).getByRole("button", { name: "Take out d20" }));
    await until(() => isRef(ids.crypt)(cellOf(app, die, "board")), "the die on Crypt");
    const out = positionOf(app, die);
    expect(near(out, [goblinAt[0] + 1, goblinAt[1]])).toBe(true);
    drag(app, out, OUTSIDE);
    await until(() => near(positionOf(app, die), OUTSIDE), "the die on the PC");
    await header(die);

    // 9 + 5 = 14 ≥ 13: HIT.
    await typeIntoRow(app, die, "value", "9", isNumber(9));
    await hitIs(aldric, true);
    expect(await protocolValue(die, "total")).toEqual(num(14));
    await altClickUntil(app, OUTSIDE, aldric);
    await header(aldric);
    expect(await rowValue("hit")).toBe("true");

    // 7 + 5 = 12 < 13: no HIT.
    await altClickUntil(app, OUTSIDE, die);
    await header(die);
    await typeIntoRow(app, die, "value", "7", isNumber(7));
    await hitIs(aldric, false);
    expect(await protocolValue(die, "total")).toEqual(num(12));
    await altClickUntil(app, OUTSIDE, aldric);
    await header(aldric);
    expect(await rowValue("hit")).toBe("false");

    // The GM sees the goblins; viewing as the PC (the PC and the die outside
    // all rooms): six covers and no goblin.
    await until(() => texts(lastFrame(app)).includes(GOBLIN.name), "goblin labels in the GM view");
    await viewAs(app, "Aldric", `character:${aldric}`);
    const covers = await coversDrawn(6);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(covering(covers, centerOf(room(n)))).toBe(true);
    expect(texts(lastFrame(app))).not.toContain(GOBLIN.name);
    const visible = [...(app.session.boardView()?.objects.keys() ?? [])];
    for (const copy of ids.goblinCopies) expect(visible).not.toContain(copy);
    expect(visible).toContain(aldric);
    await viewAs(app, "GM", "gm");
  });

  test("6. every object, cell, formula, tag, visibility entry, owner and containment, through the protocol", async () => {
    const doc = await documentNow();
    const obj = (id: ObjectId): TableObject => {
      const o = doc.objects[id];
      if (o === undefined) throw new Error(`${id} is missing`);
      return o;
    };

    // Readable ids (id_base for created objects, `<original>_<n>` for copies).
    expect(ids.pc).toMatch(/^token_\d+$/);
    expect(ids.die).toMatch(/^token_\d+$/);
    expect(ids.sheet).toMatch(/^note_\d+$/);
    expect(ids.map).toMatch(/^image_\d+$/);
    expect(ids.goblin).toMatch(/^image_\d+$/);
    for (const id of ids.rooms) expect(id).toMatch(/^zone_\d+$/);
    expect(doc.boards.map((b) => b.id)).toEqual([GM_BOARD, ids.crypt]);
    expect(doc.boards[1]?.name).toBe("Crypt");

    // The character template and its sheet.
    const pc = obj(ids.pc);
    expect(pc).toMatchObject({ is_template: true, is_character: true, tag: ["pc"] });
    expect(pc.board).toBe(GM_BOARD);
    expect(lit(pc.cells.name)).toEqual(text("PC"));
    expect(lit(pc.cells.hit)).toEqual(formula(HIT));
    for (const cell of PC_CELLS) expect(lit(pc.cells[cell])).toEqual({ type: "empty" });
    expect(pc.contents).toEqual([ids.sheet]);
    const sheet = obj(ids.sheet);
    expect(sheet.board).toBeNull();
    expect(lit(sheet.cells.name)).toEqual(text("Sheet"));
    expect(lit(sheet.cells.owner)).toEqual(ref(ids.pc));

    // The four characters, each holding its own sheet copy, owned by it.
    for (const [i, id] of ids.pcCopies.entries()) {
      const values = PCS[i] as (typeof PCS)[number];
      const copy = obj(id);
      expect(copy).toMatchObject({ is_template: false, is_character: true, tag: ["pc"] });
      expect(copy.board).toBe(i === 0 ? ids.crypt : GM_BOARD);
      expect(lit(copy.cells.template)).toEqual(ref(ids.pc));
      expect(lit(copy.cells.name)).toEqual(text(values.name));
      expect(lit(copy.cells.hit)).toEqual(formula(HIT));
      for (const cell of PC_CELLS) expect(lit(copy.cells[cell])).toEqual(num(values[cell]));
      expect(copy.contents).toEqual([ids.sheetCopies[i]]);
      const sheetCopy = obj(ids.sheetCopies[i] as ObjectId);
      expect(lit(sheetCopy.cells.owner)).toEqual(ref(id));
      expect(lit(sheetCopy.cells.template)).toEqual(ref(ids.sheet));
      expect(lit(sheetCopy.cells.name)).toEqual(text("Sheet"));
    }

    // The map and the rooms.
    const map = obj(ids.map);
    expect(map.board).toBe(ids.crypt);
    expect(map.shape).toEqual({ type: "rect", width: 24, height: 16 });
    expect(lit(map.cells.image)).toEqual(text(assets.map));
    expect(lit(map.cells.name)).toEqual(text("crypt-map"));
    for (const [i, id] of ids.rooms.entries()) {
      const zone = obj(id);
      const b = ROOMS[i] as Bounds;
      expect(zone).toMatchObject({ is_zone: true, board: ids.crypt });
      expect(zone.shape?.type).toBe("rect");
      const shape = zone.shape as { width: number; height: number };
      expect(shape.width).toBeCloseTo(b.maxX - b.minX, 6);
      expect(shape.height).toBeCloseTo(b.maxY - b.minY, 6);
      expect(lit(zone.cells.name)).toEqual(text(`Room ${i + 1}`));
      expect(lit(zone.cells.opaque)).toEqual(bool(true));
      expect(lit(zone.cells.visible_to)).toEqual(i === 1 || i === 3 ? formula(REHIDE) : gmOnly);
    }

    // The goblin template and its d20.
    const goblin = obj(ids.goblin);
    expect(goblin).toMatchObject({ is_template: true, is_character: false, tag: ["creature"] });
    expect(lit(goblin.cells.image)).toEqual(text(assets.goblin));
    expect(lit(goblin.cells.name)).toEqual(text(GOBLIN.name));
    for (const cell of GOBLIN_CELLS) expect(lit(goblin.cells[cell])).toEqual(num(GOBLIN[cell]));
    expect(lit(goblin.cells.hit)).toEqual(formula(HIT));
    expect(goblin.cell_visibility).toEqual({ ac: gmOnly });
    expect(goblin.contents).toEqual([ids.die]);
    const die = obj(ids.die);
    expect(die.tag).toEqual(["die", "d20"]);
    expect(lit(die.cells.name)).toEqual(text("d20"));
    expect(lit(die.cells.owner)).toEqual(ref(ids.goblin));
    expect(lit(die.cells.value)).toEqual(num(DIE_VALUE));
    expect(lit(die.cells.modifier)).toEqual(formula(MODIFIER));
    expect(lit(die.cells.total)).toEqual(formula(TOTAL));

    // The eight goblins and their dice.
    for (const [i, id] of ids.goblinCopies.entries()) {
      const copy = obj(id);
      expect(copy).toMatchObject({ is_template: false, board: ids.crypt, tag: ["creature"] });
      expect(lit(copy.cells.template)).toEqual(ref(ids.goblin));
      expect(copy.cell_visibility).toEqual({ ac: gmOnly });
      const dieCopy = obj(ids.dieCopies[i] as ObjectId);
      expect(dieCopy.tag).toEqual(["die", "d20"]);
      expect(lit(dieCopy.cells.owner)).toEqual(ref(id));
      expect(lit(dieCopy.cells.template)).toEqual(ref(ids.die));
      expect(lit(dieCopy.cells.modifier)).toEqual(formula(MODIFIER));
      expect(lit(dieCopy.cells.total)).toEqual(formula(TOTAL));
      if (i === 0) {
        // Taken out onto the PC in block 5.
        expect(copy.contents).toEqual([]);
        expect(dieCopy.board).toBe(ids.crypt);
        expect(lit(dieCopy.cells.value)).toEqual(num(7));
      } else {
        expect(copy.contents).toEqual([ids.dieCopies[i]]);
        expect(lit(dieCopy.cells.value)).toEqual(num(DIE_VALUE));
      }
    }

    // Evaluated: each die's modifier follows its goblin; its total is value + modifier.
    const dice = await views(ids.dieCopies);
    const goblins = await views(ids.goblinCopies);
    for (const [i, id] of ids.dieCopies.entries()) {
      const owner = goblins.get(ids.goblinCopies[i] as ObjectId);
      const view = dice.get(id);
      expect(view?.cells.modifier?.value).toEqual(owner?.cells.attack_bonus?.value);
      expect(view?.cells.modifier?.value).toEqual(num(GOBLIN.attack_bonus));
      const value = i === 0 ? 7 : DIE_VALUE;
      expect(view?.cells.total?.value).toEqual(num(value + GOBLIN.attack_bonus));
    }

    // `zones crypt`: four goblins in room 3, four in room 5, none elsewhere.
    const zones = await gm.request("zones", { board: ids.crypt });
    const goblinsIn = (zone: ObjectId) =>
      new Set(
        (zones.zones.find((z) => z.id === zone)?.contents ?? []).filter((id) =>
          ids.goblinCopies.includes(id),
        ),
      );
    expect(goblinsIn(ids.rooms[2] as ObjectId)).toEqual(new Set(ids.goblinCopies.slice(0, 4)));
    expect(goblinsIn(ids.rooms[4] as ObjectId)).toEqual(new Set(ids.goblinCopies.slice(4)));
    for (const n of [1, 2, 4, 6]) expect(goblinsIn(ids.rooms[n - 1] as ObjectId).size).toBe(0);
  });

  test("7. save, close, reopen: the same objects and the assets are there", {
    timeout: 15_000,
  }, async () => {
    await user.click(screen.getByRole("button", { name: "Save" }));
    await within(screen.getByRole("contentinfo")).findByText("Saved");
    const before = authority.host.table.store.toSnapshot();
    app.unmount();
    await authority.close();

    const reopened = await TableHost.open(authority.path);
    try {
      const after = reopened.table.store.toSnapshot();
      expect(after.boards).toEqual(before.boards);
      expect(after.objects).toEqual(before.objects);
      expect(after.revision).toBe(before.revision);
      expect([...reopened.assets].sort()).toEqual([assets.goblin, assets.map].sort());
      for (const path of [assets.map, assets.goblin]) {
        expect((await stat(join(authority.dir, path))).isFile()).toBe(true);
      }
    } finally {
      await reopened.close();
    }
  });
});
