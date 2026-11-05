/**
 * Step 5's prep (vtt-5su.13, block 2): what DESIGN.md §8.4 steps 1–4 leave on
 * the table that step 5 needs, written by the GM through a `ProtocolClient`
 * of kind `ui` against the running `vtt-serve`. Board `crypt`; the character
 * `aldric` and his binder on `gm_board`; six opaque GM-only room zones on
 * `crypt`; a PC token (with FORMULAS.md §10 Difficult terrain's `speed`) in
 * room 4 and a goblin in room 3.
 */
import type { InputCellContent, ProtocolClient, TransactResult, WireOp } from "@vtt/protocol";
import type { Shape } from "@vtt/schema";

export const ROOM_SIZE = 100;
/** Room anchors (rect zones are centred on their anchor). */
export const ROOMS: readonly { id: string; name: string; position: [number, number] }[] = [
  { id: "room1", name: "Room 1", position: [100, 100] },
  { id: "room2", name: "Room 2", position: [300, 100] },
  { id: "room3", name: "Room 3", position: [500, 100] },
  { id: "room4", name: "Room 4", position: [100, 300] },
  { id: "room5", name: "Room 5", position: [300, 300] },
  { id: "room6", name: "Room 6", position: [500, 300] },
];
/** Inside room 4. */
export const PC1_POSITION: [number, number] = [110, 310];
/** Inside room 3. */
export const GOBLIN1_POSITION: [number, number] = [510, 110];
/** On `crypt`, outside every room. */
export const OUTSIDE_ROOMS: [number, number] = [800, 800];

/** FORMULAS.md §10, Difficult terrain. */
export const SPEED_FORMULA =
  'base_speed / if(len(zones_containing(this).where(tag has "difficult")) > 0, 2, 1)';

const text = (value: string): InputCellContent => ({ type: "text", value });
const num = (value: number): InputCellContent => ({ type: "number", value });
const ref = (object: string): InputCellContent => ({ type: "ref", object });
const viewers = (...v: ("all" | "gm" | "owner")[]): InputCellContent => ({
  type: "viewers",
  viewers: v,
});
const room: Shape = { type: "rect", width: ROOM_SIZE, height: ROOM_SIZE };

/** The prep ops, in one GM group. */
export function prepOps(): WireOp[] {
  return [
    { type: "add_board", id: "crypt", name: "Crypt" },
    {
      type: "create_object",
      id: "aldric",
      to: { type: "board", board: "gm_board", position: [0, 0] },
      init: { is_character: true, cells: { name: text("Aldric") } },
    },
    {
      type: "create_object",
      id: "aldric_binder",
      to: { type: "board", board: "gm_board", position: [100, 0] },
      init: {
        cells: {
          name: text("Aldric's binder"),
          owner: ref("aldric"),
          visible_to: viewers("owner"),
        },
      },
    },
    ...ROOMS.map(
      (r): WireOp => ({
        type: "create_object",
        id: r.id,
        to: { type: "board", board: "crypt", position: r.position },
        init: {
          is_zone: true,
          shape: room,
          cells: {
            name: text(r.name),
            opaque: { type: "boolean", value: true },
            visible_to: viewers("gm"),
          },
        },
      }),
    ),
    {
      type: "create_object",
      id: "pc1",
      to: { type: "board", board: "crypt", position: PC1_POSITION },
      init: {
        tag: ["creature"],
        cells: { base_speed: num(30), speed: { type: "formula", source: SPEED_FORMULA } },
      },
    },
    {
      type: "create_object",
      id: "goblin1",
      to: { type: "board", board: "crypt", position: GOBLIN1_POSITION },
      init: { tag: ["creature"] },
    },
  ];
}

/** Writes the prep as the GM; throws unless it commits. */
export async function prepare(
  gm: ProtocolClient,
): Promise<Extract<TransactResult, { status: "committed" }>> {
  const result = await gm.transact(prepOps(), { label: "Prep: Crypt, Aldric, rooms, tokens" });
  if (result.status !== "committed") {
    throw new Error(`prep rejected: ${JSON.stringify(result)}`);
  }
  return result;
}
