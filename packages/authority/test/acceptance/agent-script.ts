/**
 * Step 5's agent (vtt-5su.13, block 3): a deterministic script, no model,
 * doing over `vtt-mcp`'s tools what an agent asked "Make room 4 difficult
 * terrain and hatch it, and make a Fireball card for Aldric with DC 14 and
 * 8d6" would do (DESIGN.md §8.4 step 5; FORMULAS.md §10 Difficult terrain,
 * A Fireball card; M3-D26). It finds room 4 by name, writes the tag and the
 * hatch, checks `speed`, authors the card, its zone and its save-row
 * template from scratch in one group, explains the actions and `targets`,
 * tries the zone on the board and undoes that. It records every tool result
 * in a transcript; the test asserts on the transcript.
 */
import type { Client } from "@modelcontextprotocol/client";
import type { ActionDef } from "@vtt/schema";
import { OUTSIDE_ROOMS } from "./prep";

// biome-ignore lint/suspicious/noExplicitAny: tool results are asserted loosely
export type Json = any;

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Json;
  content: { type: string; text?: string }[];
}

/** Calls one MCP tool. */
export async function call(
  agent: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await agent.callTool({ name, arguments: args })) as ToolResult;
}

/** Calls one MCP tool and returns its `structuredContent`; throws on `isError`. */
export async function ok(
  agent: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Json> {
  const result = await call(agent, name, args);
  if (result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent;
}

export const CARD = "fireball_aldric";
export const ZONE = "fireball_aldric_zone";
export const ROW = "fireball_save_row";
export const ROOM_LABEL = "Room 4: difficult terrain, hatched";
export const CARD_LABEL = "Fireball card for Aldric";

export const TARGETS_FORMULA = 'contents(zone).where(tag has "creature")';
export const ROWS_FORMULA = 'contents.where(tag has "save_row")';

/** FORMULAS.md §10, A Fireball card, with Roll damage reading `damage_dice`. */
export const CARD_ACTIONS: ActionDef[] = [
  {
    name: "Lock targets",
    when: "not locked",
    steps: [
      "each(targets, spawn(save_row, this, {target: it, owner: it.owner}))",
      "set(locked, true)",
    ],
  },
  {
    name: "Roll damage",
    when: "locked and damage = empty",
    steps: ["roll(damage_dice) -> damage"],
  },
  {
    name: "Apply all",
    when: "locked and damage != empty and all(rows.save_roll != empty) and not applied",
    steps: ["each(rows, add(it.target.damage_taken, it.damage_dealt))", "set(applied, true)"],
  },
  { name: "Discard", steps: ["remove(zone)", "remove(this)"] },
];

/** FORMULAS.md §10, the save row template's formulas. */
export const ROW_FORMULAS: Record<string, string> = {
  card: "container",
  save_bonus: "target.dex_save",
  passed: "save_roll + save_bonus >= card.dc",
  damage_dealt: "if(passed, floor(card.damage / 2), card.damage)",
};

export const ROW_ACTIONS: ActionDef[] = [
  { name: "Roll save", when: "save_roll = empty", steps: ["roll(1d20) -> save_roll"] },
];

const formula = (source: string) => ({ type: "formula", source });
const ref = (object: string) => ({ type: "ref", object });
const EMPTY = { type: "empty" };

/** The card group's ops: the card, its zone inside it, the save-row template in the binder. */
export function cardOps(): Record<string, unknown>[] {
  return [
    {
      type: "create_object",
      id: CARD,
      to: { type: "container", container: "aldric_binder" },
      init: {
        cells: {
          name: { type: "text", value: "Fireball" },
          owner: ref("aldric"),
          caster: ref("aldric"),
          zone: ref(ZONE),
          dc: { type: "number", value: 14 },
          damage_dice: { type: "dice", expr: "8d6" },
          damage: EMPTY,
          locked: { type: "boolean", value: false },
          applied: { type: "boolean", value: false },
          save_row: ref(ROW),
          targets: formula(TARGETS_FORMULA),
          rows: formula(ROWS_FORMULA),
        },
        actions: CARD_ACTIONS,
      },
    },
    {
      type: "create_object",
      id: ZONE,
      to: { type: "container", container: CARD },
      init: { is_zone: true, shape: { type: "circle", radius: 20 } },
    },
    {
      type: "create_object",
      id: ROW,
      to: { type: "container", container: "aldric_binder" },
      init: {
        is_template: true,
        tag: ["save_row"],
        cells: {
          target: EMPTY,
          save_roll: EMPTY,
          ...Object.fromEntries(Object.entries(ROW_FORMULAS).map(([k, v]) => [k, formula(v)])),
        },
        actions: ROW_ACTIONS,
      },
    },
  ];
}

export interface Step3Transcript {
  info: Json;
  zones: Json;
  room4: string;
  roomGroup: Json;
  pc1: Json;
  cardGroup: Json;
  explainCard: Record<string, Json>;
  explainRollSave: Json;
  targetsInside: Json;
  move: Json;
  targetsOnBoard: Json;
  undoMove: Json;
  afterUndo: Json;
}

/** Block 3: the agent's work, recorded. */
export async function authorStep5(agent: Client): Promise<Step3Transcript> {
  const info = await ok(agent, "table_info");
  const zones = await ok(agent, "zones", { board: "crypt" });
  const found = (zones.zones as Json[]).find((z) => z.view.cells.name?.value?.value === "Room 4");
  if (found === undefined) throw new Error(`no zone named Room 4: ${JSON.stringify(zones)}`);
  const room4 = found.id as string;

  const roomGroup = await ok(agent, "transact", {
    base_revision: zones.revision,
    label: ROOM_LABEL,
    ops: [
      { type: "set_tag", object: room4, tags: ["difficult"] },
      {
        type: "set_value",
        object: room4,
        cell: "pattern",
        value: { type: "text", value: "hatch" },
      },
    ],
  });
  const pc1 = await ok(agent, "get_objects", { ids: ["pc1"] });

  const cardGroup = await ok(agent, "transact", {
    base_revision: pc1.revision,
    label: CARD_LABEL,
    ops: cardOps(),
  });

  const explainCard: Record<string, Json> = {};
  for (const action of CARD_ACTIONS) {
    explainCard[action.name] = await ok(agent, "explain_action", {
      object: CARD,
      action: action.name,
    });
  }
  const explainRollSave = await ok(agent, "explain_action", { object: ROW, action: "Roll save" });

  const targetsInside = await ok(agent, "explain_cell", { object: CARD, cell: "targets" });
  const move = await ok(agent, "transact", {
    base_revision: targetsInside.revision,
    label: "Try the Fireball zone on the Crypt",
    ops: [
      {
        type: "move",
        object: ZONE,
        to: { type: "board", board: "crypt", position: OUTSIDE_ROOMS },
      },
    ],
  });
  const targetsOnBoard = await ok(agent, "explain_cell", { object: CARD, cell: "targets" });
  const undoMove = await ok(agent, "undo", { target: { type: "mine" } });
  const afterUndo = await ok(agent, "get_objects", { ids: [ZONE, CARD] });

  return {
    info,
    zones,
    room4,
    roomGroup,
    pc1,
    cardGroup,
    explainCard,
    explainRollSave,
    targetsInside,
    move,
    targetsOnBoard,
    undoMove,
    afterUndo,
  };
}
