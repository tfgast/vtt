/**
 * The MCP `instructions` (vtt-nb8.16; DESIGN.md §5.2; PROTOCOL.md §11;
 * M6-D6): every backticked identifier in `MCP_INSTRUCTIONS` is mapped to one
 * category and checked against the thing it names, so the text cannot drift
 * from the tools, ops, templates and docs it points at (M6 review r1
 * finding 8, r2 finding 4). The tool and resource checks read the composed
 * `vtt-mcp` process's `tools/list` and `resources/list` over stdio.
 */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_INSTRUCTIONS, stockedTableSnapshot, UndoInputSchema } from "@vtt/authority";
import {
  BINDING_NAME_PATTERN,
  ProtocolRejectionSchema,
  TransactParamsSchema,
  WireOpSchema,
} from "@vtt/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const MCP_BIN = join(PKG, "src", "bin", "mcp.ts");

type Category =
  | "tool"
  | "op"
  | "template"
  | "cell"
  | "appearance"
  | "field"
  | "rejection"
  | "exception";

/** Every backticked identifier in `MCP_INSTRUCTIONS`, with its one category. */
const IDENTIFIERS: Record<string, Category> = {
  table_info: "tool",
  list_objects: "tool",
  zones: "tool",
  get_objects: "tool",
  explain_cell: "tool",
  transact: "tool",
  import_asset: "tool",
  invoke: "tool",
  undo: "tool",
  spawn: "op",
  set_template_flag: "op",
  gm_binder: "template",
  tpl_character: "template",
  tpl_attack: "template",
  tpl_damage: "template",
  tpl_area_save: "template",
  tpl_save_row: "template",
  tpl_token: "template",
  tpl_zone: "template",
  tpl_card: "template",
  tpl_note: "template",
  tpl_sheet: "template",
  tpl_hand: "template",
  tpl_binder: "template",
  tpl_stack: "template",
  tpl_d20: "template",
  name: "cell",
  caster: "cell",
  owner: "cell",
  damage_dice: "cell",
  dc: "cell",
  spell_dc: "cell",
  sheet: "cell",
  color: "appearance",
  pattern: "appearance",
  text: "appearance",
  image: "appearance",
  as: "field",
  base_revision: "field",
  stale_write: "rejection",
  mine: "exception",
  $copy: "exception",
};

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

/** The cell names in the first column of DESIGN.md §4.6's Appearance cells table. */
async function appearanceCells(): Promise<Set<string>> {
  const design = await readFile(join(REPO, "docs", "DESIGN.md"), "utf8");
  const start = design.indexOf("**Appearance cells.**");
  expect(start).toBeGreaterThanOrEqual(0);
  const lines = design.slice(start).split("\n");
  const header = lines.findIndex((l) => l.startsWith("| Cell |"));
  expect(header).toBeGreaterThan(0);
  const cells = new Set<string>();
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) cells.add(m[1] as string);
  }
  return cells;
}

let dir: string;
let client: Client;
let tools: Set<string>;
let resources: Set<string>;

beforeAll(async () => {
  // No credentials and no session file: `vtt-mcp` waits in discovery and
  // still answers tools/list and resources/list.
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-mcp-instructions-")));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", MCP_BIN],
    cwd: PKG,
    env: { ...getDefaultEnvironment(), XDG_CONFIG_HOME: join(dir, "config") },
    stderr: "pipe",
  });
  client = new Client({ name: "instructions-test", version: "1.0.0" });
  await client.connect(transport);
  tools = new Set((await client.listTools()).tools.map((t) => t.name));
  resources = new Set((await client.listResources()).resources.map((r) => r.uri));
}, 60_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("MCP_INSTRUCTIONS", () => {
  test("the composed vtt-mcp process sends it at initialize", () => {
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
  });

  test("its backticked identifiers are exactly the categorized ones", () => {
    expect(new Set(backticked(MCP_INSTRUCTIONS))).toEqual(new Set(Object.keys(IDENTIFIERS)));
  });

  const of = (category: Category) =>
    Object.entries(IDENTIFIERS)
      .filter(([, c]) => c === category)
      .map(([id]) => id);

  test.each(of("tool"))("tool %s is registered by vtt-mcp", (id) => {
    expect(tools).toContain(id);
  });

  test.each(of("op"))("op %s is a WireOp type", (id) => {
    const types = WireOpSchema.options.map((o) => o.shape.type.value as string);
    expect(types).toContain(id);
  });

  test.each(of("template"))("template %s is an object of the stocked table", (id) => {
    expect(Object.keys(stockedTableSnapshot().objects)).toContain(id);
  });

  test.each(of("cell"))("cell %s is a cell of some stocked record", (id) => {
    const cells = new Set(
      Object.values(stockedTableSnapshot().objects).flatMap((o) => Object.keys(o.cells)),
    );
    expect(cells).toContain(id);
  });

  test.each(of("appearance"))("appearance cell %s is in DESIGN §4.6's table", async (id) => {
    expect(await appearanceCells()).toContain(id);
  });

  test("field `as` is a key of the spawn op", () => {
    expect(IDENTIFIERS.as).toBe("field");
    const spawn = WireOpSchema.options.find((o) => o.shape.type.value === "spawn");
    expect(Object.keys(spawn?.shape ?? {})).toContain("as");
  });

  test("field `base_revision` is a key of the transact params", () => {
    expect(IDENTIFIERS.base_revision).toBe("field");
    expect(Object.keys(TransactParamsSchema.shape)).toContain("base_revision");
  });

  test.each(of("rejection"))("rejection %s is a ProtocolRejection type", (id) => {
    const types = ProtocolRejectionSchema.out.options.map((o) => o.shape.type.value as string);
    expect(types).toContain(id);
  });

  test("exception `mine` is an undo target type of the undo tool", () => {
    expect(IDENTIFIERS.mine).toBe("exception");
    expect(UndoInputSchema.safeParse({ target: { type: "mine" } }).success).toBe(true);
  });

  test("exception `$copy` is a batch binding name", () => {
    expect(IDENTIFIERS.$copy).toBe("exception");
    expect(BINDING_NAME_PATTERN.test("$copy")).toBe(true);
  });

  test("giving a card sets its owner to the binder's owner (M6-D15)", () => {
    const give = MCP_INSTRUCTIONS.split("\n").find((l) => l.startsWith("To give a card"));
    expect(give).toContain(
      "always set its `owner` to the binder's `owner` (the character), so the card's buttons pressed in the UI act as that character",
    );
    expect(give).toContain("for `tpl_area_save` also set `name`, `caster` and `damage_dice`");
  });

  test("every vtt:// URI is a registered resource", () => {
    const uris = [...MCP_INSTRUCTIONS.matchAll(/vtt:\/\/[^\s)]+/g)].map((m) => m[0]);
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) expect(resources).toContain(uri);
  });
});
